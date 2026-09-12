// SPDX-License-Identifier: Apache-2.0
//! L1 invariants owned by sch-read (I8 read half, I18) and reader-side regressions.

use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures")
}

fn kicad_symbols_dir() -> Option<PathBuf> {
    let (env, _) = sch_read::discover_kicad(None);
    env.iter()
        .find(|(k, _)| k.starts_with("KICAD") && k.ends_with("_SYMBOL_DIR"))
        .map(|(_, v)| PathBuf::from(v))
}

#[test]
fn inv_8_instance_pins_carry_no_at() {
    for f in ["hier/hier_root.kicad_sch", "hier/hier_child.kicad_sch"] {
        let (_, doc) = sch_read::read_sheet(&fixtures().join(f)).unwrap();
        let mut seen = 0;
        for sym in doc.root.find_all("symbol") {
            for pin in sym.find_all("pin") {
                seen += 1;
                assert!(
                    pin.find("at").is_none(),
                    "{f}: instance pin {:?} must not carry (at)",
                    pin.arg(0)
                );
                assert!(pin.find("uuid").is_some());
            }
        }
        assert!(seen > 0);
    }
}

const LIB: &str = r#"(kicad_symbol_lib (version 20241209) (generator "t")
  (symbol "Base" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "Base" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "Pkg:BASE" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (symbol "Base_0_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254) (type default)) (fill (type background))))
    (symbol "Base_1_1"
      (pin input line (at -7.62 2.54 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 2.54 180) (length 2.54) (name "Y" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
    (symbol "Base_1_2"
      (pin input line (at -7.62 2.54 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 2.54 180) (length 2.54) (name "~Y" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
    (symbol "Base_2_1"
      (pin input line (at -7.62 -2.54 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
      (pin output line (at 7.62 -2.54 180) (length 2.54) (name "Z" (effects (font (size 1.27 1.27)))) (number "4" (effects (font (size 1.27 1.27))))))
    (symbol "Base_3_1"
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "VCC" (effects (font (size 1.27 1.27)))) (number "5" (effects (font (size 1.27 1.27)))))
      (pin power_in line (at 0 -7.62 90) (length 2.54) (name "GND" (effects (font (size 1.27 1.27)))) (number "6" (effects (font (size 1.27 1.27)))))))
  (symbol "Derived" (extends "Base")
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "Derived" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Datasheet" "https://example.invalid/d.pdf" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes))))
  (symbol "Derived2" (extends "Derived")
    (property "Value" "Derived2" (at 0 0 0) (effects (font (size 1.27 1.27)))))
  (symbol "TwinPad" (in_bom yes) (on_board yes)
    (property "Reference" "Q" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "TwinPad" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "TwinPad_1_1"
      (pin passive line (at -5.08 2.54 0) (length 2.54) (name "S" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at -5.08 -2.54 0) (length 2.54) (name "S" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 5.08 0 180) (length 2.54) (name "D" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
)"#;

#[test]
fn inv_18_extends_flattened_multi_unit_body_style_1_and_duplicate_pins_kept() {
    let syms = sch_read::parse_symbol_lib(LIB, "T", Path::new("t.kicad_sym")).unwrap();
    let get = |n: &str| syms.iter().find(|s| s.id == format!("T:{n}")).unwrap();
    // (extends) chains are flattened: pins/unit count come from the parent, properties override
    let d = get("Derived");
    assert_eq!(d.unit_count, 3);
    assert_eq!(d.pins.len(), get("Base").pins.len());
    assert_eq!(d.property("Value"), Some("Derived"));
    assert_eq!(
        d.property("Footprint"),
        Some("Pkg:BASE"),
        "inherited property"
    );
    let d2 = get("Derived2");
    assert_eq!(d2.pins.len(), get("Base").pins.len(), "two-level extends");
    assert_eq!(
        d2.property("Datasheet"),
        Some("https://example.invalid/d.pdf")
    );
    // multi-unit: unit 2 sees its own pins + none of unit 1; body style 2 (De Morgan) is not
    // collected as extra pins of the instance
    let base = get("Base");
    let u1: Vec<&str> = base.pins_for_unit(1).map(|p| p.number.as_str()).collect();
    assert_eq!(
        u1,
        vec!["1", "2"],
        "unit 1 pins once (body style 1 only): {u1:?}"
    );
    let u2: Vec<&str> = base.pins_for_unit(2).map(|p| p.number.as_str()).collect();
    assert_eq!(u2, vec!["3", "4"]);
    // duplicate pin numbers (shared pads) are both kept; the writer disambiguates with #k seeds
    let tp = get("TwinPad");
    assert_eq!(tp.pins.iter().filter(|p| p.number == "1").count(), 2);
}

/// reg: 0.3.0 — De Morgan `_<unit>_2` bodies were collected twice and collided on UUIDs.
#[test]
fn reg_demorgan_body_pins_not_double_collected() {
    let syms = sch_read::parse_symbol_lib(LIB, "T", Path::new("t.kicad_sym")).unwrap();
    let base = syms.iter().find(|s| s.id == "T:Base").unwrap();
    assert!(
        base.pins.iter().any(|p| p.convert == 2),
        "reader records the body style"
    );
    let n1 = base.pins_for_unit(1).filter(|p| p.number == "1").count();
    assert_eq!(
        n1, 1,
        "pin 1 of unit 1 must appear once on a placed instance"
    );
}

/// reg: 0.3.0 — `(extends)` symbols were written unflattened and KiCad's loader dropped their pins.
#[test]
fn reg_extends_symbol_resolves_to_pins_in_real_library() {
    let Some(dir) = kicad_symbols_dir() else {
        eprintln!("KiCad not installed: skipping real-library check (FLUXSMITH_CONFORMANCE=required makes this fatal)");
        assert!(
            std::env::var("FLUXSMITH_CONFORMANCE")
                .map(|v| v != "required")
                .unwrap_or(true),
            "KiCad symbol library required"
        );
        return;
    };
    let p = dir.join("Device.kicad_sym");
    let src = std::fs::read_to_string(&p).unwrap();
    let syms = sch_read::parse_symbol_lib(&src, "Device", &p).unwrap();
    let derived: Vec<&sch_model::LibSymbol> = syms.iter().filter(|s| s.extends.is_some()).collect();
    assert!(!derived.is_empty());
    for s in derived {
        assert!(!s.pins.is_empty(), "{} lost its pins", s.id);
    }
}

/// reg: 0.18.0 — `${KICAD*_SYMBOL_DIR}` is compiled into KiCad, not exported; discovery must
/// synthesise it so a standard install resolves `Device:R` without a project table.
#[test]
fn reg_kicad_symbol_dir_is_synthesised_by_discovery() {
    let (env, table) = sch_read::discover_kicad(None);
    let Some(t) = table else {
        eprintln!("KiCad not installed: skipping");
        assert!(
            std::env::var("FLUXSMITH_CONFORMANCE")
                .map(|v| v != "required")
                .unwrap_or(true),
            "KiCad required"
        );
        return;
    };
    let dir =
        kicad_symbols_dir().expect("KICAD<major>_SYMBOL_DIR present without any exported env var");
    assert!(dir.join("Device.kicad_sym").exists(), "{}", dir.display());
    let rows = sch_read::parse_lib_table(&t, &env, 0).unwrap();
    let dev = rows
        .iter()
        .find(|r| r.nickname == "Device")
        .expect("global table lists Device");
    assert!(!dev.uri.contains("${"), "env vars expanded: {}", dev.uri);
    let mut lib = sch_read::SymbolLibrary::new(rows);
    assert!(lib.resolve("Device:R").is_some());
}

/// reg: 0.18.0 — `add_sheet` to a missing child file used to succeed and then nothing could
/// read the root. The reader reports a structured `SheetFileMissing`.
#[test]
fn reg_missing_child_sheet_is_a_structured_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("hier_root.kicad_sch");
    std::fs::copy(fixtures().join("hier/hier_root.kicad_sch"), &root).unwrap();
    // child deliberately not copied
    match sch_read::read_project(&root) {
        Err(sch_read::ReadError::SheetFileMissing { file, .. }) => {
            assert_eq!(file, "hier_child.kicad_sch")
        }
        other => panic!("expected SheetFileMissing, got {other:?}"),
    }
}

/// Deterministic ugly inputs for the reader: every S-expression the parser accepts must
/// come back as `Ok(sheet)` or a `ReadError`, never a panic (L7 companion).
#[test]
fn ugly_inputs_never_panic() {
    let cases = [
        "(kicad_sch)",
        "(kicad_sch (version 20260306))",
        "(kicad_sch (version 1))",
        "(kicad_sch (version 20260306) (symbol))",
        "(kicad_sch (version 20260306) (symbol (lib_id) (at)))",
        "(kicad_sch (version 20260306) (symbol (lib_id \"Device:R\") (at 1 2 3) (property \"Reference\") (pin)))",
        "(kicad_sch (version 20260306) (wire (pts (xy 1) (xy 2 3 4))))",
        "(kicad_sch (version 20260306) (wire (pts)))",
        "(kicad_sch (version 20260306) (label) (global_label \"\") (hierarchical_label \"x\" (at)))",
        "(kicad_sch (version 20260306) (sheet (property \"Sheetfile\" \"\") (pin)))",
        "(kicad_sch (version 20260306) (sheet (property \"Sheetfile\" \"hier_root.kicad_sch\")))",
        "(kicad_sch (version 20260306) (junction) (no_connect) (bus_entry (at 1 1)))",
        "(kicad_sch (version 20260306) (lib_symbols (symbol) (symbol \"A\" (symbol \"A_x_y\" (pin)))))",
        "(kicad_sch (version 20260306) (symbol (lib_id \"Device:R\") (at 1e308 -1e308 99999999999) (unit -1)))",
        "(kicad_sch (version 20260306) (symbol (lib_id \"Device:R\") (at nan inf 0)))",
        "(kicad_sch (version 20260306) (uuid) (paper) (title_block (title)))",
        "(kicad_pcb (version 20260306))",
        "(kicad_symbol_lib)",
        "(kicad_symbol_lib (symbol \"X\" (extends \"X\")))",
        "(kicad_symbol_lib (symbol \"A\" (extends \"B\")) (symbol \"B\" (extends \"A\")))",
    ];
    for c in cases {
        let doc = kicad_sexpr::parse(c).unwrap();
        let _ = sch_read::sheet_from_document(&doc, Path::new("ugly.kicad_sch"));
        let _ = sch_read::parse_symbol_lib(c, "ugly", Path::new("ugly.kicad_sym"));
    }
    // self-referencing sheet: recursion must be reported, not looped
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("loop.kicad_sch");
    std::fs::write(&f, "(kicad_sch (version 20260306) (generator \"t\") (uuid \"aaaaaaaa-aaaa-4aaa-8aaa-000000000099\") (paper \"A4\") (lib_symbols)\n (sheet (at 10 10) (size 10 10) (uuid \"aaaaaaaa-aaaa-4aaa-8aaa-000000000098\") (property \"Sheetname\" \"me\") (property \"Sheetfile\" \"loop.kicad_sch\") (instances (project \"t\" (path \"/aaaaaaaa-aaaa-4aaa-8aaa-000000000099\" (page \"2\")))))\n (sheet_instances (path \"/\" (page \"1\"))))\n").unwrap();
    match sch_read::read_project(&f) {
        Err(sch_read::ReadError::SheetRecursion { .. }) | Err(_) => {}
        Ok(t) => assert!(t.instances.len() < 64, "recursion not bounded"),
    }
}
