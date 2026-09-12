// SPDX-License-Identifier: Apache-2.0
use std::path::PathBuf;

/// Looks the named file up in the directories listed in `FLUXSMITH_EXTRA_FIXTURES`
/// (colon separated). Returns `None` — and the caller skips — when it is not there.
fn extra_fixture(name: &str) -> Option<PathBuf> {
    std::env::var("FLUXSMITH_EXTRA_FIXTURES")
        .ok()?
        .split(':')
        .filter(|s| !s.is_empty())
        .map(|d| PathBuf::from(d).join(name))
        .find(|p| p.exists())
}

/// A hand-checked reference sheet: an inrush/power-entry block whose expected pin
/// coordinates and object counts were read off KiCad itself.
#[test]
fn reads_power_entry() {
    let Some(p) = extra_fixture("power_entry.kicad_sch") else {
        return;
    };
    let (sheet, _doc) = sch_read::read_sheet(&p).unwrap();
    assert_eq!(sheet.version, 20231120);
    assert_eq!(sheet.symbols.len(), 9);
    let f1 = sheet.symbol_by_ref("F1").next().unwrap();
    assert_eq!(f1.lib_id, "Device:Fuse");
    assert_eq!(f1.placement.rot, sch_model::Rot::R90);
    let lib = sheet.lib_symbol("Device:Fuse").unwrap();
    assert_eq!(lib.pins.len(), 2);
    let pins = sch_model::world_pins(f1, lib);
    // KiCad places F1's pins at x 1050 mil / 1350 mil, y 800 mil.
    let mut xs: Vec<f64> = pins.iter().map(|p| sch_model::nm_to_mil(p.at.x)).collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(xs, vec![1050.0, 1350.0]);
    assert!(pins.iter().all(|p| sch_model::nm_to_mil(p.at.y) == 800.0));
    assert_eq!(sheet.labels.len(), 16);
    assert_eq!(sheet.wires.len(), 2);
}

#[test]
fn reads_kicad_symbol_library() {
    let p = PathBuf::from(
        "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols/Device.kicad_sym",
    );
    if !p.exists() {
        return;
    }
    let src = std::fs::read_to_string(&p).unwrap();
    let syms = sch_read::parse_symbol_lib(&src, "Device", &p).unwrap();
    let r = syms.iter().find(|s| s.id == "Device:R").unwrap();
    assert_eq!(r.pins.len(), 2);
    assert_eq!(r.unit_count, 1);
    // R_Small extends nothing but R_US etc. exist; check an extends symbol resolves pins
    let derived = syms.iter().find(|s| s.extends.is_some()).unwrap();
    assert!(
        !derived.pins.is_empty(),
        "extends must inherit pins: {}",
        derived.id
    );
}

#[test]
fn discovers_kicad_and_global_table() {
    let (env, table) = sch_read::discover_kicad(None);
    if let Some(t) = table {
        let rows = sch_read::parse_lib_table(&t, &env, 0).unwrap();
        assert!(
            rows.iter().any(|r| r.nickname == "Device"),
            "global table should expand to Device"
        );
        let mut lib = sch_read::SymbolLibrary::new(rows);
        let r = lib.resolve("Device:R").expect("Device:R resolves");
        assert_eq!(r.pins.len(), 2);
    }
}
