// SPDX-License-Identifier: Apache-2.0
//! Every `#[tauri::command]` — thin wrappers over the modules, mirroring
//! `Commands` in `src/ipc/types.ts`.

use crate::error::err;
use crate::ipc::*;
use crate::state::AppState;
use serde_json::Value;
use std::sync::Arc;
use tauri::{ipc::Channel, State};

type S<'a> = State<'a, Arc<AppState>>;

pub fn version(state: &AppState) -> VersionInfo {
    VersionInfo {
        app: state.app_version.clone(),
        engine: env!("CARGO_PKG_VERSION").into(),
        protocol_version: sch_ops::PROTOCOL_VERSION,
        tool_manifest_version: 1,
        db_schema: crate::db::DB_SCHEMA,
        settings_schema: crate::settings::SETTINGS_SCHEMA,
        ipc_version: IPC_VERSION,
        kicad_write_version: sch_read::WRITE_VERSION as u32,
        git_sha: option_env!("FLUXSMITH_GIT_SHA").unwrap_or("unknown").into(),
    }
}

/// Project paths given on the command line (`fluxsmith-app <path>…`, also
/// used by run-from-source and Open With). Only `.kicad_pro` / `.kicad_sch`
/// arguments are returned; everything else is ignored.
#[tauri::command(rename_all = "snake_case")]
pub fn startup_args() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| {
            a.ends_with(".kicad_pro")
                || a.ends_with(".kicad_sch")
                || a.starts_with("--settings=")
                || a.starts_with("--script=")
        })
        .collect()
}

pub(crate) fn script_path() -> Option<std::path::PathBuf> {
    std::env::args()
        .skip(1)
        .find_map(|a| a.strip_prefix("--script=").map(std::path::PathBuf::from))
}

/// Developer autorun: the JSON script named by `--script=<path>` on the command
/// line. Only that one file is readable, and only when the flag was given.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_script_read() -> IpcResult<Option<String>> {
    let Some(p) = script_path() else {
        return Ok(None);
    };
    let s = std::fs::read_to_string(&p).map_err(|e| crate::error::io_err(&p, e))?;
    Ok(Some(s))
}

/// Developer autorun report: written next to the script as `<script>.report.json`.
#[tauri::command(rename_all = "snake_case")]
pub fn dev_script_report(text: String) -> IpcResult<()> {
    let Some(p) = script_path() else {
        return Err(crate::error::err("BAD_CONFIG", "no --script argument"));
    };
    let out = p.with_extension("report.json");
    crate::paths::write_atomic(&out, text.as_bytes())
}

/// Developer autorun: sleep on the Rust side. WebKit parks DOM timers of an occluded page after a few
/// minutes (seen as the autorun wait loop freezing mid-run), while IPC round-trips keep working, so the
/// script's waits go through here. Only honoured with `--script=`; capped at 60 s.
#[tauri::command(rename_all = "snake_case")]
pub async fn dev_sleep(ms: u64) -> IpcResult<()> {
    if script_path().is_none() {
        return Err(crate::error::err("BAD_CONFIG", "no --script argument"));
    }
    tokio::time::sleep(std::time::Duration::from_millis(ms.min(60_000))).await;
    Ok(())
}

/// Developer autorun: quit after the report was written (only honoured when
/// `--script=` was given, so a stray IPC call cannot close a real session).
#[tauri::command(rename_all = "snake_case")]
pub fn dev_exit(app: tauri::AppHandle) -> IpcResult<()> {
    if script_path().is_none() {
        return Err(crate::error::err("BAD_CONFIG", "no --script argument"));
    }
    crate::log::info("autorun: exiting on script request");
    app.exit(0);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn version_info(state: S) -> IpcResult<VersionInfo> {
    Ok(version(&state))
}

#[tauri::command(rename_all = "snake_case")]
pub fn env_check(state: S, force: Option<bool>) -> IpcResult<EnvReport> {
    let _ = force;
    let k = state.settings.read().kicad.clone();
    let report = crate::env::check(&k);
    // Only a real change is an event: the requester already receives the report as the return value,
    // and an "environment changed" toast on every launch / re-check would cry wolf.
    let changed = {
        let prev = state.env.read();
        let strip = |r: &EnvReport| {
            let mut v = serde_json::to_value(r).unwrap_or_default();
            if let Some(o) = v.as_object_mut() {
                o.remove("checked_at");
            }
            v
        };
        strip(&prev) != strip(&report)
    };
    *state.env.write() = report.clone();
    if changed {
        state.emit(AppEvent::EnvChanged {
            report: report.clone(),
        });
    }
    if report.status == "ok" {
        crate::libindex::spawn(state.inner().clone(), false);
    }
    Ok(report)
}

fn with_secret_flags(_state: &AppState, mut s: Settings) -> Settings {
    for p in s.providers.iter_mut() {
        p.has_secret = crate::keyring::has(&p.id);
    }
    s
}

#[tauri::command(rename_all = "snake_case")]
pub fn settings_get(state: S) -> IpcResult<Settings> {
    Ok(with_secret_flags(&state, state.settings.read().clone()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn settings_set(state: S, patch: Value) -> IpcResult<Settings> {
    let cur = state.settings.read().clone();
    let next = crate::settings::apply_patch(&cur, patch.clone())?;
    // Safety-relevant changes are recorded as consent events (settings.md §11).
    for key in ["agent", "advanced", "kicad", "parts"] {
        if patch.get(key).is_some() {
            let id = uuid::Uuid::new_v4().to_string();
            let _ = state.db.lock().consent_insert(
                &id,
                None,
                "setting_change",
                &crate::paths::sha256_hex(patch.to_string().as_bytes()),
                "click",
            );
        }
    }
    crate::settings::save(&next)?;
    crate::log::set_level(&next.privacy.log_level);
    *state.settings.write() = next.clone();
    Ok(with_secret_flags(&state, next))
}

#[tauri::command(rename_all = "snake_case")]
pub fn settings_reset(state: S, keys: Vec<String>) -> IpcResult<Settings> {
    let cur = state.settings.read().clone();
    let next = if keys.is_empty() {
        crate::settings::defaults()
    } else {
        crate::settings::reset_keys(&cur, &keys)?
    };
    crate::settings::save(&next)?;
    *state.settings.write() = next.clone();
    Ok(with_secret_flags(&state, next))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn provider_models(state: S<'_>, provider_id: String) -> IpcResult<Vec<String>> {
    let st: Arc<AppState> = state.inner().clone();
    let models = crate::net::provider_models(&st, &provider_id).await?;
    // Remember the catalogue so the UI and the harness see it without re-fetching.
    if !models.is_empty() {
        let mut s = st.settings.read().clone();
        if let Some(p) = s.providers.iter_mut().find(|p| p.id == provider_id) {
            p.models = models.clone();
        }
        crate::settings::save(&s)?;
        *st.settings.write() = s;
    }
    Ok(models)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn provider_probe(
    state: S<'_>,
    provider_id: String,
    model: String,
) -> IpcResult<ProviderConfig> {
    let st: Arc<AppState> = state.inner().clone();
    let cfg = st
        .settings
        .read()
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .cloned()
        .ok_or_else(|| err("BAD_CONFIG", "unknown provider"))?;
    let probe = crate::probe::run(st.clone(), &cfg, &model).await?;
    let mut s = st.settings.read().clone();
    if let Some(p) = s.providers.iter_mut().find(|p| p.id == provider_id) {
        p.build_capable = probe.build_capable.clone();
        p.vision = probe.vision;
        p.probed_at = Some(crate::paths::now_iso());
        if !p.models.contains(&model) {
            p.models.push(model.clone());
        }
        if let Some(ctx) = probe.context_window {
            p.context_window = ctx;
        }
    }
    crate::settings::save(&s)?;
    *st.settings.write() = s.clone();
    let out = s
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .unwrap();
    Ok(with_secret_flags(
        &st,
        Settings {
            providers: vec![out],
            ..crate::settings::defaults()
        },
    )
    .providers
    .remove(0))
}

// ---------------------------------------------------------------- projects

#[tauri::command(rename_all = "snake_case")]
pub fn project_open(state: S, path: String, identity: Option<String>) -> IpcResult<ProjectInfo> {
    let info = crate::project::open(&state, &path, identity.as_deref())?;
    crate::libindex::spawn(state.inner().clone(), false);
    Ok(info)
}

#[tauri::command(rename_all = "snake_case")]
pub fn project_close(state: S, project_key: String) -> IpcResult<()> {
    crate::project::close(&state, &project_key)
}

#[tauri::command(rename_all = "snake_case")]
pub fn project_list_recent(state: S) -> IpcResult<Vec<RecentProject>> {
    crate::project::list_recent(&state)
}

#[tauri::command(rename_all = "snake_case")]
pub fn project_new(state: S, spec: NewProjectSpec) -> IpcResult<ProjectInfo> {
    crate::project::create(&state, &spec)
}

/// D-57: write the project files next to a standalone `.kicad_sch` and reopen it as a project.
/// Structural, so it takes the id of a consent event recorded for this action.
#[tauri::command(rename_all = "snake_case")]
pub fn project_shell_create(
    state: S,
    sheet: String,
    consent_event_id: String,
) -> IpcResult<ProjectInfo> {
    crate::project::shell_create(&state, &sheet, &consent_event_id)
}

/// Copy the bundled example project into `dir` (app data `examples/` when absent) and answer with
/// the path of its `.kicad_pro`, which the webview then opens like any other project.
#[tauri::command(rename_all = "snake_case")]
pub fn example_install(app: tauri::AppHandle, dir: Option<String>) -> IpcResult<String> {
    crate::example::install(Some(&app), dir.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn project_info(state: S, project_key: String) -> IpcResult<ProjectInfo> {
    let h = state.project(&project_key)?;
    crate::project::info(&state, &h)
}

// ------------------------------------------------------------------ engine

#[tauri::command(rename_all = "snake_case")]
pub async fn engine_request(
    state: S<'_>,
    project_key: String,
    request: EngineRequest,
    auth: Auth,
) -> IpcResult<EngineResponse> {
    let st: Arc<AppState> = state.inner().clone();
    let request_kind = serde_json::to_value(&request)
        .ok()
        .and_then(|v| {
            v.get("kind")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".into());
    crate::log::event(
        "debug",
        "ipc.engine_request",
        serde_json::json!({"kind": request_kind, "phase": "begin"}),
        None,
    );
    let kind_for_end = request_kind.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::engine::handle(&st, &project_key, request, auth)
        }));
        crate::log::event("debug", "ipc.engine_request", serde_json::json!({"kind": kind_for_end, "phase": "end", "ok": result.as_ref().map(|r| r.is_ok()).unwrap_or(false)}), None);
        match result {
            Ok(r) => r,
            Err(p) => {
                let msg = p
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "panic".into());
                let mut e = err("ENGINE_PANIC", msg.clone());
                // crash-recovery.md §5: rebuild the engine state (parking_lot mutexes do not
                // poison; the half-mutated engine is the hazard), drop temp files / stage trees.
                let cleaned = crate::recovery::after_panic(&st, &project_key);
                let count = {
                    let Ok(h) = st.project(&project_key) else { return Err(e) };
                    let mut c = h.panic_counts.lock();
                    let n = c.entry(request_kind.clone()).or_insert(0);
                    *n += 1;
                    *n
                };
                let unstable = count >= 2;
                if unstable {
                    // Two panics of the same request kind: Build stays closed until restart.
                    st.sessions.lock().expire_project(&project_key);
                }
                let _ = st.db.lock().crash_insert(&e.req_id, "engine_panic", &format!("{request_kind}: {msg}"));
                let file = crate::log::write_crash(
                    &e.req_id,
                    "engine_panic",
                    &msg,
                    serde_json::json!({"project_key": project_key, "request_kind": request_kind, "cleaned": cleaned, "count": count, "unstable": unstable}),
                );
                crate::log::write("error", &format!("engine panic ({request_kind}): {msg}"), &e.req_id);
                e.evidence = Some(serde_json::json!({"request_kind": request_kind, "unstable": unstable, "crash_file": file.map(|p| p.to_string_lossy().to_string())}));
                e = e.with_remediation(if unstable {
                    "the engine panicked twice on this request kind; restart the app before entering Build again"
                } else {
                    "files are unchanged (the transaction never committed); report the req_id and retry with a different op-list"
                });
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| err("ENGINE_PANIC", e.to_string()))?
}

// ---------------------------------------------------------------- sessions

#[tauri::command(rename_all = "snake_case")]
pub fn build_session_open(state: S, open: BuildSessionOpen) -> IpcResult<BuildSessionInfo> {
    let db = state.db.lock();
    if !db.consent_exists(&open.consent_event_id)? {
        return Err(err(
            "CONSENT_REQUIRED",
            "entering Build needs a recorded consent",
        ));
    }
    if let Some(sha) = &open.plan_sha256 {
        if !db.approval_check(Some(&open.project_key), "plan", &open.plan_ref, sha)? {
            return Err(err(
                "PLAN_NOT_LOCALLY_APPROVED",
                "the plan version is not approved",
            )
            .with_remediation("approve the plan card first"));
        }
    }
    drop(db);
    let env = state.env.read().status.clone();
    if env != "ok" {
        return Err(
            err("ENV_SETUP_REQUIRED", "the environment check did not pass")
                .with_remediation("open Settings > Environment"),
        );
    }
    // A standalone `.kicad_sch` has no project to own approvals, checkpoints or a sidecar (D-57):
    // the UI disables Build, and this is the second check.
    if state.project(&open.project_key)?.no_pro {
        return Err(err("PROJECT_NO_PRO", "this schematic has no project file")
            .with_remediation("create a project shell first"));
    }
    let ceiling = state.settings.read().agent.session_ceiling_components_added;
    // A plan session's ceiling is the approved plan's own bound -- budgets, sheets, structural
    // entries and renamable nets -- so the webview can never declare more than the human approved.
    let plan_ceiling = if open.plan_ref != "incremental" {
        let root = state.project(&open.project_key)?.root.clone();
        approved_plan_ceiling(&root, &open)
    } else {
        None
    };
    let info = state
        .sessions
        .lock()
        .open_build(&open, ceiling, plan_ceiling.as_ref());
    state.db.lock().query(
        DbQuery::ProjectStateSet {
            project_key: open.project_key.clone(),
            patch: serde_json::json!({"last_mode": "build"}),
        },
        &state.app_version,
    )?;
    Ok(info)
}

/// Structural verbs whose entry names a sheet *file* (`structural_key` puts the file in the key for
/// `add_sheet`; the plan vocabulary spells the same actions `create_sheet` / `delete_sheet`). Only
/// these can be qualified by file; the rest (`delete_sheet_pin`, `resize_sheet`) have no qualified
/// form and would match nothing if one were invented for them. Mirrors `SHEET_FILE_VERBS` in
/// `src/agent/plans/schema.ts`.
const SHEET_FILE_VERBS: &[&str] = &[
    "create_sheet",
    "add_sheet",
    "delete_sheet",
    "remove_sheet",
    "rename_sheet",
];

/// Approval identity of a plan, as the webview computes it (`planIdentitySha` in
/// `src/agent/index.ts`): the plan without `display` (status and progress move while the plan runs;
/// the approved content does not), canonical JSON, sha256. `serde_json::Value` keeps object keys in
/// a `BTreeMap`, so `to_string` here is the same byte string `canonicalJson` produces.
fn plan_identity_sha(plan: &serde_json::Value) -> String {
    let mut v = plan.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("display");
    }
    crate::paths::sha256_hex(v.to_string().as_bytes())
}

/// Every `.kicad_sch` under the project root, project-relative. A superset of the hierarchy (writes
/// are canonicalised under the root anyway); used as the part of a plan session's ceiling that says
/// "the files this project already has".
fn project_sheet_files(root: &std::path::Path) -> Vec<String> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, depth: u32, out: &mut Vec<String>) {
        if depth > 3 || out.len() > 500 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                walk(&p, root, depth + 1, out);
            } else if name.ends_with(".kicad_sch") {
                out.push(crate::paths::rel_to(root, &p));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, 0, &mut out);
    out.sort();
    out
}

/// The ceiling of a plan build session, read from the approved plan.
///
/// The approval lives in app data (`approvals`, checked by the caller); the plan body lives in the
/// project sidecar, which is untrusted input (red line 21) and is not where approval state comes
/// from (red line 13). The body is therefore only used once it hashes to the sha the approval was
/// recorded over. A sidecar that does not -- hand-edited, a newer unapproved version, one shipped
/// inside somebody else's project -- is ignored, and the session falls back to the settings ceiling
/// instead of inheriting a bound nobody approved.
fn approved_plan_ceiling(
    root: &std::path::Path,
    open: &BuildSessionOpen,
) -> Option<crate::session::PlanCeiling> {
    let want = open.plan_sha256.as_deref()?;
    let id = open
        .plan_ref
        .trim_start_matches("plan:")
        .split('@')
        .next()
        .unwrap_or("");
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") || id.starts_with('.') {
        return None;
    }
    let version = open.plan_ref.split('@').nth(1).unwrap_or("");
    let dir = root.join(".fluxsmith").join("plans").join(id);
    // The version the approval names first; `latest.json` only as a fallback, and either way only
    // if it hashes to the approved sha.
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()) {
        candidates.push(dir.join(format!("v{version}.json")));
    }
    candidates.push(dir.join("latest.json"));
    let plan = candidates.into_iter().find_map(|p| {
        let b = std::fs::read(&p).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&b).ok()?;
        (plan_identity_sha(&v) == want).then_some(v)
    });
    let Some(plan) = plan else {
        crate::log::write(
            "warn",
            &format!(
                "plan {id} in the project sidecar does not hash to the approved version; using the session ceiling"
            ),
            "",
        );
        return None;
    };
    let b = &plan["envelope"]["budgets"];
    let strings = |v: &serde_json::Value| -> Vec<String> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .filter(|x| !x.is_empty())
                    .map(|x| x.to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let plan_sheets: Vec<String> = plan["sheets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x["file"].as_str())
                .filter(|x| !x.is_empty())
                .map(|x| x.to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut sheets = project_sheet_files(root);
    for f in &plan_sheets {
        if !sheets.contains(f) {
            sheets.push(f.clone());
        }
    }
    // `create_sheet:<file>` and `add_sheet:<file>` are the same action under the plan's name and the
    // op's name; the plan's own sheets carry both (mirrors `planStructural` in the webview). A bare
    // destructive verb the plan wrote is qualified to the plan's sheets rather than left as a verb
    // that would permit every file (P2-6).
    let mut structural: Vec<String> = Vec::new();
    let mut push = |x: String| {
        if !x.is_empty() && !structural.contains(&x) {
            structural.push(x);
        }
    };
    for x in strings(&plan["envelope"]["structural"]) {
        match x.split_once(':') {
            Some((verb, file)) if !file.trim().is_empty() => {
                push(x.clone());
                if verb == "create_sheet" || verb == "add_sheet" {
                    push(format!("create_sheet:{}", file.trim()));
                    push(format!("add_sheet:{}", file.trim()));
                }
            }
            // Unqualified. A bare verb in a ceiling permits that verb on any file, so a verb that
            // names a sheet file is spelled out over the plan's own sheets (and dropped when the
            // plan lists none). Verbs whose `structural_key` carries no file at all --
            // `delete_sheet_pin`, `resize_sheet` -- have no qualified form to match against and
            // stay bare; the `sheets` dimension is what bounds where they land.
            _ => {
                let verb = x.split(':').next().unwrap_or("").trim().to_string();
                if SHEET_FILE_VERBS.contains(&verb.as_str()) {
                    for f in &plan_sheets {
                        push(format!("{verb}:{f}"));
                    }
                } else {
                    push(verb);
                }
            }
        }
    }
    for f in &plan_sheets {
        push(format!("create_sheet:{f}"));
        push(format!("add_sheet:{f}"));
    }
    Some(crate::session::PlanCeiling {
        components_added: b["components_added"].as_u64().unwrap_or(0) as u32,
        components_deleted: b["components_deleted"].as_u64().unwrap_or(0) as u32,
        wires_max: b["wires_added"]
            .as_u64()
            .filter(|w| *w > 0)
            .map(|w| w as u32),
        sheets,
        structural,
        nets_renamable: strings(&plan["envelope"]["nets"]["renamable"]),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn build_session_close(state: S, token: String) -> IpcResult<()> {
    state.sessions.lock().close_build(&token);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn build_session_touch(state: S, token: String) -> IpcResult<BuildSessionInfo> {
    let mut s = state.sessions.lock();
    s.touch(&token, None)?;
    s.info(&token)
        .ok_or_else(|| err("NO_BUILD_SESSION", "unknown session"))
}

#[tauri::command(rename_all = "snake_case")]
pub fn turn_begin(state: S, begin: TurnBegin) -> IpcResult<TurnInfo> {
    crate::log::event(
        "debug",
        "ipc.turn_begin",
        serde_json::json!({"kind": begin.kind}),
        None,
    );
    let h = state.project(&begin.project_key)?;
    crate::log::event(
        "info",
        "turn.start",
        serde_json::json!({"kind": begin.kind, "mode": begin.mode, "project": begin.project_key}),
        None,
    );
    if begin.mode == "build" && crate::project::is_locked(&h.root_sheet) {
        return Err(err("TARGET_LOCKED", "the project is open in KiCad")
            .with_remediation("close it in KiCad before building"));
    }
    let last = state.db.lock().project_last_turn(&begin.project_key)?;
    // A re-declaration (same turn, widened after the human approved the scope card) must not
    // consume a new turn number: the harness still addresses checkpoints/applies by the old one.
    let next = if begin.redeclare && last > 0 {
        last
    } else {
        last + 1
    };
    let info = state.sessions.lock().begin_turn(&begin, next)?;
    state.db.lock().project_set_turn(&begin.project_key, next)?;
    crate::sidecar::journal_append(
        &h.root,
        &serde_json::json!({"ts": crate::paths::now_iso(), "kind": "turn_begin", "turn": next, "turn_kind": begin.kind, "mode": begin.mode, "headline": begin.headline, "ceiling_source": info.ceiling_source}),
    )?;
    Ok(info)
}

#[tauri::command(rename_all = "snake_case")]
pub fn turn_end(
    state: S,
    project_key: String,
    turn: u32,
    outcome: String,
) -> IpcResult<TurnCounters> {
    let h = state.project(&project_key)?;
    let c = state.sessions.lock().end_turn(&project_key, turn)?;
    crate::sidecar::journal_append(
        &h.root,
        &serde_json::json!({"ts": crate::paths::now_iso(), "kind": "turn_end", "turn": turn, "outcome": outcome, "counters": c}),
    )?;
    Ok(c)
}

#[tauri::command(rename_all = "snake_case")]
pub fn turn_counters(state: S, project_key: String) -> IpcResult<TurnCounters> {
    state
        .sessions
        .lock()
        .turns
        .get(&project_key)
        .map(|t| t.counters.clone())
        .ok_or_else(|| err("MODE_MISMATCH", "no turn"))
}

#[tauri::command(rename_all = "snake_case")]
pub fn consent_record(state: S, event: ConsentEvent) -> IpcResult<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    state.db.lock().consent_insert(
        &id,
        Some(&event.project_key),
        &event.card_kind,
        &event.payload_sha256,
        &event.input_kind,
    )?;
    Ok(serde_json::json!({"id": id}))
}

#[tauri::command(rename_all = "snake_case")]
pub fn grant_create(state: S, request: GrantRequest) -> IpcResult<GrantInfo> {
    let consent = state
        .db
        .lock()
        .consent_payload_sha(&request.consent_event_id)?
        .ok_or_else(|| err("CONSENT_REQUIRED", "a grant needs a recorded consent event"))?;
    check_waiver_grant(&request, &consent)?;
    state.project(&request.project_key)?;
    Ok(state.sessions.lock().create_grant(&request))
}

/// A waiver hides a verdict the engine reached, so its grant has to be the decision the human
/// actually made. The webview records the consent event over the rows that were ticked plus the
/// reason and the expiry typed with them (`src/agent/review-waiver.ts`, `waiveConsentSha`), and
/// repeats that object in `action.waive`; here the two are required to agree with each other and
/// with what the consent event was recorded over. `engine.rs` (`PolicyWaive`) then refuses to waive
/// a finding that batch does not list — before this, one consent recorded before the picking
/// unlocked any number of unrelated waivers.
fn check_waiver_grant(request: &GrantRequest, consent_payload_sha: &str) -> Result<(), IpcError> {
    // A `scope` grant widens a turn envelope, and `begin_turn` will only honour it for the envelope
    // whose canonical sha it carries -- so that sha has to be the one the human's consent was
    // recorded over, not one the webview picked afterwards.
    if request.kind == "scope" && request.payload_sha256 != consent_payload_sha {
        return Err(err(
            "CONSENT_MISMATCH",
            "the scope grant does not carry the payload the consent event was recorded over",
        )
        .with_remediation("answer the scope card again"));
    }
    if request.kind != "waiver" {
        return Ok(());
    }
    if request.payload_sha256 != consent_payload_sha {
        return Err(err(
            "CONSENT_MISMATCH",
            "the waiver grant does not carry the payload the consent event was recorded over",
        )
        .with_remediation("answer the waiver card again"));
    }
    if let Some(w) = request.action.as_ref().and_then(|a| a.get("waive")) {
        // `serde_json::Value` keeps object keys in a BTreeMap, so this is the same canonical JSON
        // (keys sorted, no spaces) the webview hashes with `canonicalJson`.
        if crate::paths::sha256_hex(w.to_string().as_bytes()) != consent_payload_sha {
            return Err(err(
                "CONSENT_MISMATCH",
                "the waived findings do not hash to the recorded consent",
            )
            .with_remediation("answer the waiver card again"));
        }
    }
    Ok(())
}

// ------------------------------------------------------------- checkpoints

#[tauri::command(rename_all = "snake_case")]
pub fn checkpoint_create(
    state: S,
    project_key: String,
    turn: u32,
    kind: Option<String>,
) -> IpcResult<CheckpointInfo> {
    let h = state.project(&project_key)?;
    crate::checkpoint::create(&state, &h, turn, kind.as_deref().unwrap_or("turn"))
}

#[tauri::command(rename_all = "snake_case")]
pub fn checkpoint_list(state: S, project_key: String) -> IpcResult<Vec<CheckpointInfo>> {
    crate::checkpoint::list(&state, &project_key)
}

/// Read-only: what a rollback would restore and what it would move out of the
/// project, plus the `state_sha256` the write checks against.
#[tauri::command(rename_all = "snake_case")]
pub fn rollback_preview(
    state: S,
    project_key: String,
    before_turn: u32,
    kind: Option<String>,
) -> IpcResult<RollbackPreview> {
    let h = state.project(&project_key)?;
    crate::checkpoint::preview(&state, &h, before_turn, kind.as_deref().unwrap_or("turn"))
}

#[tauri::command(rename_all = "snake_case")]
pub fn rollback(state: S, request: RollbackRequest) -> IpcResult<RollbackResult> {
    let h = state.project(&request.project_key)?;
    let r = crate::checkpoint::rollback(&state, &h, &request)?;
    state.emit(AppEvent::SessionExpired {
        project_key: request.project_key.clone(),
        reason: "rollback".into(),
    });
    Ok(r)
}

// ----------------------------------------------------------------- sidecar

#[tauri::command(rename_all = "snake_case")]
pub fn sidecar_write(state: S, project_key: String, write: SidecarWrite) -> IpcResult<()> {
    let h = state.project(&project_key)?;
    // A standalone `.kicad_sch` is read-only (D-57): nothing creates a `.fluxsmith/` next to a
    // loose file. Plan / Build / Review are disabled in the UI; this is the second check.
    if h.no_pro {
        return Err(err("PROJECT_NO_PRO", "this schematic has no project file")
            .with_remediation("create a project shell first"));
    }
    crate::sidecar::write(&h.root, &write)
}

/// One guarded `fluxsmith.toml` change from the project settings tab (`docs/settings.md` §6): the
/// keys `sidecar_write` refuses, behind the consent event the settings card recorded. Exactly one
/// key per call; removing a waiver is `waiver_revoke`, never a rewritten list.
#[tauri::command(rename_all = "snake_case")]
pub fn project_config_apply(
    state: S,
    project_key: String,
    edit: ProjectConfigEdit,
    consent_event_id: String,
) -> IpcResult<Value> {
    let h = state.project(&project_key)?;
    let out = {
        let db = state.db.lock();
        crate::sidecar::project_config_apply(&db, &h.root, &edit, &consent_event_id)?
    };
    h.own_shas
        .lock()
        .insert(crate::paths::sha256_hex(out.written.as_bytes()));
    Ok(out.config)
}

#[tauri::command(rename_all = "snake_case")]
pub fn sidecar_read(
    state: S,
    project_key: String,
    kind: String,
    turn: Option<u32>,
    key: Option<String>,
) -> IpcResult<Value> {
    let h = state.project(&project_key)?;
    crate::sidecar::read(&h.root, &kind, turn, key.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn db_query(state: S, query: DbQuery) -> IpcResult<Value> {
    crate::log::event(
        "debug",
        "ipc.db_query",
        serde_json::json!({"kind": format!("{:?}", std::mem::discriminant(&query))}),
        None,
    );
    let v = state.app_version.clone();
    state.db.lock().query(query, &v)
}

// ----------------------------------------------------------------- keyring

/// Remove a provider row and its secret together (the settings patch merge keeps unknown ids, so a
/// filtered `providers` list from the UI never deleted anything and the key stayed in secrets.json).
#[tauri::command(rename_all = "snake_case")]
pub fn provider_remove(state: S, provider_id: String) -> IpcResult<Settings> {
    let next = {
        let mut s = state.settings.write();
        let before = s.providers.len();
        s.providers.retain(|p| p.id != provider_id);
        if s.providers.len() == before {
            return Err(err("BAD_CONFIG", "unknown provider id"));
        }
        for (_role, id) in s.models_by_role.iter_mut() {
            if id.starts_with(&format!("{provider_id}/")) {
                id.clear();
            }
        }
        s.models_by_role.retain(|_, v| !v.is_empty());
        s.clone()
    };
    crate::settings::save(&next)?;
    // Best effort: a missing secret is not an error for a removal.
    let _ = crate::keyring::delete(&provider_id);
    Ok(next)
}

#[tauri::command(rename_all = "snake_case")]
pub fn keyring_set(state: S, provider_id: String, secret: String) -> IpcResult<()> {
    if !state
        .settings
        .read()
        .providers
        .iter()
        .any(|p| p.id == provider_id)
    {
        return Err(err("BAD_CONFIG", "unknown provider id"));
    }
    crate::keyring::set(&provider_id, &secret)
}

#[tauri::command(rename_all = "snake_case")]
pub fn keyring_has(provider_id: String) -> IpcResult<bool> {
    Ok(crate::keyring::has(&provider_id))
}

#[tauri::command(rename_all = "snake_case")]
pub fn keyring_delete(provider_id: String) -> IpcResult<()> {
    crate::keyring::delete(&provider_id)
}

// ----------------------------------------------------------------- network

#[tauri::command(rename_all = "snake_case")]
pub async fn net_fetch(
    state: S<'_>,
    request: NetRequest,
    on_chunk: Channel<NetChunk>,
) -> IpcResult<()> {
    let st = Arc::new(crate::net::AppStateRef(state.inner().clone()));
    crate::net::fetch(st, request, on_chunk).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn net_abort(state: S, id: String) -> IpcResult<()> {
    crate::net::abort(&state, &id);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn origin_register(
    state: S,
    origin: String,
    consent_event_id: String,
) -> IpcResult<Vec<String>> {
    let o = crate::net::validate_custom_origin(&origin)?;
    let db = state.db.lock();
    if !db.consent_exists(&consent_event_id)? {
        return Err(err(
            "CONSENT_REQUIRED",
            "registering an origin needs consent",
        ));
    }
    db.approval_upsert(
        None,
        "origin",
        &o,
        &crate::paths::sha256_hex(o.as_bytes()),
        &consent_event_id,
        &state.app_version,
    )?;
    db.approved_refs("origin")
}

#[tauri::command(rename_all = "snake_case")]
pub fn origin_list(state: S) -> IpcResult<Vec<String>> {
    let mut v: Vec<String> = crate::net::BUILTIN_ORIGINS
        .iter()
        .map(|(_, o)| o.to_string())
        .collect();
    v.extend(state.db.lock().approved_refs("origin")?);
    Ok(v)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fetch_origin_approve(state: S, origin: String, consent_event_id: String) -> IpcResult<()> {
    let o = crate::net::origin_of(&origin)?;
    let db = state.db.lock();
    if !db.consent_exists(&consent_event_id)? {
        return Err(err(
            "CONSENT_REQUIRED",
            "fetching from a new origin needs consent",
        ));
    }
    db.approval_upsert(
        None,
        "fetch_origin",
        &o,
        &crate::paths::sha256_hex(o.as_bytes()),
        &consent_event_id,
        &state.app_version,
    )?;
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn web_fetch(state: S<'_>, url: String) -> IpcResult<Value> {
    let st = Arc::new(crate::net::AppStateRef(state.inner().clone()));
    crate::net::fetch_and_land(st, &url).await
}

/// `web.fetch` tool body: landed bytes plus model-readable text (HTML → text in Rust).
#[tauri::command(rename_all = "snake_case")]
pub async fn web_fetch_text(state: S<'_>, url: String) -> IpcResult<Value> {
    let st = Arc::new(crate::net::AppStateRef(state.inner().clone()));
    crate::net::fetch_text(st, &url).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn fetch_origin_list(state: S) -> IpcResult<Vec<Value>> {
    crate::net::fetch_origin_list(&state)
}

#[tauri::command(rename_all = "snake_case")]
pub fn fetch_origin_revoke(state: S, id: i64) -> IpcResult<()> {
    state.db.lock().approval_revoke(id)
}

/// `docs.pdf_text`: per-page text of a cached PDF (sha256 handle), extraction off the runtime.
#[tauri::command(rename_all = "snake_case")]
pub async fn pdf_text(state: S<'_>, sha256: String, pages: Option<Vec<u32>>) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    crate::pdftext::pdf_text(st, sha256, pages).await
}

/// `parts.bom`: BOM lines + shared-library snapshot, optional lock write / drift.
#[tauri::command(rename_all = "snake_case")]
pub fn parts_bom(
    state: S,
    project_key: String,
    lock: Option<bool>,
    against_lock: Option<String>,
) -> IpcResult<Value> {
    crate::parts::bom(
        &state,
        &project_key,
        lock.unwrap_or(false),
        against_lock.as_deref(),
    )
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn parts_search(
    state: S<'_>,
    query: Option<String>,
    mpn: Option<String>,
    lcsc: Option<String>,
    value: Option<String>,
    package: Option<String>,
    category: Option<String>,
    limit: Option<u32>,
    in_stock: Option<bool>,
    basic_only: Option<bool>,
) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    crate::parts::search(
        st, query, mpn, lcsc, value, package, category, limit, in_stock, basic_only,
    )
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn parts_show(state: S<'_>, lcsc: String) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    crate::parts::show(st, lcsc).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn parts_datasheet(
    state: S<'_>,
    project_key: String,
    lcsc: Option<String>,
    mpn: Option<String>,
) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    crate::parts::datasheet(st, project_key, lcsc, mpn).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn parts_refresh(state: S<'_>, lcsc: String) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    crate::parts::refresh(st, lcsc).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn parts_convert(
    state: S<'_>,
    project_key: String,
    lcsc: String,
    lib_nickname: Option<String>,
    with_3d: Option<bool>,
    auth: Auth,
) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    crate::parts::convert(st, project_key, lcsc, lib_nickname, with_3d, auth).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn codex_device_begin(
    state: S<'_>,
    consent_event_id: String,
    method: Option<String>,
) -> IpcResult<DeviceCodeState> {
    let st: Arc<AppState> = state.inner().clone();
    {
        let db = st.db.lock();
        if !db.consent_exists(&consent_event_id)? {
            return Err(err(
                "CONSENT_REQUIRED",
                "the Codex risk consent must be recorded first",
            ));
        }
        db.approval_upsert(
            None,
            "consent",
            &format!("codex@{}", st.app_version),
            &consent_event_id,
            &consent_event_id,
            &st.app_version,
        )?;
    }
    match method.as_deref().unwrap_or("browser") {
        "device" => crate::net::codex_begin(&st).await,
        _ => crate::net::codex_browser_begin(&st).await,
    }
}

/// Open an https URL (or the loopback login page) in the system browser.
/// Only used for provider login pages and documentation links.
#[tauri::command(rename_all = "snake_case")]
pub fn open_url(app: tauri::AppHandle, url: String) -> IpcResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = url::Url::parse(&url).map_err(|e| err("BAD_URL", e.to_string()))?;
    let ok = parsed.scheme() == "https"
        || (parsed.scheme() == "http"
            && matches!(parsed.host_str(), Some("localhost") | Some("127.0.0.1")));
    if !ok {
        return Err(err("BAD_URL", "only https URLs can be opened"));
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| err("OPEN_FAILED", e.to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub async fn codex_device_poll(state: S<'_>) -> IpcResult<DeviceCodeState> {
    let st: Arc<AppState> = state.inner().clone();
    crate::net::codex_poll(&st).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn codex_revoke(state: S) -> IpcResult<()> {
    crate::net::codex_revoke(&state)
}

// ------------------------------------------------------------- attachments

#[tauri::command(rename_all = "snake_case")]
pub fn attach_intake(state: S, request: IntakeRequest) -> IpcResult<AttachInfo> {
    state.project(&request.project_key)?;
    let info = crate::intake::intake(&state, &request)?;
    let _ = state.db.lock().query(
        DbQuery::MetricAppend {
            project_key: request.project_key.clone(),
            kind_: "intake".into(),
            value: info.size as f64,
            dims: serde_json::json!({"kind": info.kind}),
        },
        &state.app_version,
    );
    Ok(info)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attach_read(state: S, project_key: String, read: AttachRead) -> IpcResult<Value> {
    crate::intake::read(&state, &project_key, &read)
}

/// Adopt a private `.kicad_sym` / `.pretty` into the project library (human consent, `lib_import`
/// grant). The agent can only propose this through `lib.import_request`.
#[tauri::command(rename_all = "snake_case")]
pub fn lib_register(
    state: S,
    project_key: String,
    request: LibRegisterRequest,
    auth: Auth,
) -> IpcResult<Value> {
    let out = crate::engine::lib_register(&state, &project_key, &request, auth)?;
    crate::libindex::spawn(state.inner().clone(), false);
    Ok(out)
}

#[tauri::command(rename_all = "snake_case")]
pub fn attach_bind_to_project(
    state: S,
    project_key: String,
    sha256: String,
    dest: String,
) -> IpcResult<String> {
    crate::intake::bind_to_project(&state, &project_key, &sha256, &dest)
}

// ------------------------------------------------------------------ skills

#[tauri::command(rename_all = "snake_case")]
pub fn skills_list(state: S, project_key: Option<String>) -> IpcResult<Vec<SkillPackInfo>> {
    crate::skills::list(&state, project_key.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_read(state: S, pack: String, path: String) -> IpcResult<String> {
    crate::skills::read(&state, &pack, &path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_trust(
    state: S,
    pack: String,
    sha256: String,
    consent_event_id: String,
    project_key: Option<String>,
) -> IpcResult<SkillPackInfo> {
    crate::skills::trust(
        &state,
        &pack,
        &sha256,
        &consent_event_id,
        project_key.as_deref(),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_trust_workflows(
    state: S,
    pack: String,
    sha256: String,
    consent_event_id: String,
    project_key: Option<String>,
) -> IpcResult<SkillPackInfo> {
    crate::skills::trust_workflows(
        &state,
        &pack,
        &sha256,
        &consent_event_id,
        project_key.as_deref(),
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_revoke_workflows(
    state: S,
    pack: String,
    project_key: Option<String>,
) -> IpcResult<SkillPackInfo> {
    crate::skills::revoke_workflows(&state, &pack, project_key.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub fn skills_write_draft(
    state: S,
    pack: String,
    name: String,
    section_text: String,
    activation: Option<String>,
    scope: String,
    project_key: Option<String>,
    grant: String,
) -> IpcResult<SkillPackInfo> {
    crate::skills::write_draft(
        &state,
        &pack,
        &name,
        &section_text,
        activation.as_deref(),
        &scope,
        project_key.as_deref(),
        &grant,
    )
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_import_zip(
    state: S,
    path: String,
    scope: String,
    project_key: Option<String>,
) -> IpcResult<SkillPackInfo> {
    crate::skills::import_zip(&state, &path, &scope, project_key.as_deref())
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_export_zip(state: S, pack: String, out_path: String) -> IpcResult<()> {
    crate::skills::export_zip(&state, &pack, &out_path)
}

// ------------------------------------------------------------------- misc

#[tauri::command(rename_all = "snake_case")]
pub fn export_file(
    state: S,
    project_key: String,
    kind: String,
    payload: Value,
    out_path: String,
) -> IpcResult<String> {
    crate::export::export(&state, &project_key, &kind, &payload, &out_path)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn kicad_advisory(state: S<'_>, project_key: String, kind: String) -> IpcResult<Value> {
    let st: Arc<AppState> = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || crate::advisory::run(&st, &project_key, &kind))
        .await
        .map_err(|e| err("ENGINE_PANIC", e.to_string()))?
}

#[tauri::command(rename_all = "snake_case")]
pub fn lib_index_rebuild(state: S) -> IpcResult<()> {
    state
        .libindex
        .cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
    crate::libindex::spawn(state.inner().clone(), true);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn log_write(level: String, message: String, req_id: Option<String>) -> IpcResult<()> {
    crate::log::write(&level, &message, req_id.as_deref().unwrap_or("webview"));
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn diag_bundle(state: S, spec: DiagBundleSpec) -> IpcResult<String> {
    crate::diag::bundle(&state, &spec)
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_data_path() -> IpcResult<String> {
    Ok(crate::paths::app_data_dir().to_string_lossy().to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn open_path(app: tauri::AppHandle, state: S, path: String) -> IpcResult<()> {
    use tauri_plugin_opener::OpenerExt;
    // Only app data, project roots and their sidecars may be revealed.
    let p = std::path::Path::new(&path);
    let allowed = p.starts_with(crate::paths::app_data_dir())
        || state
            .projects
            .read()
            .values()
            .any(|h| p.starts_with(&h.root));
    if !allowed {
        return Err(err(
            "PATH_OUT_OF_SCOPE",
            "only app data and open project folders can be revealed",
        ));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| err("FS_TRANSIENT", e.to_string()))
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_data_export(state: S, out_path: String) -> IpcResult<()> {
    crate::diag::export_app_data(&state, &out_path)
}

#[tauri::command(rename_all = "snake_case")]
pub fn app_data_wipe(state: S, consent_event_id: String) -> IpcResult<()> {
    crate::diag::wipe(&state, &consent_event_id)
}

// ---------------------------------------------------------------- Phase F

/// Local update check (release folder / git tag). No network (updates-and-compatibility.md §1).
#[tauri::command(rename_all = "snake_case")]
pub fn update_check(state: S) -> IpcResult<UpdateCheck> {
    let r = crate::update::check(&state);
    crate::log::event(
        "info",
        "update.check",
        serde_json::json!({"status": r.status, "latest": r.latest, "source": r.source}),
        None,
    );
    Ok(r)
}

/// CHANGELOG entries for the first-run disclosure of this version (D-8).
#[tauri::command(rename_all = "snake_case")]
pub fn update_disclosure(state: S) -> IpcResult<Disclosure> {
    let version = state.app_version.clone();
    let (bytes_affecting, entries) = crate::update::disclosure(&version);
    Ok(Disclosure {
        version,
        bytes_affecting,
        entries,
    })
}

/// OS clipboard image fallback for paste (arboard); None when the clipboard holds no image.
#[tauri::command(rename_all = "snake_case")]
pub fn clipboard_read_image() -> IpcResult<Option<ClipboardImage>> {
    crate::clipboard::read_image()
}

/// Structured JSONL log event from the webview (docs/logging.md §3). Fields are masked in Rust.
#[tauri::command(rename_all = "snake_case")]
pub fn log_event(
    event: String,
    level: Option<String>,
    fields: Option<Value>,
    req_id: Option<String>,
) -> IpcResult<()> {
    if event.len() > 64
        || !event
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return Err(err("BAD_CONFIG", "invalid event name"));
    }
    crate::log::event(
        level.as_deref().unwrap_or("info"),
        &event,
        fields.unwrap_or(Value::Null),
        req_id.as_deref(),
    );
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_preview(text: String) -> IpcResult<SkillPreview> {
    Ok(crate::skills::preview(&text))
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_write_file(
    state: S,
    pack: String,
    path: String,
    text: String,
    scope: String,
    project_key: Option<String>,
) -> IpcResult<SkillPackInfo> {
    let r = crate::skills::write_file(&state, &pack, &path, &text, &scope, project_key.as_deref())?;
    crate::log::event(
        "info",
        "skill.load",
        serde_json::json!({"pack": pack, "path": path, "scope": scope, "edited": true}),
        None,
    );
    Ok(r)
}

#[tauri::command(rename_all = "snake_case")]
pub fn skills_test(
    state: S,
    pack: String,
    project_key: Option<String>,
) -> IpcResult<SkillTestReport> {
    crate::skills::test(&state, &pack, project_key.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn waiver_request(payload_sha: &str, action: Option<Value>) -> GrantRequest {
        GrantRequest {
            project_key: "k".into(),
            kind: "waiver".into(),
            payload_sha256: payload_sha.into(),
            consent_event_id: "c1".into(),
            action,
        }
    }

    /// The batch the webview hashes (`src/agent/review-waiver.ts`, `waiveBatch`): keys sorted, no
    /// spaces, refs sorted inside each row.
    fn batch() -> Value {
        serde_json::json!({
            "expires": "2026-12-01T00:00:00Z",
            "findings": [{"code": "OFF_GRID", "refs": ["style:grid:9"]}],
            "reason": "panel silk, on purpose",
        })
    }

    fn write_plan(root: &std::path::Path, id: &str, version: u64, plan: &Value) {
        let d = root.join(".fluxsmith").join("plans").join(id);
        std::fs::create_dir_all(&d).unwrap();
        let body = serde_json::to_string_pretty(plan).unwrap();
        std::fs::write(d.join(format!("v{version}.json")), &body).unwrap();
        std::fs::write(d.join("latest.json"), &body).unwrap();
    }

    fn a_plan() -> Value {
        serde_json::json!({
            "id": "p1",
            "version": 2,
            "sheets": [{"file": "power.kicad_sch", "create": true}, {"file": "root.kicad_sch"}],
            "envelope": {
                "budgets": {"components_added": 12, "components_deleted": 1, "wires_added": 30},
                "nets": {"renamable": ["GLB"]},
                "structural": ["create_sheet:power.kicad_sch"],
            },
            "display": {"status": "approved", "approved_at": "2026-09-06T00:00:00Z"},
        })
    }

    fn open_for(root_id: &str, sha: Option<&str>) -> BuildSessionOpen {
        BuildSessionOpen {
            project_key: "k".into(),
            plan_ref: format!("plan:{root_id}@2"),
            plan_sha256: sha.map(|s| s.to_string()),
            policy: "review".into(),
            consent_event_id: "c1".into(),
            lead_model: "m".into(),
            tool_manifest_version: 1,
        }
    }

    /// P1-1: the session ceiling now carries the approved plan's sheets, structural entries and
    /// renamable nets, not only its two counters -- and the plan body it reads is in the project
    /// directory, so it is only trusted once it hashes to the sha the app-data approval was recorded
    /// over (red lines 13 and 21).
    #[test]
    fn the_plan_ceiling_comes_from_the_body_the_approval_names() {
        let d = tempfile::tempdir().unwrap();
        let plan = a_plan();
        write_plan(d.path(), "p1", 2, &plan);
        std::fs::write(d.path().join("root.kicad_sch"), "(kicad_sch)").unwrap();
        let sha = plan_identity_sha(&plan);

        let c = approved_plan_ceiling(d.path(), &open_for("p1", Some(&sha))).expect("approved");
        assert_eq!(c.components_added, 12);
        assert_eq!(c.components_deleted, 1);
        assert_eq!(c.wires_max, Some(30));
        assert_eq!(c.nets_renamable, vec!["GLB".to_string()]);
        assert!(c.sheets.contains(&"power.kicad_sch".to_string()));
        assert!(
            c.sheets.contains(&"root.kicad_sch".to_string()),
            "the project's existing files stay in scope: {:?}",
            c.sheets
        );
        assert!(c
            .structural
            .contains(&"add_sheet:power.kicad_sch".to_string()));
        assert!(
            c.structural.iter().all(|x| x.contains(':')),
            "a bare verb in a ceiling would permit every file: {:?}",
            c.structural
        );

        // `display` moves while the plan runs and is outside the approval identity.
        let mut running = plan.clone();
        running["display"] = serde_json::json!({"status": "running", "approved_at": null});
        write_plan(d.path(), "p1", 2, &running);
        assert!(approved_plan_ceiling(d.path(), &open_for("p1", Some(&sha))).is_some());

        // A body that is not the approved one (edited in the project, or a newer version dropped in)
        // buys nothing: no ceiling, so the session falls back to the settings one.
        let mut tampered = plan.clone();
        tampered["envelope"]["budgets"]["components_added"] = serde_json::json!(9999);
        write_plan(d.path(), "p1", 2, &tampered);
        assert!(approved_plan_ceiling(d.path(), &open_for("p1", Some(&sha))).is_none());

        // No approved sha at all (an incremental session, or a webview that omitted it).
        write_plan(d.path(), "p1", 2, &plan);
        assert!(approved_plan_ceiling(d.path(), &open_for("p1", None)).is_none());
        // A plan id that tries to leave the sidecar directory.
        assert!(approved_plan_ceiling(d.path(), &open_for("../../etc", Some(&sha))).is_none());
    }

    /// P1-2: a `scope` grant widens a turn envelope, so its payload has to be the one the consent
    /// event was recorded over -- otherwise the webview could name any sha after the click.
    #[test]
    fn a_scope_grant_must_carry_its_consent_payload() {
        let mut r = waiver_request("envelope-sha", None);
        r.kind = "scope".into();
        assert!(check_waiver_grant(&r, "envelope-sha").is_ok());
        assert_eq!(
            check_waiver_grant(&r, "another-sha").unwrap_err().code,
            "CONSENT_MISMATCH"
        );
    }

    #[test]
    fn a_waiver_grant_must_carry_the_payload_its_consent_was_recorded_over() {
        let sha = crate::paths::sha256_hex(batch().to_string().as_bytes());
        // The batch, its hash and the consent event agree: the grant is created.
        assert!(check_waiver_grant(
            &waiver_request(&sha, Some(serde_json::json!({"waive": batch()}))),
            &sha
        )
        .is_ok());
        // A grant that claims a payload other than the one the human consented to.
        assert_eq!(
            check_waiver_grant(&waiver_request("deadbeef", None), &sha)
                .unwrap_err()
                .code,
            "CONSENT_MISMATCH"
        );
        // The right hash, but a batch that does not hash to it (a row added after the click).
        let mut tampered = batch();
        tampered["findings"] = serde_json::json!([
            {"code": "OFF_GRID", "refs": ["style:grid:9"]},
            {"code": "ERC_SINGLE_PIN_NET", "refs": ["R9.1"]},
        ]);
        assert_eq!(
            check_waiver_grant(
                &waiver_request(&sha, Some(serde_json::json!({"waive": tampered}))),
                &sha
            )
            .unwrap_err()
            .code,
            "CONSENT_MISMATCH"
        );
        // Every other grant kind keeps hashing its own payload, which is not the consent's.
        let mut other = waiver_request("something-else", None);
        other.kind = "intent".into();
        assert!(check_waiver_grant(&other, &sha).is_ok());
    }
}
