// SPDX-License-Identifier: Apache-2.0
//! Turn checkpoints in app data + verified rollback (red line 13).

use crate::error::{err, io_err};
use crate::ipc::*;
use crate::paths::{app_data_dir, ensure_dir};
use crate::state::{AppState, ProjectHandle};
use std::path::{Path, PathBuf};

pub fn dir_for(project_key: &str, turn: u32, kind: &str) -> PathBuf {
    let name = if kind == "turn" {
        format!("{turn}")
    } else {
        format!("{turn}-{kind}")
    };
    app_data_dir()
        .join("checkpoints")
        .join(project_key)
        .join(name)
}

/// Every design-truth file under the project root (sheets, .kicad_pro,
/// lib tables, fluxsmith.toml, intent.json, project libs).
pub fn design_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
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
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            if matches!(ext, "kicad_sch" | "kicad_pro" | "kicad_sym" | "kicad_mod")
                || matches!(
                    name.as_str(),
                    "sym-lib-table" | "fp-lib-table" | "fluxsmith.toml" | "intent.json"
                )
            {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

pub fn create(
    state: &AppState,
    h: &ProjectHandle,
    turn: u32,
    kind: &str,
) -> Result<CheckpointInfo, IpcError> {
    let dir = dir_for(&h.key, turn, kind);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    }
    ensure_dir(&dir)?;
    let files = design_files(&h.root);
    let (manifest, sha) = sch_write::checkpoint::create(&h.root, &files, &dir)
        .map_err(|e| err("CHECKPOINT_FAILED", e.to_string()))?;
    let bytes: u64 = manifest.files.iter().map(|f| f.size).sum();
    state
        .db
        .lock()
        .checkpoint_insert(&h.key, turn, &sha, bytes, kind)?;
    if kind == "turn" {
        if let Some(t) = state.sessions.lock().turn_mut(&h.key) {
            if t.turn == turn {
                t.checkpoint_done = true;
            }
        }
    }
    prune(state, h).ok();
    Ok(CheckpointInfo {
        project_key: h.key.clone(),
        turn,
        manifest_sha256: sha,
        bytes,
        created: crate::paths::now_iso(),
        kind: kind.into(),
        pruned: false,
        verified: true,
    })
}

pub fn list(state: &AppState, project_key: &str) -> Result<Vec<CheckpointInfo>, IpcError> {
    let rows = state.db.lock().checkpoint_list(project_key)?;
    Ok(rows
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

/// A `pre_rollback` snapshot is offered for restore for this long (D-34; the
/// rollback dialog copy promises it), then it is storage like any other.
pub const PRE_ROLLBACK_KEEP_DAYS: i64 = 7;

/// Drop the `pre_rollback` snapshots older than [`PRE_ROLLBACK_KEEP_DAYS`]:
/// they are one-shot and nothing can restore them any more.
fn prune_pre_rollback(state: &AppState, h: &ProjectHandle) -> Result<(), IpcError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(PRE_ROLLBACK_KEEP_DAYS);
    for c in list(state, &h.key)? {
        if c.kind != "pre_rollback" || c.pruned {
            continue;
        }
        let old = chrono::DateTime::parse_from_rfc3339(&c.created)
            .map(|t| t.with_timezone(&chrono::Utc) < cutoff)
            // An unreadable timestamp must not keep a snapshot alive forever.
            .unwrap_or(true);
        if old {
            state
                .db
                .lock()
                .checkpoint_mark_pruned(&h.key, c.turn, "pre_rollback")?;
            let _ = std::fs::remove_dir_all(dir_for(&h.key, c.turn, "pre_rollback"));
        }
    }
    Ok(())
}

/// Storage quota: keep the newest N turn checkpoints and at most M MB.
pub fn prune(state: &AppState, h: &ProjectHandle) -> Result<(), IpcError> {
    let (max_turns, max_mb) = {
        let s = state.settings.read();
        (
            s.storage.checkpoint_turns as usize,
            s.storage.checkpoint_mb as u64,
        )
    };
    prune_pre_rollback(state, h)?;
    let mut list = list(state, &h.key)?;
    list.retain(|c| c.kind == "turn" && !c.pruned);
    list.sort_by_key(|c| std::cmp::Reverse(c.turn));
    let mut total = 0u64;
    for (i, c) in list.iter().enumerate() {
        total += c.bytes;
        // The newest checkpoint is the one the running turn was just given: it is never pruned, even when
        // a vendored library inside the project pushes it alone over the quota.
        if i == 0 {
            continue;
        }
        if i >= max_turns || total > max_mb * 1024 * 1024 {
            // DB first: a crash between the two leaves "pruned" recorded rather than a phantom checkpoint.
            state
                .db
                .lock()
                .checkpoint_mark_pruned(&h.key, c.turn, "turn")?;
            let d = dir_for(&h.key, c.turn, "turn");
            let _ = std::fs::remove_dir_all(&d);
        }
    }
    Ok(())
}

/// Every design file as it is right now, with its sha: the observation both
/// the preview token and the restore's optimistic lock are built from.
fn observe(root: &Path) -> Vec<(PathBuf, String)> {
    design_files(root)
        .into_iter()
        .filter_map(|p| sch_write::atomic::file_sha(&p).map(|s| (p, s)))
        .collect()
}

/// One sha over the whole observation (relative path + content sha, sorted):
/// any file added, removed or edited since gives a different token.
fn state_token(root: &Path, obs: &[(PathBuf, String)]) -> String {
    let mut lines: Vec<String> = obs
        .iter()
        .map(|(p, s)| format!("{} {s}", crate::paths::rel_to(root, p)))
        .collect();
    lines.sort();
    crate::paths::sha256_hex(lines.join("\n").as_bytes())
}

fn checkpoint_manifest(dir: &Path) -> Result<sch_write::checkpoint::Manifest, IpcError> {
    let p = dir.join("manifest.json");
    let bytes = std::fs::read(&p).map_err(|e| io_err(&p, e))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| err("CHECKPOINT_TAMPERED", format!("manifest unreadable: {e}")))
}

fn kind_of(req: &RollbackRequest) -> Result<&'static str, IpcError> {
    match req.kind() {
        "turn" => Ok("turn"),
        "pre_rollback" => Ok("pre_rollback"),
        other => Err(err(
            "BAD_CONFIG",
            format!("unknown checkpoint kind {other}"),
        )),
    }
}

/// What restoring `before_turn` would do to the files on disk. Read-only: the
/// rollback dialog shows it before any consent is recorded.
pub fn preview(
    state: &AppState,
    h: &ProjectHandle,
    before_turn: u32,
    kind: &str,
) -> Result<RollbackPreview, IpcError> {
    let kind = match kind {
        "" | "turn" => "turn",
        "pre_rollback" => "pre_rollback",
        other => {
            return Err(err(
                "BAD_CONFIG",
                format!("unknown checkpoint kind {other}"),
            ))
        }
    };
    let (_, pruned) = state
        .db
        .lock()
        .checkpoint_get(&h.key, before_turn, kind)?
        .ok_or_else(|| {
            err(
                "ROLLBACK_STALE",
                format!("no {kind} checkpoint for turn {before_turn}"),
            )
        })?;
    if pruned {
        return Err(err(
            "ROLLBACK_STALE",
            "that checkpoint was pruned by the storage quota",
        ));
    }
    let manifest = checkpoint_manifest(&dir_for(&h.key, before_turn, kind))?;
    let obs = observe(&h.root);
    let remove_files = obs
        .iter()
        .map(|(p, _)| crate::paths::rel_to(&h.root, p))
        .filter(|rel| !manifest.files.iter().any(|f| f.path == *rel))
        .collect();
    Ok(RollbackPreview {
        before_turn,
        kind: kind.into(),
        restore_files: manifest.files.iter().map(|f| f.path.clone()).collect(),
        remove_files,
        state_sha256: state_token(&h.root, &obs),
    })
}

pub fn rollback(
    state: &AppState,
    h: &ProjectHandle,
    req: &RollbackRequest,
) -> Result<RollbackResult, IpcError> {
    let kind = kind_of(req)?;
    state
        .sessions
        .lock()
        .consume_grant(&req.grant, &h.key, "rollback", None)?;
    let (sha, pruned) = state
        .db
        .lock()
        .checkpoint_get(&h.key, req.before_turn, kind)?
        .ok_or_else(|| {
            err(
                "ROLLBACK_STALE",
                format!("no {kind} checkpoint for turn {}", req.before_turn),
            )
        })?;
    if pruned {
        return Err(err(
            "ROLLBACK_STALE",
            if kind == "pre_rollback" {
                "that snapshot was already restored or has expired"
            } else {
                "that checkpoint was pruned by the storage quota"
            },
        ));
    }
    if crate::project::is_locked(&h.root_sheet) {
        return Err(err("TARGET_LOCKED", "the project is open in KiCad")
            .with_remediation("close it in KiCad and retry"));
    }
    // The files as they are now; the caller compares them against what the
    // human was shown (`rollback_preview`), and `restore` locks each one.
    let obs = observe(&h.root);
    if let Some(expected) = &req.state_sha256 {
        if *expected != state_token(&h.root, &obs) {
            return Err(err(
                "ROLLBACK_STALE",
                "the project changed after the rollback was shown",
            )
            .with_remediation("re-read the project and roll back again"));
        }
    }
    let now_turn = state.db.lock().project_last_turn(&h.key)? + 1;
    // Restoring a pre-rollback snapshot consumes it; it does not take another one
    // (the state it would snapshot is exactly the checkpoint the rollback restored).
    let pre = if kind == "turn" {
        Some(create(state, h, now_turn, "pre_rollback")?)
    } else {
        None
    };
    let dir = dir_for(&h.key, req.before_turn, kind);
    // Files created since the checkpoint go into the pre-rollback snapshot, the one place the human can
    // restore them from. Restoring a pre-rollback snapshot takes none, so its extras go to a sibling
    // `removed/<turn>` directory outside the snapshot: the snapshot directory itself is deleted below
    // once consumed, and a default inside it would have destroyed those files.
    let removed_dir = Some(match pre.as_ref() {
        Some(p) => dir_for(&h.key, p.turn, "pre_rollback").join("removed"),
        None => dir_for(&h.key, now_turn, "removed"),
    });
    let depth = state.settings.read().storage.checkpoint_turns.min(3) as usize;
    // Write-ahead: a crash during the multi-file restore is visible to recovery as an open `rollback_begin`.
    crate::sidecar::journal_append(
        &h.root,
        &serde_json::json!({"ts": crate::paths::now_iso(), "kind": "rollback_begin", "before_turn": req.before_turn, "checkpoint_kind": kind, "now_turn": now_turn, "pre_rollback": pre.as_ref().map(|p| p.turn)}),
    )?;
    let out = sch_write::checkpoint::restore(
        &h.root,
        &dir,
        sch_write::checkpoint::RestoreOptions {
            expected_manifest_sha: Some(&sha),
            current: Some(&obs),
            backup_depth: depth,
            removed_dir: removed_dir.as_deref(),
        },
    )
    .map_err(|e| {
        let s = e.to_string();
        let code = if s.contains("TAMPERED") {
            "CHECKPOINT_TAMPERED"
        } else if s.contains("STALE") {
            "ROLLBACK_STALE"
        } else if s.contains("SCOPE") {
            "PATH_OUT_OF_SCOPE"
        } else if s.contains("TARGET_LOCKED") {
            "TARGET_LOCKED"
        } else {
            "TXN_ROLLBACK_FAILED"
        };
        let e = err(code, s);
        if code == "ROLLBACK_STALE" {
            e.with_remediation("re-read the project and roll back again")
        } else {
            e
        }
    })?;
    {
        let mut own = h.own_shas.lock();
        for f in &out.restored {
            if let Some(s) = sch_write::atomic::file_sha(f) {
                own.insert(s);
            }
        }
    }
    // Single use: the snapshot is gone once it has been restored.
    if kind == "pre_rollback" {
        state
            .db
            .lock()
            .checkpoint_mark_pruned(&h.key, req.before_turn, "pre_rollback")?;
        let _ = std::fs::remove_dir_all(&dir);
    }
    state.db.lock().project_set_turn(&h.key, now_turn)?;
    let rel = |v: &[PathBuf]| -> Vec<String> {
        v.iter().map(|p| crate::paths::rel_to(&h.root, p)).collect()
    };
    crate::sidecar::journal_append(
        &h.root,
        &serde_json::json!({"ts": crate::paths::now_iso(), "kind": "rollback", "before_turn": req.before_turn, "checkpoint_kind": kind, "now_turn": now_turn, "files": rel(&out.restored), "removed": rel(&out.removed)}),
    )?;
    state.sessions.lock().expire_project(&h.key);
    Ok(RollbackResult {
        restored_files: rel(&out.restored),
        removed_files: rel(&out.removed),
        pre_rollback_checkpoint: pre,
        now_turn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    fn fixture() -> (tempfile::TempDir, Arc<AppState>, Arc<ProjectHandle>) {
        let d = tempfile::tempdir().unwrap();
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/conformance/fixtures/hier");
        for f in [
            "hier_root.kicad_sch",
            "hier_child.kicad_sch",
            "hier.kicad_pro",
        ] {
            std::fs::copy(src.join(f), d.path().join(f)).unwrap();
        }
        let state = AppState::for_tests();
        let pro = d
            .path()
            .join("hier.kicad_pro")
            .to_string_lossy()
            .to_string();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let h = state.project(&info.key).unwrap();
        (d, state, h)
    }

    fn grant(state: &AppState, key: &str) -> String {
        state
            .sessions
            .lock()
            .create_grant(&GrantRequest {
                project_key: key.into(),
                kind: "rollback".into(),
                payload_sha256: "sha".into(),
                consent_event_id: "consent".into(),
                action: None,
            })
            .id
    }

    fn request(state: &AppState, h: &ProjectHandle, turn: u32, kind: &str) -> RollbackRequest {
        RollbackRequest {
            project_key: h.key.clone(),
            before_turn: turn,
            grant: grant(state, &h.key),
            kind: Some(kind.into()),
            state_sha256: None,
        }
    }

    /// The optimistic lock is live: what the human confirmed is the state the
    /// preview showed, and an edit made in KiCad afterwards is not overwritten.
    #[test]
    fn rollback_refuses_a_project_that_changed_after_the_preview() {
        let (d, state, h) = fixture();
        let root = d.path().join("hier_root.kicad_sch");
        let before = std::fs::read(&root).unwrap();
        create(&state, &h, 1, "turn").unwrap();
        std::fs::write(&root, b"(kicad_sch agent wrote this)").unwrap();
        let p = preview(&state, &h, 1, "turn").unwrap();
        assert!(p.restore_files.iter().any(|f| f == "hier_root.kicad_sch"));
        assert!(p.remove_files.is_empty());
        // The human reads the dialog; KiCad writes the file meanwhile.
        std::fs::write(&root, b"(kicad_sch a human wrote this)").unwrap();
        let mut req = request(&state, &h, 1, "turn");
        req.state_sha256 = Some(p.state_sha256.clone());
        let e = rollback(&state, &h, &req).unwrap_err();
        assert_eq!(e.code, "ROLLBACK_STALE");
        assert_eq!(
            std::fs::read(&root).unwrap(),
            b"(kicad_sch a human wrote this)",
            "nothing was written"
        );
        // Re-read, then roll back: it goes through.
        let p2 = preview(&state, &h, 1, "turn").unwrap();
        let mut req = request(&state, &h, 1, "turn");
        req.state_sha256 = Some(p2.state_sha256);
        let r = rollback(&state, &h, &req).unwrap();
        assert!(r.pre_rollback_checkpoint.is_some());
        assert_eq!(std::fs::read(&root).unwrap(), before);
    }

    /// D-34: the overwritten state is kept as a snapshot that can be restored
    /// exactly once.
    #[test]
    fn pre_rollback_snapshot_restores_once() {
        let (d, state, h) = fixture();
        let root = d.path().join("hier_root.kicad_sch");
        create(&state, &h, 1, "turn").unwrap();
        std::fs::write(&root, b"(kicad_sch human edit)").unwrap();
        let r = rollback(&state, &h, &request(&state, &h, 1, "turn")).unwrap();
        let snap = r.pre_rollback_checkpoint.unwrap();
        assert_ne!(std::fs::read(&root).unwrap(), b"(kicad_sch human edit)");
        let back = rollback(&state, &h, &request(&state, &h, snap.turn, "pre_rollback")).unwrap();
        assert!(back.pre_rollback_checkpoint.is_none());
        assert_eq!(std::fs::read(&root).unwrap(), b"(kicad_sch human edit)");
        // Single use.
        let e = rollback(&state, &h, &request(&state, &h, snap.turn, "pre_rollback")).unwrap_err();
        assert_eq!(e.code, "ROLLBACK_STALE");
        assert!(!dir_for(&h.key, snap.turn, "pre_rollback").exists());
        // The turn checkpoint with the same number is untouched by that pruning.
        create(&state, &h, snap.turn, "turn").unwrap();
        assert!(state
            .db
            .lock()
            .checkpoint_get(&h.key, snap.turn, "turn")
            .unwrap()
            .is_some_and(|(_, pruned)| !pruned));
    }

    /// A sheet created by the rolled-back turn is not in the manifest: it must
    /// leave the project (kept in the snapshot), not stay behind as an orphan.
    #[test]
    fn a_sheet_created_since_the_checkpoint_moves_into_the_snapshot() {
        let (d, state, h) = fixture();
        create(&state, &h, 1, "turn").unwrap();
        let orphan = d.path().join("new_sheet.kicad_sch");
        std::fs::write(&orphan, b"(kicad_sch created by turn 1)").unwrap();
        let p = preview(&state, &h, 1, "turn").unwrap();
        assert_eq!(p.remove_files, vec!["new_sheet.kicad_sch".to_string()]);
        let r = rollback(&state, &h, &request(&state, &h, 1, "turn")).unwrap();
        assert_eq!(r.removed_files, vec!["new_sheet.kicad_sch".to_string()]);
        assert!(!orphan.exists(), "no orphan left in the project");
        let snap = r.pre_rollback_checkpoint.unwrap();
        let kept = dir_for(&h.key, snap.turn, "pre_rollback")
            .join("removed")
            .join("new_sheet.kicad_sch");
        assert_eq!(
            std::fs::read(&kept).unwrap(),
            b"(kicad_sch created by turn 1)"
        );
        // Restoring the snapshot brings the sheet back with everything else.
        rollback(&state, &h, &request(&state, &h, snap.turn, "pre_rollback")).unwrap();
        assert_eq!(
            std::fs::read(&orphan).unwrap(),
            b"(kicad_sch created by turn 1)"
        );
    }

    /// The dialog promises the snapshot for 7 days; after that it is storage.
    #[test]
    fn pre_rollback_snapshots_expire_after_seven_days() {
        let (_d, state, h) = fixture();
        let cp = create(&state, &h, 9, "pre_rollback").unwrap();
        let dir = dir_for(&h.key, 9, "pre_rollback");
        assert!(dir.exists());
        prune(&state, &h).unwrap();
        assert!(dir.exists(), "a fresh snapshot stays");
        let old = (chrono::Utc::now() - chrono::Duration::days(PRE_ROLLBACK_KEEP_DAYS + 1))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        state
            .db
            .lock()
            .conn
            .execute(
                "UPDATE checkpoints SET created=?3 WHERE project_key=?1 AND turn=?2 AND kind='pre_rollback'",
                rusqlite::params![h.key, cp.turn, old],
            )
            .unwrap();
        prune(&state, &h).unwrap();
        assert!(!dir.exists());
        assert!(state
            .db
            .lock()
            .checkpoint_get(&h.key, 9, "pre_rollback")
            .unwrap()
            .is_some_and(|(_, pruned)| pruned));
    }
}
