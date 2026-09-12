// SPDX-License-Identifier: Apache-2.0
use std::path::Path;

/// These cases place parts by `lib_id` from KiCad's own symbol libraries, which this
/// repository deliberately does not vendor (`release-process.md`: fluxsmith does not
/// redistribute the libraries), so `engine()` hands the write gate an empty library and
/// every apply is refused with `SYMBOL_NOT_FOUND`. Hosted CI has no KiCad, so they skip
/// there; the conformance runner sets `FLUXSMITH_CONFORMANCE=required`, which turns
/// absence into a hard failure so a skip cannot pass silently where KiCad does exist.
fn kicad_libraries_present() -> bool {
    let (env, table) = sch_read::discover_kicad(None);
    let resolvable = table
        .and_then(|t| sch_read::parse_lib_table(&t, &env, 0).ok())
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    if resolvable {
        return true;
    }
    let required = std::env::var("FLUXSMITH_CONFORMANCE")
        .map(|v| v == "required")
        .unwrap_or(false);
    assert!(
        !required,
        "FLUXSMITH_CONFORMANCE=required but KiCad's symbol libraries were not found \
         (install KiCad 10 so sym-lib-table resolves)"
    );
    false
}

macro_rules! need_kicad_libs {
    () => {
        if !kicad_libraries_present() {
            eprintln!("KiCad symbol libraries not installed: case skipped");
            return;
        }
    };
}

fn fixture() -> sch_read::SheetTree {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch");
    sch_read::read_project(&p).unwrap()
}

#[test]
fn erc_runs_on_hier_fixture_without_panicking() {
    let tree = fixture();
    let nets = sch_net::build_nets(&tree);
    let findings = sch_check::erc(&tree, &nets);
    // Resistor-only fixture: no output conflicts.
    assert!(findings.iter().all(|f| f.code != "ERC_OUTPUT_CONFLICT"));
}

#[test]
fn sheet_pins_and_hier_labels_must_match() {
    let mut tree = fixture();
    let nets = sch_net::build_nets(&tree);
    let clean = sch_check::erc(&tree, &nets);
    assert!(
        clean
            .iter()
            .all(|f| f.code != "SHEET_PIN_UNMATCHED" && f.code != "HIER_LABEL_UNMATCHED"),
        "{clean:?}"
    );
    // Drop one hierarchical label from a child sheet: its sheet pin is now unmatched (eeschema error).
    let child = tree
        .instances
        .iter()
        .find(|i| i.parent.is_some())
        .map(|i| i.file.clone())
        .expect("fixture has a child sheet");
    let sheet = tree.files.get_mut(&child).unwrap();
    let before = sheet.labels.len();
    let removed = sheet
        .labels
        .iter()
        .position(|l| l.kind == sch_model::LabelKind::Hierarchical)
        .expect("child sheet has a hierarchical label");
    let name = sheet.labels.remove(removed).text;
    assert_eq!(sheet.labels.len(), before - 1);
    let findings = sch_check::erc(&tree, &nets);
    assert!(
        findings
            .iter()
            .any(|f| f.code == "SHEET_PIN_UNMATCHED" && f.message.contains(&name)),
        "{findings:?}"
    );
}

#[test]
fn intent_snapshot_round_trips_and_matches_itself() {
    let tree = fixture();
    let nets = sch_net::build_nets(&tree);
    let intent = sch_check::intent_snapshot(&nets, "fixture");
    let json = serde_json::to_string(&intent).unwrap();
    let back: sch_check::Intent = serde_json::from_str(&json).unwrap();
    assert!(sch_check::check_intent(&nets, &back).is_empty());
}

#[test]
fn gate_run_reports_every_family() {
    let tree = fixture();
    let nets = sch_net::build_nets(&tree);
    let report = sch_check::gate_run(&tree, &nets, None, None);
    let names: Vec<&str> = report.families.iter().map(|f| f.name.as_str()).collect();
    for want in ["integrity", "erc", "project", "layout", "pinmap", "style"] {
        assert!(names.contains(&want), "missing family {want}: {names:?}");
    }
}

fn engine() -> sch_write::Engine {
    let (env, table) = sch_read::discover_kicad(None);
    let rows = table
        .map(|t| sch_read::parse_lib_table(&t, &env, 0).unwrap())
        .unwrap_or_default();
    sch_write::Engine::new(sch_read::SymbolLibrary::new(rows))
}

fn req(target: &std::path::Path, json: &str) -> sch_write::DrawRequest {
    sch_write::DrawRequest {
        target: target.to_path_buf(),
        root: None,
        oplist: sch_ops::OpList::from_json(json).unwrap(),
        strict_nets: true,
        strict_layout: true,
        expected_merges: vec![],
        note: Some("test".into()),
        backup_depth: 2,
        journal: None,
        expected_target_sha: None,
        run_backup_dir: None,
    }
}

#[test]
fn undriven_power_input_names_its_anchor_and_a_pwr_flag_clears_it() {
    need_kicad_libs!();
    let dir = tempfile::tempdir().unwrap();
    let fx = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier");
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fx.join(f), dir.path().join(f)).unwrap();
    }
    let t = dir.path().join("hier_root.kicad_sch");
    let mut eng = engine();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"place_component","lib_id":"Regulator_Linear:AMS1117-3.3","designator":"U60","x_mil":7000,"y_mil":6000},
      {"op":"place_component","lib_id":"Device:R","designator":"R60","x_mil":5500,"y_mil":6000},
      {"op":"add_net_label","at":"U60.3","name":"REG_IN"},
      {"op":"add_net_label","at":"R60.1","name":"REG_IN"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::build_nets(&tree);
    let erc = sch_check::erc(&tree, &nets);
    let und = erc
        .iter()
        .find(|f| f.code == "ERC_POWER_IN_UNDRIVEN" && f.location.ends_with("REG_IN"))
        .expect("undriven REG_IN reported");
    assert_eq!(
        und.refs.first().map(String::as_str),
        Some("U60.3"),
        "{:?}",
        und.refs
    );
    assert_eq!(und.remediation.as_deref(), Some("place_pwr_flag at U60.3"));
    assert!(und.at_mil.is_some());
    let pm = sch_check::pinmap_findings(&tree, &nets);
    assert!(pm.iter().all(|f| f.code == "PINMAP_UNCONNECTED"
        && f.location.starts_with("pin:")
        && f.refs[0].contains('.')));
    let r = eng
        .apply(&req(
            &t,
            r#"{"protocol_version":1,"ops":[{"op":"place_pwr_flag","at":"U60.3"}]}"#,
        ))
        .unwrap();
    assert!(r.applied, "{:?}", r.refusal);
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::build_nets(&tree);
    assert!(
        nets.nets.iter().any(|n| n.flagged),
        "a net carries the PWR_FLAG"
    );
    let erc = sch_check::erc(&tree, &nets);
    assert!(
        erc.iter()
            .all(|f| !(f.code == "ERC_POWER_IN_UNDRIVEN" && f.location.ends_with("REG_IN"))),
        "{:?}",
        erc
    );
}

#[test]
fn rail_key_normalises_voltage_forms_only() {
    use sch_check::rail_key;
    assert_eq!(rail_key("+3V3"), rail_key("+3.3V"));
    assert_eq!(rail_key("3V3"), rail_key("+3v3"));
    assert_ne!(rail_key("+5V"), rail_key("+5V_USB"));
    assert_ne!(rail_key("-5V"), rail_key("+5V"));
    assert_ne!(rail_key("-5V"), rail_key("-12V"));
    assert_ne!(rail_key("VCC_3V3"), rail_key("VCC_5V"));
    assert_ne!(rail_key("+5V"), rail_key("+5VA"));
}

#[test]
fn fixture_labels_are_all_attached() {
    let tree = fixture();
    let nets = sch_net::build_nets(&tree);
    let findings = sch_check::erc(&tree, &nets);
    assert!(
        findings.iter().all(|f| f.code != "LABEL_DANGLING"),
        "{findings:?}"
    );
}

#[test]
fn fixture_has_no_dangling_power_ports() {
    let tree = fixture();
    let nets = sch_net::build_nets(&tree);
    let findings = sch_check::erc(&tree, &nets);
    assert!(
        findings.iter().all(|f| f.code != "POWER_PORT_DANGLING"),
        "{findings:?}"
    );
}
