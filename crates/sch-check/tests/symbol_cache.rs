// SPDX-License-Identifier: Apache-2.0
//! `SYMBOL_CACHE_MISMATCH` = eeschema's `ERCE_LIB_SYMBOL_MISMATCH`, which compares the flattened
//! library symbol with the copy cached in the schematic (`Compare(..., EQUALITY | ERC)`) — not
//! just the pin count. A renamed pin, a changed electrical type and a moved pin each have to be
//! reported, and named in the message.

use std::path::{Path, PathBuf};

const ROOT: &str = "0e7b7e4e-1b3c-4c2e-9a10-0000000000f4";

/// `(pin ...)` line for both the schematic cache and the library file.
fn pin(kind: &str, name: &str, number: &str, y: f64) -> String {
    format!(
        "\t\t\t(pin {kind} line (at 0 {y} 0) (length 2.54) (name \"{name}\" (effects (font (size 1.27 1.27)))) (number \"{number}\" (effects (font (size 1.27 1.27)))))\n"
    )
}

/// `id` is the symbol id as written (`Lib:R` in a schematic cache, `R` in a library file); the
/// nested body symbol is always named after the bare symbol name, as KiCad writes it.
fn symbol(id: &str, name: &str, pins: &str) -> String {
    format!(
        r#"	(symbol "{id}"
		(pin_numbers (hide yes))
		(pin_names (offset 0))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
		(property "Value" "{name}" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
		(symbol "{name}_1_1"
			(rectangle (start -7.62 -2.54) (end -2.54 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
{pins}		)
		(embedded_fonts no)
	)
"#
    )
}

/// A project whose `lib_symbols` cache holds `cached_pins`, next to a `Lib.kicad_sym` holding
/// `library_pins`. Returns the schematic path and the symbol library reading that file.
fn fixture(
    dir: &Path,
    cached_pins: &str,
    library_pins: &str,
) -> (PathBuf, sch_read::SymbolLibrary) {
    let sch = dir.join("t.kicad_sch");
    std::fs::write(
        &sch,
        format!(
            "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT}\")\n\t(paper \"A4\")\n\t(lib_symbols\n{}\t)\n\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n",
            symbol("Lib:R", "R", cached_pins)
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("t.kicad_pro"),
        "{\"meta\": {\"filename\": \"t.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    let lib_path = dir.join("Lib.kicad_sym");
    std::fs::write(
        &lib_path,
        format!(
            "(kicad_symbol_lib\n\t(version 20260306)\n\t(generator \"kicad_symbol_editor\")\n{})\n",
            symbol("R", "R", library_pins)
        ),
    )
    .unwrap();
    let rows = vec![sch_read::LibTableRow {
        nickname: "Lib".into(),
        kind: "KiCad".into(),
        uri: lib_path.to_string_lossy().into_owned(),
        descr: String::new(),
    }];
    (sch, sch_read::SymbolLibrary::new(rows))
}

fn mismatch(cached: &str, library: &str) -> Option<sch_write::gates::Finding> {
    let dir = tempfile::tempdir().unwrap();
    let (sch, mut lib) = fixture(dir.path(), cached, library);
    let tree = sch_read::read_project(&sch).unwrap();
    let out = sch_check::project(&tree, &mut lib);
    assert!(
        out.iter().all(|f| f.code != "SYMBOL_NOT_IN_TABLE"),
        "the fixture library must resolve: {out:?}"
    );
    out.into_iter().find(|f| f.code == "SYMBOL_CACHE_MISMATCH")
}

fn two_pins() -> String {
    pin("passive", "A", "1", 2.54) + &pin("passive", "B", "2", -2.54)
}

#[test]
fn an_identical_cache_is_clean() {
    assert!(mismatch(&two_pins(), &two_pins()).is_none());
}

#[test]
fn a_renamed_pin_is_reported_by_name() {
    let library = pin("passive", "VCC", "1", 2.54) + &pin("passive", "B", "2", -2.54);
    let f = mismatch(&two_pins(), &library).expect("renamed pin reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert_eq!(f.location, "cache:Lib:R");
    assert!(f.message.contains("pin 1 name A vs VCC"), "{}", f.message);
}

#[test]
fn a_changed_electrical_type_is_reported() {
    let library = pin("power_in", "A", "1", 2.54) + &pin("passive", "B", "2", -2.54);
    let f = mismatch(&two_pins(), &library).expect("retyped pin reported");
    assert!(
        f.message.contains("pin 1 type passive vs power_in"),
        "{}",
        f.message
    );
}

#[test]
fn a_moved_pin_is_reported() {
    let library = pin("passive", "A", "1", 5.08) + &pin("passive", "B", "2", -2.54);
    let f = mismatch(&two_pins(), &library).expect("moved pin reported");
    assert!(f.message.contains("pin 1 at "), "{}", f.message);
    assert!(f.message.contains(" mil vs "), "{}", f.message);
}

#[test]
fn added_and_removed_pins_are_named_on_both_sides() {
    let library = two_pins() + &pin("passive", "C", "3", 0.0);
    let f = mismatch(&two_pins(), &library).expect("extra library pin reported");
    assert!(
        f.message
            .contains("pin 3 is in the library but not in the cache"),
        "{}",
        f.message
    );
    let f = mismatch(&library, &two_pins()).expect("extra cached pin reported");
    assert!(
        f.message.contains("pin 3 is not in the library"),
        "{}",
        f.message
    );
}

#[test]
fn the_listed_differences_are_bounded() {
    let many = |name: &str| {
        (1..=12)
            .map(|i| {
                pin(
                    "passive",
                    &format!("{name}{i}"),
                    &i.to_string(),
                    i as f64 * 2.54,
                )
            })
            .collect::<String>()
    };
    let f = mismatch(&many("A"), &many("B")).expect("12 renamed pins reported");
    assert!(f.message.contains("(+6 more)"), "{}", f.message);
}
