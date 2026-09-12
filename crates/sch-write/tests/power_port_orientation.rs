// SPDX-License-Identifier: Apache-2.0
//! `POWER_PORT_ORIENTATION` names its own repair: `evidence.rotation` is the file rotation that
//! stands the port upright (rails up, GND-class down), derived from the port's own pin direction
//! through the engine's one transform, and the remediation text spells the same number so a repair
//! that only reads the text gets the same answer. A port drawn right raises nothing.

use std::path::{Path, PathBuf};

use sch_model::Mirror;
use sch_write::gates::{style, upright_port_rotation, Finding};

const ROOT: &str = "0e7b7e4e-1b3c-4c2e-9a10-0000000000f4";

/// KiCad's stock `power:GND`: the pin at the origin points down (270) into a body drawn below it.
const GND_LIB: &str = r##"	(symbol "power:GND"
		(power)
		(pin_numbers (hide yes))
		(pin_names (offset 0) (hide yes))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "#PWR" (at 0 -6.35 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(symbol "GND_0_1"
			(polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27) (xy 0 -1.27)) (stroke (width 0) (type default)) (fill (type none)))
		)
		(symbol "GND_1_1"
			(pin power_in line (at 0 0 270) (length 0) (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
		)
		(embedded_fonts no)
	)
"##;

/// KiCad's stock `power:+3V3`: the pin at the origin points up (90) into a body drawn above it.
const RAIL_LIB: &str = r##"	(symbol "power:+3V3"
		(power)
		(pin_numbers (hide yes))
		(pin_names (offset 0) (hide yes))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Value" "+3V3" (at 0 3.556 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(symbol "+3V3_0_1"
			(polyline (pts (xy -0.762 1.27) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))
			(polyline (pts (xy 0 0) (xy 0 2.54)) (stroke (width 0) (type default)) (fill (type none)))
			(polyline (pts (xy 0 2.54) (xy 0.762 1.27)) (stroke (width 0) (type default)) (fill (type none)))
		)
		(symbol "+3V3_1_1"
			(pin power_in line (at 0 0 90) (length 0) (name "+3V3" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
		)
		(embedded_fonts no)
	)
"##;

fn uuid(n: u32) -> String {
    format!("0e7b7e4e-1b3c-4c2e-9a10-0000000001{n:02}")
}

/// A placed power port at (50.8, 50.8) mm with the given file rotation and optional `(mirror x|y)`.
fn port(n: u32, lib: &str, value: &str, refdes: &str, rot: i64, mirror: Option<&str>) -> String {
    let uuid = uuid(n);
    let mirror = mirror
        .map(|m| format!("\t\t(mirror {m})\n"))
        .unwrap_or_default();
    format!(
        r##"	(symbol
		(lib_id "power:{lib}")
		(at 50.8 50.8 {rot})
{mirror}		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "{uuid}")
		(property "Reference" "{refdes}" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Value" "{value}" (at 50.8 50.8 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(pin "1" (uuid "0e7b7e4e-1b3c-4c2e-9a10-0000000002{n:02}"))
		(instances
			(project "t"
				(path "/{ROOT}"
					(reference "{refdes}")
					(unit 1)
				)
			)
		)
	)
"##
    )
}

fn project(dir: &Path, body: &str) -> PathBuf {
    let sch = dir.join("t.kicad_sch");
    std::fs::write(&sch, format!(
        "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT}\")\n\t(paper \"A4\")\n\t(lib_symbols\n{GND_LIB}{RAIL_LIB}\t)\n{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n"
    )).unwrap();
    std::fs::write(
        dir.join("t.kicad_pro"),
        "{\"meta\": {\"filename\": \"t.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    sch
}

fn orientation_findings(body: &str) -> Vec<Finding> {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(dir.path(), body);
    let tree = sch_read::read_project(&sch).unwrap();
    let mut v: Vec<Finding> = style(&tree)
        .into_iter()
        .filter(|f| f.code == "POWER_PORT_ORIENTATION")
        .collect();
    v.sort_by(|a, b| a.location.cmp(&b.location));
    v
}

fn rotation_of(f: &Finding, key: &str) -> i64 {
    f.evidence
        .get(key)
        .and_then(|v| v.as_i64())
        .unwrap_or_else(|| panic!("{key} missing from evidence: {f:?}"))
}

#[test]
fn upright_ports_raise_nothing() {
    let body =
        port(1, "GND", "GND", "#PWR01", 0, None) + &port(2, "+3V3", "+3V3", "#PWR02", 0, None);
    assert!(orientation_findings(&body).is_empty());
}

#[test]
fn an_upside_down_gnd_names_rotation_0_in_evidence_and_text() {
    let fs = orientation_findings(&port(1, "GND", "GND", "#PWR01", 180, None));
    assert_eq!(fs.len(), 1, "{fs:?}");
    let f = &fs[0];
    assert_eq!(f.location, format!("style:power:{}", uuid(1)));
    assert_eq!(rotation_of(f, "rotation"), 0);
    assert_eq!(rotation_of(f, "current_rotation"), 180);
    let text = f.remediation.as_deref().unwrap();
    assert!(
        text.contains("set_component_transform {uuid, rotation=0}"),
        "{text}"
    );
    assert!(text.starts_with("GND ports point down"), "{text}");
    assert_eq!(f.message, "#PWR01 (GND) points up instead of down");
}

#[test]
fn an_upside_down_rail_names_rotation_0() {
    let fs = orientation_findings(&port(2, "+3V3", "+3V3", "#PWR02", 180, None));
    assert_eq!(fs.len(), 1, "{fs:?}");
    let f = &fs[0];
    assert_eq!(rotation_of(f, "rotation"), 0);
    assert_eq!(rotation_of(f, "current_rotation"), 180);
    let text = f.remediation.as_deref().unwrap();
    assert!(
        text.contains("set_component_transform {uuid, rotation=0}"),
        "{text}"
    );
    assert!(text.starts_with("power rails point up"), "{text}");
}

#[test]
fn a_mirrored_port_keeps_its_mirror_and_gets_the_rotation_that_stands_it_upright() {
    // `(mirror x)` negates y after the rotation, so a GND at rotation 0 hangs upside down and the
    // pose that rights it without touching the mirror is 180, not 0.
    let fs = orientation_findings(&port(1, "GND", "GND", "#PWR01", 0, Some("x")));
    assert_eq!(fs.len(), 1, "{fs:?}");
    assert_eq!(rotation_of(&fs[0], "rotation"), 180);
    assert_eq!(rotation_of(&fs[0], "current_rotation"), 0);
    assert!(fs[0]
        .remediation
        .as_deref()
        .unwrap()
        .contains("rotation=180"));
}

#[test]
fn upright_rotation_follows_the_pin_direction() {
    // Stock shapes: GND's pin points down (270) into its body, a rail's points up (90).
    assert_eq!(upright_port_rotation(270, Mirror::None, true), Some(0));
    assert_eq!(upright_port_rotation(90, Mirror::None, false), Some(0));
    // The same symbol asked to stand the other way round is a half turn.
    assert_eq!(upright_port_rotation(270, Mirror::None, false), Some(180));
    assert_eq!(upright_port_rotation(90, Mirror::None, true), Some(180));
    // A mirror about X flips the vertical, so the upright pose is the half turn as well.
    assert_eq!(upright_port_rotation(270, Mirror::X, true), Some(180));
    // A mirror about Y leaves the vertical alone.
    assert_eq!(upright_port_rotation(270, Mirror::Y, true), Some(0));
    // A sideways-drawn pin (body to its right) is a quarter turn either way.
    assert_eq!(upright_port_rotation(0, Mirror::None, false), Some(90));
    assert_eq!(upright_port_rotation(0, Mirror::None, true), Some(270));
    // Off-axis pins have no upright pose to offer.
    assert_eq!(upright_port_rotation(45, Mirror::None, true), None);
}
