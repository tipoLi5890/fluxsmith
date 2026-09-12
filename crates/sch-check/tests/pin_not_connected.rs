// SPDX-License-Identifier: Apache-2.0
//! eeschema's `pin_not_connected` (`ERCE_PIN_NOT_CONNECTED`, an error by default), modelled as
//! `PINMAP_UNCONNECTED`, on hand-written one-symbol fixtures. When KiCad is installed the same
//! fixtures also go through `kicad-cli sch erc`, so the oracle and the engine are compared on
//! identical input (docs/engine-conformance.md; the test is skipped when `kicad-cli` is absent,
//! unless `FLUXSMITH_CONFORMANCE=required`).

use std::path::{Path, PathBuf};
use std::process::Command;

const ROOT: &str = "0e7b7e4e-1b3c-4c2e-9a10-0000000000f2";

/// A library symbol with one pin of electrical type `kind` at the symbol origin, plus any
/// `extra` pin lines (used for stacked pins).
fn lib_symbol(name: &str, kind: &str, extra: &str) -> String {
    format!(
        r#"	(symbol "Test:{name}"
		(pin_numbers (hide yes))
		(pin_names (offset 0))
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
		(property "Value" "{name}" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(symbol "{name}_1_1"
			(rectangle (start -7.62 -2.54) (end -2.54 2.54) (stroke (width 0.254) (type default)) (fill (type none)))
			(pin {kind} line (at 0 0 0) (length 2.54) (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
{extra}		)
		(embedded_fonts no)
	)
"#
    )
}

/// A second pin at the very same point (`SCH_PIN::IsStacked` also wants the same name).
fn stacked_pin(kind: &str, name: &str) -> String {
    format!(
        "			(pin {kind} line (at 0 0 0) (length 2.54) (name \"{name}\" (effects (font (size 1.27 1.27)))) (number \"2\" (effects (font (size 1.27 1.27)))))\n"
    )
}

fn placed(lib: &str, refdes: &str, x: f64, n: u32, pins: &[&str]) -> String {
    let pin_rows: String = pins
        .iter()
        .enumerate()
        .map(|(i, p)| {
            format!("\t\t(pin \"{p}\" (uuid \"0e7b7e4e-1b3c-4c2e-9a10-0000000002{n:02}{i:02}\"))\n")
        })
        .collect();
    format!(
        r#"	(symbol
		(lib_id "Test:{lib}")
		(at {x} 50.8 0)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "0e7b7e4e-1b3c-4c2e-9a10-0000000001{n:02}")
		(property "Reference" "{refdes}" (at {x} 44.45 0) (effects (font (size 1.27 1.27))))
		(property "Value" "{lib}" (at {x} 57.15 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at {x} 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at {x} 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
{pin_rows}		(instances
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

fn sheet(libs: &str, body: &str) -> String {
    format!(
        "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT}\")\n\t(paper \"A4\")\n\t(lib_symbols\n{libs}\t)\n{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n"
    )
}

fn project(dir: &Path, libs: &str, body: &str) -> PathBuf {
    let sch = dir.join("t.kicad_sch");
    std::fs::write(&sch, sheet(libs, body)).unwrap();
    std::fs::write(
        dir.join("t.kicad_pro"),
        "{\"meta\": {\"filename\": \"t.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    sch
}

fn findings_of(sch: &Path) -> Vec<sch_write::gates::Finding> {
    let tree = sch_read::read_project(sch).unwrap();
    let nets = sch_net::build_nets(&tree);
    sch_check::pinmap_findings(&tree, &nets)
}

/// One isolated symbol of pin type `kind`, plus whatever `extra` puts on the sheet.
fn one_pin(kind: &str, extra: &str) -> (tempfile::TempDir, Vec<sch_write::gates::Finding>) {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("A", kind, ""),
        &(placed("A", "R1", 50.8, 1, &["1"]).to_string() + extra),
    );
    let fs = findings_of(&sch);
    (dir, fs)
}

const WIRE: &str = "\t(wire (pts (xy 50.8 50.8) (xy 63.5 50.8)) (stroke (width 0) (type default)) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000301\"))\n";
const NC: &str = "\t(no_connect (at 50.8 50.8) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000401\"))\n";
const LABEL: &str = "\t(label \"SIG\" (at 50.8 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000501\"))\n";

#[test]
fn an_unconnected_passive_pin_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("A", "passive", ""),
        &(placed("A", "R1", 50.8, 1, &["1"]) + &placed("A", "R2", 76.2, 2, &["1"])),
    );
    let fs = findings_of(&sch);
    assert_eq!(fs.len(), 2, "{fs:?}");
    for (f, r) in fs.iter().zip(["R1", "R2"]) {
        assert_eq!(f.code, "PINMAP_UNCONNECTED");
        assert_eq!(f.severity, sch_write::gates::Severity::Error);
        assert_eq!(f.location, format!("pin:{r}:1"));
        assert_eq!(f.refs, vec![format!("{r}.1")]);
        assert_eq!(
            f.at_mil,
            Some([if r == "R1" { 2000.0 } else { 3000.0 }, 2000.0])
        );
        assert_eq!(f.file.as_deref(), Some("t.kicad_sch"));
        assert!(f.remediation.as_deref().unwrap().contains("add_no_connect"));
    }
}

#[test]
fn unspecified_and_input_pins_are_reported_but_free_and_nc_types_are_not() {
    for kind in ["unspecified", "input", "bidirectional", "power_in"] {
        let (_d, fs) = one_pin(kind, "");
        assert_eq!(fs.len(), 1, "{kind}: {fs:?}");
    }
    // PT_NIC / PT_NC: the two types eeschema exempts.
    for kind in ["free", "no_connect"] {
        let (_d, fs) = one_pin(kind, "");
        assert!(fs.is_empty(), "{kind}: {fs:?}");
    }
}

#[test]
fn a_no_connect_marker_clears_it_and_a_bare_wire_stub_does_not() {
    let (_d, fs) = one_pin("passive", NC);
    assert!(fs.is_empty(), "{fs:?}");
    // A wire to nowhere is a second defect (`unconnected_wire_endpoint` in KiCad, the
    // `DANGLING_ENDPOINT` write gate here), not a connection.
    let (_d, fs) = one_pin("passive", WIRE);
    assert_eq!(fs.len(), 1, "{fs:?}");
}

#[test]
fn a_label_on_the_pin_clears_it() {
    let (_d, fs) = one_pin("passive", LABEL);
    assert!(fs.is_empty(), "{fs:?}");
}

#[test]
fn stacked_pins_count_as_one_pin_and_are_reported_once() {
    // Same symbol, same position, same name: eeschema's `SCH_PIN::IsStacked`. One finding.
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("K", "passive", &stacked_pin("passive", "P")),
        &placed("K", "U1", 50.8, 1, &["1", "2"]),
    );
    let fs = findings_of(&sch);
    assert_eq!(fs.len(), 1, "{fs:?}");
    assert_eq!(fs[0].refs, vec!["U1.1".to_string(), "U1.2".to_string()]);

    // Same position, different pin name: two pins that connect to each other, so KiCad reports
    // nothing.
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("M", "passive", &stacked_pin("passive", "Q")),
        &placed("M", "U1", 50.8, 1, &["1", "2"]),
    );
    assert!(findings_of(&sch).is_empty());
}

#[test]
fn pins_of_two_symbols_at_the_same_point_are_connected() {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("A", "passive", ""),
        &(placed("A", "R1", 50.8, 1, &["1"]) + &placed("A", "R2", 50.8, 2, &["1"])),
    );
    assert!(findings_of(&sch).is_empty());
}

/// reg: an unconnected `input` / `power_in` pin produced two findings for one pin -- the
/// `PINMAP_UNCONNECTED` error and the `ERC_INPUT_FLOATING` warning that restates it. `gate.run`
/// reports the error only.
#[test]
fn an_unconnected_input_pin_is_reported_once() {
    for kind in ["input", "power_in"] {
        let dir = tempfile::tempdir().unwrap();
        let sch = project(
            dir.path(),
            &lib_symbol("A", kind, ""),
            &placed("A", "U1", 50.8, 1, &["1"]),
        );
        let tree = sch_read::read_project(&sch).unwrap();
        let nets = sch_net::build_nets(&tree);
        let report = sch_check::gate_run(&tree, &nets, None, None);
        let on_pin: Vec<(String, String)> = report
            .families
            .iter()
            .flat_map(|f| f.findings.iter())
            .filter(|f| f.refs.iter().any(|r| r == "U1.1"))
            .map(|f| (f.code.clone(), f.location.clone()))
            .collect();
        let count = |code: &str| on_pin.iter().filter(|(c, _)| c == code).count();
        assert_eq!(count("PINMAP_UNCONNECTED"), 1, "{kind}: {on_pin:?}");
        assert_eq!(count("ERC_INPUT_FLOATING"), 0, "{kind}: {on_pin:?}");
        // An `input` pin has nothing else to say; a `power_in` one is also an undriven rail.
        if kind == "input" {
            assert_eq!(on_pin.len(), 1, "{on_pin:?}");
        }
        // The suppression is by pin: an `ERC_INPUT_FLOATING` whose pin the pinmap family does not
        // report survives.
        let erc = sch_check::erc(&tree, &nets);
        assert!(erc.iter().any(|f| f.code == "ERC_INPUT_FLOATING"), "{kind}");
        let kept = sch_check::drop_duplicate_pin_findings(erc.clone(), &[]);
        assert_eq!(kept.len(), erc.len(), "{kind}");
    }
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

fn kicad_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KICAD_CLI") {
        return Some(PathBuf::from(p));
    }
    for c in [
        "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
        "/usr/bin/kicad-cli",
    ] {
        if Path::new(c).exists() {
            return Some(PathBuf::from(c));
        }
    }
    let required = std::env::var("FLUXSMITH_CONFORMANCE")
        .map(|v| v == "required")
        .unwrap_or(false);
    assert!(
        !required,
        "FLUXSMITH_CONFORMANCE=required but kicad-cli was not found (set KICAD_CLI or install KiCad 10)"
    );
    eprintln!("kicad-cli not installed: oracle step skipped");
    None
}

/// Violation `type` strings KiCad reports on `sch`, one entry per violation.
fn oracle_types(cli: &Path, sch: &Path) -> Vec<String> {
    let out = sch.with_extension("erc.json");
    let st = Command::new(cli)
        .args(["sch", "erc", "--format", "json", "--severity-all", "-o"])
        .arg(&out)
        .arg(sch)
        .output()
        .expect("run kicad-cli");
    assert!(
        st.status.success(),
        "kicad-cli sch erc failed: {}",
        String::from_utf8_lossy(&st.stderr)
    );
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap())
        .expect("kicad-cli wrote JSON");
    v["sheets"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .flat_map(|s| {
            s["violations"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
        })
        .filter_map(|x| x["type"].as_str().map(str::to_string))
        .collect()
}

/// The engine and `kicad-cli sch erc` must agree, count included, on which fixtures raise
/// `pin_not_connected`.
#[test]
fn kicad_cli_agrees_on_pin_not_connected() {
    let Some(cli) = kicad_cli() else { return };
    // (name, lib_symbols, body, expected count)
    let two = lib_symbol("A", "passive", "");
    let stacked_same = lib_symbol("K", "passive", &stacked_pin("passive", "P"));
    let stacked_diff = lib_symbol("M", "passive", &stacked_pin("passive", "Q"));
    let cases: Vec<(&str, String, String, usize)> = vec![
        (
            "two isolated passives",
            two.clone(),
            placed("A", "R1", 50.8, 1, &["1"]) + &placed("A", "R2", 76.2, 2, &["1"]),
            2,
        ),
        (
            "wire stub",
            two.clone(),
            placed("A", "R1", 50.8, 1, &["1"]) + WIRE,
            1,
        ),
        (
            "no-connect marker",
            two.clone(),
            placed("A", "R1", 50.8, 1, &["1"]) + NC,
            0,
        ),
        (
            "label on the pin",
            two.clone(),
            placed("A", "R1", 50.8, 1, &["1"]) + LABEL,
            0,
        ),
        (
            "unspecified pin",
            lib_symbol("S", "unspecified", ""),
            placed("S", "U1", 50.8, 1, &["1"]),
            1,
        ),
        (
            "free pin",
            lib_symbol("F", "free", ""),
            placed("F", "U1", 50.8, 1, &["1"]),
            0,
        ),
        (
            "no_connect pin type",
            lib_symbol("N", "no_connect", ""),
            placed("N", "U1", 50.8, 1, &["1"]),
            0,
        ),
        (
            "stacked pins, same name",
            stacked_same,
            placed("K", "U1", 50.8, 1, &["1", "2"]),
            1,
        ),
        (
            "stacked pins, different names",
            stacked_diff,
            placed("M", "U1", 50.8, 1, &["1", "2"]),
            0,
        ),
        (
            "two symbols on one point",
            two,
            placed("A", "R1", 50.8, 1, &["1"]) + &placed("A", "R2", 50.8, 2, &["1"]),
            0,
        ),
    ];
    for (name, libs, body, want) in cases {
        let dir = tempfile::tempdir().unwrap();
        let sch = project(dir.path(), &libs, &body);
        let ours = findings_of(&sch).len();
        assert_eq!(ours, want, "engine on {name}");
        let theirs = oracle_types(&cli, &sch)
            .iter()
            .filter(|t| *t == "pin_not_connected")
            .count();
        assert_eq!(theirs, want, "kicad-cli on {name}");
    }
}
