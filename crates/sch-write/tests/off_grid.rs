// SPDX-License-Identifier: Apache-2.0
//! `OFF_GRID` = eeschema's `endpoint_off_grid` (`erc.cpp::TestOffGridEndpoints`): an exact
//! integer modulo against the connection grid (`DEFAULT_CONNECTION_GRID_MILS` = 50), applied to
//! symbol *pin* positions, wire and bus endpoints and bus-entry ends. When KiCad is installed the
//! same fixtures also go through `kicad-cli sch erc` (docs/engine-conformance.md; skipped when
//! `kicad-cli` is absent, unless `FLUXSMITH_CONFORMANCE=required`).

use std::path::{Path, PathBuf};
use std::process::Command;

const ROOT: &str = "0e7b7e4e-1b3c-4c2e-9a10-0000000000f3";

/// A one-pin library symbol whose pin sits `dx` mm to the right of the symbol origin.
fn lib_symbol(name: &str, dx: f64) -> String {
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
			(pin passive line (at {dx} 0 0) (length 2.54) (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
		)
		(embedded_fonts no)
	)
"#
    )
}

const SYM_UUID: &str = "0e7b7e4e-1b3c-4c2e-9a10-000000000101";
const WIRE_UUID: &str = "0e7b7e4e-1b3c-4c2e-9a10-000000000301";
const BUS_UUID: &str = "0e7b7e4e-1b3c-4c2e-9a10-000000000302";
const ENTRY_UUID: &str = "0e7b7e4e-1b3c-4c2e-9a10-000000000303";

fn placed(lib: &str, refdes: &str, x: f64, y: f64) -> String {
    format!(
        r#"	(symbol
		(lib_id "Test:{lib}")
		(at {x} {y} 0)
		(unit 1)
		(exclude_from_sim no)
		(in_bom yes)
		(on_board yes)
		(dnp no)
		(uuid "{SYM_UUID}")
		(property "Reference" "{refdes}" (at {x} {y} 0) (effects (font (size 1.27 1.27))))
		(property "Value" "{lib}" (at {x} {y} 0) (effects (font (size 1.27 1.27))))
		(property "Footprint" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
		(pin "1" (uuid "0e7b7e4e-1b3c-4c2e-9a10-000000000201"))
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

fn wire(x0: f64, y0: f64, x1: f64, y1: f64) -> String {
    format!("\t(wire (pts (xy {x0} {y0}) (xy {x1} {y1})) (stroke (width 0) (type default)) (uuid \"{WIRE_UUID}\"))\n")
}

fn bus_and_entry(x: f64, y: f64) -> String {
    format!(
        "\t(bus (pts (xy {bx} {y}) (xy {ex} {y})) (stroke (width 0) (type default)) (uuid \"{BUS_UUID}\"))\n\t(bus_entry (at {x} {y}) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid \"{ENTRY_UUID}\"))\n",
        bx = x - 10.16,
        ex = x + 10.16,
    )
}

fn project(dir: &Path, libs: &str, body: &str) -> PathBuf {
    let sch = dir.join("t.kicad_sch");
    std::fs::write(&sch, format!(
        "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT}\")\n\t(paper \"A4\")\n\t(lib_symbols\n{libs}\t)\n{body}\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n"
    )).unwrap();
    std::fs::write(
        dir.join("t.kicad_pro"),
        "{\"meta\": {\"filename\": \"t.kicad_pro\", \"version\": 3}}\n",
    )
    .unwrap();
    sch
}

fn off_grid(sch: &Path) -> Vec<sch_write::gates::Finding> {
    let tree = sch_read::read_project(sch).unwrap();
    let mut v: Vec<sch_write::gates::Finding> = sch_write::gates::style(&tree)
        .into_iter()
        .filter(|f| f.code == "OFF_GRID")
        .collect();
    v.sort_by(|a, b| a.location.cmp(&b.location));
    v
}

/// 25 mil (0.635 mm) off a 50 mil point: on the fine grid a human may draw on, but not on the
/// connection grid KiCad tests against.
const OFF: f64 = 51.435;
const ON: f64 = 50.8;

#[test]
fn a_pin_a_wire_and_a_bus_entry_off_the_50_mil_grid_are_all_reported() {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("A", 0.0),
        &(placed("A", "R1", OFF, OFF)
            + &wire(OFF, OFF, OFF + 12.7, OFF)
            + &bus_and_entry(OFF, 40.005)),
    );
    let fs = off_grid(&sch);
    let locations: Vec<&str> = fs.iter().map(|f| f.location.as_str()).collect();
    assert_eq!(
        locations,
        vec![
            format!("style:busentry:{ENTRY_UUID}:end").as_str(),
            format!("style:busentry:{ENTRY_UUID}:start").as_str(),
            format!("style:grid:{SYM_UUID}:1").as_str(),
            format!("style:wire:{WIRE_UUID}:end").as_str(),
            format!("style:wire:{WIRE_UUID}:start").as_str(),
            format!("style:wire:{BUS_UUID}:end").as_str(),
            format!("style:wire:{BUS_UUID}:start").as_str(),
        ],
        "{fs:?}"
    );
    for f in &fs {
        assert_eq!(f.severity, sch_write::gates::Severity::Warning);
        assert!(f.message.contains("50 mil"), "{}", f.message);
    }
    let pin = fs.iter().find(|f| f.location.contains(SYM_UUID)).unwrap();
    assert!(pin.message.starts_with("pin R1.1 at "), "{}", pin.message);
    assert_eq!(pin.refs, vec!["R1.1".to_string()]);
}

#[test]
fn a_symbol_anchored_on_the_grid_with_a_pin_off_it_is_reported() {
    // The gap this replaced: the anchor was checked, so a library symbol carrying an off-grid pin
    // slipped through.
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("C", 0.635),
        &placed("C", "R1", ON, ON),
    );
    let fs = off_grid(&sch);
    assert_eq!(fs.len(), 1, "{fs:?}");
    assert_eq!(fs[0].location, format!("style:grid:{SYM_UUID}:1"));
}

#[test]
fn everything_on_the_50_mil_grid_is_clean() {
    let dir = tempfile::tempdir().unwrap();
    let sch = project(
        dir.path(),
        &lib_symbol("A", 0.0),
        &(placed("A", "R1", ON, ON) + &wire(ON, ON, ON + 12.7, ON) + &bus_and_entry(ON, 40.64)),
    );
    assert!(off_grid(&sch).is_empty(), "{:?}", off_grid(&sch));
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

/// KiCad has to agree on which fixture is off the connection grid. Counts differ by design: KiCad
/// files one violation per line, the engine one per endpoint, so only presence is compared.
#[test]
fn kicad_cli_agrees_on_the_grid_fixtures() {
    let Some(cli) = kicad_cli() else { return };
    let cases: [(&str, f64, f64, bool); 3] = [
        ("25 mil coordinates", 0.0, OFF, true),
        ("off-grid pin in the library symbol", 0.635, ON, true),
        ("50 mil coordinates", 0.0, ON, false),
    ];
    for (name, dx, at, want) in cases {
        let dir = tempfile::tempdir().unwrap();
        let sch = project(
            dir.path(),
            &lib_symbol("A", dx),
            &(placed("A", "R1", at, at) + &wire(at + dx, at, at + dx + 12.7, at)),
        );
        let ours = !off_grid(&sch).is_empty();
        assert_eq!(ours, want, "engine on {name}: {:?}", off_grid(&sch));
        let types = oracle_types(&cli, &sch);
        assert_eq!(
            types.iter().any(|t| t == "endpoint_off_grid"),
            want,
            "kicad-cli on {name}: {types:?}"
        );
    }
}
