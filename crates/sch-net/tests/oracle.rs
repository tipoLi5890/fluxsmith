// SPDX-License-Identifier: Apache-2.0
//! Parity against `kicad-cli sch export netlist` (the oracle).
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// name -> set of "REF.PIN" from a kicadsexpr netlist
fn oracle_nets(sch: &Path) -> Option<BTreeMap<String, BTreeSet<String>>> {
    let cli = kicad_cli()?;
    let out = std::env::temp_dir().join(format!(
        "fluxsmith-oracle-{}-{}-{:?}.net",
        std::process::id(),
        sch.file_stem().unwrap().to_string_lossy(),
        std::thread::current().id()
    ));
    let st = Command::new(cli)
        .args(["sch", "export", "netlist", "--format", "kicadsexpr", "-o"])
        .arg(&out)
        .arg(sch)
        .output()
        .ok()?;
    if !st.status.success() {
        return None;
    }
    let src = std::fs::read_to_string(&out).ok()?;
    let doc = kicad_sexpr::parse(&src).ok()?;
    let mut m = BTreeMap::new();
    for net in doc.root.find("nets")?.find_all("net") {
        let name = net.find("name")?.arg(0)?;
        let mut set = BTreeSet::new();
        for node in net.find_all("node") {
            set.insert(format!(
                "{}.{}",
                node.find("ref")?.arg(0)?,
                node.find("pin")?.arg(0)?
            ));
        }
        m.insert(name, set);
    }
    Some(m)
}

fn ours(sch: &Path) -> BTreeMap<String, BTreeSet<String>> {
    let nl = sch_net::nets_of(sch).unwrap();
    nl.nets
        .into_iter()
        .map(|n| {
            (
                n.name,
                n.members
                    .into_iter()
                    .map(|m| format!("{}.{}", m.reference, m.pin))
                    .collect(),
            )
        })
        .collect()
}

fn compare(sch: &Path) {
    let Some(oracle) = oracle_nets(sch) else {
        let required = std::env::var("FLUXSMITH_CONFORMANCE")
            .map(|v| v == "required")
            .unwrap_or(false);
        assert!(!required, "FLUXSMITH_CONFORMANCE=required but kicad-cli is unavailable for {} (install KiCad 10 or set KICAD_CLI; tests/conformance/env.toml)", sch.display());
        eprintln!("oracle unavailable, skipping");
        return;
    };
    let mine = ours(sch);
    if mine == oracle {
        return;
    }
    // Name *and* membership parity. Keyed by name, because two nets can legitimately
    // carry the same members (a multi-unit symbol's common pin is one subgraph per
    // placed unit, and the netlist cannot tell the two nodes apart).
    let mut problems = Vec::new();
    for (name, members) in &oracle {
        match mine.get(name) {
            Some(m) if m == members => {}
            Some(m) => problems.push(format!(
                "members differ for {name}: oracle={members:?} ours={m:?}"
            )),
            None => match mine.iter().find(|(_, m)| *m == members) {
                Some((other, _)) => problems.push(format!(
                    "name mismatch for {members:?}: oracle={name} ours={other}"
                )),
                None => problems.push(format!("missing net {name} {members:?}")),
            },
        }
    }
    for (name, members) in &mine {
        if !oracle.contains_key(name) {
            problems.push(format!("extra net {name} {members:?}"));
        }
    }
    if problems.is_empty() {
        problems.push(format!("oracle={oracle:?}\nours={mine:?}"));
    }
    assert!(
        problems.is_empty(),
        "{}:\n{}",
        sch.display(),
        problems.join("\n")
    );
}

/// Compares against any extra `.kicad_sch` files the developer points at with
/// `FLUXSMITH_EXTRA_FIXTURES=/path/a:/path/b`. Skipped when the variable is unset.
#[test]
fn parity_extra_fixtures() {
    for dir in extra_fixture_dirs() {
        for f in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "kicad_sch") {
                compare(&p);
            }
        }
    }
}

fn extra_fixture_dirs() -> Vec<PathBuf> {
    std::env::var("FLUXSMITH_EXTRA_FIXTURES")
        .ok()
        .map(|v| {
            v.split(':')
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures")
}

#[test]
fn parity_repo_fixtures() {
    let root = fixtures();
    compare(&root.join("hier/hier_root.kicad_sch"));
    compare(&root.join("sch/minimal.kicad_sch"));
    // A bus crossing a hierarchical sheet pin (vector and group buses), and the
    // negative control where the parent bus label and the sheet pin name differ.
    compare(&root.join("bus_hier/hbusvec_root.kicad_sch"));
    compare(&root.join("bus_hier/hbusgrp_root.kicad_sch"));
    compare(&root.join("bus_hier/hbusren_root.kicad_sch"));
    // `(power local)` symbols: per sheet instance, sheet-path-qualified name.
    compare(&root.join("local_power/twicelocal_root.kicad_sch"));
    compare(&root.join("local_power/localprio_root.kicad_sch"));
    // Legacy invisible power pins on a non-power symbol.
    compare(&root.join("multi_unit/multiunit.kicad_sch"));
    // Auto-generated names: pin names, `candidate_cmp`, the `unconnected-` trigger,
    // `EscapeString( ..., CTX_NETNAME )` and multi-unit common pins.
    compare(&root.join("naming/named.kicad_sch"));
    compare(&root.join("naming/common0.kicad_sch"));
    compare(&root.join("naming/nc2pin.kicad_sch"));
    compare(&root.join("naming/midpin.kicad_sch"));
    compare(&root.join("naming/escname.kicad_sch"));
}

/// name -> sorted "REF.PIN" members, from our own netbuild.
fn nets_of(rel: &str) -> BTreeMap<String, Vec<String>> {
    ours(&fixtures().join(rel))
        .into_iter()
        .map(|(k, v)| (k, v.into_iter().collect()))
        .collect()
}

fn members(nets: &BTreeMap<String, Vec<String>>, name: &str) -> Vec<String> {
    nets.get(name)
        .unwrap_or_else(|| panic!("no net {name} in {:?}", nets.keys().collect::<Vec<_>>()))
        .clone()
}

/// I26: a bus wire and a hierarchical sheet pin whose name is a bus name connect
/// at a shared point, so bus members cross the sheet boundary.
#[test]
fn inv_bus_crosses_a_hierarchical_sheet_pin() {
    let nets = nets_of("bus_hier/hbusvec_root.kicad_sch");
    assert_eq!(members(&nets, "/D0"), ["R1.1", "R10.1"]);
    let nets = nets_of("bus_hier/hbusgrp_root.kicad_sch");
    assert_eq!(members(&nets, "/USB.DP"), ["R1.1", "R10.1"]);
    // Negative control: the parent bus is labelled Q[0..7] while the sheet pin is
    // D[0..7]; eeschema does not translate members across that mismatch.
    let nets = nets_of("bus_hier/hbusren_root.kicad_sch");
    assert_eq!(members(&nets, "/Q0"), ["R1.1"]);
    assert_eq!(members(&nets, "/ch/D0"), ["R10.1"]);
}

/// I27: `(power local)` symbols merge per sheet instance and their net name
/// carries the instance names path; `(power global)` still merges project-wide.
#[test]
fn inv_local_power_symbols_are_sheet_scoped() {
    let nets = nets_of("local_power/twicelocal_root.kicad_sch");
    assert_eq!(members(&nets, "/ampA/VLOC"), ["R1.2"]);
    assert_eq!(members(&nets, "/ampB/VLOC"), ["R2.2"]);
    assert_eq!(members(&nets, "GND"), ["R1.1", "R2.1"]);
    assert!(
        !nets.contains_key("VLOC"),
        "local power must not merge globally"
    );
    // Two same-named local power symbols on one sheet instance connect without a
    // wire, and the local power name outranks a local label on the same net.
    let nets = nets_of("local_power/localprio_root.kicad_sch");
    assert_eq!(members(&nets, "/ampA/VLOC"), ["R1.2", "R2.2"]);
    assert!(!nets.contains_key("/ampA/ZZZ"));
}

/// I28: a hidden `power_in` pin on a symbol that is not a power symbol is
/// KiCad's legacy implicit global power pin, named after the pin.
#[test]
fn inv_invisible_power_pins_connect_by_name() {
    let nets = nets_of("multi_unit/multiunit.kicad_sch");
    assert_eq!(members(&nets, "V+"), ["A1.8"]);
    assert_eq!(members(&nets, "V-"), ["A1.4"]);
    assert!(
        nets.keys().all(|n| !n.starts_with("unconnected-(A1-V")),
        "invisible power pins must not stay unconnected: {:?}",
        nets.keys().collect::<Vec<_>>()
    );
}

/// I29: an auto-generated name comes from `SCH_PIN::GetDefaultNetName` -- the pin
/// name when it is neither empty nor the pin number, `-Pad<n>` otherwise -- and
/// `CONNECTION_SUBGRAPH::ResolveDrivers` picks between the pins of the subgraph with
/// `candidate_cmp`: a candidate containing "-Pad" sorts last, then the
/// lexicographically smallest wins.
#[test]
fn inv_auto_names_use_the_pin_name_and_candidate_order() {
    let nets = nets_of("naming/named.kicad_sch");
    // The named pin beats the resistor's `-Pad` candidate, whatever the reference.
    assert_eq!(members(&nets, "Net-(U1-VOUT)"), ["R1.2", "U1.1"]);
    // `/` in a pin name is escaped.
    assert_eq!(members(&nets, "Net-(U1-OUT{slash}N)"), ["R2.2", "U1.2"]);
    // A pin whose name is its number has no usable name: both candidates are
    // low quality, so the lexicographically smallest wins.
    assert_eq!(members(&nets, "Net-(R3-Pad2)"), ["R3.2", "U1.3"]);
    // Two pins of one symbol showing the same name append `-Pad<n>` (KiCad's
    // `has_multiple`); the tie is then lexicographic again.
    assert_eq!(members(&nets, "Net-(U1-DUP-Pad4)"), ["U1.4", "Z1.2"]);
    assert_eq!(members(&nets, "Net-(U1-DUP-Pad5)"), ["U1.5", "Z2.2"]);
    // An empty pin name uses the pad form, a literal `~` is a name like any other.
    assert_eq!(members(&nets, "unconnected-(R1-Pad1)"), ["R1.1"]);
    assert_eq!(members(&nets, "unconnected-(Z1-~-Pad1)"), ["Z1.1"]);
}

/// I30: `unconnected-(...)` is used when the subgraph carries a no-connect, when the
/// pin is a `no_connect` pin, or when the subgraph holds a single pin; a
/// `no_connect` pin propagates connection to nothing
/// (`SCH_PIN::ConnectionPropagatesTo`).
#[test]
fn inv_unconnected_names_follow_no_connects() {
    let nets = nets_of("naming/nc2pin.kicad_sch");
    // Two pins on one wire: the no-connect marker still makes the net unconnected.
    assert_eq!(members(&nets, "unconnected-(R1-~-Pad1)"), ["R1.1", "R2.1"]);
    // The `no_connect` pin is a net of its own, and the wire it sits on is not
    // connected to it.
    assert_eq!(members(&nets, "unconnected-(U1-NCP-Pad1)"), ["U1.1"]);
    assert_eq!(members(&nets, "unconnected-(R3-~-Pad1)"), ["R3.1"]);
    // A pin on a wire interior without a junction is a subgraph of one pin.
    let nets = nets_of("naming/midpin.kicad_sch");
    assert_eq!(members(&nets, "unconnected-(R1-~-Pad1)"), ["R1.1"]);
    assert_eq!(members(&nets, "unconnected-(R2-~-Pad1)"), ["R2.1"]);
}

/// I30b: every driver name goes through `EscapeString( ..., CTX_NETNAME )`, which
/// escapes `/` and nothing else.
#[test]
fn inv_net_names_are_escaped_everywhere() {
    let nets = nets_of("naming/escname.kicad_sch");
    assert_eq!(members(&nets, "/BUS{slash}CLK"), ["R1.1"]); // local label
    assert_eq!(members(&nets, "G{slash}H"), ["R2.1"]); // global label
    assert_eq!(members(&nets, "P{slash}Q"), ["R3.1"]); // power symbol value
    assert_eq!(members(&nets, "V{slash}W"), ["X1.9"]); // invisible power pin
    assert_eq!(members(&nets, "Net-(U1-A{B})"), ["R4.2", "U1.1"]); // braces stay
}

/// I31: a common (`<name>_0_1`) pin is exposed by every placed unit, so the named
/// form carries the unit token (`LIB_SYMBOL::SubReference`) and the two nets stay
/// apart; every net name is unique.
#[test]
fn inv_multi_unit_common_pins_carry_the_unit_token() {
    let nets = nets_of("naming/common0.kicad_sch");
    assert_eq!(members(&nets, "unconnected-(A1A-V+-Pad8)"), ["A1.8"]);
    assert_eq!(members(&nets, "unconnected-(A1B-V+-Pad8)"), ["A1.8"]);
    assert_eq!(members(&nets, "unconnected-(A1A-V--Pad4)"), ["A1.4"]);
    assert_eq!(members(&nets, "unconnected-(A1B-V--Pad4)"), ["A1.4"]);
    assert_eq!(members(&nets, "unconnected-(A1A-OUT-Pad1)"), ["A1.1"]);
    assert_eq!(members(&nets, "unconnected-(A1B-OUT-Pad7)"), ["A1.7"]);
    assert_eq!(nets.len(), 10, "{:?}", nets.keys().collect::<Vec<_>>());
    // `nets_of` is keyed by name: 10 keys means no net was lost to a name clash.
    let nl = sch_net::nets_of(&fixtures().join("naming/common0.kicad_sch")).unwrap();
    assert_eq!(nl.nets.len(), 10);
}
