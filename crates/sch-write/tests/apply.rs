// SPDX-License-Identifier: Apache-2.0
use sch_ops::OpList;
use sch_write::{DrawRequest, Engine};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

/// These cases place parts by `lib_id` from KiCad's own symbol libraries, which this
/// repository deliberately does not vendor (`release-process.md`: fluxsmith does not
/// redistribute the libraries), so `engine()` hands the write gate an empty library and
/// every apply is refused with `SYMBOL_NOT_FOUND`. Hosted CI has no KiCad, so they skip
/// there; the conformance runner sets `FLUXSMITH_CONFORMANCE=required`, which turns
/// absence into a hard failure so a skip cannot pass silently where KiCad does exist.
fn kicad_libraries_present() -> bool {
    let (env, table) = sch_read::discover_kicad(None);
    let resolvable = table
        .and_then(|t| sch_read::parse_lib_table(&t, &env, 0).ok())
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if resolvable {
        return true;
    }
    let required = std::env::var("FLUXSMITH_CONFORMANCE")
        .map(|v| v == "required")
        .unwrap_or(false);
    assert!(
        !required,
        "FLUXSMITH_CONFORMANCE=required but KiCad's symbol libraries were not found \
         (install KiCad 10 so sym-lib-table resolves)"
    );
    false
}

macro_rules! need_kicad_libs {
    () => {
        if !kicad_libraries_present() {
            eprintln!("KiCad symbol libraries not installed: case skipped");
            return;
        }
    };
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures")
}

fn engine() -> Engine {
    let (env, table) = sch_read::discover_kicad(None);
    let rows = table
        .map(|t| sch_read::parse_lib_table(&t, &env, 0).unwrap())
        .unwrap_or_default();
    Engine::new(sch_read::SymbolLibrary::new(rows))
}

fn copy_hier(dir: &Path) -> PathBuf {
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fixtures().join("hier").join(f), dir.join(f)).unwrap();
    }
    dir.join("hier_root.kicad_sch")
}

fn req(target: &Path, json: &str) -> DrawRequest {
    DrawRequest {
        target: target.to_path_buf(),
        root: None,
        oplist: OpList::from_json(json).unwrap(),
        strict_nets: true,
        strict_layout: true,
        expected_merges: vec![],
        note: Some("test".into()),
        backup_depth: 2,
        journal: Some(target.parent().unwrap().join(".fluxsmith/journal.jsonl")),
        expected_target_sha: None,
        run_backup_dir: None,
    }
}

fn kicad_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KICAD_CLI") {
        return Some(PathBuf::from(p));
    }
    let found = [
        "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
        "/usr/bin/kicad-cli",
    ]
    .iter()
    .map(Path::new)
    .find(|p| p.exists())
    .map(|p| p.to_path_buf());
    if found.is_none() {
        let required = std::env::var("FLUXSMITH_CONFORMANCE")
            .map(|v| v == "required")
            .unwrap_or(false);
        assert!(!required, "FLUXSMITH_CONFORMANCE=required but kicad-cli was not found (install KiCad 10 or set KICAD_CLI; tests/conformance/env.toml)");
    }
    found
}

fn oracle(sch: &Path) -> Option<BTreeMap<String, BTreeSet<String>>> {
    let cli = kicad_cli()?;
    let out = sch.with_extension("net");
    let st = Command::new(cli)
        .args(["sch", "export", "netlist", "--format", "kicadsexpr", "-o"])
        .arg(&out)
        .arg(sch)
        .output()
        .ok()?;
    assert!(
        st.status.success(),
        "kicad-cli failed: {}",
        String::from_utf8_lossy(&st.stderr)
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&out).ok()?).ok()?;
    let mut m = BTreeMap::new();
    for net in doc.root.find("nets")?.find_all("net") {
        let name = net.find("name")?.arg(0)?;
        let set: BTreeSet<String> = net
            .find_all("node")
            .map(|n| {
                format!(
                    "{}.{}",
                    n.find("ref").unwrap().arg(0).unwrap(),
                    n.find("pin").unwrap().arg(0).unwrap()
                )
            })
            .collect();
        m.insert(name, set);
    }
    Some(m)
}

const OPS: &str = r#"{"protocol_version":1,"groups":{"blk":{"origin_mil":[4000,4000]}},"sheets":{"child":"hier_child.kicad_sch"},"ops":[
  {"op":"add_rectangle","group":"blk","start":[-200,-300],"end":[1400,900],"key":"blk-frame"},
  {"op":"add_text","group":"blk","text":"Test block","at":[-200,-350],"key":"blk-title"},
  {"op":"place_component","group":"blk","lib_id":"Device:R","designator":"R10","x_mil":0,"y_mil":0,"value":"4k7"},
  {"op":"place_component","group":"blk","lib_id":"Device:C","designator":"C10","x_mil":600,"y_mil":-300,"value":"100n","rotation":0},
  {"op":"add_net_label","name":"NEW_SIG","at":"R10.1"},
  {"op":"route_net","from":"R10.2","to":"C10.1"},
  {"op":"add_net_label","name":"MIDNODE","at":"mid(R10.2, C10.1)"},
  {"op":"place_gnd","at":"C10.2"},
  {"op":"place_decoupling","group":"blk","power_net":"+3V3","x_mil":1000,"y_mil":0,"designator":"C11"},
  {"op":"add_no_connect","pin":"R5.2","sheet":"child"},
  {"op":"set_component_parameters","designator":"R1","value":"1k5","parameters":{"MPN":"RC0402FR-071K5L"}},
  {"op":"set_component_attributes","designator":"R2","dnp":true},
  {"op":"set_title_block","title":"fluxsmith test","rev":"A"}
]}"#;

#[test]
fn plan_apply_roundtrip_oracle_and_idempotent() {
    need_kicad_libs!();
    let dir_a = tempfile::tempdir().unwrap();
    let dir_b = tempfile::tempdir().unwrap();
    let ta = copy_hier(dir_a.path());
    let tb = copy_hier(dir_b.path());
    let mut eng = engine();

    // plan first: no write
    let sha0 = sch_write::atomic::file_sha(&ta).unwrap();
    let plan = eng.plan(&req(&ta, OPS)).unwrap();
    assert!(
        plan.refusal.is_none(),
        "plan refused: {:?}\n{:?}",
        plan.refusal,
        plan.integrity_introduced
    );
    assert!(!plan.applied);
    assert_eq!(sch_write::atomic::file_sha(&ta).unwrap(), sha0);
    assert_eq!(plan.counts.components_added, 6); // R10, C10, #PWR (gnd), C11 + its +3V3 and GND ports
    assert!(
        plan.per_op.iter().all(|r| r.status == "ok"),
        "{:?}",
        plan.per_op
    );

    // apply on A and on B: byte-identical outputs (content-addressed identity)
    let ra = eng.apply(&req(&ta, OPS)).unwrap();
    assert!(ra.applied, "{:?}", ra.refusal);
    let rb = eng.apply(&req(&tb, OPS)).unwrap();
    assert!(rb.applied);
    let a = std::fs::read_to_string(&ta).unwrap();
    let b = std::fs::read_to_string(&tb).unwrap();
    assert_eq!(a, b, "apply on two identical copies must be byte-identical");
    assert!(ta.with_file_name("hier_root.kicad_sch.bak").exists());
    assert!(dir_a.path().join(".fluxsmith/journal.jsonl").exists());

    // our own round-trip
    let doc = kicad_sexpr::parse(&a).unwrap();
    assert_eq!(kicad_sexpr::dumps(&doc), a);

    // the written file re-reads and passes integrity with no new errors
    let tree = sch_read::read_project(&ta).unwrap();
    assert!(
        ra.integrity_introduced
            .iter()
            .all(|f| f.severity != sch_write::gates::Severity::Error),
        "{:?}",
        ra.integrity_introduced
    );
    let root = tree.root();
    let r10 = root.symbol_by_ref("R10").next().unwrap();
    assert_eq!(r10.value, "4k7");
    let r1 = root.symbol_by_ref("R1").next().unwrap();
    assert_eq!(r1.value, "1k5");
    assert_eq!(
        r1.properties
            .iter()
            .find(|(k, _)| k == "MPN")
            .map(|(_, v)| v.as_str()),
        Some("RC0402FR-071K5L")
    );
    assert!(root.symbol_by_ref("R2").next().unwrap().dnp);
    assert!(
        root.lib_symbol("Device:C").is_some(),
        "lib_symbols cache gained Device:C"
    );

    // KiCad reads it and agrees on the nets
    if let Some(oracle) = oracle(&ta) {
        let ours = sch_net::build_nets(&tree);
        let mine: BTreeMap<String, BTreeSet<String>> = ours
            .nets
            .iter()
            .map(|n| {
                (
                    n.name.clone(),
                    n.members
                        .iter()
                        .map(|m| format!("{}.{}", m.reference, m.pin))
                        .collect(),
                )
            })
            .collect();
        for (name, members) in &oracle {
            assert_eq!(
                mine.get(name),
                Some(members),
                "net {name} differs from kicad-cli"
            );
        }
        assert!(oracle.contains_key("/NEW_SIG"));
        assert!(oracle.contains_key("/MIDNODE"));
        assert_eq!(
            oracle["+3V3"].len(),
            2,
            "C11 joined +3V3 via place_decoupling: {:?}",
            oracle["+3V3"]
        );
        assert!(oracle["GND"].contains("C10.2"));
    }
}

#[test]
fn gates_refuse_dangling_and_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let dangling =
        r#"{"protocol_version":1,"ops":[{"op":"add_wire","vertices":[[5000,5000],[5500,5000]]}]}"#;
    let r = eng.apply(&req(&t, dangling)).unwrap();
    assert!(!r.applied);
    assert!(
        r.integrity_introduced
            .iter()
            .any(|f| f.code == "DANGLING_ENDPOINT"),
        "{:?}",
        r.refusal
    );
    let dup = r#"{"protocol_version":1,"ops":[{"op":"place_component","lib_id":"Device:R","designator":"R1","x_mil":6000,"y_mil":6000}]}"#;
    let r = eng.apply(&req(&t, dup)).unwrap();
    assert!(!r.applied);
    assert!(r
        .integrity_introduced
        .iter()
        .any(|f| f.code == "DUPLICATE_DESIGNATOR"));
    let missing = r#"{"protocol_version":1,"ops":[{"op":"place_component","lib_id":"Nope:Nothing","designator":"X1","x_mil":6000,"y_mil":6000}]}"#;
    let r = eng.apply(&req(&t, missing)).unwrap();
    assert_eq!(r.per_op[0].error.as_ref().unwrap().code, "SYMBOL_NOT_FOUND");
    // strict nets: merging two named nets is refused
    let merge = r#"{"protocol_version":1,"ops":[{"op":"add_net_label","name":"GLB","at":"R2.1"}]}"#;
    let r = eng.apply(&req(&t, merge)).unwrap();
    assert!(!r.applied && r.net_diff.has_risk, "{:?}", r.net_diff);
}

/// A rename reaches the files the label's own scope reaches, and no others.
#[test]
fn rename_net_scope_is_the_labels_own_scope() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let child = dir.path().join("hier_child.kicad_sch");
    // The root's own local label now spells the same name as an unrelated local label in the child.
    let patched = std::fs::read_to_string(&t)
        .unwrap()
        .replace("(label \"MIDROOT\"", "(label \"MID\"");
    std::fs::write(&t, patched).unwrap();
    let child_before = std::fs::read_to_string(&child).unwrap();
    let mut eng = engine();
    let loose = |target: &Path, json: &str| {
        let mut r = req(target, json);
        r.strict_nets = false;
        r.strict_layout = false;
        r
    };

    // local: the op's own sheet only — the child's same-named label is a different net.
    let r = eng
        .apply(&loose(
            &t,
            r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"MID","new_name":"MIDX"}]}"#,
        ))
        .unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert_eq!(r.targets.len(), 1, "one file written: {:?}", r.targets);
    assert!(r.per_op[0]
        .warnings
        .iter()
        .any(|w| w.contains("local scope")));
    assert!(std::fs::read_to_string(&t)
        .unwrap()
        .contains("(label \"MIDX\""));
    assert_eq!(
        std::fs::read_to_string(&child).unwrap(),
        child_before,
        "the child's own local MID is a different net and must not move"
    );

    // A local name that is not on the target sheet is not found there (it is not silently
    // renamed on the sheet that does carry it).
    let r = eng
        .apply(&loose(
            &t,
            r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"MID","new_name":"NOPE"}]}"#,
        ))
        .unwrap();
    assert!(!r.applied);
    assert_eq!(r.per_op[0].error.as_ref().unwrap().code, "NET_NOT_FOUND");
    assert_eq!(
        std::fs::read_to_string(&child).unwrap(),
        child_before,
        "a refused rename writes nothing"
    );

    // global: every file, because a global name is one net project-wide.
    let r = eng
        .apply(&loose(
            &t,
            r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"GLB","new_name":"GLOBAL_SIG"}]}"#,
        ))
        .unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert_eq!(r.targets.len(), 2, "both files written: {:?}", r.targets);
    assert!(std::fs::read_to_string(&t).unwrap().contains("GLOBAL_SIG"));
    assert!(std::fs::read_to_string(&child)
        .unwrap()
        .contains("GLOBAL_SIG"));

    // hierarchical: the child's label and the parent's sheet pin, which must keep matching.
    let mut hier = loose(
        &child,
        r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"VIN","new_name":"VBUS"}]}"#,
    );
    hier.root = Some(t.clone());
    let r = eng.apply(&hier).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert_eq!(r.targets.len(), 2, "child + parent: {:?}", r.targets);
    assert!(std::fs::read_to_string(&child)
        .unwrap()
        .contains("(hierarchical_label \"VBUS\""));
    assert!(std::fs::read_to_string(&t)
        .unwrap()
        .contains("(pin \"VBUS\""));
}

/// One name spelled as two kinds of label has no single reach: the model is asked for a `scope`.
#[test]
fn rename_net_refuses_an_ambiguous_scope() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let patched = std::fs::read_to_string(&t)
        .unwrap()
        .replace("(label \"MIDROOT\"", "(label \"GLB\"");
    std::fs::write(&t, patched).unwrap();
    let before = std::fs::read_to_string(&t).unwrap();
    let mut eng = engine();
    let r = eng
        .apply(&req(
            &t,
            r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"GLB","new_name":"X"}]}"#,
        ))
        .unwrap();
    assert!(!r.applied);
    let err = r.per_op[0].error.as_ref().unwrap();
    assert_eq!(err.code, "RENAME_SCOPE_AMBIGUOUS");
    assert!(err.message.contains("global") && err.message.contains("local"));
    let ev = err
        .evidence
        .as_ref()
        .expect("evidence names the label and its sheets");
    assert_eq!(ev["name"], "GLB");
    assert_eq!(ev["sheets"].as_array().map(Vec::len), Some(2), "{ev}");
    assert_eq!(std::fs::read_to_string(&t).unwrap(), before);
    // With the scope spelled out it goes through, on the global labels only.
    let mut ok = req(
        &t,
        r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"GLB","new_name":"X","scope":"global"}]}"#,
    );
    ok.strict_nets = false;
    ok.strict_layout = false;
    let r = eng.apply(&ok).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let after = std::fs::read_to_string(&t).unwrap();
    assert!(after.contains("(global_label \"X\"") && after.contains("(label \"GLB\""));
}

/// The same local name on two child sheets is two nets (eeschema dialect). A `rename_net` routed to
/// the default target, which does not carry the name, is refused with `RENAME_SCOPE_AMBIGUOUS`
/// naming both sheets; with `sheet` set it renames that sheet's label only. Regression: "rename
/// NET_X on the power sheet" used to be a generic constraint error with nothing to say which sheets
/// were meant. (A target that does carry the name keeps renaming its own label, see
/// `rename_net_scope_is_the_labels_own_scope`.)
#[test]
fn rename_net_local_label_on_two_sheets_needs_a_sheet() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let child = dir.path().join("hier_child.kicad_sch");
    let power = dir.path().join("power.kicad_sch");
    let mut eng = engine();
    let loose = |json: &str| {
        let mut r = req(&t, json);
        r.strict_nets = false;
        r.strict_layout = false;
        r
    };
    let r = eng
        .apply(&loose(
            r#"{"protocol_version":1,"ops":[
            {"op":"add_sheet","name":"power","file":"power.kicad_sch","at":[6000,3000],"size":[800,600],"pins":[],"create":true}]}"#,
        ))
        .unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let r = eng
        .apply(&loose(
            r#"{"protocol_version":1,"sheets":{"child":"hier_child.kicad_sch","power":"power.kicad_sch"},"ops":[
            {"op":"place_component","lib_id":"Device:R","designator":"R9","value":"1k","x_mil":3000,"y_mil":3000,"sheet":"power"},
            {"op":"add_net_label","name":"SENSE_A","at":"R9.1","scope":"local","sheet":"power"},
            {"op":"add_net_label","name":"SENSE_A","at":"R5.2","scope":"local","sheet":"child"}]}"#,
        ))
        .unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let before = |p: &Path| std::fs::read_to_string(p).unwrap();
    let (root_before, child_before, power_before) = (before(&t), before(&child), before(&power));

    // No `sheet`, and the root has no SENSE_A: refused, the evidence lists the sheets that do.
    let r = eng
        .apply(&loose(
            r#"{"protocol_version":1,"ops":[{"op":"rename_net","old_name":"SENSE_A","new_name":"SENSE_B"}]}"#,
        ))
        .unwrap();
    assert!(!r.applied);
    let err = r.per_op[0].error.as_ref().unwrap();
    assert_eq!(err.code, "RENAME_SCOPE_AMBIGUOUS", "{err:?}");
    assert!(err.remediation.as_deref().unwrap_or("").contains("`sheet`"));
    let ev = err.evidence.as_ref().unwrap();
    assert_eq!(ev["name"], "SENSE_A");
    let mut sheets: Vec<&str> = ev["sheets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap())
        .collect();
    sheets.sort();
    assert_eq!(sheets, ["hier_child.kicad_sch", "power.kicad_sch"]);
    assert_eq!(before(&t), root_before);
    assert_eq!(before(&child), child_before);
    assert_eq!(before(&power), power_before);

    // `sheet` set: that sheet's label is renamed, the other sheet's is left alone.
    let r = eng
        .apply(&loose(
            r#"{"protocol_version":1,"sheets":{"child":"hier_child.kicad_sch"},"ops":[{"op":"rename_net","old_name":"SENSE_A","new_name":"SENSE_B","sheet":"child"}]}"#,
        ))
        .unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert!(before(&child).contains("(label \"SENSE_B\""));
    assert!(!before(&child).contains("(label \"SENSE_A\""));
    assert_eq!(before(&power), power_before);
}

#[test]
fn move_delete_rename_and_sheet_ops() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"R2","x_mil":3600,"y_mil":2600},
      {"op":"rename_net","old_name":"GLB","new_name":"GLOBAL_SIG"},
      {"op":"add_sheet","name":"power","file":"power.kicad_sch","at":[6000,3000],"size":[800,600],"pins":[{"name":"VIN","type":"input","side":"left"},{"name":"VOUT","type":"output","side":"right"}],"create":true},
      {"op":"add_sheet_pin","sheet":"power","name":"EN","type":"input","side":"left"},
      {"op":"delete_component","designator":"R1","cascade":true},
      {"op":"delete_object","match":{"kind":"wire","between":[[2000,1800],[2000,1850]]}},
      {"op":"delete_object","match":{"kind":"wire","between":[[2000,2150],[2000,2300]]}}
    ]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert!(dir.path().join("power.kicad_sch").exists());
    let tree = sch_read::read_project(&t).unwrap();
    assert!(tree.root().symbol_by_ref("R1").next().is_none());
    let r2 = tree.root().symbol_by_ref("R2").next().unwrap();
    assert_eq!(sch_model::nm_to_mil(r2.placement.at.x), 3600.0);
    assert!(
        tree.root().labels.iter().any(|l| l.text == "GLOBAL_SIG")
            && !tree.root().labels.iter().any(|l| l.text == "GLB")
    );
    let child = tree
        .files
        .values()
        .find(|s| s.labels.iter().any(|l| l.text == "GLOBAL_SIG"))
        .is_some();
    assert!(child, "rename must reach the child sheet");
    let ps = tree
        .root()
        .sheets
        .iter()
        .find(|s| s.name == "power")
        .unwrap();
    assert_eq!(ps.pins.len(), 3);
    assert_eq!(tree.instances.len(), 3);
    if kicad_cli().is_some() {
        oracle(&t).expect("kicad-cli must still read the project");
    }
}

#[test]
#[ignore]
fn debug_dump_to_env_dir() {
    let out = PathBuf::from(std::env::var("FLUXSMITH_DEBUG_OUT").unwrap());
    std::fs::create_dir_all(&out).unwrap();
    let t = copy_hier(&out);
    let mut eng = engine();
    let r = eng.apply(&req(&t, OPS)).unwrap();
    eprintln!("{:?}", r.refusal);
    let ops2 = r#"{"protocol_version":1,"ops":[
      {"op":"add_sheet","name":"power","file":"power.kicad_sch","at":[6000,3000],"size":[800,600],"pins":[{"name":"VIN","type":"input","side":"left"},{"name":"VOUT","type":"output","side":"right"}],"create":true},
      {"op":"add_sheet_pin","sheet":"power","name":"EN","type":"input","side":"left"}
    ]}"#;
    let r = eng.apply(&req(&t, ops2)).unwrap();
    eprintln!("{:?}", r.refusal);
}

#[test]
fn placement_nudges_and_layout_gate() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // Two parts authored on top of each other: the second is nudged to a free spot.
    let stacked = r#"{"protocol_version":1,"groups":{"g":{"origin_mil":[0,0],"region_mil":[[5000,5000],[9000,8000]]}},"ops":[
      {"op":"place_component","group":"g","lib_id":"Device:R","designator":"R50","x_mil":6000,"y_mil":6000},
      {"op":"place_component","group":"g","lib_id":"Device:R","designator":"R51","x_mil":6000,"y_mil":6000}]}"#;
    let r = eng.apply(&req(&t, stacked)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    assert!(
        r.per_op[1]
            .warnings
            .iter()
            .any(|w| w.starts_with("PLACEMENT_NUDGED")),
        "{:?}",
        r.per_op[1].warnings
    );
    // A genuine overlap is still resolved by a small nudge: the part stays within the bound
    // (600 mil) of where it was authored, so it is still in the block the author drew.
    let moved = symbol_at(&t, "R51");
    assert!(
        (moved.x - sch_model::mil_to_nm(6000.0))
            .abs()
            .max((moved.y - sch_model::mil_to_nm(6000.0)).abs())
            <= sch_model::mil_to_nm(600.0),
        "{moved:?}"
    );
    assert!(
        r.layout
            .iter()
            .all(|f| f.severity != sch_write::gates::Severity::Error),
        "{:?}",
        r.layout
    );
    // `exact` disables the nudge and the introduced overlap refuses the apply.
    let exact = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R52","x_mil":6000,"y_mil":6000,"exact":true}]}"#;
    let r = eng.plan(&req(&t, exact)).unwrap();
    assert!(!r.applied);
    assert!(
        r.layout.iter().any(|f| f.code == "GROUP_OVERLAP"),
        "{:?}",
        r.layout
    );
    assert!(
        r.refusal.as_deref().unwrap_or("").contains("GROUP_OVERLAP"),
        "{:?}",
        r.refusal
    );
    // arrange_group re-lays exact-stacked parts without overlaps.
    let arrange = r#"{"protocol_version":1,"groups":{"b":{"origin_mil":[0,0],"region_mil":[[1000,5000],[4000,7500]]}},"ops":[
      {"op":"place_component","group":"b","lib_id":"Device:C","designator":"C50","x_mil":2000,"y_mil":6000,"exact":true},
      {"op":"place_component","group":"b","lib_id":"Device:C","designator":"C51","x_mil":2000,"y_mil":6000,"exact":true},
      {"op":"place_component","group":"b","lib_id":"Device:R","designator":"R53","x_mil":2100,"y_mil":6000,"exact":true},
      {"op":"arrange_group","group":"b"}]}"#;
    let r = eng.apply(&req(&t, arrange)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let moved = r.per_op.iter().find(|o| o.op == "arrange_group").unwrap();
    assert!(
        moved
            .warnings
            .iter()
            .filter(|w| w.contains("moved to"))
            .count()
            >= 2,
        "{:?}",
        moved.warnings
    );
    assert!(
        r.layout.iter().all(|f| f.code != "GROUP_OVERLAP"),
        "{:?}",
        r.layout
    );
}

/// Anchor of the placed symbol with that designator.
fn symbol_at(sch: &Path, designator: &str) -> sch_model::Pt {
    let (sheet, _) = sch_read::read_sheet(sch).unwrap();
    sheet
        .symbols
        .iter()
        .find(|s| s.reference == designator)
        .unwrap_or_else(|| panic!("{designator} is not on the sheet"))
        .placement
        .at
}

/// `no_nudge` keeps the authored position without giving up the 50 mil grid snap - the setting a
/// drafter wants when the nudge would break a layout it designed. `exact` keeps the position
/// verbatim, snap included, so it says so (`PLACEMENT_OFF_GRID`) when the result leaves pins off
/// the connection grid: before this, `exact` was the only escape from a nudge and it wrote
/// off-grid silently.
#[test]
fn no_nudge_snaps_without_moving_and_exact_reports_off_grid() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // no_nudge on a free spot: snapped onto the 50 mil grid, otherwise left where it was authored.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R70","x_mil":6000,"y_mil":6000},
      {"op":"place_component","lib_id":"Device:R","designator":"R71","x_mil":7013,"y_mil":7007,"no_nudge":true}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    assert!(
        r.per_op[1]
            .warnings
            .iter()
            .any(|w| w.starts_with("PLACEMENT_SNAPPED")),
        "{:?}",
        r.per_op[1].warnings
    );
    assert!(
        !r.per_op[1]
            .warnings
            .iter()
            .any(|w| w.starts_with("OPLIST_UNKNOWN_FIELD")),
        "no_nudge is a common field, not an unknown one: {:?}",
        r.per_op[1].warnings
    );
    assert_eq!(
        symbol_at(&t, "R71"),
        sch_model::Pt::new(sch_model::mil_to_nm(7000.0), sch_model::mil_to_nm(7000.0))
    );
    // no_nudge on a taken spot: still no nudge, so the overlap reaches the layout gate.
    let stacked = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R72","x_mil":6013,"y_mil":6007,"no_nudge":true}]}"#;
    let r = eng.plan(&req(&t, stacked)).unwrap();
    let w = &r.per_op[0].warnings;
    assert!(
        w.iter()
            .any(|w| w.starts_with("PLACEMENT_SNAPPED") && w.contains("(6000,6000)")),
        "{w:?}"
    );
    assert!(
        !w.iter().any(|w| w.starts_with("PLACEMENT_NUDGED")),
        "{w:?}"
    );
    assert!(!r.applied, "the kept overlap must reach the layout gate");
    // `exact` off the grid: applied as authored, but the op says which pins are off it.
    let off = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R73","x_mil":6033,"y_mil":7000,"exact":true},
      {"op":"place_component","lib_id":"Device:C","designator":"C73","anchor":"R73.1","offset_mil":[600,0],"exact":true}]}"#;
    let r = eng.apply(&req(&t, off)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let w = &r.per_op[0].warnings;
    assert!(
        w.iter()
            .any(|x| x.starts_with("PLACEMENT_OFF_GRID") && x.contains("pin 1")),
        "{w:?}"
    );
    // The relative placement inherits the off-grid anchor: same warning, no snap in between.
    let w = &r.per_op[1].warnings;
    assert!(
        w.iter().any(|x| x.starts_with("PLACEMENT_OFF_GRID")),
        "{w:?}"
    );
    assert_eq!(symbol_at(&t, "R73").x, sch_model::mil_to_nm(6033.0));
    // On the grid, `exact` stays quiet.
    let on = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R74","x_mil":8000,"y_mil":5000,"exact":true}]}"#;
    let r = eng.apply(&req(&t, on)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    assert!(
        !r.per_op[0]
            .warnings
            .iter()
            .any(|w| w.starts_with("PLACEMENT_OFF_GRID")),
        "{:?}",
        r.per_op[0].warnings
    );
}

/// A move is the other way a part reaches a position, so `exact` has to be as loud there as it is on
/// a placement: it skips the same 50 mil snap, and it used to move a part off the connection grid in
/// silence while placing that very part at the same point warned. Without `exact` the move snaps.
#[test]
fn exact_move_reports_off_grid_and_a_plain_move_still_snaps() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let place = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R80","x_mil":8000,"y_mil":6000}]}"#;
    let r = eng.apply(&req(&t, place)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    // `exact` off the grid: moved as authored, and the op names the anchor and the pins that missed it.
    let off = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"R80","x_mil":8033,"y_mil":6000,"exact":true}]}"#;
    let r = eng.apply(&req(&t, off)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let w = &r.per_op[0].warnings;
    assert!(
        w.iter()
            .any(|x| x.starts_with("PLACEMENT_OFF_GRID") && x.contains("pin 1")),
        "{w:?}"
    );
    assert!(
        !w.iter().any(|x| x.starts_with("PLACEMENT_SNAPPED")),
        "`exact` keeps the position: {w:?}"
    );
    assert_eq!(symbol_at(&t, "R80").x, sch_model::mil_to_nm(8033.0));
    // Without `exact` the destination is snapped, as before, and nothing is off the grid to report.
    let plain = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"R80","x_mil":7013,"y_mil":7007}]}"#;
    let r = eng.apply(&req(&t, plain)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let w = &r.per_op[0].warnings;
    assert!(
        w.iter().any(|x| x.starts_with("PLACEMENT_SNAPPED")),
        "{w:?}"
    );
    assert!(
        !w.iter().any(|x| x.starts_with("PLACEMENT_OFF_GRID")),
        "{w:?}"
    );
    assert_eq!(
        symbol_at(&t, "R80"),
        sch_model::Pt::new(sch_model::mil_to_nm(7000.0), sch_model::mil_to_nm(7000.0))
    );
    // On the grid, an `exact` move stays quiet.
    let on = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"R80","x_mil":7500,"y_mil":7000,"exact":true}]}"#;
    let r = eng.apply(&req(&t, on)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    assert!(
        !r.per_op[0]
            .warnings
            .iter()
            .any(|x| x.starts_with("PLACEMENT_OFF_GRID")),
        "{:?}",
        r.per_op[0].warnings
    );
}

/// A crowded spot used to teleport the part: the ring search walked out to 3000 mil, so a real run
/// moved a diode 2600 mil away from the resistor it belonged with and the model answered with
/// `exact` on everything. The search now stops at 600 mil and refuses the op instead, naming what
/// is in the way so the next attempt can pick another spot.
#[test]
fn a_nudge_beyond_the_bound_is_refused_and_names_the_blocker() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // Fixture: a block of parts around (6000,6000), placed where authored (no_nudge). Their
    // property texts crowd each other, which is the point - the layout gate is off for the setup.
    let mut ops = String::from(r#"{"protocol_version":1,"ops":["#);
    let mut n = 80;
    for x in [5200, 5600, 6000, 6400, 6800] {
        for y in [5600, 6000, 6400] {
            if n > 80 {
                ops.push(',');
            }
            ops.push_str(&format!(
                r#"{{"op":"place_component","lib_id":"Device:R","designator":"R{n}","x_mil":{x},"y_mil":{y},"no_nudge":true}}"#
            ));
            n += 1;
        }
    }
    ops.push_str("]}");
    let mut fixture = req(&t, &ops);
    fixture.strict_layout = false;
    let r = eng.apply(&fixture).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    assert!(
        r.per_op
            .iter()
            .all(|o| !o.warnings.iter().any(|w| w.starts_with("PLACEMENT_NUDGED"))),
        "no_nudge must not move any of them"
    );
    // One more part in the middle of that block: every spot within 600 mil is taken.
    let one_more = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R99","x_mil":6000,"y_mil":6000}]}"#;
    let r = eng.plan(&req(&t, one_more)).unwrap();
    assert!(!r.applied);
    let err = r.per_op[0].error.as_ref().expect("a per-op error");
    assert_eq!(err.code, "PLACEMENT_BLOCKED");
    assert!(
        err.message.contains("R8") || err.message.contains("R9"),
        "the blocker must be named: {}",
        err.message
    );
    assert!(err.message.contains("600 mil"), "{}", err.message);
    assert!(
        r.refusal
            .as_deref()
            .unwrap_or("")
            .contains("PLACEMENT_BLOCKED"),
        "{:?}",
        r.refusal
    );
    // Same spot with `no_nudge`: the author keeps it, the layout gate judges the overlap.
    let kept = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R99","x_mil":6000,"y_mil":6000,"no_nudge":true}]}"#;
    let r = eng.plan(&req(&t, kept)).unwrap();
    assert!(r.per_op[0].error.is_none(), "{:?}", r.per_op[0].error);
}

fn power_ports(sch: &Path) -> Vec<(String, String, i64, sch_model::Pt)> {
    let (sheet, _) = sch_read::read_sheet(sch).unwrap();
    sheet
        .symbols
        .iter()
        .filter(|s| s.reference.starts_with('#'))
        .map(|s| {
            (
                s.uuid.clone(),
                s.value.clone(),
                s.placement.rot.deg(),
                s.placement.at,
            )
        })
        .collect()
}

#[test]
fn power_ports_orient_from_the_pin_and_stub_sideways() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // R60 upright: pin 1 up, pin 2 down. R61 rotated: pins sideways.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R60","x_mil":6000,"y_mil":7000,"exact":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R61","x_mil":8000,"y_mil":7000,"rotation":90,"exact":true},
      {"op":"place_gnd","at":"R60.2"},
      {"op":"place_power_port","lib_id":"power:+3V3","net_name":"+3V3","at":"R60.1"},
      {"op":"place_gnd","at":"R61.1","net_name":"GND"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let ports = power_ports(&t);
    let gnd_down = ports
        .iter()
        .find(|p| p.1 == "GND" && p.3.x == sch_model::mil_to_nm(6000.0))
        .expect("GND on R60.2");
    assert_eq!(
        gnd_down.2, 0,
        "GND on a downward pin sits at the tip pointing down"
    );
    let vcc = ports.iter().find(|p| p.1 == "+3V3").expect("+3V3 on R60.1");
    assert_eq!(vcc.2, 0, "a rail on an upward pin points up");
    // The sideways GND turns the corner on an L of wire and still points down.
    let stub = r.per_op[4]
        .created
        .iter()
        .filter(|c| c.kind == "wire")
        .count();
    assert_eq!(stub, 2, "{:?}", r.per_op[4]);
    let side_uuid = r.per_op[4]
        .created
        .iter()
        .find(|c| c.kind == "power_port")
        .unwrap()
        .uuid
        .clone();
    let gnd_side = ports
        .iter()
        .find(|p| p.0 == side_uuid)
        .expect("GND on R61.1");
    assert_eq!(gnd_side.2, 0);
    assert_eq!(
        gnd_side.3.y,
        sch_model::mil_to_nm(7100.0),
        "the port drops one grid square below the pin row instead of standing in it"
    );
    assert!(
        r.bbox_mil.is_some(),
        "apply reports the bbox of what it created"
    );
    // Style check: clean now; a flipped GND is flagged (by uuid, so the ref renumbering does not matter).
    let tree = sch_read::read_project(&t).unwrap();
    let style = sch_write::gates::style(&tree);
    assert!(
        style.iter().all(|f| f.code != "POWER_PORT_ORIENTATION"),
        "{style:?}"
    );
    let flip = format!(
        r#"{{"protocol_version":1,"ops":[{{"op":"set_component_transform","uuid":"{}","rotation":180}}]}}"#,
        gnd_down.0
    );
    let r = eng.apply(&req(&t, &flip)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let tree = sch_read::read_project(&t).unwrap();
    let style = sch_write::gates::style(&tree);
    let f = style
        .iter()
        .find(|f| f.code == "POWER_PORT_ORIENTATION")
        .expect("flipped GND flagged");
    assert_eq!(f.location, format!("style:power:{}", gnd_down.0));
    // Moving R61 by uuid carries the stub and its GND along.
    let (sheet, _) = sch_read::read_sheet(&t).unwrap();
    let r61 = sheet
        .symbols
        .iter()
        .find(|s| s.reference == "R61")
        .unwrap()
        .uuid
        .clone();
    let mv = format!(
        r#"{{"protocol_version":1,"ops":[{{"op":"move_component","uuid":"{r61}","x_mil":8000,"y_mil":8000}}]}}"#
    );
    let r = eng.apply(&req(&t, &mv)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let ports = power_ports(&t);
    let gnd_side = ports.iter().find(|p| p.0 == gnd_side.0).unwrap();
    assert_eq!(
        gnd_side.3.y,
        sch_model::mil_to_nm(8100.0),
        "carried power port moved with its host"
    );
}

/// A port whose glyph would land on a *neighbouring* part's property text slides further
/// along the pin on its stub wire until the layout check is clean again. C71's value text
/// runs under R71's lower pin; the GND port on that pin clears it with one 100 mil step.
#[test]
fn port_stub_clears_a_neighbours_property_text() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:C","designator":"C71","x_mil":6150,"y_mil":5600,"value":"100nF_16V","exact":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R71","x_mil":6450,"y_mil":5500,"value":"10k","exact":true},
      {"op":"place_gnd","at":"R71.2"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let gnd = &r.per_op[2];
    assert!(
        gnd.warnings
            .iter()
            .any(|w| w.starts_with("PORT_STUB_EXTENDED") && w.contains("100 mil")),
        "{gnd:?}"
    );
    assert_eq!(
        gnd.created.iter().filter(|c| c.kind == "wire").count(),
        1,
        "the port hangs on one stub wire: {gnd:?}"
    );
    // R71 pin 2 is at y 5650; the port sits 100 mil further down, on the 50 mil grid.
    let port = power_ports(&t)
        .into_iter()
        .find(|p| p.1 == "GND" && p.3.x == sch_model::mil_to_nm(6450.0))
        .expect("GND on R71.2");
    assert_eq!(port.3.y, sch_model::mil_to_nm(5750.0));
    assert_eq!(port.2, 0, "the port still points down");
    // The overlap it was moved out of is gone, and it is still on the pin's net.
    let tree = sch_read::read_project(&t).unwrap();
    let found = sch_write::gates::overlap(&tree);
    assert!(found.iter().all(|f| f.code != "TEXT_OVERLAP"), "{found:?}");
    let nets = sch_net::nets_of(&t).unwrap();
    let gnd_net = nets.by_name("GND").expect("GND net");
    assert!(
        gnd_net
            .members
            .iter()
            .any(|m| m.reference == "R71" && m.pin == "2"),
        "{:?}",
        gnd_net.members
    );
}

/// The stub search is bounded, and when it runs out it says so. R80 lies across the pin's
/// line with its autoplaced Reference 70 mil below the tip and its long value 170 mil below
/// that, and its body 350 mil below that again - more than the 300 mil ceiling - so nothing
/// straight down the pin is clear; R81 and R82 put a pin on the row either side of C80.2, so
/// every step aside would draw a wire across a foreign pin and is refused too. The port is
/// then placed at the pin tip anyway, `PORT_STUB_BLOCKED` names the situation (it is never
/// silent - a run put a `+3V3` port on a neighbouring capacitor's value that way), and the
/// layout check reports the overlap (the remedy is then to move the part, not the port). R80
/// is turned a quarter turn because eeschema's field autoplace puts a vertical two-pin
/// part's texts beside it, clear of its own pin lines.
#[test]
fn port_stub_extension_is_bounded_and_says_so() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R80","x_mil":7000,"y_mil":6000,"rotation":90,"value":"100k_0402_1PCT_LONGXY","exact":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R81","x_mil":6900,"y_mil":5800,"value":"1k","exact":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R82","x_mil":7100,"y_mil":5800,"value":"1k","exact":true},
      {"op":"place_component","lib_id":"Device:C","designator":"C80","x_mil":7000,"y_mil":5500,"value":"100n","exact":true},
      {"op":"place_gnd","at":"C80.2"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let gnd = r.per_op.last().expect("the place_gnd result");
    assert!(
        !gnd.warnings
            .iter()
            .any(|w| w.starts_with("PORT_STUB_EXTENDED")),
        "{gnd:?}"
    );
    assert!(
        gnd.warnings
            .iter()
            .any(|w| w.starts_with("PORT_STUB_BLOCKED")),
        "a port the search could not clear is never placed silently: {gnd:?}"
    );
    assert!(
        gnd.created.iter().all(|c| c.kind != "wire"),
        "no stub: the port stays on the pin tip {gnd:?}"
    );
    let port = power_ports(&t)
        .into_iter()
        .find(|p| p.1 == "GND" && p.3.x == sch_model::mil_to_nm(7000.0))
        .expect("GND on C80.2");
    assert_eq!(port.3.y, sch_model::mil_to_nm(5650.0), "on the pin tip");
    let tree = sch_read::read_project(&t).unwrap();
    let found = sch_write::gates::overlap(&tree);
    let f = found
        .iter()
        .find(|f| f.code == "TEXT_OVERLAP")
        .expect("the check reports what the writer could not clear");
    assert!(f.refs.contains(&"R80".to_string()), "{f:?}");
    let nets = sch_net::nets_of(&t).unwrap();
    assert!(nets
        .by_name("GND")
        .expect("GND net")
        .members
        .iter()
        .any(|m| m.reference == "C80" && m.pin == "2"));
}

#[test]
fn keyed_frames_are_idempotent_and_rows_align() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let frame = |x: i64| {
        format!(
            r#"{{"protocol_version":1,"ops":[
      {{"op":"add_rectangle","start":[{x},5000],"end":[{},7000],"key":"frame:b"}},
      {{"op":"add_text","text":"Block B","at":[{x},4900],"key":"title:b"}}]}}"#,
            x + 2000
        )
    };
    eng.apply(&req(&t, &frame(1000))).unwrap();
    let r = eng.apply(&req(&t, &frame(1200))).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let text = std::fs::read_to_string(&t).unwrap();
    // top-level rectangles only (symbol bodies in lib_symbols also contain rectangles)
    assert_eq!(
        text.matches("\n\t(rectangle").count(),
        1,
        "the keyed rectangle was replaced, not duplicated"
    );
    assert_eq!(text.matches("\"Block B\"").count(), 1);
    // Rows: three passives at staggered heights end up with aligned bottoms after arrange_group.
    let stagger = r#"{"protocol_version":1,"groups":{"b":{"origin_mil":[0,0],"region_mil":[[1000,5000],[4000,7500]]}},"ops":[
      {"op":"place_component","group":"b","lib_id":"Device:C","designator":"C60","x_mil":1500,"y_mil":6000,"exact":true},
      {"op":"place_component","group":"b","lib_id":"Device:R","designator":"R62","x_mil":2300,"y_mil":6000,"exact":true},
      {"op":"place_component","group":"b","lib_id":"Device:C","designator":"C61","x_mil":3100,"y_mil":5950,"exact":true},
      {"op":"place_gnd","at":"C60.2"}]}"#;
    let r = eng.apply(&req(&t, stagger)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let gnd_uuid = r.per_op[3]
        .created
        .iter()
        .find(|c| c.kind == "power_port")
        .unwrap()
        .uuid
        .clone();
    let tree = sch_read::read_project(&t).unwrap();
    {
        let (sheet, doc) = sch_read::read_sheet(&t).unwrap();
        let (sheet, doc) = (&sheet, &doc);
        let dbg: Vec<(String, i64, usize)> = sheet
            .symbols
            .iter()
            .filter(|s| ["C60", "R62", "C61"].contains(&s.reference.as_str()))
            .map(|s| {
                (
                    s.reference.clone(),
                    sch_model::nm_to_mil(sch_read::bbox::symbol_bbox(doc, s).unwrap().max.y) as i64,
                    sheet
                        .lib_symbol(&s.lib_id)
                        .map(|l| l.pins_for_unit(s.unit).count())
                        .unwrap_or(99),
                )
            })
            .collect();
        assert!(
            sch_write::gates::style(&tree)
                .iter()
                .any(|f| f.code == "ROW_MISALIGNED"),
            "staggered row is reported: {dbg:?} {:?}",
            sch_write::gates::style(&tree)
        );
    }
    let r = eng.apply(&req(&t, r#"{"protocol_version":1,"groups":{"b":{"origin_mil":[0,0],"region_mil":[[1000,5000],[4000,7500]]}},"ops":[{"op":"arrange_group","group":"b"}]}"#)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let tree = sch_read::read_project(&t).unwrap();
    let (sheet, doc) = sch_read::read_sheet(&t).unwrap();
    let (sheet, doc) = (&sheet, &doc);
    let bottoms: Vec<i64> = sheet
        .symbols
        .iter()
        .filter(|s| ["C60", "R62", "C61"].contains(&s.reference.as_str()))
        .map(|s| sch_read::bbox::symbol_bbox(doc, s).unwrap().max.y)
        .collect();
    assert_eq!(bottoms.len(), 3);
    assert!(
        bottoms
            .iter()
            .all(|b| (b - bottoms[0]).abs() <= sch_model::mil_to_nm(50.0)),
        "{bottoms:?}"
    );
    assert!(sch_write::gates::style(&tree)
        .iter()
        .all(|f| f.code != "ROW_MISALIGNED"));
    // The GND hanging off C60 followed it.
    let gnd = sheet.symbols.iter().find(|s| s.uuid == gnd_uuid).unwrap();
    let c60 = sheet.symbols.iter().find(|s| s.reference == "C60").unwrap();
    let pins: Vec<_> = sch_model::world_pins(c60, sheet.lib_symbol(&c60.lib_id).unwrap())
        .into_iter()
        .map(|p| p.at)
        .collect();
    let gpin = sch_model::world_pins(gnd, sheet.lib_symbol(&gnd.lib_id).unwrap())[0].at;
    assert!(
        pins.contains(&gpin),
        "GND pin still on C60: {pins:?} vs {gpin:?}"
    );
}

#[test]
fn wires_snap_to_grid_and_off_grid_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // Labels on both ends keep the wires connected; the first wire is 13 mil off grid (snaps),
    // the second 20 mil off (beyond the 15 mil tolerance: stays, and style() reports it).
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"add_net_label","at":[5000,7000],"name":"WA"},{"op":"add_net_label","at":[5300,7000],"name":"WA"},
      {"op":"add_wire","vertices":[[5000,7013],[5300,7013]]},
      {"op":"add_net_label","at":[5000,7530],"name":"WB"},{"op":"add_net_label","at":[5300,7530],"name":"WB"},
      {"op":"add_wire","vertices":[[5000,7530],[5300,7530]]}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    assert!(
        r.per_op[2]
            .warnings
            .iter()
            .any(|w| w.starts_with("WIRE_SNAPPED")),
        "{:?}",
        r.per_op[2].warnings
    );
    assert!(
        r.per_op[5]
            .warnings
            .iter()
            .all(|w| !w.starts_with("WIRE_SNAPPED")),
        "{:?}",
        r.per_op[5].warnings
    );
    let tree = sch_read::read_project(&t).unwrap();
    let style = sch_write::gates::style(&tree);
    assert!(
        style
            .iter()
            .any(|f| f.code == "OFF_GRID" && f.location.starts_with("style:wire:")),
        "{:?}",
        style
    );
}

/// reg: a PWR_FLAG requested on a pin that already carries a power port must not stack on it
/// (POWER_PORT_STACKED refused every ercfix in the 2026-08-30 golden run); it hangs 100 mil to
/// the side on a short wire and stays electrically on the same net.
#[test]
fn reg_pwr_flag_on_occupied_pin_moves_aside() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R70","x_mil":6000,"y_mil":6000,"value":"1k"},
      {"op":"add_net_label","name":"SIG70","at":"R70.1"},
      {"op":"place_gnd","at":"R70.2"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let flag = r#"{"protocol_version":1,"ops":[{"op":"place_pwr_flag","at":"R70.2"}]}"#;
    let r = eng.apply(&req(&t, flag)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.integrity_introduced);
    assert!(!r
        .integrity_introduced
        .iter()
        .any(|f| f.code == "POWER_PORT_STACKED"));
    assert!(
        !r.layout.iter().any(|f| f.code == "SYMBOL_OVERLAP"),
        "flag beside its port is not an overlap: {:?}",
        r.layout
    );
    assert!(
        r.counts.wires_added >= 1,
        "flag should sit on a short wire: {:?}",
        r.counts
    );
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::build_nets(&tree);
    let gnd = nets.nets.iter().find(|n| n.name == "GND").expect("GND net");
    assert!(gnd.flagged, "PWR_FLAG must be on the GND net");
}

/// reg: on a 100 mil-pitch header the flag's side offset must not land on the neighbouring pin
/// (that merged VBUS with D+ in the 2026-08-30 golden run: strict_nets refusal, no flag placed).
#[test]
fn reg_pwr_flag_beside_header_pin_does_not_touch_neighbour() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // rotation 90: pins point up/down so the GND port sits directly on pin 4 (no stub)
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Connector_Generic:Conn_01x04","designator":"J70","x_mil":7000,"y_mil":7000,"rotation":90},
      {"op":"add_net_label","name":"H70_1","at":"J70.1"},
      {"op":"add_net_label","name":"H70_2","at":"J70.2"},
      {"op":"add_net_label","name":"H70_3","at":"J70.3"},
      {"op":"place_gnd","at":"J70.4"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let flag = r#"{"protocol_version":1,"ops":[{"op":"place_pwr_flag","at":"J70.4"}]}"#;
    let r = eng.apply(&req(&t, flag)).unwrap();
    assert!(
        r.applied,
        "{:?} {:?} {:?}",
        r.refusal, r.integrity_introduced, r.net_diff
    );
    assert!(
        !r.layout.iter().any(|f| f.code == "SYMBOL_OVERLAP"),
        "{:?}",
        r.layout
    );
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::build_nets(&tree);
    let gnd = nets.nets.iter().find(|n| n.name == "GND").expect("GND net");
    assert!(gnd.flagged);
    assert!(
        gnd.members
            .iter()
            .all(|m| m.reference != "J70" || m.pin == "4"),
        "flag wire merged a neighbouring header pin: {:?}",
        gnd.members
    );
    assert!(
        nets.nets
            .iter()
            .any(|n| n.name.trim_start_matches('/') == "H70_3" && n.members.len() == 1),
        "H70_3 must stay separate"
    );
}

/// reg: `place_array` could place parts but not wire them, so a real model's `pin1_labels` /
/// `pin2_rail` were dropped and all eight pins of a four-resistor array floated. One macro now
/// draws the whole block: a label per element on pin 1, one rail port per element on pin 2, and
/// the layout check stays clean at the 400 mil pitch of a row of vertical passives.
#[test]
fn reg_place_array_labels_and_rail_terminate_every_pin() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_array","lib_id":"Device:R","designator_prefix":"R","count":4,"start_index":11,
       "x_mil":7000,"y_mil":3000,"pitch_mil":400,"direction":"right","value":"10k",
       "pin1_labels":["IN0","IN1","IN2","IN3"],"pin2_rail":"GND"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert!(r.per_op.iter().all(|o| o.status == "ok"), "{:?}", r.per_op);
    assert_eq!(r.counts.components_added, 8, "4 resistors + 4 GND ports");
    let nets = sch_net::nets_of(&t).unwrap();
    // A local label carries its sheet path: on the root sheet `IN0` is the net `/IN0`.
    for (k, name) in ["/IN0", "/IN1", "/IN2", "/IN3"].iter().enumerate() {
        let n = nets
            .by_name(name)
            .unwrap_or_else(|| panic!("{name} exists"));
        assert_eq!(n.members.len(), 1, "{name}: {:?}", n.members);
        let m = n.members.iter().next().unwrap();
        assert_eq!(m.reference, format!("R{}", 11 + k));
        assert_eq!(m.pin, "1");
    }
    let gnd = nets.by_name("GND").expect("GND net");
    let array_on_gnd: Vec<&str> = gnd
        .members
        .iter()
        .filter(|m| ["R11", "R12", "R13", "R14"].contains(&m.reference.as_str()))
        .map(|m| m.pin.as_str())
        .collect();
    assert_eq!(array_on_gnd, vec!["2", "2", "2", "2"], "{:?}", gnd.members);
    // Nothing floats: no pin of the array shows up on an unconnected net.
    assert!(
        !nets.nets.iter().any(|n| n.name.starts_with("unconnected-")
            && n.members
                .iter()
                .any(|m| m.reference.starts_with("R1") && m.reference.len() == 3)),
        "{:?}",
        nets.nets.iter().map(|n| n.name.clone()).collect::<Vec<_>>()
    );
    // The labels and the rail ports keep out of each other's way.
    let tree = sch_read::read_project(&t).unwrap();
    let found = sch_write::gates::overlap(&tree);
    assert!(
        found
            .iter()
            .all(|f| f.code != "TEXT_OVERLAP" && f.code != "LABEL_OVER_BODY"),
        "{found:?}"
    );

    // Marching along the pin axis, the same wiring at a 400 mil pitch would drop each label on
    // the next body: the macro clamps the pitch and the check stays clean.
    let down = r#"{"protocol_version":1,"ops":[
      {"op":"place_array","lib_id":"Device:R","designator_prefix":"R","count":3,"start_index":21,
       "x_mil":9000,"y_mil":2000,"pitch_mil":400,"direction":"down","value":"1k",
       "pin1_nets":["A0","A1","A2"],"pin2_rail":"GND"}]}"#;
    let r = eng.apply(&req(&t, down)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let tree = sch_read::read_project(&t).unwrap();
    let found = sch_write::gates::overlap(&tree);
    assert!(
        found
            .iter()
            .all(|f| f.code != "TEXT_OVERLAP" && f.code != "LABEL_OVER_BODY"),
        "{found:?}"
    );
    let nets = sch_net::nets_of(&t).unwrap();
    for name in ["/A0", "/A1", "/A2"] {
        assert_eq!(nets.by_name(name).unwrap().members.len(), 1, "{name}");
    }
}

/// A field no branch of the parser reads is reported on the op it was written on, instead of
/// being dropped in silence (`OPLIST_UNKNOWN_FIELD`, per-op warning of plan / apply).
#[test]
fn reg_unknown_op_field_is_reported_in_per_op() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R31","x_mil":7000,"y_mil":6000,"vaule":"10k"},
      {"op":"add_net_label","name":"SIG","at":"R31.1"}]}"#;
    let r = eng.plan(&req(&t, ops)).unwrap();
    assert!(r.refusal.is_none(), "{:?}", r.refusal);
    let w = &r.per_op[0].warnings;
    assert!(
        w.iter()
            .any(|w| w.starts_with("OPLIST_UNKNOWN_FIELD:") && w.contains("`vaule`")),
        "{w:?}"
    );
    assert!(r.per_op[1].warnings.is_empty(), "{:?}", r.per_op[1]);
}

/// What the turn drew, in the engine's own words: `per_op[].created` carries the designator and
/// value of a symbol, the net name of a label or power port, and the file the op landed on;
/// `per_op[].changed` carries the before/after of a field an op replaced. This is the only source
/// the UI has for "Added: R10 4k7" / "Changed: R1 Value 1k -> 1k5", so it is asserted here.
#[test]
fn created_and_changed_name_what_the_oplist_drew() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let r = eng.plan(&req(&t, OPS)).unwrap();
    assert!(r.refusal.is_none(), "{:?}", r.refusal);
    let created: Vec<&sch_write::handlers::Created> =
        r.per_op.iter().flat_map(|o| o.created.iter()).collect();

    let r10 = created
        .iter()
        .find(|c| c.reference.as_deref() == Some("R10"))
        .expect("the placed resistor is reported by designator");
    assert_eq!(r10.kind, "symbol");
    assert_eq!(r10.value.as_deref(), Some("4k7"));
    assert_eq!(r10.sheet.as_deref(), Some("hier_root.kicad_sch"));

    assert!(
        created
            .iter()
            .any(|c| c.kind == "label" && c.name.as_deref() == Some("NEW_SIG")),
        "a label carries the net it names: {created:?}"
    );
    let gnd = created
        .iter()
        .find(|c| c.kind == "power_port" && c.name.as_deref() == Some("GND"))
        .expect("a power port carries its net name");
    assert!(
        gnd.reference.as_deref().unwrap_or("").starts_with('#'),
        "{gnd:?}"
    );
    // Objects with nothing to name stay as they were: kind, uuid and the sheet they landed on.
    let wire = created.iter().find(|c| c.kind == "wire").unwrap();
    assert!(wire.reference.is_none() && wire.value.is_none() && wire.name.is_none());
    assert_eq!(wire.sheet.as_deref(), Some("hier_root.kicad_sch"));

    let changed: Vec<&sch_write::handlers::Changed> =
        r.per_op.iter().flat_map(|o| o.changed.iter()).collect();
    let value = changed
        .iter()
        .find(|c| c.reference == "R1" && c.field == "Value")
        .expect("set_component_parameters reports the value it replaced");
    assert_eq!((value.before.as_str(), value.after.as_str()), ("1k", "1k5"));
    assert_eq!(value.sheet.as_deref(), Some("hier_root.kicad_sch"));
    assert!(
        changed
            .iter()
            .any(|c| c.reference == "R1" && c.field == "MPN" && c.before.is_empty()),
        "a new custom property has an empty before: {changed:?}"
    );
    // A field written with the value it already had is not a change.
    let same = r#"{"protocol_version":1,"ops":[
      {"op":"set_component_parameters","designator":"R1","value":"1k"}]}"#;
    let r2 = eng.plan(&req(&t, same)).unwrap();
    assert!(r2.per_op[0].changed.is_empty(), "{:?}", r2.per_op[0]);
}

/// A move is a change to a part that already existed and is reported like one (P0-2): `changed`
/// carries the pose before and after, so a "move the block" turn no longer summarises as zeros and
/// the canvas can highlight the part. Moving a part to where it already is changes nothing.
#[test]
fn a_move_reports_the_pose_it_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"R2","x_mil":3600,"y_mil":2600}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let c = r.per_op[0]
        .changed
        .iter()
        .find(|c| c.reference == "R2" && c.field == "at")
        .expect("a move reports its pose change");
    assert!(c.after.starts_with("(3600,2600,"), "{c:?}");
    assert_ne!(c.before, c.after);
    assert_eq!(c.sheet.as_deref(), Some("hier_root.kicad_sch"));
    let again = eng.plan(&req(&t, ops)).unwrap();
    assert!(again.per_op[0].changed.is_empty(), "{:?}", again.per_op[0]);
    // A re-pose is a change of the same field.
    let turn = r#"{"protocol_version":1,"ops":[
      {"op":"set_component_transform","designator":"R2","rotation":90}]}"#;
    let r2 = eng.plan(&req(&t, turn)).unwrap();
    let c2 = r2.per_op[0]
        .changed
        .iter()
        .find(|c| c.reference == "R2" && c.field == "at")
        .expect("a rotation reports its pose change");
    assert!(c2.after.ends_with(",90)"), "{c2:?}");
}

// F13: a `match` that hits nothing is a not-found, not an ambiguity, and it must name what the
// sheet does have -- a bare "match found no object" made the model narrow an already-empty match.
#[test]
fn empty_match_is_object_not_found_with_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"delete_object","match":{"kind":"wire","between":[[9000,9000],[9100,9000]]}}]}"#;
    let r = eng.plan(&req(&t, ops)).unwrap();
    let e = r.per_op[0].error.as_ref().expect("op must fail");
    assert_eq!(e.code, "OBJECT_NOT_FOUND", "{e:?}");
    let rem = e.remediation.as_deref().unwrap_or("");
    assert!(!rem.is_empty(), "no remediation on {e:?}");
    // The hier fixture has wires on the root sheet, so the remediation lists their endpoints.
    assert!(rem.contains("wire") && rem.contains('('), "{rem}");

    let labels = r#"{"protocol_version":1,"ops":[
      {"op":"delete_object","match":{"kind":"label","name":"NO_SUCH_LABEL"}}]}"#;
    let r2 = eng.plan(&req(&t, labels)).unwrap();
    let e2 = r2.per_op[0].error.as_ref().expect("op must fail");
    assert_eq!(e2.code, "OBJECT_NOT_FOUND", "{e2:?}");
    assert!(
        e2.remediation.as_deref().unwrap_or("").contains("MIDROOT"),
        "the sheet's own labels must be listed: {e2:?}"
    );
}

/// reg: a `PWR_FLAG` hung beside the rail port on the same pin printed its 320 mil of value
/// text straight over the port's own ("PWR_FLAGND", "PSWR3_FLAG" on 7 of the 13 golden
/// sheets): the escape stepped a fixed 100 mil and only tested connection points, never text
/// boxes. It now runs the same clearance search as the stub, so no two drawn texts overlap.
#[test]
fn reg_pwr_flag_text_clears_rail_port() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // The decoupling_3v3 golden task: a pair of caps on +3V3/GND with both rails flagged.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_decoupling","power_net":"+3V3","x_mil":3000,"y_mil":3000,"designator":"C80","value":"100n","gnd_net":"GND"},
      {"op":"place_decoupling","power_net":"+3V3","x_mil":3600,"y_mil":3000,"designator":"C81","value":"100n","gnd_net":"GND"},
      {"op":"place_pwr_flag","at":"C80.1"},
      {"op":"place_pwr_flag","at":"C80.2"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.layout);
    let drawn: BTreeSet<String> = r
        .per_op
        .iter()
        .flat_map(|o| o.created.iter())
        .filter(|c| c.kind == "symbol" || c.kind == "power_port")
        .map(|c| c.uuid.clone())
        .collect();
    let (sheet, doc) = sch_read::read_sheet(&t).unwrap();
    // Every visible Reference / Value text this op-list drew, power ports included: the gate
    // skips power symbols (a rail text over the part it feeds is normal), so this is the check
    // the gate cannot make for us.
    let texts: Vec<(String, sch_read::bbox::BBox)> = sheet
        .symbols
        .iter()
        .filter(|s| drawn.contains(&s.uuid))
        .flat_map(|s| sch_read::bbox::symbol_text_boxes(&doc, s))
        .collect();
    assert!(texts.len() >= 10, "{texts:?}");
    for i in 0..texts.len() {
        for j in i + 1..texts.len() {
            assert!(
                !texts[i].1.intersects(&texts[j].1),
                "{} overprints {}",
                texts[i].0,
                texts[j].0
            );
        }
    }
    // Still one net each, still flagged: the escape wire may not rewire anything.
    let nets = sch_net::build_nets(&sch_read::read_project(&t).unwrap());
    for name in ["+3V3", "GND"] {
        let n = nets
            .nets
            .iter()
            .find(|n| n.name == name)
            .unwrap_or_else(|| panic!("{name} net"));
        assert!(n.flagged, "{name} must carry its PWR_FLAG");
        for c in ["C80", "C81"] {
            assert!(
                n.members.iter().any(|m| m.reference == c),
                "{name} lost {c}: {:?}",
                n.members
            );
        }
    }
}

/// reg: a power port on a horizontal pin used to hang off the end of a 200 mil rail stub, in
/// the pin's own row - on a connector that put GND and VBUS level with the neighbouring pins'
/// labels. It now turns the corner: 100 mil out along the pin, then 100 mil down (ground) or
/// up (rail), so the port stands vertical the way a drafter draws it.
#[test]
fn reg_side_pin_gnd_drops_below() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // J80 unrotated: Conn_01x04 pins point left, 100 mil apart.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Connector_Generic:Conn_01x04","designator":"J80","x_mil":3000,"y_mil":3000,"exact":true},
      {"op":"place_power_port","lib_id":"power:VBUS","net_name":"VBUS","at":"J80.1"},
      {"op":"place_gnd","at":"J80.4"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.layout);
    let (sheet, _) = sch_read::read_sheet(&t).unwrap();
    let pin_at = |n: &str| {
        let j = sheet.symbols.iter().find(|s| s.reference == "J80").unwrap();
        let lib = sheet.lib_symbol(&j.lib_id).unwrap();
        sch_model::world_pins(j, lib)
            .into_iter()
            .find(|p| p.number == n)
            .unwrap()
            .at
    };
    // By uuid: the fixture already carries power ports of its own.
    let drawn = |name: &str| {
        r.per_op
            .iter()
            .flat_map(|o| o.created.iter())
            .find(|c| c.kind == "power_port" && c.name.as_deref() == Some(name))
            .unwrap_or_else(|| panic!("{name} port"))
            .uuid
            .clone()
    };
    let placed = |name: &str| {
        let u = drawn(name);
        sheet.symbols.iter().find(|s| s.uuid == u).unwrap()
    };
    let port = |name: &str| placed(name).placement.at;
    let elbow = sch_model::mil_to_nm(100.0);
    // Ground drops below its pin, supply rises above its own, both one square out along the pin.
    assert_eq!(
        port("GND"),
        sch_model::Pt::new(pin_at("4").x - elbow, pin_at("4").y + elbow)
    );
    assert_eq!(
        port("VBUS"),
        sch_model::Pt::new(pin_at("1").x - elbow, pin_at("1").y - elbow)
    );
    // Two legs of wire, drawn horizontal-first so the corner is on the grid.
    let legs: Vec<(sch_model::Pt, sch_model::Pt)> =
        sheet.wires.iter().map(|w| (w.a, w.b)).collect();
    assert!(
        legs.contains(&(
            pin_at("4"),
            sch_model::Pt::new(pin_at("4").x - elbow, pin_at("4").y)
        )) && legs.contains(&(
            sch_model::Pt::new(pin_at("4").x - elbow, pin_at("4").y),
            sch_model::Pt::new(pin_at("4").x - elbow, pin_at("4").y + elbow)
        )),
        "{legs:?}"
    );
    // The ports still point their natural way (rot 0: ground down, rail up).
    for name in ["GND", "VBUS"] {
        assert_eq!(placed(name).placement.rot.deg(), 0, "{name}");
    }
    let style = sch_write::gates::style(&sch_read::read_project(&t).unwrap());
    let ours = [drawn("GND"), drawn("VBUS")];
    assert!(
        style.iter().all(|f| f.code != "POWER_PORT_ORIENTATION"
            || !ours.iter().any(|u| f.location.contains(u.as_str()))),
        "the L keeps the port upright: {style:?}"
    );
}

/// The hierarchy scaffold hands the drafter a corridor, not a staircase: the row counter is per
/// column, so the input on the left column and the output on the right land on the same row and
/// a wire between them is a straight line. Before this the single counter advanced on every pin,
/// whatever column it went to, and an in/out pair never shared a row.
#[test]
fn reg_hier_scaffold_rows() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"add_sheet","name":"power","file":"power.kicad_sch","at":[6000,3000],"pins":[
        {"name":"VIN","type":"input","side":"left"},
        {"name":"VOUT","type":"output","side":"right"},
        {"name":"EN","type":"input","side":"left"}],"create":true}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let (child, _) = sch_read::read_sheet(&dir.path().join("power.kicad_sch")).unwrap();
    let at = |name: &str| {
        child
            .labels
            .iter()
            .find(|l| l.text == name)
            .unwrap_or_else(|| panic!("no {name} label"))
            .at
    };
    assert_eq!(at("VIN").y, at("VOUT").y, "an in/out pair shares a row");
    assert_ne!(at("VIN").x, at("VOUT").x, "and sits in opposite columns");
    // The second pin on the *same* column takes the next row, not the same one.
    assert_ne!(at("EN").y, at("VIN").y);
    assert_eq!(at("EN").x, at("VIN").x);
    if kicad_cli().is_some() {
        oracle(&t).expect("kicad-cli must still read the project");
    }
}

/// Sheet pins are distributed on the symbol edge at KiCad's 100 mil pitch and centred on that
/// edge, and a sheet drawn without an explicit `size` is as tall as its pin count needs. Before
/// this the pins stacked from the top-left corner of a box whose size the author had to guess.
#[test]
fn reg_sheet_pin_distribution() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"add_sheet","name":"power","file":"power.kicad_sch","at":[6000,3000],"pins":[
        {"name":"VIN","type":"input","side":"left"},
        {"name":"EN","type":"input","side":"left"},
        {"name":"PG","type":"output","side":"left"},
        {"name":"VOUT","type":"output","side":"right"}],"create":true}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let tree = sch_read::read_project(&t).unwrap();
    let sh = tree
        .root()
        .sheets
        .iter()
        .find(|s| s.name == "power")
        .expect("sheet");
    let mil = sch_model::nm_to_mil;
    // Height follows the pin count of the busiest vertical edge (3 pins), not a guess.
    assert_eq!(mil(sh.size.y), 800.0, "size derived from the pin count");
    let mut left: Vec<f64> = sh
        .pins
        .iter()
        .filter(|p| p.rot == 180)
        .map(|p| mil(p.at.y))
        .collect();
    left.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(left.len(), 3);
    // 100 mil pitch...
    for w in left.windows(2) {
        assert_eq!(w[1] - w[0], 100.0, "{left:?}");
    }
    // ...centred on the edge: the same clearance above the first pin and below the last.
    let top = mil(sh.at.y);
    let bottom = mil(sh.at.y) + mil(sh.size.y);
    assert_eq!(left[0] - top, bottom - left[2], "{left:?}");
    // Every pin lands on the 50 mil connection grid (eeschema `endpoint_off_grid`).
    for p in &sh.pins {
        assert_eq!(p.at.x % sch_model::mil_to_nm(50.0), 0);
        assert_eq!(p.at.y % sch_model::mil_to_nm(50.0), 0);
    }
    if kicad_cli().is_some() {
        oracle(&t).expect("kicad-cli must still read the project");
    }
}

/// `place_decoupling near: "U9.3"` anchors the capacitor to the pin it decouples through the same
/// anchor path `place_power_port` uses, instead of a bare x/y that lands it across the sheet. The
/// `DECAP_FAR` check is the other half: silent for the anchored cap, and it speaks for a far one.
#[test]
fn reg_place_decoupling_near_pin() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Regulator_Linear:AMS1117-3.3","designator":"U9","x_mil":6000,"y_mil":6000,"exact":true},
      {"op":"place_power_port","lib_id":"power:+3V3","net_name":"+3V3","at":"U9.3"},
      {"op":"place_decoupling","designator":"C90","power_net":"+3V3","gnd_net":"GND","value":"100n","near":"U9.3"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let (sheet, _) = sch_read::read_sheet(&t).unwrap();
    let u9 = sheet.symbol_by_ref("U9").next().unwrap().placement.at;
    let c90 = sheet.symbol_by_ref("C90").next().unwrap().placement.at;
    let d = (((c90.x - u9.x) as f64).powi(2) + ((c90.y - u9.y) as f64).powi(2)).sqrt();
    let d_mil = sch_model::nm_to_mil(d as sch_model::Nm);
    assert!(
        d_mil <= 900.0,
        "the cap stays next to the part it decouples: {d_mil} mil"
    );
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::nets_of(&t).unwrap();
    let far: Vec<_> = sch_write::gates::delivery(&tree, &nets)
        .into_iter()
        .filter(|f| f.code == "DECAP_FAR" && f.refs.iter().any(|r| r.starts_with("C90")))
        .collect();
    assert!(far.is_empty(), "the anchored cap is close enough: {far:?}");

    // The same cap drawn 2000 mil away is what `DECAP_FAR` is for.
    let moved = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"C90","x_mil":6000,"y_mil":8000}]}"#;
    let r2 = eng.apply(&req(&t, moved)).unwrap();
    assert!(r2.applied, "{:?} {:?}", r2.refusal, r2.per_op);
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::nets_of(&t).unwrap();
    let far: Vec<_> = sch_write::gates::delivery(&tree, &nets)
        .into_iter()
        .filter(|f| f.code == "DECAP_FAR" && f.refs.iter().any(|r| r.starts_with("C90")))
        .collect();
    assert_eq!(far.len(), 1, "{far:?}");
    assert_eq!(far[0].severity, sch_write::gates::Severity::Warning);
    // The evidence names the pin the distance was measured to, so a repair can move the cap to it
    // instead of parsing the sentence: the power_in pin of the regulator on that rail.
    let pin = far[0]
        .evidence
        .get("nearest_pin")
        .and_then(|v| v.as_str())
        .expect("nearest_pin");
    assert!(pin.starts_with("U9."), "{:?}", far[0]);
    let at = far[0]
        .evidence
        .get("nearest_pin_at_mil")
        .and_then(|v| v.as_array())
        .expect("nearest_pin_at_mil");
    assert_eq!(at.len(), 2, "{:?}", far[0]);
    let number = pin.split_once('.').unwrap().1;
    let u9_sym = sheet.symbol_by_ref("U9").next().unwrap();
    let lib = sheet.lib_symbol(&u9_sym.lib_id).unwrap();
    let tip = sch_model::world_pins(u9_sym, lib)
        .into_iter()
        .find(|p| p.number == number)
        .expect("the named pin exists")
        .at;
    assert_eq!(
        (at[0].as_f64().unwrap(), at[1].as_f64().unwrap()),
        (sch_model::nm_to_mil(tip.x), sch_model::nm_to_mil(tip.y)),
        "{:?}",
        far[0]
    );
}

/// reg (run 21): `move_component` carries the wire ends on the moved pins by translating one end
/// of each segment. A move perpendicular to a wire's own axis then rubber-bands it into a diagonal,
/// which is a `LONG_WIRE: diagonal wire` finding nobody could trace back to the move that made it -
/// two survived a whole plan to delivery. A carried segment that would come out skewed is redrawn
/// as an L instead, and the netlist is unchanged by the redraw.
#[test]
fn reg_move_component_keeps_wires_orthogonal() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // The fixture has wires of its own; only the ones this test draws are examined.
    let (sheet, _) = sch_read::read_sheet(&t).unwrap();
    let fixture: BTreeSet<String> = sheet.wires.iter().map(|w| w.uuid.clone()).collect();
    let drawn = |t: &Path| -> Vec<(sch_model::Pt, sch_model::Pt)> {
        let (s, _) = sch_read::read_sheet(t).unwrap();
        s.wires
            .iter()
            .filter(|w| !fixture.contains(&w.uuid))
            .map(|w| (w.a, w.b))
            .collect()
    };
    // Two passives lying on their sides, joined by one straight horizontal wire between the pins
    // that face each other.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:C","designator":"C40","value":"100n","x_mil":3000,"y_mil":6000,"rotation":90,"no_nudge":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R40","value":"1k","x_mil":4000,"y_mil":6000,"rotation":90,"no_nudge":true},
      {"op":"route_net","from":"C40.2","to":"R40.1"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let before = drawn(&t);
    assert_eq!(
        before.len(),
        1,
        "one straight segment to start with: {before:?}"
    );
    assert_eq!(before[0].0.y, before[0].1.y, "it is horizontal: {before:?}");
    let joined = |t: &Path| -> bool {
        let nets = sch_net::nets_of(t).unwrap();
        nets.nets.iter().any(|n| {
            n.members.iter().any(|m| m.reference == "C40")
                && n.members.iter().any(|m| m.reference == "R40")
        })
    };
    assert!(joined(&t), "the wire joins the two parts");

    // Move the capacitor across the wire's own axis: rubber-banding its end would leave a diagonal.
    let moved = r#"{"protocol_version":1,"ops":[
      {"op":"move_component","designator":"C40","x_mil":3000,"y_mil":6400}]}"#;
    let r2 = eng.apply(&req(&t, moved)).unwrap();
    assert!(r2.applied, "{:?} {:?}", r2.refusal, r2.per_op);
    assert!(
        r2.per_op[0]
            .warnings
            .iter()
            .any(|w| w.starts_with("WIRE_REROUTED")),
        "the redraw is reported: {:?}",
        r2.per_op[0].warnings
    );
    let after = drawn(&t);
    for (a, b) in &after {
        assert!(
            a.x == b.x || a.y == b.y,
            "no wire is diagonal after the move: {a:?} -> {b:?}"
        );
    }
    // The gate is the verdict, not the arithmetic above: no `LONG_WIRE: diagonal wire` after a move.
    let tree = sch_read::read_project(&t).unwrap();
    let diagonal: Vec<_> = sch_write::gates::style(&tree)
        .into_iter()
        .filter(|f| f.code == "LONG_WIRE" && f.message.contains("diagonal"))
        .collect();
    assert!(diagonal.is_empty(), "{diagonal:?}");
    // The L is two legs, and the two parts are still on one net.
    assert_eq!(after.len(), 2, "{after:?}");
    assert!(joined(&t), "the redraw kept the connection");
    if let Some(oracle) = oracle(&t) {
        let nets = sch_net::nets_of(&t).unwrap();
        for (name, members) in &oracle {
            let ours: BTreeSet<String> = nets
                .nets
                .iter()
                .find(|n| &n.name == name)
                .map(|n| {
                    n.members
                        .iter()
                        .map(|m| format!("{}.{}", m.reference, m.pin))
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(&ours, members, "net {name} differs from kicad-cli");
        }
    }
}

/// A `power:PWR_FLAG` cache entry with no graphic primitives at all - only its pin. KiCad's
/// own library draws a hexagon, but a schematic can carry any cache entry, and this one makes
/// both glyph-box lookups of the power-port code return `None`.
const PWR_FLAG_STUB: &str = r##"
		(symbol "power:PWR_FLAG"
			(power global)
			(pin_numbers (hide yes))
			(pin_names (offset 0) (hide yes))
			(property "Reference" "#FLG" (at 0 1.905 0) (effects (font (size 1.27 1.27)) (hide yes)))
			(property "Value" "PWR_FLAG" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
			(symbol "PWR_FLAG_0_0"
				(pin power_out line (at 0 0 90) (length 0)
					(name "~" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
			)
		)"##;

/// reg (P1-5): the no-glyph branch of `flag_aside` returned `p +/- 100 mil` outright - it never
/// ran `busy_points` or the obstacle test the branch below it runs - so a `PWR_FLAG` whose
/// library entry carries no graphics was hung onto whatever was already 100 mil to the side,
/// wire end included, which merges two nets. The obstacles are now gathered before the glyph is
/// looked up and that branch takes the first candidate whose wire stays clear.
#[test]
fn reg_flag_aside_without_a_glyph_still_avoids_connection_points() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let src = std::fs::read_to_string(&t).unwrap();
    std::fs::write(
        &t,
        src.replacen(
            "\t(lib_symbols",
            &format!("\t(lib_symbols{PWR_FLAG_STUB}"),
            1,
        ),
    )
    .unwrap();
    let mut eng = engine();
    // R9 stands vertically at (5000,5000): pin 1 points up, so its tip is (5000,4850) and the
    // flag's escape steps sideways from there, +X first. R10 lies across that first candidate:
    // its own pin is exactly the point the old code hung the flag on.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R9","value":"1k","x_mil":5000,"y_mil":5000,"no_nudge":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R10","value":"1k","x_mil":5250,"y_mil":4850,"rotation":90,"no_nudge":true},
      {"op":"place_pwr_flag","at":"R9.1"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.layout);
    let (sheet, _) = sch_read::read_sheet(&t).unwrap();
    let flag = sheet
        .symbols
        .iter()
        .find(|s| s.lib_id == "power:PWR_FLAG")
        .expect("the flag was placed");
    let at = [
        sch_model::nm_to_mil(flag.placement.at.x).round(),
        sch_model::nm_to_mil(flag.placement.at.y).round(),
    ];
    assert_ne!(at, [5100.0, 4850.0], "the flag was hung onto R10's pin");
    assert_eq!(
        at,
        [4900.0, 4850.0],
        "the free side is one step the other way"
    );
    // R10 is still on a net of its own: the flag did not merge the two.
    let nets = sch_net::build_nets(&sch_read::read_project(&t).unwrap());
    let flagged: Vec<&sch_net::Net> = nets.nets.iter().filter(|n| n.flagged).collect();
    assert_eq!(flagged.len(), 1, "{flagged:?}");
    assert!(
        flagged[0].members.iter().any(|m| m.reference == "R9")
            && !flagged[0].members.iter().any(|m| m.reference == "R10"),
        "{:?}",
        flagged[0].members
    );
}

/// reg (run 20): `route_net` drew its corner wherever the geometry fell. Routing GND to J1.4 with
/// "auto" put the corner at (1200,2200) and then ran the leg straight up J1's pin column, through
/// the tips of pins 1, 2 and 3 - three connector pins joined the rail, one of them under a
/// no-connect, and the write path said nothing. The route now tries the other leg order (and then a
/// Z on a free grid line) before it draws, so the wire reaches the pin it was asked for and touches
/// no other.
#[test]
fn reg_route_avoids_foreign_pin_tips() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // J1 as run 20 placed it: a 4-pin header whose pin tips stand in a column at x 1200, 100 mil
    // apart from y 2300 (pin 1) down to y 2600 (pin 4).
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Connector_Generic:Conn_01x04","designator":"J1","x_mil":1400,"y_mil":2400,"no_nudge":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R70","value":"1k","x_mil":900,"y_mil":2350,"no_nudge":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R71","value":"1k","x_mil":600,"y_mil":2650,"no_nudge":true},
      {"op":"route_net","from":"R70.1","to":"J1.4"},
      {"op":"route_net","from":"R71.1","to":"J1.1"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    for o in &r.per_op[3..5] {
        assert!(
            !o.warnings
                .iter()
                .any(|w| w.starts_with("ROUTE_THROUGH_PIN")),
            "a clear shape was available: {o:?}"
        );
    }
    // The netlist is the verdict: pin 4 reaches R70, pin 1 reaches R71, and pins 2 and 3 are on
    // neither net (the leg used to wire all three).
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::build_nets(&tree);
    let of = |reference: &str, pin: &str| -> Option<&sch_net::Net> {
        nets.nets.iter().find(|n| {
            n.members
                .iter()
                .any(|m| m.reference == reference && m.pin == pin)
        })
    };
    let n4 = of("J1", "4").expect("J1.4 is on a net");
    assert!(
        n4.members.iter().any(|m| m.reference == "R70"),
        "{:?}",
        n4.members
    );
    let n1 = of("J1", "1").expect("J1.1 is on a net");
    assert!(
        n1.members.iter().any(|m| m.reference == "R71"),
        "{:?}",
        n1.members
    );
    for pin in ["2", "3"] {
        let n = of("J1", pin);
        assert!(
            n.map(|n| n.members.len()).unwrap_or(1) == 1,
            "J1.{pin} was wired by a passing leg: {:?}",
            n.map(|n| n.members.clone())
        );
    }
    if let Some(oracle) = oracle(&t) {
        for (name, members) in &oracle {
            let ours: BTreeSet<String> = nets
                .nets
                .iter()
                .find(|n| &n.name == name)
                .map(|n| {
                    n.members
                        .iter()
                        .map(|m| format!("{}.{}", m.reference, m.pin))
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(&ours, members, "net {name} differs from kicad-cli");
        }
    }
}

/// A no-connect says "this pin is deliberately unused". On a pin a wire already ends on it says two
/// things at once, and KiCad's ERC reports the contradiction; the op is refused with the thing in
/// the way named, instead of being written for a later check to find (run 20 wrote two of them).
#[test]
fn no_connect_on_a_wired_pin_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // R2.1 in the fixture is the far end of a wire.
    let ops = r#"{"protocol_version":1,"ops":[{"op":"add_no_connect","pin":"R2.1"}]}"#;
    let r = eng.plan(&req(&t, ops)).unwrap();
    assert!(!r.applied);
    let err = r.per_op[0].error.as_ref().expect("the op is refused");
    assert_eq!(err.code, "NO_CONNECT_ON_CONNECTED_PIN");
    assert!(err.message.contains("R2.1"), "{err:?}");
    assert!(
        err.remediation
            .as_deref()
            .unwrap_or_default()
            .contains("delete_object"),
        "the refusal says how to get out of it: {err:?}"
    );
    // A pin with nothing on it still takes one.
    let ok = r#"{"protocol_version":1,"sheets":{"child":"hier_child.kicad_sch"},
      "ops":[{"op":"add_no_connect","pin":"R5.2","sheet":"child"}]}"#;
    let r = eng.apply(&req(&t, ok)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
}

/// A wire drawn onto an existing no-connect marker is the same contradiction from the other end -
/// the marker was written first, so there is nothing left to refuse - and it warns.
#[test]
fn a_wire_onto_a_no_connect_warns() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R75","value":"1k","x_mil":900,"y_mil":4000,"no_nudge":true},
      {"op":"place_component","lib_id":"Device:R","designator":"R76","value":"1k","x_mil":1400,"y_mil":4000,"no_nudge":true},
      {"op":"add_no_connect","pin":"R75.1"},
      {"op":"add_wire","vertices":[[900,3850],[1400,3850]]}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let w = &r.per_op[3].warnings;
    assert!(
        w.iter().any(|w| w.starts_with("WIRE_ON_NO_CONNECT")),
        "{w:?}"
    );
}

/// reg (run 20): a `power:PWR_FLAG` placed through `place_component` under a leased designator
/// (`PWR1`) is a port wearing a part's name - it went into the BOM and the delivery check asked it
/// for a footprint. The reference is put back on KiCad's convention (`#FLG` for a flag, `#PWR` for
/// any other port), the rename is reported, and the delivery check then leaves it alone.
#[test]
fn reg_power_symbol_placed_as_a_part_is_annotated_as_a_port() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // R2.1 is a driven node in the fixture, which is where a flag belongs.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"power:PWR_FLAG","designator":"PWR1","x_mil":3500,"y_mil":2450}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let w = &r.per_op[0].warnings;
    assert!(
        w.iter()
            .any(|w| w.starts_with("PLACEMENT_POWER_DESIGNATOR") && w.contains("#FLG01")),
        "{w:?}"
    );
    assert_eq!(
        r.per_op[0].created[0].reference.as_deref(),
        Some("#FLG01"),
        "what the turn reports is the name that was written"
    );
    let tree = sch_read::read_project(&t).unwrap();
    let root = tree.root();
    assert!(
        root.symbol_by_ref("PWR1").next().is_none(),
        "the part name is gone"
    );
    let flag = root
        .symbol_by_ref("#FLG01")
        .next()
        .expect("the flag is annotated as a port");
    assert_eq!(flag.lib_id, "power:PWR_FLAG");
    let nets = sch_net::build_nets(&tree);
    let delivery = sch_write::gates::delivery(&tree, &nets);
    assert!(
        !delivery
            .iter()
            .any(|f| f.code == "FOOTPRINT_MISSING" && f.refs.iter().any(|r| r.contains("FLG"))),
        "a port has no footprint to miss: {delivery:?}"
    );
    // A rail port takes the other prefix.
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"power:+3V3","designator":"PW2","x_mil":900,"y_mil":5000}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let made = r.per_op[0].created[0].reference.as_deref();
    assert!(
        made.unwrap_or_default().starts_with("#PWR"),
        "a rail port is annotated #PWR: {made:?}"
    );
}
