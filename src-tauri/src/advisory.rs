// SPDX-License-Identifier: Apache-2.0
//! Optional `kicad-cli` advisory verification (red line 8): sandboxed
//! subprocess, absence non-fatal, never a gate.
//!
//! The ERC report is untrusted input (red line 21) *and* written in whatever language KiCad runs
//! in: its violation and item descriptions are translated, so nothing here reads a translated
//! word. Only the ASCII designator, the item uuid and the numeric position are interpreted; the
//! raw description is passed through unchanged for the harness to show as untrusted text.

use crate::error::err;
use crate::ipc::IpcError;
use crate::state::AppState;
use sch_read::SheetTree;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

/// Locale forced on `kicad-cli` so the report comes back in English where the platform allows it.
/// It does not always: on macOS wxWidgets takes the UI language from the system preferences and
/// ignores the environment (verified with KiCad 10.0.4), so the parsing below stays
/// locale-independent whether or not this has any effect.
const C_LOCALE: &[(&str, &str)] = &[("LC_ALL", "C"), ("LANG", "C"), ("LANGUAGE", "en")];

pub fn run(state: &AppState, project_key: &str, kind: &str) -> Result<Value, IpcError> {
    let h = state.project(project_key)?;
    if !state.settings.read().advanced.sandbox_enabled {
        return Ok(json!({"available": false, "reason": "sandbox disabled"}));
    }
    let cli: Option<PathBuf> = state.env.read().kicad_cli_path.clone().map(PathBuf::from);
    let Some(cli) = cli else {
        return Ok(json!({"available": false, "code": "KICAD_CLI_MISSING"}));
    };
    // `kicad-cli` takes KiCad's own `~<project>.kicad_pro.lck` for the whole run; without this
    // the watcher would report our own advisory as "KiCad has this file open" (`watch.rs`).
    let _busy = h.advisory.enter();
    let tmp = tempfile::tempdir().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    let sch = h.root_sheet.to_string_lossy().to_string();
    match kind {
        "erc" => {
            let out = tmp.path().join("erc.json");
            let outs = out.to_string_lossy().to_string();
            let res = crate::sandbox::run_env(
                &cli,
                &[
                    "sch",
                    "erc",
                    "--format",
                    "json",
                    "--severity-all",
                    "--output",
                    &outs,
                    &sch,
                ],
                Some(&h.root),
                120,
                C_LOCALE,
            )?;
            let report: Value = std::fs::read(&out)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            let tree = crate::treecache::tree(&h.tree_cache, &h.root_sheet).ok();
            let index = tree.as_deref().map(SheetIndex::build).unwrap_or_default();
            let violations = decorate(&report, &index);
            Ok(
                json!({"available": true, "ok": res.status.success(), "violations": violations.iter().take(200).cloned().collect::<Vec<_>>(), "total": violations.len(), "stderr": crate::log::mask(&String::from_utf8_lossy(&res.stderr)), "trust": "untrusted"}),
            )
        }
        "netlist" => {
            let out = tmp.path().join("out.net");
            let outs = out.to_string_lossy().to_string();
            let res = crate::sandbox::run(
                &cli,
                &[
                    "sch",
                    "export",
                    "netlist",
                    "--format",
                    "kicadsexpr",
                    "--output",
                    &outs,
                    &sch,
                ],
                Some(&h.root),
                120,
            )?;
            let text = std::fs::read_to_string(&out).unwrap_or_default();
            let theirs = crate::intake::parse_kicad_netlist(&text);
            let tree = sch_read::read_project(&h.root_sheet)?;
            let ours = sch_net::build_nets(&tree);
            let mut mismatches = Vec::new();
            if let Some(t) = &theirs {
                for n in t["nets"].as_array().cloned().unwrap_or_default() {
                    let name = n["name"].as_str().unwrap_or("");
                    let members: std::collections::BTreeSet<String> = n["members"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    let ours_m: Option<std::collections::BTreeSet<String>> =
                        ours.by_name(name).map(|o| {
                            o.members
                                .iter()
                                .map(|m| format!("{}.{}", m.reference, m.pin))
                                .collect()
                        });
                    if ours_m.as_ref() != Some(&members) {
                        mismatches.push(json!({"net": name, "kicad": members, "engine": ours_m}));
                    }
                }
            }
            Ok(
                json!({"available": true, "ok": res.status.success() && mismatches.is_empty(), "mismatches": mismatches, "trust": "untrusted"}),
            )
        }
        _ => Err(err("BAD_CONFIG", "kind must be erc|netlist")),
    }
}

// ------------------------------------------------------- ERC report decoration

/// Where the parsed tree says an ERC item lives.
#[derive(Clone, Debug, PartialEq)]
struct Loc {
    /// Instance names path (`/`, `/power/`), the form the harness matches sheets on.
    names: String,
    /// Sheet file relative to the project root.
    file: String,
    at: sch_model::Pt,
}

/// Designator and uuid lookup over every sheet instance of the project. `None` marks a key that
/// appears on more than one sheet instance (a sheet instantiated twice, a multi-unit part split
/// across sheets): ambiguous is not attributed at all.
#[derive(Default)]
struct SheetIndex {
    by_ref: HashMap<String, Option<Loc>>,
    by_uuid: HashMap<String, Option<Loc>>,
    /// Instance names path -> sheet file, for violations nothing else resolves.
    files_by_names: HashMap<String, String>,
}

fn insert(map: &mut HashMap<String, Option<Loc>>, key: &str, loc: Loc) {
    match map.get_mut(key) {
        None => {
            map.insert(key.to_string(), Some(loc));
        }
        Some(slot) => {
            if slot.as_ref().is_some_and(|l| l.names != loc.names) {
                *slot = None;
            }
        }
    }
}

impl SheetIndex {
    fn build(tree: &SheetTree) -> SheetIndex {
        let mut ix = SheetIndex::default();
        for inst in &tree.instances {
            let Some(sheet) = tree.sheet(&inst.file) else {
                continue;
            };
            let file = tree.rel_file(&inst.file);
            ix.files_by_names
                .entry(inst.names.clone())
                .or_insert_with(|| file.clone());
            let loc = |at| Loc {
                names: inst.names.clone(),
                file: file.clone(),
                at,
            };
            for s in &sheet.symbols {
                // The reference is per instance path; the property is the fallback for a symbol
                // whose `instances` block does not cover this path.
                let r = s
                    .instances
                    .iter()
                    .find(|i| i.path == inst.path)
                    .map(|i| i.reference.as_str())
                    .unwrap_or(s.reference.as_str());
                insert(&mut ix.by_ref, r, loc(s.placement.at));
            }
            // Only whole objects are indexed by uuid: KiCad reports a symbol *pin* by the pin's
            // own uuid, which the tree does not carry, and those items name a designator anyway.
            for l in &sheet.labels {
                insert(&mut ix.by_uuid, &l.uuid, loc(l.at));
            }
            for j in &sheet.junctions {
                insert(&mut ix.by_uuid, &j.uuid, loc(j.at));
            }
            for n in &sheet.no_connects {
                insert(&mut ix.by_uuid, &n.uuid, loc(n.at));
            }
            for w in &sheet.wires {
                insert(&mut ix.by_uuid, &w.uuid, loc(w.a));
            }
            for b in &sheet.bus_entries {
                insert(&mut ix.by_uuid, &b.uuid, loc(b.at));
            }
            for sh in &sheet.sheets {
                insert(&mut ix.by_uuid, &sh.uuid, loc(sh.at));
                for p in &sh.pins {
                    insert(&mut ix.by_uuid, &p.uuid, loc(p.at));
                }
            }
        }
        ix
    }

    fn resolve(&self, description: &str, uuid: &str) -> Option<&Loc> {
        if let Some(d) = designator_of(description) {
            if let Some(l) = self.by_ref.get(d) {
                return l.as_ref();
            }
        }
        self.by_uuid.get(uuid).and_then(|l| l.as_ref())
    }
}

/// The designator (`R1`, `#PWR02`) an ERC item description names, or `None`. KiCad translates
/// these strings ("Symbol R1 Pin 2 [...]", "Symbol R1 接腳 2 [...]"), so only the ASCII designator
/// token is read; everything from the first `[` is pin detail and is cut off first so a pin name
/// can never be taken for a designator.
fn designator_of(description: &str) -> Option<&str> {
    description
        .split('[')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| matches!(c, ',' | ';' | ':' | '.' | '(' | ')')))
        .find(|t| is_designator(t))
}

/// `#?[A-Z][A-Za-z_]{0,3}[0-9]{1,4}` over the whole token. Whole-token so a quoted label
/// (`Label 'R1'`) is not read as a designator.
fn is_designator(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'#'));
    if b.get(i).is_none_or(|c| !c.is_ascii_uppercase()) {
        return false;
    }
    i += 1;
    let letters = i;
    while b
        .get(i)
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
    {
        i += 1;
    }
    if i - letters > 3 {
        return false;
    }
    let digits = i;
    while b.get(i).is_some_and(|c| c.is_ascii_digit()) {
        i += 1;
    }
    i == b.len() && (1..=4).contains(&(i - digits))
}

/// Mils per unit of `coordinate_units`, or `None` for a unit the report has not declared.
fn unit_to_mil(units: &str) -> Option<f64> {
    match units {
        "mm" => Some(1000.0 / 25.4),
        "in" => Some(1000.0),
        "mils" | "mil" => Some(1.0),
        _ => None,
    }
}

/// Report-wide correction for `kicad-cli`'s item positions. KiCad 10.0.4 writes schematic ERC
/// positions with the PCB internal-unit scale, so every coordinate comes out exactly 100x too
/// small (verified against `tests/conformance/fixtures/hier` in every `--units` mode). The factor
/// is *measured* against positions the parsed tree already knows rather than hard-coded, so a
/// fixed `kicad-cli` keeps working with no change here.
fn position_scale(mut ratios: Vec<f64>) -> f64 {
    if ratios.is_empty() {
        return 1.0;
    }
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if ratios[ratios.len() / 2] > 10.0 {
        100.0
    } else {
        1.0
    }
}

fn item_pos_mil(item: &Value, per_unit: f64) -> Option<[f64; 2]> {
    let p = item.get("pos")?;
    let x = p.get("x")?.as_f64()?;
    let y = p.get("y")?.as_f64()?;
    Some([x * per_unit, y * per_unit])
}

/// Flatten KiCad's per-sheet violation lists into one array, each violation decorated with the
/// sheet, sheet file and canvas anchor the parsed tree agrees on.
///
/// KiCad's own `sheets[].path` is not reliable: 10.0.4 files violations about child-sheet objects
/// under `/` (verified against the `hier` fixture), which put every marker on the root sheet. The
/// designator wins over it; `path` is only the fallback when nothing in the violation resolves.
fn decorate(report: &Value, index: &SheetIndex) -> Vec<Value> {
    let per_unit = report
        .get("coordinate_units")
        .and_then(|u| u.as_str())
        .and_then(unit_to_mil);
    let sheets = report
        .get("sheets")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    // Pass 1: how far off KiCad's own coordinates are from the ones the tree knows.
    let mut ratios = Vec::new();
    if let Some(per_unit) = per_unit {
        for s in &sheets {
            for v in s
                .get("violations")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                for it in v
                    .get("items")
                    .and_then(|i| i.as_array())
                    .into_iter()
                    .flatten()
                {
                    let Some(loc) = resolve_item(index, it) else {
                        continue;
                    };
                    let Some(pos) = item_pos_mil(it, per_unit) else {
                        continue;
                    };
                    let truth = [
                        sch_model::nm_to_mil(loc.at.x),
                        sch_model::nm_to_mil(loc.at.y),
                    ];
                    for a in 0..2 {
                        if pos[a].abs() > 1e-6 && truth[a].abs() > 1.0 {
                            ratios.push(truth[a].abs() / pos[a].abs());
                        }
                    }
                }
            }
        }
    }
    let scale = position_scale(ratios);
    // Pass 2: decorate.
    let mut out = Vec::new();
    for s in &sheets {
        let kicad_path = s
            .get("path")
            .or_else(|| s.get("uuid_path"))
            .and_then(|p| p.as_str())
            .unwrap_or("/");
        for v in s
            .get("violations")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let mut v = v.clone();
            let items: Vec<Value> = v
                .get("items")
                .and_then(|i| i.as_array())
                .cloned()
                .unwrap_or_default();
            let locs: Vec<Option<&Loc>> = items.iter().map(|it| resolve_item(index, it)).collect();
            let mut names: Option<&str> = None;
            let mut conflict = false;
            for l in locs.iter().flatten() {
                match names {
                    None => names = Some(&l.names),
                    Some(n) if n == l.names => {}
                    _ => conflict = true,
                }
            }
            let resolved = if conflict { None } else { names };
            let sheet = resolved.unwrap_or(kicad_path);
            let file = resolved
                .and_then(|_| locs.iter().flatten().next().map(|l| l.file.clone()))
                .or_else(|| index.files_by_names.get(kicad_path).cloned());
            // Anchor: the tree's own position where the item resolved (exact), otherwise KiCad's
            // corrected one so a label- or wire-only violation still gets a canvas marker.
            let at_mil = locs
                .iter()
                .flatten()
                .next()
                .map(|l| [sch_model::nm_to_mil(l.at.x), sch_model::nm_to_mil(l.at.y)])
                .or_else(|| {
                    per_unit
                        .and_then(|u| items.first().and_then(|it| item_pos_mil(it, u)))
                        .map(|p| [p[0] * scale, p[1] * scale])
                });
            if let Some(o) = v.as_object_mut() {
                o.insert("sheet".into(), Value::String(sheet.to_string()));
                if let Some(f) = file {
                    o.insert("file".into(), Value::String(f));
                }
                if let Some(a) = at_mil {
                    o.insert("at_mil".into(), json!([a[0], a[1]]));
                }
            }
            out.push(v);
        }
    }
    out
}

fn resolve_item<'a>(index: &'a SheetIndex, item: &Value) -> Option<&'a Loc> {
    let desc = item
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("");
    let uuid = item.get("uuid").and_then(|u| u.as_str()).unwrap_or("");
    index.resolve(desc, uuid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The `hier` conformance fixture: R1/R2/#PWR01/#PWR02 and the GLB/MIDROOT labels live in
    /// `hier_root.kicad_sch`, R3..R8 in `hier_child.kicad_sch` (instantiated as `/child/`).
    fn index() -> SheetIndex {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/conformance/fixtures/hier/hier_root.kicad_sch");
        SheetIndex::build(&sch_read::read_project(&p).unwrap())
    }

    /// A report shaped like a real `kicad-cli sch erc --format json` run on that fixture, with
    /// KiCad 10.0.4's two quirks reproduced: item descriptions in the user's language, and every
    /// violation filed under the root sheet path. `descriptions` supplies the four item strings.
    fn report(descriptions: [&str; 4]) -> Value {
        json!({
            "coordinate_units": "mm",
            "kicad_version": "10.0.4",
            "sheets": [{
                "path": "/",
                "uuid_path": "/11111111-1111-4111-8111-111111111111",
                "violations": [
                    {"type": "power_pin_not_driven", "severity": "error",
                     "description": "Input Power pin not driven by any Output Power pins",
                     "items": [{"description": descriptions[0], "pos": {"x": 0.4191, "y": 0.508},
                                "uuid": "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"}]},
                    {"type": "multiple_net_names", "severity": "warning", "description": "two names",
                     "items": [
                        {"description": descriptions[1], "pos": {"x": 0.508, "y": 0.5842},
                         "uuid": "aaaaaaaa-aaaa-4aaa-8aaa-000000000011"},
                        {"description": descriptions[2], "pos": {"x": 0.5588, "y": 0.5842},
                         "uuid": "aaaaaaaa-aaaa-4aaa-8aaa-000000000012"}]},
                    {"type": "endpoint_off_grid", "severity": "warning", "description": "off grid",
                     "items": [{"description": descriptions[3], "pos": {"x": 0.508, "y": 0.508},
                                "uuid": "00000000-0000-4000-8000-00000000ffff"}]}
                ]
            }]
        })
    }

    const ZH: [&str; 4] = [
        "Symbol R3 接腳 2 [無源, 線]",
        "全域標籤 'GLB'",
        "標籤 'MIDROOT'",
        "線",
    ];
    const EN: [&str; 4] = [
        "Symbol R3 Pin 2 [Passive, Line]",
        "Global label 'GLB'",
        "Label 'MIDROOT'",
        "Wire",
    ];

    #[test]
    fn designators_survive_translation() {
        assert_eq!(designator_of(ZH[0]), Some("R3"));
        assert_eq!(designator_of(EN[0]), Some("R3"));
        assert_eq!(
            designator_of("Symbol #PWR02 接腳 1 [電源輸入, 線]"),
            Some("#PWR02")
        );
        assert_eq!(
            designator_of("シンボル U12 ピン A3 [入力, 線]"),
            Some("U12")
        );
        // A label is not a designator, whatever it is called and whatever it is named.
        assert_eq!(designator_of("標籤 'MIDROOT'"), None);
        assert_eq!(designator_of("Label '+3V3_LED'"), None);
        assert_eq!(designator_of("Label 'R1'"), None);
        // A pin *name* inside the brackets can never be read as one.
        assert_eq!(designator_of("Wire [R1, Line]"), None);
    }

    #[test]
    fn a_chinese_and_an_english_report_decorate_identically() {
        let ix = index();
        let zh = decorate(&report(ZH), &ix);
        let en = decorate(&report(EN), &ix);
        let strip = |v: &[Value]| -> Vec<Value> {
            v.iter()
                .map(|v| json!({"sheet": v["sheet"], "file": v["file"], "at_mil": v["at_mil"]}))
                .collect()
        };
        assert_eq!(strip(&zh), strip(&en));
    }

    #[test]
    fn the_designator_decides_the_sheet_not_kicads_path() {
        let out = decorate(&report(ZH), &index());
        // R3 lives on the child sheet even though KiCad filed the violation under "/".
        assert_eq!(out[0]["sheet"], json!("/child/"));
        assert_eq!(out[0]["file"], json!("hier_child.kicad_sch"));
        // 41.91 mm / 50.8 mm, from the parsed tree rather than from the report.
        assert_eq!(out[0]["at_mil"], json!([1650.0, 2000.0]));
        // The two labels are both on the root sheet: KiCad's path is right and stays.
        assert_eq!(out[1]["sheet"], json!("/"));
        assert_eq!(out[1]["file"], json!("hier_root.kicad_sch"));
        assert_eq!(out[1]["at_mil"], json!([2000.0, 2300.0]));
        // The raw (untrusted, translated) descriptions are passed through untouched.
        assert_eq!(out[0]["items"][0]["description"], json!(ZH[0]));
    }

    #[test]
    fn an_unresolvable_item_keeps_kicads_sheet_and_gets_a_corrected_anchor() {
        let out = decorate(&report(ZH), &index());
        let v = &out[2];
        assert_eq!(v["sheet"], json!("/"));
        // 0.508 in KiCad's 100x-too-small millimetres is 50.8 mm = 2000 mil. The factor is
        // measured from the violations above, not hard-coded.
        let at = v["at_mil"].as_array().unwrap();
        assert!((at[0].as_f64().unwrap() - 2000.0).abs() < 0.1);
        assert!((at[1].as_f64().unwrap() - 2000.0).abs() < 0.1);
    }

    #[test]
    fn an_uncalibrated_report_is_taken_at_the_units_it_declares() {
        // Nothing resolves, so nothing measures the scale: the declared units are used as they are
        // rather than assuming a broken kicad-cli.
        let ix = SheetIndex::default();
        let out = decorate(&report(ZH), &ix);
        assert_eq!(out[0]["sheet"], json!("/"));
        assert_eq!(out[0]["file"], Value::Null);
        let at = out[0]["at_mil"].as_array().unwrap();
        assert!((at[0].as_f64().unwrap() - 0.4191 * 1000.0 / 25.4).abs() < 1e-6);
    }

    #[test]
    fn units_and_scale() {
        assert_eq!(unit_to_mil("mils"), Some(1.0));
        assert_eq!(unit_to_mil("in"), Some(1000.0));
        assert_eq!(unit_to_mil("furlong"), None);
        assert_eq!(position_scale(vec![]), 1.0);
        assert_eq!(position_scale(vec![100.0, 95.9, 100.0]), 100.0);
        assert_eq!(position_scale(vec![1.0, 0.98, 1.02]), 1.0);
    }

    #[test]
    fn a_report_without_sheets_yields_no_violations() {
        assert!(decorate(&Value::Null, &SheetIndex::default()).is_empty());
        assert!(decorate(&json!({"sheets": "nonsense"}), &SheetIndex::default()).is_empty());
    }
}
