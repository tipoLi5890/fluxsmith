// SPDX-License-Identifier: Apache-2.0
//! Conformance for eeschema-equivalent field autoplace (`sch_write::autoplace`).
//!
//! KiCad's own libraries park property texts where only eeschema's
//! "Automatically place symbol fields" makes them readable: `Device:R` anchors
//! its Value on the symbol origin, `Regulator_Linear:AMS1117-3.3` puts
//! Reference and Value on one row. A symbol this engine places must come out
//! looking hand-placed, at every rotation and mirror.

use sch_ops::OpList;
use sch_read::bbox::{symbol_graphics_bbox, symbol_text_boxes, BBox};
use sch_write::{DrawRequest, Engine};
use std::path::{Path, PathBuf};

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
        // The sheet is a grid of unconnected parts; the point of the test is
        // the geometry inside each symbol, not the block layout.
        strict_layout: false,
        expected_merges: vec![],
        note: Some("test".into()),
        backup_depth: 2,
        journal: Some(target.parent().unwrap().join(".fluxsmith/journal.jsonl")),
        expected_target_sha: None,
        run_backup_dir: None,
    }
}

/// Every rotation and mirror the op vocabulary allows.
const POSES: [(i64, &str); 12] = [
    (0, "none"),
    (90, "none"),
    (180, "none"),
    (270, "none"),
    (0, "x"),
    (90, "x"),
    (180, "x"),
    (270, "x"),
    (0, "y"),
    (90, "y"),
    (180, "y"),
    (270, "y"),
];

/// Parts whose library anchors are known to need autoplace (`R`, the LDO) plus
/// parts whose anchors are already fine (`C`, `LED`, `Crystal`) plus a
/// multi-pin IC with pins down both sides.
const PARTS: [(&str, &str, &str); 6] = [
    ("Device:R", "R", "100k"),
    ("Device:C", "C", "100n"),
    ("Device:LED", "D", "LED"),
    ("Device:Crystal", "Y", "8MHz"),
    ("Regulator_Linear:AMS1117-3.3", "U", "AMS1117-3.3"),
    ("MCU_Microchip_ATtiny:ATtiny85-20P", "U", "ATtiny85-20P"),
];

/// Place one part in all twelve poses on a spread-out grid and return the
/// sheet, so a caller can measure the resulting boxes.
fn place_all_poses(dir: &Path, lib_id: &str, prefix: &str, value: &str) -> PathBuf {
    let t = copy_hier(dir);
    let mut eng = engine();
    let mut ops = String::from(r#"{"protocol_version":1,"ops":["#);
    for (i, (rot, mirror)) in POSES.iter().enumerate() {
        if i > 0 {
            ops.push(',');
        }
        // 1800 mil apart: far enough that no part's fields reach a neighbour,
        // so a nudge never fires and the anchors are the authored ones.
        let x = 1500 + (i as i64 % 4) * 1800;
        let y = 1500 + (i as i64 / 4) * 1800;
        ops.push_str(&format!(
            r#"{{"op":"place_component","lib_id":"{lib_id}","designator":"{prefix}9{i}","x_mil":{x},"y_mil":{y},"rotation":{rot},"mirror":"{mirror}","value":"{value}"}}"#
        ));
    }
    ops.push_str("]}");
    let r = eng.apply(&req(&t, &ops)).unwrap();
    assert!(r.applied, "{lib_id}: {:?}", r.refusal);
    t
}

/// The symbol-frame angle stored on a placed symbol's Reference; the writer
/// gives every field of one symbol the same angle, so it stands for the pair.
fn stored_angle(doc: &kicad_sexpr::Document, sym: &sch_model::SymbolInst) -> i64 {
    let Some(kicad_sexpr::Node::List(node)) = doc.root.children.get(sym.node_index) else {
        panic!("{} has no node", sym.reference);
    };
    node.find_all("property")
        .find(|p| p.arg(0).as_deref() == Some("Reference"))
        .and_then(|p| p.find("at").and_then(|a| a.arg_f64(2)))
        .unwrap_or(0.0)
        .round() as i64
}

/// I: a symbol the engine places has every visible property text clear of its
/// own body and of the symbol's other fields, at every rotation and mirror.
#[test]
fn conf_placed_fields_clear_the_body_and_each_other() {
    for (lib_id, prefix, value) in PARTS {
        let dir = tempfile::tempdir().unwrap();
        let t = place_all_poses(dir.path(), lib_id, prefix, value);
        let tree = sch_read::read_project(&t).unwrap();
        let sheet = tree.root();
        let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
        let mut seen = 0;
        // Only the symbols this test placed: the fixture's own parts were not
        // touched by the write and must keep the anchors they already had.
        let placed = format!("{prefix}9");
        for sym in &sheet.symbols {
            if sym.lib_id != lib_id || !sym.reference.starts_with(&placed) {
                continue;
            }
            seen += 1;
            let body = symbol_graphics_bbox(&doc, sym).expect("body box");
            let boxes: Vec<(String, BBox)> = symbol_text_boxes(&doc, sym);
            assert_eq!(
                boxes.len(),
                2,
                "{} shows Reference and Value",
                sym.reference
            );
            for (what, b) in &boxes {
                assert!(
                    !b.intersects(&body),
                    "{lib_id} {:?}: {what} {:?} sits on the body {:?}",
                    sym.placement,
                    b.to_mil(),
                    body.to_mil()
                );
            }
            assert!(
                !boxes[0].1.intersects(&boxes[1].1),
                "{lib_id} {:?}: {} and {} overlap ({:?} / {:?})",
                sym.placement,
                boxes[0].0,
                boxes[1].0,
                boxes[0].1.to_mil(),
                boxes[1].1.to_mil()
            );
            // Fields must also stack, never share a row: a value that runs off
            // the end of the reference reads as one long line (the
            // AMS1117-3.3 defect). "Row" is the axis across the text run, so
            // ask the shared transform which way these texts run.
            let (a, b) = (&boxes[0].1, &boxes[1].1);
            let run = sch_read::bbox::field_run_dir(stored_angle(&doc, sym), sym.placement);
            let same_row = if run.0 == 0 {
                a.min.x < b.max.x && b.min.x < a.max.x
            } else {
                a.min.y < b.max.y && b.min.y < a.max.y
            };
            assert!(
                !same_row,
                "{lib_id} {:?}: {} and {} share a row",
                sym.placement, boxes[0].0, boxes[1].0
            );
        }
        assert_eq!(seen, POSES.len(), "{lib_id}: every pose placed");
    }
}

/// reg: `Device:R` used to keep the library's Value anchor, which is the
/// symbol origin - the value was drawn inside the body on every 0-degree
/// resistor (11 instances over 6 of the 13 golden sheets). Autoplace now puts
/// both fields to the right of a vertical two-pin part, the side eeschema
/// picks, and pins the exact anchors.
#[test]
fn reg_resistor_fields_sit_beside_the_body_not_inside_it() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R91","x_mil":3000,"y_mil":3000,"value":"100k"},
      {"op":"place_component","lib_id":"Device:R","designator":"R92","x_mil":3000,"y_mil":4000,"rotation":90,"value":"27k"},
      {"op":"place_component","lib_id":"Regulator_Linear:AMS1117-3.3","designator":"U91","x_mil":5000,"y_mil":3000,"value":"AMS1117-3.3"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let src = std::fs::read_to_string(&t).unwrap();
    let doc = kicad_sexpr::parse(&src).unwrap();

    // (reference, Reference at, Value at, stored angle, justify)
    let want = [
        // R1 upright: body is 40 mil wide, so the block clears it at +100 mil
        // and straddles the body centre at the 100 mil field pitch.
        ("R91", "78.74 74.93", "78.74 77.47", "0", Some("left")),
        // R2 a quarter turn: the stored angle cancels the symbol rotation so
        // the text still draws horizontally, and the block moves to the top.
        ("R92", "76.2 95.25", "76.2 97.79", "90", None),
        // The LDO has pins left, right and below: the fields go on top.
        ("U91", "127 68.58", "127 71.12", "0", None),
    ];
    for (reference, ref_at, val_at, angle, justify) in want {
        let sym = doc
            .root
            .find_all("symbol")
            .find(|s| {
                s.find_all("property").any(|p| {
                    p.arg(0).as_deref() == Some("Reference")
                        && p.arg(1).as_deref() == Some(reference)
                })
            })
            .unwrap_or_else(|| panic!("{reference} not written"));
        assert!(
            sym.find("fields_autoplaced").is_some(),
            "{reference} must be marked (fields_autoplaced yes) so eeschema owns the fields"
        );
        for (name, want_at) in [("Reference", ref_at), ("Value", val_at)] {
            let p = sym
                .find_all("property")
                .find(|p| p.arg(0).as_deref() == Some(name))
                .unwrap();
            let at = p.find("at").unwrap();
            assert_eq!(
                format!("{} {}", at.arg(0).unwrap(), at.arg(1).unwrap()),
                want_at,
                "{reference} {name} anchor"
            );
            assert_eq!(at.arg(2).unwrap(), angle, "{reference} {name} angle");
            let got = p
                .find("effects")
                .and_then(|e| e.find("justify"))
                .and_then(|j| j.arg(0));
            assert_eq!(got.as_deref(), justify, "{reference} {name} justify");
        }
    }
}

/// reg: a library whose anchors already read well keeps them - `Device:C`
/// stacks Reference and Value above and below its plates, and that is where
/// the library author put them, so the engine must not shuffle them and must
/// not claim `fields_autoplaced`.
#[test]
fn reg_library_anchors_that_already_read_well_are_kept() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:C","designator":"C91","x_mil":3000,"y_mil":3000,"value":"100n"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let sym = doc
        .root
        .find_all("symbol")
        .find(|s| {
            s.find_all("property").any(|p| {
                p.arg(0).as_deref() == Some("Reference") && p.arg(1).as_deref() == Some("C91")
            })
        })
        .unwrap();
    assert!(
        sym.find("fields_autoplaced").is_none(),
        "the library's own anchors are not an autoplace"
    );
}

/// reg: the golden `decoupling_3v3` op-list drew "+3V3 PWR_FLAG +3V3" as one line - C1's rail
/// port text, the `PWR_FLAG` hung 300 mil aside with its own text on the same row, and C2's
/// rail port text, each just barely clear of the next. Two texts on one row with no gap between
/// them read as one string whether or not their boxes touch, so the port search now keeps a
/// reading gap and a flag puts its text on the far side from the text of the port whose node it
/// shares.
#[test]
fn reg_decoupling_pair_and_its_flags_leave_no_text_touching() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_decoupling","power_net":"+3V3","x_mil":3000,"y_mil":3000,"designator":"C1","value":"100n","gnd_net":"GND"},
      {"op":"place_decoupling","power_net":"+3V3","x_mil":3600,"y_mil":3000,"designator":"C2","value":"100n","gnd_net":"GND"},
      {"op":"place_pwr_flag","at":"C1.1"},
      {"op":"place_pwr_flag","at":"C1.2"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let tree = sch_read::read_project(&t).unwrap();
    let sheet = tree.root();
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    // Every text this op-list drew: the two capacitors and the power symbols on their pins.
    let block: Vec<(String, BBox)> = sheet
        .symbols
        .iter()
        .filter(|s| {
            s.reference == "C1"
                || s.reference == "C2"
                || sheet.lib_symbol(&s.lib_id).map(|l| l.is_power) == Some(true)
        })
        .flat_map(|s| symbol_text_boxes(&doc, s))
        .collect();
    assert!(block.len() >= 10, "{block:?}");
    // 50 mil - one grid square - is the gap the port search keeps; a pair with less than that
    // between them on one row is the "+3V3 PWR_FLAG" defect however far apart the boxes are.
    let gap = sch_model::mil_to_nm(50.0);
    for (i, (an, a)) in block.iter().enumerate() {
        for (bn, b) in block.iter().skip(i + 1) {
            assert!(
                !a.intersects(b),
                "{an} {:?} overlaps {bn} {:?}",
                a.to_mil(),
                b.to_mil()
            );
            let same_row = a.min.y < b.max.y && b.min.y < a.max.y;
            let apart = (a.min.x - b.max.x).max(b.min.x - a.max.x);
            assert!(
                !same_row || apart >= gap,
                "{an} {:?} and {bn} {:?} share a row {:.0} mil apart: they read as one string",
                a.to_mil(),
                b.to_mil(),
                sch_model::nm_to_mil(apart)
            );
        }
    }
}

/// reg: `FIELD_OVER_OWN_BODY` had no op that could repair it - the field autoplace ran only at
/// `place_component`, a move carried the texts along verbatim and a turn moved the body out from
/// under them, leaving them lying across it and, on a quarter turn, drawn sideways. A move and a
/// transform now autoplace again, and only on the symbols this engine placed: `(fields_autoplaced
/// yes)` is the marker, and a symbol a human anchored keeps its bytes (red line 2).
#[test]
fn reg_move_and_turn_place_the_fields_again() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R95","x_mil":3000,"y_mil":3000,"value":"100k"},
      {"op":"move_component","designator":"R95","x_mil":4000,"y_mil":4200},
      {"op":"set_component_transform","designator":"R95","rotation":90}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let tree = sch_read::read_project(&t).unwrap();
    let sheet = tree.root();
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&t).unwrap()).unwrap();
    let sym = sheet
        .symbols
        .iter()
        .find(|s| s.reference == "R95")
        .expect("R95");
    let node = match doc.root.children.get(sym.node_index) {
        Some(kicad_sexpr::Node::List(l)) => l,
        _ => panic!("R95 has no node"),
    };
    assert!(
        node.find("fields_autoplaced").is_some(),
        "the flag stays: the engine still owns these fields"
    );
    // The turn is what the file says it is, and the texts cancel it so they draw horizontally.
    assert_eq!(node.find("at").unwrap().arg_f64(2), Some(90.0));
    let body = symbol_graphics_bbox(&doc, sym).expect("body box");
    let boxes = symbol_text_boxes(&doc, sym);
    assert_eq!(boxes.len(), 2);
    for (what, b) in &boxes {
        assert!(
            !b.intersects(&body),
            "{what} {:?} lies on the body {:?} after a move and a turn",
            b.to_mil(),
            body.to_mil()
        );
    }
    assert!(!boxes[0].1.intersects(&boxes[1].1), "{boxes:?}");
    for name in ["Reference", "Value"] {
        let a = node
            .find_all("property")
            .find(|p| p.arg(0).as_deref() == Some(name))
            .unwrap()
            .find("at")
            .unwrap();
        assert_eq!(a.arg_f64(2), Some(90.0), "{name} angle cancels the turn");
    }
}

/// reg: a symbol whose fields a human anchored is never re-autoplaced, however its value
/// changes. `edit_existing_value`'s R1 carries its Value on the symbol origin, inside the body,
/// because that is where the fixture's author put it, and `set_component_parameters` changing
/// "1k" to "2k2" must leave that anchor byte-identical (red line 2). The engine's own symbols,
/// marked `(fields_autoplaced yes)`, do move.
#[test]
fn reg_only_our_own_fields_are_replaced_when_a_value_changes() {
    let dir = tempfile::tempdir().unwrap();
    let t = copy_hier(dir.path());
    let mut eng = engine();
    // A hand-authored symbol: fields on the anchor, no `fields_autoplaced`.
    let src = std::fs::read_to_string(&t).unwrap();
    let hand = r#"	(symbol
		(lib_id "Device:R")
		(at 190.5 190.5 0)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "11111111-2222-3333-4444-555555555555")
		(property "Reference" "R99"
			(at 190.5 190.5 90)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(property "Value" "1k"
			(at 190.5 190.5 90)
			(effects
				(font
					(size 1.27 1.27)
				)
			)
		)
		(instances
			(project "hier"
				(path "/00000000-0000-0000-0000-000000000000"
					(reference "R99")
					(unit 1)
				)
			)
		)
	)
"#;
    let marker = "\t(sheet_instances";
    std::fs::write(&t, src.replacen(marker, &format!("{hand}{marker}"), 1)).unwrap();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Device:R","designator":"R96","x_mil":3000,"y_mil":3000,"value":"1k"},
      {"op":"set_component_parameters","designator":"R96","value":"100k 1% 0805"},
      {"op":"set_component_parameters","designator":"R99","value":"2k2"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let out = std::fs::read_to_string(&t).unwrap();
    assert!(
        out.contains("(property \"Value\" \"2k2\"\n\t\t\t(at 190.5 190.5 90)"),
        "the hand-authored anchor is untouched"
    );
    let doc = kicad_sexpr::parse(&out).unwrap();
    let tree = sch_read::read_project(&t).unwrap();
    let sheet = tree.root();
    let sym = sheet.symbols.iter().find(|s| s.reference == "R96").unwrap();
    let body = symbol_graphics_bbox(&doc, sym).expect("body box");
    for (what, b) in symbol_text_boxes(&doc, sym) {
        assert!(
            !b.intersects(&body),
            "{what} {:?} lies on the body after the value grew",
            b.to_mil()
        );
    }
}
