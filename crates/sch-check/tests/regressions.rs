// SPDX-License-Identifier: Apache-2.0
//! Check-side regressions (docs/engine-conformance.md §4): BOM and designator counting on
//! twice-instantiated sheets, and the ERC oracle after a write.

use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures")
}

fn engine() -> sch_write::Engine {
    let (env, table) = sch_read::discover_kicad(None);
    let rows = table
        .map(|t| sch_read::parse_lib_table(&t, &env, 0).unwrap())
        .unwrap_or_default();
    sch_write::Engine::new(sch_read::SymbolLibrary::new(rows))
}

fn req(target: &Path, json: &str) -> sch_write::DrawRequest {
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

const ROOT: &str = "11111111-1111-4111-8111-111111111111";
const SHEET1: &str = "33333333-3333-4333-8333-333333333333";
const SHEET2: &str = "44444444-4444-4444-8444-444444444444";

/// A copy of the hierarchy where `hier_child.kicad_sch` is instantiated twice (a second
/// `(sheet)` node in the root). With `annotate_second`, every child symbol gets its own
/// reference for the second instance path (R3 -> R9 ...), the way KiCad annotates reused
/// sheets; without it both instances fall back to the symbol's Reference property.
fn twice_instantiated(annotate_second: bool) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fixtures().join("hier").join(f), dir.path().join(f)).unwrap();
    }
    let t = dir.path().join("hier_root.kicad_sch");
    let root = std::fs::read_to_string(&t).unwrap();
    let start = root.find("\t(sheet\n").unwrap();
    let end = root[start..].find("\n\t)\n").unwrap() + start + 4;
    let block = &root[start..end];
    let second = block
        .replace(SHEET1, SHEET2)
        .replace("(at 63.5 55.88)", "(at 95.25 55.88)")
        .replace("\"child\"", "\"child2\"")
        .replace("(page \"2\")", "(page \"3\")")
        .replace(
            "aaaaaaaa-aaaa-4aaa-8aaa-000000000013",
            "aaaaaaaa-aaaa-4aaa-8aaa-000000000113",
        )
        .replace(
            "aaaaaaaa-aaaa-4aaa-8aaa-000000000014",
            "aaaaaaaa-aaaa-4aaa-8aaa-000000000114",
        )
        .replace("(at 63.5 58.42 180)", "(at 95.25 58.42 180)")
        .replace("(at 76.2 63.5 0)", "(at 107.95 63.5 0)")
        .replace("(at 63.5 55.1684 0)", "(at 95.25 55.1684 0)")
        .replace("(at 63.5 66.6246 0)", "(at 95.25 66.6246 0)");
    let patched = format!("{}{}\n{}", &root[..end], second, &root[end..]);
    assert_ne!(patched, root);
    std::fs::write(&t, patched).unwrap();
    if annotate_second {
        let child_p = dir.path().join("hier_child.kicad_sch");
        let child = std::fs::read_to_string(&child_p).unwrap();
        let re = regex::Regex::new(&format!(
            "\\(path \"/{ROOT}/{SHEET1}\"\\n\\t\\t\\t\\t\\t\\(reference \"([^\"]+)\"\\)\\n\\t\\t\\t\\t\\t\\(unit 1\\)\\n\\t\\t\\t\\t\\)"
        ))
        .unwrap();
        let out = re.replace_all(&child, |c: &regex::Captures| {
            let r = &c[1];
            let (prefix, num): (String, u32) = (r.chars().take_while(|ch| !ch.is_ascii_digit()).collect(), r.chars().skip_while(|ch| !ch.is_ascii_digit()).collect::<String>().parse().unwrap());
            format!("{}\n\t\t\t\t(path \"/{ROOT}/{SHEET2}\"\n\t\t\t\t\t(reference \"{prefix}{}\")\n\t\t\t\t\t(unit 1)\n\t\t\t\t)", &c[0], num + 6)
        });
        assert_ne!(
            out.as_ref(),
            child.as_str(),
            "child annotated for the second path"
        );
        std::fs::write(&child_p, out.as_ref()).unwrap();
    }
    (dir, t)
}

/// reg 0.20.0: BOM lines are keyed by (instance path, symbol) — a twice-instantiated sheet
/// contributes its parts twice, never silently merged into one line.
#[test]
fn reg_bom_counts_every_instance_path() {
    let (_d, t) = twice_instantiated(true);
    let tree = sch_read::read_project(&t).unwrap();
    assert_eq!(
        tree.instances
            .iter()
            .filter(|i| i.file.ends_with("hier_child.kicad_sch"))
            .count(),
        2
    );
    let bom = sch_check::bom(&tree);
    let qty: usize = bom.iter().filter(|l| !l.dnp).map(|l| l.qty).sum();
    let refs: usize = bom.iter().map(|l| l.refs.len()).sum();
    // root: R1, R2; child: R3..R8 (6) x 2 instances = 14 resistors
    assert_eq!(qty, 14, "{bom:?}");
    assert_eq!(refs, qty, "every instance is listed: {bom:?}");
    assert!(
        bom.iter()
            .all(|l| !l.refs.iter().any(|r| r.starts_with('#'))),
        "power symbols are not BOM lines"
    );
    let all_refs: Vec<&String> = bom.iter().flat_map(|l| l.refs.iter()).collect();
    assert!(
        all_refs.iter().any(|r| r.as_str() == "R3") && all_refs.iter().any(|r| r.as_str() == "R9"),
        "both instance references listed: {all_refs:?}"
    );
}

/// reg 0.20.0: DUPLICATE_DESIGNATOR counts path entries (instances), so the reused sheet's
/// symbols are not duplicates of themselves, while two symbol nodes with one refdes are.
#[test]
fn reg_duplicate_designator_counts_path_entries_not_nodes() {
    // annotated per path: no duplicates
    let (_d, t) = twice_instantiated(true);
    let tree = sch_read::read_project(&t).unwrap();
    let f = sch_write::gates::integrity(&tree);
    let dups: Vec<&sch_write::gates::Finding> = f
        .iter()
        .filter(|x| x.code.starts_with("DUPLICATE_DESIGNATOR"))
        .collect();
    let resolved: Vec<(String, Vec<String>)> = tree
        .instances
        .iter()
        .map(|i| {
            (
                i.path.clone(),
                tree.files[&i.file]
                    .symbols
                    .iter()
                    .map(|s| {
                        s.instances
                            .iter()
                            .find(|r| r.path == i.path)
                            .map(|r| r.reference.clone())
                            .unwrap_or_else(|| format!("{}(prop)", s.reference))
                    })
                    .collect(),
            )
        })
        .collect();
    assert!(dups.is_empty(), "a reused sheet annotated per instance is not a duplicate of itself: {dups:?}\n{resolved:?}");
    // not annotated: both paths resolve to R3..R8 — one symbol node, two path entries, and the
    // gate must count the entries (this is what a node-count missed)
    let (_d2, t2) = twice_instantiated(false);
    let tree2 = sch_read::read_project(&t2).unwrap();
    let f2 = sch_write::gates::integrity(&tree2);
    let dups2: Vec<&sch_write::gates::Finding> = f2
        .iter()
        .filter(|x| x.code.starts_with("DUPLICATE_DESIGNATOR"))
        .collect();
    assert!(
        dups2
            .iter()
            .any(|x| x.refs.contains(&"R3".to_string()) || x.message.contains("R3")),
        "reused-sheet duplicate refdes must be reported: {dups2:?}"
    );
    let mut eng = engine();
    let r = eng.plan(&req(&t, r#"{"protocol_version":1,"ops":[{"op":"place_component","lib_id":"Device:R","designator":"R3","x_mil":9000,"y_mil":6000}]}"#)).unwrap();
    assert!(
        r.integrity_introduced
            .iter()
            .any(|x| x.code.starts_with("DUPLICATE_DESIGNATOR")
                && x.refs.contains(&"R3".to_string())),
        "{:?}",
        r.integrity_introduced
    );
    assert!(!r.applied);
}

/// The gate families and the ERC rules run over the twice-instantiated tree without
/// panicking and report no integrity error for a clean design.
#[test]
fn gate_run_is_clean_on_twice_instantiated_tree() {
    let (_d, t) = twice_instantiated(true);
    let tree = sch_read::read_project(&t).unwrap();
    let nets = sch_net::build_nets(&tree);
    let report = sch_check::gate_run(&tree, &nets, None, None);
    let integrity = report
        .families
        .iter()
        .find(|f| f.name == "integrity")
        .unwrap();
    // the fixture's demo bus has free ends (pre-existing DANGLING_BUS); nothing else may appear
    let other: Vec<&sch_write::gates::Finding> = integrity
        .findings
        .iter()
        .filter(|f| f.code != "DANGLING_BUS")
        .collect();
    assert!(other.is_empty(), "{other:?}");
    let glb: Vec<String> = nets
        .by_name("GLB")
        .unwrap()
        .members
        .iter()
        .map(|m| format!("{}{}.{}", m.sheet, m.reference, m.pin))
        .collect();
    // root R1.2 + child R3.1 (via the wired VIN sheet pin) + R4.1 in both instances (their own
    // global label); the second instance's VIN pin is unwired, so R9.1 stays out.
    assert_eq!(
        glb,
        vec!["/R1.2", "/child/R3.1", "/child/R4.1", "/child2/R10.1"]
    );
}

/// FR-611: a sheet file placed once needs no per-instance annotation, so the check stays quiet
/// on the plain hierarchy fixture.
#[test]
fn instance_refs_quiet_on_single_instance_hierarchy() {
    let tree =
        sch_read::read_project(&fixtures().join("hier").join("hier_root.kicad_sch")).unwrap();
    let f = sch_check::instance_refs(&tree);
    assert!(f.is_empty(), "{f:?}");
}

/// FR-611: a twice-instantiated sheet whose symbols carry a reference for both instance paths
/// is clean.
#[test]
fn instance_refs_clean_when_every_path_is_annotated() {
    let (_d, t) = twice_instantiated(true);
    let tree = sch_read::read_project(&t).unwrap();
    let f = sch_check::instance_refs(&tree);
    assert!(f.is_empty(), "{f:?}");
}

/// FR-611: one symbol without an entry for the second instance path is an Error that names it,
/// carries the missing path, and reaches the erc family.
#[test]
fn instance_refs_flags_a_symbol_missing_one_path() {
    let (_d, t) = twice_instantiated(true);
    let mut tree = sch_read::read_project(&t).unwrap();
    let second = format!("/{ROOT}/{SHEET2}");
    let child = tree
        .instances
        .iter()
        .find(|i| i.parent.is_some())
        .map(|i| i.file.clone())
        .expect("fixture has a child sheet");
    let sheet = tree.files.get_mut(&child).unwrap();
    let sym = sheet
        .symbols
        .iter_mut()
        .find(|s| s.reference == "R3")
        .expect("child sheet has R3");
    sym.instances.retain(|r| r.path != second);
    let f = sch_check::instance_refs(&tree);
    assert_eq!(f.len(), 1, "one finding per sheet file: {f:?}");
    assert_eq!(f[0].code, "INSTANCE_REFS_REQUIRED");
    assert_eq!(f[0].severity, sch_write::gates::Severity::Error);
    assert_eq!(f[0].refs, vec!["R3".to_string()]);
    assert!(f[0].message.contains("R3"), "{}", f[0].message);
    assert!(f[0].message.contains(&second), "{}", f[0].message);
    assert!(f[0].at_mil.is_some(), "anchored at the symbol: {f:?}");
    assert!(f[0].remediation.is_some());
    let nets = sch_net::build_nets(&tree);
    assert!(
        sch_check::erc(&tree, &nets)
            .iter()
            .any(|x| x.code == "INSTANCE_REFS_REQUIRED"),
        "erc carries the finding"
    );
}

/// FR-611: power symbols are annotated by KiCad itself and never reported.
#[test]
fn instance_refs_ignores_power_symbols() {
    let (_d, t) = twice_instantiated(true);
    let mut tree = sch_read::read_project(&t).unwrap();
    let second = format!("/{ROOT}/{SHEET2}");
    let mut stripped = 0;
    for sheet in tree.files.values_mut() {
        let power: Vec<String> = sheet
            .symbols
            .iter()
            .filter(|s| {
                s.reference.starts_with('#')
                    || sheet
                        .lib_symbol(&s.lib_id)
                        .map(|l| l.is_power)
                        .unwrap_or(false)
            })
            .map(|s| s.uuid.clone())
            .collect();
        for s in sheet.symbols.iter_mut().filter(|s| power.contains(&s.uuid)) {
            let before = s.instances.len();
            s.instances.retain(|r| r.path != second);
            stripped += before - s.instances.len();
        }
    }
    assert!(stripped > 0, "the fixture has power symbols to strip");
    let f = sch_check::instance_refs(&tree);
    assert!(f.is_empty(), "{f:?}");
}

/// FR-611: a second instance that was never annotated reports every non-power symbol of the
/// reused file in a single finding.
#[test]
fn instance_refs_reports_an_unannotated_second_instance() {
    let (_d, t) = twice_instantiated(false);
    let tree = sch_read::read_project(&t).unwrap();
    let f = sch_check::instance_refs(&tree);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].refs, ["R3", "R4", "R5", "R6", "R7", "R8"]);
    assert!(
        f[0].refs.iter().all(|r| !r.starts_with('#')),
        "power symbols stay out: {:?}",
        f[0].refs
    );
    assert!(
        f[0].message.contains("hier_child.kicad_sch"),
        "{}",
        f[0].message
    );
}

/// A working copy of the `hier` fixture (root + child + project file).
fn hier_copy() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fixtures().join("hier").join(f), dir.path().join(f)).unwrap();
    }
    let t = dir.path().join("hier_root.kicad_sch");
    (dir, t)
}

/// How many hierarchical labels named `name` the file `file` carries.
fn hier_labels(tree: &sch_read::SheetTree, file: &str, name: &str) -> usize {
    tree.files
        .iter()
        .filter(|(p, _)| p.ends_with(file))
        .flat_map(|(_, s)| s.labels.iter())
        .filter(|l| l.kind == sch_model::LabelKind::Hierarchical && l.text == name)
        .count()
}

/// P0: a sheet pin added to a child that already exists is written together with the matching
/// hierarchical label inside that child. Without it the pin is an instant `SHEET_PIN_UNMATCHED`
/// (eeschema `hier_label_mismatch`, an error both ways) and nothing inside the child can be wired
/// to it, so a hierarchical interface built one pin at a time was unbuildable. Re-applying the
/// same op-list adds nothing.
#[test]
fn reg_add_sheet_pin_seeds_the_hierarchical_label_in_the_child() {
    let (_d, t) = hier_copy();
    let ops = r#"{"protocol_version":1,"ops":[
      {"op":"add_sheet_pin","sheet":"child","name":"EN","type":"input","side":"left"}]}"#;
    let mut eng = engine();
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    assert!(
        r.per_op[0]
            .warnings
            .iter()
            .any(|w| w.starts_with("HIER_LABEL_SEEDED EN")),
        "{:?}",
        r.per_op[0].warnings
    );
    let tree = sch_read::read_project(&t).unwrap();
    assert_eq!(hier_labels(&tree, "hier_child.kicad_sch", "EN"), 1);
    // The pin and the label match, both ways, so neither mismatch code fires.
    let nets = sch_net::build_nets(&tree);
    let f = sch_check::erc(&tree, &nets);
    assert!(
        f.iter()
            .all(|x| x.code != "SHEET_PIN_UNMATCHED" && x.code != "HIER_LABEL_UNMATCHED"),
        "{f:?}"
    );
    // Second apply: neither file changes a byte. The pin is already on the sheet symbol and the
    // label is already in the child, so both halves of the op are no-ops.
    let files: Vec<PathBuf> = ["hier_root.kicad_sch", "hier_child.kicad_sch"]
        .iter()
        .map(|f| t.parent().unwrap().join(f))
        .collect();
    let before: Vec<Vec<u8>> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();
    let r2 = eng.apply(&req(&t, ops)).unwrap();
    assert!(r2.targets.is_empty(), "{:?}", r2.targets);
    assert!(
        r2.per_op[0]
            .warnings
            .iter()
            .any(|w| w.starts_with("SHEET_PIN_EXISTS EN")),
        "{:?}",
        r2.per_op[0].warnings
    );
    for (f, b) in files.iter().zip(before) {
        assert_eq!(std::fs::read(f).unwrap(), b, "{}", f.display());
    }
    assert_eq!(
        hier_labels(
            &sch_read::read_project(&t).unwrap(),
            "hier_child.kicad_sch",
            "EN"
        ),
        1
    );
}

/// The label a sheet pin seeded stays when the pin goes: it may carry the child's own wiring, and
/// `sch-check` reports the leftover as `HIER_LABEL_UNMATCHED` with both remedies.
#[test]
fn reg_delete_sheet_pin_leaves_the_child_label_alone() {
    let (_d, t) = hier_copy();
    let mut eng = engine();
    // A fresh pin (nothing is wired to it in the parent, so deleting it dangles no endpoint).
    let add = r#"{"protocol_version":1,"ops":[
      {"op":"add_sheet_pin","sheet":"child","name":"EN","type":"input","side":"left"}]}"#;
    assert!(eng.apply(&req(&t, add)).unwrap().applied);
    let ops =
        r#"{"protocol_version":1,"ops":[{"op":"delete_sheet_pin","sheet":"child","name":"EN"}]}"#;
    let r = eng.apply(&req(&t, ops)).unwrap();
    assert!(r.applied, "{:?} {:?}", r.refusal, r.per_op);
    let tree = sch_read::read_project(&t).unwrap();
    assert_eq!(hier_labels(&tree, "hier_child.kicad_sch", "EN"), 1);
    let nets = sch_net::build_nets(&tree);
    let f = sch_check::erc(&tree, &nets);
    assert!(
        f.iter().any(|x| x.code == "HIER_LABEL_UNMATCHED"),
        "the orphan label is reported, not deleted: {f:?}"
    );
}
