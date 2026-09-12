// SPDX-License-Identifier: Apache-2.0
//! Layout-gate text rules on *hand-built* sheets.
//!
//! KiCad's ERC has no geometric text check, so `gates::overlap` is the only place a text
//! collision can be reported at all. These fixtures are written by hand — never by the
//! writer's own field autoplace — so the detectors are proven independent of whatever the
//! placement code does today: the sheet states exactly the geometry under test.
//!
//! `Device:R`'s stock library anchors put Value at the symbol origin (`(at 0 0 90)`), i.e.
//! in the middle of the body; that is the `FIELD_OVER_OWN_BODY` case, verbatim from
//! `Device.kicad_sym`.

use sch_write::gates::{Finding, Severity};
use std::path::{Path, PathBuf};

const ROOT_UUID: &str = "11111111-2222-3333-4444-555555555555";

/// Library bodies used by the fixtures, verbatim from KiCad 10's stock `Device` / `power`
/// libraries (trimmed to the nodes a bounding box is built from).
const LIB_SYMBOLS: &str = r##"	(lib_symbols
		(symbol "Connector_Generic:Conn_01x04"
			(pin_names (offset 1.016) (hide yes))
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(property "Reference" "J" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
			(property "Value" "Conn_01x04" (at 0 -7.62 0) (effects (font (size 1.27 1.27))))
			(symbol "Conn_01x04_1_1"
				(rectangle (start -1.27 -5.08) (end 1.27 5.08)
					(stroke (width 0.254) (type default))
					(fill (type none))
				)
				(pin passive line (at -5.08 3.81 0) (length 3.81)
					(name "Pin_1" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
				(pin passive line (at -5.08 1.27 0) (length 3.81)
					(name "Pin_2" (effects (font (size 1.27 1.27))))
					(number "2" (effects (font (size 1.27 1.27))))
				)
				(pin passive line (at -5.08 -1.27 0) (length 3.81)
					(name "Pin_3" (effects (font (size 1.27 1.27))))
					(number "3" (effects (font (size 1.27 1.27))))
				)
				(pin passive line (at -5.08 -3.81 0) (length 3.81)
					(name "Pin_4" (effects (font (size 1.27 1.27))))
					(number "4" (effects (font (size 1.27 1.27))))
				)
			)
		)
		(symbol "Test:R3"
			(pin_numbers (hide yes))
			(pin_names (offset 0))
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(property "Reference" "RN" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
			(property "Value" "R3" (at 4.5 0 90) (effects (font (size 1.27 1.27))))
			(symbol "R3_1_1"
				(rectangle (start -1.016 -2.54) (end 1.016 2.54)
					(stroke (width 0.254) (type default))
					(fill (type none))
				)
				(pin passive line (at 0 3.81 270) (length 1.27)
					(name "" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
				(pin passive line (at 0 -3.81 90) (length 1.27)
					(name "" (effects (font (size 1.27 1.27))))
					(number "2" (effects (font (size 1.27 1.27))))
				)
				(pin passive line (at 0 0 90) (length 0)
					(name "" (effects (font (size 1.27 1.27))))
					(number "3" (effects (font (size 1.27 1.27))))
				)
			)
		)
		(symbol "Device:R"
			(pin_numbers (hide yes))
			(pin_names (offset 0))
			(exclude_from_sim no)
			(in_bom yes)
			(on_board yes)
			(property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
			(property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
			(property "Footprint" "" (at -1.778 0 90) (effects (font (size 1.27 1.27)) (hide yes)))
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
		(symbol "power:+3V3"
			(power global)
			(pin_numbers (hide yes))
			(pin_names (offset 0) (hide yes))
			(property "Reference" "#PWR" (at 0 -3.81 0) (effects (font (size 1.27 1.27)) (hide yes)))
			(property "Value" "+3V3" (at 0 3.556 0) (effects (font (size 1.27 1.27))))
			(symbol "+3V3_0_1"
				(polyline
					(pts (xy -0.762 1.27) (xy 0 2.54) (xy 0.762 1.27))
					(stroke (width 0) (type default))
					(fill (type none))
				)
				(polyline
					(pts (xy 0 0) (xy 0 2.54))
					(stroke (width 0) (type default))
					(fill (type none))
				)
			)
			(symbol "+3V3_1_1"
				(pin power_in line (at 0 0 90) (length 0)
					(name "~" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
			)
		)
		(symbol "power:PWR_FLAG"
			(power global)
			(pin_numbers (hide yes))
			(pin_names (offset 0) (hide yes))
			(property "Reference" "#FLG" (at 0 1.905 0) (effects (font (size 1.27 1.27)) (hide yes)))
			(property "Value" "PWR_FLAG" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
			(symbol "PWR_FLAG_0_0"
				(pin power_out line (at 0 0 90) (length 0)
					(name "" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
			)
			(symbol "PWR_FLAG_0_1"
				(polyline
					(pts (xy 0 0) (xy 0 1.27) (xy -1.016 1.905) (xy 0 2.54) (xy 1.016 1.905) (xy 0 1.27))
					(stroke (width 0) (type default))
					(fill (type none))
				)
			)
		)
	)
"##;

/// One placed symbol. `fields` are absolute `(at x y rot)` triples, so every fixture states
/// its own text geometry instead of inheriting the writer's autoplace.
fn symbol(lib_id: &str, reference: &str, at: (f64, f64, i64), fields: &str) -> String {
    format!(
        "\t(symbol\n\t\t(lib_id \"{lib_id}\")\n\t\t(at {} {} {})\n\t\t(unit 1)\n\t\t(uuid \"{}\")\n{fields}\n\t\t(instances\n\t\t\t(project \"t\"\n\t\t\t\t(path \"/{ROOT_UUID}\"\n\t\t\t\t\t(reference \"{reference}\")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t)\n",
        at.0,
        at.1,
        at.2,
        fake_uuid(reference),
    )
}

fn fake_uuid(seed: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        h as u32,
        (h >> 32) as u16,
        (h >> 48) as u16 & 0xfff,
        (h >> 20) as u16 & 0xfff,
        h & 0xffff_ffff_ffff
    )
}

fn field(name: &str, shown: &str, at: (f64, f64, i64)) -> String {
    format!(
        "\t\t(property \"{name}\" \"{shown}\"\n\t\t\t(at {} {} {})\n\t\t\t(effects (font (size 1.27 1.27)))\n\t\t)",
        at.0, at.1, at.2
    )
}

/// A hidden field: it carries the value (a power symbol's `#PWR01` reference) but has no box.
fn hidden(name: &str, shown: &str) -> String {
    format!(
        "\t\t(property \"{name}\" \"{shown}\"\n\t\t\t(at 0 0 0)\n\t\t\t(effects (font (size 1.27 1.27)) (hide yes))\n\t\t)",
    )
}

fn write_sheet(dir: &Path, body: &str) -> PathBuf {
    let src = format!(
        "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT_UUID}\")\n\t(paper \"A4\")\n{LIB_SYMBOLS}{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n)\n"
    );
    let p = dir.join("hand.kicad_sch");
    std::fs::write(&p, src).unwrap();
    p
}

fn findings(dir: &Path, body: &str) -> Vec<Finding> {
    let p = write_sheet(dir, body);
    let tree = sch_read::read_project(&p).unwrap();
    sch_write::gates::overlap(&tree)
}

fn codes<'a>(f: &'a [Finding], code: &str) -> Vec<&'a Finding> {
    f.iter().filter(|x| x.code == code).collect()
}

/// The whole layout family (frame, overlap, page use) on the same hand-built sheet.
fn layout_findings(dir: &Path, body: &str) -> Vec<Finding> {
    let p = write_sheet(dir, body);
    sch_write::gates::layout(&sch_read::read_project(&p).unwrap())
}

/// The style family (grid, long wires, power port orientation, rows).
fn style_findings(dir: &Path, body: &str) -> Vec<Finding> {
    let p = write_sheet(dir, body);
    sch_write::gates::style(&sch_read::read_project(&p).unwrap())
}

/// A part of the size and shape the row rule looks at, with its fields well clear of everything.
fn passive(lib_id: &str, reference: &str, at: (f64, f64)) -> String {
    symbol(
        lib_id,
        reference,
        (at.0, at.1, 0),
        &format!(
            "{}\n{}",
            field("Reference", reference, (at.0, at.1 - 12.0, 0)),
            field("Value", "1k", (at.0, at.1 - 14.0, 0)),
        ),
    )
}

/// The stock `Device:R` puts its Value anchor at the symbol origin, dead centre of the
/// 2.032 x 5.08 mm body rectangle. A part written with the library's own field anchors is
/// therefore a `FIELD_OVER_OWN_BODY` warning, while the Reference (2.032 mm to the side)
/// is clear. Nothing in KiCad reports this; the layout gate is the only detector.
#[test]
fn reg_field_over_own_body_from_library_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let body = symbol(
        "Device:R",
        "R1",
        (100.0, 100.0, 0),
        &format!(
            "{}\n{}",
            field("Reference", "R1", (102.032, 100.0, 90)),
            field("Value", "1k", (100.0, 100.0, 90)),
        ),
    );
    let f = findings(dir.path(), &body);
    let hits = codes(&f, "FIELD_OVER_OWN_BODY");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Warning);
    assert!(hits[0].message.contains("R1 value"), "{:?}", hits[0]);
    assert!(hits[0].refs.contains(&"R1".to_string()), "{:?}", hits[0]);
    // The Reference sits beside the body, so exactly one field is reported.
    assert!(
        !hits[0].message.contains("reference"),
        "the reference is clear: {:?}",
        hits[0]
    );
}

/// A field moved off its own body is not reported: the rule is geometry, not "the library
/// anchor was used".
#[test]
fn reg_field_clear_of_own_body_is_silent() {
    let dir = tempfile::tempdir().unwrap();
    let body = symbol(
        "Device:R",
        "R1",
        (100.0, 100.0, 0),
        &format!(
            "{}\n{}",
            field("Reference", "R1", (102.032, 100.0, 90)),
            field("Value", "1k", (97.5, 100.0, 90)),
        ),
    );
    let f = findings(dir.path(), &body);
    assert!(codes(&f, "FIELD_OVER_OWN_BODY").is_empty(), "{f:?}");
    assert!(codes(&f, "TEXT_OVERLAP").is_empty(), "{f:?}");
}

/// Two parts far enough apart that their bodies never touch can still collide through their
/// texts. `FIELD_OVER_FIELD` is the only rule that sees it.
#[test]
fn reg_field_over_field_between_two_parts() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!(
        "{}{}",
        symbol(
            "Device:R",
            "R2",
            (110.0, 100.0, 0),
            &format!(
                "{}\n{}",
                field("Reference", "R2", (112.032, 100.0, 90)),
                field("Value", "10k", (110.0, 96.0, 0)),
            ),
        ),
        symbol(
            "Device:R",
            "R3",
            (115.0, 100.0, 0),
            &format!(
                "{}\n{}",
                field("Reference", "R3", (117.032, 100.0, 90)),
                field("Value", "22k", (110.5, 96.0, 0)),
            ),
        ),
    );
    let f = findings(dir.path(), &body);
    let hits = codes(&f, "FIELD_OVER_FIELD");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Warning);
    assert!(
        hits[0].refs.contains(&"R2".to_string()) && hits[0].refs.contains(&"R3".to_string()),
        "{:?}",
        hits[0]
    );
    // The bodies themselves are clear: nothing else fires.
    assert!(codes(&f, "GROUP_OVERLAP").is_empty(), "{f:?}");
}

/// The `#PWR` exemption is narrowed to what KiCad's convention actually covers: a power
/// port's value may sit on the pin (and body) of the part it feeds, because the port is
/// drawn on that pin. It is not exempt from running into another text — a PWR_FLAG parked
/// beside a rail port with colliding values is `FIELD_OVER_FIELD` like any other pair.
#[test]
fn reg_power_port_value_exempt_only_on_what_it_feeds() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!(
        "{}{}{}{}",
        // R4 with its fields well clear of everything.
        symbol(
            "Device:R",
            "R4",
            (130.0, 105.0, 0),
            &format!(
                "{}\n{}",
                field("Reference", "R4", (133.5, 105.0, 90)),
                field("Value", "10k", (127.0, 105.0, 90)),
            ),
        ),
        // The rail port on R4 pin 1 (130, 101.19). Its value is parked on R4's body: that is
        // the part it feeds, so it must stay silent.
        symbol(
            "power:+3V3",
            "#PWR01",
            (130.0, 101.19, 0),
            &format!(
                "{}\n{}",
                hidden("Reference", "#PWR01"),
                field("Value", "+3V3", (130.0, 105.0, 0))
            ),
        ),
        // A PWR_FLAG and a second rail port whose values run into each other.
        symbol(
            "power:PWR_FLAG",
            "#FLG01",
            (135.0, 101.19, 0),
            &format!(
                "{}\n{}",
                hidden("Reference", "#FLG01"),
                field("Value", "PWR_FLAG", (131.0, 97.634, 0))
            ),
        ),
        symbol(
            "power:+3V3",
            "#PWR02",
            (140.0, 101.19, 0),
            &format!(
                "{}\n{}",
                hidden("Reference", "#PWR02"),
                field("Value", "+3V3", (134.0, 97.634, 0))
            ),
        ),
    );
    let f = findings(dir.path(), &body);
    // Exempt: the port's value over the body of the pin it drives.
    assert!(
        codes(&f, "TEXT_OVERLAP")
            .iter()
            .all(|x| !x.refs.contains(&"#PWR01".to_string())),
        "the port feeds R4: {f:?}"
    );
    // Not exempt: text on text.
    let pairs = codes(&f, "FIELD_OVER_FIELD");
    assert!(
        pairs
            .iter()
            .any(|x| x.refs.contains(&"#FLG01".to_string())
                && x.refs.contains(&"#PWR02".to_string())),
        "{f:?}"
    );
}

/// A local label whose text is written along the wire leaving its own anchor: eeschema
/// draws the net name on top of the line. The same label turned around is clean, so the
/// rule is direction-sensitive rather than "a label near a wire".
#[test]
fn reg_label_over_wire_follows_the_text_direction() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!(
        "{}{}{}{}",
        wire((150.0, 100.0), (155.0, 100.0), "w1"),
        label("SIG", (150.0, 100.0), 0, "l1"),
        wire((160.0, 100.0), (165.0, 100.0), "w2"),
        label("BACK", (160.0, 100.0), 180, "l2"),
    );
    let f = findings(dir.path(), &body);
    let hits = codes(&f, "LABEL_OVER_WIRE");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Warning);
    assert!(hits[0].message.contains("SIG"), "{:?}", hits[0]);
}

fn wire(a: (f64, f64), b: (f64, f64), seed: &str) -> String {
    format!(
        "\t(wire\n\t\t(pts\n\t\t\t(xy {} {})\n\t\t\t(xy {} {})\n\t\t)\n\t\t(stroke (width 0) (type default))\n\t\t(uuid \"{}\")\n\t)\n",
        a.0,
        a.1,
        b.0,
        b.1,
        fake_uuid(seed)
    )
}

fn label(text: &str, at: (f64, f64), rot: i64, seed: &str) -> String {
    format!(
        "\t(label \"{text}\"\n\t\t(at {} {} {rot})\n\t\t(effects (font (size 1.27 1.27)) (justify left bottom))\n\t\t(uuid \"{}\")\n\t)\n",
        at.0,
        at.1,
        fake_uuid(seed)
    )
}

/// A text written across a connector's pin *leads*. The neighbour's body rectangle is nowhere
/// near the text — everything the reader would lose is the four lines running out of the left
/// side — so this is exactly the case a graphics-only comparison cannot see. The same text moved
/// clear of the leads is silent, which proves the rule is the leads and not the bounding box that
/// contains them.
#[test]
fn reg_text_over_a_neighbours_pin_leads() {
    // J1 at (100, 100): body x 98.73..101.27, four leads running left from x 94.92 to 98.73 at
    // y 96.19, 98.73, 101.27 and 103.81.
    let connector = symbol(
        "Connector_Generic:Conn_01x04",
        "J1",
        (100.0, 100.0, 0),
        &format!(
            "{}\n{}",
            field("Reference", "J1", (100.0, 92.0, 0)),
            field("Value", "Conn_01x04", (100.0, 90.0, 0)),
        ),
    );
    // A part parked far to the right whose value text was written over the connector's leads.
    let over = |x: f64| {
        symbol(
            "Device:R",
            "R9",
            (140.0, 100.0, 0),
            &format!(
                "{}\n{}",
                field("Reference", "R9", (140.0, 90.0, 0)),
                field("Value", "TALLVALUE", (x, 100.0, 90)),
            ),
        )
    };

    let dir = tempfile::tempdir().unwrap();
    let f = findings(dir.path(), &format!("{connector}{}", over(96.5)));
    let hits = codes(&f, "TEXT_OVERLAP");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Warning);
    assert!(hits[0].refs.contains(&"J1".to_string()), "{:?}", hits[0]);
    assert_eq!(
        hits[0].evidence.get("blocker").and_then(|v| v.as_str()),
        Some("J1"),
        "{:?}",
        hits[0]
    );
    assert!(
        matches!(
            hits[0].evidence.get("axis").and_then(|v| v.as_str()),
            Some("x") | Some("y")
        ),
        "{:?}",
        hits[0]
    );

    let dir = tempfile::tempdir().unwrap();
    let clear = findings(dir.path(), &format!("{connector}{}", over(93.0)));
    assert!(
        codes(&clear, "TEXT_OVERLAP").is_empty(),
        "past the pin tips, over nothing: {clear:?}"
    );
}

/// `LABEL_OVER_WIRE` in its second shape: a wire that crosses the label's text somewhere other
/// than at the label's own anchor. The mid-span label — a name written beside the line it sits
/// on, the ordinary way to name a net — is the negative, and it is the case a plain box-touches-
/// wire test gets wrong, because eeschema draws that text with its baseline on the line.
#[test]
fn reg_label_over_wire_sees_a_crossing_wire_but_not_a_mid_span_label() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!(
        "{}{}{}{}",
        // SIG's text runs right from (100, 100); a wire crosses it at x = 102.
        label("SIG", (100.0, 100.0), 0, "cross-l"),
        wire((102.0, 95.0), (102.0, 105.0), "cross-w"),
        // MID names the wire it sits on, drawn beside it: the drafting norm, not a finding.
        label("MID", (115.0, 100.0), 0, "mid-l"),
        wire((110.0, 100.0), (125.0, 100.0), "mid-w"),
    );
    let f = findings(dir.path(), &body);
    let hits = codes(&f, "LABEL_OVER_WIRE");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert!(hits[0].message.contains("SIG"), "{:?}", hits[0]);
    assert!(
        hits[0].message.contains("runs through"),
        "the crossing wording, not the along-the-anchor one: {:?}",
        hits[0]
    );
}

/// The same rule for a power port's Value, which is a net name on the sheet but not a `label`
/// object: nothing else in the family looks at it. The port's own pin is exempt (the wire it
/// drives always arrives there), so the wire that fires has to cross the text elsewhere.
#[test]
fn reg_power_port_value_over_a_crossing_wire() {
    let dir = tempfile::tempdir().unwrap();
    // The port's pin is at (100, 100) and its value sits 3.556 mm above, as the library puts it.
    let port = |wire_x: f64| {
        format!(
            "{}{}",
            symbol(
                "power:+3V3",
                "#PWR01",
                (100.0, 100.0, 0),
                &format!(
                    "{}\n{}",
                    hidden("Reference", "#PWR01"),
                    field("Value", "+3V3", (100.0, 96.444, 0))
                ),
            ),
            wire((wire_x, 94.0), (wire_x, 98.0), "pw"),
        )
    };
    let f = findings(dir.path(), &port(100.6));
    let hits = codes(&f, "LABEL_OVER_WIRE");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert!(hits[0].message.contains("value"), "{:?}", hits[0]);
    assert!(
        hits[0].refs.contains(&"#PWR01".to_string()),
        "{:?}",
        hits[0]
    );

    let dir = tempfile::tempdir().unwrap();
    let clear = findings(dir.path(), &port(110.0));
    assert!(codes(&clear, "LABEL_OVER_WIRE").is_empty(), "{clear:?}");
}

/// The row rule, with the three clauses that keep it off deliberate layout stated as their own
/// negatives: a part of another shape is not one of the row, a whole placement step is a decision
/// rather than a slip, and two parts with a third drawn between them are not neighbours.
#[test]
fn reg_row_misaligned_needs_one_shape_a_clear_gap_and_a_part_step() {
    // Three resistors in a row on 10 mm centres; R12 sits 0.762 mm (30 mil) low.
    let dir = tempfile::tempdir().unwrap();
    let staircase = format!(
        "{}{}{}",
        passive("Device:R", "R10", (100.0, 100.0)),
        passive("Device:R", "R11", (110.0, 100.0)),
        passive("Device:R", "R12", (120.0, 100.762)),
    );
    let f = style_findings(dir.path(), &staircase);
    let hits = codes(&f, "ROW_MISALIGNED");
    assert_eq!(hits.len(), 2, "the R11/R12 pair, once each: {hits:?}");
    let refs: Vec<&str> = hits
        .iter()
        .flat_map(|h| h.refs.iter().map(|r| r.as_str()))
        .collect();
    assert!(refs.contains(&"R11") && refs.contains(&"R12"), "{hits:?}");
    assert!(
        !refs.contains(&"R10"),
        "R11 is drawn between R10 and R12: {hits:?}"
    );
    // The repair evidence names one baseline for the pair, and only the part that is off it moves.
    let r12 = hits
        .iter()
        .find(|h| h.refs == vec!["R12".to_string()])
        .unwrap();
    assert_eq!(
        r12.evidence.get("target_y_mil").and_then(|v| v.as_f64()),
        Some(sch_model::nm_to_mil(sch_model::mm_to_nm(96.19))),
        "{r12:?}"
    );
    assert!(
        (r12.evidence
            .get("delta_mil")
            .and_then(|v| v.as_f64())
            .unwrap()
            + 30.0)
            .abs()
            < 0.01,
        "{r12:?}"
    );
    let r11 = hits
        .iter()
        .find(|h| h.refs == vec!["R11".to_string()])
        .unwrap();
    assert_eq!(
        r11.evidence.get("delta_mil").and_then(|v| v.as_f64()),
        Some(0.0),
        "R11 is the one on the grid: {r11:?}"
    );

    // A whole 100 mil step down is a row on two lines, not a staircase.
    let dir = tempfile::tempdir().unwrap();
    let stepped = format!(
        "{}{}",
        passive("Device:R", "R10", (100.0, 100.0)),
        passive("Device:R", "R11", (110.0, 102.54)),
    );
    assert!(
        codes(&style_findings(dir.path(), &stepped), "ROW_MISALIGNED").is_empty(),
        "a deliberate step"
    );

    // Another shape beside it is not out of line with it: different pin count, same offset.
    let dir = tempfile::tempdir().unwrap();
    let mixed = format!(
        "{}{}",
        passive("Device:R", "R10", (100.0, 100.0)),
        passive("Test:R3", "RN1", (110.0, 100.762)),
    );
    assert!(
        codes(&style_findings(dir.path(), &mixed), "ROW_MISALIGNED").is_empty(),
        "a three-pin part is not one of a row of two-pin ones"
    );

    // A part turned the other way up is not out of line with the row either.
    let dir = tempfile::tempdir().unwrap();
    let turned = format!(
        "{}{}",
        passive("Device:R", "R10", (100.0, 100.0)),
        symbol(
            "Device:R",
            "R11",
            (110.0, 100.762, 90),
            &format!(
                "{}\n{}",
                field("Reference", "R11", (110.0, 88.0, 0)),
                field("Value", "1k", (110.0, 86.0, 0)),
            ),
        ),
    );
    assert!(
        codes(&style_findings(dir.path(), &turned), "ROW_MISALIGNED").is_empty(),
        "a rotated part is drawn on another axis"
    );
}

/// `PAGE_UNDERUSED`: both halves have to hold. A small block parked in a corner of an A4 sheet is
/// reported; the same block in the middle of the page is a small drawing and nothing else.
#[test]
fn reg_page_underused_is_the_corner_not_the_size() {
    let dir = tempfile::tempdir().unwrap();
    let corner = layout_findings(dir.path(), &passive("Device:R", "R1", (30.0, 30.0)));
    let hits = codes(&corner, "PAGE_UNDERUSED");
    assert_eq!(hits.len(), 1, "{corner:?}");
    assert_eq!(hits[0].severity, Severity::Info);
    assert!(hits[0].message.contains("drawing border"), "{:?}", hits[0]);

    // The middle of A4's drawing border (x 500..11193, y 500..6768 mil).
    let dir = tempfile::tempdir().unwrap();
    let centred = layout_findings(dir.path(), &passive("Device:R", "R1", (148.5, 92.3)));
    assert!(
        codes(&centred, "PAGE_UNDERUSED").is_empty(),
        "a small drawing in the middle of the page is a drawing: {centred:?}"
    );
}

/// `LABEL_PAIR_SHOULD_BE_WIRE`: one name written twice within a short run of clear paper, where a
/// line is what a drafter would have drawn. A body between the two anchors is why the two names
/// exist, so that pair is left alone.
#[test]
fn reg_label_pair_should_be_wire_needs_a_clear_run() {
    let dir = tempfile::tempdir().unwrap();
    let pair = format!(
        "{}{}",
        label("SDA", (100.0, 100.0), 0, "pa"),
        label("SDA", (100.0, 108.0), 0, "pb"),
    );
    let f = findings(dir.path(), &pair);
    let hits = codes(&f, "LABEL_PAIR_SHOULD_BE_WIRE");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(hits[0].severity, Severity::Info);
    assert!(hits[0].message.contains("SDA"), "{:?}", hits[0]);

    let dir = tempfile::tempdir().unwrap();
    let blocked = format!("{pair}{}", passive("Device:R", "R1", (100.0, 104.0)));
    assert!(
        codes(&findings(dir.path(), &blocked), "LABEL_PAIR_SHOULD_BE_WIRE").is_empty(),
        "a body between them is why there are two names"
    );

    // Far apart is a hierarchy of blocks, not a wire a reader follows in one glance.
    let dir = tempfile::tempdir().unwrap();
    let far = format!(
        "{}{}",
        label("SDA", (100.0, 100.0), 0, "fa"),
        label("SDA", (100.0, 140.0), 0, "fb"),
    );
    assert!(
        codes(&findings(dir.path(), &far), "LABEL_PAIR_SHOULD_BE_WIRE").is_empty(),
        "beyond the 500 mil run"
    );
}

/// `FIELD_OVER_FIELD` carries the same repair evidence as `TEXT_OVERLAP`: which object is in the
/// way, and the axis with less to clear.
#[test]
fn reg_field_over_field_carries_repair_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let body = format!(
        "{}{}",
        symbol(
            "Device:R",
            "R2",
            (110.0, 100.0, 0),
            &format!(
                "{}\n{}",
                field("Reference", "R2", (112.032, 100.0, 90)),
                field("Value", "10k", (110.0, 96.0, 0)),
            ),
        ),
        symbol(
            "Device:R",
            "R3",
            (115.0, 100.0, 0),
            &format!(
                "{}\n{}",
                field("Reference", "R3", (117.032, 100.0, 90)),
                field("Value", "22k", (110.5, 96.0, 0)),
            ),
        ),
    );
    let f = findings(dir.path(), &body);
    let hits = codes(&f, "FIELD_OVER_FIELD");
    assert_eq!(hits.len(), 1, "{f:?}");
    assert_eq!(
        hits[0].evidence.get("blocker").and_then(|v| v.as_str()),
        Some("R3"),
        "{:?}",
        hits[0]
    );
    assert_eq!(
        hits[0].evidence.get("axis").and_then(|v| v.as_str()),
        Some("y"),
        "the two value texts sit on one line and overlap along most of it, so lifting one clear is the short way out: {:?}",
        hits[0]
    );
}
