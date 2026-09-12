// SPDX-License-Identifier: Apache-2.0
//! The hierarchy scaffold rules, on hand-built parent/child pairs.
//!
//! A sheet symbol is the one object whose defects live in two files at once, and eeschema's own
//! ERC only reaches one of them: it reports an unwired sheet pin (`pin_not_connected`, an error),
//! which `PINMAP_UNCONNECTED` never saw because that walk only visits symbol pins. The other two
//! rules — a sheet symbol with no pins in front of a child that has a circuit, and a child file
//! with nothing drawn on it — are what a scaffold looks like when the block was never wired
//! through, and nothing in KiCad reports either.

use sch_write::gates::{Finding, Severity};
use std::path::{Path, PathBuf};

const ROOT_UUID: &str = "aaaaaaa1-0000-4000-8000-000000000001";
const CHILD_UUID: &str = "aaaaaaa1-0000-4000-8000-000000000002";
const SHEET_UUID: &str = "aaaaaaa1-0000-4000-8000-000000000003";

/// A minimal resistor, enough to make a child sheet "drawn on".
const LIB: &str = r##"	(lib_symbols
		(symbol "Device:R"
			(pin_numbers (hide yes))
			(pin_names (offset 0))
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
			(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
			(symbol "R_0_1"
				(rectangle (start -1.016 -2.54) (end 1.016 2.54)
					(stroke (width 0.254) (type default))
					(fill (type none))
				)
			)
			(symbol "R_1_1"
				(pin passive line (at 0 3.81 270) (length 1.27)
					(name "" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
				(pin passive line (at 0 -3.81 90) (length 1.27)
					(name "" (effects (font (size 1.27 1.27))))
					(number "2" (effects (font (size 1.27 1.27))))
				)
			)
		)
	)
"##;

fn sheet_pin(name: &str, y: f64, n: u32) -> String {
    format!(
        "\t\t(pin \"{name}\" input\n\t\t\t(at 63.5 {y} 180)\n\t\t\t(effects (font (size 1.27 1.27)) (justify right))\n\t\t\t(uuid \"aaaaaaa1-0000-4000-8000-00000000010{n}\")\n\t\t)\n"
    )
}

/// The `(sheet)` node in the parent, with `pins` already formatted.
fn sheet_node(pins: &str) -> String {
    format!(
        "\t(sheet\n\t\t(at 63.5 55.88)\n\t\t(size 12.7 10.16)\n\t\t(uuid \"{SHEET_UUID}\")\n\t\t(property \"Sheetname\" \"child\"\n\t\t\t(at 63.5 55.1684 0)\n\t\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n\t\t)\n\t\t(property \"Sheetfile\" \"child.kicad_sch\"\n\t\t\t(at 63.5 66.5 0)\n\t\t\t(effects (font (size 1.27 1.27)) (justify left top))\n\t\t)\n{pins}\t\t(instances\n\t\t\t(project \"t\"\n\t\t\t\t(path \"/{ROOT_UUID}\"\n\t\t\t\t\t(page \"2\")\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t)\n"
    )
}

fn hier_label(name: &str, y: f64, n: u32) -> String {
    format!(
        "\t(hierarchical_label \"{name}\"\n\t\t(shape input)\n\t\t(at 76.2 {y} 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left))\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-00000000020{n}\")\n\t)\n"
    )
}

fn resistor() -> String {
    format!(
        "\t(symbol\n\t\t(lib_id \"Device:R\")\n\t\t(at 100 100 0)\n\t\t(unit 1)\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-000000000301\")\n\t\t(property \"Reference\" \"R1\" (at 102.032 100 90) (effects (font (size 1.27 1.27))))\n\t\t(property \"Value\" \"1k\" (at 97.5 100 90) (effects (font (size 1.27 1.27))))\n\t\t(instances\n\t\t\t(project \"t\"\n\t\t\t\t(path \"/{ROOT_UUID}/{SHEET_UUID}\"\n\t\t\t\t\t(reference \"R1\")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t)\n"
    )
}

fn file(uuid: &str, body: &str) -> String {
    format!(
        "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{uuid}\")\n\t(paper \"A4\")\n{LIB}{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n)\n"
    )
}

/// Write a parent/child pair into `dir` and return the root path.
fn project(dir: &Path, parent_body: &str, child_body: &str) -> PathBuf {
    std::fs::write(
        dir.join("root.kicad_pro"),
        "{\"meta\": {\"filename\": \"root.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    std::fs::write(dir.join("child.kicad_sch"), file(CHILD_UUID, child_body)).unwrap();
    let root = dir.join("root.kicad_sch");
    std::fs::write(&root, file(ROOT_UUID, parent_body)).unwrap();
    root
}

fn erc_findings(root: &Path) -> Vec<Finding> {
    let tree = sch_read::read_project(root).unwrap();
    let nets = sch_net::nets_of(root).unwrap();
    sch_check::erc(&tree, &nets)
}

fn delivery_findings(root: &Path) -> Vec<Finding> {
    let tree = sch_read::read_project(root).unwrap();
    let nets = sch_net::nets_of(root).unwrap();
    sch_write::gates::delivery(&tree, &nets)
}

fn only<'a>(f: &'a [Finding], code: &str) -> Vec<&'a Finding> {
    f.iter().filter(|x| x.code == code).collect()
}

/// A sheet pin with nothing drawn on it, matched name for name by the child's hierarchical
/// labels so the two `*_UNMATCHED` errors stay quiet. eeschema calls this `pin_not_connected`
/// and files it as an error; so does the engine, or the two disagree about the same file.
#[test]
fn inv_sheet_pin_with_nothing_on_it_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let pins = format!(
        "{}{}",
        sheet_pin("VIN", 58.42, 1),
        sheet_pin("VOUT", 60.96, 2)
    );
    let child = format!(
        "{}{}{}",
        hier_label("VIN", 58.42, 1),
        hier_label("VOUT", 60.96, 2),
        resistor()
    );
    let root = project(dir.path(), &sheet_node(&pins), &child);
    let f = erc_findings(&root);
    let hits = only(&f, "SHEET_PIN_UNWIRED");
    assert_eq!(hits.len(), 2, "{f:?}");
    for h in &hits {
        assert_eq!(h.severity, Severity::Error);
        assert!(h.at_mil.is_some(), "{h:?}");
    }
    assert!(
        hits.iter().any(|h| h.message.contains("VIN"))
            && hits.iter().any(|h| h.message.contains("VOUT")),
        "{hits:?}"
    );
    assert!(only(&f, "SHEET_PIN_UNMATCHED").is_empty(), "{f:?}");
    assert!(only(&f, "HIER_LABEL_UNMATCHED").is_empty(), "{f:?}");
}

/// A wire ending on the pin is all it takes: the rule is what lands on the point, the same
/// question the integrity gate asks of a wire end.
#[test]
fn reg_a_wired_sheet_pin_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    let pins = format!(
        "{}{}",
        sheet_pin("VIN", 58.42, 1),
        sheet_pin("VOUT", 60.96, 2)
    );
    let parent = format!(
        "{}\t(wire\n\t\t(pts\n\t\t\t(xy 63.5 58.42)\n\t\t\t(xy 50.8 58.42)\n\t\t)\n\t\t(stroke (width 0) (type default))\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-000000000401\")\n\t)\n\t(label \"VOUT\"\n\t\t(at 63.5 60.96 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-000000000402\")\n\t)\n",
        sheet_node(&pins)
    );
    let child = format!(
        "{}{}{}",
        hier_label("VIN", 58.42, 1),
        hier_label("VOUT", 60.96, 2),
        resistor()
    );
    let root = project(dir.path(), &parent, &child);
    let f = erc_findings(&root);
    assert!(only(&f, "SHEET_PIN_UNWIRED").is_empty(), "{f:?}");
}

/// The scaffold: a sheet symbol with no pins at all in front of a child that has a circuit on
/// it. Nothing crosses the boundary, and neither `SHEET_PIN_UNMATCHED` nor `HIER_LABEL_UNMATCHED`
/// has anything to compare, so this is the only rule that sees it.
#[test]
fn inv_sheet_with_no_pins_over_a_drawn_child() {
    let dir = tempfile::tempdir().unwrap();
    let root = project(dir.path(), &sheet_node(""), &resistor());
    let f = delivery_findings(&root);
    let hits = only(&f, "SHEET_NO_PINS");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Warning);
    assert!(hits[0].message.contains("child.kicad_sch"), "{:?}", hits[0]);
    assert!(only(&f, "SHEET_CHILD_EMPTY").is_empty(), "{f:?}");

    // With pins on it the sheet carries something across, and the rule has nothing to say.
    let dir = tempfile::tempdir().unwrap();
    let pins = sheet_pin("VIN", 58.42, 1);
    let child = format!("{}{}", hier_label("VIN", 58.42, 1), resistor());
    let root = project(dir.path(), &sheet_node(&pins), &child);
    assert!(
        only(&delivery_findings(&root), "SHEET_NO_PINS").is_empty(),
        "a sheet with pins carries something"
    );
}

/// The other half of the scaffold: the child file exists and holds nothing. Reported instead of
/// `SHEET_NO_PINS`, because the missing drawing is the reason there is nothing to wire.
#[test]
fn inv_child_sheet_with_nothing_drawn_on_it() {
    let dir = tempfile::tempdir().unwrap();
    let root = project(dir.path(), &sheet_node(""), "");
    let f = delivery_findings(&root);
    let hits = only(&f, "SHEET_CHILD_EMPTY");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Warning);
    assert!(hits[0].refs.contains(&"child".to_string()), "{:?}", hits[0]);
    assert!(
        only(&f, "SHEET_NO_PINS").is_empty(),
        "one finding per empty scaffold, not two: {f:?}"
    );
}

/// A sheet that ships without a title. The harness fills the title block itself on a new project,
/// so one still empty at check time got that way afterwards, and the plot carries an empty title
/// block — a Warning a reader sees, not an Info that leaves the row folded away.
#[test]
fn reg_title_block_empty_is_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let root = project(dir.path(), &sheet_node(""), &resistor());
    let tree = sch_read::read_project(&root).unwrap();
    let mut lib = sch_read::SymbolLibrary::new(vec![]);
    let f = sch_check::project(&tree, &mut lib);
    let hits = only(&f, "TITLE_BLOCK_EMPTY");
    assert_eq!(hits.len(), 2, "root and child: {f:?}");
    for h in &hits {
        assert_eq!(h.severity, Severity::Warning, "{h:?}");
        assert!(
            h.remediation
                .as_deref()
                .unwrap()
                .contains("set_title_block"),
            "{h:?}"
        );
    }
}

/// A global label on the child, used by the rail tests below.
fn global_label(name: &str, y: f64, n: u32) -> String {
    format!(
        "\t(global_label \"{name}\"\n\t\t(shape input)\n\t\t(at 76.2 {y} 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left))\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-00000000030{n}\")\n\t)\n"
    )
}

/// A local label.
fn local_label(name: &str, y: f64, n: u32) -> String {
    format!(
        "\t(label \"{name}\"\n\t\t(at 76.2 {y} 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left))\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-00000000040{n}\")\n\t)\n"
    )
}

/// A GND port on the child: a power symbol, so its value is the rail it drives.
fn power_port() -> String {
    format!(
        "\t(symbol\n\t\t(lib_id \"power:GND\")\n\t\t(at 100 110 0)\n\t\t(unit 1)\n\t\t(uuid \"aaaaaaa1-0000-4000-8000-000000000501\")\n\t\t(property \"Reference\" \"#PWR01\" (at 100 113 0) (effects (font (size 1.27 1.27)) (hide yes)))\n\t\t(property \"Value\" \"GND\" (at 100 114 0) (effects (font (size 1.27 1.27))))\n\t\t(instances\n\t\t\t(project \"t\"\n\t\t\t\t(path \"/{ROOT_UUID}/{SHEET_UUID}\"\n\t\t\t\t\t(reference \"#PWR01\")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t)\n"
    )
}

/// reg (run 20): a plan whose blocks meet on the rails alone - a power sheet whose whole interface
/// is VBUS_5V in, +3V3 out and GND - needs no sheet pin, because a power port and a global label
/// merge across a sheet boundary on their own (red line 4). `SHEET_NO_PINS` called that an
/// unfinished scaffold on every run.
#[test]
fn reg_sheet_no_pins_is_quiet_when_only_rails_cross() {
    let dir = tempfile::tempdir().unwrap();
    let child = format!(
        "{}{}{}",
        global_label("VBUS_5V", 58.42, 1),
        power_port(),
        resistor()
    );
    let root = project(dir.path(), &sheet_node(""), &child);
    let f = delivery_findings(&root);
    assert!(
        only(&f, "SHEET_NO_PINS").is_empty(),
        "the rails cross by design: {f:?}"
    );
    assert!(only(&f, "SHEET_CHILD_EMPTY").is_empty(), "{f:?}");
}

/// The other side of the same rule. A hierarchical label asks for a sheet pin of that name, and a
/// local label the parent also carries reads as one net across the boundary and is not one; either
/// way the sheet symbol without pins is a scaffold, rails or no rails.
#[test]
fn reg_sheet_no_pins_still_fires_when_more_than_rails_cross() {
    // A local label that also appears on the parent.
    let dir = tempfile::tempdir().unwrap();
    let parent = format!("{}{}", sheet_node(""), local_label("SIG", 58.42, 1));
    let child = format!(
        "{}{}{}",
        global_label("VBUS_5V", 58.42, 1),
        local_label("SIG", 60.96, 2),
        resistor()
    );
    let root = project(dir.path(), &parent, &child);
    let f = delivery_findings(&root);
    assert_eq!(only(&f, "SHEET_NO_PINS").len(), 1, "{f:?}");

    // A hierarchical label with no pin to match it.
    let dir = tempfile::tempdir().unwrap();
    let child = format!(
        "{}{}{}",
        global_label("VBUS_5V", 58.42, 1),
        hier_label("VOUT", 60.96, 2),
        resistor()
    );
    let root = project(dir.path(), &sheet_node(""), &child);
    let f = delivery_findings(&root);
    assert_eq!(only(&f, "SHEET_NO_PINS").len(), 1, "{f:?}");
}

/// reg (run 20): a `power:PWR_FLAG` that was placed under a part designator (`PWR1`) was asked for
/// a footprint. A port has none to give whatever it is called, so the delivery check reads what the
/// symbol is, not only how it is named.
#[test]
fn reg_a_power_symbol_under_a_part_designator_is_not_asked_for_a_footprint() {
    let dir = tempfile::tempdir().unwrap();
    let flag = power_port()
        .replace("power:GND", "power:PWR_FLAG")
        .replace("#PWR01", "PWR1")
        .replace("\"GND\"", "\"PWR_FLAG\"");
    let child = format!("{}{}", flag, resistor());
    let root = project(dir.path(), &sheet_node(""), &child);
    let f = delivery_findings(&root);
    let missing = only(&f, "FOOTPRINT_MISSING");
    assert!(
        missing
            .iter()
            .all(|m| !m.refs.contains(&"PWR1".to_string())),
        "{missing:?}"
    );
    assert!(
        missing.iter().any(|m| m.refs.contains(&"R1".to_string())),
        "a part with no footprint is still reported: {missing:?}"
    );
}
