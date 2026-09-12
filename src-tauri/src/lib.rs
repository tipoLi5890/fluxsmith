// SPDX-License-Identifier: Apache-2.0
//! fluxsmith desktop app — Rust effect kernel. See `src-tauri/README.md`.
#![allow(clippy::result_large_err)]

pub mod advisory;
pub mod checkpoint;
pub mod clipboard;
pub mod cloud;
pub mod commands;
pub mod db;
pub mod diag;
pub mod engine;
pub mod env;
pub mod error;
pub mod example;
pub mod export;
pub mod facts;
pub mod intake;
pub mod ipc;
pub mod keyring;
pub mod libindex;
pub mod log;
pub mod net;
pub mod parts;
pub mod parts_cache;
pub mod paths;
pub mod pdftext;
pub mod probe;
pub mod project;
pub mod recovery;
pub mod sandbox;
pub mod session;
pub mod settings;
pub mod sidecar;
pub mod skills;
pub mod skilltest;
pub mod state;
pub mod treecache;
pub mod update;
pub mod watch;
pub mod webtext;
pub mod winui;

use state::AppState;
use std::sync::Arc;
use tauri::Manager;

pub fn build_state(app_version: &str) -> Result<Arc<AppState>, ipc::IpcError> {
    let settings = settings::load();
    log::set_level(&settings.privacy.log_level);
    let db = db::Db::open(&db::db_path(), app_version)?;
    let conn_max = settings.advanced.provider_conn_max as usize;
    Ok(Arc::new(AppState {
        app_version: app_version.to_string(),
        settings: parking_lot::RwLock::new(settings),
        db: parking_lot::Mutex::new(db),
        projects: parking_lot::RwLock::new(Default::default()),
        sessions: parking_lot::Mutex::new(Default::default()),
        env: parking_lot::RwLock::new(Default::default()),
        net: net::NetState::new(conn_max, app_version),
        libindex: Default::default(),
        handle: std::sync::OnceLock::new(),
    }))
}

pub fn run() {
    let version = env!("CARGO_PKG_VERSION");
    // Windows: a missing/broken WebView2 runtime gets a native dialog before any window exists.
    winui::check_webview2();
    let state = match build_state(version) {
        Ok(s) => s,
        Err(e) => {
            // The DB refused to open (e.g. newer schema): surface via a native dialog and exit.
            eprintln!("fluxsmith: {}: {}", e.code, e.message);
            std::process::exit(2);
        }
    };
    let rebuilt = state.db.lock().rebuilt;
    keep_awake();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
            // "Open With" while the app already runs: Windows/Linux start a second process whose
            // argv carries the file and hand it here. The first launch reads the same argument
            // through `startup_args`; macOS delivers it as `RunEvent::Opened` instead.
            if let Some(p) = args.iter().skip(1).find(|a| is_project_arg(a)) {
                emit_open_file(app, p);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .setup(move |app| {
            let _ = state.handle.set(app.handle().clone());
            // The main window is built here (not from the config) so navigation can be observed and
            // fenced: the webview must never leave the app origin (an untrusted markdown link, a form
            // submit or a stray `location` write would tear down the harness running inside it).
            // Every navigation attempt is logged; foreign ones are refused.
            let win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("fluxsmith")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .on_navigation(|url| {
                    let host = url.host_str().unwrap_or("");
                    let ok = matches!(url.scheme(), "tauri" | "asset" | "ipc")
                        || (url.scheme() == "http" && (host == "localhost" || host == "127.0.0.1" || host == "tauri.localhost" || host == "asset.localhost" || host == "ipc.localhost"))
                        || (url.scheme() == "https" && host == "tauri.localhost");
                    log::event(
                        if ok { "debug" } else { "warn" },
                        "webview.navigation",
                        serde_json::json!({"url": url.as_str(), "allowed": ok}),
                        None,
                    );
                    ok
                })
                .build();
            if let Err(e) = win {
                log::event("error", "webview.window_failed", serde_json::json!({"error": e.to_string()}), None);
            }
            // Autorun (`--script=`): keep the window unoccluded. WebKit throttles and eventually parks DOM timers
            // of a hidden page, which froze the autorun wait loop when another window covered the app.
            if commands::script_path().is_some() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_always_on_top(true);
                }
            }
            // Hold the App Nap activity for every session (defined below; it was never called before 2026-09-06,
            // which is why long runs with a covered window still stalled).
            keep_awake();
            log::info(&format!("fluxsmith {version} starting; app data {}", paths::app_data_dir().display()));
            let v = commands::version(&state);
            log::set_header(serde_json::json!({"app": v.app, "engine": v.engine, "protocol": v.protocol_version, "db_schema": v.db_schema, "settings_schema": v.settings_schema, "git": v.git_sha}));
            log::event("info", "app.start", serde_json::json!({"app_data": paths::app_data_dir().to_string_lossy()}), None);
            log::prune(&log::jsonl_dir());
            let k = state.settings.read().kicad.clone();
            let report = env::check(&k);
            let ok = report.status == "ok";
            *state.env.write() = report;
            if ok {
                libindex::spawn(state.clone(), false);
            }
            if rebuilt {
                state.emit(ipc::AppEvent::Notification { title: "app data rebuilt".into(), body: "the local database was corrupt and has been recreated; conversations and approvals were lost".into(), project_key: None });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::startup_args,
            commands::dev_script_read,
            commands::dev_script_report,
            commands::dev_exit,
            commands::dev_sleep,
            commands::version_info,
            commands::env_check,
            commands::settings_get,
            commands::settings_set,
            commands::settings_reset,
            commands::provider_probe,
            commands::provider_models,
            commands::project_open,
            commands::project_close,
            commands::project_list_recent,
            commands::project_new,
            commands::example_install,
            commands::project_info,
            commands::project_shell_create,
            commands::engine_request,
            commands::build_session_open,
            commands::build_session_close,
            commands::build_session_touch,
            commands::turn_begin,
            commands::turn_end,
            commands::turn_counters,
            commands::consent_record,
            commands::grant_create,
            commands::checkpoint_create,
            commands::checkpoint_list,
            commands::rollback_preview,
            commands::rollback,
            commands::sidecar_write,
            commands::sidecar_read,
            commands::project_config_apply,
            commands::db_query,
            commands::keyring_set,
            commands::provider_remove,
            commands::keyring_has,
            commands::keyring_delete,
            commands::net_fetch,
            commands::net_abort,
            commands::origin_register,
            commands::origin_list,
            commands::fetch_origin_approve,
            commands::web_fetch,
            commands::web_fetch_text,
            commands::fetch_origin_list,
            commands::fetch_origin_revoke,
            commands::pdf_text,
            commands::parts_bom,
            commands::parts_search,
            commands::parts_show,
            commands::parts_datasheet,
            commands::parts_convert,
            commands::parts_refresh,
            commands::codex_device_begin,
            commands::codex_device_poll,
            commands::codex_revoke,
            commands::attach_intake,
            commands::attach_read,
            commands::attach_bind_to_project,
            commands::lib_register,
            commands::skills_list,
            commands::skills_read,
            commands::skills_trust,
            commands::skills_trust_workflows,
            commands::skills_revoke_workflows,
            commands::skills_write_draft,
            commands::skills_import_zip,
            commands::skills_export_zip,
            commands::export_file,
            commands::kicad_advisory,
            commands::lib_index_rebuild,
            commands::log_write,
            commands::diag_bundle,
            commands::app_data_path,
            commands::open_path,
            commands::open_url,
            commands::app_data_export,
            commands::app_data_wipe,
            commands::update_check,
            commands::update_disclosure,
            commands::clipboard_read_image,
            commands::log_event,
            commands::skills_preview,
            commands::skills_write_file,
            commands::skills_test,
        ])
        .build(tauri::generate_context!())
        .expect("error while running fluxsmith");
    #[allow(unused_variables)]
    app.run(|handle, event| {
        // macOS "Open With" / a dropped file on the dock icon: LaunchServices never starts a second
        // process, it sends the paths here. Everything else is the plugins' business.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for u in urls {
                if let Ok(p) = u.to_file_path() {
                    let p = p.to_string_lossy().to_string();
                    if is_project_arg(&p) {
                        emit_open_file(handle, &p);
                    }
                }
            }
        }
    });
}

/// A command-line / Open-With argument the app can act on: only the two KiCad files it opens.
fn is_project_arg(a: &str) -> bool {
    a.ends_with(".kicad_pro") || a.ends_with(".kicad_sch")
}

/// Ask the webview to open a project file (it does the same work as a click on a recent project).
fn emit_open_file(app: &tauri::AppHandle, path: &str) {
    use tauri::Emitter;
    log::event(
        "info",
        "app.open_file",
        serde_json::json!({"path": path}),
        None,
    );
    let _ = app.emit(
        "fluxsmith://event",
        ipc::AppEvent::OpenFile {
            path: path.to_string(),
        },
    );
}

/// macOS App Nap suspends the timers of an occluded window; a long Build whose
/// window is covered would then stall silently (the harness and its idle
/// polling live in the webview). Hold a user-initiated activity for the
/// process lifetime.
#[cfg(target_os = "macos")]
fn keep_awake() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    let info = NSProcessInfo::processInfo();
    let reason = NSString::from_str("fluxsmith agent turns run in the webview");
    let token = info.beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &reason,
    );
    std::mem::forget(token);
}

#[cfg(not(target_os = "macos"))]
fn keep_awake() {}
