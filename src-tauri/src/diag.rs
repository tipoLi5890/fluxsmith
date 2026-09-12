// SPDX-License-Identifier: Apache-2.0
//! Storage report/clear, diagnostics bundle, app-data export/wipe.

use crate::db::Db;
use crate::error::{err, io_err};
use crate::ipc::{DiagBundleSpec, IpcError};
use crate::paths::app_data_dir;
use crate::state::AppState;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if let Ok(m) = e.metadata() {
                    total += m.len();
                }
            }
        }
    }
    total
}

pub fn storage_report(db: &Db) -> Result<Value, IpcError> {
    let base = app_data_dir();
    let cps: i64 = db
        .conn
        .query_row(
            "SELECT count(DISTINCT project_key || turn) FROM checkpoints WHERE pruned=0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let ext: i64 = db
        .conn
        .query_row("SELECT count(*) FROM external_files", [], |r| r.get(0))
        .unwrap_or(0);
    Ok(json!({
        "checkpoints": {"bytes": dir_size(&base.join("checkpoints")), "count": cps},
        "external": {"bytes": dir_size(&base.join("external")), "count": ext},
        "assets": {"bytes": dir_size(&base.join("assets"))},
        "parts": {"bytes": dir_size(&base.join("parts")) + dir_size(&base.join("libs")), "count": db.parts_cache_count()},
        "logs": {"bytes": dir_size(&base.join("logs"))},
        "db": {"bytes": std::fs::metadata(&db.path).map(|m| m.len()).unwrap_or(0)},
        "app_data": base.to_string_lossy(),
    }))
}

pub fn storage_clear(db: &Db, area: &str) -> Result<(), IpcError> {
    let base = app_data_dir();
    match area {
        "checkpoints" => {
            db.conn.execute("UPDATE checkpoints SET pruned=1", [])?;
            let _ = std::fs::remove_dir_all(base.join("checkpoints"));
        }
        "external" => {
            // Keep blobs still referenced by a project pointer.
            let mut st = db.conn.prepare("SELECT sha256 FROM external_files WHERE sha256 NOT IN (SELECT sha256 FROM external_refs)")?;
            let shas: Vec<String> = st
                .query_map([], |r| r.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            for s in shas {
                db.conn
                    .execute("DELETE FROM external_files WHERE sha256=?1", [&s])?;
                let _ = std::fs::remove_file(base.join("external").join(&s));
            }
        }
        "assets" => {
            let _ = std::fs::remove_dir_all(base.join("assets"));
        }
        "parts" => {
            let _ = std::fs::remove_dir_all(base.join("parts"));
            let _ = std::fs::remove_dir_all(base.join("libs"));
            db.parts_cache_clear()?;
        }
        "logs" => {
            let _ = std::fs::remove_dir_all(base.join("logs"));
        }
        _ => return Err(err("BAD_CONFIG", "unknown storage area")),
    }
    Ok(())
}

pub fn bundle(state: &AppState, spec: &DiagBundleSpec) -> Result<String, IpcError> {
    let out = Path::new(&spec.out_path);
    let file = std::fs::File::create(out).map_err(|e| io_err(out, e))?;
    let mut z = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), IpcError> {
        z.start_file(name, opts)
            .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
        z.write_all(bytes)
            .map_err(|e| err("FS_TRANSIENT", e.to_string()))
    };
    add(
        "version.json",
        serde_json::to_string_pretty(&crate::commands::version(state))?.as_bytes(),
    )?;
    add(
        "env.json",
        serde_json::to_string_pretty(&*state.env.read())?.as_bytes(),
    )?;
    if spec.include_log {
        let log = std::fs::read_to_string(crate::log::log_path()).unwrap_or_default();
        add("fluxsmith.log", crate::log::mask(&log).as_bytes())?;
    }
    if spec.include_settings {
        let mut v = serde_json::to_value(&*state.settings.read())?;
        if let Some(list) = v.get_mut("providers").and_then(|p| p.as_array_mut()) {
            for p in list {
                if let Some(o) = p.as_object_mut() {
                    o.remove("has_secret");
                }
            }
        }
        add(
            "settings.json",
            serde_json::to_string_pretty(&v)?.as_bytes(),
        )?;
    }
    let allowed = [
        "projects",
        "approvals",
        "consent_events",
        "checkpoints",
        "lib_files",
        "metrics",
        "compactions",
        "model_calls",
        "crashes",
        "attachments",
        "sessions",
        "messages",
        "external_files",
    ];
    for t in &spec.include_db_tables {
        if !allowed.contains(&t.as_str()) {
            continue;
        }
        let rows: Vec<Value> = {
            let db = state.db.lock();
            let mut st = db.conn.prepare(&format!("SELECT * FROM {t} LIMIT 5000"))?;
            let cols: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
            let rows: Vec<Value> = st
                .query_map([], |r| {
                    let mut o = serde_json::Map::new();
                    for (i, c) in cols.iter().enumerate() {
                        let v: rusqlite::types::Value = r.get(i)?;
                        let jv = match v {
                            rusqlite::types::Value::Null => Value::Null,
                            rusqlite::types::Value::Integer(i) => json!(i),
                            rusqlite::types::Value::Real(f) => json!(f),
                            rusqlite::types::Value::Text(s) => {
                                if t == "external_files" && c == "source_url" {
                                    Value::String("[redacted]".into())
                                } else {
                                    Value::String(crate::log::mask(&s))
                                }
                            }
                            rusqlite::types::Value::Blob(_) => Value::String("[blob]".into()),
                        };
                        o.insert(c.clone(), jv);
                    }
                    Ok(Value::Object(o))
                })?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        add(
            &format!("db/{t}.json"),
            serde_json::to_string_pretty(&rows)?.as_bytes(),
        )?;
    }
    if let Some(pk) = &spec.include_project_meta {
        if let Ok(h) = state.project(pk) {
            let info = crate::project::info(state, &h)?;
            add("project.json", serde_json::to_string_pretty(&json!({"key": info.key, "name": info.name, "version": info.version, "sheets": info.sheets, "config": info.config, "locked": info.locked}))?.as_bytes())?;
            let journal =
                crate::sidecar::read(&h.root, "journal", None, None).unwrap_or(Value::Null);
            add(
                "project-journal.json",
                serde_json::to_string_pretty(&journal)?.as_bytes(),
            )?;
        }
    }
    z.finish().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    Ok(spec.out_path.clone())
}

/// App data export (no secrets): settings, db copy, skills, checkpoints index.
pub fn export_app_data(state: &AppState, out: &str) -> Result<(), IpcError> {
    let base = app_data_dir();
    let file = std::fs::File::create(out).map_err(|e| io_err(Path::new(out), e))?;
    let mut z = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for sub in [
        "settings.json",
        "skills",
        "checkpoints",
        "external",
        "parts",
        "libs",
    ] {
        let p = base.join(sub);
        if p.is_file() {
            z.start_file(sub, opts)
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            z.write_all(&std::fs::read(&p).map_err(|e| io_err(&p, e))?)
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
        } else if p.is_dir() {
            let mut stack = vec![p.clone()];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).map_err(|e| io_err(&d, e))?.flatten() {
                    let f = e.path();
                    if f.is_dir() {
                        stack.push(f);
                        continue;
                    }
                    let rel = f
                        .strip_prefix(&base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    z.start_file(rel, opts)
                        .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
                    z.write_all(&std::fs::read(&f).map_err(|e| io_err(&f, e))?)
                        .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
                }
            }
        }
    }
    // DB: a consistent copy via backup API.
    let db = state.db.lock();
    let tmp = base.join("export-tmp.db");
    {
        let mut dst = rusqlite::Connection::open(&tmp)?;
        let backup = rusqlite::backup::Backup::new(&db.conn, &mut dst)?;
        backup.run_to_completion(100, std::time::Duration::from_millis(5), None)?;
    }
    drop(db);
    z.start_file("fluxsmith.db", opts)
        .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    z.write_all(&std::fs::read(&tmp).map_err(|e| io_err(&tmp, e))?)
        .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    let _ = std::fs::remove_file(&tmp);
    z.finish().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    Ok(())
}

pub fn wipe(state: &AppState, consent: &str) -> Result<(), IpcError> {
    if !state.db.lock().consent_exists(consent)? {
        return Err(err("CONSENT_REQUIRED", "wipe needs a recorded consent"));
    }
    let ids: Vec<String> = state
        .settings
        .read()
        .providers
        .iter()
        .map(|p| p.id.clone())
        .collect();
    for id in ids {
        let _ = crate::keyring::delete(&id);
    }
    let _ = crate::keyring::delete("openai-codex");
    let base = app_data_dir();
    for sub in [
        "settings.json",
        "skills",
        "checkpoints",
        "external",
        "assets",
        "logs",
        "parts",
        "libs",
    ] {
        let p = base.join(sub);
        if p.is_dir() {
            let _ = std::fs::remove_dir_all(&p);
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }
    // The DB is recreated empty on next launch; wipe rows now.
    let db = state.db.lock();
    for t in [
        "messages",
        "sessions",
        "attachments",
        "metrics",
        "compactions",
        "model_calls",
        "checkpoints",
        "external_refs",
        "external_files",
        "approvals",
        "consent_events",
        "projects",
        "symbols_fts",
        "symbols",
        "lib_files",
        "crashes",
        "parts_cache",
    ] {
        let _ = db.conn.execute(&format!("DELETE FROM {t}"), []);
    }
    Ok(())
}
