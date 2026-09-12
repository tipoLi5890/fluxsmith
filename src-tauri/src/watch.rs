// SPDX-License-Identifier: Apache-2.0
//! Project file watcher: sha-based external change detection, `.lck`
//! detection, debounce, BuildSession invalidation.

use crate::ipc::AppEvent;
use crate::state::{AppState, ProjectHandle};
use notify::{RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;

pub struct WatchHandle {
    stop: mpsc::Sender<()>,
}

impl WatchHandle {
    pub fn stop(&self) {
        let _ = self.stop.send(());
    }
}

fn is_design_file(p: &Path) -> bool {
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    matches!(ext, "kicad_sch" | "kicad_pro" | "kicad_sym")
        || matches!(
            name,
            "sym-lib-table" | "fp-lib-table" | "fluxsmith.toml" | "intent.json"
        )
}

fn is_lock(p: &Path) -> bool {
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    name.starts_with('~') && name.ends_with(".lck")
}

/// How long a lock file must survive before it counts as a real editor holding the project.
const LOCK_RECHECK: Duration = Duration::from_millis(1500);

/// What to do with a deferred lock re-check.
#[derive(Debug, PartialEq, Eq)]
pub enum LockAction {
    /// The lock is gone and was never reported: it was transient, nothing to say.
    Gone,
    /// The lock is gone after `Emit` reported it: KiCad closed the sheet, tell the UI and the
    /// harness so the rollback button and the P7 flag do not stay stuck on "locked".
    Released,
    /// Ours (a `kicad_advisory` run holds KiCad's project lock for its whole run): check again
    /// later rather than dropping it, so a KiCad window opened during the run is still reported.
    Defer,
    /// Someone else has the project open.
    Emit,
}

/// `reported`: this lock was already announced with `LockDetected` and not yet released.
pub fn lock_action(exists: bool, advisory_active: bool, reported: bool) -> LockAction {
    if !exists {
        if reported {
            LockAction::Released
        } else {
            LockAction::Gone
        }
    } else if advisory_active {
        LockAction::Defer
    } else if reported {
        // Still held and already announced: nothing new to report.
        LockAction::Gone
    } else {
        LockAction::Emit
    }
}

/// The durable record of an external change (`journal.jsonl`), written by the watcher so a change
/// made between turns leaves a trace even though no turn was running to file it under.
/// `files` carries the sha after the change (`None` for a deleted file).
pub fn external_change_entry(
    ts: &str,
    after_turn: u32,
    files: &[(String, Option<String>)],
) -> serde_json::Value {
    let shas: serde_json::Map<String, serde_json::Value> = files
        .iter()
        .map(|(f, s)| {
            (
                f.clone(),
                s.as_ref()
                    .map(|x| serde_json::Value::String(x.clone()))
                    .unwrap_or(serde_json::Value::Null),
            )
        })
        .collect();
    serde_json::json!({
        "ts": ts,
        "kind": "external_change",
        "after_turn": after_turn,
        "files": files.iter().map(|(f, _)| f.clone()).collect::<Vec<_>>(),
        "shas": shas,
    })
}

pub fn start(app: tauri::AppHandle, h: Arc<ProjectHandle>) -> Option<WatchHandle> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .ok()?;
    watcher.watch(&h.root, RecursiveMode::Recursive).ok()?;
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let debounce = crate::cloud::debounce_ms(h.cloud_synced);
    let mut known: HashMap<PathBuf, String> = HashMap::new();
    for f in crate::checkpoint::design_files(&h.root) {
        if let Some(s) = sch_write::atomic::file_sha(&f) {
            known.insert(f, s);
        }
    }
    std::thread::Builder::new()
        .name("fluxsmith-watch".into())
        .spawn(move || {
            let _keep = watcher;
            let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
            // Lock files to re-check, and when. Deferred rather than slept on: the watcher loop
            // must keep draining events while a `kicad-cli` advisory holds the project lock.
            let mut locks: HashMap<PathBuf, Instant> = HashMap::new();
            // Locks announced with `LockDetected` whose release has not been reported yet.
            let mut reported: HashSet<PathBuf> = HashSet::new();
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(150)) {
                    Ok(Ok(ev)) => {
                        for p in ev.paths {
                            if p.components()
                                .any(|c| c.as_os_str() == ".fluxsmith" || c.as_os_str() == ".git")
                            {
                                continue;
                            }
                            if is_lock(&p) {
                                // Transient locks (a kicad-cli run, a KiCad window being closed)
                                // vanish within a moment: re-check later, never block the loop.
                                locks
                                    .entry(p)
                                    .or_insert_with(|| Instant::now() + LOCK_RECHECK);
                                continue;
                            }
                            if is_design_file(&p) {
                                pending.insert(p, Instant::now());
                            }
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let due_locks: Vec<PathBuf> = locks
                    .iter()
                    .filter(|(_, t)| Instant::now() >= **t)
                    .map(|(p, _)| p.clone())
                    .collect();
                for p in due_locks {
                    match lock_action(p.exists(), h.advisory.active(), reported.contains(&p)) {
                        LockAction::Gone => {
                            locks.remove(&p);
                        }
                        LockAction::Released => {
                            locks.remove(&p);
                            reported.remove(&p);
                            crate::project::lock_released(&h.root_sheet);
                            let st: tauri::State<Arc<AppState>> = app.state();
                            st.emit(AppEvent::LockReleased {
                                project_key: h.key.clone(),
                                file: crate::paths::rel_to(&h.root, &p),
                            });
                        }
                        LockAction::Defer => {
                            locks.insert(p, Instant::now() + LOCK_RECHECK);
                        }
                        LockAction::Emit => {
                            locks.remove(&p);
                            reported.insert(p.clone());
                            let st: tauri::State<Arc<AppState>> = app.state();
                            st.emit(AppEvent::LockDetected {
                                project_key: h.key.clone(),
                                file: crate::paths::rel_to(&h.root, &p),
                            });
                        }
                    }
                }
                let due: Vec<PathBuf> = pending
                    .iter()
                    .filter(|(_, t)| t.elapsed() >= Duration::from_millis(debounce))
                    .map(|(p, _)| p.clone())
                    .collect();
                if due.is_empty() {
                    continue;
                }
                // (relative path, sha after the change; None = deleted)
                let mut changed: Vec<(String, Option<String>)> = Vec::new();
                let mut external = false;
                for p in due {
                    pending.remove(&p);
                    let sha = sch_write::atomic::file_sha(&p);
                    let before = known.get(&p).cloned();
                    match sha {
                        Some(s) => {
                            if before.as_deref() == Some(s.as_str()) {
                                continue;
                            }
                            known.insert(p.clone(), s.clone());
                            if !h.own_shas.lock().contains(&s) {
                                external = true;
                            }
                            changed.push((crate::paths::rel_to(&h.root, &p), Some(s)));
                        }
                        None => {
                            if before.is_some() {
                                known.remove(&p);
                                external = true;
                                changed.push((crate::paths::rel_to(&h.root, &p), None));
                            }
                        }
                    }
                }
                if changed.is_empty() {
                    continue;
                }
                crate::treecache::invalidate(&h.tree_cache);
                let st: tauri::State<Arc<AppState>> = app.state();
                if external {
                    let toks = st.sessions.lock().expire_project(&h.key);
                    if !toks.is_empty() {
                        st.emit(AppEvent::SessionExpired {
                            project_key: h.key.clone(),
                            reason: "external_change".into(),
                        });
                    }
                    h.apply_cache.lock().clear();
                    // Durable trace (agent-runtime.md §4.2 external turn): the harness only sees an
                    // event, and between turns nothing else would record that KiCad wrote. A
                    // standalone `.kicad_sch` has no sidecar (D-57), so nothing is written for it.
                    if !h.no_pro {
                        let after_turn = st.db.lock().project_last_turn(&h.key).unwrap_or(0);
                        let entry =
                            external_change_entry(&crate::paths::now_iso(), after_turn, &changed);
                        if let Err(e) = crate::sidecar::journal_append(&h.root, &entry) {
                            crate::log::event(
                                "warn",
                                "watch.journal_failed",
                                serde_json::json!({"error": e.message}),
                                None,
                            );
                        }
                    }
                }
                st.emit(AppEvent::FsChanged {
                    project_key: h.key.clone(),
                    files: changed.into_iter().map(|(f, _)| f).collect(),
                    external,
                });
            }
        })
        .ok()?;
    Some(WatchHandle { stop: stop_tx })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AdvisoryFlag;

    #[test]
    fn a_lock_held_by_our_own_advisory_run_is_deferred_not_reported() {
        let flag = AdvisoryFlag::default();
        assert!(!flag.active());
        assert_eq!(lock_action(true, flag.active(), false), LockAction::Emit);
        {
            let _guard = flag.enter();
            assert!(flag.active());
            assert_eq!(lock_action(true, flag.active(), false), LockAction::Defer);
            // A lock that vanished while we waited is never reported either way.
            assert_eq!(lock_action(false, flag.active(), false), LockAction::Gone);
        }
        // The grace keeps the flag set for a moment after the child exits, so a filesystem event
        // delivered late is still attributed to the advisory run.
        assert!(flag.active());
    }

    #[test]
    fn a_reported_lock_that_disappears_is_released_once() {
        // KiCad opens the sheet: the lock survives the grace and is announced.
        assert_eq!(lock_action(true, false, false), LockAction::Emit);
        // Later events on a lock already announced say nothing new.
        assert_eq!(lock_action(true, false, true), LockAction::Gone);
        // KiCad closes the sheet: the lock file goes away and the release is reported, so the
        // UI can re-enable rollback and the harness can clear P7 `external.locked`.
        assert_eq!(lock_action(false, false, true), LockAction::Released);
        // A transient lock (kicad-cli, a window being closed) that was never announced is silent.
        assert_eq!(lock_action(false, false, false), LockAction::Gone);
        // The advisory flag never masks a release.
        assert_eq!(lock_action(false, true, true), LockAction::Released);
    }

    #[test]
    fn external_change_journal_entry_shape() {
        let files = vec![
            ("root.kicad_sch".to_string(), Some("abc".to_string())),
            ("pwr.kicad_sch".to_string(), None),
        ];
        let v = external_change_entry("2026-09-06T00:00:00Z", 7, &files);
        assert_eq!(v["kind"], "external_change");
        assert_eq!(v["ts"], "2026-09-06T00:00:00Z");
        assert_eq!(v["after_turn"], 7);
        assert_eq!(
            v["files"],
            serde_json::json!(["root.kicad_sch", "pwr.kicad_sch"])
        );
        assert_eq!(v["shas"]["root.kicad_sch"], "abc");
        assert!(v["shas"]["pwr.kicad_sch"].is_null());
    }

    #[test]
    fn lock_paths_are_recognised_and_design_files_are_not() {
        assert!(is_lock(Path::new("/p/~board.kicad_pro.lck")));
        assert!(is_lock(Path::new("/p/~board.kicad_sch.lck")));
        assert!(!is_lock(Path::new("/p/board.kicad_sch")));
        assert!(!is_design_file(Path::new("/p/~board.kicad_pro.lck")));
        assert!(is_design_file(Path::new("/p/board.kicad_sch")));
    }
}
