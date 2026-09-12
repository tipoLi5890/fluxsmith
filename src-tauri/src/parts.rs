// SPDX-License-Identifier: Apache-2.0
//! Parts sourcing (M3): JLCPCB/LCSC search via jlcsearch (tscircuit, MIT),
//! EasyEDA CAD fetch, datasheet download, and CAD → KiCad conversion through
//! `easyeda_convert` + `sch_libwrite`. Every network call goes through the
//! Rust reqwest client and the `parts` origin whitelist (`net::PARTS_ORIGINS`);
//! nothing runs unless `settings.parts.enabled` is true (consent recorded in
//! Settings). Every result is a CLAIM and is returned untrusted.

use crate::error::err;
use crate::ipc::*;
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;

const SEARCH_BASE: &str = "https://jlcsearch.tscircuit.com";
const MAX_BYTES: u64 = 50 * 1024 * 1024;
const USER_AGENT: &str = "fluxsmith/0.1 (+parts sourcing; EasyEDA/JLC CAD converter)";

pub fn ensure_enabled(state: &AppState) -> Result<(), IpcError> {
    if state.settings.read().parts.enabled {
        Ok(())
    } else {
        Err(err(
            "PARTS_DISABLED",
            "parts sourcing (JLCPCB/LCSC/EasyEDA network access) is switched off",
        )
        .with_remediation(
            "ask the user to enable parts sourcing in Settings > Privacy; part queries go to third-party services",
        ))
    }
}

/// GET with the parts whitelist, following at most 3 redirects that stay
/// inside the whitelist. Returns (final url, content-type, bytes).
async fn get(state: &AppState, url: &str) -> Result<(String, String, Vec<u8>), IpcError> {
    let mut url = url.to_string();
    for _ in 0..4 {
        let origin = crate::net::origin_of(&url)?;
        if !crate::net::origin_allowed(&origin, "parts", &[], &[]) {
            return Err(err(
                "NET_ORIGIN_DENIED",
                format!("{origin} is not an allowed parts origin"),
            ));
        }
        crate::log::write("debug", &format!("parts GET {origin}"), "parts");
        let resp = state
            .net
            .client
            .get(&url)
            .header("user-agent", USER_AGENT)
            .header("accept", "application/json, application/pdf, */*")
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    err("NET_TIMEOUT", e.to_string())
                } else {
                    err("NET_OFFLINE", e.to_string())
                }
            })?;
        if resp.status().is_redirection() {
            let Some(loc) = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
            else {
                return Err(err("NET_REDIRECT_BLOCKED", "redirect without location"));
            };
            url = match url::Url::parse(&url).and_then(|b| b.join(&loc)) {
                Ok(u) => u.to_string(),
                Err(_) => return Err(err("NET_REDIRECT_BLOCKED", "bad redirect target")),
            };
            continue;
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(err(
                "PARTS_UPSTREAM",
                format!("{origin} answered HTTP {}", status.as_u16()),
            )
            .with_remediation("the part may not exist or the service is down; retry later"));
        }
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if resp.content_length().unwrap_or(0) > MAX_BYTES {
            return Err(err("NET_TOO_LARGE", "response exceeds 50 MB"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| err("PROVIDER_STREAM_BROKEN", e.to_string()))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(err("NET_TOO_LARGE", "response exceeds 50 MB"));
        }
        return Ok((url, ct, bytes.to_vec()));
    }
    Err(err("NET_REDIRECT_BLOCKED", "too many redirects"))
}

async fn get_json(state: &AppState, url: &str) -> Result<Value, IpcError> {
    let (_, _, bytes) = get(state, url).await?;
    serde_json::from_slice(&bytes).map_err(|e| {
        err(
            "PARTS_UPSTREAM",
            format!("invalid JSON from parts service: {e}"),
        )
    })
}

fn lcsc_str(v: &Value) -> String {
    match v {
        Value::Number(n) => format!("C{n}"),
        Value::String(s) => easyeda_convert::normalize_lcsc(s),
        _ => String::new(),
    }
}

fn search_row(c: &Value) -> Value {
    let price = match c.get("price") {
        Some(Value::Number(n)) => n.as_f64().map(Value::from).unwrap_or(Value::Null),
        Some(Value::String(s)) => {
            // "1-9:1.0038,10-29:0.8167,..." → first tier
            s.split(',')
                .next()
                .and_then(|t| t.split(':').nth(1))
                .and_then(|p| p.parse::<f64>().ok())
                .map(Value::from)
                .unwrap_or(Value::Null)
        }
        _ => Value::Null,
    };
    json!({
        "lcsc": lcsc_str(c.get("lcsc").unwrap_or(&Value::Null)),
        "mpn": c.get("mfr").and_then(|v| v.as_str()).unwrap_or(""),
        "package": c.get("package").and_then(|v| v.as_str()).unwrap_or(""),
        "description": c.get("description").and_then(|v| v.as_str()).unwrap_or(""),
        "stock": c.get("stock").and_then(|v| v.as_i64()).unwrap_or(0),
        "price_usd": price,
        "basic": c.get("is_basic").and_then(|v| v.as_bool()).unwrap_or(false),
        "preferred": c.get("is_preferred").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

/// Search orderable parts. `query` is free text; the structured fields are
/// joined into it when given.
#[allow(clippy::too_many_arguments)]
pub async fn search(
    state: Arc<AppState>,
    query: Option<String>,
    mpn: Option<String>,
    lcsc: Option<String>,
    value: Option<String>,
    package: Option<String>,
    category: Option<String>,
    limit: Option<u32>,
    in_stock: Option<bool>,
    basic_only: Option<bool>,
) -> Result<Value, IpcError> {
    let mut terms: Vec<String> = Vec::new();
    if let Some(l) = lcsc.as_deref().filter(|s| !s.trim().is_empty()) {
        terms.push(easyeda_convert::normalize_lcsc(l));
    }
    for t in [&mpn, &value, &package, &category, &query] {
        if let Some(s) = t.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            terms.push(s.to_string());
        }
    }
    if terms.is_empty() {
        return Err(err(
            "BAD_CONFIG",
            "parts.search needs a query, mpn, lcsc or value+package",
        ));
    }
    let q = terms.join(" ");
    let limit = limit.unwrap_or(20).clamp(1, 50);
    // The shared parts library answers first: parts already fetched for any project
    // come back without a network call (and are all that is available offline or
    // while parts sourcing is switched off).
    let cached: Vec<Value> = crate::parts_cache::search(&state, &terms, limit as usize)
        .into_iter()
        .filter(|r| {
            (!in_stock.unwrap_or(false) || r.get("stock").and_then(|s| s.as_i64()).unwrap_or(0) > 0)
                && (!basic_only.unwrap_or(false)
                    || r.get("basic").and_then(|b| b.as_bool()).unwrap_or(false))
        })
        .collect();
    if let Err(e) = ensure_enabled(&state) {
        if cached.is_empty() {
            return Err(e);
        }
        return Ok(json!({
            "query": q, "results": cached, "relaxed": [], "hint": "parts sourcing is off: only the shared parts library was searched",
            "source": "cache", "cached": true, "claim": true,
            "note": "shared parts library snapshot; enable parts sourcing in Settings > Privacy for live catalogue data",
        }));
    }
    let fetch_n = if in_stock.unwrap_or(false) || basic_only.unwrap_or(false) {
        (limit * 3).min(100)
    } else {
        limit
    };
    // Empty results are the model's cue to give up, so the search itself relaxes:
    // 1) as asked, 2) without the basic-only filter, 3) with package-like tokens
    // dropped from the query, 4) without the stock filter. What was relaxed is reported.
    let mut relaxed: Vec<&str> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut attempts: Vec<(String, bool, bool)> = vec![(
        q.clone(),
        in_stock.unwrap_or(false),
        basic_only.unwrap_or(false),
    )];
    if basic_only.unwrap_or(false) {
        attempts.push((q.clone(), in_stock.unwrap_or(false), false));
    }
    let stripped = strip_package_tokens(&q);
    if stripped != q && !stripped.trim().is_empty() {
        attempts.push((stripped.clone(), in_stock.unwrap_or(false), false));
    }
    if in_stock.unwrap_or(false) {
        attempts.push((
            if stripped.trim().is_empty() {
                q.clone()
            } else {
                stripped.clone()
            },
            false,
            false,
        ));
    }
    for (i, (qi, stock_f, basic_f)) in attempts.iter().enumerate() {
        let url = format!(
            "{SEARCH_BASE}/api/search?q={}&limit={fetch_n}",
            urlencoding::encode(qi)
        );
        let v = match get_json(&state, &url).await {
            Ok(v) => v,
            Err(e) if !cached.is_empty() => {
                return Ok(json!({
                    "query": q, "results": cached, "relaxed": [], "hint": format!("catalogue unreachable ({}): only the shared parts library was searched", e.message),
                    "source": "cache", "cached": true, "claim": true,
                    "note": "shared parts library snapshot; the live catalogue could not be reached",
                }));
            }
            Err(e) => return Err(e),
        };
        let mut cand: Vec<Value> = v
            .get("components")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().map(search_row).collect())
            .unwrap_or_default();
        if *stock_f {
            cand.retain(|r| r.get("stock").and_then(|s| s.as_i64()).unwrap_or(0) > 0);
        }
        if *basic_f {
            cand.retain(|r| r.get("basic").and_then(|s| s.as_bool()).unwrap_or(false));
        }
        if !cand.is_empty() || i + 1 == attempts.len() {
            rows = cand;
            if i > 0 {
                if basic_only.unwrap_or(false) && !*basic_f {
                    relaxed.push("basic_only");
                }
                if qi != &q {
                    relaxed.push("package tokens dropped from the query");
                }
                if in_stock.unwrap_or(false) && !*stock_f {
                    relaxed.push("in_stock");
                }
            }
            break;
        }
    }
    if let Some(p) = package.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // exact package filter when the user gave one; keep others if nothing matches. Whole-name comparison
        // (spaces / underscores / case ignored): "SOT-23" must not accept "SOT-23-5" or "SOT-23-6".
        let norm = |x: &str| x.to_ascii_lowercase().replace([' ', '_'], "-");
        let pl = norm(p);
        let exact: Vec<Value> = rows
            .iter()
            .filter(|r| {
                r.get("package")
                    .and_then(|s| s.as_str())
                    .map(|s| norm(s) == pl)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if !exact.is_empty() {
            rows = exact;
        }
    }
    // Cached hits first (deduplicated by LCSC), then the live catalogue.
    let mut merged: Vec<Value> = cached.clone();
    for r in rows {
        let id = r
            .get("lcsc")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !merged
            .iter()
            .any(|c| c.get("lcsc").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            merged.push(r);
        }
    }
    let mut rows = merged;
    rows.truncate(limit as usize);
    let source = if cached.is_empty() {
        "jlcsearch"
    } else {
        "cache+jlcsearch"
    };
    let empty_hint = if rows.is_empty() {
        "no match even after relaxing the filters: search again with a generic description (function + key rating, e.g. \"3.3V LDO SOT-23-5\" or \"USB-C receptacle 16P\"), a different part family, or an LCSC number; do not stop the step because a query was empty"
    } else {
        ""
    };
    Ok(json!({
        "query": q,
        "results": rows,
        "relaxed": relaxed,
        "hint": empty_hint,
        "source": source,
        "cached": !cached.is_empty(),
        "claim": true,
        "note": "stock and prices are a snapshot; confirm at order time. Use parts.show for pins/CAD and parts.convert to make a KiCad library."
    }))
}

/// Drop package/footprint-looking tokens ("SOT-23-5", "0603", "SOIC-20") so a
/// second search matches on the electrical description alone.
fn strip_package_tokens(q: &str) -> String {
    q.split_whitespace()
        .filter(|t| {
            let u = t.to_ascii_uppercase();
            let pkg = u.starts_with("SOT")
                || u.starts_with("SOD")
                || u.starts_with("SOIC")
                || u.starts_with("SOP")
                || u.starts_with("TSSOP")
                || u.starts_with("MSOP")
                || u.starts_with("QFN")
                || u.starts_with("DFN")
                || u.starts_with("VQFN")
                || u.starts_with("TQFP")
                || u.starts_with("LQFP")
                || u.starts_with("SMA")
                || u.starts_with("SMB")
                || u.starts_with("DO-")
                || u.starts_with("TO-")
                || u == "SMD"
                || u == "THT";
            let imperial = matches!(
                u.as_str(),
                "0201" | "0402" | "0603" | "0805" | "1206" | "1210" | "2010" | "2512"
            );
            !(pkg || imperial)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

async fn product(state: &AppState, lcsc: &str) -> Result<Value, IpcError> {
    let lcsc = easyeda_convert::normalize_lcsc(lcsc);
    if lcsc.len() < 2 || !lcsc[1..].chars().all(|c| c.is_ascii_digit()) {
        return Err(err(
            "BAD_CONFIG",
            format!("{lcsc} is not an LCSC part number (C followed by digits)"),
        ));
    }
    // CAD JSON never changes for a given LCSC number: the shared cache is the truth once filled.
    if let Some(v) = crate::parts_cache::read_cad(&lcsc) {
        crate::parts_cache::touch(state, &lcsc);
        return Ok(v);
    }
    ensure_enabled(state)?;
    let v = get_json(state, &easyeda_convert::product_url(&lcsc)).await;
    let v = match v {
        Ok(v) if v.get("result").map(|r| r.is_object()).unwrap_or(false) => v,
        _ => {
            // Fallback: jlcsearch's shared EasyEDA cache.
            let alt = get_json(
                state,
                &format!("{SEARCH_BASE}/api/easyeda_components/{lcsc}"),
            )
            .await?;
            let inner = alt
                .get("easyeda_component_details")
                .and_then(|d| d.get("easyeda_json"))
                .cloned()
                .ok_or_else(|| {
                    err("PARTS_NOT_FOUND", format!("{lcsc} has no EasyEDA CAD data"))
                        .with_remediation("pick another candidate from parts.search or draw with a generic KiCad symbol")
                })?;
            if inner.get("result").is_some() {
                inner
            } else {
                json!({ "result": inner })
            }
        }
    };
    let _ = crate::parts_cache::write_cad(&lcsc, &v);
    Ok(v)
}

/// Catalogue snapshot for one LCSC number (stock/price/basic) from jlcsearch.
async fn catalogue_row(state: &AppState, lcsc: &str) -> Option<Value> {
    let norm = easyeda_convert::normalize_lcsc(lcsc);
    get_json(state, &format!("{SEARCH_BASE}/api/search?q={norm}&limit=3"))
        .await
        .ok()
        .and_then(|v| {
            v.get("components")?
                .as_array()?
                .iter()
                .find(|c| lcsc_str(c.get("lcsc").unwrap_or(&Value::Null)) == norm)
                .map(search_row)
        })
}

/// Meta patch for the cache from a conversion + optional catalogue row.
fn meta_patch(c: &easyeda_convert::Converted, catalogue: Option<&Value>) -> Value {
    let mut m = json!({
        "mpn": c.spec.mpn,
        "manufacturer": c.manufacturer,
        "package": c.package,
        "description": c.spec.description,
        "datasheet_url": c.datasheet_url,
        "pins": pins_json(c),
        "symbol_name": c.spec.name,
        "footprint_name": c.spec.footprint.as_ref().map(|f| f.name.clone()),
        "model_3d": c.model_uuid.is_some(),
    });
    if let Some(row) = catalogue {
        for k in ["stock", "price_usd", "basic", "preferred"] {
            if let Some(v) = row.get(k) {
                m[k] = v.clone();
            }
        }
        m["fetched_at"] = Value::String(crate::paths::now_iso());
    }
    m
}

fn pins_json(c: &easyeda_convert::Converted) -> Vec<Value> {
    c.spec
        .pins
        .iter()
        .map(|p| json!({"number": p.number, "name": p.name, "type": p.kind}))
        .collect()
}

/// Part detail: identity, CAD availability, pin table (claim).
pub async fn show(state: Arc<AppState>, lcsc: String) -> Result<Value, IpcError> {
    let norm = easyeda_convert::normalize_lcsc(&lcsc);
    let p = product(&state, &norm).await?;
    let c = easyeda_convert::convert(&p).map_err(|e| err("PARTS_UPSTREAM", e))?;
    // Stock/price: reuse a fresh snapshot, refetch when older than the TTL (and the network is allowed).
    let meta = crate::parts_cache::read_meta(&norm);
    let fresh = meta
        .as_ref()
        .and_then(crate::parts_cache::meta_age_secs)
        .map(|age| age < crate::parts_cache::META_TTL_SECS)
        .unwrap_or(false);
    let stock = if fresh || ensure_enabled(&state).is_err() {
        crate::parts_cache::search_row(&norm)
    } else {
        catalogue_row(&state, &norm).await
    };
    let cached = fresh || stock.as_ref().and_then(|r| r.get("cached")).is_some();
    let _ = crate::parts_cache::upsert_meta(&state, &norm, meta_patch(&c, stock.as_ref()));
    Ok(json!({
        "cached": cached,
        "lcsc": c.spec.lcsc,
        "mpn": c.spec.mpn,
        "manufacturer": c.manufacturer,
        "package": c.package,
        "description": c.spec.description,
        "datasheet_url": c.datasheet_url,
        "catalogue": stock,
        "cad": {
            "symbol": true,
            "footprint": c.spec.footprint.as_ref().map(|f| json!({"name": f.name, "pads": f.pads.len()})),
            "model_3d": c.model_uuid.is_some(),
        },
        "pins": pins_json(&c),
        "warnings": c.warnings,
        "claim": true,
        "source": easyeda_convert::product_url(&norm),
    }))
}

/// Download the vendor datasheet into the attachment store (sha256 handle).
pub async fn datasheet(
    state: Arc<AppState>,
    project_key: String,
    lcsc: Option<String>,
    mpn: Option<String>,
) -> Result<Value, IpcError> {
    let lcsc = match lcsc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(l) => easyeda_convert::normalize_lcsc(l),
        None => {
            let m = mpn
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| err("BAD_CONFIG", "parts.datasheet needs lcsc or mpn"))?;
            // A cached part with this MPN needs no catalogue round trip.
            let hit = state
                .db
                .lock()
                .parts_cache_list(Some(m))
                .unwrap_or_default()
                .into_iter()
                .find(|r| {
                    r.get("mpn")
                        .and_then(|v| v.as_str())
                        .map(|s| s.eq_ignore_ascii_case(m))
                        .unwrap_or(false)
                })
                .and_then(|r| {
                    r.get("lcsc")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                });
            if let Some(h) = hit {
                h
            } else {
                ensure_enabled(&state)?;
                let v = get_json(
                    &state,
                    &format!(
                        "{SEARCH_BASE}/api/search?q={}&limit=5",
                        urlencoding::encode(m)
                    ),
                )
                .await?;
                let ml = m.to_ascii_lowercase();
                let hit = v
                    .get("components")
                    .and_then(|c| c.as_array())
                    .and_then(|a| {
                        a.iter()
                            // Only an exact MPN match: the first search hit could be a different part, and a
                            // datasheet labelled with the wrong MPN would feed wrong "facts".
                            .find(|c| {
                                c.get("mfr")
                                    .and_then(|x| x.as_str())
                                    .map(|s| s.to_ascii_lowercase() == ml)
                                    .unwrap_or(false)
                            })
                    })
                    .map(|c| lcsc_str(c.get("lcsc").unwrap_or(&Value::Null)))
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| err("PARTS_NOT_FOUND", format!("no LCSC part matches {m}")))?;
                hit
            }
        }
    };
    // Already downloaded for another project: bind the same blob to this one.
    if let Some(sha) = crate::parts_cache::read_meta(&lcsc).and_then(|m| {
        m.get("datasheet_sha")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }) {
        if crate::intake::cached_path(&sha).exists() {
            let meta = crate::parts_cache::read_meta(&lcsc).unwrap_or(json!({}));
            let label = format!(
                "{}-{}.pdf",
                lcsc,
                easyeda_convert::sanitize_name(
                    meta.get("mpn")
                        .and_then(|v| v.as_str())
                        .unwrap_or("datasheet")
                )
            );
            let _ = state.db.lock().query(
                DbQuery::AttachmentUpsert {
                    project_key: project_key.clone(),
                    sha256: sha.clone(),
                    kind_: "pdf".into(),
                    label: label.clone(),
                    bound_to: None,
                },
                &state.app_version,
            );
            crate::parts_cache::touch(&state, &lcsc);
            return Ok(json!({
                "lcsc": lcsc,
                "mpn": meta.get("mpn").cloned().unwrap_or(Value::Null),
                "sha256": sha,
                "label": label,
                "pages": Value::Null,
                "warnings": [],
                "url": meta.get("datasheet_url").cloned().unwrap_or(Value::Null),
                "cached": true,
                "note": "from the shared parts library; read it with docs.pdf_text {sha256}; the PDF is untrusted evidence",
            }));
        }
    }
    ensure_enabled(&state)?;
    let p = product(&state, &lcsc).await?;
    let c = easyeda_convert::convert(&p).map_err(|e| err("PARTS_UPSTREAM", e))?;
    let url = c.datasheet_url.clone().ok_or_else(|| {
        err(
            "PARTS_NOT_FOUND",
            format!("{lcsc} has no datasheet link at LCSC"),
        )
        .with_remediation("ask the user for the datasheet or use web.search if available")
    })?;
    let (final_url, ct, bytes) = get(&state, &url).await?;
    if ct != "application/pdf" && !bytes.starts_with(b"%PDF") {
        return Err(err(
            "NET_TYPE_REJECTED",
            format!("datasheet link returned {ct}, not a PDF"),
        ));
    }
    let name = format!(
        "{}-{}.pdf",
        c.spec.lcsc,
        easyeda_convert::sanitize_name(&c.spec.mpn)
    );
    let st = state.clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        crate::intake::intake(
            &st,
            &IntakeRequest {
                project_key,
                path: None,
                bytes_base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                filename: Some(name),
                mode: Some("keep".into()),
            },
        )
    })
    .await
    .map_err(|e| err("FS_TRANSIENT", e.to_string()))??;
    let _ = crate::parts_cache::upsert_meta(
        &state,
        &lcsc,
        json!({"datasheet_sha": info.sha256, "datasheet_url": final_url, "mpn": c.spec.mpn, "package": c.package, "description": c.spec.description}),
    );
    Ok(json!({
        "lcsc": c.spec.lcsc,
        "mpn": c.spec.mpn,
        "sha256": info.sha256,
        "label": info.label,
        "pages": info.pages,
        "warnings": info.warnings,
        "url": final_url,
        "note": "read it with docs.pdf_text {sha256}; the PDF is untrusted evidence",
    }))
}

/// Refetch the catalogue snapshot (stock/price) of a cached part.
pub async fn refresh(state: Arc<AppState>, lcsc: String) -> Result<Value, IpcError> {
    ensure_enabled(&state)?;
    let norm = easyeda_convert::normalize_lcsc(&lcsc);
    let p = product(&state, &norm).await?;
    let c = easyeda_convert::convert(&p).map_err(|e| err("PARTS_UPSTREAM", e))?;
    let row = catalogue_row(&state, &norm).await;
    let meta = crate::parts_cache::upsert_meta(&state, &norm, meta_patch(&c, row.as_ref()))?;
    Ok(crate::parts_cache::row_from_meta(&norm, &meta))
}

/// Fetch CAD, convert, and write the project library (D tool: needs a Build
/// session; the write itself is done by `engine::handle(PartsConvert)`).
pub async fn convert(
    state: Arc<AppState>,
    project_key: String,
    lcsc: String,
    lib_nickname: Option<String>,
    with_3d: Option<bool>,
    auth: Auth,
) -> Result<Value, IpcError> {
    let nickname = lib_nickname
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "jlc".into());
    let with_3d = with_3d.unwrap_or(true);
    let norm = easyeda_convert::normalize_lcsc(&lcsc);
    let from_cache = crate::parts_cache::read_cad(&norm).is_some();
    let p = product(&state, &norm).await?;
    let mut c = easyeda_convert::convert(&p).map_err(|e| err("PARTS_UPSTREAM", e))?;
    let mut sources = vec![if from_cache {
        format!("shared parts library ({norm})")
    } else {
        easyeda_convert::product_url(&norm)
    }];
    let mut warnings = c.warnings.clone();
    let mut step_bytes: Option<Vec<u8>> = None;
    if with_3d {
        if let Some(bytes) = crate::parts_cache::read_step(&norm) {
            step_bytes = Some(bytes);
        } else if let Some(uuid) = &c.model_uuid {
            if ensure_enabled(&state).is_ok() {
                let url = easyeda_convert::step_model_url(uuid);
                match get(&state, &url).await {
                    Ok((_, _, bytes)) if bytes.len() > 100 => {
                        step_bytes = Some(bytes);
                        sources.push(url);
                    }
                    Ok(_) => {
                        warnings.push("3D model download was empty; footprint has no model".into())
                    }
                    Err(e) => warnings.push(format!("3D model not downloaded: {}", e.message)),
                }
            }
        } else {
            warnings.push("no 3D model in EasyEDA data".into());
        }
        if let Some(b) = &step_bytes {
            use base64::Engine as _;
            c.spec.model_step_base64 = Some(base64::engine::general_purpose::STANDARD.encode(b));
        }
    }
    // Shared library first (app data), then the project copy below.
    let shared = crate::parts_cache::store_converted(&norm, &c.spec, step_bytes.as_deref())
        .map_err(|e| err("FS_TRANSIENT", e.message))?;
    let _ = crate::parts_cache::upsert_meta(&state, &norm, meta_patch(&c, None));
    if !c.skipped.is_empty() {
        warnings.push(format!(
            "unsupported CAD shapes skipped: {}",
            c.skipped.join(", ")
        ));
    }
    let pins = pins_json(&c);
    let spec_json = serde_json::to_value(&c.spec)?;
    let footprint_name = c.spec.footprint.as_ref().map(|f| f.name.clone());
    let st = state.clone();
    let nick = nickname.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        crate::engine::handle(
            &st,
            &project_key,
            EngineRequest::PartsConvert {
                source: spec_json,
                lib_nickname: nick,
                with_3d,
            },
            auth,
        )
    })
    .await
    .map_err(|e| err("FS_TRANSIENT", e.to_string()))??;
    let mut v = serde_json::to_value(&out)?;
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let lib_id = data
        .get("lib_id")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{nickname}:{}", c.spec.name));
    let footprint = footprint_name.map(|f| format!("{nickname}:{f}"));
    if let Some(obj) = v.as_object_mut() {
        obj.insert(
            "data".into(),
            json!({
                "lib_id": lib_id,
                "footprint": footprint,
                "lcsc": c.spec.lcsc,
                "mpn": c.spec.mpn,
                "package": c.package,
                "datasheet_url": c.datasheet_url,
                "pins": pins,
                "files": data,
                "shared": shared,
                "cached": from_cache,
                "claim": true,
                "sources": sources,
                "warnings": warnings,
                "next": "lib.resolve the lib_id, compare the pin table with the datasheet (facts), then place with this exact lib_id",
            }),
        );
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_by_default_and_rows_normalise() {
        let state = AppState::for_tests();
        assert_eq!(ensure_enabled(&state).unwrap_err().code, "PARTS_DISABLED");
        let row = search_row(
            &json!({"lcsc": 14663, "mfr": "CC0603KRX7R9BB104", "package": "0603", "stock": 5, "price": "1-9:0.0106,10-:0.009", "is_basic": true}),
        );
        assert_eq!(row["lcsc"], "C14663");
        assert_eq!(row["price_usd"], 0.0106);
        assert_eq!(row["basic"], true);
        assert_eq!(lcsc_str(&json!("c2040")), "C2040");
    }

    /// Live: the second fetch of the same part comes from the shared library — proven by
    /// switching parts sourcing off (every network call would then fail with PARTS_DISABLED).
    #[test]
    #[ignore]
    fn parts_live_cache_serves_second_fetch_offline() {
        let state = AppState::for_tests();
        state.settings.write().parts.enabled = true;
        let rt = tokio::runtime::Runtime::new().unwrap();
        let first = rt.block_on(show(state.clone(), "C14663".into())).unwrap();
        assert_eq!(first["cached"], false);
        assert!(crate::parts_cache::read_cad("C14663").is_some());
        state.settings.write().parts.enabled = false;
        let second = rt.block_on(show(state.clone(), "C14663".into())).unwrap();
        assert_eq!(second["mpn"], first["mpn"]);
        let s = rt
            .block_on(search(
                state.clone(),
                Some("C14663".into()),
                None,
                None,
                None,
                None,
                None,
                Some(5),
                None,
                None,
            ))
            .unwrap();
        assert_eq!(s["source"], "cache");
        assert_eq!(s["results"][0]["cached"], true);
    }

    /// Live network check (jlcsearch + EasyEDA); `cargo test -p fluxsmith-app parts_live -- --ignored`.
    #[test]
    #[ignore]
    fn parts_live_search_and_show() {
        let state = AppState::for_tests();
        state.settings.write().parts.enabled = true;
        let rt = tokio::runtime::Runtime::new().unwrap();
        let s = rt
            .block_on(search(
                state.clone(),
                Some("ATtiny1616 SOIC-20".into()),
                None,
                None,
                None,
                None,
                None,
                Some(5),
                Some(true),
                None,
            ))
            .unwrap();
        let rows = s["results"].as_array().unwrap();
        assert!(!rows.is_empty(), "{s}");
        assert!(rows[0]["lcsc"].as_str().unwrap().starts_with('C'));
        let d = rt.block_on(show(state.clone(), "C2040".into())).unwrap();
        assert_eq!(d["mpn"], "RP2040");
        assert_eq!(d["pins"].as_array().unwrap().len(), 57);
        assert_eq!(d["cad"]["model_3d"], true);
        // STEP model download through the whitelist
        let p = rt.block_on(product(&state, "C2040")).unwrap();
        let c = easyeda_convert::convert(&p).unwrap();
        let (_, _, bytes) = rt
            .block_on(get(
                &state,
                &easyeda_convert::step_model_url(c.model_uuid.as_ref().unwrap()),
            ))
            .unwrap();
        assert!(bytes.len() > 1000, "step model {} bytes", bytes.len());
        // datasheet link is fetchable as a PDF
        let (_, ct, pdf) = rt
            .block_on(get(&state, c.datasheet_url.as_ref().unwrap()))
            .unwrap();
        assert!(pdf.starts_with(b"%PDF"), "content-type {ct}");
    }
}

// ------------------------------------------------------------------- BOM (M3)

/// `parts.bom`: BOM lines from the schematic (`sch_check::bom`) enriched with
/// the shared parts library snapshot (MPN / package / stock / price for every
/// `LCSC` property), plus an optional lock write and drift report against
/// `bom.lock.json`. No network: stock and price are the cached snapshot.
pub fn bom(
    state: &AppState,
    project_key: &str,
    write_lock: bool,
    against_lock: Option<&str>,
) -> Result<Value, IpcError> {
    let h = state.project(project_key)?;
    let tree = sch_read::read_project(&h.root_sheet)?;
    let lines0 = sch_check::bom(&tree);
    // Substitutions are recorded on the symbol (Substitute / SUBSTITUTED_PART properties).
    let mut substituted: std::collections::BTreeMap<String, String> = Default::default();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            if let Some(v) = s
                .properties
                .iter()
                .find(|(k, _)| k == "SUBSTITUTED_PART" || k == "Substitute_Of")
                .map(|(_, v)| v.clone())
            {
                substituted.insert(reference, v);
            }
        }
    }
    // Library symbols fluxsmith converted from vendor CAD carry `fluxsmith_claim`: those BOM lines
    // are a claim about a real part, not a verified fact (red line 10).
    let unverified: std::collections::BTreeSet<String> = tree
        .files
        .values()
        .flat_map(|sheet| sheet.lib_symbols.iter())
        .filter(|l| l.unverified_claim())
        .map(|l| l.id.clone())
        .collect();
    let mut lines = Vec::with_capacity(lines0.len());
    let mut with_lcsc = 0usize;
    let mut parts_total = 0usize;
    let mut findings = Vec::new();
    for l in &lines0 {
        parts_total += l.qty;
        let lcsc = l
            .lcsc
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(easyeda_convert::normalize_lcsc);
        if lcsc.is_some() {
            with_lcsc += 1;
        }
        let row = lcsc.as_deref().and_then(crate::parts_cache::search_row);
        let subst = l.refs.iter().find_map(|r| substituted.get(r).cloned());
        if let Some(s) = &subst {
            findings.push(json!({"code": "SUBSTITUTED_PART", "severity": "warning", "refs": l.refs, "message": format!("substituted part: {s}"), "origin": "engine"}));
        }
        lines.push(json!({
            "refs": l.refs,
            "qty": l.qty,
            "value": l.value,
            "footprint": l.footprint,
            "lib_id": l.lib_id,
            "dnp": l.dnp,
            "lcsc": lcsc,
            "mpn": row.as_ref().and_then(|r| r.get("mpn")).cloned().unwrap_or(Value::Null),
            "package": row.as_ref().and_then(|r| r.get("package")).cloned().unwrap_or(Value::Null),
            "stock": row.as_ref().and_then(|r| r.get("stock")).cloned().unwrap_or(Value::Null),
            "price_usd": row.as_ref().and_then(|r| r.get("price_usd")).cloned().unwrap_or(Value::Null),
            "basic": row.as_ref().and_then(|r| r.get("basic")).cloned().unwrap_or(Value::Null),
            "cached": row.is_some(),
            // `unverified`: the symbol came out of a conversion nobody checked against the
            // datasheet. `catalogue`: value/stock/price are the JLC snapshot, not measured.
            "claim": if unverified.contains(&l.lib_id) {
                "unverified"
            } else if row.is_some() {
                "catalogue"
            } else {
                ""
            },
            "substituted": subst,
        }));
    }
    let lock_doc = json!({
        "schema_version": 1,
        "written": crate::paths::now_iso(),
        "lines": lines.iter().map(|l| json!({"refs": l["refs"], "value": l["value"], "footprint": l["footprint"], "lcsc": l["lcsc"], "dnp": l["dnp"]})).collect::<Vec<_>>(),
    });
    let mut drift = Value::Null;
    if let Some(name) = against_lock.map(str::trim).filter(|s| !s.is_empty()) {
        // Only the project's own lock file is readable (no arbitrary paths).
        let file = if name == "bom.lock.json" || name == "true" || name == "lock" {
            "bom.lock.json"
        } else {
            name
        };
        if file != "bom.lock.json" {
            return Err(err("BAD_CONFIG", "against_lock must name bom.lock.json"));
        }
        let old: Value = std::fs::read(h.root.join(file))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| {
                err("BOM_LOCK_MISSING", "no bom.lock.json in this project")
                    .with_remediation("call parts.bom {lock:true} once to write it")
            })?;
        drift = json!(bom_drift(&old, &lock_doc));
    }
    if write_lock {
        crate::sidecar::write(
            &h.root,
            &SidecarWrite::BomLock {
                lock: lock_doc.clone(),
            },
        )?;
        let mut own = h.own_shas.lock();
        if let Ok(b) = std::fs::read(h.root.join("bom.lock.json")) {
            own.insert(crate::paths::sha256_hex(&b));
        }
    }
    Ok(json!({
        "lines": lines,
        "totals": {"lines": lines0.len(), "parts": parts_total, "with_lcsc": with_lcsc, "without_lcsc": lines0.len() - with_lcsc},
        "findings": findings,
        "lock_written": write_lock,
        "drift": drift,
        "claim": true,
        "note": "stock and price are the shared-library snapshot, not live; DNP lines are listed with dnp:true",
    }))
}

/// Per-reference differences between a lock and the current BOM.
pub fn bom_drift(old: &Value, new: &Value) -> Vec<Value> {
    fn by_ref(doc: &Value) -> std::collections::BTreeMap<String, (String, String, String)> {
        let mut m = std::collections::BTreeMap::new();
        for l in doc
            .get("lines")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let s = |k: &str| l.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            for r in l
                .get("refs")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(r) = r.as_str() {
                    m.insert(r.to_string(), (s("value"), s("footprint"), s("lcsc")));
                }
            }
        }
        m
    }
    let a = by_ref(old);
    let b = by_ref(new);
    let mut out = Vec::new();
    for (r, (v0, f0, l0)) in &a {
        match b.get(r) {
            None => out.push(json!({"ref": r, "kind": "removed"})),
            Some((v1, f1, l1)) => {
                let mut changed = Vec::new();
                if v0 != v1 {
                    changed.push(json!({"field": "value", "from": v0, "to": v1}));
                }
                if f0 != f1 {
                    changed.push(json!({"field": "footprint", "from": f0, "to": f1}));
                }
                if l0 != l1 {
                    changed.push(json!({"field": "lcsc", "from": l0, "to": l1}));
                }
                if !changed.is_empty() {
                    out.push(json!({"ref": r, "kind": "changed", "changes": changed}));
                }
            }
        }
    }
    for r in b.keys() {
        if !a.contains_key(r) {
            out.push(json!({"ref": r, "kind": "added"}));
        }
    }
    out
}

#[cfg(test)]
mod bom_tests {
    use super::*;

    #[test]
    fn drift_reports_added_removed_changed() {
        let old = json!({"lines": [{"refs": ["R1", "R2"], "value": "10k", "footprint": "0603", "lcsc": "C1"}, {"refs": ["C1"], "value": "100n", "footprint": "0603", "lcsc": "C2"}]});
        let new = json!({"lines": [{"refs": ["R1"], "value": "10k", "footprint": "0603", "lcsc": "C9"}, {"refs": ["C1"], "value": "100n", "footprint": "0603", "lcsc": "C2"}, {"refs": ["U1"], "value": "X", "footprint": "", "lcsc": ""}]});
        let d = bom_drift(&old, &new);
        let kinds: Vec<(String, String)> = d
            .iter()
            .map(|x| {
                (
                    x["ref"].as_str().unwrap().into(),
                    x["kind"].as_str().unwrap().into(),
                )
            })
            .collect();
        assert!(kinds.contains(&("R1".into(), "changed".into())));
        assert!(kinds.contains(&("R2".into(), "removed".into())));
        assert!(kinds.contains(&("U1".into(), "added".into())));
        assert_eq!(kinds.len(), 3);
    }
}
