// SPDX-License-Identifier: Apache-2.0
//! L1 invariants owned by sch-net (I4, I9–I14, I25) and connectivity regressions
//! (docs/engine-conformance.md §4). Every case is checked against the engine and, when
//! `kicad-cli` is installed, against `kicad-cli sch export netlist` (the oracle).
//! `FLUXSMITH_CONFORMANCE=required` turns a missing oracle into a failure.

use sch_net::{diff_nets, net_id, NetChange, NetScope, Netlist};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

// ---------------------------------------------------------------------------
// Crafted schematics (lib_symbols copied from the conformance fixture)
// ---------------------------------------------------------------------------

const ROOT_UUID: &str = "11111111-1111-4111-8111-111111111111";

fn fixture_lib_symbols() -> String {
    let src = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch"),
    )
    .unwrap();
    let doc = kicad_sexpr::parse(&src).unwrap();
    let mut libs = doc.root.find("lib_symbols").unwrap().clone();
    let flag = kicad_sexpr::parse(PWR_FLAG).unwrap();
    libs.push(kicad_sexpr::Node::list(flag.root));
    kicad_sexpr::dumps_list(&libs)
}

const PWR_FLAG: &str = r##"(symbol "power:PWR_FLAG" (power global) (pin_numbers (hide yes)) (pin_names (offset 0) (hide yes)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "#FLG" (at 0 1.905 0) (effects (font (size 1.27 1.27)) (hide yes)))
  (property "Value" "PWR_FLAG" (at 0 3.81 0) (effects (font (size 1.27 1.27))))
  (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
  (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
  (symbol "PWR_FLAG_0_0" (pin power_out line (at 0 0 90) (length 0) (name "pwr" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
  (symbol "PWR_FLAG_0_1" (polyline (pts (xy 0 0) (xy 0 1.27) (xy -1.016 1.905) (xy 0 2.54) (xy 1.016 1.905) (xy 0 1.27)) (stroke (width 0) (type default)) (fill (type none)))))"##;

#[derive(Default)]
struct Sch {
    nodes: Vec<String>,
    n: usize,
}

impl Sch {
    fn uuid(&mut self) -> String {
        self.n += 1;
        format!("bbbbbbbb-bbbb-4bbb-8bbb-{:012}", self.n)
    }
    /// Device:R / power:GND / power:+3V3 / power:PWR_FLAG at (x,y) mm, rotation deg.
    fn symbol(&mut self, lib_id: &str, refdes: &str, x: f64, y: f64, rot: i64) -> &mut Self {
        self.symbol_m(lib_id, refdes, x, y, rot, "")
    }
    fn symbol_m(
        &mut self,
        lib_id: &str,
        refdes: &str,
        x: f64,
        y: f64,
        rot: i64,
        mirror: &str,
    ) -> &mut Self {
        let u = self.uuid();
        let value = match lib_id {
            "Device:R" => "1k",
            other => other.rsplit(':').next().unwrap(),
        };
        let m = if mirror.is_empty() {
            String::new()
        } else {
            format!(" (mirror {mirror})")
        };
        self.nodes.push(format!(
            "(symbol (lib_id \"{lib_id}\") (at {x} {y} {rot}){m} (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid \"{u}\")\n\
             (property \"Reference\" \"{refdes}\" (at {x} {y} 0) (effects (font (size 1.27 1.27))))\n\
             (property \"Value\" \"{value}\" (at {x} {y} 0) (effects (font (size 1.27 1.27))))\n\
             (property \"Footprint\" \"\" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n\
             (property \"Datasheet\" \"\" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n\
             (pin \"1\" (uuid \"{u}\")) (pin \"2\" (uuid \"{u}\"))\n\
             (instances (project \"t\" (path \"/{ROOT_UUID}\" (reference \"{refdes}\") (unit 1)))))"
        ));
        self
    }
    fn wire(&mut self, x1: f64, y1: f64, x2: f64, y2: f64) -> &mut Self {
        let u = self.uuid();
        self.nodes.push(format!("(wire (pts (xy {x1} {y1}) (xy {x2} {y2})) (stroke (width 0) (type default)) (uuid \"{u}\"))"));
        self
    }
    fn junction(&mut self, x: f64, y: f64) -> &mut Self {
        let u = self.uuid();
        self.nodes.push(format!(
            "(junction (at {x} {y}) (diameter 0) (color 0 0 0 0) (uuid \"{u}\"))"
        ));
        self
    }
    fn label(&mut self, kind: &str, name: &str, x: f64, y: f64) -> &mut Self {
        let u = self.uuid();
        let shape = if kind == "label" {
            String::new()
        } else {
            " (shape passive)".into()
        };
        self.nodes.push(format!("({kind} \"{name}\"{shape} (at {x} {y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid \"{u}\"))"));
        self
    }
    fn write(&self, dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(format!("{name}.kicad_sch"));
        let mut s = format!(
            "(kicad_sch\n\t(version 20260306)\n\t(generator \"eeschema\")\n\t(generator_version \"10.0\")\n\t(uuid \"{ROOT_UUID}\")\n\t(paper \"A4\")\n\t{}\n",
            fixture_lib_symbols()
        );
        for n in &self.nodes {
            s.push('\t');
            s.push_str(n);
            s.push('\n');
        }
        s.push_str("\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n");
        std::fs::write(&p, s).unwrap();
        std::fs::write(
            dir.join("t.kicad_pro"),
            "{\"meta\":{\"filename\":\"t.kicad_pro\",\"version\":3}}\n",
        )
        .unwrap();
        p
    }
}

// Device:R at rot 0: pin 1 at (x, y-3.81), pin 2 at (x, y+3.81).
const R: &str = "Device:R";

fn nets_by_members(nl: &Netlist) -> BTreeMap<BTreeSet<String>, String> {
    nl.nets
        .iter()
        .map(|n| {
            (
                n.members
                    .iter()
                    .map(|m| format!("{}.{}", m.reference, m.pin))
                    .collect(),
                n.name.clone(),
            )
        })
        .collect()
}

fn net_of<'a>(nl: &'a Netlist, refpin: &str) -> Option<&'a sch_net::Net> {
    let (r, p) = refpin.split_once('.').unwrap();
    nl.nets
        .iter()
        .find(|n| n.members.iter().any(|m| m.reference == r && m.pin == p))
}

fn connected(nl: &Netlist, a: &str, b: &str) -> bool {
    match (net_of(nl, a), net_of(nl, b)) {
        (Some(x), Some(y)) => x.id == y.id,
        _ => false,
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
    None
}

/// `Some(netlist)` from kicad-cli, `None` when the oracle is not installed (skip) — unless
/// `FLUXSMITH_CONFORMANCE=required`, which turns the absence into a failure with a reason.
fn oracle(sch: &Path) -> Option<BTreeMap<BTreeSet<String>, String>> {
    let Some(cli) = kicad_cli() else {
        let required = std::env::var("FLUXSMITH_CONFORMANCE")
            .map(|v| v == "required")
            .unwrap_or(false);
        assert!(!required, "FLUXSMITH_CONFORMANCE=required but kicad-cli was not found (set KICAD_CLI or install KiCad 10; see tests/conformance/env.toml)");
        eprintln!(
            "kicad-cli not installed: oracle comparison skipped for {}",
            sch.display()
        );
        return None;
    };
    let out = sch.with_extension("oracle.net");
    let st = Command::new(cli)
        .args(["sch", "export", "netlist", "--format", "kicadsexpr", "-o"])
        .arg(&out)
        .arg(sch)
        .output()
        .expect("run kicad-cli");
    assert!(
        st.status.success(),
        "kicad-cli failed on {}: {}",
        sch.display(),
        String::from_utf8_lossy(&st.stderr)
    );
    let doc = kicad_sexpr::parse(&std::fs::read_to_string(&out).unwrap()).unwrap();
    let mut m = BTreeMap::new();
    for net in doc.root.find("nets").unwrap().find_all("net") {
        let name = net.find("name").unwrap().arg(0).unwrap();
        let set: BTreeSet<String> = net
            .find_all("node")
            .map(|n| {
                format!(
                    "{}.{}",
                    n.find("ref").unwrap().arg(0).unwrap(),
                    n.find("pin").unwrap().arg(0).unwrap()
                )
            })
            .collect();
        m.insert(set, name);
    }
    Some(m)
}

/// Assert membership parity (every net with >= 2 pins) and naming parity against the oracle.
fn assert_oracle_parity(sch: &Path, nl: &Netlist) {
    let Some(orc) = oracle(sch) else { return };
    let mine = nets_by_members(nl);
    for (members, name) in &orc {
        if members.len() < 2 {
            continue;
        }
        match mine.get(members) {
            Some(n) => assert_eq!(n, name, "{}: name mismatch for {members:?}", sch.display()),
            None => panic!(
                "{}: oracle net {name} {members:?} missing from ours; ours = {mine:?}",
                sch.display()
            ),
        }
    }
    for (members, name) in &mine {
        if members.len() >= 2 {
            assert!(
                orc.contains_key(members),
                "{}: extra net {name} {members:?} not in oracle {orc:?}",
                sch.display()
            );
        }
    }
}

fn build(sch: &Sch, name: &str) -> (tempfile::TempDir, PathBuf, Netlist) {
    let dir = tempfile::tempdir().unwrap();
    let p = sch.write(dir.path(), name);
    let nl = sch_net::nets_of(&p).unwrap();
    (dir, p, nl)
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

#[test]
fn inv_4_net_name_token_escape_is_a_single_source() {
    assert_eq!(sch_net::escape_net_name("A/B"), "A{slash}B");
    // `EscapeString( ..., CTX_NETNAME )` escapes the sheet-path separator and drops
    // line breaks; braces stay as they are (kicad-cli 10.0.4 names a pin `A{B}`
    // net `Net-(U1-A{B})`).
    assert_eq!(sch_net::escape_net_name("{x}"), "{x}");
    assert_eq!(sch_net::escape_net_name("a\nb"), "ab");
    assert_eq!(sch_net::escape_net_name("plain_NET-1"), "plain_NET-1");
    assert!(sch_net::is_named("GND"));
    assert!(!sch_net::is_named("Net-(R1-Pad1)"));
    assert!(!sch_net::is_named("unconnected-(R1-Pad1)"));
    assert!(!sch_net::is_named(""));
}

/// I9 / reg 0.4.0 / reg 0.3.0: a wire (or a pin) touching another wire mid-span without a
/// `(junction)` is NOT connected in eeschema; with the junction it is.
#[test]
fn inv_9_midspan_t_needs_a_junction() {
    // RA at (50.8, 50.8): pin2 at (50.8, 54.61); vertical wire down to (50.8, 70).
    // RB at (63.5, 62.23) rot 90: pins at (59.69, 62.23) and (67.31, 62.23).
    // A horizontal wire from RB.1 to (50.8, 62.23) touches the vertical wire mid-span.
    let mut s = Sch::default();
    s.symbol(R, "RA", 50.8, 50.8, 0)
        .symbol(R, "RB", 63.5, 62.23, 90)
        .wire(50.8, 54.61, 50.8, 70.0)
        .wire(59.69, 62.23, 50.8, 62.23)
        // keep the far ends non-dangling so the oracle does not prune them
        .symbol(R, "RC", 50.8, 73.81, 0)
        .symbol(R, "RD", 71.12, 62.23, 90);
    let (_d, p, nl) = build(&s, "t_nojunction");
    assert!(
        !connected(&nl, "RA.2", "RB.1"),
        "mid-span touch without junction must not connect: {:?}",
        nets_by_members(&nl)
    );
    assert!(connected(&nl, "RA.2", "RC.1"));
    assert_oracle_parity(&p, &nl);

    let mut s2 = Sch::default();
    s2.symbol(R, "RA", 50.8, 50.8, 0)
        .symbol(R, "RB", 63.5, 62.23, 90)
        .wire(50.8, 54.61, 50.8, 70.0)
        .wire(59.69, 62.23, 50.8, 62.23)
        .junction(50.8, 62.23)
        .symbol(R, "RC", 50.8, 73.81, 0)
        .symbol(R, "RD", 71.12, 62.23, 90);
    let (_d, p, nl) = build(&s2, "t_junction");
    assert!(
        connected(&nl, "RA.2", "RB.1"),
        "junction connects the T: {:?}",
        nets_by_members(&nl)
    );
    assert_oracle_parity(&p, &nl);
}

/// reg 0.3.0: a pin sitting on a wire mid-span (not at an endpoint) also needs a junction.
#[test]
fn reg_pin_tap_on_wire_midspan_needs_junction() {
    // vertical wire (50.8, 40) -> (50.8, 70) between RA.2 (at 50.8,40 via RA at y=36.19) and RC.1;
    // RB rot 90 at (54.61, 55): pin1 at (50.8, 55) lands on the wire mid-span.
    let mut s = Sch::default();
    s.symbol(R, "RA", 50.8, 36.19, 0)
        .symbol(R, "RC", 50.8, 73.81, 0)
        .wire(50.8, 40.0, 50.8, 70.0)
        .symbol(R, "RB", 54.61, 55.0, 90)
        .symbol(R, "RD", 62.23, 55.0, 90);
    let (_d, p, nl) = build(&s, "t_pintap");
    assert!(
        !connected(&nl, "RA.2", "RB.1"),
        "{:?}",
        nets_by_members(&nl)
    );
    assert_oracle_parity(&p, &nl);
    s.junction(50.8, 55.0);
    let (_d, p, nl) = build(&s, "t_pintap_j");
    assert!(connected(&nl, "RA.2", "RB.1"), "{:?}", nets_by_members(&nl));
    assert_oracle_parity(&p, &nl);
}

/// I10 / reg 0.4.0: a local label merges with a same-named global or power net on the same
/// sheet, and two same-named local labels on different sheets are different nets.
#[test]
fn inv_10_local_label_merges_same_sheet_globals_only() {
    let mut s = Sch::default();
    // wire A: RA.2 -> RB.1 carries local label "GND" ; separate wire C: RC.2 -> GND power port
    s.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .wire(30.0, 33.81, 30.0, 41.19)
        .label("label", "GND", 30.0, 37.0)
        .symbol(R, "RC", 60.0, 30.0, 0)
        .symbol("power:GND", "#PWR01", 60.0, 40.0, 0)
        .wire(60.0, 33.81, 60.0, 40.0)
        // wire E: RE.2 -> RF.1 with local label "GLB"; wire G: RG.2 -> RH.1 with global label "GLB"
        .symbol(R, "RE", 90.0, 30.0, 0)
        .symbol(R, "RF", 90.0, 45.0, 0)
        .wire(90.0, 33.81, 90.0, 41.19)
        .label("label", "GLB", 90.0, 37.0)
        .symbol(R, "RG", 120.0, 30.0, 0)
        .symbol(R, "RH", 120.0, 45.0, 0)
        .wire(120.0, 33.81, 120.0, 41.19)
        .label("global_label", "GLB", 120.0, 37.0)
        // wire I: local "ONLY" on its own
        .symbol(R, "RI", 150.0, 30.0, 0)
        .symbol(R, "RJ", 150.0, 45.0, 0)
        .wire(150.0, 33.81, 150.0, 41.19)
        .label("label", "ONLY", 150.0, 37.0);
    let (_d, p, nl) = build(&s, "t_labels");
    assert!(
        connected(&nl, "RA.2", "RC.2"),
        "local GND label merges with the GND power net: {:?}",
        nets_by_members(&nl)
    );
    assert_eq!(net_of(&nl, "RA.2").unwrap().name, "GND");
    assert!(
        connected(&nl, "RE.2", "RG.2"),
        "local GLB merges with global GLB on the same sheet"
    );
    assert_eq!(net_of(&nl, "RE.2").unwrap().name, "GLB");
    assert_eq!(
        net_of(&nl, "RI.2").unwrap().name,
        "/ONLY",
        "root-sheet local label is sheet-scoped"
    );
    assert_eq!(net_of(&nl, "RI.2").unwrap().scope, NetScope::Local);
    assert_oracle_parity(&p, &nl);

    // cross-sheet: the conformance hierarchy has local "MID" in the child; a root-level local
    // "MID" must not merge with it.
    let dir = tempfile::tempdir().unwrap();
    let fx =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures/hier");
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fx.join(f), dir.path().join(f)).unwrap();
    }
    let root = dir.path().join("hier_root.kicad_sch");
    let src = std::fs::read_to_string(&root).unwrap();
    // The +3V3 wire in the root, (50.8 45.72)-(50.8 46.99), only reaches R1.1; tag it with a
    // local label "MID" (the child sheet has its own local "MID" on R3.2).
    let patched = src.replace("\t(sheet_instances", "\t(label \"MID\" (at 50.8 46.5 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid \"bbbbbbbb-bbbb-4bbb-8bbb-000000000777\"))\n\t(sheet_instances");
    std::fs::write(&root, patched).unwrap();
    let nl = sch_net::nets_of(&root).unwrap();
    let names: Vec<(String, Vec<String>)> = nl
        .nets
        .iter()
        .map(|n| {
            (
                n.name.clone(),
                n.members
                    .iter()
                    .map(|m| format!("{}{}.{}", m.sheet, m.reference, m.pin))
                    .collect(),
            )
        })
        .collect();
    let root_mid = nl
        .nets
        .iter()
        .find(|n| {
            n.members
                .iter()
                .any(|m| m.reference == "R1" && m.pin == "1")
        })
        .unwrap();
    let child_mid = nl
        .nets
        .iter()
        .find(|n| n.name == "/child/MID")
        .unwrap_or_else(|| panic!("child local net keeps its sheet-scoped name: {names:?}"));
    assert_ne!(
        root_mid.id, child_mid.id,
        "same-named local labels on different sheets must not merge: {names:?}"
    );
    assert_eq!(root_mid.name, "+3V3");
    assert!(root_mid.labels.contains("MID"));
    assert_oracle_parity(&root, &nl);
}

/// I11 / reg 0.4.0: PWR_FLAG never names a net and never merges rails.
#[test]
fn inv_11_pwr_flag_never_names_or_merges() {
    let mut s = Sch::default();
    s.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol("power:GND", "#PWR01", 30.0, 40.0, 0)
        .wire(30.0, 33.81, 30.0, 40.0)
        .symbol("power:PWR_FLAG", "#FLG01", 30.0, 40.0, 0)
        .symbol(R, "RB", 60.0, 30.0, 0)
        .symbol("power:+3V3", "#PWR02", 60.0, 20.0, 0)
        .wire(60.0, 26.19, 60.0, 20.0)
        .symbol("power:PWR_FLAG", "#FLG02", 60.0, 20.0, 0);
    let (_d, p, nl) = build(&s, "t_flags");
    let gnd = net_of(&nl, "RA.2").unwrap();
    let v33 = net_of(&nl, "RB.1").unwrap();
    assert_eq!((gnd.name.as_str(), v33.name.as_str()), ("GND", "+3V3"));
    assert_ne!(gnd.id, v33.id, "two PWR_FLAGs must not short the rails");
    assert!(gnd.flagged && v33.flagged);
    assert!(nl.nets.iter().all(|n| n.name != "PWR_FLAG"));
    assert_oracle_parity(&p, &nl);
}

/// I12: naming follows the driver-priority ladder (power > global > hierarchical > local).
#[test]
fn inv_12_driver_priority_ladder() {
    let mut s = Sch::default();
    // power + local: named by the power port
    s.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol("power:+3V3", "#PWR01", 30.0, 20.0, 0)
        .wire(30.0, 26.19, 30.0, 20.0)
        .label("label", "AAA_LOCAL", 30.0, 23.0)
        // global + local: named by the global label
        .symbol(R, "RB", 60.0, 30.0, 0)
        .symbol(R, "RC", 60.0, 45.0, 0)
        .wire(60.0, 33.81, 60.0, 41.19)
        .label("label", "AAA_LOCAL2", 60.0, 36.0)
        .label("global_label", "ZZZ_GLOBAL", 60.0, 39.0)
        // two locals: alphabetical (KiCad picks the lexically first)
        .symbol(R, "RD", 90.0, 30.0, 0)
        .symbol(R, "RE", 90.0, 45.0, 0)
        .wire(90.0, 33.81, 90.0, 41.19)
        .label("label", "ZED", 90.0, 36.0)
        .label("label", "ALPHA", 90.0, 39.0);
    let (_d, p, nl) = build(&s, "t_ladder");
    assert_eq!(net_of(&nl, "RA.1").unwrap().name, "+3V3");
    assert_eq!(net_of(&nl, "RB.2").unwrap().name, "ZZZ_GLOBAL");
    assert_eq!(net_of(&nl, "RD.2").unwrap().name, "/ALPHA");
    assert_oracle_parity(&p, &nl);
}

/// I13: the net id is the membership hash — renaming a label keeps it.
#[test]
fn inv_13_net_id_is_membership_hash() {
    let mut a = Sch::default();
    a.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .wire(30.0, 33.81, 30.0, 41.19)
        .label("label", "ONE", 30.0, 37.0);
    let mut b = Sch::default();
    b.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .wire(30.0, 33.81, 30.0, 41.19)
        .label("label", "TWO", 30.0, 37.0);
    let (_d1, _, na) = build(&a, "t_a");
    let (_d2, _, nb) = build(&b, "t_b");
    let x = net_of(&na, "RA.2").unwrap();
    let y = net_of(&nb, "RA.2").unwrap();
    assert_ne!(x.name, y.name);
    assert_eq!(x.id, y.id, "same members => same id regardless of name");
    assert_eq!(x.id, net_id(&x.members));
    for n in &na.nets {
        assert_eq!(n.id, net_id(&n.members));
    }
}

/// I14: netdiff pairs nets by pin membership, not by name; risk only for named nets.
#[test]
fn inv_14_netdiff_by_membership_risk_only_named() {
    let mut base = Sch::default();
    base.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .wire(30.0, 33.81, 30.0, 41.19)
        .label("label", "ONE", 30.0, 37.0)
        .symbol(R, "RC", 60.0, 30.0, 0)
        .symbol(R, "RD", 60.0, 45.0, 0)
        .wire(60.0, 33.81, 60.0, 41.19);
    let (_d, _, before) = build(&base, "t_before");

    // rename only
    let mut renamed = Sch::default();
    renamed
        .symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .wire(30.0, 33.81, 30.0, 41.19)
        .label("label", "TWO", 30.0, 37.0)
        .symbol(R, "RC", 60.0, 30.0, 0)
        .symbol(R, "RD", 60.0, 45.0, 0)
        .wire(60.0, 33.81, 60.0, 41.19);
    let (_d, _, after) = build(&renamed, "t_renamed");
    let d = diff_nets(&before, &after);
    assert!(
        d.changes.iter().any(
            |c| matches!(c, NetChange::Renamed { from, to } if from == "/ONE" && to == "/TWO")
        ),
        "{:?}",
        d.changes
    );
    assert!(
        !d.has_risk,
        "a rename is not a split/merge: {:?}",
        d.changes
    );

    // split the named net (drop the wire): risk
    let mut split = Sch::default();
    split
        .symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .label("label", "ONE", 30.0, 33.81)
        .symbol(R, "RC", 60.0, 30.0, 0)
        .symbol(R, "RD", 60.0, 45.0, 0)
        .wire(60.0, 33.81, 60.0, 41.19);
    let (_d, _, after) = build(&split, "t_split");
    let d = diff_nets(&before, &after);
    assert!(
        d.has_risk,
        "splitting a named net is a risk: {:?}",
        d.changes
    );

    // split the unnamed net: no risk
    let mut split_unnamed = Sch::default();
    split_unnamed
        .symbol(R, "RA", 30.0, 30.0, 0)
        .symbol(R, "RB", 30.0, 45.0, 0)
        .wire(30.0, 33.81, 30.0, 41.19)
        .label("label", "ONE", 30.0, 37.0)
        .symbol(R, "RC", 60.0, 30.0, 0)
        .symbol(R, "RD", 60.0, 45.0, 0);
    let (_d, _, after) = build(&split_unnamed, "t_split_unnamed");
    let d = diff_nets(&before, &after);
    assert!(
        !d.has_risk,
        "splitting an unnamed net is not a risk: {:?}",
        d.changes
    );
}

/// I25: same input, same netlist bytes.
#[test]
fn inv_25_netlist_is_deterministic() {
    let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch");
    let a = serde_json::to_string(&sch_net::nets_of(&fx).unwrap()).unwrap();
    let b = serde_json::to_string(&sch_net::nets_of(&fx).unwrap()).unwrap();
    assert_eq!(a, b);
    let nl = sch_net::nets_of(&fx).unwrap();
    let names: Vec<&str> = nl.nets.iter().map(|n| n.name.as_str()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "nets are emitted in a sorted, stable order");
}

/// reg 0.4.0: unnamed nets carry a string name (never null / empty).
#[test]
fn reg_unnamed_net_name_is_a_nonempty_string() {
    let mut s = Sch::default();
    s.symbol(R, "RC", 60.0, 30.0, 0)
        .symbol(R, "RD", 60.0, 45.0, 0)
        .wire(60.0, 33.81, 60.0, 41.19);
    let (_d, p, nl) = build(&s, "t_unnamed");
    let n = net_of(&nl, "RC.2").unwrap();
    assert!(n.name.starts_with("Net-("), "{}", n.name);
    assert_eq!(n.scope, NetScope::Unnamed);
    let v: serde_json::Value = serde_json::to_value(&nl).unwrap();
    for net in v["nets"].as_array().unwrap() {
        assert!(
            net["name"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
            "{net}"
        );
    }
    assert_oracle_parity(&p, &nl);
}

/// reg 0.2.0: netlist names are sheet-scoped (`/child/MID`), globals are not.
#[test]
fn reg_net_names_are_sheet_scoped() {
    let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/fixtures/hier/hier_root.kicad_sch");
    let nl = sch_net::nets_of(&fx).unwrap();
    let names: BTreeSet<&str> = nl.nets.iter().map(|n| n.name.as_str()).collect();
    assert!(names.contains("/child/MID"), "{names:?}");
    assert!(
        names.contains("GLB") && names.contains("GND") && names.contains("+3V3"),
        "{names:?}"
    );
    assert!(names.iter().all(|n| !n.starts_with("//")));
}

/// reg 0.19.0: mirroring a symmetric two-pin part swaps which pin sits on which net; the net
/// engine must see the swap (the diff engine then flags it).
#[test]
fn reg_mirror_swaps_pins_of_symmetric_parts_visibly() {
    let mut a = Sch::default();
    a.symbol(R, "RA", 30.0, 30.0, 0)
        .symbol("power:+3V3", "#PWR01", 30.0, 26.19, 0)
        .symbol("power:GND", "#PWR02", 30.0, 33.81, 0);
    let (_d, _, before) = build(&a, "t_m0");
    let mut b = Sch::default();
    b.symbol_m(R, "RA", 30.0, 30.0, 0, "x")
        .symbol("power:+3V3", "#PWR01", 30.0, 26.19, 0)
        .symbol("power:GND", "#PWR02", 30.0, 33.81, 0);
    let (_d, _, after) = build(&b, "t_m1");
    assert_eq!(net_of(&before, "RA.1").unwrap().name, "+3V3");
    assert_eq!(
        net_of(&after, "RA.1").unwrap().name,
        "GND",
        "mirror x flips the resistor"
    );
    let d = diff_nets(&before, &after);
    assert!(
        d.has_risk
            || d.changes
                .iter()
                .any(|c| matches!(c, NetChange::MembersChanged { .. })),
        "{:?}",
        d.changes
    );
}

/// reg (found 2026-08-30 by inv_22): a local label on a child sheet merges with the same-named
/// global label on that child sheet even when another sheet also carries that global label.
#[test]
fn reg_local_label_merges_global_on_child_sheet_too() {
    let dir = tempfile::tempdir().unwrap();
    let fx =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures/hier");
    for f in [
        "hier_root.kicad_sch",
        "hier_child.kicad_sch",
        "hier.kicad_pro",
    ] {
        std::fs::copy(fx.join(f), dir.path().join(f)).unwrap();
    }
    let child = dir.path().join("hier_child.kicad_sch");
    let src = std::fs::read_to_string(&child).unwrap();
    // the child wire (45.72 50.8)-(53.34 50.8) carries local MID; add a local "GLB" there
    let patched = src.replace("\n\t(embedded_fonts no)\n)", "\n\t(label \"GLB\" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid \"bbbbbbbb-bbbb-4bbb-8bbb-000000000778\"))\n\t(embedded_fonts no)\n)");
    assert_ne!(patched, src, "fixture patched");
    std::fs::write(&child, patched).unwrap();
    let root = dir.path().join("hier_root.kicad_sch");
    let nl = sch_net::nets_of(&root).unwrap();
    let glb = nl.by_name("GLB").unwrap();
    let refs: Vec<String> = glb
        .members
        .iter()
        .map(|m| format!("{}{}.{}", m.sheet, m.reference, m.pin))
        .collect();
    assert!(
        refs.contains(&"/child/R3.2".to_string()),
        "local GLB in the child joins the global GLB net: {refs:?}"
    );
    assert!(
        nl.nets.iter().all(|n| n.name != "/child/GLB"),
        "{:?}",
        nl.nets.iter().map(|n| &n.name).collect::<Vec<_>>()
    );
    assert_oracle_parity(&root, &nl);
}
