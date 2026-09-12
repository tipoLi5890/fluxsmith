// SPDX-License-Identifier: Apache-2.0
//! Background symbol index (FR-807): every lib table row parsed into
//! `symbols` / `symbols_fts`, per-file mtime+size invalidation.

use crate::ipc::AppEvent;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct IndexState {
    pub building: AtomicBool,
    pub cancel: AtomicBool,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
}

impl IndexState {
    pub fn building(&self) -> bool {
        self.building.load(Ordering::Relaxed)
    }
    pub fn progress(&self) -> serde_json::Value {
        serde_json::json!({"done": self.done.load(Ordering::Relaxed), "total": self.total.load(Ordering::Relaxed), "building": self.building()})
    }
}

/// Spawn the indexing thread (no-op if one is running). `force` drops the
/// existing index first.
pub fn spawn(state: Arc<AppState>, force: bool) {
    if state.libindex.building.swap(true, Ordering::SeqCst) {
        if force {
            // Cancel the running pass and start the forced one once it has stopped.
            state.libindex.cancel.store(true, Ordering::SeqCst);
            std::thread::Builder::new()
                .name("fluxsmith-libindex-restart".into())
                .spawn(move || {
                    while state.libindex.building.load(Ordering::SeqCst) {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    spawn(state, true);
                })
                .ok();
        }
        return;
    }
    state.libindex.cancel.store(false, Ordering::SeqCst);
    std::thread::Builder::new()
        .name("fluxsmith-libindex".into())
        .spawn(move || {
            let result = run(&state, force);
            let cancelled = state.libindex.cancel.load(Ordering::SeqCst);
            state.libindex.building.store(false, Ordering::SeqCst);
            if cancelled {
                return; // the restart thread announces the forced pass
            }
            let count = state.db.lock().symbol_count();
            let st = match result {
                Ok(()) if count > 0 => "ready",
                Ok(()) => "empty",
                Err(e) => {
                    crate::log::warn(&format!("symbol index failed: {}", e.message));
                    "error"
                }
            };
            state.emit(AppEvent::SymbolIndex {
                state: st.into(),
                done: state.libindex.done.load(Ordering::Relaxed),
                total: state.libindex.total.load(Ordering::Relaxed),
            });
        })
        .ok();
}

fn run(state: &AppState, force: bool) -> Result<(), crate::ipc::IpcError> {
    if force {
        state.db.lock().lib_index_clear()?;
    }
    let (_, rows) = state.lib_env();
    // Project-scoped rows from every open project's sym-lib-table.
    let mut all: Vec<(sch_read::LibTableRow, &'static str)> =
        rows.into_iter().map(|r| (r, "global")).collect();
    let (env, _) = state.lib_env();
    for h in state.projects.read().values() {
        let t = h.root.join("sym-lib-table");
        if t.exists() {
            let mut env2 = env.clone();
            env2.insert("KIPRJMOD".into(), h.root.to_string_lossy().to_string());
            if let Ok(rs) = sch_read::parse_lib_table(&t, &env2, 0) {
                all.extend(rs.into_iter().map(|r| (r, "project")));
            }
        }
    }
    all.retain(|(r, _)| r.kind.eq_ignore_ascii_case("kicad") && r.uri.ends_with(".kicad_sym"));
    state.libindex.total.store(all.len(), Ordering::Relaxed);
    state.libindex.done.store(0, Ordering::Relaxed);
    let mut present = Vec::new();
    for (i, (row, scope)) in all.iter().enumerate() {
        if state.libindex.cancel.load(Ordering::Relaxed) {
            break;
        }
        let path = std::path::Path::new(&row.uri);
        present.push(row.uri.clone());
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        let unchanged = state
            .db
            .lock()
            .lib_file_state(&row.uri)?
            .map(|(m, s)| m == mtime && s == size)
            .unwrap_or(false);
        if !unchanged {
            if let Ok(src) = std::fs::read_to_string(path) {
                if let Ok(syms) = sch_read::parse_symbol_lib(&src, &row.nickname, path) {
                    state.db.lock().lib_file_replace(
                        &row.uri,
                        &row.nickname,
                        scope,
                        mtime,
                        size,
                        &syms,
                    )?;
                }
            }
        }
        state.libindex.done.store(i + 1, Ordering::Relaxed);
        if i % 20 == 0 {
            state.emit(AppEvent::SymbolIndex {
                state: "building".into(),
                done: i + 1,
                total: all.len(),
            });
        }
    }
    if state.libindex.cancel.load(Ordering::Relaxed) {
        // Cancelled (a forced rebuild is queued): a partial `present` list must not prune the index.
        return Ok(());
    }
    state.db.lock().lib_files_remove_missing(&present)?;
    Ok(())
}
