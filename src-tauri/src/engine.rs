// SPDX-License-Identifier: Apache-2.0
//! `engine_request`: the only way the webview reaches the engine (red
//! line 14). Closed enum in, structured JSON out; D-tier variants are
//! authorised and envelope-checked here regardless of what hooks decided.

use crate::error::err;
use crate::ipc::*;
use crate::paths::{rel_to, scoped, sha256_hex};
use crate::session::{check_envelope, DAuth, EnvelopeUse};
use crate::state::{AppState, ProjectHandle};
use sch_model::{nm_to_mil, SymbolInst};
use sch_net::Netlist;
use sch_read::SheetTree;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

pub const CAP_DEFAULT: usize = 32 * 1024;
pub const CAP_READ: usize = 64 * 1024;
/// One project-wide component list, for the UI only (no model-facing tool can ask for it): it is a
/// list of lean rows, so the model-context cap that keeps `sch.read` small would only cut it apart.
pub const CAP_READ_PROJECT: usize = 512 * 1024;
pub const CAP_SUMMARY: usize = 8 * 1024;

pub fn is_d_tier(r: &EngineRequest) -> Option<&'static str> {
    match r {
        EngineRequest::Apply { .. } => Some("apply"),
        EngineRequest::SheetCreate { .. } => Some("structural"),
        EngineRequest::IntentSnapshot { .. } => Some("intent"),
        EngineRequest::PolicyWaive { .. } => Some("waiver"),
        EngineRequest::PartsConvert { .. } => Some("parts_convert"),
        _ => None,
    }
}

fn read_tree(h: &ProjectHandle) -> Result<std::sync::Arc<SheetTree>, IpcError> {
    crate::treecache::tree(&h.tree_cache, &h.root_sheet)
}

/// Resolve a sheet selector (`/`, `/child/`, or a project-relative file).
fn sheet_file(h: &ProjectHandle, tree: &SheetTree, sel: Option<&str>) -> Result<PathBuf, IpcError> {
    match sel {
        None | Some("") | Some("/") => Ok(tree.root_file.clone()),
        Some(s) => {
            if let Some(i) = tree
                .instances
                .iter()
                .find(|i| i.path == s || i.names == s || i.names == s.trim_end_matches('/'))
            {
                return Ok(i.file.clone());
            }
            let p = scoped(&h.root, s)?;
            if tree.files.contains_key(&p) {
                Ok(p)
            } else {
                // The bare "not a sheet of this project" gave the model nothing to pick from, so
                // it retried the same guess. List what the project does have, both ways of
                // addressing a sheet: the file and the hierarchical instance path.
                let files: Vec<String> = tree
                    .files
                    .keys()
                    .map(|f| crate::paths::rel_to(&h.root, f))
                    .collect();
                let paths: Vec<String> = tree.instances.iter().map(|i| i.path.clone()).collect();
                Err(err(
                    "SHEET_UNKNOWN",
                    format!("{s} is not a sheet of this project"),
                )
                .with_remediation(format!(
                    "use one of these sheet files: {}",
                    files.join(", ")
                ))
                .with_evidence(json!({"sheet_files": files, "sheet_paths": paths, "requested": s})))
            }
        }
    }
}

/// Keep the findings that belong to one sheet file, for every check family.
///
/// The three fields never line up on their own: a selector may be a uuid instance path
/// (`/234b.../d030...`), an instance names path (`/power/`) or a project-relative file, while
/// `Finding.sheet` is always the names path (`gates::finding` anchors on `inst.names`) and
/// `Finding.file` is the project-relative file `attach_files` resolved from it. So the file is
/// compared first — it is one-to-one with the requested file even when one sheet file is
/// instantiated twice — and a finding that carries no file falls back to the instance path or the
/// names path of any instance of that file. A finding with neither field is project-wide
/// (`RAIL_SCOPE_SPLIT`) and is kept.
fn retain_sheet(tree: &SheetTree, file: &Path, findings: &mut Vec<sch_write::gates::Finding>) {
    let rel = tree.rel_file(file);
    let paths: Vec<&str> = tree
        .instances
        .iter()
        .filter(|i| i.file == file)
        .flat_map(|i| [i.path.as_str(), i.names.as_str()])
        .collect();
    findings.retain(|f| match (f.file.as_deref(), f.sheet.as_deref()) {
        (Some(ff), _) => ff == rel,
        (None, Some(s)) => paths.contains(&s),
        (None, None) => true,
    });
}

fn sheet_path_of(tree: &SheetTree, file: &Path) -> String {
    tree.instances
        .iter()
        .find(|i| i.file == file)
        .map(|i| i.path.clone())
        .unwrap_or_else(|| "/".into())
}

struct Out {
    data: Value,
    trust: &'static str,
    cap: usize,
    meta: ResponseMeta,
}

impl Out {
    fn untrusted(data: Value) -> Out {
        Out {
            data,
            trust: "untrusted",
            cap: CAP_DEFAULT,
            meta: ResponseMeta::default(),
        }
    }
    fn engine(data: Value) -> Out {
        Out {
            data,
            trust: "engine",
            cap: CAP_DEFAULT,
            meta: ResponseMeta::default(),
        }
    }
    fn cap(mut self, c: usize) -> Out {
        self.cap = c;
        self
    }
}

/// Byte cap with truncation: arrays are cut, objects keep keys but arrays
/// inside are cut, strings are cut.
fn truncate(v: &mut Value, cap: usize) -> bool {
    let size = v.to_string().len();
    if size <= cap {
        return false;
    }
    match v {
        Value::Array(a) => {
            while !a.is_empty() && v_len(a) > cap {
                let keep = (a.len() * cap / v_len(a)).max(1).min(a.len() - 1);
                a.truncate(keep);
                if keep <= 1 {
                    break;
                }
            }
        }
        Value::Object(o) => {
            let keys: Vec<String> = o.keys().cloned().collect();
            for k in keys {
                if serde_json::to_string(o).map(|s| s.len()).unwrap_or(0) <= cap {
                    break;
                }
                if let Some(inner) = o.get_mut(&k) {
                    if inner.is_array() || inner.is_object() || inner.is_string() {
                        truncate(inner, cap / 2);
                    }
                }
            }
        }
        Value::String(s) => {
            let mut end = cap.min(s.len());
            while end > 0 && !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
        }
        _ => {}
    }
    true
}

fn v_len(a: &[Value]) -> usize {
    serde_json::to_string(a).map(|s| s.len()).unwrap_or(0)
}

pub fn handle(
    state: &AppState,
    project_key: &str,
    request: EngineRequest,
    auth: Auth,
) -> Result<EngineResponse, IpcError> {
    let start = Instant::now();
    let h = state.project(project_key)?;
    let mut out = match dispatch(state, &h, &request, &auth) {
        Ok(o) => o,
        Err(e) => {
            // One choke point for every engine error: no host-absolute paths reach the model, and
            // a missing sheet says what creates it (crate::error::localize).
            let e = crate::error::localize(e, &h.root);
            crate::log::write(
                "warn",
                &format!(
                    "engine_request {} failed: {} {}",
                    request_kind(&request),
                    e.code,
                    e.message
                ),
                &e.req_id,
            );
            return Ok(EngineResponse {
                ok: false,
                data: Value::Null,
                error: Some(e),
                meta: ResponseMeta {
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    trust: "engine".into(),
                    ..Default::default()
                },
            });
        }
    };
    // Serialise once: the cap check used to stringify the payload twice (inside `truncate` and
    // again for `meta.bytes`) on top of Tauri's own IPC serialisation -- for a multi-MB render
    // that was two throwaway copies per request.
    let mut bytes = serde_json::to_vec(&out.data).map(|v| v.len()).unwrap_or(0);
    let truncated = if bytes > out.cap {
        let t = truncate(&mut out.data, out.cap);
        bytes = serde_json::to_vec(&out.data).map(|v| v.len()).unwrap_or(0);
        t
    } else {
        false
    };
    let mut meta = out.meta;
    meta.bytes = bytes;
    meta.truncated = truncated;
    if truncated && meta.hint.is_none() {
        meta.hint = Some("result truncated: use match/limit/sheet to narrow the query".into());
    }
    meta.elapsed_ms = start.elapsed().as_millis() as u64;
    meta.trust = out.trust.into();
    Ok(EngineResponse {
        ok: true,
        data: out.data,
        error: None,
        meta,
    })
}

fn request_kind(r: &EngineRequest) -> String {
    serde_json::to_value(r)
        .ok()
        .and_then(|v| {
            v.get("kind")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}

fn dispatch(
    state: &AppState,
    h: &ProjectHandle,
    req: &EngineRequest,
    auth: &Auth,
) -> Result<Out, IpcError> {
    use EngineRequest as R;
    match req {
        R::Summary { sheet } => summary(h, sheet.as_deref()),
        R::Read {
            sheet,
            r#match,
            limit,
            all_sheets,
        } => {
            if all_sheets.unwrap_or(false) {
                read_all_sheets(h, r#match.as_deref(), limit.unwrap_or(200))
            } else {
                read(
                    h,
                    sheet.as_deref(),
                    r#match.as_deref(),
                    limit.unwrap_or(200),
                )
            }
        }
        R::Nets {
            sheet,
            r#match,
            limit,
        } => nets(
            h,
            sheet.as_deref(),
            r#match.as_deref(),
            limit.unwrap_or(200),
        ),
        R::Net { name } => net(h, name),
        R::Component { reference, unit } => component(h, reference, *unit),
        R::Pins {
            lib_id,
            at_mil,
            rotation,
            mirror,
            unit,
        } => pins(
            h,
            lib_id,
            *at_mil,
            *rotation,
            mirror.as_deref(),
            unit.unwrap_or(1),
        ),
        R::Bbox { refs, region_mil } => bbox(h, refs.clone().unwrap_or_default(), *region_mil),
        R::Geom { sheet } => {
            let tree = read_tree(h)?;
            let sp = tree
                .instances
                .iter()
                .find(|i| i.path == *sheet || i.names == *sheet)
                .map(|i| i.path.clone())
                .unwrap_or_else(|| sheet.clone());
            let g = sch_geom::sheet_geometry(&tree, &sp)
                .ok_or_else(|| err("SHEET_UNKNOWN", sheet.clone()))?;
            Ok(Out::untrusted(serde_json::to_value(g)?).cap(16 * 1024 * 1024))
        }
        R::Render { sheet } => {
            let tree = read_tree(h)?;
            let sp = tree
                .instances
                .iter()
                .find(|i| i.path == *sheet || i.names == *sheet)
                .map(|i| i.path.clone())
                .unwrap_or_else(|| sheet.clone());
            let v = crate::treecache::render(&h.tree_cache, &h.root_sheet, &sp)?
                .ok_or_else(|| err("SHEET_UNKNOWN", sheet.clone()))?;
            Ok(Out::untrusted((*v).clone()).cap(64 * 1024 * 1024))
        }
        R::NetMap { sheet } => {
            let tree = read_tree(h)?;
            let inst = tree
                .instances
                .iter()
                .find(|i| i.path == *sheet || i.names == *sheet)
                .ok_or_else(|| err("SHEET_UNKNOWN", sheet.clone()))?;
            let (nets, map) = sch_net::build_nets_with_map(&tree);
            let pins: BTreeMap<String, String> = nets
                .pin_map()
                .into_iter()
                .filter(|(m, _)| m.sheet == inst.names)
                .map(|(m, n)| (format!("{}.{}", m.reference, m.pin), n))
                .collect();
            let v = serde_json::json!({
                "sheet": inst.path,
                "wires": map.wires.get(&inst.path).cloned().unwrap_or_default(),
                "labels": map.labels.get(&inst.path).cloned().unwrap_or_default(),
                // Sheet pins of the sheet symbols drawn on this sheet (canvas hover / net highlight).
                "sheet_pins": map.sheet_pins.get(&inst.path).cloned().unwrap_or_default(),
                // Junctions / no-connect flags, so hovering one reads out its net instead of just its kind.
                "junctions": map.junctions.get(&inst.path).cloned().unwrap_or_default(),
                "no_connects": map.no_connects.get(&inst.path).cloned().unwrap_or_default(),
                "pins": pins,
            });
            Ok(Out::untrusted(v).cap(16 * 1024 * 1024))
        }
        R::RenderPreview { preview_id, sheet } => {
            Ok(Out::untrusted(render_preview(h, preview_id, sheet)?).cap(64 * 1024 * 1024))
        }
        R::Bytes { sheet } => {
            let tree = read_tree(h)?;
            let f = sheet_file(h, &tree, Some(sheet))?;
            let s = std::fs::read_to_string(&f).map_err(|e| crate::error::io_err(&f, e))?;
            Ok(
                Out::untrusted(json!({"file": rel_to(&h.root, &f), "text": s}))
                    .cap(64 * 1024 * 1024),
            )
        }
        R::LibSearch {
            query,
            lib_id,
            category,
            pins,
            limit,
        } => {
            let building = state.libindex.building();
            let started = std::time::Instant::now();
            let db = state.db.lock();
            let lock_wait = started.elapsed();
            let (rows, total) = db.symbol_search(
                query.as_deref(),
                lib_id.as_deref(),
                category.as_deref(),
                *pins,
                limit.unwrap_or(20),
            )?;
            if started.elapsed().as_millis() > 500 {
                crate::log::warn(&format!(
                    "lib_search slow: {} ms (db lock wait {} ms, index building {})",
                    started.elapsed().as_millis(),
                    lock_wait.as_millis(),
                    building
                ));
            }
            let count = db.symbol_count();
            drop(db);
            if count == 0 {
                let code = if building {
                    "SYMBOL_INDEX_BUILDING"
                } else {
                    "SYMBOL_INDEX_EMPTY"
                };
                return Err(err(code, "the symbol index is not ready")
                    .with_evidence(json!({"progress": state.libindex.progress()}))
                    .with_remediation(
                        "wait for the index or rebuild it in Settings > Environment",
                    ));
            }
            Ok(Out::untrusted(
                json!({"results": rows, "total": total, "index_state": if building { "building" } else { "ready" }}),
            ))
        }
        R::LibResolve { lib_id } => {
            let tree = read_tree(h)?;
            let in_cache = tree.files.values().any(|s| s.lib_symbol(lib_id).is_some());
            if in_cache {
                return Ok(Out::engine(
                    json!({"state": "cache", "source": "lib_symbols"}),
                ));
            }
            let mut eng = h.engine.lock();
            match eng.lib.resolve(lib_id) {
                Some(s) => {
                    let nick = lib_id.split(':').next().unwrap_or("");
                    let src = eng
                        .lib
                        .rows
                        .iter()
                        .find(|r| r.nickname == nick)
                        .map(|r| r.uri.clone());
                    Ok(Out::engine(
                        json!({"state": "table", "source": src, "units": s.unit_count, "pins": s.pins.len()}),
                    ))
                }
                None => Ok(Out::engine(json!({"state": "none"}))),
            }
        }
        R::LibSymbol { lib_id } => {
            let tree = read_tree(h)?;
            let sym = tree
                .files
                .values()
                .find_map(|s| s.lib_symbol(lib_id).cloned())
                .or_else(|| h.engine.lock().lib.resolve(lib_id));
            let s = sym.ok_or_else(|| {
                err(
                    "SYMBOL_NOT_FOUND",
                    format!("{lib_id} not found in cache or library table"),
                )
                .with_remediation("use lib.search to find the exact lib_id")
            })?;
            Ok(Out::untrusted(json!({
                "lib_id": s.id, "units": s.unit_count, "is_power": s.is_power, "extends": s.extends,
                "default_footprint": s.property("Footprint").unwrap_or(""),
                "description": s.property("Description").unwrap_or(""),
                "pins": s.pins.iter().map(|p| json!({"number": p.number, "name": p.name, "type": p.kind.as_str(), "unit": p.unit, "x_mil": nm_to_mil(p.at.x), "y_mil": nm_to_mil(p.at.y), "angle": p.angle})).collect::<Vec<_>>()
            })))
        }
        R::OpsList {} => Ok(Out::engine(
            json!({"core": sch_ops::CORE_OPS, "macros": sch_ops::MACRO_OPS, "protocol_version": sch_ops::PROTOCOL_VERSION}),
        )),
        R::OpsTemplate { op, required_only } => {
            // The message used to be the bad name and nothing else, so the only way out was a
            // second call to ops.list. Ship the nearest names and the whole vocabulary here:
            // the retry after this error is the corrected one.
            let t = sch_ops::template(op, required_only.unwrap_or(false)).ok_or_else(|| {
                err(
                    "OP_UNKNOWN",
                    format!(
                        "`{op}` is not an op in protocol {}",
                        sch_ops::PROTOCOL_VERSION
                    ),
                )
                .with_remediation(sch_ops::unknown_op_remediation(op))
                .with_evidence(json!({
                    "candidates": sch_ops::nearest_ops(op),
                    "core": sch_ops::CORE_OPS,
                    "macros": sch_ops::MACRO_OPS,
                }))
            })?;
            Ok(Out::engine(t))
        }
        R::OpsValidate { oplist } => {
            let list = parse_oplist(oplist)?;
            match sch_ops::expand(&list) {
                // Warnings (unknown fields the parser ignored) do not fail the op-list, but the
                // caller has to see them: a silently dropped field is how a model ends up with
                // an unwired circuit and no idea why.
                Ok(ex) => Ok(Out::engine(
                    json!({"ok": true, "errors": [], "warnings": ex.warnings}),
                )),
                Err(errs) => Ok(Out::engine(
                    json!({"ok": false, "errors": errs, "warnings": []}),
                )),
            }
        }
        R::OpsExpand { oplist } => {
            let list = parse_oplist(oplist)?;
            let ex = sch_ops::expand(&list)
                .map_err(|e| err("OPLIST_SCHEMA", "op-list invalid").with_evidence(json!(e)))?;
            Ok(Out::engine(
                json!({"expanded": ex.ops.iter().map(|o| json!({"authored_index": o.authored_index, "sheet": o.sheet, "op": o.op.name(), "detail": o.op})).collect::<Vec<_>>(), "mapping": ex.mapping, "warnings": ex.warnings}),
            ))
        }
        R::DryrunScratch { oplist, target } => {
            let r = plan(state, h, oplist, target, false, None)?;
            let (split, merge, created, removed) = r.net_diff.summary();
            Ok(Out::engine(
                json!({"per_op": r.per_op, "integrity": r.integrity_introduced, "net_diff_summary": {"split": split, "merge": merge, "created": created, "removed": removed, "has_risk": r.net_diff.has_risk}, "refusal": r.refusal}),
            ))
        }
        R::Plan {
            oplist,
            target,
            flat,
        } => {
            let r = plan(state, h, oplist, target, flat.unwrap_or(false), None)?;
            let preview = store_preview(h, &r)?;
            let mut v = draw_result_json(h, &r);
            v["applied"] = json!(false);
            v["preview"] = preview;
            let mut o = Out::engine(v).cap(CAP_READ);
            o.meta.ops_sha256 = Some(r.authored_sha256.clone());
            Ok(o)
        }
        R::Apply {
            oplist,
            target,
            expected_merges,
            note,
            waived,
            strict_layout,
        } => apply(
            state,
            h,
            auth,
            oplist,
            target,
            expected_merges,
            note,
            waived.as_ref(),
            strict_layout.unwrap_or(true),
        ),
        R::Check { family, sheet } => check(state, h, family, sheet.as_deref()),
        R::GateRun {} => gate_run(state, h),
        R::DiffNets { before, after } => diff_nets(state, h, before, after.as_deref()),
        R::ProjectCheck {} => {
            let tree = read_tree(h)?;
            let mut eng = h.engine.lock();
            let mut f = sch_check::project(&tree, &mut eng.lib);
            f.extend(project_name_check(h, &tree));
            Ok(Out::engine(json!(f)))
        }
        R::Bom {} => {
            let tree = read_tree(h)?;
            Ok(Out::untrusted(json!(sch_check::bom(&tree))))
        }
        R::IntentSnapshot { note } => {
            let d = state.sessions.lock().authorize_d(&h.key, auth, "intent")?;
            let tree = read_tree(h)?;
            let nets = sch_net::build_nets(&tree);
            let intent = sch_check::intent_snapshot(&nets, note);
            let p = h.root.join("intent.json");
            let prev: Option<sch_check::Intent> = std::fs::read(&p)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            let bytes = serde_json::to_string_pretty(&intent)?;
            let depth = crate::sidecar::read_project_config(&h.root)
                .ok()
                .and_then(|c| c["backup_depth"].as_u64())
                .unwrap_or(3) as usize;
            let prep = sch_write::atomic::prepare(&p, bytes.as_bytes(), None, depth)
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            prep.commit()
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            h.own_shas.lock().insert(sha256_hex(bytes.as_bytes()));
            let diff = prev.map(|pv| intent_diff(&pv, &intent));
            journal(
                h,
                json!({"kind": "intent_snapshot", "note": note, "auth": auth_kind(&d), "nets": intent.nets.len()}),
            )?;
            Ok(Out::engine(
                json!({"written": "intent.json", "nets": intent.nets.len(), "diff": diff}),
            ))
        }
        R::SheetCreate {
            file,
            name,
            at_mil,
            size_mil,
            pins,
            paper,
            parent,
        } => {
            let pins: Vec<Value> = pins
                .iter()
                .map(|p| {
                    let o = p.as_object().cloned().unwrap_or_default();
                    let kind = o.get("kind").or_else(|| o.get("type")).cloned().unwrap_or(json!("passive"));
                    let mut pin = json!({"name": o.get("name").cloned().unwrap_or(json!("")), "type": kind, "side": o.get("side").cloned().unwrap_or(json!("left"))});
                    if let Some(off) = o.get("offset_mil").or_else(|| o.get("offset")) {
                        pin["offset_mil"] = off.clone();
                    }
                    pin
                })
                .collect();
            let mut op = json!({"op": "add_sheet", "name": name, "file": file, "at": at_mil, "size": size_mil, "pins": pins, "create": true});
            // `paper` is the page size of the file being created; an existing child keeps its own.
            if let Some(p) = paper.as_deref().filter(|p| !p.is_empty()) {
                op["paper"] = json!(p);
            }
            let oplist = json!({"protocol_version": sch_ops::PROTOCOL_VERSION, "ops": [op]});
            // The sheet symbol is drawn on the parent sheet, which is the root only by default: a
            // nested sheet names the sheet it hangs under (file, instance path or names path).
            let target = match parent.as_deref().filter(|p| !p.is_empty()) {
                Some(sel) => {
                    let tree = read_tree(h)?;
                    rel_to(&h.root, &sheet_file(h, &tree, Some(sel))?)
                }
                None => rel_to(&h.root, &h.root_sheet),
            };
            apply(
                state,
                h,
                auth,
                &oplist,
                &target,
                &[],
                &format!("sheet.create {name}"),
                None,
                true,
            )
        }
        R::Resolve { refs } => resolve(h, refs),
        R::PolicyRead {} => Ok(Out::engine(
            crate::sidecar::read_project_config(&h.root).unwrap_or(json!({})),
        )),
        R::PolicyWaive {
            code,
            refs,
            severity,
            reason,
            expires,
        } => {
            let d = state.sessions.lock().authorize_d(&h.key, auth, "waiver")?;
            let DAuth::Grant(grant) = &d else {
                return Err(err(
                    "GRANT_INVALID",
                    "waivers require an approved waiver card",
                ));
            };
            // The grant repeats the batch the human ticked (`grant_create` checked that it hashes to
            // the recorded consent): this waiver has to be one of its rows, with the same reason and
            // expiry. A batch of n findings is n single-use grants of one consent, each still bound
            // to that list, so an extra `policy_waive` on a finding nobody ticked is refused.
            waiver_is_consented(
                grant.action.as_ref(),
                code,
                refs.as_deref(),
                reason,
                expires,
            )?;
            if reason.trim().is_empty() {
                return Err(err("BAD_CONFIG", "a waiver needs a reason"));
            }
            // An Error is a KiCad-red condition: it is fixed, never waived (red line 6: the harness and the
            // human do not overrule the engine's correctness verdict by hiding it).
            if severity
                .as_deref()
                .map(|s| s.eq_ignore_ascii_case("error"))
                .unwrap_or(false)
                && (expires.is_none() || reason.trim().len() < 12)
            {
                // An Error is a KiCad-red condition: waived only as an explicit, time-bound decision (an
                // expiry and a written reason), never by a one-click default.
                return Err(err(
                    "WAIVER_SEVERITY",
                    "an Error finding is waived only with an expiry date and a written reason",
                )
                .with_remediation("fix it (Fix selected), or waive it with `expires` and a reason of at least 12 characters"));
            }
            // A waiver names what it hides: at least one ref (or a location) so it never blankets a code project-wide.
            let refs_v: Vec<String> = refs
                .clone()
                .unwrap_or_default()
                .into_iter()
                .filter(|r| !r.trim().is_empty())
                .collect();
            if refs_v.is_empty() {
                return Err(err(
                    "WAIVER_SCOPE",
                    "a waiver must name the parts or location it applies to",
                )
                .with_remediation("pass refs (designators or the finding location)"));
            }
            // No expiry given: 90 days, so a forgotten waiver resurfaces.
            let expires = expires.clone().or_else(|| {
                let now = crate::paths::now_iso();
                now.get(0..10).and_then(|d| {
                    let mut it = d.split('-');
                    let y: i64 = it.next()?.parse().ok()?;
                    let m: i64 = it.next()?.parse().ok()?;
                    let day: i64 = it.next()?.parse().ok()?;
                    // 90 days ahead, approximated by calendar months of 30 days (good enough for an expiry).
                    let total = y * 360 + (m - 1) * 30 + (day - 1) + 90;
                    Some(format!(
                        "{:04}-{:02}-{:02}T00:00:00Z",
                        total / 360,
                        (total % 360) / 30 + 1,
                        (total % 30) + 1
                    ))
                })
            });
            let refs = &Some(refs_v);
            let expires = &expires;
            let mut cfg = crate::sidecar::read_project_config(&h.root).unwrap_or(json!({}));
            let mut list = cfg
                .get("waiver")
                .and_then(|w| w.as_array())
                .cloned()
                .unwrap_or_default();
            let record = json!({"code": code, "refs": refs.clone().unwrap_or_default(), "severity": severity, "reason": reason, "expires": expires, "granted": crate::paths::now_iso()});
            // One waiver per (code, refs): waiving the same finding again — a retry after a partial
            // failure, or a new expiry for a decision already taken — replaces the record instead of
            // appending a second `[[waiver]]` row that says the same thing. The webview puts a
            // location-only finding's location in `refs` (`waiverRefs`), so that case is covered too.
            let key = waiver_key(&record);
            match list.iter().position(|w| waiver_key(w) == key) {
                Some(i) => list[i] = record,
                None => list.push(record),
            }
            cfg["waiver"] = Value::Array(list);
            let s = toml::to_string_pretty(&cfg).map_err(|e| err("BAD_CONFIG", e.to_string()))?;
            let p = h.root.join("fluxsmith.toml");
            let prep = sch_write::atomic::prepare(&p, s.as_bytes(), None, 3)
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            prep.commit()
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            h.own_shas.lock().insert(sha256_hex(s.as_bytes()));
            journal(
                h,
                json!({"kind": "policy_waive", "code": code, "reason": reason}),
            )?;
            Ok(Out::engine(
                json!({"written": "fluxsmith.toml", "waivers": cfg["waiver"].as_array().map(|a| a.len()).unwrap_or(0)}),
            ))
        }
        R::PartsConvert {
            source,
            lib_nickname,
            with_3d,
        } => parts_convert(state, h, auth, source, lib_nickname, *with_3d),
    }
}

/// Refs as a set: order and duplicates never made two waivers different decisions.
fn ref_set<'a>(refs: impl IntoIterator<Item = &'a str>) -> std::collections::BTreeSet<String> {
    refs.into_iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
        .map(|r| r.to_string())
        .collect()
}

/// Is this waiver one the human consented to? The grant's `action.waive` is the batch the review
/// card (or the findings panel) recorded the consent event over — `commands.rs grant_create` has
/// already checked that it hashes to that event, so a request naming a finding outside it, or a
/// different reason or expiry, is a waiver nobody approved. A grant without the field is one the
/// older card shape created and is left to the checks below (severity, scope, reason).
fn waiver_is_consented(
    action: Option<&Value>,
    code: &str,
    refs: Option<&[String]>,
    reason: &str,
    expires: &Option<String>,
) -> Result<(), IpcError> {
    let Some(w) = action.and_then(|a| a.get("waive")) else {
        return Ok(());
    };
    let refused = |what: &str| {
        Err(err(
            "CONSENT_MISMATCH",
            format!("this waiver is not the decision that was approved: {what}"),
        )
        .with_remediation("answer the waiver card again"))
    };
    if w.get("reason").and_then(|r| r.as_str()).unwrap_or_default() != reason {
        return refused("reason");
    }
    let approved_expiry = w.get("expires").and_then(|e| e.as_str());
    if approved_expiry != expires.as_deref() {
        return refused("expiry");
    }
    let wanted = ref_set(refs.unwrap_or(&[]).iter().map(|s| s.as_str()));
    let listed = w
        .get("findings")
        .and_then(|f| f.as_array())
        .map(|a| a.as_slice())
        .unwrap_or_default();
    let hit = listed.iter().any(|f| {
        f.get("code").and_then(|c| c.as_str()) == Some(code)
            && ref_set(
                f.get("refs")
                    .and_then(|r| r.as_array())
                    .map(|a| a.as_slice())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|x| x.as_str()),
            ) == wanted
    });
    if hit {
        Ok(())
    } else {
        refused(code)
    }
}

/// What makes two `[[waiver]]` records the same decision: the code plus the set of refs it names
/// (order and duplicates do not matter — a waiver hides a set of places, not a list).
fn waiver_key(w: &Value) -> (String, std::collections::BTreeSet<String>) {
    let code = w
        .get("code")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    let refs = w
        .get("refs")
        .and_then(|r| r.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    (code, refs)
}

fn auth_kind(d: &DAuth) -> &'static str {
    match d {
        DAuth::Session(_) => "build_session",
        DAuth::Grant(_) => "grant",
    }
}

fn parse_oplist(v: &Value) -> Result<sch_ops::OpList, IpcError> {
    sch_ops::OpList::from_value(v.clone()).map_err(|e| {
        err("OPLIST_SCHEMA", e.message.clone()).with_remediation(
            "fix the field named in the message; ops.template shows the expected shape of each op",
        )
    })
}

fn journal(h: &ProjectHandle, mut entry: Value) -> Result<(), IpcError> {
    entry["ts"] = json!(crate::paths::now_iso());
    crate::sidecar::journal_append(&h.root, &entry)
}

// ------------------------------------------------------------------ reads

fn refdes_ranges(tree: &SheetTree) -> BTreeMap<String, Value> {
    let mut by_prefix: BTreeMap<String, BTreeSet<u32>> = BTreeMap::new();
    for s in tree.files.values().flat_map(|s| s.symbols.iter()) {
        if s.reference.starts_with('#') {
            continue;
        }
        let idx = s
            .reference
            .find(|c: char| c.is_ascii_digit())
            .unwrap_or(s.reference.len());
        let (p, n) = s.reference.split_at(idx);
        if let Ok(n) = n.parse::<u32>() {
            by_prefix.entry(p.to_string()).or_default().insert(n);
        }
    }
    by_prefix
        .into_iter()
        .map(|(p, set)| {
            let mut ranges: Vec<[u32; 2]> = Vec::new();
            for n in &set {
                match ranges.last_mut() {
                    Some(r) if r[1] + 1 == *n => r[1] = *n,
                    _ => ranges.push([*n, *n]),
                }
            }
            let next = set.iter().max().map(|m| m + 1).unwrap_or(1);
            (p, json!({"used": ranges, "next": next}))
        })
        .collect()
}

fn summary(h: &ProjectHandle, sheet: Option<&str>) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    let file = sheet_file(h, &tree, sheet)?;
    let cfg = crate::sidecar::read_project_config(&h.root).unwrap_or(json!({}));
    let mut rails: BTreeSet<String> = cfg["rails"]["names"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    for n in &nets.nets {
        if sch_check::looks_like_rail(&n.name) {
            rails.insert(n.name.clone());
        }
    }
    let mut units: BTreeMap<String, Value> = BTreeMap::new();
    for s in tree.files.values().flat_map(|s| s.symbols.iter()) {
        if s.reference.starts_with('#') {
            continue;
        }
        let total = tree
            .files
            .values()
            .find_map(|f| f.lib_symbol(&s.lib_id))
            .map(|l| l.unit_count)
            .unwrap_or(1);
        if total > 1 {
            let e = units
                .entry(s.reference.clone())
                .or_insert(json!({"placed": [], "total": total}));
            if let Some(a) = e["placed"].as_array_mut() {
                if !a.iter().any(|u| u.as_u64() == Some(s.unit as u64)) {
                    a.push(json!(s.unit));
                }
            }
        }
    }
    let counts: BTreeMap<String, Value> = tree
        .files
        .iter()
        .map(|(p, s)| (rel_to(&h.root, p), json!({"symbols": s.symbols.len(), "wires": s.wires.len(), "labels": s.labels.len(), "sheets": s.sheets.len(), "paper": s.paper})))
        .collect();
    let data = json!({
        "root": rel_to(&h.root, &tree.root_file),
        "sheet": rel_to(&h.root, &file),
        "sheets": tree.instances.iter().map(|i| json!({"path": i.path, "file": rel_to(&h.root, &i.file)})).collect::<Vec<_>>(),
        "counts": counts,
        "nets": nets.nets.len(),
        "named_nets": nets.named().count(),
        "refdes": refdes_ranges(&tree),
        "rails": rails,
        "units": units,
        "detail_via": "sch.read / sch.nets / sch.component",
    });
    Ok(Out::untrusted(data).cap(CAP_SUMMARY))
}

fn sym_json(root: &Path, file: &Path, s: &SymbolInst) -> Value {
    json!({
        "reference": s.reference, "lib_id": s.lib_id, "value": s.value, "footprint": s.footprint, "unit": s.unit,
        "x_mil": nm_to_mil(s.placement.at.x), "y_mil": nm_to_mil(s.placement.at.y), "rotation": s.placement.rot.deg(),
        "mirror": format!("{:?}", s.placement.mirror).to_lowercase(), "dnp": s.dnp, "in_bom": s.in_bom, "on_board": s.on_board,
        "uuid": s.uuid, "sheet": rel_to(root, file),
    })
}

fn matches(m: Option<&str>, hay: &[&str]) -> bool {
    match m {
        None => true,
        Some(m) => {
            let m = m.to_lowercase();
            hay.iter().any(|h| h.to_lowercase().contains(&m))
        }
    }
}

fn read(
    h: &ProjectHandle,
    sheet: Option<&str>,
    m: Option<&str>,
    limit: u32,
) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let file = sheet_file(h, &tree, sheet)?;
    let s = tree.sheet(&file).unwrap();
    let limit = limit.clamp(1, 2000) as usize;
    let symbols: Vec<Value> = s
        .symbols
        .iter()
        .filter(|x| matches(m, &[&x.reference, &x.value, &x.lib_id]))
        .take(limit)
        .map(|x| sym_json(&h.root, &file, x))
        .collect();
    let labels: Vec<Value> = s.labels.iter().filter(|l| matches(m, &[&l.text])).take(limit).map(|l| json!({"uuid": l.uuid, "text": l.text, "kind": format!("{:?}", l.kind).to_lowercase(), "x_mil": nm_to_mil(l.at.x), "y_mil": nm_to_mil(l.at.y), "rotation": l.rot, "shape": l.shape})).collect();
    let wires: Vec<Value> = if m.is_none() {
        s.wires.iter().take(limit).map(|w| json!({"from": [nm_to_mil(w.a.x), nm_to_mil(w.a.y)], "to": [nm_to_mil(w.b.x), nm_to_mil(w.b.y)], "bus": w.is_bus})).collect()
    } else {
        vec![]
    };
    let sheets: Vec<Value> = s.sheets.iter().filter(|x| matches(m, &[&x.name, &x.file])).map(|x| json!({"name": x.name, "file": x.file, "x_mil": nm_to_mil(x.at.x), "y_mil": nm_to_mil(x.at.y), "w_mil": nm_to_mil(x.size.x), "h_mil": nm_to_mil(x.size.y), "pins": x.pins.iter().map(|p| json!({"name": p.name, "kind": p.shape})).collect::<Vec<_>>()})).collect();
    Ok(Out::untrusted(json!({
        "file": rel_to(&h.root, &file), "sheet_path": sheet_path_of(&tree, &file), "paper": s.paper, "version": s.version,
        "symbols": symbols, "labels": labels, "wires": wires, "junctions": s.junctions.len(), "no_connects": s.no_connects.len(), "sheets": sheets,
        "total": {"symbols": s.symbols.len(), "labels": s.labels.len(), "wires": s.wires.len()}
    }))
    .cap(CAP_READ))
}

/// Every sheet instance's symbols in one answer (the sidebar's "all sheets" list). Instances, not
/// files: a reused sheet is annotated per instance path, so the same symbol node is two rows with
/// two references. Rows stay lean -- the caller wants a list, not geometry.
fn read_all_sheets(h: &ProjectHandle, m: Option<&str>, limit: u32) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let limit = limit.clamp(1, 2000) as usize;
    let mut symbols: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for inst in &tree.instances {
        let Some(sheet) = tree.files.get(&inst.file) else {
            continue;
        };
        let file = rel_to(&h.root, &inst.file);
        for s in &sheet.symbols {
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            if !matches(m, &[&reference, &s.value, &s.lib_id]) {
                continue;
            }
            total += 1;
            if symbols.len() >= limit {
                continue;
            }
            symbols.push(json!({
                "reference": reference, "value": s.value, "lib_id": s.lib_id, "footprint": s.footprint,
                "unit": s.unit, "uuid": s.uuid, "sheet": file, "sheet_path": inst.names, "instance_path": inst.path,
            }));
        }
    }
    Ok(Out::untrusted(json!({
        "all_sheets": true, "symbols": symbols,
        "total": {"symbols": total}, "truncated": total > symbols.len(),
    }))
    .cap(CAP_READ_PROJECT))
}

fn net_json(n: &sch_net::Net) -> Value {
    json!({"name": n.name, "scope": format!("{:?}", n.scope).to_lowercase(), "id": n.id, "flagged": n.flagged, "members": n.members.iter().map(|m| format!("{}.{}", m.reference, m.pin)).collect::<Vec<_>>(),
        "member_count": n.members.len(), "labels": n.labels, "no_connect": n.no_connect, "sheets": n.members.iter().map(|m| m.sheet.clone()).collect::<BTreeSet<_>>()})
}

fn nets(
    h: &ProjectHandle,
    sheet: Option<&str>,
    m: Option<&str>,
    limit: u32,
) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    // Net members carry the human sheet path (`/`, `/power/`), while the UI
    // addresses sheets by file or KiCad instance path: accept both spellings.
    let accepted: Option<BTreeSet<String>> = match sheet {
        Some(s) => {
            let f = sheet_file(h, &tree, Some(s))?;
            Some(
                tree.instances
                    .iter()
                    .filter(|i| i.file == f)
                    .flat_map(|i| [i.path.clone(), i.names.clone()])
                    .collect(),
            )
        }
        None => None,
    };
    let filtered: Vec<&sch_net::Net> = nets
        .nets
        .iter()
        .filter(|n| matches(m, &[&n.name]))
        .filter(|n| {
            accepted
                .as_ref()
                .map(|set| n.members.iter().any(|mm| set.contains(&mm.sheet)))
                .unwrap_or(true)
        })
        .collect();
    let total = filtered.len();
    let list: Vec<Value> = filtered.into_iter().take(limit.clamp(1, 2000) as usize).map(|n| json!({"name": n.name, "scope": format!("{:?}", n.scope).to_lowercase(), "flagged": n.flagged, "members": n.members.len(), "sheets": n.members.iter().map(|m| m.sheet.clone()).collect::<BTreeSet<_>>()})).collect();
    let truncated = list.len() < total;
    Ok(Out::untrusted(
        json!({"nets": list, "total": total, "truncated": truncated}),
    ))
}

fn net(h: &ProjectHandle, name: &str) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    let n = nets.by_name(name).or_else(|| {
        nets.nets.iter().find(|n| {
            n.name.eq_ignore_ascii_case(name)
                || n.name.trim_start_matches('/') == name.trim_start_matches('/')
        })
    });
    match n {
        Some(n) => Ok(Out::untrusted(net_json(n))),
        None => Err(err("NET_NOT_FOUND", format!("net {name} does not exist"))
            .with_remediation("use sch.nets with match to find the name")),
    }
}

fn component(h: &ProjectHandle, reference: &str, unit: Option<u32>) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    let mut found: Vec<(PathBuf, &SymbolInst)> = Vec::new();
    for (p, s) in &tree.files {
        for sym in s.symbol_by_ref(reference) {
            if unit.map(|u| u == sym.unit).unwrap_or(true) {
                found.push((p.clone(), sym));
            }
        }
    }
    if found.is_empty() {
        return Err(err("COMPONENT_NOT_FOUND", format!("{reference} not found"))
            .with_remediation("use sch.read with match to find the reference"));
    }
    let pins = sch_check::pinmap(&tree, &nets, reference);
    let (p0, s0) = &found[0];
    let total_units = tree
        .files
        .values()
        .find_map(|f| f.lib_symbol(&s0.lib_id))
        .map(|l| l.unit_count)
        .unwrap_or(1);
    Ok(Out::untrusted(json!({
        "ref": reference, "lib_id": s0.lib_id, "value": s0.value, "footprint": s0.footprint,
        "units": found.iter().map(|(p, s)| json!({"unit": s.unit, "sheet": rel_to(&h.root, p), "sheet_path": sheet_path_of(&tree, p), "placed": true, "x_mil": nm_to_mil(s.placement.at.x), "y_mil": nm_to_mil(s.placement.at.y), "rotation": s.placement.rot.deg()})).collect::<Vec<_>>(),
        "total_units": total_units,
        "attributes": {"dnp": s0.dnp, "in_bom": s0.in_bom, "on_board": s0.on_board},
        "fields": s0.properties.iter().map(|(k, v)| json!({"name": k, "value": v})).collect::<Vec<_>>(),
        "pins": pins.iter().map(|p| json!({"unit": p.unit, "number": p.number, "name": p.name, "type": p.kind, "net": p.net, "x_mil": p.at_mil[0], "y_mil": p.at_mil[1]})).collect::<Vec<_>>(),
        "sheet": rel_to(&h.root, p0),
    })))
}

fn pins(
    h: &ProjectHandle,
    lib_id: &str,
    at_mil: [f64; 2],
    rotation: f64,
    mirror: Option<&str>,
    unit: u32,
) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let lib = tree
        .files
        .values()
        .find_map(|s| s.lib_symbol(lib_id).cloned())
        .or_else(|| h.engine.lock().lib.resolve(lib_id))
        .ok_or_else(|| err("SYMBOL_NOT_FOUND", lib_id.to_string()))?;
    let rot = sch_model::Rot::from_deg(rotation)
        .ok_or_else(|| err("OP_FIELD_TYPE", "rotation must be a multiple of 90"))?;
    let mirror = match mirror.unwrap_or("none") {
        "x" => sch_model::Mirror::X,
        "y" => sch_model::Mirror::Y,
        _ => sch_model::Mirror::None,
    };
    let inst = SymbolInst {
        uuid: String::new(),
        lib_id: lib_id.to_string(),
        placement: sch_model::Placement {
            at: sch_model::Pt::new(
                sch_model::mil_to_nm(at_mil[0]),
                sch_model::mil_to_nm(at_mil[1]),
            ),
            rot,
            mirror,
        },
        unit,
        reference: String::new(),
        value: String::new(),
        footprint: String::new(),
        dnp: false,
        in_bom: true,
        on_board: true,
        exclude_from_sim: false,
        properties: vec![],
        instances: vec![],
        node_index: 0,
    };
    let pins: Vec<Value> = sch_model::world_pins(&inst, &lib).into_iter().map(|p| json!({"number": p.number, "name": p.name, "type": p.kind.as_str(), "x_mil": nm_to_mil(p.at.x), "y_mil": nm_to_mil(p.at.y)})).collect();
    Ok(Out::engine(
        json!({"lib_id": lib_id, "unit": unit, "units": lib.unit_count, "pins": pins}),
    ))
}

fn bbox(
    h: &ProjectHandle,
    refs: Vec<String>,
    region: Option<[[f64; 2]; 2]>,
) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let mut items = Vec::new();
    let mut all = sch_geom::BBox::empty();
    for (p, s) in &tree.files {
        let doc = &tree.docs[p];
        for sym in &s.symbols {
            if !refs.is_empty() && !refs.contains(&sym.reference) {
                continue;
            }
            if let Some(b) = sch_geom::symbol_bbox(doc, sym) {
                let bm = b.to_mil();
                if let Some(r) = region {
                    let inside = bm[0][0] >= r[0][0]
                        && bm[0][1] >= r[0][1]
                        && bm[1][0] <= r[1][0]
                        && bm[1][1] <= r[1][1];
                    if !inside {
                        continue;
                    }
                }
                all.union(&b);
                items.push(
                    json!({"ref": sym.reference, "sheet": rel_to(&h.root, p), "bbox_mil": bm}),
                );
            }
        }
    }
    Ok(Out::engine(
        json!({"bbox_mil": if all.is_empty() { Value::Null } else { json!(all.to_mil()) }, "items": items}),
    ))
}

fn resolve(h: &ProjectHandle, refs: &[Value]) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    let mut out = Vec::new();
    for r in refs {
        let kind = r.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let v = match kind {
            "component" => {
                let rf = r.get("ref").and_then(|x| x.as_str()).unwrap_or("");
                let found: Vec<Value> = tree
                    .files
                    .iter()
                    .flat_map(|(p, s)| s.symbol_by_ref(rf).map(move |x| sym_json(&h.root, p, x)))
                    .collect();
                json!({"kind": "component", "ref": rf, "found": !found.is_empty(), "instances": found, "nets": sch_check::pinmap(&tree, &nets, rf).iter().filter_map(|p| p.net.clone()).collect::<BTreeSet<_>>()})
            }
            "net" => {
                let name = r.get("name").and_then(|x| x.as_str()).unwrap_or("");
                match nets.by_name(name) {
                    Some(n) => json!({"kind": "net", "found": true, "net": net_json(n)}),
                    None => json!({"kind": "net", "name": name, "found": false}),
                }
            }
            "sheet" => {
                let p = r.get("path").and_then(|x| x.as_str()).unwrap_or("/");
                match sheet_file(h, &tree, Some(p)) {
                    Ok(f) => {
                        let s = tree.sheet(&f).unwrap();
                        json!({"kind": "sheet", "found": true, "file": rel_to(&h.root, &f), "path": sheet_path_of(&tree, &f), "symbols": s.symbols.len(), "paper": s.paper})
                    }
                    Err(_) => json!({"kind": "sheet", "path": p, "found": false}),
                }
            }
            "region" => {
                let sp = r.get("sheet").and_then(|x| x.as_str()).unwrap_or("/");
                let bb = r
                    .get("bbox_mil")
                    .and_then(|b| serde_json::from_value::<[[f64; 2]; 2]>(b.clone()).ok());
                match (sheet_file(h, &tree, Some(sp)), bb) {
                    (Ok(f), Some(bb)) => {
                        let s = tree.sheet(&f).unwrap();
                        let doc = &tree.docs[&f];
                        let inside: Vec<String> = s
                            .symbols
                            .iter()
                            .filter(|sym| {
                                sch_geom::symbol_bbox(doc, sym)
                                    .map(|b| {
                                        let m = b.to_mil();
                                        m[0][0] >= bb[0][0]
                                            && m[0][1] >= bb[0][1]
                                            && m[1][0] <= bb[1][0]
                                            && m[1][1] <= bb[1][1]
                                    })
                                    .unwrap_or(false)
                            })
                            .map(|sym| sym.reference.clone())
                            .collect();
                        let lbls: Vec<String> = s
                            .labels
                            .iter()
                            .filter(|l| {
                                let x = nm_to_mil(l.at.x);
                                let y = nm_to_mil(l.at.y);
                                x >= bb[0][0] && y >= bb[0][1] && x <= bb[1][0] && y <= bb[1][1]
                            })
                            .map(|l| l.text.clone())
                            .collect();
                        json!({"kind": "region", "found": true, "sheet": sp, "bbox_mil": bb, "components": inside, "labels": lbls})
                    }
                    _ => json!({"kind": "region", "found": false}),
                }
            }
            "block" => {
                let g = r.get("group").and_then(|x| x.as_str()).unwrap_or("");
                // Groups are recorded in the journal per apply; find components whose journal group matches.
                let journal =
                    crate::sidecar::read(&h.root, "journal", None, None).unwrap_or(Value::Null);
                let mut comps = BTreeSet::new();
                if let Some(a) = journal.as_array() {
                    for e in a {
                        if e.get("groups")
                            .and_then(|gg| gg.as_array())
                            .map(|gg| gg.iter().any(|x| x.as_str() == Some(g)))
                            .unwrap_or(false)
                        {
                            if let Some(c) = e.get("created_refs").and_then(|c| c.as_array()) {
                                for x in c {
                                    if let Some(s) = x.as_str() {
                                        comps.insert(s.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
                let refs: BTreeSet<String> = tree
                    .files
                    .values()
                    .flat_map(|s| s.symbols.iter())
                    .filter(|s| comps.contains(&s.uuid))
                    .map(|s| s.reference.clone())
                    .collect();
                json!({"kind": "block", "group": g, "found": !refs.is_empty(), "components": refs})
            }
            "finding" | "turn" | "attachment" => r.clone(),
            _ => json!({"kind": kind, "found": false}),
        };
        let resolved = v.get("found").and_then(|f| f.as_bool()).unwrap_or(false);
        out.push(json!({"ref": r, "resolved": resolved, "detail": v}));
    }
    Ok(Out::untrusted(json!({"resolved": out})))
}

// -------------------------------------------------------------- write path

fn draw_request(
    h: &ProjectHandle,
    oplist: &Value,
    target: &str,
    expected: &[ExpectedMergeSpec],
    note: Option<String>,
    journal: bool,
) -> Result<sch_write::DrawRequest, IpcError> {
    let list = parse_oplist(oplist)?;
    let target_p = scoped(&h.root, target)?;
    for f in list.sheets.values() {
        scoped(&h.root, f)?;
    }
    let depth = crate::sidecar::read_project_config(&h.root)
        .ok()
        .and_then(|c| c["backup_depth"].as_u64())
        .unwrap_or(3) as usize;
    Ok(sch_write::DrawRequest {
        target: target_p,
        root: Some(h.root_sheet.clone()),
        oplist: list,
        strict_nets: true,
        strict_layout: true,
        expected_merges: expected
            .iter()
            .map(|e| sch_write::ExpectedMerge {
                into: e.into.clone(),
                sources_unnamed_only: e.sources_unnamed_only,
            })
            .collect(),
        note,
        backup_depth: depth,
        journal: if journal {
            Some(h.root.join(".fluxsmith/journal.jsonl"))
        } else {
            None
        },
        expected_target_sha: None,
        run_backup_dir: Some(h.root.join(".fluxsmith/backups/runs")),
    })
}

fn plan(
    _state: &AppState,
    h: &ProjectHandle,
    oplist: &Value,
    target: &str,
    _flat: bool,
    expected: Option<&[ExpectedMergeSpec]>,
) -> Result<sch_write::DrawResult, IpcError> {
    let req = draw_request(h, oplist, target, expected.unwrap_or(&[]), None, false)?;
    let mut eng = h.engine.lock();
    let mut r = eng.plan(&req)?;
    // Layout overlap on the would-be result: evaluate previews in a temp tree.
    if let Some(overlaps) = preview_overlaps(h, &r) {
        r.layout.extend(overlaps);
    }
    Ok(r)
}

/// Copy the project's design files into a scratch directory and overlay the
/// previews (project-relative path -> sheet text); returns the tempdir and the
/// scratch root sheet so callers can read the would-be tree.
fn materialise_previews(
    h: &ProjectHandle,
    previews: &BTreeMap<String, String>,
) -> Option<(tempfile::TempDir, PathBuf)> {
    let tmp = tempfile::tempdir().ok()?;
    for f in crate::checkpoint::design_files(&h.root) {
        let rel = f.strip_prefix(&h.root).ok()?;
        let dest = tmp.path().join(rel);
        std::fs::create_dir_all(dest.parent()?).ok()?;
        std::fs::copy(&f, &dest).ok()?;
    }
    for (rel, text) in previews {
        let dest = tmp.path().join(rel);
        std::fs::create_dir_all(dest.parent()?).ok()?;
        std::fs::write(&dest, text).ok()?;
    }
    let root_rel = h.root_sheet.strip_prefix(&h.root).ok()?;
    let root = tmp.path().join(root_rel);
    Some((tmp, root))
}

/// Write previews to a scratch copy of the project and run the overlap and
/// style checks on the would-be result.
fn preview_overlaps(
    h: &ProjectHandle,
    r: &sch_write::DrawResult,
) -> Option<Vec<sch_write::gates::Finding>> {
    if r.previews.is_empty() {
        return None;
    }
    let previews: BTreeMap<String, String> = r
        .previews
        .iter()
        .map(|(p, t)| (rel_to(&h.root, p), t.clone()))
        .collect();
    let (_tmp, root) = materialise_previews(h, &previews)?;
    let tree = sch_read::read_project(&root).ok()?;
    let mut out = sch_geom::overlap_findings(&tree);
    out.extend(sch_write::gates::style(&tree));
    Some(out)
}

/// Render a stored preview (`sch.plan` handle) as a ghost layer: same shape as `Render`.
fn render_preview(h: &ProjectHandle, preview_id: &str, sheet: &str) -> Result<Value, IpcError> {
    if preview_id.is_empty() || !preview_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(err(
            "BAD_CONFIG",
            "preview_id must be a hex id from sch.plan",
        ));
    }
    let path = crate::paths::app_data_dir()
        .join("assets")
        .join(&h.key)
        .join(format!("preview-{preview_id}.json"));
    let bytes = std::fs::read(&path).map_err(|_| {
        err(
            "PREVIEW_NOT_FOUND",
            format!("no preview {preview_id} for this project"),
        )
    })?;
    let previews: BTreeMap<String, String> =
        serde_json::from_slice(&bytes).map_err(|e| err("PREVIEW_NOT_FOUND", e.to_string()))?;
    let (_tmp, root) = materialise_previews(h, &previews)
        .ok_or_else(|| err("FS_TRANSIENT", "cannot materialise the preview"))?;
    let tree = sch_read::read_project(&root)?;
    let sp = tree
        .instances
        .iter()
        .find(|i| i.path == sheet || i.names == sheet)
        .map(|i| i.path.clone())
        .unwrap_or_else(|| sheet.to_string());
    let g = sch_geom::render_sheet(&tree, &sp)
        .ok_or_else(|| err("SHEET_UNKNOWN", sheet.to_string()))?;
    Ok(serde_json::to_value(g)?)
}

fn store_preview(h: &ProjectHandle, r: &sch_write::DrawResult) -> Result<Value, IpcError> {
    let dir = crate::paths::app_data_dir().join("assets").join(&h.key);
    crate::paths::ensure_dir(&dir)?;
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut hasher_input = String::new();
    for (p, text) in &r.previews {
        hasher_input.push_str(text);
        total += text.len();
        files.push(rel_to(&h.root, p));
    }
    let id = sha256_hex(hasher_input.as_bytes())[..16].to_string();
    let path = dir.join(format!("preview-{id}.json"));
    let payload: BTreeMap<String, &String> = r
        .previews
        .iter()
        .map(|(p, t)| (rel_to(&h.root, p), t))
        .collect();
    crate::paths::write_atomic(&path, serde_json::to_string(&payload)?.as_bytes())?;
    Ok(json!({"id": id, "kind": "preview", "bytes": total, "files": files}))
}

/// How many designators an apply's `focus` carries: enough for the canvas to frame a block, not so
/// many that framing them all is the same as framing the whole sheet.
const FOCUS_REFS_MAX: usize = 40;

/// What this op-list drew, as designators: the symbols and power ports it created, then the parts
/// whose fields it changed. The canvas frames these instead of the whole sheet ("show on canvas").
/// Built only from what the engine reported; nothing is inferred here.
fn focus_json(per_op: &[sch_write::handlers::OpResult]) -> Option<Value> {
    let mut refs: Vec<String> = Vec::new();
    let mut sheet: Option<String> = None;
    let mut push = |rf: &str, on: Option<&String>| {
        if rf.is_empty() || refs.len() >= FOCUS_REFS_MAX || refs.iter().any(|x| x == rf) {
            return;
        }
        if sheet.is_none() {
            sheet = on.cloned();
        }
        refs.push(rf.to_string());
    };
    for op in per_op {
        for c in &op.created {
            if c.kind != "symbol" && c.kind != "power_port" {
                continue;
            }
            if let Some(rf) = c.reference.as_deref() {
                push(rf, c.sheet.as_ref());
            }
        }
    }
    for op in per_op {
        for c in &op.changed {
            push(&c.reference, c.sheet.as_ref());
        }
    }
    if refs.is_empty() {
        return None;
    }
    Some(json!({"refs": refs, "sheet": sheet}))
}

fn draw_result_json(h: &ProjectHandle, r: &sch_write::DrawResult) -> Value {
    let (split, merge, created, removed) = r.net_diff.summary();
    json!({
        "applied": r.applied, "run_id": r.run_id, "per_op": r.per_op, "focus": focus_json(&r.per_op),
        "integrity": r.integrity_introduced, "integrity_all": r.integrity.len(), "layout": r.layout,
        "net_diff": {"summary": {"split": split, "merge": merge, "created": created, "removed": removed}, "has_risk": r.net_diff.has_risk, "changes": net_changes_json(&r.net_diff)},
        "nets_after": r.nets, "net_count_after": r.nets_after, "counts": r.counts,
        "targets": r.targets.iter().map(|t| json!({"path": rel_to(&h.root, Path::new(&t.path)), "sha_before": t.sha_before, "sha_after": t.sha_after, "created": t.created})).collect::<Vec<_>>(),
        "authored_sha256": r.authored_sha256, "expanded_sha256": r.expanded_sha256,
        "refusal": r.refusal, "expected_merges_used": r.expected_merges_used,
        "bbox_mil": r.bbox_mil,
    })
}

#[allow(clippy::too_many_arguments)]
fn apply(
    state: &AppState,
    h: &ProjectHandle,
    auth: &Auth,
    oplist: &Value,
    target: &str,
    expected: &[ExpectedMergeSpec],
    note: &str,
    waived: Option<&WaiverRef>,
    strict_layout: bool,
) -> Result<Out, IpcError> {
    let d = state.sessions.lock().authorize_d(&h.key, auth, "apply")?;
    if crate::project::is_locked(&h.root_sheet) {
        return Err(err("TARGET_LOCKED", "the project is open in KiCad")
            .with_remediation("close it in KiCad and retry"));
    }
    let list = parse_oplist(oplist)?;
    let expanded = sch_ops::expand(&list)
        .map_err(|e| err("OPLIST_SCHEMA", "op-list invalid").with_evidence(json!(e)))?;
    let target_p = scoped(&h.root, target)?;
    let target_rel = rel_to(&h.root, &target_p);
    let sheets_rel: Vec<String> = list.sheets.values().cloned().collect();
    // Symbol uuids of the project so a `delete_object` aimed at a part counts as a component deletion.
    let tree_now = crate::treecache::tree(&h.tree_cache, &h.root_sheet);
    let symbol_uuids: BTreeSet<String> = tree_now
        .as_ref()
        .map(|t| {
            t.files
                .values()
                // Power symbols and flags are net anchors, not components: deleting one is free (mirrors placement).
                .flat_map(|s| {
                    s.symbols
                        .iter()
                        .filter(|sym| !sym.reference.starts_with('#'))
                        .map(|sym| sym.uuid.clone())
                })
                .collect()
        })
        .unwrap_or_default();
    let sheet_uuids: std::collections::BTreeMap<String, String> = tree_now
        .as_ref()
        .map(|t| {
            t.files
                .values()
                .flat_map(|s| s.sheets.iter().map(|sh| (sh.uuid.clone(), sh.file.clone())))
                .collect()
        })
        .unwrap_or_default();
    let project_files: Vec<PathBuf> = tree_now
        .as_ref()
        .map(|t| t.files.keys().cloned().collect())
        .unwrap_or_default();
    drop(tree_now);
    // Envelope + counters (session path only; grants carry their own scope).
    let mut env_sheets: Vec<String> = Vec::new();
    let used: EnvelopeUse = match &d {
        DAuth::Session(turn) => {
            let mut sess = state.sessions.lock();
            let t = sess
                .turn_mut(&h.key)
                .ok_or_else(|| err("MODE_MISMATCH", "no running turn"))?;
            if t.turn != *turn {
                return Err(err("MODE_MISMATCH", "turn changed"));
            }
            env_sheets = t.envelope.sheets.clone();
            check_envelope(
                &t.envelope,
                &t.counters,
                &expanded,
                &target_rel,
                &sheets_rel,
                &symbol_uuids,
                &sheet_uuids,
            )?
        }
        DAuth::Grant(g) => {
            // A grant unlocks exactly one op-list: its sha must match.
            let sha = sha256_hex(
                serde_json::to_string(&list.ops)
                    .unwrap_or_default()
                    .as_bytes(),
            );
            if let Some(exp) = g
                .action
                .as_ref()
                .and_then(|a| a.get("ops_sha256"))
                .and_then(|s| s.as_str())
            {
                if exp != sha {
                    return Err(err(
                        "GRANT_INVALID",
                        "grant was issued for a different op-list",
                    ));
                }
            }
            EnvelopeUse::default()
        }
    };
    // Idempotent re-send: same ops + same target bytes -> cached result.
    let ops_sha = sha256_hex(
        serde_json::to_string(&list.ops)
            .unwrap_or_default()
            .as_bytes(),
    );
    let waived_ok = match waived {
        Some(w) => {
            // A net-risk approval unlocks exactly the op-list the human saw on the card (the sha the
            // refused sch.plan reported), never "the next apply": a grant without that binding is refused.
            // Checked before consuming: a mismatch (the model edited the list after the card) keeps the
            // human's approval alive for the list they actually saw.
            let action = state.sessions.lock().grant_action(&w.grant_id);
            match action
                .as_ref()
                .and_then(|a| a.get("ops_sha256"))
                .and_then(|s| s.as_str())
            {
                Some(exp) if exp == ops_sha => {}
                Some(_) => {
                    return Err(err(
                        "GRANT_INVALID",
                        "the net-risk approval was for a different op-list",
                    )
                    .with_remediation("apply exactly the op-list the card was issued for, or re-run sch.plan and wait for a new card"));
                }
                None => {
                    return Err(err(
                        "GRANT_INVALID",
                        "the net-risk approval is not bound to an op-list",
                    ));
                }
            }
            state
                .sessions
                .lock()
                .consume_grant(&w.grant_id, &h.key, "net_risk", None)?;
            true
        }
        None => false,
    };
    let target_sha = sch_write::atomic::file_sha(&target_p).unwrap_or_default();
    if let Some(cached) = h
        .apply_cache
        .lock()
        .get(&(ops_sha.clone(), target_sha.clone()))
        .cloned()
    {
        let mut o = Out::engine(cached);
        o.meta.hint = Some("cached: identical op-list already applied to this target state".into());
        o.meta.ops_sha256 = Some(ops_sha);
        return Ok(o);
    }
    let mut req = draw_request(h, oplist, target, expected, Some(note.to_string()), true)?;
    req.strict_nets = !waived_ok;
    req.strict_layout = strict_layout;
    req.expected_target_sha = if target_sha.is_empty() {
        None
    } else {
        Some(target_sha.clone())
    };
    // Second line on the approved scope (red lines 13/14): the envelope's sheets bound the files
    // this apply may rewrite, not only the ones the op-list declares — an op can reach further than
    // its own routing (a global rename, a sheet pin seeded in a child). Files this run creates are
    // exempt: `add_sheet` is gated as a structural op above. No envelope sheets = no restriction
    // (a grant carries its own scope; an incremental ceiling may leave the list empty).
    let allowed_files: Option<BTreeSet<PathBuf>> = if env_sheets.is_empty() {
        None
    } else {
        let mut set: BTreeSet<PathBuf> = BTreeSet::new();
        set.insert(target_p.clone());
        for f in &project_files {
            let rel = rel_to(&h.root, f);
            if env_sheets
                .iter()
                .any(|e| crate::session::sheet_matches(e, &rel))
            {
                set.insert(f.clone());
            }
        }
        Some(set)
    };
    let r = {
        let mut eng = h.engine.lock();
        match &allowed_files {
            Some(a) => eng.apply_within(&req, a)?,
            None => eng.apply(&req)?,
        }
    };
    if !r.undeclared_sheets.is_empty() {
        let files: Vec<String> = r
            .undeclared_sheets
            .iter()
            .map(|p| rel_to(&h.root, Path::new(p)))
            .collect();
        return Err(err(
            "ENVELOPE_SHEET_UNDECLARED",
            format!(
                "this op-list would write {}, which the approved sheets do not include",
                files.join(", ")
            ),
        )
        .with_evidence(json!({"sheet": files[0], "sheets": files}))
        .with_remediation(
            "keep the ops on the step's own sheet (a local label is renamed per sheet), or the user widens the scope",
        ));
    }
    let mut v = draw_result_json(h, &r);
    v["mode"] = json!("build");
    v["waived"] = json!(waived_ok);
    if r.applied {
        crate::treecache::invalidate(&h.tree_cache);
        {
            let mut own = h.own_shas.lock();
            for t in &r.targets {
                own.insert(t.sha_after.clone());
            }
        }
        if let DAuth::Session(_) = d {
            let mut sess = state.sessions.lock();
            if let Some(t) = sess.turn_mut(&h.key) {
                t.counters.components_added += used.added;
                t.counters.components_deleted += used.deleted;
                t.counters.wires_added += used.wires;
                // Moves: the engine's own count (an `arrange_group` without a designator list fans out
                // only at apply time) or the pre-write count, whichever is larger. Properties: the
                // pre-write count only -- the engine's `properties_changed` also counts renamed labels
                // and title blocks, which no envelope budget covers.
                let engine_moved = (r.counts.components_moved + r.counts.transforms_changed) as u32;
                t.counters.components_moved += used.moved.max(engine_moved);
                t.counters.properties_changed += used.properties;
                for c in r.per_op.iter().flat_map(|o| o.created.iter()) {
                    if c.kind == "symbol" {
                        if let Some(rf) = &c.reference {
                            if !t.counters.refs_created.iter().any(|x| x == rf) {
                                t.counters.refs_created.push(rf.clone());
                            }
                        }
                    }
                }
                t.counters.apply_count += 1;
                v["turn"] = json!(t.turn);
            }
        }
        let sha_after = r
            .targets
            .iter()
            .find(|t| Path::new(&t.path) == target_p)
            .map(|t| t.sha_after.clone())
            .unwrap_or_default();
        h.apply_cache
            .lock()
            .insert((ops_sha.clone(), target_sha), v.clone());
        // Also cache against the post-state so a retry after success hits.
        h.apply_cache
            .lock()
            .insert((ops_sha.clone(), sha_after), v.clone());
        let created_refs: Vec<String> = r
            .per_op
            .iter()
            .flat_map(|o| {
                o.created
                    .iter()
                    .filter(|c| c.kind == "symbol")
                    .map(|c| c.uuid.clone())
            })
            .collect();
        journal(
            h,
            json!({"kind": "apply_meta", "run_id": r.run_id, "auth": auth_kind(&d), "note": note, "groups": list.groups.keys().collect::<Vec<_>>(), "created_refs": created_refs, "waived": waived_ok}),
        )?;
    }
    let mut o = Out::engine(v).cap(CAP_READ);
    o.meta.run_id = Some(r.run_id.clone());
    o.meta.ops_sha256 = Some(ops_sha);
    o.meta.stamp = Some(crate::paths::now_iso());
    Ok(o)
}

// ------------------------------------------------------------------ checks

fn project_name_check(h: &ProjectHandle, tree: &SheetTree) -> Vec<sch_write::gates::Finding> {
    let mut out = Vec::new();
    let expected = sch_write::project_name(&h.root_sheet);
    for (path, s) in tree
        .files
        .iter()
        .flat_map(|(path, sheet)| sheet.symbols.iter().map(move |s| (path, s)))
    {
        for inst in &s.instances {
            if !inst.project.is_empty() && inst.project != expected {
                out.push(sch_write::gates::Finding {
                    code: "PROJECT_NAME_MISMATCH".into(),
                    severity: sch_write::gates::Severity::Warning,
                    message: format!(
                        "{} has instances for project {:?}, expected {:?}",
                        s.reference, inst.project, expected
                    ),
                    sheet: None,
                    file: Some(tree.rel_file(path)),
                    refs: vec![s.reference.clone()],
                    at_mil: None,
                    remediation: Some(
                        "the project was renamed or copied; re-annotate in KiCad or accept".into(),
                    ),
                    evidence: Default::default(),
                    location: format!("instances:{}", s.reference),
                });
                break;
            }
        }
    }
    out
}

fn check(
    state: &AppState,
    h: &ProjectHandle,
    family: &str,
    sheet: Option<&str>,
) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    // The selector is resolved to a file, not to an instance path: `Finding.sheet` is the instance
    // *names* path (`/power/`) while `sheet_path_of` answers the uuid path, so comparing the two
    // matched nothing and every sheet-scoped check came back empty. `retain_sheet` compares in the
    // form the finding actually carries.
    let only = match sheet {
        Some(s) => Some(sheet_file(h, &tree, Some(s))?),
        None => None,
    };
    let mut findings = match family {
        "integrity" => sch_write::gates::integrity(&tree),
        // The unconnected-input warning is the pinmap error restated (`drop_duplicate_pin_findings`).
        "erc" => sch_check::drop_duplicate_pin_findings(
            sch_check::erc(&tree, &nets),
            &sch_check::pinmap_findings(&tree, &nets),
        ),
        "power" => sch_check::erc(&tree, &nets)
            .into_iter()
            .filter(|f| f.code.starts_with("ERC_POWER"))
            .collect(),
        "nets" => sch_write::gates::delivery(&tree, &nets),
        "pinmap" => sch_check::pinmap_findings(&tree, &nets),
        "intent" => {
            let p = h.root.join("intent.json");
            match std::fs::read(&p)
                .ok()
                .and_then(|b| serde_json::from_slice::<sch_check::Intent>(&b).ok())
            {
                Some(i) => sch_check::check_intent(&nets, &i),
                None => return Ok(Out::engine(json!({"skipped": "no intent.json"}))),
            }
        }
        "layout" => sch_write::gates::layout(&tree),
        "style" => sch_write::gates::style(&tree),
        "project" => {
            let mut eng = h.engine.lock();
            let mut v = sch_check::project(&tree, &mut eng.lib);
            v.extend(project_name_check(h, &tree));
            v
        }
        other => return Err(err("BAD_CONFIG", format!("unknown check family {other}"))),
    };
    if let Some(file) = &only {
        retain_sheet(&tree, file, &mut findings);
    }
    let _ = state;
    let (rows, _) = Waivers::load(h).decorate(&findings);
    Ok(Out::engine(json!(rows)))
}

/// The project's `[[waiver]]` records (`fluxsmith.toml`), read once per check run.
///
/// A waived finding is not dropped any more: it travels with `waived: true` (plus `waived_until` /
/// `waived_reason` when the record carries them) so the findings panel can say what is hidden and
/// until when, even for a waiver granted in an earlier session. It is excluded from every count and
/// never fails a gate family — that exclusion is made here, in the engine layer, so the harness
/// still never judges the circuit itself. Waivers cover the *check* families only; the write gate
/// in `sch-write` never sees them.
struct Waivers {
    records: Vec<Value>,
    now: String,
}

impl Waivers {
    fn load(h: &ProjectHandle) -> Self {
        let records = crate::sidecar::read_project_config(&h.root)
            .ok()
            .and_then(|cfg| cfg.get("waiver").and_then(|w| w.as_array()).cloned())
            .unwrap_or_default();
        Waivers {
            records,
            now: crate::paths::now_iso(),
        }
    }

    /// The unexpired waiver covering `f`, if any: same code, and — when the record names refs —
    /// one of them naming a ref or the location of the finding (`waiver_ref_matches`).
    fn covering(&self, f: &sch_write::gates::Finding) -> Option<&Value> {
        self.records.iter().find(|w| {
            let code_ok = w.get("code").and_then(|c| c.as_str()) == Some(&f.code);
            let refs_ok = match w.get("refs").and_then(|r| r.as_array()) {
                Some(r) if !r.is_empty() => r.iter().any(|x| {
                    x.as_str()
                        .map(|s| waiver_ref_matches(s, f))
                        .unwrap_or(false)
                }),
                _ => true,
            };
            let not_expired = w
                .get("expires")
                .and_then(|e| e.as_str())
                .map(|e| e > self.now.as_str())
                .unwrap_or(true);
            code_ok && refs_ok && not_expired
        })
    }

    /// `findings` serialised with their waiver decoration, plus whether each one is waived (same
    /// order). A finding with no live waiver serialises exactly as before.
    fn decorate(&self, findings: &[sch_write::gates::Finding]) -> (Vec<Value>, Vec<bool>) {
        let mut rows = Vec::with_capacity(findings.len());
        let mut waived = Vec::with_capacity(findings.len());
        for f in findings {
            let mut row = json!(f);
            let w = self.covering(f);
            if let Some(w) = w {
                row["waived"] = json!(true);
                if let Some(e) = w.get("expires").and_then(|e| e.as_str()) {
                    row["waived_until"] = json!(e);
                }
                if let Some(r) = w.get("reason").and_then(|r| r.as_str()) {
                    row["waived_reason"] = json!(r);
                }
            }
            waived.push(w.is_some());
            rows.push(row);
        }
        (rows, waived)
    }
}

/// Does one `refs` entry of a `[[waiver]]` name this finding?
///
/// A waiver is a scoped decision, so the match is by whole name, never by substring: a designator
/// matches a ref of the finding exactly, and a location matches either in full or on one of its
/// `:`-delimited segments (`decap:C1` is covered by a waiver on `C1`). The old `location.contains`
/// test made a waiver on `C1` silently hide every `C10` / `C11` finding of the same code.
fn waiver_ref_matches(s: &str, f: &sch_write::gates::Finding) -> bool {
    if s.is_empty() {
        return false;
    }
    f.refs.iter().any(|fr| fr == s) || f.location == s || f.location.split(':').any(|seg| seg == s)
}

fn gate_run(state: &AppState, h: &ProjectHandle) -> Result<Out, IpcError> {
    let tree = read_tree(h)?;
    let nets = sch_net::build_nets(&tree);
    let intent: Option<sch_check::Intent> = std::fs::read(h.root.join("intent.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let mut report = {
        let mut eng = h.engine.lock();
        sch_check::gate_run(&tree, &nets, intent.as_ref(), Some(&mut eng.lib))
    };
    let cfg = crate::sidecar::read_project_config(&h.root).unwrap_or(json!({}));
    let fail_on_warning = cfg["check"]["fail_on"].as_str() == Some("warning");
    let waivers = Waivers::load(h);
    let mut families: Vec<Value> = Vec::new();
    let mut findings: Vec<Value> = Vec::new();
    for fam in report.families.iter_mut() {
        let (rows, waived) = waivers.decorate(&fam.findings);
        // A waived finding is reported but neither counted nor allowed to fail the family: the
        // human already decided about it, with an expiry that puts it back when it runs out.
        let fail = fam.findings.iter().zip(waived.iter()).any(|(f, w)| {
            !w && (f.severity == sch_write::gates::Severity::Error
                || (fail_on_warning && f.severity == sch_write::gates::Severity::Warning))
        });
        if fam.status != "skipped" {
            fam.status = if fail { "fail".into() } else { "pass".into() };
        }
        let waived_count = waived.iter().filter(|w| **w).count();
        families.push(
            json!({"name": fam.name, "status": fam.status, "reason": fam.reason, "count": rows.len() - waived_count, "waived": waived_count}),
        );
        findings.extend(rows);
    }
    report.ok = report.families.iter().all(|f| f.status != "fail");
    let _ = state;
    Ok(Out::engine(
        json!({"ok": report.ok, "families": families, "findings": findings}),
    ))
}

fn diff_nets(
    state: &AppState,
    h: &ProjectHandle,
    before: &str,
    after: Option<&str>,
) -> Result<Out, IpcError> {
    let tree_after = read_tree(h)?;
    let nets_after = sch_net::build_nets(&tree_after);
    let nets_before: Netlist = if let Some(n) = before.strip_prefix("checkpoint:") {
        let turn: u32 = n.parse().map_err(|_| err("BAD_CONFIG", "checkpoint:<n>"))?;
        let dir = crate::checkpoint::dir_for(&h.key, turn, "turn");
        if !dir.exists() {
            return Err(err(
                "NET_DIFF_UNAVAILABLE",
                format!("checkpoint {turn} is not available"),
            ));
        }
        nets_from_checkpoint(h, &dir)?
    } else if before == "session_open" {
        state
            .sessions
            .lock()
            .session_open_nets
            .get(&h.key)
            .cloned()
            .ok_or_else(|| err("NET_DIFF_UNAVAILABLE", "no session-open snapshot"))?
    } else if before == "git:HEAD" {
        nets_from_git_head(h)?
    } else if let Some(sha) = before.strip_prefix("attachment:") {
        let bytes = crate::intake::cached_bytes(state, sha)?;
        let text = String::from_utf8_lossy(&bytes);
        crate::intake::parse_kicad_netlist(&text)
            .map(|v| netlist_from_value(&v))
            .ok_or_else(|| err("NET_DIFF_UNAVAILABLE", "attachment is not a KiCad netlist"))?
    } else if before == "proposal" {
        return Err(err(
            "NET_DIFF_UNAVAILABLE",
            "use sch.plan for proposal diffs",
        ));
    } else {
        return Err(err(
            "BAD_CONFIG",
            "before must be checkpoint:n | session_open | git:HEAD | attachment:<sha256>",
        ));
    };
    let _ = after;
    let d = sch_net::diff_nets(&nets_before, &nets_after);
    let (split, merge, created, removed) = d.summary();
    Ok(Out::engine(
        json!({"before": before, "has_risk": d.has_risk, "summary": {"split": split, "merge": merge, "created": created, "removed": removed}, "changes": d.changes}),
    ))
}

fn nets_from_checkpoint(h: &ProjectHandle, dir: &Path) -> Result<Netlist, IpcError> {
    let manifest: sch_write::checkpoint::Manifest = serde_json::from_slice(
        &std::fs::read(dir.join("manifest.json")).map_err(|e| crate::error::io_err(dir, e))?,
    )?;
    let tmp = tempfile::tempdir().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    for e in &manifest.files {
        let dest = tmp.path().join(&e.path);
        std::fs::create_dir_all(dest.parent().unwrap()).ok();
        std::fs::copy(dir.join(&e.blob), &dest).map_err(|e| crate::error::io_err(&dest, e))?;
    }
    let root_rel = rel_to(&h.root, &h.root_sheet);
    let tree = sch_read::read_project(&tmp.path().join(root_rel))?;
    Ok(sch_net::build_nets(&tree))
}

fn nets_from_git_head(h: &ProjectHandle) -> Result<Netlist, IpcError> {
    let git = which_git().ok_or_else(|| err("NET_DIFF_UNAVAILABLE", "git is not installed"))?;
    let tmp = tempfile::tempdir().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    for f in crate::checkpoint::design_files(&h.root) {
        let rel = rel_to(&h.root, &f);
        let out = crate::sandbox::run(&git, &["show", &format!("HEAD:{rel}")], Some(&h.root), 20)?;
        if out.status.success() {
            let dest = tmp.path().join(&rel);
            std::fs::create_dir_all(dest.parent().unwrap()).ok();
            std::fs::write(&dest, &out.stdout).map_err(|e| crate::error::io_err(&dest, e))?;
        }
    }
    let root_rel = rel_to(&h.root, &h.root_sheet);
    let tree = sch_read::read_project(&tmp.path().join(root_rel))?;
    Ok(sch_net::build_nets(&tree))
}

fn which_git() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(if cfg!(windows) { "git.exe" } else { "git" }))
            .find(|c| c.exists())
    })
}

/// Build a Netlist from the structured attachment netlist value.
fn netlist_from_value(v: &Value) -> Netlist {
    let mut nets = Vec::new();
    if let Some(list) = v.get("nets").and_then(|n| n.as_array()) {
        for n in list {
            let name = n
                .get("name")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let members: BTreeSet<sch_net::NetMember> = n
                .get("members")
                .and_then(|m| m.as_array())
                .map(|m| {
                    m.iter()
                        .filter_map(|s| s.as_str())
                        .filter_map(|s| {
                            s.rsplit_once('.').map(|(r, p)| sch_net::NetMember {
                                sheet: "/".into(),
                                reference: r.into(),
                                pin: p.into(),
                                pin_type: "passive".into(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let id = sch_net::net_id(&members);
            let scope = if name.starts_with('/') {
                sch_net::NetScope::Local
            } else {
                sch_net::NetScope::Global
            };
            nets.push(sch_net::Net {
                name,
                scope,
                members,
                id,
                labels: Default::default(),
                no_connect: false,
                flagged: false,
                powered: false,
                local_power: false,
            });
        }
    }
    Netlist { nets }
}

fn intent_diff(prev: &sch_check::Intent, now: &sch_check::Intent) -> Value {
    let added: Vec<&String> = now
        .nets
        .keys()
        .filter(|k| !prev.nets.contains_key(*k))
        .collect();
    let removed: Vec<&String> = prev
        .nets
        .keys()
        .filter(|k| !now.nets.contains_key(*k))
        .collect();
    let changed: Vec<&String> = now
        .nets
        .iter()
        .filter(|(k, v)| {
            prev.nets
                .get(*k)
                .map(|p| p.members != v.members)
                .unwrap_or(false)
        })
        .map(|(k, _)| k)
        .collect();
    json!({"added": added, "removed": removed, "changed": changed})
}

// ---------------------------------------------------------- parts convert

fn parts_convert(
    state: &AppState,
    h: &ProjectHandle,
    auth: &Auth,
    source: &Value,
    nickname: &str,
    with_3d: bool,
) -> Result<Out, IpcError> {
    let d = state
        .sessions
        .lock()
        .authorize_d(&h.key, auth, "parts_convert")?;
    if nickname.is_empty() || nickname.contains(['/', '\\', ':', ' ']) {
        return Err(err("LIB_NICKNAME_CONFLICT", "invalid library nickname"));
    }
    let mut spec: sch_libwrite::PartSpec = serde_json::from_value(source.clone())
        .map_err(|e| err("LIB_PARSE_ERROR", format!("part spec invalid: {e}")))?;
    let libs = h.root.join("fluxsmith-libs");
    crate::paths::ensure_dir(&libs)?;
    let sym_path = libs.join(format!("{nickname}.kicad_sym"));
    let fp_dir = libs.join(format!("{nickname}.pretty"));
    crate::paths::ensure_dir(&fp_dir)?;
    let mut written = Vec::new();
    let mut reused = Vec::new();
    // 3D model first so the footprint can reference it.
    let mut model_path = None;
    if with_3d {
        if let Some(m) = spec.model_step_base64.take() {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(m)
                .map_err(|_| err("LIB_PARSE_ERROR", "bad STEP base64"))?;
            let shapes = libs.join(format!("{nickname}.3dshapes"));
            crate::paths::ensure_dir(&shapes)?;
            let fname = spec
                .footprint
                .as_ref()
                .map(|f| f.name.clone())
                .unwrap_or_else(|| spec.name.clone());
            let mp = shapes.join(format!("{fname}.step"));
            if !mp.exists() {
                crate::paths::write_atomic(&mp, &bytes)?;
                written.push(rel_to(&h.root, &mp));
            }
            let kicad_path =
                format!("${{KIPRJMOD}}/fluxsmith-libs/{nickname}.3dshapes/{fname}.step");
            if let Some(fp) = spec.footprint.as_mut() {
                match fp.model.as_mut() {
                    Some(m) => m.path = kicad_path.clone(),
                    None => {
                        fp.model = Some(sch_libwrite::ModelRef {
                            path: kicad_path.clone(),
                            ..Default::default()
                        })
                    }
                }
            }
            model_path = Some(rel_to(&h.root, &mp));
        }
    }
    if let Some(fp) = spec.footprint.as_mut() {
        if fp
            .model
            .as_ref()
            .map(|m| m.path.is_empty())
            .unwrap_or(false)
        {
            fp.model = None;
        }
    }
    // Footprint first (the symbol's Footprint property names it). A same-named file with different
    // geometry belongs to another part: this one is written under `{name}_{lcsc}` instead of reusing it.
    let mut renamed = Vec::new();
    if let Some(fp) = spec.footprint.as_mut() {
        let fp_path = fp_dir.join(format!("{}.kicad_mod", fp.name));
        if fp_path.exists() {
            let new_text =
                sch_libwrite::write_footprint(fp).map_err(|e| err("LIB_PARSE_ERROR", e))?;
            let old_text = std::fs::read_to_string(&fp_path).unwrap_or_default();
            if old_text != new_text {
                let suffix = if spec.lcsc.is_empty() {
                    sha256_hex(new_text.as_bytes())[..8].to_string()
                } else {
                    spec.lcsc.clone()
                };
                let new_name = format!("{}_{}", fp.name, suffix);
                renamed.push(json!({"footprint": fp.name, "written_as": new_name, "reason": "a footprint of that name with different geometry already exists"}));
                fp.name = new_name;
            }
        }
    }
    spec.footprint_lib = nickname.to_string();
    // Symbol: idempotent — an existing symbol of the same name is reused.
    let existing = std::fs::read_to_string(&sym_path).ok();
    let sym_exists = existing
        .as_ref()
        .map(|e| e.contains(&format!("(symbol \"{}\"", spec.name)))
        .unwrap_or(false);
    if sym_exists {
        reused.push(rel_to(&h.root, &sym_path));
    } else {
        let sym_text = sch_libwrite::write_symbol_lib(existing.as_deref(), &spec)
            .map_err(|e| err("LIB_PARSE_ERROR", e))?;
        let prep = sch_write::atomic::prepare(&sym_path, sym_text.as_bytes(), None, 3)
            .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
        prep.commit()
            .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
        written.push(rel_to(&h.root, &sym_path));
    }
    if let Some(fp) = &spec.footprint {
        let fp_path = fp_dir.join(format!("{}.kicad_mod", fp.name));
        if fp_path.exists() {
            reused.push(rel_to(&h.root, &fp_path));
        } else {
            let fp_text =
                sch_libwrite::write_footprint(fp).map_err(|e| err("LIB_PARSE_ERROR", e))?;
            let prep = sch_write::atomic::prepare(&fp_path, fp_text.as_bytes(), None, 3)
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            prep.commit()
                .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            written.push(rel_to(&h.root, &fp_path));
        }
    }
    // Register in the project sym-lib-table / fp-lib-table.
    register_lib_table(
        &h.root.join("sym-lib-table"),
        "sym_lib_table",
        nickname,
        &format!("${{KIPRJMOD}}/fluxsmith-libs/{nickname}.kicad_sym"),
        CONVERTED_DESCR,
    )?;
    if spec.footprint.is_some() {
        register_lib_table(
            &h.root.join("fp-lib-table"),
            "fp_lib_table",
            nickname,
            &format!("${{KIPRJMOD}}/fluxsmith-libs/{nickname}.pretty"),
            CONVERTED_DESCR,
        )?;
    }
    // These are our own writes: the watcher must not count them as external changes.
    {
        let mut own = h.own_shas.lock();
        for p in [
            sym_path.clone(),
            h.root.join("sym-lib-table"),
            h.root.join("fp-lib-table"),
        ] {
            if let Some(sha) = sch_write::atomic::file_sha(&p) {
                own.insert(sha);
            }
        }
    }
    // Refresh the engine library table with the project row (re-read so the
    // new symbol is resolvable immediately) and the search index.
    {
        let mut eng = h.engine.lock();
        let mut rows = eng.lib.rows.clone();
        rows.retain(|r| r.nickname != nickname);
        rows.push(sch_read::LibTableRow {
            nickname: nickname.into(),
            kind: "KiCad".into(),
            uri: sym_path.to_string_lossy().to_string(),
            descr: "fluxsmith converted (claim)".into(),
        });
        eng.lib = sch_read::SymbolLibrary::new(rows);
    }
    if let Ok(src) = std::fs::read_to_string(&sym_path) {
        if let Ok(syms) = sch_read::parse_symbol_lib(&src, nickname, &sym_path) {
            let meta = std::fs::metadata(&sym_path).ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let size = meta.map(|m| m.len() as i64).unwrap_or(0);
            let _ = state.db.lock().lib_file_replace(
                &sym_path.to_string_lossy(),
                nickname,
                "project",
                mtime,
                size,
                &syms,
            );
        }
    }
    journal(
        h,
        json!({"kind": "parts_convert", "nickname": nickname, "symbol": spec.name, "files": written, "reused": reused, "renamed": renamed, "auth": auth_kind(&d), "claim": true}),
    )?;
    Ok(Out::engine(
        json!({"sym_path": rel_to(&h.root, &sym_path), "fp_path": spec.footprint.as_ref().map(|f| format!("fluxsmith-libs/{nickname}.pretty/{}.kicad_mod", f.name)), "model_path": model_path, "written": written, "reused": reused, "renamed": renamed, "lib_id": format!("{nickname}:{}", spec.name), "footprint": spec.footprint.as_ref().map(|f| format!("{nickname}:{}", f.name)), "claim": true, "warning": "converted geometry is a CLAIM: verify against the datasheet"}),
    ))
}

/// `descr` written on a lib-table row for a library fluxsmith converted from vendor CAD.
const CONVERTED_DESCR: &str = "fluxsmith converted part (claim)";
/// `descr` for a library the human supplied (`docs/chat-references-and-attachments.md` §2.3).
const USER_LIB_DESCR: &str = "user library registered by fluxsmith";
/// Upper bound on the `.kicad_mod` files copied out of one `.pretty` directory.
const MAX_PRETTY_FILES: usize = 2000;

/// Add a `(lib ...)` row to a project lib table, creating the file when absent. A nickname that is
/// already registered is left alone (idempotent): `descr` only describes a row this call writes.
fn register_lib_table(
    path: &Path,
    root_name: &str,
    nickname: &str,
    uri: &str,
    descr: &str,
) -> Result<(), IpcError> {
    let existing = std::fs::read_to_string(path)
        .unwrap_or_else(|_| format!("({root_name}\n  (version 7)\n)\n"));
    if existing.contains(&format!("(name \"{nickname}\")")) {
        return Ok(());
    }
    let row = format!("  (lib (name \"{nickname}\")(type \"KiCad\")(uri \"{uri}\")(options \"\")(descr \"{descr}\"))\n");
    let idx = existing
        .trim_end()
        .rfind(')')
        .ok_or_else(|| err("LIBTABLE_UNREADABLE", "malformed lib table"))?;
    let new = format!("{}{}{}", &existing[..idx], row, &existing[idx..]);
    let prep = sch_write::atomic::prepare(path, new.as_bytes(), None, 3)
        .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    prep.commit()
        .map_err(|e| err("FS_TRANSIENT", e.to_string()))
}

// ------------------------------------------------------- private library registration

/// Register a library the human supplied (a `.kicad_sym` file and/or a `.pretty` directory) into
/// this project: copy it under `lib/` and add the `${KIPRJMOD}` rows to `sym-lib-table` /
/// `fp-lib-table` (`docs/chat-references-and-attachments.md` §2.3, SPEC FR-428).
///
/// This is a human action, never an agent one: `auth` must carry a `lib_import` grant minted from a
/// consent event (the agent's `lib.import_request` only proposes the card). The write is idempotent
/// — registering the same bytes twice is a no-op — and a nickname already pointing at different
/// bytes is refused rather than overwritten.
pub fn lib_register(
    state: &AppState,
    project_key: &str,
    req: &LibRegisterRequest,
    auth: Auth,
) -> Result<Value, IpcError> {
    let h = state.project(project_key)?;
    let d = state
        .sessions
        .lock()
        .authorize_d(&h.key, &auth, "lib_import")?;
    let nickname = req.nickname.trim();
    if nickname.is_empty()
        || nickname.len() > 64
        || nickname.contains(['/', '\\', ':', ' ', '"'])
        || nickname.starts_with('.')
    {
        return Err(err(
            "LIB_NICKNAME_CONFLICT",
            "a library nickname cannot be empty or contain / \\ : \" or spaces",
        )
        .with_remediation("pick a short name such as mylib"));
    }
    // Symbol bytes: an attachment handle (agent proposal) or a file the human picked.
    let symbols: Option<Vec<u8>> = match (&req.sha256, &req.path) {
        (Some(sha), _) => Some(crate::intake::cached_bytes(state, sha)?),
        (None, Some(p)) => {
            let path = Path::new(p);
            if path.extension().map(|e| e != "kicad_sym").unwrap_or(true) {
                return Err(err(
                    "ATTACH_TYPE_REJECTED",
                    "a project symbol library must be a .kicad_sym file",
                ));
            }
            Some(std::fs::read(path).map_err(|e| crate::error::io_err(path, e))?)
        }
        (None, None) => None,
    };
    if symbols.is_none() && req.pretty_path.is_none() {
        return Err(err("BAD_CONFIG", "path, sha256 or pretty_path is required"));
    }
    let lib_dir = h.root.join("lib");
    let mut written = Vec::new();
    let mut reused = Vec::new();
    let mut registered = Vec::new();
    let mut symbol_names: Vec<String> = Vec::new();
    let sym_path = lib_dir.join(format!("{nickname}.kicad_sym"));
    if let Some(bytes) = &symbols {
        // Untrusted input: it has to parse as a symbol library before it lands in the project.
        let text = String::from_utf8_lossy(bytes);
        let parsed = sch_read::parse_symbol_lib(&text, nickname, &sym_path)
            .map_err(|e| err("LIB_PARSE_ERROR", e.to_string()))?;
        symbol_names = parsed.iter().map(|s| s.id.clone()).collect();
        crate::paths::ensure_dir(&lib_dir)?;
        match std::fs::read(&sym_path) {
            Ok(old) if old == *bytes => reused.push(rel_to(&h.root, &sym_path)),
            Ok(_) => {
                return Err(err(
                    "LIB_NICKNAME_CONFLICT",
                    format!("lib/{nickname}.kicad_sym already exists with different content"),
                )
                .with_remediation("register it under another nickname"))
            }
            Err(_) => {
                let prep = sch_write::atomic::prepare(&sym_path, bytes, None, 3)
                    .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
                prep.commit()
                    .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
                written.push(rel_to(&h.root, &sym_path));
            }
        }
    }
    let pretty_dir = lib_dir.join(format!("{nickname}.pretty"));
    if let Some(src) = &req.pretty_path {
        let src = Path::new(src);
        if !src.is_dir() {
            return Err(err(
                "ATTACH_TYPE_REJECTED",
                "the footprint library must be a .pretty directory",
            ));
        }
        crate::paths::ensure_dir(&pretty_dir)?;
        let mut files: Vec<PathBuf> = std::fs::read_dir(src)
            .map_err(|e| crate::error::io_err(src, e))?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "kicad_mod").unwrap_or(false))
            .collect();
        if files.len() > MAX_PRETTY_FILES {
            return Err(err(
                "ATTACH_TOO_LARGE",
                format!("a .pretty with more than {MAX_PRETTY_FILES} footprints is not accepted"),
            ));
        }
        files.sort();
        for f in files {
            let Some(name) = f.file_name() else { continue };
            let dest = pretty_dir.join(name);
            let bytes = std::fs::read(&f).map_err(|e| crate::error::io_err(&f, e))?;
            match std::fs::read(&dest) {
                Ok(old) if old == bytes => reused.push(rel_to(&h.root, &dest)),
                Ok(_) => {
                    return Err(err(
                        "LIB_NICKNAME_CONFLICT",
                        format!(
                            "{} already exists with different content",
                            rel_to(&h.root, &dest)
                        ),
                    )
                    .with_remediation("register it under another nickname"))
                }
                Err(_) => {
                    crate::paths::write_atomic(&dest, &bytes)?;
                    written.push(rel_to(&h.root, &dest));
                }
            }
        }
    }
    if symbols.is_some() {
        register_lib_table(
            &h.root.join("sym-lib-table"),
            "sym_lib_table",
            nickname,
            &format!("${{KIPRJMOD}}/lib/{nickname}.kicad_sym"),
            USER_LIB_DESCR,
        )?;
        registered.push("sym-lib-table");
    }
    if req.pretty_path.is_some() {
        register_lib_table(
            &h.root.join("fp-lib-table"),
            "fp_lib_table",
            nickname,
            &format!("${{KIPRJMOD}}/lib/{nickname}.pretty"),
            USER_LIB_DESCR,
        )?;
        registered.push("fp-lib-table");
    }
    // Our own writes: the watcher must not report them as an external change.
    {
        let mut own = h.own_shas.lock();
        for p in [
            sym_path.clone(),
            h.root.join("sym-lib-table"),
            h.root.join("fp-lib-table"),
        ] {
            if let Some(sha) = sch_write::atomic::file_sha(&p) {
                own.insert(sha);
            }
        }
    }
    // The engine's table must see the new rows immediately; the background symbol index is
    // invalidated by the caller (`libindex::spawn`) so `lib.search` finds the symbols too.
    if symbols.is_some() {
        let mut eng = h.engine.lock();
        let mut rows = eng.lib.rows.clone();
        rows.retain(|r| r.nickname != nickname);
        rows.push(sch_read::LibTableRow {
            nickname: nickname.into(),
            kind: "KiCad".into(),
            uri: sym_path.to_string_lossy().to_string(),
            descr: USER_LIB_DESCR.into(),
        });
        eng.lib = sch_read::SymbolLibrary::new(rows);
    }
    journal(
        &h,
        json!({"kind": "lib_register", "nickname": nickname, "written": written, "reused": reused, "registered": registered, "symbols": symbol_names.len(), "auth": auth_kind(&d), "source": "user"}),
    )?;
    Ok(
        json!({"nickname": nickname, "written": written, "reused": reused, "registered": registered, "symbols": symbol_names, "lib_dir": rel_to(&h.root, &lib_dir)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_waiver_may_only_hide_a_finding_the_consent_listed() {
        let action = json!({"card_id": "c", "action_id": "waive_selected", "waive": {
            "expires": "2026-12-01T00:00:00Z",
            "findings": [{"code": "OFF_GRID", "refs": ["R1", "R2"]}, {"code": "LABEL_OVERLAP", "refs": ["labels:1:2"]}],
            "reason": "panel silk, on purpose",
        }});
        let reason = "panel silk, on purpose";
        let expiry = Some("2026-12-01T00:00:00Z".to_string());
        let refs = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // A row of the batch, refs in any order.
        assert!(waiver_is_consented(
            Some(&action),
            "OFF_GRID",
            Some(&refs(&["R2", "R1"])),
            reason,
            &expiry
        )
        .is_ok());
        // A finding nobody ticked, the same finding on other refs, another reason, another expiry.
        for bad in [
            waiver_is_consented(
                Some(&action),
                "ERC_SINGLE_PIN_NET",
                Some(&refs(&["R9.1"])),
                reason,
                &expiry,
            ),
            waiver_is_consented(
                Some(&action),
                "OFF_GRID",
                Some(&refs(&["R1", "R3"])),
                reason,
                &expiry,
            ),
            waiver_is_consented(
                Some(&action),
                "OFF_GRID",
                Some(&refs(&["R1", "R2"])),
                "because",
                &expiry,
            ),
            waiver_is_consented(
                Some(&action),
                "OFF_GRID",
                Some(&refs(&["R1", "R2"])),
                reason,
                &None,
            ),
        ] {
            assert_eq!(bad.unwrap_err().code, "CONSENT_MISMATCH");
        }
        // A grant from a card that carries no batch is left to the severity / scope gates below it.
        assert!(waiver_is_consented(
            Some(&json!({"card_id": "c"})),
            "OFF_GRID",
            None,
            reason,
            &expiry
        )
        .is_ok());
        assert!(waiver_is_consented(None, "OFF_GRID", None, reason, &expiry).is_ok());
    }

    #[test]
    fn truncation_keeps_json_valid_and_under_cap() {
        let mut v = json!({"items": (0..5000).map(|i| json!({"i": i, "s": "xxxxxxxxxx"})).collect::<Vec<_>>()});
        assert!(truncate(&mut v, 4096));
        assert!(v.to_string().len() <= 4096 + 64);
        let mut s = json!("é".repeat(100));
        truncate(&mut s, 7);
        assert!(s.as_str().unwrap().len() <= 7);
    }

    /// `focus` is what "show on canvas" frames: the parts the op-list drew and the parts it
    /// changed, in that order, deduplicated, capped, with the sheet of the first one.
    #[test]
    fn focus_lists_created_then_changed_parts() {
        use sch_write::handlers::{Changed, Created, OpResult};
        let op = |created: Vec<Created>, changed: Vec<Changed>| OpResult {
            index: 0,
            op: "place_component".into(),
            status: "ok".into(),
            created,
            changed,
            warnings: vec![],
            error: None,
        };
        let sym = |r: &str, v: &str| {
            Created::of("symbol", format!("u-{r}"))
                .with_reference(r)
                .with_value(v)
                .with_sheet("power.kicad_sch")
        };
        let per_op = vec![
            op(
                vec![
                    sym("R7", "1k"),
                    Created::of("wire", "u-w".into()),
                    Created::of("power_port", "u-p".into())
                        .with_reference("#PWR012")
                        .with_name("+3V3")
                        .with_sheet("power.kicad_sch"),
                ],
                vec![],
            ),
            op(
                vec![],
                vec![Changed {
                    reference: "R1".into(),
                    field: "Value".into(),
                    before: "1k".into(),
                    after: "2k2".into(),
                    sheet: Some("power.kicad_sch".into()),
                }],
            ),
            // A part that was both created and changed is listed once.
            op(
                vec![],
                vec![Changed {
                    reference: "R7".into(),
                    field: "Footprint".into(),
                    before: "".into(),
                    after: "R_0402".into(),
                    sheet: None,
                }],
            ),
        ];
        let f = focus_json(&per_op).unwrap();
        assert_eq!(
            f["refs"],
            json!(["R7", "#PWR012", "R1"]),
            "created parts first, then changed ones, no wires and no duplicates"
        );
        assert_eq!(f["sheet"], json!("power.kicad_sch"));
        // Nothing addressable drawn or changed: no focus at all, so the caller frames the sheet.
        assert!(focus_json(&[op(vec![Created::of("wire", "u".into())], vec![])]).is_none());
        // Bounded: a huge apply does not hand the canvas the whole sheet as a ref list.
        let many: Vec<Created> = (0..FOCUS_REFS_MAX + 10)
            .map(|i| sym(&format!("R{i}"), "1k"))
            .collect();
        let big = focus_json(&[op(many, vec![])]).unwrap();
        assert_eq!(big["refs"].as_array().unwrap().len(), FOCUS_REFS_MAX);
    }

    #[test]
    fn refdes_ranges_are_compact() {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/conformance/fixtures/hier/hier_root.kicad_sch");
        let tree = sch_read::read_project(&p).unwrap();
        let r = refdes_ranges(&tree);
        assert!(r.contains_key("R"));
        assert!(r["R"]["next"].as_u64().unwrap() >= 2);
    }
}

#[cfg(test)]
mod flow_tests {
    use super::*;
    use crate::ipc::EngineRequest as R;

    /// `lib_register` is the human's "add to project symbol library": consent-gated, idempotent,
    /// and it leaves a `${KIPRJMOD}` row behind so the symbol resolves immediately.
    #[test]
    fn lib_register_copies_and_registers_a_private_library() {
        let state = AppState::for_tests();
        let (d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let src = d.path().join("drop/MyParts.kicad_sym");
        std::fs::create_dir_all(src.parent().unwrap()).unwrap();
        std::fs::write(&src, USER_LIB).unwrap();
        let pretty = d.path().join("drop/MyParts.pretty");
        std::fs::create_dir_all(&pretty).unwrap();
        std::fs::write(pretty.join("R_0603.kicad_mod"), "(footprint \"R_0603\")\n").unwrap();
        let req = LibRegisterRequest {
            nickname: "mylib".into(),
            path: Some(src.to_string_lossy().to_string()),
            sha256: None,
            pretty_path: Some(pretty.to_string_lossy().to_string()),
        };
        // No grant: refused (the agent cannot register a library on its own).
        assert_eq!(
            lib_register(&state, &k, &req, Auth::default())
                .unwrap_err()
                .code,
            "NO_BUILD_SESSION"
        );
        let grant = |kind: &str| {
            let g = state.sessions.lock().create_grant(&GrantRequest {
                project_key: k.clone(),
                kind: kind.into(),
                payload_sha256: "sha".into(),
                consent_event_id: "c".into(),
                action: None,
            });
            Auth {
                build_session: None,
                grant: Some(g.id),
                role: None,
            }
        };
        // A grant for another action does not unlock this one.
        assert_eq!(
            lib_register(&state, &k, &req, grant("waiver"))
                .unwrap_err()
                .code,
            "GRANT_INVALID"
        );
        let out = lib_register(&state, &k, &req, grant("lib_import")).unwrap();
        let root = Path::new(&info.root);
        assert!(root.join("lib/mylib.kicad_sym").exists());
        assert!(root.join("lib/mylib.pretty/R_0603.kicad_mod").exists());
        assert_eq!(out["symbols"], json!(["mylib:MYPART"]));
        assert_eq!(out["written"].as_array().unwrap().len(), 2);
        let sym_table = std::fs::read_to_string(root.join("sym-lib-table")).unwrap();
        assert!(
            sym_table.contains("(name \"mylib\")")
                && sym_table.contains("${KIPRJMOD}/lib/mylib.kicad_sym"),
            "{sym_table}"
        );
        let fp_table = std::fs::read_to_string(root.join("fp-lib-table")).unwrap();
        assert!(
            fp_table.contains("${KIPRJMOD}/lib/mylib.pretty"),
            "{fp_table}"
        );
        // The engine's table sees it at once: `lib.resolve mylib:MYPART` answers.
        let resolved = handle(
            &state,
            &k,
            R::LibResolve {
                lib_id: "mylib:MYPART".into(),
            },
            Auth::default(),
        )
        .unwrap();
        assert!(resolved.ok, "{:?}", resolved.error);
        assert_eq!(resolved.data["state"], "table");
        assert_eq!(resolved.data["pins"], 2);

        // Idempotent: the same bytes again write nothing and add no second table row.
        let again = lib_register(&state, &k, &req, grant("lib_import")).unwrap();
        assert_eq!(again["written"], json!([]));
        assert_eq!(again["reused"].as_array().unwrap().len(), 2);
        assert_eq!(
            std::fs::read_to_string(root.join("sym-lib-table")).unwrap(),
            sym_table
        );

        // Different bytes under a nickname already in use are refused, never overwritten.
        std::fs::write(&src, USER_LIB.replace("MYPART", "OTHER")).unwrap();
        let e = lib_register(&state, &k, &req, grant("lib_import")).unwrap_err();
        assert_eq!(e.code, "LIB_NICKNAME_CONFLICT");
        assert!(std::fs::read_to_string(root.join("lib/mylib.kicad_sym"))
            .unwrap()
            .contains("MYPART"));

        // A file that is not a symbol library never lands in the project.
        std::fs::write(&src, "not a library").unwrap();
        let bad = LibRegisterRequest {
            nickname: "broken".into(),
            ..req.clone()
        };
        assert_eq!(
            lib_register(&state, &k, &bad, grant("lib_import"))
                .unwrap_err()
                .code,
            "LIB_PARSE_ERROR"
        );
        assert!(!root.join("lib/broken.kicad_sym").exists());
    }

    const USER_LIB: &str = "(kicad_symbol_lib\n\t(version 20241209)\n\t(generator \"kicad_symbol_editor\")\n\t(symbol \"MYPART\"\n\t\t(exclude_from_sim no)\n\t\t(in_bom yes)\n\t\t(on_board yes)\n\t\t(property \"Reference\" \"U\" (at 0 5.08 0) (effects (font (size 1.27 1.27))))\n\t\t(property \"Value\" \"MYPART\" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))\n\t\t(symbol \"MYPART_1_1\"\n\t\t\t(pin passive line (at -5.08 0 0) (length 2.54) (name \"A\" (effects (font (size 1.27 1.27)))) (number \"1\" (effects (font (size 1.27 1.27)))))\n\t\t\t(pin passive line (at 5.08 0 180) (length 2.54) (name \"B\" (effects (font (size 1.27 1.27)))) (number \"2\" (effects (font (size 1.27 1.27)))))\n\t\t)\n\t\t(embedded_fonts no)\n\t)\n)\n";

    #[test]
    fn parts_convert_writes_project_library_and_resolves() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let fx = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../crates/easyeda-convert/tests/fixtures/C124375.json");
        let product: Value = serde_json::from_str(&std::fs::read_to_string(fx).unwrap()).unwrap();
        let conv = easyeda_convert::convert(&product).unwrap();
        let spec = serde_json::to_value(&conv.spec).unwrap();
        // No build session: refused.
        let denied = handle(
            &state,
            &k,
            R::PartsConvert {
                source: spec.clone(),
                lib_nickname: "jlc".into(),
                with_3d: false,
            },
            Auth::default(),
        )
        .unwrap();
        assert_eq!(denied.error.unwrap().code, "NO_BUILD_SESSION");
        let tok = state
            .sessions
            .lock()
            .open_build(
                &BuildSessionOpen {
                    project_key: k.clone(),
                    plan_ref: "incremental".into(),
                    plan_sha256: None,
                    policy: "auto".into(),
                    consent_event_id: "c".into(),
                    lead_model: "m".into(),
                    tool_manifest_version: 1,
                },
                24,
                None,
            )
            .token;
        state
            .sessions
            .lock()
            .begin_turn(
                &TurnBegin {
                    project_key: k.clone(),
                    build_session: Some(tok.clone()),
                    kind: "instruction".into(),
                    headline: "h".into(),
                    plan_step: None,
                    envelope: None,
                    inherit_from_turn: None,
                    mode: "build".into(),
                    grant: None,
                    redeclare: false,
                },
                1,
            )
            .unwrap();
        let h = state.project(&k).unwrap();
        crate::checkpoint::create(&state, &h, 1, "turn").unwrap();
        // The Sourcer role may write converted libraries (and nothing else).
        let auth = Auth {
            build_session: Some(tok.clone()),
            grant: None,
            role: Some("sourcer".into()),
        };
        let out = handle(
            &state,
            &k,
            R::PartsConvert {
                source: spec.clone(),
                lib_nickname: "jlc".into(),
                with_3d: false,
            },
            auth.clone(),
        )
        .unwrap();
        assert!(out.ok, "{:?}", out.error);
        let lib_id = out.data["lib_id"].as_str().unwrap().to_string();
        assert!(lib_id.starts_with("jlc:"));
        let root = Path::new(&info.root);
        assert!(root.join("fluxsmith-libs/jlc.kicad_sym").exists());
        assert!(root
            .join("fluxsmith-libs/jlc.pretty")
            .join(format!(
                "{}.kicad_mod",
                conv.spec.footprint.as_ref().unwrap().name
            ))
            .exists());
        let table = std::fs::read_to_string(root.join("sym-lib-table")).unwrap();
        assert!(table.contains("(name \"jlc\")") && table.contains("fluxsmith-libs/jlc.kicad_sym"));
        assert!(std::fs::read_to_string(root.join("fp-lib-table"))
            .unwrap()
            .contains("jlc.pretty"));
        // Immediately resolvable through the engine library table and the search index.
        let r = handle(
            &state,
            &k,
            R::LibResolve {
                lib_id: lib_id.clone(),
            },
            Auth::default(),
        )
        .unwrap();
        assert_eq!(r.data["state"], "table", "{:?}", r.data);
        assert_eq!(r.data["pins"], 2);
        let s = handle(
            &state,
            &k,
            R::LibSearch {
                query: Some("B-2100S02P".into()),
                lib_id: None,
                category: None,
                pins: None,
                limit: Some(5),
            },
            Auth::default(),
        )
        .unwrap();
        assert!(
            s.data["results"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false),
            "{:?}",
            s.data
        );
        // Idempotent: a second conversion reuses the files instead of failing.
        let again = handle(
            &state,
            &k,
            R::PartsConvert {
                source: spec,
                lib_nickname: "jlc".into(),
                with_3d: false,
            },
            auth,
        )
        .unwrap();
        assert!(again.ok, "{:?}", again.error);
        assert_eq!(again.data["lib_id"].as_str().unwrap(), lib_id);
        assert!(again.data["written"].as_array().unwrap().is_empty());
    }

    /// Red lines 13/14: an apply may only rewrite the sheets the envelope declares, measured on
    /// the files that actually change — a global `rename_net` reaches the child sheet too.
    #[test]
    fn apply_refuses_a_file_the_envelope_does_not_declare() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        // A plan session: renaming a net is only inside the envelope because the approved plan made
        // `GLB` renamable (an incremental session would raise a scope card for it instead).
        let tok = state
            .sessions
            .lock()
            .open_build(
                &BuildSessionOpen {
                    project_key: k.clone(),
                    plan_ref: "plan:p@1".into(),
                    plan_sha256: Some("sha".into()),
                    policy: "review".into(),
                    consent_event_id: "c".into(),
                    lead_model: "m".into(),
                    tool_manifest_version: 1,
                },
                24,
                Some(&crate::session::PlanCeiling {
                    components_added: 24,
                    components_deleted: 0,
                    wires_max: None,
                    sheets: vec!["hier_root.kicad_sch".into(), "hier_child.kicad_sch".into()],
                    structural: vec![],
                    nets_renamable: vec!["GLB".into()],
                }),
            )
            .token;
        let auth = Auth {
            build_session: Some(tok.clone()),
            grant: None,
            role: Some("lead".into()),
        };
        let envelope = |sheets: Vec<String>| Envelope {
            sheets,
            allowed_ops: vec!["rename_net".into()],
            nets_renamable: vec!["GLB".into()],
            source: "plan:p@1/s1".into(),
            ..Default::default()
        };
        let begin = |env: Envelope, turn: u32| {
            state
                .sessions
                .lock()
                .begin_turn(
                    &TurnBegin {
                        project_key: k.clone(),
                        build_session: Some(tok.clone()),
                        kind: "instruction".into(),
                        headline: "h".into(),
                        plan_step: None,
                        envelope: Some(env),
                        inherit_from_turn: None,
                        mode: "build".into(),
                        grant: None,
                        redeclare: false,
                    },
                    turn,
                )
                .unwrap();
            let h = state.project(&k).unwrap();
            crate::checkpoint::create(&state, &h, turn, "turn").unwrap();
        };
        let ops = json!({"protocol_version": 1, "ops": [{"op": "rename_net", "old_name": "GLB", "new_name": "GLOBAL_SIG"}]});
        let apply = |auth: Auth| {
            handle(
                &state,
                &k,
                R::Apply {
                    oplist: ops.clone(),
                    target: "hier_root.kicad_sch".into(),
                    expected_merges: vec![],
                    note: "t".into(),
                    waived: None,
                    strict_layout: None,
                },
                auth,
            )
            .unwrap()
        };
        let root = Path::new(&info.root);
        let child = root.join("hier_child.kicad_sch");
        let before = std::fs::read_to_string(&child).unwrap();

        // GLB is a global label on both sheets, but only the root is declared.
        begin(envelope(vec!["hier_root.kicad_sch".into()]), 1);
        let out = apply(auth.clone());
        let e = out.error.expect("the undeclared child sheet is refused");
        assert_eq!(e.code, "ENVELOPE_SHEET_UNDECLARED");
        assert!(e.message.contains("hier_child.kicad_sch"), "{}", e.message);
        assert_eq!(
            std::fs::read_to_string(&child).unwrap(),
            before,
            "a refused apply writes nothing"
        );
        assert!(std::fs::read_to_string(root.join("hier_root.kicad_sch"))
            .unwrap()
            .contains("\"GLB\""));

        // Declaring both sheets is what the op-list needed all along.
        begin(
            envelope(vec![
                "hier_root.kicad_sch".into(),
                "hier_child.kicad_sch".into(),
            ]),
            2,
        );
        let out = apply(auth);
        assert!(out.ok, "{:?}", out.error);
        assert_eq!(out.data["applied"], true);
        assert!(std::fs::read_to_string(&child)
            .unwrap()
            .contains("GLOBAL_SIG"));
    }

    fn fixture_project() -> (tempfile::TempDir, String) {
        let d = tempfile::tempdir().unwrap();
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/conformance/fixtures/hier");
        for f in [
            "hier_root.kicad_sch",
            "hier_child.kicad_sch",
            "hier.kicad_pro",
        ] {
            std::fs::copy(src.join(f), d.path().join(f)).unwrap();
        }
        let p = d
            .path()
            .join("hier.kicad_pro")
            .to_string_lossy()
            .to_string();
        (d, p)
    }

    /// A second sheet symbol pointing at the same file is a second instance: the project-wide read
    /// lists it separately, addressed by instance path, with the reference KiCad annotates on that
    /// path (here the file's own property, since only the first instance has an entry).
    #[test]
    fn read_all_sheets_lists_every_instance() {
        let state = AppState::for_tests();
        let (d, pro) = fixture_project();
        let root = d.path().join("hier_root.kicad_sch");
        let src = std::fs::read_to_string(&root).unwrap();
        let second = concat!(
            "\t(sheet\n\t\t(at 100 100)\n\t\t(size 12.7 10.16)\n",
            "\t\t(stroke (width 0.1524) (type solid))\n\t\t(fill (color 0 0 0 0.0000))\n",
            "\t\t(uuid \"44444444-4444-4444-8444-444444444444\")\n",
            "\t\t(property \"Sheetname\" \"child2\" (at 100 99 0) (effects (font (size 1.27 1.27))))\n",
            "\t\t(property \"Sheetfile\" \"hier_child.kicad_sch\" (at 100 111 0) (effects (font (size 1.27 1.27))))\n\t)\n",
        );
        std::fs::write(
            &root,
            src.replace("\t(sheet_instances", &format!("{second}\t(sheet_instances")),
        )
        .unwrap();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let call = |r: R| handle(&state, &k, r, Auth::default()).unwrap();
        let one = call(R::Read {
            sheet: None,
            r#match: None,
            limit: None,
            all_sheets: None,
        });
        assert!(one.ok, "{:?}", one.error);
        // The default is still one sheet: the root has no R3.
        assert!(!one.data["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["reference"] == "R3"));
        let all = call(R::Read {
            sheet: None,
            r#match: None,
            limit: None,
            all_sheets: Some(true),
        });
        assert!(all.ok, "{:?}", all.error);
        assert_eq!(all.data["all_sheets"], true);
        assert_eq!(all.meta.trust, "untrusted");
        let rows = all.data["symbols"].as_array().unwrap();
        assert_eq!(
            all.data["total"]["symbols"].as_u64().unwrap() as usize,
            rows.len()
        );
        assert_eq!(all.data["truncated"], false);
        let r1 = rows.iter().find(|s| s["reference"] == "R1").unwrap();
        assert_eq!(r1["sheet"], "hier_root.kicad_sch");
        let r3: Vec<&Value> = rows.iter().filter(|s| s["reference"] == "R3").collect();
        assert_eq!(r3.len(), 2, "one row per instance of the reused sheet");
        assert!(r3.iter().all(|s| s["sheet"] == "hier_child.kicad_sch"));
        let paths: BTreeSet<&str> = r3
            .iter()
            .map(|s| s["instance_path"].as_str().unwrap())
            .collect();
        assert_eq!(paths.len(), 2, "two rows, two instance paths: {paths:?}");
        assert!(paths
            .iter()
            .all(|p| p.starts_with("/11111111-1111-4111-8111-111111111111/")));
        // `match` filters on the per-instance reference: R4 exists in both instances.
        let one_ref = call(R::Read {
            sheet: None,
            r#match: Some("R4".into()),
            limit: None,
            all_sheets: Some(true),
        });
        assert_eq!(one_ref.data["symbols"].as_array().unwrap().len(), 2);
        // A limit truncates and says so.
        let cut = call(R::Read {
            sheet: None,
            r#match: None,
            limit: Some(1),
            all_sheets: Some(true),
        });
        assert_eq!(cut.data["symbols"].as_array().unwrap().len(), 1);
        assert_eq!(cut.data["truncated"], true);
    }

    #[test]
    fn read_paths_and_gated_apply() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let call = |r: R, auth: Auth| handle(&state, &k, r, auth).unwrap();
        let s = call(R::Summary { sheet: None }, Auth::default());
        assert!(s.ok, "{:?}", s.error);
        assert!(s.meta.bytes <= CAP_SUMMARY);
        assert!(s.data["refdes"]["R"].is_object());
        let n = call(
            R::Nets {
                sheet: None,
                r#match: Some("GLB".into()),
                limit: None,
            },
            Auth::default(),
        );
        assert_eq!(n.data["nets"].as_array().unwrap().len(), 1);
        let c = call(
            R::Component {
                reference: "R1".into(),
                unit: None,
            },
            Auth::default(),
        );
        assert!(c.ok);
        assert_eq!(c.meta.trust, "untrusted");
        let bad = call(
            R::Bytes {
                sheet: "../outside.kicad_sch".into(),
            },
            Auth::default(),
        );
        assert_eq!(bad.error.unwrap().code, "PATH_OUT_OF_SCOPE");
        let nm = call(R::NetMap { sheet: "/".into() }, Auth::default());
        assert!(nm.ok, "{:?}", nm.error);
        assert_eq!(nm.meta.trust, "untrusted");
        assert!(
            nm.data["wires"]
                .as_object()
                .map(|o| !o.is_empty())
                .unwrap_or(false),
            "{}",
            nm.data
        );
        assert!(nm.data["pins"]
            .as_object()
            .map(|o| o.values().all(|v| v.is_string()))
            .unwrap_or(false));
        // Sheet pins of the sheet symbols drawn on this sheet: the canvas hovers and highlights them.
        assert!(
            nm.data["sheet_pins"]
                .as_object()
                .map(|o| !o.is_empty() && o.values().all(|v| v.is_string()))
                .unwrap_or(false),
            "{}",
            nm.data
        );
        // Junctions / no-connects are always present (this fixture has none of either), so the
        // canvas can read a net out of them instead of showing a bare kind.
        for k in ["junctions", "no_connects"] {
            assert!(
                nm.data[k]
                    .as_object()
                    .map(|o| o.values().all(|v| v.is_string()))
                    .unwrap_or(false),
                "{k}: {}",
                nm.data
            );
        }
        let unk = call(
            R::NetMap {
                sheet: "/nope".into(),
            },
            Auth::default(),
        );
        assert_eq!(unk.error.unwrap().code, "SHEET_UNKNOWN");
        let ops = json!({"protocol_version": 1, "ops": [{"op": "place_component", "lib_id": "Device:R", "designator": "R9", "value": "4k7", "x_mil": 6000, "y_mil": 6000}]});
        let plan = call(
            R::Plan {
                oplist: ops.clone(),
                target: "hier_root.kicad_sch".into(),
                flat: None,
            },
            Auth::default(),
        );
        assert!(plan.ok, "{:?}", plan.error);
        assert_eq!(plan.data["applied"], false);
        // The stored preview renders as a ghost layer containing the would-be part.
        let pid = plan.data["preview"]["id"].as_str().unwrap().to_string();
        let ghost = call(
            R::RenderPreview {
                preview_id: pid,
                sheet: "/".into(),
            },
            Auth::default(),
        );
        assert!(ghost.ok, "{:?}", ghost.error);
        assert!(
            ghost.data.to_string().contains("R9"),
            "preview geometry lists the planned part"
        );
        assert!(
            plan.data["bbox_mil"].is_array(),
            "plan reports the bbox of the planned objects"
        );
        let missing = call(
            R::RenderPreview {
                preview_id: "deadbeef".into(),
                sheet: "/".into(),
            },
            Auth::default(),
        );
        assert_eq!(missing.error.unwrap().code, "PREVIEW_NOT_FOUND");
        // Apply without a session is refused; with a question turn refused; with instruction + checkpoint allowed.
        let denied = call(
            R::Apply {
                oplist: ops.clone(),
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "t".into(),
                waived: None,
                strict_layout: None,
            },
            Auth::default(),
        );
        assert_eq!(denied.error.unwrap().code, "NO_BUILD_SESSION");
        let tok = state
            .sessions
            .lock()
            .open_build(
                &BuildSessionOpen {
                    project_key: k.clone(),
                    plan_ref: "incremental".into(),
                    plan_sha256: None,
                    policy: "review".into(),
                    consent_event_id: "c".into(),
                    lead_model: "m".into(),
                    tool_manifest_version: 1,
                },
                24,
                None,
            )
            .token;
        let auth = Auth {
            build_session: Some(tok.clone()),
            grant: None,
            role: Some("lead".into()),
        };
        state
            .sessions
            .lock()
            .begin_turn(
                &TurnBegin {
                    project_key: k.clone(),
                    build_session: Some(tok.clone()),
                    kind: "instruction".into(),
                    headline: "h".into(),
                    plan_step: None,
                    envelope: None,
                    inherit_from_turn: None,
                    mode: "build".into(),
                    grant: None,
                    redeclare: false,
                },
                1,
            )
            .unwrap();
        let no_cp = call(
            R::Apply {
                oplist: ops.clone(),
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "t".into(),
                waived: None,
                strict_layout: None,
            },
            auth.clone(),
        );
        assert_eq!(no_cp.error.unwrap().code, "CHECKPOINT_FAILED");
        let h = state.project(&k).unwrap();
        crate::checkpoint::create(&state, &h, 1, "turn").unwrap();
        let applied = call(
            R::Apply {
                oplist: ops.clone(),
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "t".into(),
                waived: None,
                strict_layout: None,
            },
            auth.clone(),
        );
        assert!(applied.ok, "{:?}", applied.error);
        assert_eq!(applied.data["applied"], true);
        assert!(applied.meta.run_id.is_some());
        // Re-sending the same op-list is idempotent (cached).
        let again = call(
            R::Apply {
                oplist: ops.clone(),
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "t".into(),
                waived: None,
                strict_layout: None,
            },
            auth.clone(),
        );
        assert!(again.ok);
        assert!(again.meta.hint.as_deref().unwrap_or("").contains("cached"));
        let counters = state.sessions.lock().turns[&k].counters.clone();
        assert_eq!(counters.components_added, 1);
        assert_eq!(counters.apply_count, 1);
        // A net-risk approval travels in `waived` (kind net_risk) while auth stays the session: accepted once,
        // consumed, refused on reuse. Putting the grant into `auth.grant` would be checked as kind "apply".
        let ops2 = json!({"protocol_version": 1, "ops": [{"op": "place_component", "lib_id": "Device:R", "designator": "R10", "value": "1k", "x_mil": 7000, "y_mil": 6000}]});
        let planned = call(
            R::Plan {
                oplist: ops2.clone(),
                target: "hier_root.kicad_sch".into(),
                flat: None,
            },
            auth.clone(),
        );
        let ops2_sha = planned
            .meta
            .ops_sha256
            .clone()
            .expect("plan reports the op-list sha");
        // An unbound grant (no ops_sha256) is refused: the approval must name the op-list the human saw.
        let unbound = state.sessions.lock().create_grant(&GrantRequest {
            project_key: k.clone(),
            kind: "net_risk".into(),
            payload_sha256: "p".into(),
            consent_event_id: "c".into(),
            action: None,
        });
        let r_unbound = call(
            R::Apply {
                oplist: ops2.clone(),
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "unbound".into(),
                waived: Some(WaiverRef {
                    grant_id: unbound.id.clone(),
                    reason: "x".into(),
                }),
                strict_layout: None,
            },
            auth.clone(),
        );
        assert_eq!(r_unbound.error.unwrap().code, "GRANT_INVALID");
        let nr = state.sessions.lock().create_grant(&GrantRequest {
            project_key: k.clone(),
            kind: "net_risk".into(),
            payload_sha256: "p".into(),
            consent_event_id: "c".into(),
            action: Some(json!({"ops_sha256": ops2_sha})),
        });
        let waived = call(
            R::Apply {
                oplist: ops2.clone(),
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "waived".into(),
                waived: Some(WaiverRef {
                    grant_id: nr.id.clone(),
                    reason: "same supply".into(),
                }),
                strict_layout: None,
            },
            auth.clone(),
        );
        assert!(waived.ok, "{:?}", waived.error);
        assert_eq!(waived.data["waived"], true);
        let ops3 = json!({"protocol_version": 1, "ops": [{"op": "place_component", "lib_id": "Device:R", "designator": "R11", "value": "2k", "x_mil": 8000, "y_mil": 6000}]});
        let reused = call(
            R::Apply {
                oplist: ops3,
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "waived again".into(),
                waived: Some(WaiverRef {
                    grant_id: nr.id.clone(),
                    reason: "again".into(),
                }),
                strict_layout: None,
            },
            auth.clone(),
        );
        assert_eq!(reused.error.unwrap().code, "GRANT_INVALID");
        let misplaced = state
            .sessions
            .lock()
            .create_grant(&GrantRequest {
                project_key: k.clone(),
                kind: "net_risk".into(),
                payload_sha256: "p".into(),
                consent_event_id: "c".into(),
                action: None,
            })
            .id;
        let as_auth = call(
            R::Apply {
                oplist: ops2,
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "grant in auth".into(),
                waived: None,
                strict_layout: None,
            },
            Auth {
                build_session: Some(tok.clone()),
                grant: Some(misplaced),
                role: Some("lead".into()),
            },
        );
        assert_eq!(as_auth.error.unwrap().code, "GRANT_INVALID");
        // Deleting is outside the incremental ceiling.
        let del =
            json!({"protocol_version": 1, "ops": [{"op": "delete_component", "designator": "R9"}]});
        let d = call(
            R::Apply {
                oplist: del,
                target: "hier_root.kicad_sch".into(),
                expected_merges: vec![],
                note: "t".into(),
                waived: None,
                strict_layout: None,
            },
            auth.clone(),
        );
        assert_eq!(d.error.unwrap().code, "SCOPE_WIDEN");
        // Gate run and diff vs checkpoint see the new component.
        let g = call(R::GateRun {}, Auth::default());
        assert!(g.ok);
        let diff = call(
            R::DiffNets {
                before: "checkpoint:1".into(),
                after: None,
            },
            Auth::default(),
        );
        assert!(diff.ok, "{:?}", diff.error);
        // Rollback needs a grant of the right kind.
        let bad = crate::checkpoint::rollback(
            &state,
            &h,
            &RollbackRequest {
                project_key: k.clone(),
                before_turn: 1,
                grant: "nope".into(),
                kind: None,
                state_sha256: None,
            },
        );
        assert_eq!(bad.unwrap_err().code, "GRANT_INVALID");
        let g = state.sessions.lock().create_grant(&GrantRequest {
            project_key: k.clone(),
            kind: "rollback".into(),
            payload_sha256: "x".into(),
            consent_event_id: "c".into(),
            action: None,
        });
        let rb = crate::checkpoint::rollback(
            &state,
            &h,
            &RollbackRequest {
                project_key: k.clone(),
                before_turn: 1,
                grant: g.id,
                kind: None,
                state_sha256: None,
            },
        )
        .unwrap();
        assert!(!rb.restored_files.is_empty());
        let c = call(
            R::Component {
                reference: "R9".into(),
                unit: None,
            },
            Auth::default(),
        );
        assert!(!c.ok);
    }

    /// A `[[waiver]]` hides a finding from the verdict, not from the human: the row still comes
    /// back, carrying the expiry and reason of the waiver, and stops counting.
    #[test]
    fn waived_finding_is_reported_with_its_expiry_and_never_counts() {
        let state = AppState::for_tests();
        let (d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let gate = || handle(&state, &k, R::GateRun {}, Auth::default()).unwrap();
        let family = |v: &Value, name: &str| {
            v["families"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["name"] == name)
                .cloned()
                .unwrap()
        };
        let rows = |v: &Value, code: &str| -> Vec<Value> {
            v["findings"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|f| f["code"] == code)
                .cloned()
                .collect()
        };

        let before = gate();
        assert!(before.ok, "{:?}", before.error);
        let fam = family(&before.data, "integrity");
        assert_eq!(fam["status"], "fail", "{}", before.data);
        assert_eq!(fam["count"], 2);
        let dangling = rows(&before.data, "DANGLING_BUS");
        assert_eq!(dangling.len(), 2);
        assert_eq!(dangling[0]["severity"], "Error");
        // A finding with no waiver serialises exactly as it always did.
        assert!(dangling[0].get("waived").is_none());
        // Both errors sit on the same bus wire, so its uuid is the scope of one waiver.
        let wire = dangling[0]["location"]
            .as_str()
            .unwrap()
            .split(':')
            .nth(1)
            .unwrap()
            .to_string();
        let waiver = |expires: &str| {
            std::fs::write(
                d.path().join("fluxsmith.toml"),
                format!("[[waiver]]\ncode = \"DANGLING_BUS\"\nrefs = [\"{wire}\"]\nseverity = \"Error\"\nreason = \"the bus is stubbed until the connector lands\"\nexpires = \"{expires}\"\n"),
            )
            .unwrap();
        };

        waiver("2099-01-01T00:00:00Z");
        let after = gate();
        let fam = family(&after.data, "integrity");
        assert_eq!(fam["status"], "pass", "{}", after.data);
        assert_eq!(fam["count"], 0, "a waived Error does not count");
        assert_eq!(fam["waived"], 2);
        let waived = rows(&after.data, "DANGLING_BUS");
        assert_eq!(waived.len(), 2, "a waived finding is still reported");
        for r in &waived {
            assert_eq!(r["severity"], "Error");
            assert_eq!(r["waived"], true);
            assert_eq!(r["waived_until"], "2099-01-01T00:00:00Z");
            assert_eq!(
                r["waived_reason"],
                "the bus is stubbed until the connector lands"
            );
        }

        // An expired waiver hides nothing: the family fails again and the rows are undecorated.
        waiver("2000-01-01T00:00:00Z");
        let expired = gate();
        assert_eq!(family(&expired.data, "integrity")["status"], "fail");
        assert_eq!(family(&expired.data, "integrity")["count"], 2);
        assert!(rows(&expired.data, "DANGLING_BUS")
            .iter()
            .all(|r| r.get("waived").is_none()));
    }

    /// A waiver names parts, not prefixes: `C1` covers the `C1` rows (and a `decap:C1` location),
    /// and says nothing about `C10` / `C11`. A substring test used to hide a whole decade of parts
    /// behind one decision the human never made.
    #[test]
    fn a_waiver_on_c1_does_not_cover_c11() {
        let finding = |refs: &[&str], location: &str| sch_write::gates::Finding {
            code: "OFF_GRID".into(),
            severity: sch_write::gates::Severity::Warning,
            message: "pin off the connection grid".into(),
            sheet: None,
            file: None,
            refs: refs.iter().map(|s| s.to_string()).collect(),
            at_mil: None,
            remediation: None,
            evidence: Default::default(),
            location: location.into(),
        };
        let waivers = |refs: Value| Waivers {
            records: vec![json!({"code": "OFF_GRID", "refs": refs})],
            now: "2026-01-01T00:00:00Z".to_string(),
        };

        let on_c1 = waivers(json!(["C1"]));
        assert!(on_c1.covering(&finding(&["C1"], "grid:C1")).is_some());
        assert!(on_c1.covering(&finding(&[], "decap:C1")).is_some());
        assert!(on_c1.covering(&finding(&["C11"], "decap:C11")).is_none());
        assert!(on_c1.covering(&finding(&[], "decap:C10")).is_none());
        // A ref is a whole name as well: a waiver on the part does not stand for one on its pin,
        // which the panel records as its own ref (`C1.2`).
        assert!(on_c1.covering(&finding(&["C1.2"], "pin:C1.2")).is_none());

        // A finding with no refs is waived by its location, which the panel records verbatim.
        let on_location = waivers(json!(["style:grid:9"]));
        assert!(on_location
            .covering(&finding(&[], "style:grid:9"))
            .is_some());
        assert!(on_location
            .covering(&finding(&[], "style:grid:90"))
            .is_none());
    }

    /// Waiving the same finding twice replaces its `[[waiver]]` record instead of appending a second
    /// one: a review card whose waive failed part-way is retried with the rows that already went in,
    /// and `fluxsmith.toml` must not grow a duplicate row that says the same thing.
    #[test]
    fn waiving_the_same_finding_twice_replaces_the_record() {
        let state = AppState::for_tests();
        let (d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let waive = |refs: Vec<String>, reason: &str, expires: &str| {
            let g = state.sessions.lock().create_grant(&GrantRequest {
                project_key: k.clone(),
                kind: "waiver".into(),
                payload_sha256: "x".into(),
                consent_event_id: "c".into(),
                action: None,
            });
            handle(
                &state,
                &k,
                R::PolicyWaive {
                    code: "OFF_GRID".into(),
                    refs: Some(refs),
                    severity: Some("Warning".into()),
                    reason: reason.into(),
                    expires: Some(expires.into()),
                },
                Auth {
                    build_session: None,
                    grant: Some(g.id),
                    role: Some("lead".into()),
                },
            )
            .unwrap()
        };
        let records = || -> Vec<Value> {
            crate::sidecar::read_project_config(d.path())
                .unwrap()
                .get("waiver")
                .and_then(|w| w.as_array())
                .cloned()
                .unwrap_or_default()
        };

        let first = waive(
            vec!["R3".into(), "R4".into()],
            "panel silk, on purpose",
            "2099-01-01T00:00:00Z",
        );
        assert!(first.ok, "{:?}", first.error);
        assert_eq!(first.data["waivers"], 1);

        // The same decision again (refs in another order): one record, carrying the newer values.
        let again = waive(
            vec!["R4".into(), "R3".into()],
            "panel silk, reviewed again",
            "2098-01-01T00:00:00Z",
        );
        assert!(again.ok, "{:?}", again.error);
        assert_eq!(again.data["waivers"], 1, "no duplicate row");
        let rows = records();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["reason"], "panel silk, reviewed again");
        assert_eq!(rows[0]["expires"], "2098-01-01T00:00:00Z");

        // A waiver over other parts is a different decision: it is appended, not replaced.
        let other = waive(vec!["R9".into()], "different part", "2099-01-01T00:00:00Z");
        assert!(other.ok, "{:?}", other.error);
        assert_eq!(other.data["waivers"], 2);
        assert_eq!(records().len(), 2);
    }

    /// `sheet.create` draws the sheet symbol on the sheet the caller names, not always on the root,
    /// and the paper size of the file it creates is the one that was asked for.
    #[test]
    fn sheet_create_uses_the_named_parent_and_paper() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let k = info.key.clone();
        let tok = state
            .sessions
            .lock()
            .open_build(
                &BuildSessionOpen {
                    project_key: k.clone(),
                    plan_ref: "incremental".into(),
                    plan_sha256: None,
                    policy: "review".into(),
                    consent_event_id: "c".into(),
                    lead_model: "m".into(),
                    tool_manifest_version: 1,
                },
                24,
                None,
            )
            .token;
        let auth = Auth {
            build_session: Some(tok.clone()),
            grant: None,
            role: Some("lead".into()),
        };
        state
            .sessions
            .lock()
            .begin_turn(
                &TurnBegin {
                    project_key: k.clone(),
                    build_session: Some(tok.clone()),
                    kind: "instruction".into(),
                    headline: "h".into(),
                    plan_step: None,
                    envelope: Some(Envelope {
                        structural: vec![
                            "create_sheet:mid.kicad_sch".into(),
                            "create_sheet:leaf.kicad_sch".into(),
                        ],
                        ..Default::default()
                    }),
                    inherit_from_turn: None,
                    mode: "build".into(),
                    grant: None,
                    redeclare: false,
                },
                1,
            )
            .unwrap();
        let h = state.project(&k).unwrap();
        crate::checkpoint::create(&state, &h, 1, "turn").unwrap();
        let create = |file: &str, name: &str, parent: Option<&str>, paper: Option<&str>| {
            handle(
                &state,
                &k,
                R::SheetCreate {
                    file: file.into(),
                    name: name.into(),
                    at_mil: [4000.0, 1000.0],
                    size_mil: [1000.0, 800.0],
                    pins: vec![],
                    paper: paper.map(|p| p.to_string()),
                    parent: parent.map(|p| p.to_string()),
                },
                auth.clone(),
            )
            .unwrap()
        };
        // Default parent: the root sheet.
        let mid = create("mid.kicad_sch", "mid", None, None);
        assert!(mid.ok, "{:?}", mid.error);
        // Child of that child: the symbol belongs in the middle file, and A3 is honoured.
        let leaf = create("leaf.kicad_sch", "leaf", Some("mid.kicad_sch"), Some("A3"));
        assert!(leaf.ok, "{:?}", leaf.error);
        let root = Path::new(&info.root);
        let read = |f: &str| std::fs::read_to_string(root.join(f)).unwrap();
        assert!(read("hier_root.kicad_sch").contains("mid.kicad_sch"));
        assert!(
            !read("hier_root.kicad_sch").contains("leaf.kicad_sch"),
            "the nested sheet symbol must not land in the root"
        );
        assert!(read("mid.kicad_sch").contains("leaf.kicad_sch"));
        assert!(read("leaf.kicad_sch").contains("(paper \"A3\")"));
        assert!(read("mid.kicad_sch").contains("(paper \"A4\")"));
        // The sheet tree now has both new instances, one under the other.
        let tree = read_tree(&h).unwrap();
        let names: Vec<String> = tree.instances.iter().map(|i| i.names.clone()).collect();
        assert!(names.contains(&"/mid/".to_string()), "{names:?}");
        assert!(names.contains(&"/mid/leaf/".to_string()), "{names:?}");
        // An unknown parent is refused, not silently drawn on the root.
        let bad = create("other.kicad_sch", "other", Some("nope.kicad_sch"), None);
        assert_eq!(bad.error.unwrap().code, "SHEET_UNKNOWN");
    }

    /// Every finding that sits on a sheet names the file it sits in, so the harness never has to
    /// parse it out of the message.
    #[test]
    fn findings_carry_the_sheet_file() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let g = handle(&state, &info.key, R::GateRun {}, Auth::default()).unwrap();
        let findings = g.data["findings"].as_array().unwrap();
        assert!(!findings.is_empty());
        for f in findings {
            if f["sheet"].is_string() {
                let file = f["file"].as_str().unwrap_or_default();
                assert!(
                    file == "hier_root.kicad_sch" || file == "hier_child.kicad_sch",
                    "{f}"
                );
            }
        }
    }

    /// A check asked for one sheet answers with that sheet's findings. The selector used to be
    /// turned into a uuid instance path and compared against `Finding.sheet`, which is the instance
    /// *names* path, so the filter matched nothing and every sheet-scoped check came back empty —
    /// the Lead's post-apply style/layout/integrity passes saw no findings at all. All three ways
    /// of naming the sheet (file, names path, uuid path) select the same findings.
    #[test]
    fn a_sheet_scoped_check_returns_that_sheet_only() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let run = |sheet: Option<&str>| -> Vec<(String, String)> {
            let r = handle(
                &state,
                &info.key,
                R::Check {
                    family: "layout".into(),
                    sheet: sheet.map(|s| s.to_string()),
                },
                Auth::default(),
            )
            .unwrap();
            r.data
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    (
                        f["code"].as_str().unwrap_or_default().to_string(),
                        f["file"].as_str().unwrap_or_default().to_string(),
                    )
                })
                .collect()
        };
        let all = run(None);
        assert!(
            all.iter().any(|(_, f)| f == "hier_root.kicad_sch")
                && all.iter().any(|(_, f)| f == "hier_child.kicad_sch"),
            "the fixture has layout findings on both sheets: {all:?}"
        );
        let tree = read_tree(&state.project(&info.key).unwrap()).unwrap();
        let uuid_path = tree
            .instances
            .iter()
            .find(|i| i.names == "/child/")
            .map(|i| i.path.clone())
            .expect("the child instance");
        for sel in ["hier_child.kicad_sch", "/child/", uuid_path.as_str()] {
            let child = run(Some(sel));
            assert!(!child.is_empty(), "{sel} selected nothing: {all:?}");
            assert!(
                child.iter().all(|(_, f)| f == "hier_child.kicad_sch"),
                "{sel} returned another sheet's findings: {child:?}"
            );
            let want: Vec<&(String, String)> = all
                .iter()
                .filter(|(_, f)| f == "hier_child.kicad_sch")
                .collect();
            assert_eq!(child.len(), want.len(), "{sel}: {child:?} vs {want:?}");
        }
    }

    // F13: the errors a model hits while finding its way around must carry a remediation and the
    // candidates, so the retry after the first failure is the corrected one.
    #[test]
    fn op_unknown_names_the_nearest_ops_and_the_vocabulary() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let r = handle(
            &state,
            &info.key,
            R::OpsTemplate {
                op: "add_symbol".into(),
                required_only: None,
            },
            Auth::default(),
        )
        .unwrap();
        let e = r.error.expect("unknown op must fail");
        assert_eq!(e.code, "OP_UNKNOWN");
        let rem = e.remediation.unwrap_or_default();
        assert!(rem.contains("place_component"), "{rem}");
        let ev = e.evidence.expect("candidates and the vocabulary");
        assert_eq!(ev["candidates"][0], "place_component");
        assert!(ev["core"].as_array().unwrap().len() >= 20);

        // A name that has no op at all says what replaces it instead of guessing a lookalike.
        let root = handle(
            &state,
            &info.key,
            R::OpsTemplate {
                op: "create_root_schematic".into(),
                required_only: None,
            },
            Auth::default(),
        )
        .unwrap();
        let rem = root.error.unwrap().remediation.unwrap_or_default();
        assert!(rem.contains("already exists"), "{rem}");
    }

    #[test]
    fn sheet_unknown_lists_the_sheets_of_the_project() {
        let state = AppState::for_tests();
        let (_d, pro) = fixture_project();
        let info = crate::project::open(&state, &pro, None).unwrap();
        let r = handle(
            &state,
            &info.key,
            R::Summary {
                sheet: Some("power.kicad_sch".into()),
            },
            Auth::default(),
        )
        .unwrap();
        let e = r.error.expect("unknown sheet must fail");
        assert_eq!(e.code, "SHEET_UNKNOWN");
        let rem = e.remediation.unwrap_or_default();
        assert!(rem.contains("hier_root.kicad_sch"), "{rem}");
        let ev = e.evidence.expect("the sheet list");
        assert!(ev["sheet_files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "hier_child.kicad_sch"));
        // No host-absolute path reaches the model.
        assert!(!rem.contains(std::path::MAIN_SEPARATOR), "{rem}");
    }
}

/// Flatten `sch_net::NetChange` into the harness shape:
/// `{kind, name?, into?, sources:[{name, named}], named}`.
pub fn net_changes_json(d: &sch_net::NetDiff) -> Value {
    use sch_net::{is_named, NetChange};
    let src = |names: &[String]| -> Value {
        Value::Array(
            names
                .iter()
                .map(|n| json!({"name": n, "named": is_named(n)}))
                .collect(),
        )
    };
    Value::Array(
        d.changes
            .iter()
            .map(|c| match c {
                NetChange::Created { name, members } => json!({"kind": "Created", "name": name, "named": is_named(name), "members": members}),
                NetChange::Removed { name, members } => json!({"kind": "Removed", "name": name, "named": is_named(name), "members": members}),
                NetChange::Renamed { from, to } => json!({"kind": "Renamed", "name": from, "into": to, "named": is_named(from) || is_named(to)}),
                NetChange::Split { name, into } => json!({"kind": "Split", "name": name, "named": is_named(name), "names": into, "sources": src(into)}),
                NetChange::Merged { into, from } => {
                    let mut all = from.clone();
                    all.push(into.clone());
                    json!({"kind": "Merged", "into": into, "named": all.iter().any(|n| is_named(n)), "sources": src(&all)})
                }
                NetChange::MembersChanged { name, added, removed } => json!({"kind": "MembersChanged", "name": name, "named": is_named(name), "added": added, "removed": removed}),
            })
            .collect(),
    )
}
