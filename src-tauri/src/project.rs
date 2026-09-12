// SPDX-License-Identifier: Apache-2.0
//! Project lifecycle: open / close / new / recent (D-57).

use crate::error::{err, io_err};
use crate::ipc::*;
use crate::paths::{now_iso, sha256_hex, write_atomic};
use crate::state::{AppState, ProjectHandle};
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Find the root schematic for a path that may be a `.kicad_pro`,
/// `.kicad_sch` or a directory.
pub fn locate_root(path: &Path) -> Result<(PathBuf, PathBuf), IpcError> {
    let p = path.canonicalize().map_err(|e| io_err(path, e))?;
    let dir = if p.is_dir() {
        p.clone()
    } else {
        p.parent().map(|x| x.to_path_buf()).unwrap_or(p.clone())
    };
    if p.is_file() {
        match p.extension().and_then(|e| e.to_str()) {
            // D-57: a schematic with no `.kicad_pro` next to it is a standalone file. It is not an
            // error the user has to fix before looking at it - `open` turns this into a read-only
            // project (no sidecar is written) that offers [Create project shell].
            Some("kicad_sch") => {
                return if has_project_file(&dir, &p) {
                    Ok((dir, p))
                } else {
                    Err(no_pro(&p))
                };
            }
            Some("kicad_pro") => {
                let sch = p.with_extension("kicad_sch");
                if sch.exists() {
                    return Ok((dir, sch));
                }
                return match root_candidates(&dir)?.as_slice() {
                    [one] => Ok((dir.clone(), one.clone())),
                    [] => Err(err(
                        "PROJECT_ROOT_SHEET_MISMATCH",
                        format!("{} has no root schematic next to it", p.display()),
                    )),
                    _ => Err(err(
                        "PROJECT_ROOT_AMBIGUOUS",
                        "several root schematics; open the root sheet directly",
                    )),
                };
            }
            _ => return Err(err("PROJECT_NO_PRO", "not a KiCad project or schematic")),
        }
    }
    let mut pros: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| io_err(&dir, e))?
        .flatten()
        .map(|e| e.path())
        .filter(|f| f.extension().map(|x| x == "kicad_pro").unwrap_or(false))
        .collect();
    pros.sort();
    match pros.len() {
        0 => {
            let mut schs: Vec<PathBuf> = std::fs::read_dir(&dir)
                .map_err(|e| io_err(&dir, e))?
                .flatten()
                .map(|e| e.path())
                .filter(|f| f.extension().map(|x| x == "kicad_sch").unwrap_or(false))
                .collect();
            schs.sort();
            if schs.len() == 1 {
                Err(no_pro(&schs[0]))
            } else if schs.is_empty() {
                Err(err("PROJECT_NO_PRO", "no .kicad_pro in this folder")
                    .with_remediation("choose a KiCad project file"))
            } else {
                Err(err(
                    "PROJECT_ROOT_AMBIGUOUS",
                    "several schematics and no .kicad_pro",
                )
                .with_remediation("open the root schematic directly"))
            }
        }
        1 => {
            let sch = pros[0].with_extension("kicad_sch");
            if sch.exists() {
                Ok((dir, sch))
            } else {
                match root_candidates(&dir)?.as_slice() {
                    [one] => Ok((dir.clone(), one.clone())),
                    [] => Err(err("PROJECT_ROOT_SHEET_MISMATCH", "root schematic missing")),
                    _ => Err(err(
                        "PROJECT_ROOT_AMBIGUOUS",
                        "several root schematics; open the root sheet directly",
                    )),
                }
            }
        }
        _ => Err(err("PROJECT_ROOT_AMBIGUOUS", "several .kicad_pro files")
            .with_remediation("open one project file directly")),
    }
}

/// A `.kicad_pro` that makes `sheet` part of a project: the one with the same stem, or any
/// project file in the folder (a child sheet opened directly, or a `PROJECT_NAME_MISMATCH`).
fn has_project_file(dir: &Path, sheet: &Path) -> bool {
    if sheet.with_extension("kicad_pro").exists() {
        return true;
    }
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.path()
                    .extension()
                    .map(|x| x == "kicad_pro")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// `PROJECT_NO_PRO` carrying the sheet that can still be opened read-only (D-57).
fn no_pro(sheet: &Path) -> IpcError {
    err(
        "PROJECT_NO_PRO",
        format!("{} has no .kicad_pro beside it", sheet.display()),
    )
    .with_remediation("create a project shell so the agent can make changes")
    .with_evidence(serde_json::json!({"sheet": sheet.to_string_lossy()}))
}

/// Schematics in `dir` that no other schematic in `dir` references as a child.
fn root_candidates(dir: &Path) -> Result<Vec<PathBuf>, IpcError> {
    let mut schs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| io_err(dir, e))?
        .flatten()
        .map(|e| e.path())
        .filter(|f| f.extension().map(|x| x == "kicad_sch").unwrap_or(false))
        .collect();
    schs.sort();
    let mut children = std::collections::HashSet::new();
    for s in &schs {
        if let Ok((sheet, _)) = sch_read::read_sheet(s) {
            for c in &sheet.sheets {
                children.insert(dir.join(&c.file));
            }
        }
    }
    Ok(schs.into_iter().filter(|s| !children.contains(s)).collect())
}

pub fn project_key(root_uuid: &str, root: &Path) -> String {
    sha256_hex(format!("{root_uuid}|{}", root.to_string_lossy()).as_bytes())[..32].to_string()
}

/// `.lck` present *and still present after a short grace*: `kicad-cli` and a
/// KiCad window that is just being closed leave transient locks that must not
/// end a Build session.
pub fn is_locked(root_sheet: &Path) -> bool {
    if !sch_write::atomic::is_locked(root_sheet) {
        LOCK_CACHE.lock().remove(root_sheet);
        return false;
    }
    // A confirmed lock is remembered for a few seconds: `info()` is called on every watcher event and the
    // grace wait below would otherwise block IPC for two seconds each time KiCad has the sheet open.
    if let Some((when, locked)) = LOCK_CACHE.lock().get(root_sheet).cloned() {
        if when.elapsed() < std::time::Duration::from_secs(3) {
            return locked;
        }
    }
    for _ in 0..4 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if !sch_write::atomic::is_locked(root_sheet) {
            return false;
        }
    }
    LOCK_CACHE
        .lock()
        .insert(root_sheet.to_path_buf(), (std::time::Instant::now(), true));
    true
}

/// The watcher saw a lock disappear: forget the cached "locked" verdict so the next `info()`
/// reads the filesystem instead of serving the remaining seconds of the cache.
pub fn lock_released(root_sheet: &Path) {
    LOCK_CACHE.lock().remove(root_sheet);
}

static LOCK_CACHE: std::sync::LazyLock<
    parking_lot::Mutex<std::collections::HashMap<PathBuf, (std::time::Instant, bool)>>,
> = std::sync::LazyLock::new(|| parking_lot::Mutex::new(std::collections::HashMap::new()));

fn git_state(root: &Path) -> Option<GitState> {
    let git = root.join(".git");
    if !git.exists() {
        return None;
    }
    let head = std::fs::read_to_string(git.join("HEAD"))
        .ok()
        .map(|h| h.trim().to_string());
    let head = head.and_then(|h| {
        if let Some(r) = h.strip_prefix("ref: ") {
            std::fs::read_to_string(git.join(r))
                .ok()
                .map(|s| s.trim()[..7.min(s.trim().len())].to_string())
        } else {
            Some(h[..7.min(h.len())].to_string())
        }
    });
    Some(GitState { dirty: false, head })
}

pub fn info(state: &AppState, h: &ProjectHandle) -> Result<ProjectInfo, IpcError> {
    let tree = sch_read::read_project(&h.root_sheet)?;
    let sheets = tree
        .instances
        .iter()
        .map(|i| {
            let s = tree.files.get(&i.file);
            SheetInfo {
                file: crate::paths::rel_to(&h.root, &i.file),
                instance_path: i.path.clone(),
                names: i
                    .names
                    .split('/')
                    .filter(|x| !x.is_empty())
                    .map(|x| x.to_string())
                    .collect(),
                paper: s.map(|s| s.paper.clone()).unwrap_or_default(),
                symbols: s.map(|s| s.symbols.len()).unwrap_or(0),
            }
        })
        .collect();
    let row = state.db.lock().project_row(&h.key)?;
    let config = crate::sidecar::read_project_config(&h.root).unwrap_or(serde_json::json!({}));
    Ok(ProjectInfo {
        key: h.key.clone(),
        root: h.root.to_string_lossy().to_string(),
        root_sheet: crate::paths::rel_to(&h.root, &h.root_sheet),
        root_uuid: h.root_uuid.clone(),
        name: h.name.clone(),
        version: tree.root().version as u32,
        sheets,
        config,
        git: git_state(&h.root),
        last_turn: row
            .as_ref()
            .and_then(|r| r["last_turn"].as_u64())
            .unwrap_or(0) as u32,
        last_mode: row
            .as_ref()
            .and_then(|r| r["last_mode"].as_str())
            .unwrap_or("plan")
            .to_string(),
        policy_override: row
            .as_ref()
            .and_then(|r| r["policy_override"].as_str())
            .map(|s| s.to_string()),
        locked: is_locked(&h.root_sheet),
        recovery: h.recovery.lock().clone(),
        cloud_synced: h.cloud_synced,
        no_pro: h.no_pro,
    })
}

pub fn open(state: &AppState, path: &str, identity: Option<&str>) -> Result<ProjectInfo, IpcError> {
    let (root, root_sheet, no_pro) = match locate_root(Path::new(path)) {
        Ok((root, sheet)) => (root, sheet, false),
        // D-57: standalone `.kicad_sch` - open it read-only (canvas + Q&A) instead of refusing.
        Err(e) if e.code == "PROJECT_NO_PRO" => {
            match e
                .evidence
                .as_ref()
                .and_then(|v| v.get("sheet"))
                .and_then(|v| v.as_str())
            {
                Some(sheet) => {
                    let sheet = PathBuf::from(sheet);
                    let dir = sheet
                        .parent()
                        .map(|d| d.to_path_buf())
                        .unwrap_or_else(|| sheet.clone());
                    (dir, sheet, true)
                }
                None => return Err(e),
            }
        }
        Err(e) => return Err(e),
    };
    let tree = sch_read::read_project(&root_sheet)?;
    let mut key = project_key(&tree.root_uuid, &root);
    if let Some(existing) = state.projects.read().get(&key).cloned() {
        return info(state, &existing);
    }
    // Same root uuid seen at another path: the folder was moved (keep the history under the old key) or
    // copied (a new project). Nothing is guessed: without a decision the open is refused with both paths.
    let mut copied_fresh = false;
    // A project that was re-keyed by an earlier "moved" decision keeps that key for this path.
    if let Some(k) = state
        .db
        .lock()
        .project_key_for(&tree.root_uuid, &root.to_string_lossy())?
    {
        key = k;
        if let Some(existing) = state.projects.read().get(&key).cloned() {
            return info(state, &existing);
        }
    }
    if state.db.lock().project_row(&key)?.is_none() {
        if let Some(prev) = state.db.lock().project_by_uuid(&tree.root_uuid)? {
            let old_path = prev["path"].as_str().unwrap_or("").to_string();
            let old_key = prev["key"].as_str().unwrap_or("").to_string();
            if !old_path.is_empty() && old_path != root.to_string_lossy() && !old_key.is_empty() {
                let old_exists = Path::new(&old_path).exists();
                match identity {
                    Some("moved") if old_exists || state.projects.read().contains_key(&old_key) => {
                        return Err(err(
                            "PROJECT_MOVED_OR_COPIED",
                            format!("the original still exists at {old_path}: this folder is a copy"),
                        )
                        .with_remediation("open it as a copy (new project)")
                        .with_evidence(serde_json::json!({"old_path": old_path, "new_path": root.to_string_lossy(), "old_exists": true})));
                    }
                    Some("moved") => {
                        key = old_key.clone();
                        state.db.lock().project_identity_set(&old_key, "moved")?;
                    }
                    Some("copied") => copied_fresh = true,
                    _ => {
                        return Err(err(
                            "PROJECT_MOVED_OR_COPIED",
                            format!("this project was last opened at {old_path}"),
                        )
                        .with_evidence(serde_json::json!({"old_path": old_path, "new_path": root.to_string_lossy(), "old_exists": old_exists})));
                    }
                }
            }
        }
    }
    let name = sch_write::project_name(&root_sheet);
    let (_, rows) = state.lib_env();
    let handle = Arc::new(ProjectHandle {
        key: key.clone(),
        root: root.clone(),
        root_sheet: root_sheet.clone(),
        root_uuid: tree.root_uuid.clone(),
        name: name.clone(),
        engine: Mutex::new(sch_write::Engine::new(sch_read::SymbolLibrary::new(rows))),
        own_shas: Mutex::new(Default::default()),
        apply_cache: Mutex::new(Default::default()),
        watcher: Mutex::new(None),
        recovery: Mutex::new(None),
        panic_counts: Mutex::new(Default::default()),
        cloud_synced: crate::cloud::sync_service(&root).is_some(),
        tree_cache: parking_lot::Mutex::new(None),
        advisory: Default::default(),
        no_pro,
    });
    // A standalone sheet gets no `.fluxsmith/` beside it: nothing may write into a folder the
    // user only asked us to look at (D-57). The sidecar appears with the project shell.
    if !no_pro {
        crate::sidecar::ensure_layout(&root)?;
    }
    // Crash recovery (docs/crash-recovery.md §4): adjudicate the last turns' ledgers
    // against the files and clean orphans before anything else touches the project.
    if !no_pro {
        let last_turn = state.db.lock().project_last_turn(&key).unwrap_or(0);
        let rep = crate::recovery::scan(&root, last_turn);
        if !rep.cleaned.is_empty()
            || !rep.steps.is_empty()
            || rep.pending_card.is_some()
            || rep.turn.is_some()
        {
            crate::log::info(&format!(
                "recovery {}: turn={:?} phase={:?} cleaned={} steps={} pending_card={}",
                name,
                rep.turn,
                rep.phase_at_interrupt,
                rep.cleaned.len(),
                rep.steps.len(),
                rep.pending_card.is_some()
            ));
            *handle.recovery.lock() = Some(rep);
        }
    }
    state
        .db
        .lock()
        .project_upsert(&key, &tree.root_uuid, &root.to_string_lossy(), &name)?;
    if copied_fresh {
        // A copy carries the original's `.fluxsmith/turns/<n>` sidecars: continue numbering after them so a
        // new turn never writes into an old turn's directory.
        let max_turn = std::fs::read_dir(root.join(".fluxsmith").join("turns"))
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| e.file_name().to_string_lossy().parse::<u32>().ok())
                    .max()
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let db = state.db.lock();
        db.project_identity_set(&key, "copied")?;
        if max_turn > 0 {
            db.project_set_turn(&key, max_turn)?;
        }
    }
    state
        .sessions
        .lock()
        .session_open_nets
        .insert(key.clone(), sch_net::build_nets(&tree));
    state.projects.write().insert(key.clone(), handle.clone());
    if let Some(h) = state.handle.get() {
        let w = crate::watch::start(h.clone(), handle.clone());
        *handle.watcher.lock() = w;
    }
    info(state, &handle)
}

/// D-57: turn a standalone `.kicad_sch` into a project. A structural action, so the caller records
/// a consent event first (the same shape entering Build uses) and passes its id here. Writes
/// `<stem>.kicad_pro` (root uuid = the sheet's own `(uuid)`, so the project identity does not
/// change), the project lib tables when they are missing and a `.gitignore` for the sidecar, then
/// reopens the folder as a normal project.
pub fn shell_create(
    state: &AppState,
    sheet: &str,
    consent_event_id: &str,
) -> Result<ProjectInfo, IpcError> {
    if !state.db.lock().consent_exists(consent_event_id)? {
        return Err(err(
            "CONSENT_REQUIRED",
            "creating a project shell needs a recorded consent",
        ));
    }
    let given = Path::new(sheet);
    let sheet_path = given.canonicalize().map_err(|e| io_err(given, e))?;
    let (pro, root_uuid) = write_shell(&sheet_path)?;
    let dir = pro
        .parent()
        .map(|d| d.to_path_buf())
        .unwrap_or_else(|| sheet_path.clone());
    // The read-only handle for this sheet has the same project key (root uuid + path), and `open`
    // returns a cached handle: drop it so the reopen builds a full project.
    close(state, &project_key(&root_uuid, &dir))?;
    open(state, &pro.to_string_lossy(), None)
}

/// The files a project shell is made of, written next to `sheet_path`: `<stem>.kicad_pro`, the
/// project lib tables when they are missing and a `.gitignore` line for the sidecar. Returns the
/// project file and the root uuid. Split out of `shell_create` so it can be tested without an
/// `AppState`.
fn write_shell(sheet_path: &Path) -> Result<(PathBuf, String), IpcError> {
    if sheet_path.extension().and_then(|e| e.to_str()) != Some("kicad_sch") {
        return Err(err(
            "PROJECT_NO_PRO",
            "a project shell is created from a .kicad_sch file",
        ));
    }
    let dir = sheet_path
        .parent()
        .map(|d| d.to_path_buf())
        .ok_or_else(|| err("BAD_CONFIG", "the schematic has no parent folder"))?;
    let stem = sheet_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or_else(|| err("BAD_CONFIG", "the schematic has no file name"))?;
    let pro = dir.join(format!("{stem}.kicad_pro"));
    if pro.exists() {
        return Err(err(
            "BAD_CONFIG",
            "a project file already exists next to this schematic",
        ));
    }
    // The root uuid is the sheet's own `(uuid)`: app data is keyed on it, so the shell must not
    // mint a new one.
    let tree = sch_read::read_project(sheet_path)?;
    let root_uuid = tree.root_uuid.clone();
    let mut doc: serde_json::Value = serde_json::from_str(&sch_write::nodes::empty_project(&stem))?;
    doc["sheets"] = serde_json::json!([[root_uuid.clone(), "Root"]]);
    write_atomic(
        &pro,
        format!("{}\n", serde_json::to_string_pretty(&doc)?).as_bytes(),
    )?;
    // Project-local library tables. KiCad merges them with the global ones, so empty is valid and
    // an existing table is never touched.
    for (file, root_name) in [
        ("sym-lib-table", "sym_lib_table"),
        ("fp-lib-table", "fp_lib_table"),
    ] {
        let table = dir.join(file);
        if !table.exists() {
            write_atomic(
                &table,
                format!("({root_name}\n  (version 7)\n)\n").as_bytes(),
            )?;
        }
    }
    // Keep the sidecar out of git from the first commit (the sidecar writes its own `.gitignore`
    // as well, FR-113); a `.gitignore` the user already has is appended to, never replaced.
    let gitignore = dir.join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    if !existing.lines().any(|l| l.trim() == ".fluxsmith/") {
        let mut next = existing;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str("# fluxsmith sidecar: local state, not design truth\n.fluxsmith/\n");
        write_atomic(&gitignore, next.as_bytes())?;
    }
    Ok((pro, root_uuid))
}

pub fn close(state: &AppState, key: &str) -> Result<(), IpcError> {
    if let Some(h) = state.projects.write().remove(key) {
        if let Some(w) = h.watcher.lock().take() {
            w.stop();
        }
    }
    state.sessions.lock().expire_project(key);
    state.sessions.lock().turns.remove(key);
    Ok(())
}

pub fn list_recent(state: &AppState) -> Result<Vec<RecentProject>, IpcError> {
    let rows = state.db.lock().projects_recent()?;
    Ok(rows
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

pub fn create(state: &AppState, spec: &NewProjectSpec) -> Result<ProjectInfo, IpcError> {
    let name = spec.name.trim();
    if name.is_empty() || name.contains(['/', '\\', ':']) {
        return Err(err("BAD_CONFIG", "invalid project name"));
    }
    if spec.kicad_version != 10 {
        return Err(err(
            "VERSION_UNSUPPORTED",
            "new projects are written in the KiCad 10 format",
        ));
    }
    let dir = PathBuf::from(&spec.dir).join(name);
    if dir.exists()
        && std::fs::read_dir(&dir)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true)
    {
        return Err(err("BAD_CONFIG", "the target folder is not empty"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| io_err(&dir, e))?;
    let root_uuid = uuid::Uuid::new_v4().to_string();
    let paper = if spec.paper.is_empty() {
        "A4"
    } else {
        &spec.paper
    };
    let sch = sch_write::nodes::empty_schematic(&root_uuid, paper);
    write_atomic(&dir.join(format!("{name}.kicad_sch")), sch.as_bytes())?;
    let pro = serde_json::json!({
        "board": {"design_settings": {}, "layer_presets": [], "viewports": []},
        "libraries": {"pinned_footprint_libs": [], "pinned_symbol_libs": []},
        "meta": {"filename": format!("{name}.kicad_pro"), "version": 3},
        "net_settings": {"classes": [{"name": "Default", "priority": 2147483647}], "meta": {"version": 4}},
        "schematic": {"legacy_lib_dir": "", "legacy_lib_list": []},
        "sheets": [[root_uuid, "Root"]],
        "text_variables": {}
    });
    write_atomic(
        &dir.join(format!("{name}.kicad_pro")),
        serde_json::to_string_pretty(&pro)?.as_bytes(),
    )?;
    let toml = format!("# fluxsmith project config (docs/project-config.md)\nschema_version = 1\ncreated = \"{}\"\nkicad_target = 10\nbackup_depth = 3\ndisplay_units = \"mil\"\n\n[rails]\nnames = []\nmechanism = \"power_port\"\n\n[refdes_policy]\nfrozen_existing = true\nreuse_freed = false\n\n[check]\nfail_on = \"error\"\n", now_iso());
    write_atomic(&dir.join("fluxsmith.toml"), toml.as_bytes())?;
    open(
        state,
        &dir.join(format!("{name}.kicad_pro")).to_string_lossy(),
        None,
    )
}
#[cfg(test)]
mod tests {
    use super::*;

    fn sheet_in(dir: &Path, name: &str, uuid: &str) -> PathBuf {
        let p = dir.join(format!("{name}.kicad_sch"));
        std::fs::write(&p, sch_write::nodes::empty_schematic(uuid, "A4")).unwrap();
        p
    }

    #[test]
    fn standalone_sheet_reports_no_pro_with_the_sheet_as_evidence() {
        let d = tempfile::tempdir().unwrap();
        let sheet = sheet_in(d.path(), "loose", "11111111-2222-3333-4444-555555555555");
        let e = locate_root(&sheet).unwrap_err();
        assert_eq!(e.code, "PROJECT_NO_PRO");
        let evidence = e.evidence.unwrap();
        assert_eq!(
            Path::new(evidence["sheet"].as_str().unwrap()),
            sheet.canonicalize().unwrap()
        );
        // The folder itself resolves the same way.
        assert_eq!(locate_root(d.path()).unwrap_err().code, "PROJECT_NO_PRO");
        // With a project file beside it the sheet opens as a normal project.
        std::fs::write(
            d.path().join("loose.kicad_pro"),
            sch_write::nodes::empty_project("loose"),
        )
        .unwrap();
        let (root, root_sheet) = locate_root(&sheet).unwrap();
        assert_eq!(root, d.path().canonicalize().unwrap());
        assert_eq!(root_sheet, sheet.canonicalize().unwrap());
    }

    #[test]
    fn write_shell_creates_the_project_files_and_keeps_the_sheet_uuid() {
        let d = tempfile::tempdir().unwrap();
        let uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let sheet = sheet_in(d.path(), "loose", uuid);
        std::fs::write(d.path().join(".gitignore"), "build/\n").unwrap();
        let (pro, root_uuid) = write_shell(&sheet).unwrap();
        assert_eq!(root_uuid, uuid);
        assert_eq!(pro, d.path().join("loose.kicad_pro"));
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pro).unwrap()).unwrap();
        assert_eq!(doc["sheets"][0][0], uuid);
        assert_eq!(doc["meta"]["filename"], "loose.kicad_pro");
        assert!(d.path().join("sym-lib-table").exists());
        assert!(d.path().join("fp-lib-table").exists());
        let gitignore = std::fs::read_to_string(d.path().join(".gitignore")).unwrap();
        assert!(gitignore.starts_with("build/\n"));
        assert!(gitignore.lines().any(|l| l == ".fluxsmith/"));
        // The sheet now locates as a project root.
        assert!(locate_root(&sheet).is_ok());
        // A second shell would overwrite the project file: refused.
        assert_eq!(write_shell(&sheet).unwrap_err().code, "BAD_CONFIG");
    }
}
