// SPDX-License-Identifier: Apache-2.0
use std::path::Path;

fn fixture() -> sch_read::SheetTree {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch");
    sch_read::read_project(&p).unwrap()
}

#[test]
fn every_symbol_has_a_bbox_and_sheet_geometry_is_serialisable() {
    let tree = fixture();
    let root = tree.root_file.clone();
    for s in &tree.root().symbols {
        let b = sch_geom::symbol_bbox(&tree.docs[&root], s).expect("bbox");
        assert!(b.max.x > b.min.x && b.max.y > b.min.y, "{}", s.reference);
    }
    let g = sch_geom::sheet_geometry(&tree, "/").unwrap();
    let json = serde_json::to_string(&g).unwrap();
    assert!(json.contains("labels"));
}

#[test]
fn overlap_findings_are_clean_on_fixture() {
    let tree = fixture();
    let f = sch_geom::overlap_findings(&tree);
    assert!(f.is_empty(), "{f:?}");
}
