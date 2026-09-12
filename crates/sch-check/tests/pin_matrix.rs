// SPDX-License-Identifier: Apache-2.0
//! eeschema's pin conflict matrix, `multiple_net_names` and the no-connect rules, on
//! hand-written one-net fixtures. When KiCad is installed the same fixtures also go through
//! `kicad-cli sch erc` so the oracle and the engine are compared on identical input
//! (docs/engine-conformance.md; the test is skipped when `kicad-cli` is absent, unless
//! `FLUXSMITH_CONFORMANCE=required`).

use std::path::{Path, PathBuf};
use std::process::Command;

const ROOT: &str = "0e7b7e4e-1b3c-4c2e-9a10-0000000000f1";

/// A one-pin library symbol of the given electrical type. `flip` puts the body on the right so
/// two of these face each other across a wire; the pin's connection point is the symbol origin.
fn lib_symbol(name: &str, kind: &str, flip: bool) -> String {
    let (angle, x0, x1) = if flip {
        (180, 2.54, 7.62)
    } else {
        (0, -7.62, -2.54)
    };
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
				(rectangle
					(start {x0} -2.54)
					(end {x1} 2.54)
					(stroke (width 0.254) (type default))
					(fill (type none))
				)
				(pin {kind} line
					(at 0 0 {angle})
					(length 2.54)
					(name "P" (effects (font (size 1.27 1.27))))
					(number "1" (effects (font (size 1.27 1.27))))
				)
			)
			(embedded_fonts no)
		)
"#
    )
}

fn placed(lib: &str, refdes: &str, x: f64, n: u32) -> String {
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
"#
    )
}

/// A one-sheet schematic: `U1` (pin type `a`) and `U2` (pin type `b`) facing each other across
/// a single wire, so both pins land on one net. `extra` is appended verbatim (labels, a
/// no-connect marker, ...).
fn sheet(a: &str, b: &str, extra: &str) -> String {
    format!(
        "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT}\")\n\t(paper \"A4\")\n\t(lib_symbols\n{}{}\t)\n\t(wire\n\t\t(pts (xy 50.8 50.8) (xy 76.2 50.8))\n\t\t(stroke (width 0) (type default))\n\t\t(uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000301\")\n\t)\n{}{}{}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n",
        lib_symbol("A", a, false),
        lib_symbol("B", b, true),
        placed("A", "U1", 50.8, 1),
        placed("B", "U2", 76.2, 2),
        extra,
    )
}

/// Writes the fixture as a project and returns the schematic path.
fn project(dir: &Path, a: &str, b: &str, extra: &str) -> PathBuf {
    let sch = dir.join("t.kicad_sch");
    std::fs::write(&sch, sheet(a, b, extra)).unwrap();
    std::fs::write(
        dir.join("t.kicad_pro"),
        "{\"meta\": {\"filename\": \"t.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    sch
}

fn findings(a: &str, b: &str, extra: &str) -> Vec<sch_write::gates::Finding> {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(dir.path(), a, b, extra);
    let tree = sch_read::read_project(&sch).unwrap();
    let nets = sch_net::build_nets(&tree);
    assert_eq!(
        nets.nets.len(),
        1,
        "the fixture must be a single net: {:?}",
        nets.nets
    );
    assert_eq!(nets.nets[0].members.len(), 2, "{:?}", nets.nets[0]);
    sch_check::erc(&tree, &nets)
}

fn find<'a>(
    fs: &'a [sch_write::gates::Finding],
    code: &str,
) -> Option<&'a sch_write::gates::Finding> {
    fs.iter().find(|f| f.code == code)
}

#[test]
fn two_outputs_on_one_net_are_an_error() {
    let fs = findings("output", "output", "");
    let f = find(&fs, "ERC_OUTPUT_CONFLICT").expect("output/output reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Error);
    // The older, more specific code owns this cell; the matrix must not report it twice.
    assert!(find(&fs, "ERC_PIN_TO_PIN").is_none(), "{fs:?}");
}

#[test]
fn output_into_input_is_clean() {
    let fs = findings("output", "input", "");
    for code in [
        "ERC_PIN_TO_PIN",
        "ERC_UNSPECIFIED_PIN",
        "ERC_OUTPUT_CONFLICT",
        "ERC_POWER_OUT_CONFLICT",
        "ERC_MULTIPLE_NET_NAMES",
    ] {
        assert!(find(&fs, code).is_none(), "{code}: {fs:?}");
    }
}

#[test]
fn two_power_outputs_stay_on_the_power_code() {
    let fs = findings("power_out", "power_out", "");
    let f = find(&fs, "ERC_POWER_OUT_CONFLICT").expect("power_out/power_out reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Error);
    assert!(find(&fs, "ERC_PIN_TO_PIN").is_none(), "{fs:?}");
}

#[test]
fn output_driving_an_open_collector_is_a_matrix_error() {
    let fs = findings("output", "open_collector", "");
    let f = find(&fs, "ERC_PIN_TO_PIN").expect("output/open_collector reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Error);
    assert!(f.message.contains("output/open_collector"), "{}", f.message);
    assert_eq!(f.refs, vec!["U1.1".to_string(), "U2.1".to_string()]);
    assert!(f.at_mil.is_some());
    // The net is auto-named after the pin name (`SCH_PIN::GetDefaultNetName`), not
    // after the pad: the fixture's pin is called "P".
    assert_eq!(f.location, "erc:pin2pin:error:Net-(U1-P)");
}

#[test]
fn output_on_a_tri_state_is_a_matrix_warning() {
    let fs = findings("output", "tri_state", "");
    let f = find(&fs, "ERC_PIN_TO_PIN").expect("output/tri_state reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert!(f.location.starts_with("erc:pin2pin:warning:"), "{f:?}");
}

/// A `no_connect` pin propagates connection to nothing
/// (`SCH_PIN::ConnectionPropagatesTo`), so it never shares a net with the pin it
/// faces and the matrix cell is unreachable through the netlist. kicad-cli 10.0.4
/// reports a wired `no_connect` pin as `no_connect_connected`, not as `pin_to_pin`.
#[test]
fn a_no_connect_pin_type_never_shares_a_net() {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(dir.path(), "no_connect", "passive", "");
    let tree = sch_read::read_project(&sch).unwrap();
    let nets = sch_net::build_nets(&tree);
    assert_eq!(nets.nets.len(), 2, "{:?}", nets.nets);
    assert!(nets.nets.iter().all(|n| n.members.len() == 1), "{nets:?}");
    // The matrix cell itself is unchanged.
    assert_eq!(
        sch_check::pin_matrix::pin_conflict(
            sch_model::PinType::NoConnect,
            sch_model::PinType::Passive
        ),
        Some(sch_write::gates::Severity::Error)
    );
}

#[test]
fn an_unspecified_pin_is_a_warning_of_its_own() {
    let fs = findings("unspecified", "passive", "");
    let f = find(&fs, "ERC_UNSPECIFIED_PIN").expect("unspecified/passive reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert!(find(&fs, "ERC_PIN_TO_PIN").is_none(), "{fs:?}");
    assert!(f.remediation.as_deref().unwrap().contains("library symbol"));
}

/// A no-connect marker on a wired pin: eeschema `no_connect_connected`, warning by default.
#[test]
fn a_no_connect_marker_on_a_connected_net_is_reported() {
    let nc = "\t(no_connect (at 50.8 50.8) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000401\"))\n";
    let fs = findings("passive", "passive", nc);
    let f = find(&fs, "ERC_NC_ON_CONNECTED").expect("no-connect on a two-pin net reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert_eq!(f.refs.len(), 2, "{f:?}");
}

#[test]
fn two_different_labels_on_one_net_are_a_warning() {
    let labels = concat!(
        "\t(label \"SIG_A\" (at 58.42 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000501\"))\n",
        "\t(label \"SIG_B\" (at 68.58 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000502\"))\n",
    );
    let fs = findings("passive", "passive", labels);
    let f = find(&fs, "ERC_MULTIPLE_NET_NAMES").expect("two labels reported");
    assert_eq!(f.severity, sch_write::gates::Severity::Warning);
    assert!(
        f.message.contains("SIG_A") && f.message.contains("SIG_B"),
        "{}",
        f.message
    );
    // Two local labels tie on the ladder; sch-net breaks the tie on the name, so SIG_A wins.
    assert_eq!(f.location, "erc:names:/SIG_A");
    assert!(
        f.message.ends_with("only SIG_A reaches the netlist"),
        "{}",
        f.message
    );
}

#[test]
fn one_label_repeated_is_not_a_name_conflict() {
    let labels = concat!(
        "\t(label \"SIG_A\" (at 58.42 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000501\"))\n",
        "\t(global_label \"SIG_A\" (shape input) (at 68.58 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000502\"))\n",
    );
    let fs = findings("passive", "passive", labels);
    assert!(find(&fs, "ERC_MULTIPLE_NET_NAMES").is_none(), "{fs:?}");
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

/// Violation `type` strings KiCad reports on `sch`, sorted and deduplicated.
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
    let mut types: Vec<String> = v["sheets"]
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
        .collect();
    types.sort();
    types.dedup();
    types
}

/// The engine and `kicad-cli sch erc` must agree on the fixtures above: every violation type
/// this crate now models has to show up on the same fixture in KiCad's own report.
#[test]
fn kicad_cli_agrees_on_the_matrix_fixtures() {
    let Some(cli) = kicad_cli() else { return };
    let nc = "\t(no_connect (at 50.8 50.8) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000401\"))\n";
    let labels = concat!(
        "\t(label \"SIG_A\" (at 58.42 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000501\"))\n",
        "\t(label \"SIG_B\" (at 68.58 50.8 0) (effects (font (size 1.27 1.27))) (uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000502\"))\n",
    );
    // (a, b, extra, engine code the fixture must raise, KiCad `type` it must raise)
    let cases: [(&str, &str, &str, &str, &str); 7] = [
        ("output", "output", "", "ERC_OUTPUT_CONFLICT", "pin_to_pin"),
        (
            "power_out",
            "power_out",
            "",
            "ERC_POWER_OUT_CONFLICT",
            "pin_to_pin",
        ),
        (
            "output",
            "open_collector",
            "",
            "ERC_PIN_TO_PIN",
            "pin_to_pin",
        ),
        ("output", "tri_state", "", "ERC_PIN_TO_PIN", "pin_to_pin"),
        (
            "unspecified",
            "passive",
            "",
            "ERC_UNSPECIFIED_PIN",
            "pin_to_pin",
        ),
        (
            "passive",
            "passive",
            nc,
            "ERC_NC_ON_CONNECTED",
            "no_connect_connected",
        ),
        (
            "passive",
            "passive",
            labels,
            "ERC_MULTIPLE_NET_NAMES",
            "multiple_net_names",
        ),
    ];
    for (a, b, extra, code, want) in cases {
        let dir = tempfile::tempdir().unwrap();
        let sch = project(dir.path(), a, b, extra);
        let tree = sch_read::read_project(&sch).unwrap();
        let nets = sch_net::build_nets(&tree);
        let fs = sch_check::erc(&tree, &nets);
        assert!(
            fs.iter().any(|f| f.code == code),
            "engine missed {code} on {a}/{b}: {fs:?}"
        );
        let types = oracle_types(&cli, &sch);
        assert!(
            types.iter().any(|t| t == want),
            "kicad-cli did not report {want} on {a}/{b}: {types:?}"
        );
    }
    // The clean fixture must stay clean on both sides.
    let dir = tempfile::tempdir().unwrap();
    let sch = project(dir.path(), "output", "input", "");
    let types = oracle_types(&cli, &sch);
    assert!(
        !types.iter().any(|t| t == "pin_to_pin"),
        "output/input is an OK cell in eeschema: {types:?}"
    );
}
