// SPDX-License-Identifier: Apache-2.0
//! `fluxsmith-cli`: JSON contract over the engine for conformance tests,
//! scripts and the golden set. Exit codes: 0 ok, 1 refused/findings,
//! 2 usage, 3 not found, 4 io/parse, 5 locked/stale.

use sch_ops::OpList;
use sch_write::{DrawRequest, Engine, ExpectedMerge};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn usage() -> ! {
    eprintln!(
        "usage: fluxsmith-cli <command> [args] [--json]\n\
  read <sch>                      normalised model\n\
  nets <sch> [--root R]           every net -> members\n\
  net <sch> <name>                one net\n\
  component <sch> <ref>           component + pin map\n\
  pins <sch> <lib_id> <x_mil> <y_mil> [rot] [mirror] [unit]\n\
  bbox <sch> [refs,...]           bounding boxes\n\
  geom <sch> [sheet_path]         overlay geometry\n\
  plan <sch> --ops FILE [--root R] [--no-strict-nets] [--expect-merge NET]...\n\
  draw <sch> --ops FILE --apply [--root R] [--note TEXT] [--journal PATH]\n\
  check <sch> [--intent FILE]     gate.run report\n\
  diff <before.sch> <after.sch>   net diff\n\
  restore <project_root> <checkpoint_dir> [--manifest-sha SHA]\n\
  checkpoint <project_root> <dir>  snapshot all schematics under root\n\
  golden extract <reference.sch> --task ID [--out expected.json]\n\
  golden match <expected.json> <sch>\n\
  new <dir> <name> [--paper A4]     empty KiCad 10 project
  synth <out.kicad_sch> [--components N] [--wires M] [--seed S]   deterministic large sheet (perf fixture)
  bench <sch> [--iters K]           parse / render / serialise timings (median) + payload size
  capabilities"
    );
    std::process::exit(2)
}

fn engine() -> Engine {
    let (env, table) = sch_read::discover_kicad(None);
    let rows = table
        .map(|t| sch_read::parse_lib_table(&t, &env, 0).unwrap_or_default())
        .unwrap_or_default();
    Engine::new(sch_read::SymbolLibrary::new(rows))
}

fn arg_after(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn args_after_all(args: &[String], flag: &str) -> Vec<String> {
    let mut v = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            if let Some(x) = args.get(i + 1) {
                v.push(x.clone());
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    v
}

fn out(v: &Value) {
    println!("{}", serde_json::to_string_pretty(v).unwrap());
}

fn fail(code: i32, msg: &str) -> ! {
    out(&json!({"ok": false, "error": msg}));
    std::process::exit(code)
}

fn load_tree(path: &str, root: Option<String>) -> sch_read::SheetTree {
    let root = root.unwrap_or_else(|| path.to_string());
    match sch_read::read_project(Path::new(&root)) {
        Ok(t) => t,
        Err(e) => fail(4, &e.to_string()),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|a| a != "--json").collect();
    let Some(cmd) = args.first() else { usage() };
    let positional: Vec<String> = {
        let mut v = Vec::new();
        let mut skip = false;
        for a in args.iter().skip(1) {
            if skip {
                skip = false;
                continue;
            }
            if a.starts_with("--") {
                if !matches!(a.as_str(), "--apply" | "--no-strict-nets") {
                    skip = true;
                }
                continue;
            }
            v.push(a.clone());
        }
        v
    };
    match cmd.as_str() {
        "capabilities" => out(&json!({
            "schema_version": 1, "protocol_version": sch_ops::PROTOCOL_VERSION,
            "core_ops": sch_ops::CORE_OPS, "macro_ops": sch_ops::MACRO_OPS,
            "engine": env!("CARGO_PKG_VERSION"),
            "kicad_versions": {"min": sch_read::KNOWN_VERSIONS_MIN, "max": sch_read::KNOWN_VERSIONS_MAX, "write": sch_read::WRITE_VERSION}
        })),
        "read" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let tree = load_tree(sch, None);
            out(
                &json!({"schema_version": 1, "root": tree.root_file, "root_uuid": tree.root_uuid,
                "sheets": tree.instances.iter().map(|i| json!({"path": i.path, "names": i.names, "file": i.file})).collect::<Vec<_>>(),
                "files": tree.files.iter().map(|(p, s)| json!({"file": p, "version": s.version, "paper": s.paper, "symbols": s.symbols, "wires": s.wires.len(), "labels": s.labels, "sheets": s.sheets})).collect::<Vec<_>>()}),
            );
        }
        "nets" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let tree = load_tree(sch, arg_after(&args, "--root"));
            let nets = sch_net::build_nets(&tree);
            out(&json!({"schema_version": 1, "nets": nets.nets}));
        }
        "net" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let name = positional.get(1).unwrap_or_else(|| usage());
            let tree = load_tree(sch, None);
            let nets = sch_net::build_nets(&tree);
            match nets.by_name(name) {
                Some(n) => out(&json!({"schema_version": 1, "net": n})),
                None => fail(3, &format!("net {name} not found")),
            }
        }
        "component" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let r = positional.get(1).unwrap_or_else(|| usage());
            let tree = load_tree(sch, None);
            let nets = sch_net::build_nets(&tree);
            let pins = sch_check::pinmap(&tree, &nets, r);
            let syms: Vec<&sch_model::SymbolInst> = tree
                .files
                .values()
                .flat_map(|s| s.symbol_by_ref(r))
                .collect();
            if syms.is_empty() {
                fail(3, &format!("{r} not found"));
            }
            out(
                &json!({"schema_version": 1, "component": syms[0], "units": syms.iter().map(|s| s.unit).collect::<Vec<_>>(), "pins": pins}),
            );
        }
        "pins" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let lib_id = positional.get(1).unwrap_or_else(|| usage());
            let x: f64 = positional
                .get(2)
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| usage());
            let y: f64 = positional
                .get(3)
                .and_then(|v| v.parse().ok())
                .unwrap_or_else(|| usage());
            let rot = positional
                .get(4)
                .and_then(|v| v.parse::<f64>().ok())
                .and_then(sch_model::Rot::from_deg)
                .unwrap_or_default();
            let mirror = match positional.get(5).map(|s| s.as_str()) {
                Some("x") => sch_model::Mirror::X,
                Some("y") => sch_model::Mirror::Y,
                _ => sch_model::Mirror::None,
            };
            let unit: u32 = positional.get(6).and_then(|v| v.parse().ok()).unwrap_or(1);
            let tree = load_tree(sch, None);
            let mut eng = engine();
            let lib = tree
                .root()
                .lib_symbol(lib_id)
                .cloned()
                .or_else(|| eng.lib.resolve(lib_id));
            let Some(lib) = lib else {
                fail(3, &format!("{lib_id} not found"))
            };
            let inst = sch_model::SymbolInst {
                uuid: String::new(),
                lib_id: lib_id.clone(),
                placement: sch_model::Placement {
                    at: sch_model::Pt::new(sch_model::mil_to_nm(x), sch_model::mil_to_nm(y)),
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
            let pins: Vec<Value> = sch_model::world_pins(&inst, &lib).into_iter().map(|p| json!({"number": p.number, "name": p.name, "type": p.kind.as_str(), "x_mil": sch_model::nm_to_mil(p.at.x), "y_mil": sch_model::nm_to_mil(p.at.y)})).collect();
            out(
                &json!({"schema_version": 1, "lib_id": lib_id, "units": lib.unit_count, "pins": pins}),
            );
        }
        "bbox" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let refs: Vec<String> = positional
                .get(1)
                .map(|s| s.split(',').map(|x| x.to_string()).collect())
                .unwrap_or_default();
            let tree = load_tree(sch, None);
            let file = tree.root_file.clone();
            let items: Vec<Value> = tree
                .root()
                .symbols
                .iter()
                .filter(|s| refs.is_empty() || refs.contains(&s.reference))
                .filter_map(|s| {
                    sch_geom::symbol_bbox(&tree.docs[&file], s)
                        .map(|b| json!({"ref": s.reference, "bbox_mil": b.to_mil()}))
                })
                .collect();
            let all = sch_geom::bbox_of(&tree, &file, &refs).map(|b| b.to_mil());
            out(&json!({"schema_version": 1, "bbox_mil": all, "items": items}));
        }
        "geom" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let sp = positional.get(1).cloned().unwrap_or_else(|| "/".into());
            let tree = load_tree(sch, None);
            match sch_geom::sheet_geometry(&tree, &sp) {
                Some(g) => out(&serde_json::to_value(g).unwrap()),
                None => fail(3, "sheet not found"),
            }
        }
        "render" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let sp = positional.get(1).cloned().unwrap_or_else(|| "/".into());
            let tree = load_tree(sch, None);
            match sch_geom::render_sheet(&tree, &sp) {
                Some(g) => out(&serde_json::to_value(g).unwrap()),
                None => fail(3, "sheet not found"),
            }
        }
        "plan" | "draw" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let ops_path = arg_after(&args, "--ops").unwrap_or_else(|| usage());
            let src =
                std::fs::read_to_string(&ops_path).unwrap_or_else(|e| fail(4, &e.to_string()));
            let oplist = OpList::from_json(&src).unwrap_or_else(|e| fail(2, &e.message));
            let target = PathBuf::from(sch);
            let journal = arg_after(&args, "--journal")
                .map(PathBuf::from)
                .or_else(|| {
                    Some(
                        target
                            .parent()
                            .unwrap_or(Path::new("."))
                            .join(".fluxsmith/journal.jsonl"),
                    )
                });
            let req = DrawRequest {
                target: target.clone(),
                root: arg_after(&args, "--root").map(PathBuf::from),
                oplist,
                strict_nets: !args.iter().any(|a| a == "--no-strict-nets"),
                strict_layout: true,
                expected_merges: args_after_all(&args, "--expect-merge")
                    .into_iter()
                    .map(|n| ExpectedMerge {
                        into: n,
                        sources_unnamed_only: false,
                    })
                    .collect(),
                note: arg_after(&args, "--note"),
                backup_depth: 3,
                journal,
                expected_target_sha: None,
                run_backup_dir: Some(
                    target
                        .parent()
                        .unwrap_or(Path::new("."))
                        .join(".fluxsmith/backups/runs"),
                ),
            };
            let mut eng = engine();
            let apply = cmd == "draw" && args.iter().any(|a| a == "--apply");
            let res = if apply {
                eng.apply(&req)
            } else {
                eng.plan(&req)
            };
            match res {
                Ok(r) => {
                    let code = if r.refusal.is_some() { 1 } else { 0 };
                    let mut v = serde_json::to_value(&r).unwrap();
                    v["ok"] = json!(r.refusal.is_none());
                    v["schema_version"] = json!(1);
                    if !apply {
                        v["preview_files"] = json!(r.previews.keys().collect::<Vec<_>>());
                    }
                    out(&v);
                    std::process::exit(code);
                }
                Err(sch_write::WriteError::OpList(errs)) => {
                    out(&json!({"ok": false, "schema_version": 1, "errors": errs}));
                    std::process::exit(1);
                }
                Err(sch_write::WriteError::Atomic(e)) => fail(5, &e.to_string()),
                Err(e) => fail(4, &e.to_string()),
            }
        }
        "check" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let tree = load_tree(sch, None);
            let nets = sch_net::build_nets(&tree);
            let intent = arg_after(&args, "--intent")
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str::<sch_check::Intent>(&s).ok());
            let mut eng = engine();
            let mut report = sch_check::gate_run(&tree, &nets, intent.as_ref(), Some(&mut eng.lib));
            report.ok = report.families.iter().all(|f| f.status != "fail");
            let ok = report.ok;
            out(&json!({"schema_version": 1, "ok": ok, "families": report.families}));
            std::process::exit(if ok { 0 } else { 1 });
        }
        "intent-snapshot" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let tree = load_tree(sch, None);
            let nets = sch_net::build_nets(&tree);
            out(&serde_json::to_value(sch_check::intent_snapshot(
                &nets,
                arg_after(&args, "--note").as_deref().unwrap_or(""),
            ))
            .unwrap());
        }
        "diff" => {
            let a = positional.first().unwrap_or_else(|| usage());
            let b = positional.get(1).unwrap_or_else(|| usage());
            let na = sch_net::build_nets(&load_tree(a, None));
            let nb = sch_net::build_nets(&load_tree(b, None));
            let d = sch_net::diff_nets(&na, &nb);
            let (split, merge, created, removed) = d.summary();
            out(
                &json!({"schema_version": 1, "has_risk": d.has_risk, "summary": {"split": split, "merge": merge, "created": created, "removed": removed}, "changes": d.changes}),
            );
        }
        "checkpoint" => {
            let root = positional.first().unwrap_or_else(|| usage());
            let dir = positional.get(1).unwrap_or_else(|| usage());
            let root = Path::new(root)
                .canonicalize()
                .unwrap_or_else(|e| fail(4, &e.to_string()));
            let mut files = Vec::new();
            for e in walkdir(&root) {
                let ext = e.extension().and_then(|s| s.to_str()).unwrap_or("");
                let name = e.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if matches!(ext, "kicad_sch" | "kicad_pro")
                    || name == "sym-lib-table"
                    || name == "fp-lib-table"
                    || name == "fluxsmith.toml"
                    || name == "intent.json"
                {
                    files.push(e);
                }
            }
            match sch_write::checkpoint::create(&root, &files, Path::new(dir)) {
                Ok((m, sha)) => out(
                    &json!({"schema_version": 1, "manifest_sha256": sha, "files": m.files.len()}),
                ),
                Err(e) => fail(4, &e.to_string()),
            }
        }
        "restore" => {
            let root = positional.first().unwrap_or_else(|| usage());
            let dir = positional.get(1).unwrap_or_else(|| usage());
            match sch_write::checkpoint::restore(
                Path::new(root),
                Path::new(dir),
                sch_write::checkpoint::RestoreOptions {
                    expected_manifest_sha: arg_after(&args, "--manifest-sha").as_deref(),
                    backup_depth: 3,
                    // The CLI has no observation of the tree to lock against, so it
                    // restores the manifest only: nothing is moved out of the project.
                    ..Default::default()
                },
            ) {
                Ok(o) => out(&json!({"schema_version": 1, "restored": o.restored})),
                Err(e) => fail(5, &e.to_string()),
            }
        }
        "new" => {
            let dir = positional.first().unwrap_or_else(|| usage());
            let name = positional.get(1).unwrap_or_else(|| usage());
            let paper = arg_after(&args, "--paper").unwrap_or_else(|| "A4".into());
            let dir = PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap_or_else(|e| fail(4, &e.to_string()));
            let uuid = uuid::Uuid::new_v4().to_string();
            let sch = dir.join(format!("{name}.kicad_sch"));
            let pro = dir.join(format!("{name}.kicad_pro"));
            if sch.exists() || pro.exists() {
                fail(1, "project files already exist");
            }
            std::fs::write(&sch, sch_write::nodes::empty_schematic(&uuid, &paper))
                .unwrap_or_else(|e| fail(4, &e.to_string()));
            std::fs::write(&pro, sch_write::nodes::empty_project(name))
                .unwrap_or_else(|e| fail(4, &e.to_string()));
            out(&json!({"schema_version": 1, "root": sch, "project": pro, "root_uuid": uuid}));
        }
        "golden" => golden(&positional, &args),
        "synth" => {
            let out_path = positional.first().unwrap_or_else(|| usage());
            let n: usize = arg_after(&args, "--components")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1000);
            let m: usize = arg_after(&args, "--wires")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5000);
            let seed: u64 = arg_after(&args, "--seed")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            let text = synth_sheet(n, m, seed);
            let out_path = PathBuf::from(out_path);
            if let Some(d) = out_path.parent() {
                std::fs::create_dir_all(d).unwrap_or_else(|e| fail(4, &e.to_string()));
            }
            std::fs::write(&out_path, &text).unwrap_or_else(|e| fail(4, &e.to_string()));
            let pro = out_path.with_extension("kicad_pro");
            if !pro.exists() {
                let name = out_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("synth");
                std::fs::write(&pro, sch_write::nodes::empty_project(name))
                    .unwrap_or_else(|e| fail(4, &e.to_string()));
            }
            out(
                &json!({"schema_version": 1, "root": out_path, "components": n, "wires": m, "seed": seed, "bytes": text.len()}),
            );
        }
        "bench" => {
            let sch = positional.first().unwrap_or_else(|| usage());
            let iters: usize = arg_after(&args, "--iters")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5)
                .max(1);
            let sheet_sel = arg_after(&args, "--sheet").unwrap_or_else(|| "/".into());
            let mut parse_ms = Vec::new();
            let mut render_ms = Vec::new();
            let mut ser_ms = Vec::new();
            let mut bytes = 0usize;
            let mut counts = json!({});
            for _ in 0..iters {
                let t0 = std::time::Instant::now();
                let tree = load_tree(sch, None);
                parse_ms.push(t0.elapsed().as_secs_f64() * 1000.0);
                let t1 = std::time::Instant::now();
                let g = sch_geom::render_sheet(&tree, &sheet_sel)
                    .unwrap_or_else(|| fail(3, "sheet not found"));
                render_ms.push(t1.elapsed().as_secs_f64() * 1000.0);
                let t2 = std::time::Instant::now();
                let v = serde_json::to_vec(&g).unwrap();
                ser_ms.push(t2.elapsed().as_secs_f64() * 1000.0);
                bytes = v.len();
                counts = json!({"symbols": g.symbols.len(), "wires": g.wires.len(), "junctions": g.junctions.len(), "labels": g.labels.len(), "sheets": g.sheets.len(), "texts": g.texts.len()});
            }
            let med = |v: &mut Vec<f64>| {
                v.sort_by(|a, b| a.partial_cmp(b).unwrap());
                v[v.len() / 2]
            };
            out(
                &json!({"schema_version": 1, "iters": iters, "parse_ms": med(&mut parse_ms), "render_ms": med(&mut render_ms), "serialize_ms": med(&mut ser_ms), "bytes": bytes, "counts": counts}),
            );
        }
        _ => usage(),
    }
}

fn walkdir(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if p.file_name()
                        .map(|n| n == ".fluxsmith" || n == ".git")
                        .unwrap_or(false)
                    {
                        continue;
                    }
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// Golden set: canonical matching (D-54)
// ---------------------------------------------------------------------------

/// Normalise a component value: lowercase, no spaces, SI suffix canonicalised.
pub fn value_norm(v: &str) -> String {
    let s: String = v
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    let s = s
        .replace(['µ', 'μ'], "u")
        .replace('Ω', "")
        .replace("ohm", "")
        .replace(
            'r',
            if s.chars().filter(|c| c.is_ascii_digit()).count() > 0 && s.ends_with('r') {
                ""
            } else {
                "r"
            },
        );
    // strip trailing unit letters f/h/v/a (farad/henry/volt/amp) after an SI prefix
    let mut t = s.clone();
    for unit in ["f", "h"] {
        if t.ends_with(unit) && t.len() > 1 {
            let prev = t.chars().nth(t.len() - 2).unwrap();
            if prev.is_ascii_digit() || "pnumk".contains(prev) {
                t.pop();
            }
        }
    }
    // 0.1u -> 100n style normalisation via numeric parse
    if let Some((num, prefix)) = split_num(&t) {
        let mult = match prefix {
            "p" => 1e-12,
            "n" => 1e-9,
            "u" => 1e-6,
            "m" => 1e-3,
            "k" => 1e3,
            "meg" | "M" => 1e6,
            "g" => 1e9,
            "" => 1.0,
            _ => return t,
        };
        let val = num * mult;
        return format!("{val:e}");
    }
    t
}

fn split_num(s: &str) -> Option<(f64, &str)> {
    let idx = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    if idx == 0 {
        return None;
    }
    let num: f64 = s[..idx].parse().ok()?;
    let rest = &s[idx..];
    if rest.chars().all(|c| c.is_ascii_alphabetic()) && rest.len() <= 3 {
        return Some((num, rest));
    }
    // R-notation: the unit letter stands in for the decimal point (4k7 = 4.7k, 2R2 = 2.2, 1u5 = 1.5u).
    let mut chars = rest.chars();
    let unit = chars.next()?;
    let frac = chars.as_str();
    if unit.is_ascii_alphabetic() && !frac.is_empty() && frac.chars().all(|c| c.is_ascii_digit()) {
        let f: f64 = format!("0.{frac}").parse().ok()?;
        let unit_str = &rest[..unit.len_utf8()];
        let unit_str = if unit_str.eq_ignore_ascii_case("r") {
            ""
        } else {
            unit_str
        };
        return Some((num + f, unit_str));
    }
    None
}

fn fingerprint(sheet: &sch_model::Sheet, s: &sch_model::SymbolInst) -> String {
    // Connectors carry free-text values ("USB 4-pin", "Conn_01x04"): the task never pins them.
    // LEDs likewise ("LED", "STATUS", "RED"): the task says "a status LED", never its value string.
    let value = if s.lib_id.starts_with("Connector") || s.lib_id.starts_with("Device:LED") {
        String::new()
    } else {
        value_norm(&s.value)
    };
    // A task says "a 4-pin header", never which connector library symbol: every `Connector*`
    // symbol with the same pin count is the same part for the oracle.
    let lib_id = if s.lib_id.starts_with("Connector") {
        let n = sheet
            .lib_symbol(&s.lib_id)
            .map(|l| l.pins_for_unit(s.unit).count())
            .unwrap_or(0);
        format!("Connector:*{n}pins")
    } else {
        passive_family(&s.lib_id).to_string()
    };
    // Footprints are not part of the task statements (the reference happens to set some);
    // the oracle compares symbols and values only.
    let _ = &s.footprint;
    format!("{}|{}|", lib_id, value)
}

/// "a 22 uF capacitor" is satisfied by `Device:C`, `Device:C_Small` or `Device:C_Polarized`
/// alike (the task never names the symbol variant); the same for R / L variants. The oracle
/// compares the family, not the drawing style.
fn passive_family(lib_id: &str) -> &str {
    match lib_id {
        "Device:C_Small" | "Device:C_Polarized" | "Device:C_Polarized_Small" => "Device:C",
        "Device:R_Small" | "Device:R_US" | "Device:R_Small_US" => "Device:R",
        "Device:L_Small" => "Device:L",
        "Device:LED_Small" => "Device:LED",
        other => other,
    }
}

/// Non-polar two-pin parts connect either way round; their pin numbers must not
/// decide a match (a polarised cap collapses to its family here as well: the task text
/// never specifies which pin faces the rail).
fn symmetric_two_pin(lib_id: &str) -> bool {
    let lib_id = passive_family(lib_id);
    matches!(
        lib_id,
        "Device:R"
            | "Device:R_Small"
            | "Device:C"
            | "Device:C_Small"
            | "Device:L"
            | "Device:L_Small"
            | "Device:FerriteBead"
            | "Device:FerriteBead_Small"
            | "Device:Crystal"
            | "Device:Crystal_Small"
            | "Device:Jumper"
            | "Device:Thermistor"
            | "Device:Fuse"
            | "Device:Polyfuse"
    )
}

/// Canonical form of a schematic for matching: components as fingerprints
/// with their pins, nets as anchored names or refined colours.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct Expected {
    schema_version: u32,
    task: String,
    /// fingerprint -> count
    components: BTreeMap<String, usize>,
    /// net colour -> members as "fingerprint#pin" multiset (sorted)
    nets: Vec<Vec<String>>,
    anchored_nets: BTreeMap<String, Vec<String>>,
    /// Net names the task statement mentions (from `--task-text`): only these are matched by
    /// name; every other named net is matched by membership like an unnamed one. Empty = legacy
    /// behaviour (every named net anchored).
    #[serde(default)]
    anchors: Vec<String>,
}

/// Net names from `nets` that occur in the task text (case-insensitive, whole token).
fn anchors_from_text(text: &str, nets: &sch_net::Netlist) -> Vec<String> {
    let lower = text.to_lowercase();
    let tokens: BTreeSet<String> = lower
        .split(|c: char| {
            c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '.' | ':' | '"' | '`' | '\'')
        })
        .map(|t| t.to_string())
        .filter(|t| !t.is_empty())
        .collect();
    let mut out: Vec<String> = nets
        .nets
        .iter()
        .map(|n| n.name.trim_start_matches('/').to_string())
        .filter(|n| !n.starts_with("Net-(") && !n.starts_with("unconnected-("))
        .filter(|n| tokens.contains(&n.to_lowercase()))
        .collect();
    out.sort();
    out.dedup();
    out
}

type Canonical = (
    BTreeMap<String, usize>,
    Vec<Vec<String>>,
    BTreeMap<String, Vec<String>>,
);

fn canonical(
    tree: &sch_read::SheetTree,
    nets: &sch_net::Netlist,
    anchors: Option<&BTreeSet<String>>,
) -> Canonical {
    let mut fp_by_ref: BTreeMap<String, String> = BTreeMap::new();
    for sheet in tree.files.values() {
        for s in &sheet.symbols {
            if !s.reference.starts_with('#') {
                fp_by_ref
                    .entry(s.reference.clone())
                    .or_insert_with(|| fingerprint(sheet, s));
            }
        }
    }
    let mut components: BTreeMap<String, usize> = BTreeMap::new();
    for fp in fp_by_ref.values() {
        *components.entry(fp.clone()).or_default() += 1;
    }
    // colour refinement (1-WL): start with anchored names for global/local named nets that are rails/interfaces
    let mut net_members: Vec<(String, Vec<String>)> = nets
        .nets
        .iter()
        // Two or more members, or a single-pin net the task statement names ("from net LED_CTRL"):
        // that pin's identity is part of the task.
        .filter(|n| {
            n.members.len() >= 2
                || anchors.is_some_and(|a| a.contains(n.name.trim_start_matches('/')))
        })
        .map(|n| {
            (
                n.name.clone(),
                n.members
                    .iter()
                    .filter_map(|m| {
                        fp_by_ref.get(&m.reference).map(|fp| {
                            let lib = fp.split('|').next().unwrap_or("");
                            if symmetric_two_pin(lib) {
                                format!("{fp}#*")
                            } else {
                                format!("{fp}#{}", m.pin)
                            }
                        })
                    })
                    .collect(),
            )
        })
        .collect();
    for (_, m) in net_members.iter_mut() {
        m.sort();
    }
    // Scope is not part of the task statement: a local label `/+3V3` and a power port `+3V3`
    // name the same rail for the oracle (single-sheet tasks).
    // A named net is anchored by name only when the task statement names it (`anchors`); an
    // internal node the model happened to label ("LED_ANODE" vs the reference's "LED_CTRL_LED")
    // is matched by membership instead. `None` keeps the legacy rule (every named net anchored).
    let is_anchored = |name: &str| -> bool {
        if name.starts_with("Net-(") || name.starts_with("unconnected-(") {
            return false;
        }
        match anchors {
            Some(a) => a.contains(name.trim_start_matches('/')),
            None => true,
        }
    };
    let anchored: BTreeMap<String, Vec<String>> = net_members
        .iter()
        .filter(|(name, _)| is_anchored(name))
        .map(|(n, m)| (n.trim_start_matches('/').to_string(), m.clone()))
        .collect();
    let mut unnamed: Vec<Vec<String>> = net_members
        .into_iter()
        .filter(|(name, _)| !name.starts_with("unconnected-(") && !is_anchored(name))
        .map(|(_, m)| m)
        .collect();
    unnamed.sort();
    (components, unnamed, anchored)
}

/// Partial-credit score in 0..=1: half for the component multiset (Jaccard over
/// fingerprint counts), half for the anchored nets (per expected net, Jaccard of
/// the member sets; a missing net scores 0).
fn golden_score(
    exp_components: &BTreeMap<String, usize>,
    have_components: &BTreeMap<String, usize>,
    exp_nets: &BTreeMap<String, Vec<String>>,
    have_nets: &BTreeMap<String, Vec<String>>,
    exp_unnamed: &[Vec<String>],
    have_unnamed: &[Vec<String>],
) -> f64 {
    let keys: BTreeSet<&String> = exp_components
        .keys()
        .chain(have_components.keys())
        .collect();
    let (mut inter, mut union) = (0usize, 0usize);
    for k in keys {
        let a = exp_components.get(k).copied().unwrap_or(0);
        let b = have_components.get(k).copied().unwrap_or(0);
        inter += a.min(b);
        union += a.max(b);
    }
    let comp = if union == 0 {
        1.0
    } else {
        inter as f64 / union as f64
    };
    // Unnamed (membership-only) nets count as one more item: matched multiset / larger multiset.
    let unnamed_item: Option<f64> = if exp_unnamed.is_empty() && have_unnamed.is_empty() {
        None
    } else {
        let mut have_pool: Vec<&Vec<String>> = have_unnamed.iter().collect();
        let mut matched = 0usize;
        for want in exp_unnamed {
            if let Some(i) = have_pool.iter().position(|h| *h == want) {
                have_pool.swap_remove(i);
                matched += 1;
            }
        }
        Some(matched as f64 / exp_unnamed.len().max(have_unnamed.len()) as f64)
    };
    let net = if exp_nets.is_empty() && unnamed_item.is_none() {
        1.0
    } else {
        let mut total = 0.0;
        let mut items = 0usize;
        for (name, want) in exp_nets {
            items += 1;
            let Some(have) = have_nets.get(name) else {
                continue;
            };
            let w: BTreeSet<&String> = want.iter().collect();
            let h: BTreeSet<&String> = have.iter().collect();
            let u = w.union(&h).count();
            if u > 0 {
                total += w.intersection(&h).count() as f64 / u as f64;
            }
        }
        if let Some(x) = unnamed_item {
            items += 1;
            total += x;
        }
        total / items as f64
    };
    let s = 0.5 * comp + 0.5 * net;
    (s * 1000.0).round() / 1000.0
}

/// `lib_symbols` block of the conformance hier fixture (Device:R, power:GND, power:+3V3),
/// embedded so `synth` needs no KiCad installation and no repo path at run time.
const SYNTH_LIB_SOURCE: &str =
    include_str!("../../../tests/conformance/fixtures/hier/hier_root.kicad_sch");

fn synth_lib_symbols() -> &'static str {
    let start = SYNTH_LIB_SOURCE
        .find("\t(lib_symbols")
        .expect("fixture has lib_symbols");
    let bytes = SYNTH_LIB_SOURCE.as_bytes();
    let mut depth = 0i32;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return &SYNTH_LIB_SOURCE[start..=i];
                }
            }
            _ => {}
        }
        i += 1;
    }
    unreachable!("unbalanced lib_symbols block")
}

fn synth_num(v: f64) -> String {
    let s = format!("{:.2}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" {
        "0".into()
    } else {
        s.to_string()
    }
}

/// Deterministic large schematic for perf work (S-E7): `n` resistors on a 1000 mil grid, two
/// labelled stub wires per resistor, extra labelled vertical wires up to `m` wires in total, a
/// junction on every fourth bottom stub, every tenth label global. Every uuid is v5 of the seed,
/// so the same arguments always give the same bytes. The result parses with `sch_read` and passes
/// the integrity gate (asserted by `synth_sheet_parses_and_passes_integrity`).
pub fn synth_sheet(n: usize, m: usize, seed: u64) -> String {
    let ns = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("fluxsmith-synth:{seed}").as_bytes(),
    );
    let id = |tag: &str| uuid::Uuid::new_v5(&ns, tag.as_bytes()).to_string();
    let root = id("root");
    let cols = 45usize; // A0 landscape: 1189 mm wide, 1000 mil pitch
    let f = synth_num;
    let mut s = String::with_capacity(n * 1200 + m * 160);
    s.push_str("(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n");
    s.push_str(&format!("\t(uuid \"{root}\")\n\t(paper \"A0\")\n"));
    s.push_str(synth_lib_symbols());
    s.push('\n');
    let mut wires = 0usize;
    let push_label = |s: &mut String, k: usize, name: &str, x: f64, y: f64| {
        if k % 10 == 0 {
            s.push_str(&format!("\t(global_label \"{name}\"\n\t\t(shape passive)\n\t\t(at {} {} 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n\t\t(uuid \"{}\")\n\t)\n", f(x), f(y), id(&format!("gl:{name}@{x},{y}"))));
        } else {
            s.push_str(&format!("\t(label \"{name}\"\n\t\t(at {} {} 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n\t\t(uuid \"{}\")\n\t)\n", f(x), f(y), id(&format!("l:{name}@{x},{y}"))));
        }
    };
    for k in 0..n {
        let (col, row) = (k % cols, k / cols);
        let x = 12.7 + col as f64 * 25.4;
        let y = 12.7 + row as f64 * 25.4;
        s.push_str(&format!(
            concat!(
                "\t(symbol\n\t\t(lib_id \"Device:R\")\n\t\t(at {x} {y} 0)\n\t\t(unit 1)\n\t\t(exclude_from_sim no)\n\t\t(in_bom yes)\n\t\t(on_board yes)\n\t\t(dnp no)\n\t\t(uuid \"{u}\")\n",
                "\t\t(property \"Reference\" \"R{r}\"\n\t\t\t(at {xr} {yr} 0)\n\t\t\t(effects (font (size 1.27 1.27)))\n\t\t)\n",
                "\t\t(property \"Value\" \"10k\"\n\t\t\t(at {xr} {yv} 0)\n\t\t\t(effects (font (size 1.27 1.27)))\n\t\t)\n",
                "\t\t(property \"Footprint\" \"\"\n\t\t\t(at {x} {y} 0)\n\t\t\t(effects (font (size 1.27 1.27)) (hide yes))\n\t\t)\n",
                "\t\t(property \"Datasheet\" \"\"\n\t\t\t(at {x} {y} 0)\n\t\t\t(effects (font (size 1.27 1.27)) (hide yes))\n\t\t)\n",
                "\t\t(pin \"1\" (uuid \"{p1}\"))\n\t\t(pin \"2\" (uuid \"{p2}\"))\n",
                "\t\t(instances\n\t\t\t(project \"synth\"\n\t\t\t\t(path \"/{root}\"\n\t\t\t\t\t(reference \"R{r}\")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t)\n"
            ),
            x = f(x), y = f(y), u = id(&format!("sym:{k}")), r = k + 1, xr = f(x + 2.54), yr = f(y - 1.27), yv = f(y + 1.27),
            p1 = id(&format!("pin1:{k}")), p2 = id(&format!("pin2:{k}")), root = root
        ));
        for (tag, y0, y1) in [("A", y - 3.81, y - 8.89), ("B", y + 3.81, y + 8.89)] {
            if wires < m {
                s.push_str(&format!("\t(wire\n\t\t(pts (xy {} {}) (xy {} {}))\n\t\t(stroke (width 0) (type default))\n\t\t(uuid \"{}\")\n\t)\n", f(x), f(y0), f(x), f(y1), id(&format!("w:{k}{tag}"))));
                wires += 1;
                push_label(&mut s, k, &format!("N{k}{tag}"), x, y1);
            }
        }
        if k % 4 == 0 {
            s.push_str(&format!("\t(junction\n\t\t(at {} {})\n\t\t(diameter 0)\n\t\t(color 0 0 0 0)\n\t\t(uuid \"{}\")\n\t)\n", f(x), f(y + 8.89), id(&format!("j:{k}"))));
        }
    }
    let mut j = 0usize;
    while wires < m {
        let (col, row) = (j % cols, j / cols);
        let x = 25.4 + col as f64 * 25.4;
        let y = 12.7 + row as f64 * 25.4;
        s.push_str(&format!("\t(wire\n\t\t(pts (xy {} {}) (xy {} {}))\n\t\t(stroke (width 0) (type default))\n\t\t(uuid \"{}\")\n\t)\n", f(x), f(y - 8.89), f(x), f(y + 8.89), id(&format!("x:{j}"))));
        wires += 1;
        let name = format!("X{j}");
        push_label(&mut s, j + 1, &name, x, y - 8.89);
        push_label(&mut s, j + 1, &name, x, y + 8.89);
        j += 1;
    }
    s.push_str("\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n)\n");
    s
}

#[cfg(test)]
mod synth_tests {
    use super::*;
    #[test]
    fn synth_sheet_parses_and_passes_integrity() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("synth.kicad_sch");
        std::fs::write(&p, synth_sheet(20, 60, 7)).unwrap();
        let tree = sch_read::read_project(&p).unwrap();
        assert_eq!(tree.files.values().next().unwrap().symbols.len(), 20);
        let nets = sch_net::build_nets(&tree);
        let mut eng = engine();
        let report = sch_check::gate_run(&tree, &nets, None, Some(&mut eng.lib));
        let integ = report
            .families
            .iter()
            .find(|f| f.name == "integrity")
            .expect("integrity family");
        assert_ne!(integ.status, "fail", "{:?}", integ);
        let g = sch_geom::render_sheet(&tree, "/").unwrap();
        assert_eq!(g.symbols.len(), 20);
        assert_eq!(g.wires.len(), 60);
    }
    #[test]
    fn synth_sheet_is_byte_deterministic() {
        assert_eq!(synth_sheet(5, 12, 3), synth_sheet(5, 12, 3));
        assert_ne!(synth_sheet(5, 12, 3), synth_sheet(5, 12, 4));
    }
}

#[cfg(test)]
mod golden_score_tests {
    use super::golden_score;
    use std::collections::BTreeMap;
    #[test]
    fn score_is_one_on_exact_match_and_partial_otherwise() {
        let mut c = BTreeMap::new();
        c.insert("Device:R|1k|".to_string(), 2usize);
        let mut n = BTreeMap::new();
        n.insert(
            "OUT".to_string(),
            vec!["Device:R|1k|#1".to_string(), "Device:R|1k|#2".to_string()],
        );
        assert_eq!(golden_score(&c, &c, &n, &n, &[], &[]), 1.0);
        let mut c2 = c.clone();
        c2.insert("Device:C|100n|".to_string(), 1);
        let mut n2 = BTreeMap::new();
        n2.insert("OUT".to_string(), vec!["Device:R|1k|#1".to_string()]);
        let s = golden_score(&c, &c2, &n, &n2, &[], &[]);
        assert!(s > 0.5 && s < 1.0, "{s}");
        assert_eq!(
            golden_score(&c, &BTreeMap::new(), &n, &BTreeMap::new(), &[], &[]),
            0.0
        );
    }
}

fn golden(positional: &[String], args: &[String]) -> ! {
    let sub = positional.first().unwrap_or_else(|| usage());
    match sub.as_str() {
        "extract" => {
            let sch = positional.get(1).unwrap_or_else(|| usage());
            let task = arg_after(args, "--task").unwrap_or_else(|| "task".into());
            let tree = load_tree(sch, None);
            let nets = sch_net::build_nets(&tree);
            let anchors: Vec<String> = match arg_after(args, "--task-text") {
                Some(p) => anchors_from_text(
                    &std::fs::read_to_string(&p).unwrap_or_else(|e| fail(4, &e.to_string())),
                    &nets,
                ),
                None => Vec::new(),
            };
            let anchor_set: BTreeSet<String> = anchors.iter().cloned().collect();
            let (components, unnamed, anchored) = canonical(
                &tree,
                &nets,
                if anchors.is_empty() {
                    None
                } else {
                    Some(&anchor_set)
                },
            );
            let exp = Expected {
                schema_version: 1,
                task,
                components,
                nets: unnamed,
                anchored_nets: anchored,
                anchors,
            };
            let v = serde_json::to_value(&exp).unwrap();
            if let Some(o) = arg_after(args, "--out") {
                std::fs::write(o, serde_json::to_string_pretty(&v).unwrap())
                    .unwrap_or_else(|e| fail(4, &e.to_string()));
            }
            out(&v);
            std::process::exit(0)
        }
        "match" => {
            let exp_path = positional.get(1).unwrap_or_else(|| usage());
            let sch = positional.get(2).unwrap_or_else(|| usage());
            let exp: Expected = serde_json::from_str(
                &std::fs::read_to_string(exp_path).unwrap_or_else(|e| fail(4, &e.to_string())),
            )
            .unwrap_or_else(|e| fail(4, &e.to_string()));
            let tree = load_tree(sch, None);
            let nets = sch_net::build_nets(&tree);
            let anchor_set: BTreeSet<String> = exp.anchors.iter().cloned().collect();
            let (components, unnamed, anchored) = canonical(
                &tree,
                &nets,
                if exp.anchors.is_empty() {
                    None
                } else {
                    Some(&anchor_set)
                },
            );
            let mut problems: Vec<String> = Vec::new();
            for (fp, n) in &exp.components {
                let have = components.get(fp).copied().unwrap_or(0);
                if have != *n {
                    problems.push(format!("component {fp}: expected {n}, found {have}"));
                }
            }
            for (fp, n) in &components {
                if !exp.components.contains_key(fp) {
                    problems.push(format!("unexpected component {fp} x{n}"));
                }
            }
            for (name, members) in &exp.anchored_nets {
                match anchored.get(name) {
                    Some(m) if m == members => {}
                    Some(m) => {
                        let want: BTreeSet<&String> = members.iter().collect();
                        let have: BTreeSet<&String> = m.iter().collect();
                        problems.push(format!(
                            "net {name}: missing {:?}, extra {:?}",
                            want.difference(&have).collect::<Vec<_>>(),
                            have.difference(&want).collect::<Vec<_>>()
                        ));
                    }
                    None => {
                        problems.push(format!("net {name}: not found (expected {:?})", members))
                    }
                }
            }
            let exp_unnamed: BTreeMap<&Vec<String>, usize> =
                exp.nets.iter().fold(BTreeMap::new(), |mut m, n| {
                    *m.entry(n).or_default() += 1;
                    m
                });
            let have_unnamed: BTreeMap<&Vec<String>, usize> =
                unnamed.iter().fold(BTreeMap::new(), |mut m, n| {
                    *m.entry(n).or_default() += 1;
                    m
                });
            for (n, c) in &exp_unnamed {
                if have_unnamed.get(n).copied().unwrap_or(0) != *c {
                    problems.push(format!(
                        "unnamed net {:?}: expected {c}, found {}",
                        n,
                        have_unnamed.get(n).copied().unwrap_or(0)
                    ));
                }
            }
            let ok = problems.is_empty();
            let score = golden_score(
                &exp.components,
                &components,
                &exp.anchored_nets,
                &anchored,
                &exp.nets,
                &unnamed,
            );
            out(
                &json!({"schema_version": 1, "ok": ok, "score": score, "task": exp.task, "problems": problems}),
            );
            std::process::exit(if ok { 0 } else { 1 })
        }
        _ => usage(),
    }
}
