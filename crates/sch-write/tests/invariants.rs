// SPDX-License-Identifier: Apache-2.0
//! L1 invariants owned by sch-write (I7, I8 write half, I15–I17, I19–I23) and write-path
//! regressions (docs/engine-conformance.md §4). Oracle checks use `kicad-cli` when installed;
//! `FLUXSMITH_CONFORMANCE=required` makes its absence a failure.

use sch_ops::OpList;
use sch_write::{atomic, identity as id, DrawRequest, DrawResult, Engine};
use serde_json::json;
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

fn req(target: &Path, ops: serde_json::Value) -> DrawRequest {
    let mut v = json!({"protocol_version": 1, "groups": {"g": {"origin_mil": [4000, 4000]}}, "sheets": {"child": "hier_child.kicad_sch"}, "ops": ops});
    if let Some(obj) = v.as_object_mut() {
        obj.entry("ops").or_insert(json!([]));
    }
    DrawRequest {
        target: target.to_path_buf(),
        root: None,
        oplist: OpList::from_value(v).unwrap(),
        strict_nets: true,
        strict_layout: true,
        expected_merges: vec![],
        note: Some("test".into()),
        backup_depth: 2,
        journal: None,
        expected_target_sha: None,
        run_backup_dir: None,
    }
}

fn apply(eng: &mut Engine, target: &Path, ops: serde_json::Value) -> DrawResult {
    let r = eng.apply(&req(target, ops)).unwrap();
    assert!(
        r.applied,
        "apply refused: {:?} {:?} {:?}",
        r.refusal,
        r.per_op
            .iter()
            .filter_map(|o| o.error.as_ref())
            .collect::<Vec<_>>(),
        r.integrity_introduced
    );
    r
}

fn kicad_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KICAD_CLI") {
        return Some(PathBuf::from(p));
    }
    for c in [
        "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
        "/usr/bin/kicad-cli",
    ] {
        if Path::new(c).exists() {
            return Some(PathBuf::from(c));
        }
    }
    None
}

fn require_oracle() -> Option<PathBuf> {
    let cli = kicad_cli();
    if cli.is_none() {
        let required = std::env::var("FLUXSMITH_CONFORMANCE")
            .map(|v| v == "required")
            .unwrap_or(false);
        assert!(!required, "FLUXSMITH_CONFORMANCE=required but kicad-cli was not found (set KICAD_CLI or install KiCad 10; see tests/conformance/env.toml)");
        eprintln!("kicad-cli not installed: oracle step skipped");
    }
    cli
}

/// `kicad-cli sch erc` on `sch`: returns the report text; asserts the file loads and that the
/// report carries no annotation error (E2 oracle).
fn erc_oracle(sch: &Path) -> Option<String> {
    let cli = require_oracle()?;
    let out = sch.with_extension("erc.json");
    let st = Command::new(cli)
        .args(["sch", "erc", "--format", "json", "--severity-all", "-o"])
        .arg(&out)
        .arg(sch)
        .output()
        .expect("run kicad-cli");
    assert!(
        st.status.success(),
        "kicad-cli sch erc failed on {}: {}",
        sch.display(),
        String::from_utf8_lossy(&st.stderr)
    );
    let text = std::fs::read_to_string(&out).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    for sheet in v["sheets"].as_array().unwrap_or(&vec![]) {
        for viol in sheet["violations"].as_array().unwrap_or(&vec![]) {
            let t = viol["type"].as_str().unwrap_or("");
            assert!(
                !t.contains("annotation") && t != "lib_symbol_issues" && t != "lib_symbol_mismatch",
                "{}: KiCad reports {t}: {}",
                sch.display(),
                viol["description"]
            );
        }
    }
    Some(text)
}

fn symbol_node<'a>(doc: &'a kicad_sexpr::Document, refdes: &str) -> Option<&'a kicad_sexpr::List> {
    doc.root.find_all("symbol").find(|s| {
        s.find_all("property").any(|p| {
            p.arg(0).as_deref() == Some("Reference") && p.arg(1).as_deref() == Some(refdes)
        })
    })
}

fn prop_at(sym: &kicad_sexpr::List, name: &str) -> (f64, f64, f64) {
    let p = sym
        .find_all("property")
        .find(|p| p.arg(0).as_deref() == Some(name))
        .unwrap();
    let at = p.find("at").unwrap();
    (
        at.arg_f64(0).unwrap(),
        at.arg_f64(1).unwrap(),
        at.arg_f64(2).unwrap_or(0.0),
    )
}

const PLACE_R10: &str = r#"{"op":"place_component","group":"g","lib_id":"Device:R","designator":"R10","x_mil":0,"y_mil":0,"value":"4k7"}"#;

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

#[test]
fn inv_7_property_at_is_absolute_and_moves_with_the_symbol() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap()]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let sym = symbol_node(&doc, "R10").unwrap();
    let at = sym.find("at").unwrap();
    let (sx, sy) = (at.arg_f64(0).unwrap(), at.arg_f64(1).unwrap());
    let (rx, ry, _) = prop_at(sym, "Reference");
    let (vx, vy, _) = prop_at(sym, "Value");
    // property (at) is in sheet space: it sits near the symbol origin, not near (0,0)
    assert!(
        (rx - sx).abs() < 10.0 && (ry - sy).abs() < 10.0,
        "Reference at ({rx},{ry}) vs symbol ({sx},{sy})"
    );
    apply(
        &mut eng,
        &t,
        json!([{"op":"move_component","designator":"R10","x_mil":6000,"y_mil":6000}]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let sym = symbol_node(&doc, "R10").unwrap();
    let at = sym.find("at").unwrap();
    let (nx, ny) = (at.arg_f64(0).unwrap(), at.arg_f64(1).unwrap());
    let (dx, dy) = (nx - sx, ny - sy);
    assert!(dx.abs() > 1.0 && dy.abs() > 1.0);
    let (rx2, ry2, _) = prop_at(sym, "Reference");
    let (vx2, vy2, _) = prop_at(sym, "Value");
    assert!(
        (rx2 - rx - dx).abs() < 0.001 && (ry2 - ry - dy).abs() < 0.001,
        "Reference must move by the same delta"
    );
    assert!(
        (vx2 - vx - dx).abs() < 0.001 && (vy2 - vy - dy).abs() < 0.001,
        "Value must move by the same delta"
    );
}

#[test]
fn inv_8_written_instance_pins_carry_no_at() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(), {"op":"place_gnd","at":"R10.2"}]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    for refdes in ["R10"] {
        let sym = symbol_node(&doc, refdes).unwrap();
        let pins: Vec<&kicad_sexpr::List> = sym.find_all("pin").collect();
        assert_eq!(pins.len(), 2);
        for p in pins {
            assert!(p.find("at").is_none() && p.find("uuid").is_some());
        }
    }
}

/// I15: the UUIDv5 seed formats and the namespace derivation are frozen in
/// `tests/conformance/vectors/identity.json`. Changing any of them re-identifies every node of
/// every existing file (major change + migrator).
#[test]
fn inv_15_uuid_seed_rules_are_frozen() {
    use sch_model::Pt;
    let a = Pt::new(127_000_000, 254_000_000);
    let b = Pt::new(0, 254_000_000);
    let root = "11111111-1111-4111-8111-111111111111";
    let seeds: Vec<(&str, String)> = vec![
        ("symbol", id::seed_symbol("R1", 1)),
        ("symbol_unit2", id::seed_symbol("U1", 2)),
        ("pin", id::seed_pin("R1", 1, "1", 0)),
        ("pin_dup1", id::seed_pin("R1", 1, "1", 1)),
        ("wire", id::seed_wire(a, b)),
        ("wire_reversed", id::seed_wire(b, a)),
        ("bus", id::seed_bus(a, b)),
        ("junction", id::seed_junction(a)),
        ("bus_entry", id::seed_bus_entry(a)),
        ("anchor_pt", id::anchor_pt(a)),
        (
            "no_connect",
            id::seed_no_connect(&id::seed_pin("U1", 1, "7", 0)),
        ),
        (
            "label_local",
            id::seed_label("local", "SDA", &id::seed_pin("U1", 1, "7", 0)),
        ),
        (
            "label_global",
            id::seed_label("global", "SDA", &id::anchor_pt(a)),
        ),
        (
            "power",
            id::seed_power("GND", &id::seed_pin("C1", 1, "2", 0)),
        ),
        ("keyed_rect", id::seed_keyed("rectangle", "blk-frame")),
        ("text", id::seed_text("text", a)),
        ("rect", id::seed_rect("rectangle", a, b)),
        ("sheet", id::seed_sheet("power.kicad_sch", "power")),
        (
            "sheet_pin",
            id::seed_sheet_pin("power.kicad_sch", "power", "VIN"),
        ),
        ("sheet_file", id::seed_sheet_file("power.kicad_sch")),
    ];
    let mut vectors = serde_json::Map::new();
    for (k, seed) in &seeds {
        vectors.insert(
            k.to_string(),
            json!({"seed": seed, "uuid": id::node_uuid(root, seed)}),
        );
    }
    let doc = json!({
        "$comment": "Frozen UUIDv5 identity vectors (I15). namespace = root sheet uuid. Any change here is a major format change that needs a migrator (CLAUDE.md red line 1). Regenerate only on purpose with FLUXSMITH_UPDATE_VECTORS=1.",
        "namespace_root_uuid": root,
        "vectors": vectors,
    });
    let want = serde_json::to_string_pretty(&doc).unwrap() + "\n";
    let path = fixtures().join("../vectors/identity.json");
    if std::env::var("FLUXSMITH_UPDATE_VECTORS")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &want).unwrap();
        return;
    }
    let have = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    assert_eq!(have, want, "UUID seed rules drifted from tests/conformance/vectors/identity.json (major change: needs a migrator)");
    // the seed of a wire is orientation-independent, the namespace matters
    assert_eq!(id::seed_wire(a, b), id::seed_wire(b, a));
    assert_ne!(
        id::node_uuid(root, &seeds[0].1),
        id::node_uuid("22222222-2222-4222-8222-222222222222", &seeds[0].1)
    );
}

#[test]
fn inv_16_two_ops_with_the_same_seed_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let sha0 = atomic::file_sha(&t).unwrap();
    let r = eng.apply(&req(&t, json!([{"op":"add_wire","vertices":[[3000,3000],[3500,3000]]},{"op":"add_wire","vertices":[[3500,3000],[3000,3000]]}]))).unwrap();
    assert!(!r.applied);
    let err = r
        .per_op
        .iter()
        .find_map(|o| o.error.clone())
        .expect("second op reports an error");
    assert_eq!(err.code, "DUPLICATE_SEED");
    assert_eq!(atomic::file_sha(&t).unwrap(), sha0, "nothing written");
    // reg 0.18.0: two power ports on the same anchor for the same net do not both report ok
    let r = eng.apply(&req(&t, json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(), {"op":"place_gnd","at":"R10.2"}, {"op":"place_gnd","at":"R10.2"}]))).unwrap();
    assert!(!r.applied);
    assert_eq!(
        r.per_op.iter().filter(|o| o.status == "ok").count(),
        2,
        "{:?}",
        r.per_op
    );
    assert_eq!(
        r.per_op.last().unwrap().error.as_ref().unwrap().code,
        "DUPLICATE_SEED"
    );
}

/// I17 / reg 0.3.0: the plan preview is exactly what apply writes (no second pass needed), and
/// two identical copies receive byte-identical results.
#[test]
fn inv_17_plan_preview_equals_apply_and_copies_are_byte_identical() {
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let ta = copy_hier(da.path());
    let tb = copy_hier(db.path());
    let mut eng = engine();
    let ops = json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(), {"op":"place_gnd","at":"R10.2"}, {"op":"add_net_label","name":"SIG","at":"R10.1"}, {"op":"add_text","group":"g","text":"hello","at":[0,-400]}]);
    let plan = eng.plan(&req(&ta, ops.clone())).unwrap();
    assert!(plan.refusal.is_none(), "{:?}", plan.refusal);
    let preview = plan
        .previews
        .get(&ta.canonicalize().unwrap())
        .expect("preview for the target")
        .clone();
    apply(&mut eng, &ta, ops.clone());
    apply(&mut eng, &tb, ops);
    let a = std::fs::read_to_string(&ta).unwrap();
    assert_eq!(
        a, preview,
        "first apply must write exactly the planned bytes"
    );
    assert_eq!(a, std::fs::read_to_string(&tb).unwrap());
    // and our own reader re-serialises it unchanged (I1 on generated output)
    assert_eq!(kicad_sexpr::dumps(&kicad_sexpr::parse(&a).unwrap()), a);
    erc_oracle(&ta);
}

/// I19 / reg 0.18.0: symbols placed in a child sheet get the child's instance path
/// (`/<root uuid>/<sheet symbol uuid>`), not the root path.
#[test]
fn inv_19_child_sheet_instances_path() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([{"op":"place_component","sheet":"child","lib_id":"Device:R","designator":"R30","x_mil":7000,"y_mil":7000}]),
    );
    let child = dir.path().join("hier_child.kicad_sch");
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&child).unwrap()).unwrap();
    let sym = symbol_node(&doc, "R30").expect("placed in the child file");
    let path = sym
        .find("instances")
        .unwrap()
        .find("project")
        .unwrap()
        .find("path")
        .unwrap();
    assert_eq!(
        path.arg(0).as_deref(),
        Some("/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333")
    );
    assert_eq!(
        path.find("reference").unwrap().arg(0).as_deref(),
        Some("R30")
    );
    assert_eq!(
        sym.find("instances")
            .unwrap()
            .find("project")
            .unwrap()
            .arg(0)
            .as_deref(),
        Some("hier")
    );
    erc_oracle(&t);
}

/// I20 / reg 0.18.0: the write gate and the net engine agree on the junction dialect: a wire
/// ending mid-span on another wire without a junction is dangling for both.
#[test]
fn inv_20_gate_and_netbuild_agree_on_midspan_t() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // R10 at (4000,4000) mil: pin1 (4000,3850), pin2 (4000,4150). Vertical wire from pin2 down
    // to (4000,5000) ending on R11.1; a second wire ends mid-span at (4000,4500) with R12 on its
    // other end.
    let base = json!([
        serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(),
        {"op":"place_component","lib_id":"Device:R","designator":"R11","x_mil":4000,"y_mil":5150},
        {"op":"place_component","lib_id":"Device:R","designator":"R12","x_mil":4650,"y_mil":4500,"rotation":90},
        {"op":"add_wire","vertices":[[4000,4150],[4000,5000]]},
        {"op":"add_wire","vertices":[[4500,4500],[4000,4500]]}
    ]);
    let r = eng.plan(&req(&t, base.clone())).unwrap();
    let dangling: Vec<&sch_write::gates::Finding> = r
        .integrity_introduced
        .iter()
        .filter(|f| f.code == "DANGLING_ENDPOINT")
        .collect();
    assert!(
        !dangling.is_empty(),
        "gate must flag the junction-less T: {:?}",
        r.integrity_introduced
    );
    assert!(
        dangling.iter().any(|f| f
            .at_mil
            .map(|a| (a[0] - 4000.0).abs() < 1.0 && (a[1] - 4500.0).abs() < 1.0)
            .unwrap_or(false)),
        "{dangling:?}"
    );
    assert!(!r.applied);
    // with the junction both the gate and the net engine connect it
    let mut with_j = base.as_array().unwrap().clone();
    with_j.push(json!({"op":"add_junction","at":[4000,4500]}));
    let r = apply(&mut eng, &t, serde_json::Value::Array(with_j));
    assert!(r
        .integrity_introduced
        .iter()
        .all(|f| f.code != "DANGLING_ENDPOINT"));
    let nl = sch_net::nets_of(&t).unwrap();
    let net = nl
        .nets
        .iter()
        .find(|n| {
            n.members
                .iter()
                .any(|m| m.reference == "R10" && m.pin == "2")
        })
        .unwrap();
    let refs: Vec<String> = net
        .members
        .iter()
        .map(|m| format!("{}.{}", m.reference, m.pin))
        .collect();
    assert_eq!(refs, vec!["R10.2", "R11.1", "R12.1"]);
    erc_oracle(&t);
}

#[test]
fn inv_21_atomic_write_temp_in_same_dir_fsync_and_bak_rotation() {
    let dir = tempfile::tempdir().unwrap();
    let t = dir.path().join("a.kicad_sch");
    std::fs::write(&t, "v1").unwrap();
    let p = atomic::prepare(&t, b"v2", None, 2).unwrap();
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names
            .iter()
            .any(|n| n.starts_with(".a.kicad_sch.fluxsmith-tmp-")),
        "temp file lives next to the target: {names:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&t).unwrap(),
        "v1",
        "target untouched until commit"
    );
    p.commit().unwrap();
    assert_eq!(std::fs::read_to_string(&t).unwrap(), "v2");
    assert_eq!(
        std::fs::read_to_string(atomic::backup_name(&t, 0)).unwrap(),
        "v1"
    );
    atomic::prepare(&t, b"v3", None, 2)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(atomic::backup_name(&t, 0)).unwrap(),
        "v2",
        ".bak is the previous version"
    );
    assert_eq!(
        std::fs::read_to_string(atomic::backup_name(&t, 1)).unwrap(),
        "v1",
        ".bak1 is the one before"
    );
    atomic::prepare(&t, b"v4", None, 2)
        .unwrap()
        .commit()
        .unwrap();
    assert!(
        !atomic::backup_name(&t, 2).exists(),
        "depth 2 keeps two backups"
    );
    assert_eq!(
        std::fs::read_to_string(atomic::backup_name(&t, 1)).unwrap(),
        "v2"
    );
    // abort removes the temp file and leaves the target alone
    atomic::prepare(&t, b"v5", None, 2).unwrap().abort();
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|n| !n.contains("fluxsmith-tmp")),
        "{names:?}"
    );
    assert_eq!(std::fs::read_to_string(&t).unwrap(), "v4");
    // TOCTOU: a stale expected sha refuses the write
    let stale = atomic::prepare(&t, b"v6", Some("deadbeef"), 2);
    assert!(matches!(stale, Err(atomic::AtomicError::Stale { .. })));
    assert_eq!(std::fs::read_to_string(&t).unwrap(), "v4");
    assert!(
        !std::fs::read(&t).unwrap().contains(&b'\r'),
        "reg: writer never translates newlines"
    );
}

/// I22: nets are evaluated over the whole tree even when the op targets a child file.
#[test]
fn inv_22_net_gate_is_tree_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let root = copy_hier(dir.path());
    let child = dir.path().join("hier_child.kicad_sch");
    let mut eng = engine();
    let mut rq = req(
        &child,
        json!([{"op":"add_text","text":"note","at":[2000,2000]}]),
    );
    rq.root = Some(root.clone());
    let r = eng.apply(&rq).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let glb = r
        .nets
        .iter()
        .find(|n| n.name == "GLB")
        .expect("root+child global net visible from a child-target request");
    assert_eq!(glb.sheets, vec!["/", "/child/"]);
    assert!(
        r.nets.iter().any(|n| n.sheets == vec!["/"]),
        "root-only nets are part of the evaluation"
    );
    // a child-only view would not know that R2.1 (root) and R3.2 (child) share a named net:
    // labelling R3.2 with another named net is a MERGE the tree-scoped gate refuses.
    let mut rq = req(
        &child,
        json!([{"op":"add_net_label","name":"GLB","at":"R3.2"}]),
    );
    rq.root = Some(root.clone());
    let r = eng.apply(&rq).unwrap();
    assert!(
        !r.applied && r.net_diff.has_risk,
        "applied={} {:?}",
        r.applied,
        r.net_diff
    );
}

#[test]
fn inv_23_kicad_lock_file_refuses_the_write() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let lock = atomic::lock_path(&t);
    assert_eq!(
        lock.file_name().unwrap().to_string_lossy(),
        "~hier_root.kicad_sch.lck"
    );
    std::fs::write(&lock, "{}").unwrap();
    let sha0 = atomic::file_sha(&t).unwrap();
    let ops = json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap()]);
    match eng.apply(&req(&t, ops.clone())) {
        Err(sch_write::WriteError::Atomic(atomic::AtomicError::Locked(p))) => {
            assert_eq!(p.canonicalize().unwrap(), t.canonicalize().unwrap())
        }
        other => panic!(
            "expected Locked, got {:?}",
            other.map(|r| (r.applied, r.refusal))
        ),
    }
    assert_eq!(atomic::file_sha(&t).unwrap(), sha0);
    // plan (no write) still works while locked
    assert!(eng.plan(&req(&t, ops.clone())).unwrap().refusal.is_none());
    std::fs::remove_file(&lock).unwrap();
    apply(&mut eng, &t, ops);
}

// ---------------------------------------------------------------------------
// Regressions
// ---------------------------------------------------------------------------

/// reg 0.4.0 / 0.18.0 / 0.20.0: duplicate designators are refused (never merged), but `R?`
/// placeholders are not duplicates of each other.
#[test]
fn reg_duplicate_designator_refused_but_placeholders_allowed() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let r = eng.apply(&req(&t, json!([{"op":"place_component","lib_id":"Device:R","designator":"R1","x_mil":6000,"y_mil":6000}]))).unwrap();
    assert!(
        !r.applied
            && r.integrity_introduced
                .iter()
                .any(|f| f.code == "DUPLICATE_DESIGNATOR" && f.refs.contains(&"R1".to_string())),
        "{:?}",
        r.integrity_introduced
    );
    let r = eng.apply(&req(&t, json!([
        {"op":"place_component","lib_id":"Device:R","designator":"R?","x_mil":6000,"y_mil":6000},
        {"op":"place_component","lib_id":"Device:R","designator":"R?","x_mil":6600,"y_mil":6000}
    ]))).unwrap();
    assert!(
        r.integrity_introduced
            .iter()
            .all(|f| f.code != "DUPLICATE_DESIGNATOR"),
        "placeholders are not duplicates: {:?}",
        r.integrity_introduced
    );
}

/// reg 0.4.0: bus entry endpoints are not dangling wire ends.
#[test]
fn reg_bus_entry_endpoints_are_not_dangling() {
    let tree = sch_read::read_project(&fixtures().join("hier/hier_root.kicad_sch")).unwrap();
    let f = sch_write::gates::integrity(&tree);
    let child = tree
        .files
        .keys()
        .find(|p| p.ends_with("hier_child.kicad_sch"))
        .unwrap();
    assert!(
        !tree.files[child].bus_entries.is_empty(),
        "fixture has bus entries"
    );
    let dangling: Vec<&sch_write::gates::Finding> =
        f.iter().filter(|x| x.code == "DANGLING_ENDPOINT").collect();
    assert!(dangling.is_empty(), "{dangling:?}");
}

/// reg 0.4.0: custom fields set via `set_component_parameters` are hidden, never drawn over the body.
#[test]
fn reg_custom_parameters_are_hidden_not_drawn_on_the_body() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([{"op":"set_component_parameters","designator":"R1","parameters":{"MPN":"RC0402FR-071KL","LCSC":"C11702"}}]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let sym = symbol_node(&doc, "R1").unwrap();
    for name in ["MPN", "LCSC"] {
        let p = sym
            .find_all("property")
            .find(|p| p.arg(0).as_deref() == Some(name))
            .unwrap();
        let eff = p.find("effects").unwrap();
        assert!(
            eff.find("hide")
                .map(|h| h.arg(0).as_deref() != Some("no"))
                .unwrap_or(false),
            "{name} must be hidden: {}",
            kicad_sexpr::dumps_list(p)
        );
    }
    erc_oracle(&t);
}

/// reg 0.4.0: labels carry a `(justify ...)` that follows their angle so 180° labels do not
/// print over the symbol.
#[test]
fn reg_label_justify_follows_angle() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([
            serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(),
            {"op":"place_component","lib_id":"Device:R","designator":"R11","x_mil":5000,"y_mil":4000},
            {"op":"add_wire","vertices":[[4000,3850],[3400,3850]]},
            {"op":"add_wire","vertices":[[5000,3850],[5600,3850]]},
            {"op":"add_wire","vertices":[[4000,4150],[3400,4150]]},
            {"op":"add_wire","vertices":[[5000,4150],[5600,4150]]},
            {"op":"add_net_label","name":"L0","at":[3400,3850],"rotation":0},
            {"op":"add_net_label","name":"L180","at":[5600,3850],"rotation":180},
            {"op":"add_net_label","name":"G0","at":[3400,4150],"rotation":0,"scope":"global"},
            {"op":"add_net_label","name":"G180","at":[5600,4150],"rotation":180,"scope":"global"}
        ]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let just = |name: &str| -> (f64, Vec<String>) {
        let l = doc
            .root
            .find_all("label")
            .chain(doc.root.find_all("global_label"))
            .find(|l| l.arg(0).as_deref() == Some(name))
            .unwrap();
        (
            l.find("at").unwrap().arg_f64(2).unwrap_or(0.0),
            l.find("effects").unwrap().find("justify").unwrap().args(),
        )
    };
    let (a0, j0) = just("L0");
    let (a180, j180) = just("L180");
    assert_eq!((a0, a180), (0.0, 180.0));
    assert!(j0.contains(&"left".to_string()), "{j0:?}");
    assert!(j180.contains(&"right".to_string()), "{j180:?}");
    assert!(
        just("G0").1.contains(&"left".to_string()) && just("G180").1.contains(&"right".to_string())
    );
    erc_oracle(&t);
}

/// reg 0.4.0: Reference/Value text of a rotated symbol is rotated with it (KiCad composes the
/// two angles) so the text is neither mirrored nor drawn through the body.
#[test]
fn reg_rotated_symbol_text_angle() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([
            serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(),
            {"op":"place_component","lib_id":"Device:R","designator":"R11","x_mil":5000,"y_mil":4000,"rotation":90}
        ]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    // KiCad composes the stored text angle with the symbol transform: a horizontal text on a
    // 90-degree symbol is stored as 90. The engine writes the lib default for rot 0 and 90 for
    // rotated parts so the text never reads mirrored or through the body.
    let s10 = symbol_node(&doc, "R10").unwrap();
    let s11 = symbol_node(&doc, "R11").unwrap();
    assert_eq!(s10.find("at").unwrap().arg_f64(2), Some(0.0));
    assert_eq!(s11.find("at").unwrap().arg_f64(2), Some(90.0));
    for name in ["Reference", "Value"] {
        let a0 = prop_at(s10, name).2;
        let a90 = prop_at(s11, name).2;
        assert!(a0 == 0.0 || a0 == 90.0, "{name} rot0 angle {a0}");
        assert_eq!(
            a90, 90.0,
            "{name} on a 90-degree symbol must cancel the rotation"
        );
    }
    erc_oracle(&t);
}

/// reg 0.3.0 / 0.18.0: text and title-block strings with newlines are escaped through the
/// single quoter; KiCad opens the result.
/// The harness fills an empty title block after a Build turn (`LeadLoop.fillTitleBlocks`), so that
/// write has to be as cheap as it looks: a `set_title_block` on a sheet that has no `title_block`
/// node adds exactly that node and leaves every other byte of the file alone (red line 2), and a
/// second identical apply is a no-op on the bytes (apply-twice idempotence, red line 7).
#[test]
fn reg_set_title_block_only_touches_the_title_block() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let before = std::fs::read_to_string(&t).unwrap();
    assert!(
        !before.contains("title_block"),
        "the fixture starts without one"
    );
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([{"op":"set_title_block","title":"hier_root"}]),
    );
    let after = std::fs::read_to_string(&t).unwrap();
    assert!(after.contains("(title \"hier_root\")"));
    // Strip the one node the op owns; what is left must be the original file, byte for byte.
    let mut doc = kicad_sexpr::parse(&after).unwrap();
    let pos = doc.root.position("title_block").expect("title_block");
    doc.root.remove(pos);
    assert_eq!(kicad_sexpr::dumps(&doc), before);

    // Twice: the op replaces the `title` node in place instead of stacking a second one.
    let mut eng2 = engine();
    apply(
        &mut eng2,
        &t,
        json!([{"op":"set_title_block","title":"hier_root"}]),
    );
    assert_eq!(std::fs::read_to_string(&t).unwrap(), after);
}

#[test]
fn reg_multiline_text_and_title_are_escaped() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([
            {"op":"add_text","text":"line one\nline \"two\"\ttabbed","at":[2000,2000]},
            {"op":"set_title_block","title":"multi\nline title","rev":"A"}
        ]),
    );
    let src = std::fs::read_to_string(&t).unwrap();
    assert!(
        src.contains("\"line one\\nline \\\"two\\\"\\ttabbed\""),
        "escaped text node"
    );
    assert!(src.contains("\"multi\\nline title\""));
    assert!(
        !src.contains("line one\nline"),
        "no raw newline inside a quoted string"
    );
    let doc = kicad_sexpr::parse(&src).unwrap();
    assert_eq!(
        doc.root
            .find("title_block")
            .unwrap()
            .find("title")
            .unwrap()
            .arg(0)
            .as_deref(),
        Some("multi\nline title")
    );
    assert_eq!(
        doc.root
            .find_all("text")
            .find(|x| x
                .arg(0)
                .as_deref()
                .map(|s| s.starts_with("line one"))
                .unwrap_or(false))
            .unwrap()
            .arg(0)
            .as_deref(),
        Some("line one\nline \"two\"\ttabbed")
    );
    erc_oracle(&t);
}

/// reg 0.3.0: duplicate pin numbers (shared pads) get distinct UUIDs (`#k` disambiguator).
#[test]
fn reg_duplicate_pin_numbers_get_distinct_uuids() {
    let root = "11111111-1111-4111-8111-111111111111";
    let a = id::node_uuid(root, &id::seed_pin("Q1", 1, "1", 0));
    let b = id::node_uuid(root, &id::seed_pin("Q1", 1, "1", 1));
    assert_ne!(a, b);
    assert_ne!(id::seed_pin("Q1", 1, "1", 0), id::seed_pin("Q1", 1, "1", 1));
}

/// reg 0.17.0 / 0.18.0: node identity is content-addressed — reordering or inserting ops
/// does not re-identify untouched symbols, wires, labels or junctions.
#[test]
fn reg_identity_independent_of_op_order_and_insertion() {
    need_kicad_libs!();
    let da = tempfile::tempdir().unwrap();
    let db = tempfile::tempdir().unwrap();
    let ta = copy_hier(da.path());
    let tb = copy_hier(db.path());
    let mut eng = engine();
    let r10 = serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap();
    let c10 = json!({"op":"place_component","group":"g","lib_id":"Device:C","designator":"C10","x_mil":600,"y_mil":-300,"value":"100n"});
    let wire = json!({"op":"route_net","from":"R10.2","to":"C10.1"});
    let label = json!({"op":"add_net_label","name":"SIG","at":"R10.1"});
    let text = json!({"op":"add_text","group":"g","text":"inserted","at":[0,-900]});
    apply(&mut eng, &ta, json!([r10, c10, wire, label]));
    apply(&mut eng, &tb, json!([c10, text, r10, label, wire]));
    let uuids = |p: &Path| -> std::collections::BTreeMap<String, String> {
        let doc = kicad_sexpr::parse(&std::fs::read_to_string(p).unwrap()).unwrap();
        let mut m = std::collections::BTreeMap::new();
        for kind in ["symbol", "wire", "label", "junction"] {
            for l in doc.root.find_all(kind) {
                let key = match kind {
                    "symbol" => l
                        .find_all("property")
                        .find(|p| p.arg(0).as_deref() == Some("Reference"))
                        .and_then(|p| p.arg(1))
                        .unwrap_or_default(),
                    "label" => l.arg(0).unwrap_or_default(),
                    _ => kicad_sexpr::dumps_list(l.find("pts").or_else(|| l.find("at")).unwrap()),
                };
                if let Some(u) = l.find("uuid").and_then(|u| u.arg(0)) {
                    m.insert(format!("{kind}:{key}"), u);
                }
            }
        }
        m
    };
    let ua = uuids(&ta);
    let ub = uuids(&tb);
    for (k, v) in &ua {
        assert_eq!(
            ub.get(k),
            Some(v),
            "{k} re-identified by op order / insertion"
        );
    }
    assert!(ua.len() >= 6, "{ua:?}");
}

/// reg 0.17.0: harmless ops on a hierarchical child sheet are allowed.
#[test]
fn reg_child_sheet_accepts_harmless_ops() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let r = apply(
        &mut eng,
        &t,
        json!([{"op":"add_text","sheet":"child","text":"child note","at":[2000,2000]}]),
    );
    assert_eq!(r.per_op[0].status, "ok");
    assert!(
        std::fs::read_to_string(dir.path().join("hier_child.kicad_sch"))
            .unwrap()
            .contains("\"child note\"")
    );
    assert!(!std::fs::read_to_string(&t)
        .unwrap()
        .contains("\"child note\""));
}

/// reg 0.18.0: a power port for a different rail on an already-powered anchor is not silently
/// stacked (that merged GND into +3V3).
#[test]
fn reg_power_port_for_another_rail_on_same_anchor_is_not_silent() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(), {"op":"place_gnd","at":"R10.2"}]),
    );
    let r = eng
        .apply(&req(
            &t,
            json!([{"op":"place_vcc","at":"R10.2","net_name":"+3V3"}]),
        ))
        .unwrap();
    assert!(
        !r.applied,
        "stacking +3V3 on the GND anchor must be refused (merge of two rails)"
    );
    assert!(
        r.net_diff.has_risk || r.per_op[0].error.is_some() || !r.integrity_introduced.is_empty(),
        "{:?}",
        r
    );
    let nl = sch_net::nets_of(&t).unwrap();
    assert!(nl.by_name("GND").is_some() && nl.by_name("+3V3").unwrap().members.len() == 1);
}

/// reg 0.18.0: `add_sheet` referencing a missing child file is refused before anything is
/// written (the root would otherwise become unreadable).
/// I: every `power:*` instance the engine writes hides its Reference, whichever op wrote it.
/// KiCad's own annotator gives a power symbol a `#PWR`/`#FLG` designator and hides it - it is
/// annotation bookkeeping, not part of the drawing - and `place_power_port` always did. Run 19
/// printed "#FLG1" beside a PWR_FLAG because the model had reached for `place_component`
/// instead, which treated the port as an ordinary part.
#[test]
fn inv_power_symbol_references_are_hidden() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &t,
        json!([
            {"op":"place_component","lib_id":"Device:R","designator":"R20","x_mil":4000,"y_mil":4000},
            {"op":"place_gnd","at":"R20.2"},
            {"op":"place_pwr_flag","at":"R20.1"},
            {"op":"place_component","lib_id":"Device:R","designator":"R21","x_mil":5000,"y_mil":4000},
            // The two paths a power symbol can reach the file by other than a port op: an
            // explicit `place_component`, with and without an authored rotation.
            {"op":"place_component","lib_id":"power:GND","designator":"#PWR90","x_mil":5000,"y_mil":4150},
            {"op":"place_component","lib_id":"power:PWR_FLAG","designator":"#FLG90","x_mil":5000,"y_mil":3850,"rotation":90}
        ]),
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let mut seen = 0;
    for sym in doc.root.find_all("symbol") {
        let lib_id = sym
            .find("lib_id")
            .and_then(|l| l.arg(0))
            .unwrap_or_default();
        if !lib_id.starts_with("power:") {
            continue;
        }
        seen += 1;
        let prop = sym
            .find_all("property")
            .find(|p| p.arg(0).as_deref() == Some("Reference"))
            .unwrap_or_else(|| panic!("{lib_id} has no Reference"));
        let hidden = prop
            .find("effects")
            .map(|e| {
                e.find("hide")
                    .map(|h| h.arg(0).as_deref() != Some("no"))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        assert!(
            hidden,
            "{lib_id} {:?} draws its Reference",
            prop.arg(1).unwrap_or_default()
        );
    }
    // The four this test wrote, plus whatever the fixture already carries - the invariant
    // holds for every power instance in the file, not only the fresh ones.
    assert!(seen >= 4, "only {seen} power symbols found");
    erc_oracle(&t);
}

/// reg: a power symbol is a port, so `place_component` gives it the pose KiCad's own convention
/// gives it - away from the pin it lands on - rather than the rotation the model wrote. Run 19
/// asked for a `power:PWR_FLAG` at 90 degrees on a pin whose own away direction is up; the flag
/// stood across the connector's pin row with its net name drawn down it.
#[test]
fn reg_power_symbol_placed_as_a_component_faces_its_pin() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let r = apply(
        &mut eng,
        &t,
        json!([
            {"op":"place_component","lib_id":"Device:R","designator":"R21","x_mil":5000,"y_mil":4000},
            {"op":"place_component","lib_id":"power:PWR_FLAG","designator":"#FLG90","x_mil":5000,"y_mil":3850,"rotation":90},
            // `exact` is the author keeping a pose deliberately: it is written verbatim.
            {"op":"place_component","lib_id":"power:PWR_FLAG","designator":"#FLG91","x_mil":6000,"y_mil":3000,"rotation":90,"exact":true}
        ]),
    );
    assert!(
        r.per_op[1]
            .warnings
            .iter()
            .any(|w| w.starts_with("PLACEMENT_POWER_ROTATION_IGNORED")),
        "the ignored rotation is never silent: {:?}",
        r.per_op[1]
    );
    assert!(
        r.per_op[2].warnings.is_empty()
            || !r.per_op[2]
                .warnings
                .iter()
                .any(|w| w.starts_with("PLACEMENT_POWER_ROTATION_IGNORED")),
        "{:?}",
        r.per_op[2]
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    // R21 pin 1 points up, so the flag on it points up too: the library's own pose, rot 0.
    assert_eq!(
        symbol_node(&doc, "#FLG90")
            .unwrap()
            .find("at")
            .unwrap()
            .arg_f64(2),
        Some(0.0)
    );
    assert_eq!(
        symbol_node(&doc, "#FLG91")
            .unwrap()
            .find("at")
            .unwrap()
            .arg_f64(2),
        Some(90.0)
    );
}

#[test]
fn reg_add_sheet_missing_child_file_refused() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let sha0 = atomic::file_sha(&t).unwrap();
    let r = eng.apply(&req(&t, json!([{"op":"add_sheet","name":"nope","file":"nope.kicad_sch","at":[8000,2000],"size":[1000,600],"pins":[],"create":false}]))).unwrap();
    assert!(!r.applied);
    assert_eq!(
        r.per_op[0].error.as_ref().map(|e| e.code.as_str()),
        Some("SHEET_FILE_MISSING"),
        "{:?}",
        r.per_op
    );
    assert_eq!(atomic::file_sha(&t).unwrap(), sha0);
    assert!(sch_read::read_project(&t).is_ok(), "root still readable");
}

/// reg 0.19.0: a dangling report points at the free end only, not the live end.
#[test]
fn reg_dangling_report_names_the_free_end_only() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // R10 pin1 is at (4000,3850) mil; wire from the pin to a free point
    let r = eng.plan(&req(&t, json!([serde_json::from_str::<serde_json::Value>(PLACE_R10).unwrap(), {"op":"add_wire","vertices":[[4000,3850],[4600,3850]]}]))).unwrap();
    let d: Vec<&sch_write::gates::Finding> = r
        .integrity_introduced
        .iter()
        .filter(|f| f.code == "DANGLING_ENDPOINT")
        .collect();
    assert_eq!(d.len(), 1, "{d:?} all={:?}", r.integrity_introduced);
    let at = d[0].at_mil.unwrap();
    assert!(
        (at[0] - 4600.0).abs() < 1.0 && (at[1] - 3850.0).abs() < 1.0,
        "{:?}",
        d[0]
    );
    // location = wire uuid + free end in nm; the live end (4000 mil = 101600000 nm) is not named
    assert!(
        d[0].location.ends_with(":116840000:97790000"),
        "{}",
        d[0].location
    );
    assert!(
        !d[0].location.contains("101600000"),
        "live end must not be reported: {}",
        d[0].location
    );
}

/// reg 0.19.0: mirroring a symmetric two-pin part swaps the pins on its nets; the write gate
/// sees the swap as a named-net change and refuses under strict nets.
#[test]
fn reg_mirror_of_symmetric_part_is_a_net_change() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // R1: pin1 on +3V3, pin2 on GLB. Mirror X flips it vertically.
    let r = eng
        .apply(&req(
            &t,
            json!([{"op":"set_component_transform","designator":"R1","mirror":"x"}]),
        ))
        .unwrap();
    assert!(
        r.net_diff.has_risk
            || r.net_diff
                .changes
                .iter()
                .any(|c| matches!(c, sch_net::NetChange::MembersChanged { .. })),
        "{:?}",
        r.net_diff
    );
    assert!(
        !r.applied,
        "a rail/net swap is not applied silently under strict nets"
    );
}

/// N/A here: the runtime `kicad-cli` invocation (no `--` separator, no `--exit-code-violations`)
/// lives in `src-tauri`, not in the engine crates. The oracle helpers in this file also never
/// pass `--`; red line 8 is enforced by review of `src-tauri/src/engine.rs`.
#[test]
#[ignore = "N/A: runtime kicad-cli argv is owned by src-tauri (red line 8), not by the engine crates"]
fn reg_kicad_cli_no_double_dash_separator() {}

/// E2 oracle: every conformance fixture and every golden-set reference op-list, applied to an
/// empty sheet, loads in `kicad-cli sch erc` without annotation / library errors.
#[test]
fn erc_oracle_on_fixtures_and_golden_references() {
    need_kicad_libs!();
    if require_oracle().is_none() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let hier = dir.path().join("hier");
    std::fs::create_dir_all(&hier).unwrap();
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fixtures().join("hier").join(f), hier.join(f)).unwrap();
    }
    erc_oracle(&hier.join("hier_root.kicad_sch")).unwrap();
    let tasks = fixtures().join("../../golden-set/tasks");
    let mut eng = engine();
    let mut n = 0;
    for entry in std::fs::read_dir(&tasks).unwrap() {
        let task = entry.unwrap().path();
        let ops = task.join("reference.ops.json");
        if !ops.exists() {
            continue;
        }
        let pdir = dir.path().join(task.file_name().unwrap());
        std::fs::create_dir_all(&pdir).unwrap();
        // Editing tasks start from `fixture/` (a project with its sheets); the others from the minimal sheet.
        let fixture = task.join("fixture");
        let sch = if fixture.is_dir() {
            let mut root = None;
            for f in std::fs::read_dir(&fixture).unwrap() {
                let f = f.unwrap().path();
                let name = f.file_name().unwrap().to_owned();
                std::fs::copy(&f, pdir.join(&name)).unwrap();
                if f.extension().is_some_and(|e| e == "kicad_pro") {
                    root = Some(pdir.join(&name).with_extension("kicad_sch"));
                }
            }
            root.expect("fixture has a .kicad_pro")
        } else {
            let sch = pdir.join("t.kicad_sch");
            std::fs::copy(fixtures().join("sch/minimal.kicad_sch"), &sch).unwrap();
            std::fs::write(
                pdir.join("t.kicad_pro"),
                "{\"meta\":{\"filename\":\"t.kicad_pro\",\"version\":3}}\n",
            )
            .unwrap();
            sch
        };
        let mut rq = req(&sch, json!([]));
        rq.oplist = OpList::from_json(&std::fs::read_to_string(&ops).unwrap()).unwrap();
        rq.strict_layout = false;
        let r = eng.apply(&rq).unwrap();
        assert!(
            r.applied,
            "{}: {:?} {:?}",
            task.display(),
            r.refusal,
            r.per_op
                .iter()
                .filter_map(|o| o.error.as_ref())
                .collect::<Vec<_>>()
        );
        erc_oracle(&sch).unwrap();
        n += 1;
    }
    assert!(n >= 10, "golden references applied: {n}");
}

/// reg: `(power local)` symbols are sheet-instance scoped by design, so the same power name on two
/// sheet instances is not `RAIL_SCOPE_SPLIT` -- a repeated *local label* still is.
#[test]
fn reg_rail_scope_split_skips_local_power_symbols() {
    let root = fixtures().join("local_power/twicelocal_root.kicad_sch");
    let tree = sch_read::read_project(&root).unwrap();
    let nets = sch_net::build_nets(&tree);
    // The netlist says which nets a local power symbol named.
    assert!(nets
        .nets
        .iter()
        .any(|n| n.name == "/ampA/VLOC" && n.local_power));
    let split: Vec<String> = sch_write::gates::delivery(&tree, &nets)
        .iter()
        .filter(|f| f.code == "RAIL_SCOPE_SPLIT")
        .map(|f| f.message.clone())
        .collect();
    assert!(split.is_empty(), "{split:?}");

    // The same name drawn as a local label on two sheets: still a scope split.
    let d = tempfile::tempdir().unwrap();
    let target = copy_hier(d.path());
    let mut eng = engine();
    apply(
        &mut eng,
        &target,
        json!([
            {"op": "place_component", "lib_id": "Device:R", "designator": "R9", "value": "1k", "x_mil": 6000, "y_mil": 6000},
            {"op": "add_net_label", "name": "VBUS", "at": "R9.1", "scope": "local"},
            {"op": "add_net_label", "name": "VBUS", "at": "R5.2", "scope": "local", "sheet": "child"},
            {"op": "add_net_label", "name": "SENSE_A", "at": "R9.2", "scope": "local"},
            {"op": "place_component", "lib_id": "Device:R", "designator": "R10", "value": "1k", "x_mil": 6000, "y_mil": 6000, "sheet": "child"},
            {"op": "add_net_label", "name": "SENSE_A", "at": "R10.1", "scope": "local", "sheet": "child"}
        ]),
    );
    let tree = sch_read::read_project(&target).unwrap();
    let nets = sch_net::build_nets(&tree);
    assert!(nets.nets.iter().all(|n| !n.local_power));
    let findings = sch_write::gates::delivery(&tree, &nets);
    assert!(
        findings
            .iter()
            .any(|f| f.code == "RAIL_SCOPE_SPLIT" && f.message.contains("VBUS")),
        "a local label repeated on two sheets is still a scope split"
    );
    // The same split on a name that is not a rail is a naming finding, not a rail finding: the
    // fix is a global / hierarchical label or a per-sheet rename, never a power port.
    assert!(
        findings
            .iter()
            .any(|f| f.code == "LABEL_SCOPE_SPLIT" && f.message.contains("SENSE_A")),
        "{findings:?}"
    );
    assert!(
        !findings
            .iter()
            .any(|f| f.code == "RAIL_SCOPE_SPLIT" && f.message.contains("SENSE_A")),
        "{findings:?}"
    );
}

// ---------------------------------------------------------------------------
// Drawing border (gates::drawing_border): the placement nudge and the layout
// gate read the same rectangle, so a part can never be placed where the gate
// would then report it.
// ---------------------------------------------------------------------------

/// A placement on a spot that is empty but under the worksheet frame is nudged inside the border,
/// and refused when the border is further away than the nudge bound. Regression: a real Build run
/// wrote an AMS1117 at (0, 100) mil - clear of everything, and off the printed page - because the
/// nudge returned `Clear` before it looked at the frame.
#[test]
fn inv_24_a_placement_at_the_page_corner_is_nudged_into_the_drawing_border() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // 300 mil from both edges: empty, under the frame, and within reach of the border.
    let r = apply(
        &mut eng,
        &t,
        json!([{"op":"place_component","lib_id":"Device:R","designator":"R20","value":"1k","x_mil":300,"y_mil":300}]),
    );
    let w = r.per_op[0].warnings.join(" | ");
    assert!(
        w.contains("PLACEMENT_NUDGED") && w.contains("drawing border"),
        "{w}"
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let at = symbol_node(&doc, "R20").unwrap().find("at").unwrap();
    let (x, y) = (at.arg_f64(0).unwrap(), at.arg_f64(1).unwrap());
    // A4 border: 500 mil in from the left and top edges (12.7 mm), and the body reaches 150 mil
    // past the anchor on both sides.
    assert!(x >= 12.7 && y >= 16.51, "R20 nudged to ({x},{y}) mm");
    let tree = sch_read::read_project(&t).unwrap();
    assert!(
        !sch_write::gates::layout(&tree)
            .iter()
            .any(|f| f.code == "OUT_OF_FRAME"),
        "the nudged spot must satisfy the gate that shares the border"
    );

    // The page corner (run 18's AMS1117) and 8000 mil on A4 (on the paper, 1200 mil below the
    // title-block line) are both further from the border than the 600 mil nudge bound: refused
    // rather than teleported across the sheet.
    for (des, x_mil, y_mil) in [("R21", 0, 0), ("R22", 4000, 8000)] {
        let r = eng
            .apply(&req(
                &t,
                json!([{"op":"place_component","lib_id":"Device:R","designator":des,"value":"1k","x_mil":x_mil,"y_mil":y_mil}]),
            ))
            .unwrap();
        assert!(!r.applied);
        let err = r.per_op[0].error.as_ref().expect("refused");
        assert_eq!(err.code, "PLACEMENT_BLOCKED", "{err:?}");
        assert!(err.message.contains("drawing border"), "{err:?}");
    }

    // `exact` is the author saying they chose the spot: it is written, with a warning.
    let r = apply(
        &mut eng,
        &t,
        json!([{"op":"place_component","lib_id":"Device:R","designator":"R21","value":"1k","x_mil":4000,"y_mil":8000,"exact":true}]),
    );
    assert!(
        r.per_op[0]
            .warnings
            .iter()
            .any(|w| w.starts_with("PLACEMENT_OFF_FRAME")),
        "{:?}",
        r.per_op[0].warnings
    );
    assert!(
        r.layout.iter().any(|f| f.code == "OUT_OF_FRAME"
            && f.severity == sch_write::gates::Severity::Warning
            && f.refs == vec!["R21".to_string()]),
        "{:?}",
        r.layout
    );
    erc_oracle(&t);
}

/// A hand-built sheet with one part, one label and one wire under the worksheet frame, and the
/// same three inside it: `OUT_OF_FRAME` is a Warning off the border and silent inside.
#[test]
fn inv_25_out_of_frame_fires_off_the_drawing_border_and_not_inside() {
    let dir = tempfile::tempdir().unwrap();
    let lib = r#"	(symbol "Test:R"
		(pin_numbers (hide yes))
		(pin_names (offset 0))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "R" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
		(property "Value" "R" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
		(symbol "R_0_1"
			(rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
			(pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
		)
		(embedded_fonts no)
	)
"#;
    // Two of everything: one well inside the A4 border (500 mil = 12.7 mm in from the edges, and
    // 1500 mil = 38.1 mm up from the bottom) and one under the frame.
    let part = |refdes: &str, uuid: &str, x: f64, y: f64| {
        format!(
            "\t(symbol (lib_id \"Test:R\") (at {x} {y} 0) (unit 1) (dnp no) (uuid \"{uuid}\")\n\t\t(property \"Reference\" \"{refdes}\" (at {x} {y} 0) (effects (font (size 1.27 1.27))))\n\t\t(property \"Value\" \"1k\" (at {x} {y} 0) (effects (font (size 1.27 1.27))))\n\t\t(pin \"1\" (uuid \"{uuid}\"))\n\t)\n"
        )
    };
    let label = |text: &str, uuid: &str, x: f64, y: f64| {
        format!("\t(label \"{text}\" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid \"{uuid}\"))\n")
    };
    let wire = |uuid: &str, x0: f64, y0: f64, x1: f64, y1: f64| {
        format!("\t(wire (pts (xy {x0} {y0}) (xy {x1} {y1})) (stroke (width 0) (type default)) (uuid \"{uuid}\"))\n")
    };
    let body = part("R1", "aaaaaaa1-0000-4000-8000-000000000001", 50.8, 50.8)
        + &part("R2", "aaaaaaa1-0000-4000-8000-000000000002", 5.08, 5.08)
        + &label("IN", "aaaaaaa1-0000-4000-8000-000000000003", 50.8, 60.96)
        + &label("OUT", "aaaaaaa1-0000-4000-8000-000000000004", 2.54, 60.96)
        + &wire(
            "aaaaaaa1-0000-4000-8000-000000000005",
            50.8,
            76.2,
            63.5,
            76.2,
        )
        + &wire(
            "aaaaaaa1-0000-4000-8000-000000000006",
            2.54,
            190.5,
            15.24,
            190.5,
        );
    let sch = dir.path().join("frame.kicad_sch");
    std::fs::write(
        &sch,
        format!("(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"aaaaaaa1-0000-4000-8000-0000000000f0\")\n\t(paper \"A4\")\n\t(lib_symbols\n{lib}\t)\n{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n"),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("frame.kicad_pro"),
        "{\"meta\": {\"filename\": \"frame.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    let tree = sch_read::read_project(&sch).unwrap();
    let mut fs: Vec<sch_write::gates::Finding> = sch_write::gates::layout(&tree)
        .into_iter()
        .filter(|f| f.code == "OUT_OF_FRAME")
        .collect();
    fs.sort_by(|a, b| a.location.cmp(&b.location));
    let locs: Vec<&str> = fs.iter().map(|f| f.location.as_str()).collect();
    assert_eq!(
        locs,
        vec![
            "border:aaaaaaa1-0000-4000-8000-000000000002",
            "border:aaaaaaa1-0000-4000-8000-000000000004",
            "border:aaaaaaa1-0000-4000-8000-000000000006",
        ],
        "only the three objects under the frame; {fs:?}"
    );
    for f in &fs {
        assert_eq!(f.severity, sch_write::gates::Severity::Warning);
        assert!(f.message.contains("drawing border"), "{}", f.message);
    }
}
