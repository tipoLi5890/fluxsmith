// SPDX-License-Identifier: Apache-2.0
//! A part converted from vendor CAD is a CLAIM (red line 10). The converter records that on the
//! written `.kicad_sym` as `fluxsmith_claim` / `fluxsmith_pin_pad_mismatch`; KiCad copies those
//! properties into the schematic's `lib_symbols` cache when the part is placed, which is where
//! these two checks read them. Without them the conversion warnings reached nobody.

use std::path::{Path, PathBuf};

const ROOT: &str = "0e7b7e4e-1b3c-4c2e-9a10-0000000000f7";

/// A cached library symbol carrying `extra_props` (the provenance markers under test).
fn lib_symbol(name: &str, extra_props: &str) -> String {
    format!(
        r#"	(symbol "Jlc:{name}"
		(pin_numbers (hide yes))
		(pin_names (offset 0))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
		(property "Value" "{name}" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "jlc:SOT-23-3" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
{extra_props}		(symbol "{name}_1_1"
			(rectangle (start -7.62 -2.54) (end -2.54 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
			(pin passive line (at 0 0 0) (length 2.54) (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
		)
		(embedded_fonts no)
	)
"#
    )
}

fn prop(name: &str, value: &str) -> String {
    format!("\t\t(property \"{name}\" \"{value}\" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n")
}

fn placed(lib: &str, refdes: &str, x: f64, n: u32) -> String {
    format!(
        r#"	(symbol
		(lib_id "Jlc:{lib}")
		(at {x} 50.8 0)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "0e7b7e4e-1b3c-4c2e-9a10-0000000007{n:02}")
		(property "Reference" "{refdes}" (at {x} 44.45 0) (effects (font (size 1.27 1.27))))
		(property "Value" "{lib}" (at {x} 57.15 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "jlc:SOT-23-3" (at {x} 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(pin "1" (uuid "0e7b7e4e-1b3c-4c2e-9a10-0000000008{n:02}"))
		(instances
			(project "t"
				(path "/{ROOT}"
					(reference "{refdes}")
					(unit 1)
				)
			)
		)
	)
"#
    )
}

fn project(dir: &Path, libs: &str, body: &str) -> PathBuf {
    let sch = dir.join("t.kicad_sch");
    std::fs::write(
        &sch,
        format!(
            "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT}\")\n\t(paper \"A4\")\n\t(lib_symbols\n{libs}\t)\n{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n"
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("t.kicad_pro"),
        "{\"meta\": {\"filename\": \"t.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    sch
}

/// The project family (`check.run project`) and the delivery family, on one fixture.
fn findings(
    extra_props: &str,
    placed_refs: &[&str],
) -> (
    Vec<sch_write::gates::Finding>,
    Vec<sch_write::gates::Finding>,
) {
    let dir = tempfile::tempdir().unwrap();
    let body: String = placed_refs
        .iter()
        .enumerate()
        .map(|(i, r)| placed("AMS1117-3.3", r, 50.8 + 25.4 * i as f64, i as u32 + 1))
        .collect();
    let sch = project(dir.path(), &lib_symbol("AMS1117-3.3", extra_props), &body);
    let tree = sch_read::read_project(&sch).unwrap();
    let nets = sch_net::build_nets(&tree);
    let mut lib = sch_read::SymbolLibrary::new(vec![]);
    (
        sch_check::project(&tree, &mut lib),
        sch_write::gates::delivery(&tree, &nets),
    )
}

#[test]
fn a_recorded_pin_pad_mismatch_is_a_warning_naming_the_parts() {
    let props = prop("fluxsmith_claim", "unverified")
        + &prop("fluxsmith_source", "easyeda:C6186")
        + &prop(
            "fluxsmith_pin_pad_mismatch",
            "symbol pins 4 have no footprint pad",
        );
    let (project, _) = findings(&props, &["U1", "U2"]);
    let f = project
        .iter()
        .find(|f| f.code == "PIN_PAD_MISMATCH")
        .expect("PIN_PAD_MISMATCH reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert_eq!(f.location, "pinpad:Jlc:AMS1117-3.3");
    assert_eq!(f.refs, vec!["U1".to_string(), "U2".to_string()]);
    assert!(
        f.message.contains("symbol pins 4 have no footprint pad"),
        "{}",
        f.message
    );
    assert_eq!(f.file.as_deref(), Some("t.kicad_sch"));
    // One finding per library symbol, not one per placed part.
    assert_eq!(
        project
            .iter()
            .filter(|f| f.code == "PIN_PAD_MISMATCH")
            .count(),
        1
    );
}

#[test]
fn an_unverified_claim_is_a_delivery_warning_that_does_not_block() {
    let (_, delivery) = findings(&prop("fluxsmith_claim", "unverified"), &["U1"]);
    let f = delivery
        .iter()
        .find(|f| f.code == "PART_UNVERIFIED")
        .expect("PART_UNVERIFIED reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert_eq!(f.location, "claim:Jlc:AMS1117-3.3");
    assert_eq!(f.refs, vec!["U1".to_string()]);
    assert!(
        delivery
            .iter()
            .all(|f| f.severity != sch_write::gates::Severity::Error),
        "delivery must not fail on an unverified claim: {delivery:?}"
    );
}

#[test]
fn a_symbol_without_the_markers_reports_nothing() {
    let (project, delivery) = findings("", &["U1"]);
    assert!(project.iter().all(|f| f.code != "PIN_PAD_MISMATCH"));
    assert!(delivery.iter().all(|f| f.code != "PART_UNVERIFIED"));
    // A verified part keeps its provenance but loses the claim.
    let (_, delivery) = findings(&prop("fluxsmith_claim", "verified"), &["U1"]);
    assert!(delivery.iter().all(|f| f.code != "PART_UNVERIFIED"));
}
