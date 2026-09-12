// SPDX-License-Identifier: Apache-2.0
//! Shared parts library (docs/workspace-format.md): every LCSC resource that
//! was ever fetched is kept in app data and reused across projects.
//!
//! ```text
//! <app data>/parts/<LCSC>/meta.json        catalogue snapshot + pins (claim)
//!                        cad.json         raw EasyEDA product JSON
//!                        symbol.kicad_sym one-symbol library (human/UI copy)
//!                        footprint.kicad_mod
//!                        model.step
//! <app data>/libs/fluxsmith-parts.kicad_sym + .pretty/ + .3dshapes/
//! ```
//! Datasheet PDFs stay in the content-addressed `external/<sha>` store and are
//! referenced by `datasheet_sha`. The `parts_cache` table mirrors the
//! directory for listing/search; the directory is the truth.

use crate::error::err;
use crate::ipc::IpcError;
use crate::paths::{app_data_dir, ensure_dir, now_iso, write_atomic};
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;

pub const SHARED_NICKNAME: &str = "fluxsmith-parts";
/// Stock/price snapshots older than this are refreshed when the network is available.
pub const META_TTL_SECS: i64 = 7 * 24 * 3600;

pub fn parts_dir() -> PathBuf {
    app_data_dir().join("parts")
}

pub fn libs_dir() -> PathBuf {
    app_data_dir().join("libs")
}

pub fn dir(lcsc: &str) -> PathBuf {
    parts_dir().join(easyeda_convert::normalize_lcsc(lcsc))
}

fn read_json(p: &std::path::Path) -> Option<Value> {
    std::fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn read_cad(lcsc: &str) -> Option<Value> {
    read_json(&dir(lcsc).join("cad.json"))
}

pub fn write_cad(lcsc: &str, cad: &Value) -> Result<(), IpcError> {
    let d = dir(lcsc);
    ensure_dir(&d)?;
    write_atomic(&d.join("cad.json"), serde_json::to_vec(cad)?.as_slice())
}

pub fn read_meta(lcsc: &str) -> Option<Value> {
    read_json(&dir(lcsc).join("meta.json"))
}

pub fn has(lcsc: &str, file: &str) -> bool {
    dir(lcsc).join(file).exists()
}

/// Seconds since the meta snapshot was fetched (None when unknown).
pub fn meta_age_secs(meta: &Value) -> Option<i64> {
    let s = meta.get("fetched_at")?.as_str()?;
    let t = chrono::DateTime::parse_from_rfc3339(s).ok()?;
    Some(chrono::Utc::now().timestamp() - t.timestamp())
}

/// Merge `patch` into `meta.json` (fields absent from the patch survive) and
/// mirror the row into the `parts_cache` table.
pub fn upsert_meta(state: &AppState, lcsc: &str, patch: Value) -> Result<Value, IpcError> {
    let lcsc = easyeda_convert::normalize_lcsc(lcsc);
    let d = dir(&lcsc);
    ensure_dir(&d)?;
    let mut meta = read_meta(&lcsc).unwrap_or_else(|| json!({}));
    if let (Some(m), Some(p)) = (meta.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            if !v.is_null() {
                m.insert(k.clone(), v.clone());
            }
        }
        m.insert("lcsc".into(), Value::String(lcsc.clone()));
        m.insert("claim".into(), Value::Bool(true));
        m.entry("fetched_at".to_string())
            .or_insert_with(|| Value::String(now_iso()));
    }
    write_atomic(
        &d.join("meta.json"),
        serde_json::to_vec_pretty(&meta)?.as_slice(),
    )?;
    let row = row_from_meta(&lcsc, &meta);
    state.db.lock().parts_cache_upsert(&row)?;
    Ok(meta)
}

/// The table row (what `parts_cache_list` returns) derived from meta + files.
pub fn row_from_meta(lcsc: &str, meta: &Value) -> Value {
    let s = |k: &str| {
        meta.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    json!({
        "lcsc": lcsc,
        "mpn": s("mpn"),
        "package": s("package"),
        "description": s("description"),
        "basic": meta.get("basic").and_then(|v| v.as_bool()).unwrap_or(false),
        "stock": meta.get("stock").and_then(|v| v.as_i64()).unwrap_or(0),
        "price_usd": meta.get("price_usd").and_then(|v| v.as_f64()),
        "fetched_at": s("fetched_at"),
        "last_used": now_iso(),
        "has_cad": has(lcsc, "cad.json"),
        "has_symbol": has(lcsc, "symbol.kicad_sym"),
        "has_footprint": has(lcsc, "footprint.kicad_mod"),
        "has_step": has(lcsc, "model.step"),
        "datasheet_sha": meta.get("datasheet_sha").and_then(|v| v.as_str()),
        "datasheet_url": meta.get("datasheet_url").and_then(|v| v.as_str()),
        "pins": meta.get("pins").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0),
    })
}

pub fn touch(state: &AppState, lcsc: &str) {
    let _ = state
        .db
        .lock()
        .parts_cache_touch(&easyeda_convert::normalize_lcsc(lcsc));
}

/// A catalogue row in the `parts.search` shape, from the cache (or None when
/// the part has no snapshot yet).
pub fn search_row(lcsc: &str) -> Option<Value> {
    let meta = read_meta(lcsc)?;
    if meta
        .get("mpn")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return None;
    }
    Some(json!({
        "lcsc": easyeda_convert::normalize_lcsc(lcsc),
        "mpn": meta.get("mpn").cloned().unwrap_or(Value::String(String::new())),
        "package": meta.get("package").cloned().unwrap_or(Value::String(String::new())),
        "description": meta.get("description").cloned().unwrap_or(Value::String(String::new())),
        "stock": meta.get("stock").cloned().unwrap_or(json!(0)),
        "price_usd": meta.get("price_usd").cloned().unwrap_or(Value::Null),
        "basic": meta.get("basic").cloned().unwrap_or(Value::Bool(false)),
        "preferred": meta.get("preferred").cloned().unwrap_or(Value::Bool(false)),
        "cached": true,
        "fetched_at": meta.get("fetched_at").cloned().unwrap_or(Value::Null),
    }))
}

/// Cached rows matching the free-text terms (lcsc / mpn / description LIKE).
pub fn search(state: &AppState, terms: &[String], limit: usize) -> Vec<Value> {
    let rows = state
        .db
        .lock()
        .parts_cache_list(Some(&terms.join(" ")))
        .unwrap_or_default();
    rows.iter()
        .filter_map(|r| r.get("lcsc").and_then(|v| v.as_str()).and_then(search_row))
        .take(limit)
        .collect()
}

/// Store the converted artefacts for `lcsc` in the cache directory and the
/// shared library. Returns the shared-library paths. Idempotent: a symbol or
/// footprint of the same name is reused.
pub fn store_converted(
    lcsc: &str,
    spec: &sch_libwrite::PartSpec,
    step: Option<&[u8]>,
) -> Result<Value, IpcError> {
    let lcsc = easyeda_convert::normalize_lcsc(lcsc);
    let d = dir(&lcsc);
    ensure_dir(&d)?;
    let libs = libs_dir();
    ensure_dir(&libs)?;
    let shared_sym = libs.join(format!("{SHARED_NICKNAME}.kicad_sym"));
    let shared_fp = libs.join(format!("{SHARED_NICKNAME}.pretty"));
    let shared_3d = libs.join(format!("{SHARED_NICKNAME}.3dshapes"));
    ensure_dir(&shared_fp)?;
    let mut spec = spec.clone();
    spec.model_step_base64 = None;
    let fp_name = spec
        .footprint
        .as_ref()
        .map(|f| f.name.clone())
        .unwrap_or_else(|| spec.name.clone());
    // STEP: cache copy + shared 3dshapes.
    let mut step_path = None;
    if let Some(bytes) = step {
        if bytes.len() > 100 {
            ensure_dir(&shared_3d)?;
            let cache_step = d.join("model.step");
            if !cache_step.exists() {
                write_atomic(&cache_step, bytes)?;
            }
            let shared_step = shared_3d.join(format!("{fp_name}.step"));
            if !shared_step.exists() {
                write_atomic(&shared_step, bytes)?;
            }
            step_path = Some(shared_step.to_string_lossy().to_string());
        }
    }
    if let Some(fp) = spec.footprint.as_mut() {
        match step_path.as_ref() {
            Some(p) => match fp.model.as_mut() {
                Some(m) => m.path = p.clone(),
                None => {
                    fp.model = Some(sch_libwrite::ModelRef {
                        path: p.clone(),
                        ..Default::default()
                    })
                }
            },
            None => fp.model = None,
        }
    }
    // Symbol: per-part copy (single-symbol lib) and the shared library.
    let sym_text_single =
        sch_libwrite::write_symbol_lib(None, &spec).map_err(|e| err("LIB_PARSE_ERROR", e))?;
    write_atomic(&d.join("symbol.kicad_sym"), sym_text_single.as_bytes())?;
    let existing = std::fs::read_to_string(&shared_sym).ok();
    let sym_exists = existing
        .as_ref()
        .map(|e| e.contains(&format!("(symbol \"{}\"", spec.name)))
        .unwrap_or(false);
    if !sym_exists {
        let text = sch_libwrite::write_symbol_lib(existing.as_deref(), &spec)
            .map_err(|e| err("LIB_PARSE_ERROR", e))?;
        write_atomic(&shared_sym, text.as_bytes())?;
    }
    // Footprint.
    let mut fp_path = None;
    if let Some(fp) = &spec.footprint {
        let text = sch_libwrite::write_footprint(fp).map_err(|e| err("LIB_PARSE_ERROR", e))?;
        write_atomic(&d.join("footprint.kicad_mod"), text.as_bytes())?;
        let shared = shared_fp.join(format!("{}.kicad_mod", fp.name));
        if !shared.exists() {
            write_atomic(&shared, text.as_bytes())?;
        }
        fp_path = Some(shared.to_string_lossy().to_string());
    }
    Ok(json!({
        "nickname": SHARED_NICKNAME,
        "symbol_lib": shared_sym.to_string_lossy(),
        "footprint": fp_path,
        "model": step_path,
        "lib_id": format!("{SHARED_NICKNAME}:{}", spec.name),
    }))
}

pub fn read_step(lcsc: &str) -> Option<Vec<u8>> {
    std::fs::read(dir(lcsc).join("model.step")).ok()
}

/// Remove one part from the cache (directory + row). The shared library keeps
/// the symbol: other projects may already reference it.
pub fn forget(state: &AppState, lcsc: &str) -> Result<(), IpcError> {
    let lcsc = easyeda_convert::normalize_lcsc(lcsc);
    let d = dir(&lcsc);
    if d.exists() {
        std::fs::remove_dir_all(&d).map_err(|e| crate::error::io_err(&d, e))?;
    }
    state.db.lock().parts_cache_forget(&lcsc)
}

/// Rebuild the table from the directory (after a clear / import).
pub fn reindex(state: &AppState) -> Result<usize, IpcError> {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(parts_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(meta) = read_meta(&name) {
                state
                    .db
                    .lock()
                    .parts_cache_upsert(&row_from_meta(&name, &meta))?;
                n += 1;
            }
        }
    }
    Ok(n)
}

pub fn clear_all(state: &AppState) -> Result<(), IpcError> {
    let _ = std::fs::remove_dir_all(parts_dir());
    let _ = std::fs::remove_dir_all(libs_dir());
    state.db.lock().parts_cache_clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_round_trip_list_and_forget() {
        let state = AppState::for_tests();
        let meta = upsert_meta(
            &state,
            "c14663",
            json!({"mpn": "CC0603KRX7R9BB104", "package": "0603", "description": "100nF X7R", "stock": 5, "price_usd": 0.01, "basic": true}),
        )
        .unwrap();
        assert_eq!(meta["lcsc"], "C14663");
        assert!(read_meta("C14663").is_some());
        let rows = state.db.lock().parts_cache_list(Some("100nF")).unwrap();
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0]["mpn"], "CC0603KRX7R9BB104");
        assert_eq!(search(&state, &["0603".into()], 5).len(), 1);
        assert!(search_row("C14663").unwrap()["cached"].as_bool().unwrap());
        write_cad("C14663", &json!({"result": {"x": 1}})).unwrap();
        assert_eq!(read_cad("C14663").unwrap()["result"]["x"], 1);
        let rows = state.db.lock().parts_cache_list(None).unwrap();
        assert!(rows.iter().any(|r| r["lcsc"] == "C14663"));
        forget(&state, "C14663").unwrap();
        assert!(read_meta("C14663").is_none());
        assert!(state.db.lock().parts_cache_list(None).unwrap().is_empty());
    }
}
