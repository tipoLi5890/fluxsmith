// SPDX-License-Identifier: Apache-2.0
use sch_geom::{render_sheet, RShape};
use std::path::{Path, PathBuf};

fn hier() -> sch_read::SheetTree {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch");
    sch_read::read_project(&p).unwrap()
}

fn extra_fixtures() -> Vec<PathBuf> {
    std::env::var("FLUXSMITH_EXTRA_FIXTURES")
        .ok()
        .map(|v| {
            v.split(':')
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

fn assert_pins_match_world_pins(tree: &sch_read::SheetTree) {
    for inst in &tree.instances {
        let rs = render_sheet(tree, &inst.names).expect("render");
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let lib = sheet.lib_symbol(&s.lib_id).expect("lib symbol in cache");
            let expect: Vec<(String, [f64; 2])> = sch_model::world_pins(s, lib)
                .into_iter()
                .map(|p| {
                    (
                        p.number,
                        [sch_model::nm_to_mil(p.at.x), sch_model::nm_to_mil(p.at.y)],
                    )
                })
                .collect();
            let r = rs
                .symbols
                .iter()
                .find(|r| r.uuid == s.uuid)
                .expect("rendered symbol");
            assert!(!r.unresolved, "{} unresolved", s.reference);
            assert_eq!(r.pins.len(), expect.len(), "{} pin count", s.reference);
            for (num, at) in &expect {
                let rp = r
                    .pins
                    .iter()
                    .find(|p| &p.number == num)
                    .unwrap_or_else(|| panic!("{} pin {num}", s.reference));
                assert!(
                    (rp.at[0] - at[0]).abs() < 1e-6 && (rp.at[1] - at[1]).abs() < 1e-6,
                    "{} pin {num}: {:?} vs {:?}",
                    s.reference,
                    rp.at,
                    at
                );
                // stub end is `length` away along `dir`
                let ex = rp.at[0] + rp.dir[0] * rp.length_mil;
                let ey = rp.at[1] + rp.dir[1] * rp.length_mil;
                assert!(
                    (rp.end[0] - ex).abs() < 1e-3 && (rp.end[1] - ey).abs() < 1e-3,
                    "{} pin {num} end",
                    s.reference
                );
            }
            assert!(
                !r.shapes.is_empty() || !r.pins.is_empty(),
                "{} has no body",
                s.reference
            );
        }
    }
}

#[test]
fn pins_land_where_world_pins_put_them() {
    assert_pins_match_world_pins(&hier());
    for f in extra_fixtures() {
        let tree = sch_read::read_project(&f).unwrap();
        assert_pins_match_world_pins(&tree);
    }
}

#[test]
fn render_sheet_covers_every_item_and_round_trips() {
    let tree = hier();
    let root = render_sheet(&tree, "/").unwrap();
    let sheet = tree.root();
    assert_eq!(root.symbols.len(), sheet.symbols.len());
    assert_eq!(root.wires.len(), sheet.wires.len());
    assert_eq!(root.labels.len(), sheet.labels.len());
    assert_eq!(root.sheets.len(), sheet.sheets.len());
    assert_eq!(root.junctions.len(), sheet.junctions.len());
    assert_eq!(root.paper_mm, [297.0, 210.0]);
    assert!(root.bbox[1][0] > root.bbox[0][0]);
    // Every symbol has reference/value texts.
    for s in &root.symbols {
        assert!(
            s.texts.iter().any(|t| t.role == "reference"),
            "{}",
            s.reference
        );
        assert!(s.texts.iter().any(|t| t.role == "value"), "{}", s.reference);
    }
    // R body is a rectangle primitive.
    let r1 = root.symbols.iter().find(|s| s.reference == "R1").unwrap();
    assert!(r1
        .shapes
        .iter()
        .any(|s| matches!(s, RShape::Rectangle { .. })));
    // Child sheet renders via both the name path and the uuid path.
    let child = tree.instances.iter().find(|i| i.names != "/").unwrap();
    let a = render_sheet(&tree, &child.names).unwrap();
    let b = render_sheet(&tree, &child.path).unwrap();
    assert_eq!(a, b);
    assert!(a.bus_entries.len() + a.wires.iter().filter(|w| w.is_bus).count() > 0);
    // JSON round trip.
    let json = serde_json::to_string(&root).unwrap();
    let back: sch_geom::RenderSheet = serde_json::from_str(&json).unwrap();
    assert_eq!(back, root);
    if std::env::var("UPDATE_RENDER_FIXTURE").is_ok() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let out = manifest.join("tests/fixtures/hier_root.render.json");
        // The dump is committed, so `file` is stored relative to the workspace root
        // rather than as whatever absolute path this machine happens to use.
        let mut dump = root.clone();
        let repo = manifest.join("../..").canonicalize().unwrap();
        if let Ok(rel) = Path::new(&dump.file).strip_prefix(&repo) {
            dump.file = rel.to_string_lossy().into_owned();
        }
        std::fs::write(out, serde_json::to_string_pretty(&dump).unwrap() + "\n").unwrap();
    }
}

#[test]
fn mirrored_and_rotated_symbols_keep_body_around_pins() {
    // Build a synthetic placement matrix from the R symbol in the fixture and
    // check the body bbox always contains the pin stubs' body ends.
    let tree = hier();
    let sheet = tree.root();
    let doc = &tree.docs[&tree.root_file];
    let base = sheet.symbols.iter().find(|s| s.reference == "R1").unwrap();
    for rot in [
        sch_model::Rot::R0,
        sch_model::Rot::R90,
        sch_model::Rot::R180,
        sch_model::Rot::R270,
    ] {
        for mirror in [
            sch_model::Mirror::None,
            sch_model::Mirror::X,
            sch_model::Mirror::Y,
        ] {
            let mut s = base.clone();
            s.placement.rot = rot;
            s.placement.mirror = mirror;
            let r = sch_geom::render_symbol(doc, sheet, &s, "R1");
            for p in &r.pins {
                assert!(p.end[0] >= r.bbox[0][0] - 1e-6 && p.end[0] <= r.bbox[1][0] + 1e-6);
                assert!(p.end[1] >= r.bbox[0][1] - 1e-6 && p.end[1] <= r.bbox[1][1] + 1e-6);
            }
            let lib = sheet.lib_symbol(&s.lib_id).unwrap();
            for wp in sch_model::world_pins(&s, lib) {
                let rp = r.pins.iter().find(|p| p.number == wp.number).unwrap();
                assert_eq!(
                    rp.at,
                    [
                        sch_geom::round_mil(sch_model::nm_to_mil(wp.at.x)),
                        sch_geom::round_mil(sch_model::nm_to_mil(wp.at.y))
                    ]
                );
            }
        }
    }
}
