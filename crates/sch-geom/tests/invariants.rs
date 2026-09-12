// SPDX-License-Identifier: Apache-2.0
//! I24 (every geometry point goes through the single transform) and the render robustness
//! regression (0.18.0: render crashed on 59% of the standard library).

use std::path::Path;

fn hier() -> sch_read::SheetTree {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch");
    sch_read::read_project(&p).unwrap()
}

#[test]
fn inv_24_pin_geometry_equals_transform_point_of_library_pins() {
    let tree = hier();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let geom = sch_geom::sheet_geometry(&tree, &inst.names).unwrap();
        let rendered = sch_geom::render_sheet(&tree, &inst.names).unwrap();
        for sym in &sheet.symbols {
            let lib = sheet.lib_symbol(&sym.lib_id).unwrap();
            let expect: Vec<(String, [f64; 2])> = sch_model::world_pins(sym, lib)
                .into_iter()
                .map(|p| {
                    (
                        p.number,
                        [sch_model::nm_to_mil(p.at.x), sch_model::nm_to_mil(p.at.y)],
                    )
                })
                .collect();
            let g = geom.symbols.iter().find(|g| g.uuid == sym.uuid).unwrap();
            let got: Vec<(String, [f64; 2])> = g
                .pins
                .iter()
                .map(|p| (p.number.clone(), p.at_mil))
                .collect();
            assert_eq!(
                got, expect,
                "sheet_geometry pins of {} must be transform_point(lib pin)",
                sym.reference
            );
            let r = rendered
                .symbols
                .iter()
                .find(|r| r.uuid == sym.uuid)
                .unwrap();
            let mut rp: Vec<(String, [f64; 2])> = r
                .pins
                .iter()
                .map(|p| (p.number.clone(), [p.at[0].round(), p.at[1].round()]))
                .collect();
            rp.sort_by(|a, b| a.0.cmp(&b.0));
            let mut ep = expect.clone();
            ep.sort_by(|a, b| a.0.cmp(&b.0));
            assert_eq!(
                rp, ep,
                "render pins of {} must be transform_point(lib pin)",
                sym.reference
            );
            // bbox contains every pin anchor
            for (_, [x, y]) in &expect {
                assert!(
                    *x >= g.bbox_mil[0][0] - 1.0
                        && *x <= g.bbox_mil[1][0] + 1.0
                        && *y >= g.bbox_mil[0][1] - 1.0
                        && *y <= g.bbox_mil[1][1] + 1.0,
                    "{} pin outside bbox",
                    sym.reference
                );
            }
        }
    }
}

/// I25 for geometry: same input, same JSON bytes.
#[test]
fn inv_25_geometry_json_is_deterministic() {
    let tree = hier();
    let a = serde_json::to_string(&sch_geom::render_sheet(&tree, "/").unwrap()).unwrap();
    let b = serde_json::to_string(&sch_geom::render_sheet(&hier(), "/").unwrap()).unwrap();
    assert_eq!(a, b);
}

/// reg 0.18.0: rendering must be None-safe over the whole standard library (optional nodes
/// missing, odd arcs, zero-length pins, text-only symbols, extends chains).
#[test]
fn reg_render_is_none_safe_over_standard_library() {
    let (env, table) = sch_read::discover_kicad(None);
    let Some(table) = table else {
        let required = std::env::var("FLUXSMITH_CONFORMANCE")
            .map(|v| v == "required")
            .unwrap_or(false);
        assert!(
            !required,
            "FLUXSMITH_CONFORMANCE=required but KiCad libraries were not found"
        );
        eprintln!("KiCad not installed: skipping library render sweep");
        return;
    };
    let rows = sch_read::parse_lib_table(&table, &env, 0).unwrap();
    let mut lib = sch_read::SymbolLibrary::new(rows);
    let dir = tempfile::tempdir().unwrap();
    let mut total = 0usize;
    let mut with_shapes = 0usize;
    for nick in [
        "Device",
        "power",
        "Connector_Generic",
        "Regulator_Linear",
        "MCU_Microchip_ATtiny",
    ] {
        let Some(row) = lib.rows.iter().find(|r| r.nickname == nick).cloned() else {
            continue;
        };
        let Ok(src) = std::fs::read_to_string(&row.uri) else {
            continue;
        };
        let names: Vec<String> = sch_read::parse_symbol_lib(&src, nick, Path::new(&row.uri))
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        for id in names {
            let Some(node) = lib.cache_node(&id) else {
                continue;
            };
            let sch = format!(
                "(kicad_sch (version 20260306) (generator \"t\") (generator_version \"10.0\") (uuid \"11111111-1111-4111-8111-111111111111\") (paper \"A4\")\n(lib_symbols {})\n(symbol (lib_id \"{id}\") (at 50.8 50.8 90) (mirror y) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid \"aaaaaaaa-aaaa-4aaa-8aaa-000000000001\") (property \"Reference\" \"X1\" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)))) (property \"Value\" \"v\" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)))) (instances (project \"t\" (path \"/11111111-1111-4111-8111-111111111111\" (reference \"X1\") (unit 1)))))\n(sheet_instances (path \"/\" (page \"1\"))))\n",
                kicad_sexpr::dumps_list(&node)
            );
            let f = dir.path().join("t.kicad_sch");
            std::fs::write(&f, sch).unwrap();
            let tree = sch_read::read_project(&f).unwrap_or_else(|e| panic!("{id}: {e}"));
            let r = sch_geom::render_sheet(&tree, "/").unwrap_or_else(|| panic!("{id}: no render"));
            assert_eq!(r.symbols.len(), 1, "{id}");
            assert!(!r.symbols[0].unresolved, "{id} unresolved");
            let _ = sch_geom::sheet_geometry(&tree, "/").unwrap();
            let _ = sch_geom::overlap_findings(&tree);
            total += 1;
            if !r.symbols[0].shapes.is_empty() {
                with_shapes += 1;
            }
        }
    }
    assert!(total > 200, "swept {total} symbols");
    assert!(
        with_shapes * 10 >= total * 9,
        "{with_shapes}/{total} symbols rendered with shapes"
    );
}
