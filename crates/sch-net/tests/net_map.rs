// SPDX-License-Identifier: Apache-2.0
//! `build_nets_with_map`: every wire / label item maps to the net its endpoints belong to,
//! and the map never changes the netlist itself.

use std::path::PathBuf;

fn fixture(rel: &str) -> sch_read::SheetTree {
    let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures");
    sch_read::read_project(&fx.join(rel)).unwrap()
}

fn hier() -> sch_read::SheetTree {
    fixture("hier/hier_root.kicad_sch")
}

#[test]
fn netlist_is_unchanged_by_the_map() {
    let tree = hier();
    let plain = serde_json::to_string(&sch_net::build_nets(&tree)).unwrap();
    let (with, _) = sch_net::build_nets_with_map(&tree);
    assert_eq!(plain, serde_json::to_string(&with).unwrap());
}

#[test]
fn wires_and_labels_map_to_their_pins_net() {
    let tree = hier();
    let (nets, map) = sch_net::build_nets_with_map(&tree);
    let pin_map = nets.pin_map();
    let mut checked = 0usize;
    for inst in &tree.instances {
        let sheet = tree.files.get(&inst.file).expect("sheet file");
        let wires = map.wires.get(&inst.path).cloned().unwrap_or_default();
        let labels = map.labels.get(&inst.path).cloned().unwrap_or_default();
        // every wire on this sheet that touches a pin: the mapped net must equal that pin's net
        for w in &sheet.wires {
            let Some(net) = wires.get(&w.uuid) else {
                continue;
            };
            for sym in &sheet.symbols {
                let Some(lib) = sheet.lib_symbol(&sym.lib_id) else {
                    continue;
                };
                for wp in sch_model::world_pins(sym, lib) {
                    if wp.at == w.a || wp.at == w.b {
                        let key = sch_net::NetMember {
                            sheet: inst.names.clone(),
                            reference: sym.reference.clone(),
                            pin: wp.number.clone(),
                            pin_type: wp.kind.as_str().to_string(),
                        };
                        if let Some(pn) = pin_map.get(&key) {
                            assert_eq!(
                                pn, net,
                                "wire {} on {} vs pin {}.{}",
                                w.uuid, inst.names, sym.reference, wp.number
                            );
                            checked += 1;
                        }
                    }
                }
            }
        }
        // every label maps to a net that lists that label text
        for l in &sheet.labels {
            let Some(net) = labels.get(&l.uuid) else {
                continue;
            };
            let n = nets.by_name(net).expect("label net exists");
            assert!(n.labels.contains(&l.text), "label {} -> {}", l.text, net);
            checked += 1;
        }
    }
    assert!(checked >= 4, "fixture should exercise the map ({checked})");
}

#[test]
fn sheet_pins_map_to_the_net_of_the_wire_they_touch() {
    let tree = hier();
    let (nets, map) = sch_net::build_nets_with_map(&tree);
    let mut checked = 0usize;
    for inst in &tree.instances {
        let sheet = tree.files.get(&inst.file).expect("sheet file");
        let wires = map.wires.get(&inst.path).cloned().unwrap_or_default();
        let pins = map.sheet_pins.get(&inst.path).cloned().unwrap_or_default();
        for sh in &sheet.sheets {
            for p in &sh.pins {
                let Some(net) = pins.get(&p.uuid) else {
                    continue;
                };
                // The net is a real net, and any wire ending on the pin carries the same one.
                assert!(nets.by_name(net).is_some(), "sheet pin net {net} exists");
                for w in &sheet.wires {
                    if w.a == p.at || w.b == p.at {
                        if let Some(wn) = wires.get(&w.uuid) {
                            assert_eq!(wn, net, "sheet pin {} vs wire {}", p.name, w.uuid);
                        }
                    }
                }
                checked += 1;
            }
        }
    }
    assert!(
        checked >= 2,
        "fixture should exercise sheet pins ({checked})"
    );
}

/// The canvas reads a junction's net out of the map; it must never have to guess one from geometry.
#[test]
fn junctions_map_to_the_net_of_the_wires_they_join() {
    let tree = fixture("synth/synth20.kicad_sch");
    let (nets, map) = sch_net::build_nets_with_map(&tree);
    let mut checked = 0usize;
    for inst in &tree.instances {
        let sheet = tree.files.get(&inst.file).expect("sheet file");
        let wires = map.wires.get(&inst.path).cloned().unwrap_or_default();
        let junctions = map.junctions.get(&inst.path).cloned().unwrap_or_default();
        for j in &sheet.junctions {
            let net = junctions
                .get(&j.uuid)
                .unwrap_or_else(|| panic!("junction {} has no net", j.uuid));
            assert!(nets.by_name(net).is_some(), "junction net {net} exists");
            // Every wire ending on the junction is on that same net (same DSU, no second answer).
            for w in &sheet.wires {
                if w.a == j.at || w.b == j.at {
                    if let Some(wn) = wires.get(&w.uuid) {
                        assert_eq!(wn, net, "junction {} vs wire {}", j.uuid, w.uuid);
                    }
                }
            }
            checked += 1;
        }
    }
    assert!(checked >= 4, "fixture should have junctions ({checked})");
}

/// A no-connect flag is on the net of the pin it sits on, and the map names it by uuid.
#[test]
fn no_connects_map_to_the_net_of_their_pin() {
    let tree = fixture("naming/nc2pin.kicad_sch");
    let (nets, map) = sch_net::build_nets_with_map(&tree);
    let mut checked = 0usize;
    for inst in &tree.instances {
        let sheet = tree.files.get(&inst.file).expect("sheet file");
        let ncs = map.no_connects.get(&inst.path).cloned().unwrap_or_default();
        for nc in &sheet.no_connects {
            let net = ncs
                .get(&nc.uuid)
                .unwrap_or_else(|| panic!("no-connect {} has no net", nc.uuid));
            let n = nets.by_name(net).expect("no-connect net exists");
            assert!(n.no_connect, "net {net} is flagged no-connect");
            checked += 1;
        }
    }
    assert!(checked >= 1, "fixture should have a no-connect ({checked})");
}
