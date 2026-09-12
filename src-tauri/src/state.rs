// SPDX-License-Identifier: Apache-2.0
//! Process-wide state shared by all commands.

use crate::db::Db;
use crate::ipc::{AppEvent, EnvReport, Settings};
use crate::session::SessionStore;
use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;

pub struct ProjectHandle {
    pub key: String,
    pub root: PathBuf,
    pub root_sheet: PathBuf,
    pub root_uuid: String,
    pub name: String,
    pub engine: Mutex<sch_write::Engine>,
    /// sha256 of files we wrote ourselves (watcher ignores these).
    pub own_shas: Mutex<HashSet<String>>,
    /// (ops sha, target sha) -> apply result, for idempotent re-sends.
    pub apply_cache: Mutex<HashMap<(String, String), serde_json::Value>>,
    pub watcher: Mutex<Option<crate::watch::WatchHandle>>,
    /// Startup recovery scan (reported once through `ProjectInfo.recovery`).
    pub recovery: Mutex<Option<crate::ipc::RecoveryReport>>,
    /// ENGINE_PANIC count per request kind in this process (two in a row marks the kind unstable).
    pub panic_counts: Mutex<HashMap<String, u32>>,
    /// Root is inside a cloud-sync folder (watcher debounce 1 s; UI notice).
    pub cloud_synced: bool,
    /// Standalone `.kicad_sch` with no `.kicad_pro` (D-57): read-only, no `.fluxsmith/` sidecar.
    pub no_pro: bool,
    /// Parsed tree + render geometry, keyed on source shas (`treecache.rs`).
    pub tree_cache: crate::treecache::Slot,
    /// A `kicad_advisory` subprocess is in flight (`advisory.rs`): the watcher must not read the
    /// `~<project>.kicad_pro.lck` that `kicad-cli` holds for the whole run as a foreign editor.
    pub advisory: AdvisoryFlag,
}

/// How long after a `kicad_advisory` run its lock file is still considered ours. The lock is
/// released when the child exits, but the watcher's filesystem event for it can arrive later.
const ADVISORY_LOCK_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// "A `kicad-cli` advisory is running", for `watch.rs`. Counted rather than boolean so nested or
/// concurrent runs cannot clear it early; a real KiCad window holds its lock far longer than the
/// grace, and the watcher re-arms its deferred check instead of dropping it.
#[derive(Default)]
pub struct AdvisoryFlag(Mutex<(usize, Option<std::time::Instant>)>);

impl AdvisoryFlag {
    pub fn active(&self) -> bool {
        let g = self.0.lock();
        g.0 > 0 || g.1.is_some_and(|t| t.elapsed() < ADVISORY_LOCK_GRACE)
    }

    /// Marks a run in flight until the returned guard is dropped.
    pub fn enter(&self) -> AdvisoryGuard<'_> {
        self.0.lock().0 += 1;
        AdvisoryGuard(self)
    }
}

pub struct AdvisoryGuard<'a>(&'a AdvisoryFlag);

impl Drop for AdvisoryGuard<'_> {
    fn drop(&mut self) {
        let mut g = self.0 .0.lock();
        g.0 = g.0.saturating_sub(1);
        g.1 = Some(std::time::Instant::now());
    }
}

pub struct AppState {
    pub app_version: String,
    pub settings: RwLock<Settings>,
    pub db: Mutex<Db>,
    pub projects: RwLock<HashMap<String, Arc<ProjectHandle>>>,
    pub sessions: Mutex<SessionStore>,
    pub env: RwLock<EnvReport>,
    pub net: crate::net::NetState,
    pub libindex: crate::libindex::IndexState,
    pub handle: std::sync::OnceLock<tauri::AppHandle>,
}

impl AppState {
    pub fn emit(&self, ev: AppEvent) {
        if let Some(h) = self.handle.get() {
            let _ = h.emit("fluxsmith://event", &ev);
        }
    }

    pub fn project(&self, key: &str) -> Result<Arc<ProjectHandle>, crate::ipc::IpcError> {
        self.projects.read().get(key).cloned().ok_or_else(|| {
            crate::error::err("PROJECT_ROOT_MISSING", "project is not open")
                .with_remediation("open the project first")
        })
    }

    pub fn lib_env(
        &self,
    ) -> (
        std::collections::HashMap<String, String>,
        Vec<sch_read::LibTableRow>,
    ) {
        let s = self.settings.read();
        let (mut env, table) =
            sch_read::discover_kicad(s.kicad.app_path.as_deref().map(std::path::Path::new));
        if let Some(dir) = &s.kicad.symbol_dir_override {
            for k in [
                "KICAD10_SYMBOL_DIR",
                "KICAD9_SYMBOL_DIR",
                "KICAD8_SYMBOL_DIR",
            ] {
                env.insert(k.into(), dir.clone());
            }
        }
        let rows = table
            .and_then(|t| sch_read::parse_lib_table(&t, &env, 0).ok())
            .unwrap_or_default();
        (env, rows)
    }
}

#[cfg(test)]
impl AppState {
    /// In-memory state for unit tests (no Tauri handle, memory DB).
    pub fn for_tests() -> Arc<AppState> {
        // Never touch the real app data directory from tests: point every
        // checkpoint/asset/external write at one process-wide temp dir.
        static TEST_DATA: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
        let dir = TEST_DATA.get_or_init(|| tempfile::tempdir().expect("temp app data"));
        std::env::set_var("FLUXSMITH_APP_DATA", dir.path());
        let settings = crate::settings::defaults();
        Arc::new(AppState {
            app_version: "test".into(),
            settings: RwLock::new(settings),
            db: Mutex::new(crate::db::Db::open_memory().unwrap()),
            projects: RwLock::new(Default::default()),
            sessions: Mutex::new(Default::default()),
            env: RwLock::new(Default::default()),
            net: crate::net::NetState::new(2, "test"),
            libindex: Default::default(),
            handle: std::sync::OnceLock::new(),
        })
    }
}
