// SPDX-License-Identifier: Apache-2.0
//! Startup crash recovery (`docs/crash-recovery.md` §3–§5).
//!
//! Rust is the only truth holder: after a crash the webview state is gone and
//! the design files can only be at "checkpoint" or at a ledger-recorded step
//! boundary. `scan` adjudicates every step of the recent turns from the ledger
//! (`intended` → `applied` → `done|failed`) against the current file shas,
//! cleans orphans (atomic temp files, `.bak.pending`, stage trees, unreferenced
//! run backups, preview assets) and surfaces a pending card so the UI can
//! re-issue it. Nothing here re-acquires D capabilities: a new BuildSession
//! consent is always needed before any further write.

use crate::ipc::{RecoveryCleaned, RecoveryFile, RecoveryNote, RecoveryReport, RecoveryStep};
use crate::paths::{now_iso, sha256_hex, write_atomic};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// How many turns before `last_turn` are re-examined (a crash only ever leaves
/// the running turn unfinished, but a missed `done` may sit one turn back).
const LOOKBACK_TURNS: u32 = 2;

fn read_json(p: &Path) -> Option<Value> {
    std::fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

fn file_sha(p: &Path) -> Option<String> {
    std::fs::read(p).ok().map(|b| sha256_hex(&b))
}

/// Walk the project (skipping `.fluxsmith`, `.git`, KiCad `-backups`) and
/// remove atomic temp files / `.bak.pending` left by an interrupted txn.
fn clean_orphan_files(root: &Path, out: &mut Vec<RecoveryCleaned>) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if p.is_dir() {
                if name == ".fluxsmith"
                    || name == ".git"
                    || name.ends_with("-backups")
                    || name == "node_modules"
                {
                    continue;
                }
                stack.push(p);
                continue;
            }
            let is_tmp = name.starts_with('.') && name.contains(".fluxsmith-tmp-");
            let is_bak_pending = name.ends_with(".bak.pending");
            if (is_tmp || is_bak_pending) && std::fs::remove_file(&p).is_ok() {
                out.push(RecoveryCleaned {
                    kind: if is_tmp { "temp_file" } else { "bak_pending" }.into(),
                    path: crate::paths::rel_to(root, &p),
                });
            }
        }
    }
}

fn clean_dir_children(
    dir: &Path,
    root: &Path,
    kind: &str,
    keep: impl Fn(&str) -> bool,
    out: &mut Vec<RecoveryCleaned>,
) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        let name = p
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if keep(&name) {
            continue;
        }
        let ok = if p.is_dir() {
            std::fs::remove_dir_all(&p).is_ok()
        } else {
            std::fs::remove_file(&p).is_ok()
        };
        if ok {
            out.push(RecoveryCleaned {
                kind: kind.into(),
                path: crate::paths::rel_to(root, &p),
            });
        }
    }
}

/// Every `run_id` the ledgers and the journal know an `applied` for.
fn referenced_runs(base: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(rd) = std::fs::read_dir(base.join("turns")) {
        for e in rd.flatten() {
            if let Some(Value::Array(entries)) = read_json(&e.path().join("ledger.json")) {
                for en in entries {
                    if en["phase"] == "applied" {
                        if let Some(r) = en["payload"]["run_id"].as_str() {
                            set.insert(r.to_string());
                        }
                    }
                }
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string(base.join("journal.jsonl")) {
        for l in s.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                if let Some(r) = v["run_id"].as_str() {
                    set.insert(r.to_string());
                }
            }
        }
    }
    set
}

/// Adjudicate the ledger of one turn. Returns the step verdicts and whether the
/// turn was left unfinished (no `turn.json` while the ledger has entries).
fn adjudicate_turn(root: &Path, turn: u32) -> (Vec<RecoveryStep>, Option<String>) {
    let base = root.join(".fluxsmith");
    let dir = base.join("turns").join(turn.to_string());
    let ledger_path = dir.join("ledger.json");
    let Some(Value::Array(entries)) = read_json(&ledger_path) else {
        return (Vec::new(), None);
    };
    // Latest phase per step, in first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut latest: std::collections::HashMap<String, Value> = Default::default();
    for en in &entries {
        let step = en["step"].as_str().unwrap_or("").to_string();
        let phase = en["phase"].as_str().unwrap_or("");
        // Injections and hook denials are observability records, not write phases.
        if phase == "injected" || phase == "denied" {
            continue;
        }
        if !latest.contains_key(&step) {
            order.push(step.clone());
        }
        latest.insert(step, en.clone());
    }
    let mut steps = Vec::new();
    let mut appended: Vec<Value> = Vec::new();
    let mut last_phase: Option<String> = None;
    for step in order {
        let en = &latest[&step];
        let phase = en["phase"].as_str().unwrap_or("").to_string();
        last_phase = Some(phase.clone());
        let mut files = Vec::new();
        let verdict = match phase.as_str() {
            "intended" => {
                // No `applied` record: either the txn never committed (files still at sha_before) or the
                // process died between the rename and the ledger write. Only a matching pre-image is "unchanged".
                let mut all_match = true;
                let mut compared = 0;
                for t in en["payload"]["targets"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    let rel = t["path"].as_str().unwrap_or("").to_string();
                    let Some(expected) = t["sha_before"].as_str().map(|s| s.to_string()) else {
                        continue;
                    };
                    compared += 1;
                    let actual = crate::paths::scoped(root, &rel)
                        .ok()
                        .and_then(|p| file_sha(&p));
                    let matches = Some(&expected) == actual.as_ref();
                    if !matches {
                        all_match = false;
                    }
                    files.push(RecoveryFile {
                        path: rel,
                        expected_sha: Some(expected),
                        actual_sha: actual,
                        matches,
                    });
                }
                if compared > 0 && !all_match {
                    "needs_review"
                } else {
                    "orphan_cleaned"
                }
            }
            "applied" => {
                let mut all_match = true;
                for t in en["payload"]["targets"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                {
                    let rel = t["path"].as_str().unwrap_or("").to_string();
                    let expected = t["sha_after"].as_str().map(|s| s.to_string());
                    let actual = crate::paths::scoped(root, &rel)
                        .ok()
                        .and_then(|p| file_sha(&p));
                    let matches = expected.is_some() && expected == actual;
                    if !matches {
                        all_match = false;
                    }
                    files.push(RecoveryFile {
                        path: rel,
                        expected_sha: expected,
                        actual_sha: actual,
                        matches,
                    });
                }
                if all_match {
                    appended.push(serde_json::json!({"ts": now_iso(), "step": step, "phase": "done", "payload": {"recovered": true, "run_id": en["payload"]["run_id"]}}));
                    "done_confirmed"
                } else {
                    "needs_review"
                }
            }
            "failed" => "failed",
            "done" => "done",
            // An unknown or garbled phase is never adjudicated as committed work.
            _ => "needs_review",
        };
        steps.push(RecoveryStep {
            turn,
            step,
            ledger_phase: phase,
            verdict: verdict.into(),
            files,
        });
    }
    if !appended.is_empty() {
        let mut all = entries.clone();
        all.extend(appended);
        if let Ok(s) = serde_json::to_string(&all) {
            let _ = write_atomic(&ledger_path, s.as_bytes());
        }
    }
    // A running turn never wrote turn.json (the harness only writes it in finishTurn):
    // mark it interrupted with the phase inferred from the ledger.
    let turn_json = dir.join("turn.json");
    let status = read_json(&turn_json).and_then(|v| v["status"].as_str().map(|s| s.to_string()));
    let unfinished = matches!(
        status.as_deref(),
        None | Some("running") | Some("stopping") | Some("hard_stopped")
    );
    if unfinished {
        let phase_at_interrupt = match last_phase.as_deref() {
            Some("intended") => "building-apply",
            Some("applied") => "building-apply",
            Some("done") | Some("failed") => "building-verify",
            _ => "unknown",
        };
        let mut v = read_json(&turn_json).unwrap_or_else(|| serde_json::json!({"turn": turn}));
        v["status"] = Value::String("interrupted".into());
        v["phase_at_interrupt"] = Value::String(phase_at_interrupt.into());
        if let Ok(s) = serde_json::to_string_pretty(&v) {
            let _ = write_atomic(&turn_json, s.as_bytes());
        }
        return (steps, Some(phase_at_interrupt.into()));
    }
    (steps, None)
}

/// Startup scan for one project. Cheap (a few small JSON files) and idempotent:
/// a second scan finds nothing to clean and every step already `done`.
pub fn scan(root: &Path, last_turn: u32) -> RecoveryReport {
    let base = root.join(".fluxsmith");
    let mut cleaned = Vec::new();
    let mut notes = Vec::new();
    clean_orphan_files(root, &mut cleaned);
    // Stage shadow trees are per process; none can be live at startup.
    clean_dir_children(&base.join("stage"), root, "stage", |_| false, &mut cleaned);
    // Preview assets are transient (the ghost layer is rebuilt by the next dry-run).
    clean_dir_children(
        &base.join("assets"),
        root,
        "preview",
        |n| !n.starts_with("preview-"),
        &mut cleaned,
    );
    let mut steps = Vec::new();
    let mut interrupted: Option<(u32, String)> = None;
    let first = last_turn.saturating_sub(LOOKBACK_TURNS).max(1);
    if last_turn >= 1 {
        for turn in first..=last_turn {
            let (s, phase) = adjudicate_turn(root, turn);
            steps.extend(s);
            if let Some(p) = phase {
                interrupted = Some((turn, p));
            }
        }
    }
    // A rollback that began (journal `rollback_begin`) but never completed left a half-restored tree.
    if let Ok(text) = std::fs::read_to_string(base.join("journal.jsonl")) {
        let mut open_rollback: Option<Value> = None;
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            match v["kind"].as_str() {
                Some("rollback_begin") => open_rollback = Some(v),
                Some("rollback") => open_rollback = None,
                _ => {}
            }
        }
        if let Some(v) = open_rollback {
            let before = v["before_turn"].as_u64().unwrap_or(0) as u32;
            steps.push(RecoveryStep {
                turn: before,
                step: "rollback".into(),
                ledger_phase: "rollback_begin".into(),
                verdict: "needs_review".into(),
                files: Vec::new(),
            });
            notes.push(RecoveryNote::RollbackInterrupted {
                before_turn: before,
            });
        }
    }
    // Run backups without an `applied` record belong to a txn that never committed. While any step still
    // needs review they are the only per-run pre-image left, so they stay.
    let referenced = referenced_runs(&base);
    if !steps.iter().any(|s| s.verdict == "needs_review") {
        clean_dir_children(
            &base.join("backups/runs"),
            root,
            "run_backup",
            |n| referenced.contains(n),
            &mut cleaned,
        );
    }
    let pending_card = read_json(
        &base
            .join("turns")
            .join(last_turn.to_string())
            .join("artifacts/pending_card.json"),
    )
    .filter(|v| v.is_object());
    // The synthetic `rollback` step has its own note above; this one is about applied steps.
    if steps
        .iter()
        .any(|s| s.verdict == "needs_review" && s.step != "rollback")
    {
        notes.push(RecoveryNote::StepNeedsReview);
    }
    let (turn, phase_at_interrupt) = match interrupted {
        Some((t, p)) => (Some(t), Some(p)),
        None => (None, None),
    };
    RecoveryReport {
        scanned_at: now_iso(),
        turn,
        phase_at_interrupt,
        cleaned,
        steps,
        pending_card,
        notes,
    }
}

/// Post-panic cleanup for one project (`docs/crash-recovery.md` §5). `parking_lot`
/// mutexes do not poison (the guard is released on unwind), but the engine's
/// in-memory state may be half-mutated: rebuild it from the libraries and drop
/// the apply cache; remove this process's temp files and stage trees.
pub fn after_panic(state: &crate::state::AppState, project_key: &str) -> Vec<String> {
    let mut done = Vec::new();
    let Ok(h) = state.project(project_key) else {
        return done;
    };
    let (_, rows) = state.lib_env();
    *h.engine.lock() = sch_write::Engine::new(sch_read::SymbolLibrary::new(rows));
    h.apply_cache.lock().clear();
    done.push("engine_rebuilt".into());
    let mut cleaned = Vec::new();
    clean_orphan_files(&h.root, &mut cleaned);
    clean_dir_children(
        &h.root.join(".fluxsmith/stage"),
        &h.root,
        "stage",
        |_| false,
        &mut cleaned,
    );
    done.extend(
        cleaned
            .into_iter()
            .map(|c| format!("{}:{}", c.kind, c.path)),
    );
    done
}

#[allow(dead_code)]
pub fn crash_dir() -> PathBuf {
    crate::paths::app_data_dir().join("logs").join("crashes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(ledger: Value, target_bytes: &[u8]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        std::fs::write(root.join("p.kicad_sch"), target_bytes).unwrap();
        let t = root.join(".fluxsmith/turns/3");
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("ledger.json"), serde_json::to_vec(&ledger).unwrap()).unwrap();
        std::fs::create_dir_all(root.join(".fluxsmith/backups/runs/run-x")).unwrap();
        std::fs::write(root.join(".p.kicad_sch.fluxsmith-tmp-999"), b"partial").unwrap();
        d
    }

    #[test]
    fn intended_only_cleans_orphans() {
        let d = fixture(
            serde_json::json!([{"ts": "t", "step": "s1", "phase": "intended", "payload": {"ops_sha256": "abc", "targets": [{"path": "p.kicad_sch", "sha_before": null}]}}]),
            b"v1",
        );
        let r = scan(d.path(), 3);
        assert_eq!(r.steps.len(), 1);
        assert_eq!(r.steps[0].verdict, "orphan_cleaned");
        assert!(!d.path().join(".p.kicad_sch.fluxsmith-tmp-999").exists());
        assert!(!d.path().join(".fluxsmith/backups/runs/run-x").exists());
        assert!(r.cleaned.iter().any(|c| c.kind == "temp_file"));
        assert!(r.cleaned.iter().any(|c| c.kind == "run_backup"));
        assert_eq!(r.turn, Some(3));
        assert_eq!(r.phase_at_interrupt.as_deref(), Some("building-apply"));
        let tj: Value = read_json(&d.path().join(".fluxsmith/turns/3/turn.json")).unwrap();
        assert_eq!(tj["status"], "interrupted");
        // idempotent
        let r2 = scan(d.path(), 3);
        assert!(r2.cleaned.is_empty());
    }

    #[test]
    fn intended_with_changed_files_needs_review() {
        // The pre-image sha on the `intended` record does not match the file: the txn may have half committed.
        let d = fixture(
            serde_json::json!([{"ts": "t", "step": "s1", "phase": "intended", "payload": {"ops_sha256": "abc", "targets": [{"path": "p.kicad_sch", "sha_before": "not-the-file"}]}}]),
            b"v1",
        );
        let r = scan(d.path(), 3);
        assert_eq!(r.steps[0].verdict, "needs_review");
        // the run backup survives while something needs review
        assert!(d.path().join(".fluxsmith/backups/runs/run-x").exists());
        // a matching pre-image is a clean orphan
        let sha = sha256_hex(b"v1");
        let d2 = fixture(
            serde_json::json!([{"ts": "t", "step": "s1", "phase": "intended", "payload": {"ops_sha256": "abc", "targets": [{"path": "p.kicad_sch", "sha_before": sha}]}}]),
            b"v1",
        );
        let r2 = scan(d2.path(), 3);
        assert_eq!(r2.steps[0].verdict, "orphan_cleaned");
    }

    #[test]
    fn open_rollback_begin_needs_review() {
        let d = fixture(serde_json::json!([]), b"v1");
        std::fs::write(
            d.path().join(".fluxsmith/journal.jsonl"),
            "{\"kind\":\"rollback_begin\",\"before_turn\":2,\"now_turn\":4}\n",
        )
        .unwrap();
        let r = scan(d.path(), 3);
        assert!(r
            .steps
            .iter()
            .any(|s| s.step == "rollback" && s.verdict == "needs_review"));
        // Notes are codes with parameters, never prose: the UI translates them.
        assert_eq!(
            r.notes,
            vec![RecoveryNote::RollbackInterrupted { before_turn: 2 }]
        );
        let wire = serde_json::to_value(&r.notes[0]).unwrap();
        assert_eq!(wire["code"], "rollback_interrupted");
        assert_eq!(wire["before_turn"], 2);
    }

    #[test]
    fn applied_with_matching_sha_is_confirmed_done() {
        let sha = sha256_hex(b"v2");
        let d = fixture(
            serde_json::json!([
                {"ts": "t", "step": "s1", "phase": "intended", "payload": {"ops_sha256": "abc", "targets": [{"path": "p.kicad_sch", "sha_before": null}]}},
                {"ts": "t", "step": "s1", "phase": "applied", "payload": {"run_id": "run-x", "targets": [{"path": "p.kicad_sch", "sha_before": "old", "sha_after": sha}]}}
            ]),
            b"v2",
        );
        let r = scan(d.path(), 3);
        assert_eq!(r.steps[0].verdict, "done_confirmed");
        assert!(r.steps[0].files[0].matches);
        // the referenced run backup survives; a `done` entry was appended
        assert!(d.path().join(".fluxsmith/backups/runs/run-x").exists());
        let l: Value = read_json(&d.path().join(".fluxsmith/turns/3/ledger.json")).unwrap();
        assert_eq!(l.as_array().unwrap().last().unwrap()["phase"], "done");
        let r2 = scan(d.path(), 3);
        assert_eq!(r2.steps[0].verdict, "done");
    }

    #[test]
    fn unknown_phase_needs_review() {
        // A phase this build does not know (newer app, garbled line) is never adjudicated as done.
        let d = fixture(
            serde_json::json!([
                {"ts": "t", "step": "s1", "phase": "future_phase", "payload": {}}
            ]),
            b"v3",
        );
        let r = scan(d.path(), 3);
        assert_eq!(r.steps[0].verdict, "needs_review");
    }

    #[test]
    fn applied_with_mismatch_needs_review() {
        let d = fixture(
            serde_json::json!([
                {"ts": "t", "step": "s1", "phase": "applied", "payload": {"run_id": "run-x", "targets": [{"path": "p.kicad_sch", "sha_before": "old", "sha_after": "deadbeef"}]}}
            ]),
            b"v3",
        );
        std::fs::create_dir_all(d.path().join(".fluxsmith/turns/3/artifacts")).unwrap();
        std::fs::write(
            d.path()
                .join(".fluxsmith/turns/3/artifacts/pending_card.json"),
            br#"{"turn":3,"step":"s1","card":{"id":"c"}}"#,
        )
        .unwrap();
        let r = scan(d.path(), 3);
        assert_eq!(r.steps[0].verdict, "needs_review");
        assert!(!r.steps[0].files[0].matches);
        assert_eq!(
            r.steps[0].files[0].actual_sha.as_deref(),
            Some(sha256_hex(b"v3").as_str())
        );
        assert_eq!(r.notes, vec![RecoveryNote::StepNeedsReview]);
        assert_eq!(
            serde_json::to_value(&r.notes[0]).unwrap()["code"],
            "step_needs_review"
        );
        assert_eq!(r.pending_card.as_ref().unwrap()["step"], "s1");
        let l: Value = read_json(&d.path().join(".fluxsmith/turns/3/ledger.json")).unwrap();
        assert_eq!(
            l.as_array().unwrap().len(),
            1,
            "no done appended on mismatch"
        );
    }
}
