// SPDX-License-Identifier: Apache-2.0
//! Checks beyond the write gates: ERC-lite, power, pinmap, project-level
//! audits, BOM-lite, and intent (known-good) regression.

pub mod pin_matrix;

use sch_model::*;
use sch_net::{NetScope, Netlist};
use sch_read::SheetTree;
use sch_write::gates::{Finding, Severity};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

fn f(code: &str, sev: Severity, msg: impl Into<String>, sheet: &str, location: String) -> Finding {
    Finding {
        code: code.into(),
        severity: sev,
        message: msg.into(),
        sheet: Some(sheet.into()),
        file: None,
        refs: vec![],
        at_mil: None,
        remediation: None,
        evidence: Default::default(),
        location,
    }
}

/// Rail name heuristics used by ERC-lite when no `fluxsmith.toml` rails are given.
pub fn looks_like_rail(name: &str) -> bool {
    sch_model::looks_like_rail(name)
}

/// ERC-lite: pin-type conflicts and undriven inputs on the netlist.
pub fn erc(tree: &SheetTree, nets: &Netlist) -> Vec<Finding> {
    let mut out = Vec::new();
    // pin types per (sheet, ref, pin)
    let mut kinds: BTreeMap<(String, String, String), PinType> = BTreeMap::new();
    let mut no_connect_points: BTreeMap<String, BTreeSet<Pt>> = BTreeMap::new();
    let mut pin_points: BTreeMap<(String, String, String), Pt> = BTreeMap::new();
    // (sheet, ref) -> lib_id and (sheet, ref, pin) -> pin name, for the polarity check.
    let mut lib_ids: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut pin_names: BTreeMap<(String, String, String), String> = BTreeMap::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            if let Some(lib) = sheet.lib_symbol(&s.lib_id) {
                lib_ids.insert((inst.names.clone(), reference.clone()), s.lib_id.clone());
                for p in world_pins(s, lib) {
                    pin_names.insert(
                        (inst.names.clone(), reference.clone(), p.number.clone()),
                        p.name.clone(),
                    );
                    kinds.insert(
                        (inst.names.clone(), reference.clone(), p.number.clone()),
                        p.kind,
                    );
                    pin_points.insert(
                        (inst.names.clone(), reference.clone(), p.number.clone()),
                        p.at,
                    );
                }
            }
        }
        no_connect_points.insert(
            inst.names.clone(),
            sheet.no_connects.iter().map(|n| n.at).collect(),
        );
    }
    // Points already occupied by a power symbol (same rule as the write gate's power_at):
    // a PWR_FLAG must not be stacked on them.
    let mut power_points: BTreeMap<String, BTreeSet<Pt>> = BTreeMap::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            if lib.is_power || s.reference.starts_with('#') {
                for p in world_pins(s, lib) {
                    power_points
                        .entry(inst.names.clone())
                        .or_default()
                        .insert(p.at);
                }
            }
        }
    }
    let pin_at = |m: &sch_net::NetMember| {
        pin_points
            .get(&(m.sheet.clone(), m.reference.clone(), m.pin.clone()))
            .copied()
    };
    let mil = |p: Pt| [sch_model::nm_to_mil(p.x), sch_model::nm_to_mil(p.y)];
    for net in &nets.nets {
        let members: Vec<(&sch_net::NetMember, PinType)> = net
            .members
            .iter()
            .map(|m| {
                (
                    m,
                    kinds
                        .get(&(m.sheet.clone(), m.reference.clone(), m.pin.clone()))
                        .copied()
                        .unwrap_or(PinType::Unspecified),
                )
            })
            .collect();
        let outputs = members
            .iter()
            .filter(|(_, k)| matches!(k, PinType::Output))
            .count();
        // KiCad's matrix: a power_in pin is driven only by a power_out pin (or a PWR_FLAG); a logic
        // output feeding a supply pin is `power_pin_not_driven`, an error in eeschema.
        let power_outs = members
            .iter()
            .filter(|(_, k)| matches!(k, PinType::PowerOut))
            .count();
        let drivers = power_outs;
        let power_in = members.iter().any(|(_, k)| matches!(k, PinType::PowerIn));
        let named_global = net.scope == NetScope::Global;
        // Two supplies on one net (two power_out pins, a power_out plus a PWR_FLAG, or an output
        // driving a power_out) are `pin_to_pin` errors in eeschema.
        if power_outs >= 2 || (power_outs >= 1 && (net.flagged || outputs >= 1)) {
            let refs: Vec<String> = members
                .iter()
                .filter(|(_, k)| matches!(k, PinType::PowerOut | PinType::Output))
                .map(|(m, _)| format!("{}.{}", m.reference, m.pin))
                .collect();
            let what = if power_outs >= 2 {
                "two power outputs".to_string()
            } else if net.flagged {
                "a power output and a PWR_FLAG".to_string()
            } else {
                "a power output and a logic output".to_string()
            };
            out.push(Finding {
                refs: refs.clone(),
                at_mil: members
                    .iter()
                    .find(|(_, k)| matches!(k, PinType::PowerOut))
                    .and_then(|(m, _)| pin_at(m))
                    .map(mil),
                remediation: Some(if net.flagged {
                    "remove the PWR_FLAG (delete_object): the power output already drives this net"
                        .into()
                } else {
                    "one supply per net: separate the sources or add a series element".into()
                }),
                ..f(
                    "ERC_POWER_OUT_CONFLICT",
                    Severity::Error,
                    format!(
                        "net {} has {what} driving each other: {}",
                        net.name,
                        refs.join(", ")
                    ),
                    "/",
                    format!("erc:powerout:{}", net.name),
                )
            });
        }
        if outputs >= 2 {
            let refs: Vec<String> = members
                .iter()
                .filter(|(_, k)| matches!(k, PinType::Output))
                .map(|(m, _)| format!("{}.{}", m.reference, m.pin))
                .collect();
            out.push(Finding {
                refs: refs.clone(),
                at_mil: members
                    .iter()
                    .find(|(_, k)| matches!(k, PinType::Output))
                    .and_then(|(m, _)| pin_at(m))
                    .map(mil),
                remediation: Some(
                    "keep one driver per net; move the other output to its own net".into(),
                ),
                ..f(
                    "ERC_OUTPUT_CONFLICT",
                    Severity::Error,
                    format!(
                        "net {} has {} output pins driving each other: {}",
                        net.name,
                        outputs,
                        refs.join(", ")
                    ),
                    "/",
                    format!("erc:out:{}", net.name),
                )
            });
        }
        // KiCad's rule: a power symbol's own pin is a power_in pin, so a rail carrying only a
        // power port plus passive pins (header-fed VBUS/GND) needs a power_out pin or a PWR_FLAG;
        // a rail-looking *label* alone does not drive anything either.
        let _ = named_global;
        if (power_in || net.powered) && drivers == 0 && !net.flagged {
            // Anchor for the fix: a PowerIn pin first, else any member, whose point carries no
            // power symbol yet (a flag on an occupied point would be POWER_PORT_STACKED).
            let free = |m: &sch_net::NetMember| {
                pin_at(m)
                    .map(|p| {
                        !power_points
                            .get(&m.sheet)
                            .map(|set| set.contains(&p))
                            .unwrap_or(false)
                    })
                    .unwrap_or(true)
            };
            let anchor = members
                .iter()
                .find(|(m, k)| matches!(k, PinType::PowerIn) && free(m))
                .or_else(|| members.iter().find(|(m, _)| free(m)))
                .or_else(|| members.first())
                .map(|(m, _)| m);
            let all_refs: Vec<String> = members
                .iter()
                .map(|(m, _)| format!("{}.{}", m.reference, m.pin))
                .collect();
            let anchor_ref = anchor.map(|m| format!("{}.{}", m.reference, m.pin));
            let mut refs = Vec::new();
            if let Some(a) = &anchor_ref {
                refs.push(a.clone());
            }
            refs.extend(
                all_refs
                    .iter()
                    .filter(|r| Some(*r) != anchor_ref.as_ref())
                    .cloned(),
            );
            out.push(Finding {
                refs,
                at_mil: anchor.and_then(|m| pin_at(m)).map(mil),
                remediation: anchor_ref.as_ref().map(|a| format!("place_pwr_flag at {a}")),
                ..f(
                    "ERC_POWER_IN_UNDRIVEN",
                    Severity::Error,
                    format!(
                        "net {} feeds a power input but has no driver or power port (add a PWR_FLAG if it is externally driven)",
                        net.name
                    ),
                    anchor.map(|m| m.sheet.as_str()).unwrap_or("/"),
                    format!("erc:pwr:{}", net.name),
                )
            });
        }
        // input pin alone on an unnamed net = floating input
        if net.members.len() == 1 {
            let (m, k) = members[0];
            let at = pin_points.get(&(m.sheet.clone(), m.reference.clone(), m.pin.clone()));
            let has_nc = at
                .map(|p| {
                    no_connect_points
                        .get(&m.sheet)
                        .map(|s| s.contains(p))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if matches!(k, PinType::Input | PinType::PowerIn)
                && !has_nc
                && net.scope == NetScope::Unnamed
            {
                out.push(Finding {
                    refs: vec![format!("{}.{}", m.reference, m.pin)],
                    at_mil: at.map(|p| mil(*p)),
                    remediation: Some(format!(
                        "add_no_connect at {}.{} or connect it",
                        m.reference, m.pin
                    )),
                    ..f(
                        "ERC_INPUT_FLOATING",
                        Severity::Warning,
                        format!(
                            "{}.{} ({:?}) is not connected and has no no-connect marker",
                            m.reference, m.pin, k
                        ),
                        &m.sheet,
                        format!("erc:float:{}.{}", m.reference, m.pin),
                    )
                });
            }
        }
        // no-connect on a net with more than one member
        if net.no_connect && net.members.len() > 1 {
            out.push(Finding {
                refs: members
                    .iter()
                    .map(|(m, _)| format!("{}.{}", m.reference, m.pin))
                    .collect(),
                at_mil: members.first().and_then(|(m, _)| pin_at(m)).map(mil),
                remediation: Some(
                    "remove the no-connect marker (delete_object) or disconnect the pin".into(),
                ),
                ..f(
                    "ERC_NC_ON_CONNECTED",
                    Severity::Warning,
                    format!(
                        "net {} is marked no-connect but has {} members",
                        net.name,
                        net.members.len()
                    ),
                    members
                        .first()
                        .map(|(m, _)| m.sheet.as_str())
                        .unwrap_or("/"),
                    format!("erc:nc:{}", net.name),
                )
            });
        }
        out.extend(pin_to_pin(net, &pin_points, &pin_names));
        out.extend(multiple_net_names(
            net,
            members.first().and_then(|(m, _)| pin_at(m)),
        ));
    }
    // named net with a single pin (probably a typo in a label)
    for net in nets.named() {
        // A power-port net (or a flagged one) is driven by the port: one pin is fine there.
        if net.members.len() == 1
            && !net.powered
            && !net.flagged
            && !net.labels.iter().any(|l| looks_like_rail(l))
        {
            let m = net.members.iter().next().unwrap();
            out.push(Finding {
                refs: vec![format!("{}.{}", m.reference, m.pin)],
                at_mil: pin_at(m).map(mil),
                remediation: Some(
                    "add a matching label on the other side or rename this one (rename_net); a named net normally connects at least two pins"
                        .into(),
                ),
                ..f(
                    "ERC_SINGLE_PIN_NET",
                    Severity::Warning,
                    format!(
                        "named net {} has only one pin ({}.{})",
                        net.name, m.reference, m.pin
                    ),
                    &m.sheet,
                    format!("erc:single:{}", net.name),
                )
            });
        }
    }
    // A power symbol (or PWR_FLAG) whose pin touches no wire, junction, label or component pin: eeschema
    // `pin_not_connected` on the port itself (the netlist never sees it, so this is a geometry test).
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let on_segment = |p: Pt, a: Pt, b: Pt| -> bool {
            let (minx, maxx) = (a.x.min(b.x), a.x.max(b.x));
            let (miny, maxy) = (a.y.min(b.y), a.y.max(b.y));
            p.x >= minx
                && p.x <= maxx
                && p.y >= miny
                && p.y <= maxy
                && (b.x - a.x) as i128 * (p.y - a.y) as i128
                    == (b.y - a.y) as i128 * (p.x - a.x) as i128
        };
        for s in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            if !(lib.is_power || s.reference.starts_with('#')) {
                continue;
            }
            // Pins of every other symbol on this sheet (a port on another port's pin is connected pin-to-pin).
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            let other_pins: BTreeSet<Pt> = pin_points
                .iter()
                .filter(|((sh, r, _), _)| sh == &inst.names && r != &reference)
                .map(|(_, p)| *p)
                .collect();
            for p in world_pins(s, lib) {
                let attached = other_pins.contains(&p.at)
                    || sheet
                        .bus_entries
                        .iter()
                        .any(|b| b.at == p.at || b.end() == p.at)
                    || sheet.junctions.iter().any(|j| j.at == p.at)
                    || sheet.labels.iter().any(|l| l.at == p.at)
                    || sheet.wires.iter().any(|w| on_segment(p.at, w.a, w.b));
                if attached {
                    continue;
                }
                out.push(Finding {
                    refs: vec![s.reference.clone()],
                    at_mil: Some(mil(p.at)),
                    remediation: Some(
                        "place the power port on a pin (place_power_port at <ref>.<pin>) or delete it (delete_object)".into(),
                    ),
                    ..f(
                        "POWER_PORT_DANGLING",
                        Severity::Error,
                        format!("power symbol {} ({}) touches no wire or component pin", s.reference, s.value),
                        &inst.names,
                        format!("erc:port_dangling:{}", s.uuid),
                    )
                });
            }
        }
    }
    // label_dangling: a label whose anchor touches no wire, bus, pin tip or junction (eeschema error).
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let on_segment = |p: Pt, a: Pt, b: Pt| -> bool {
            let (minx, maxx) = (a.x.min(b.x), a.x.max(b.x));
            let (miny, maxy) = (a.y.min(b.y), a.y.max(b.y));
            if p.x < minx || p.x > maxx || p.y < miny || p.y > maxy {
                return false;
            }
            (b.x - a.x) as i128 * (p.y - a.y) as i128 == (b.y - a.y) as i128 * (p.x - a.x) as i128
        };
        let pins: BTreeSet<Pt> = pin_points
            .iter()
            .filter(|((sh, _, _), _)| sh == &inst.names)
            .map(|(_, p)| *p)
            .collect();
        for l in &sheet.labels {
            let attached = pins.contains(&l.at)
                || sheet.junctions.iter().any(|j| j.at == l.at)
                || sheet.wires.iter().any(|w| on_segment(l.at, w.a, w.b));
            if attached {
                continue;
            }
            out.push(Finding {
                at_mil: Some(mil(l.at)),
                remediation: Some(
                    "move the label onto the pin or wire it names or delete it (delete_object)"
                        .into(),
                ),
                ..f(
                    "LABEL_DANGLING",
                    Severity::Error,
                    format!("label {} touches no wire or pin", l.text),
                    &inst.names,
                    format!("erc:dangling_label:{}:{}", inst.names, l.uuid),
                )
            });
        }
    }
    // Polarised parts the wrong way round: the + / anode pin on a ground-class net while the
    // other pin sits on a positive rail. Certain for capacitors (Error); a diode may be a clamp
    // or reverse protection (Warning).
    let mut pin_net: BTreeMap<(String, String, String), &sch_net::Net> = BTreeMap::new();
    for net in &nets.nets {
        for m in &net.members {
            pin_net.insert((m.sheet.clone(), m.reference.clone(), m.pin.clone()), net);
        }
    }
    let net_class = |n: &sch_net::Net| -> i8 {
        // 1 = positive rail, -1 = ground / negative, 0 = unknown
        let rail = n
            .labels
            .iter()
            .find(|l| looks_like_rail(l))
            .cloned()
            .or_else(|| {
                let bare = n.name.trim_start_matches('/');
                if n.powered || looks_like_rail(bare) {
                    Some(bare.to_string())
                } else {
                    None
                }
            });
        match rail {
            Some(r) if sch_model::is_ground_net(&r) || r.starts_with('-') => -1,
            Some(_) => 1,
            None => 0,
        }
    };
    for ((sheet, reference), lib_id) in &lib_ids {
        let polar_cap = lib_id.starts_with("Device:C_Polarized") || lib_id.starts_with("Device:CP");
        // Zeners / TVS sit "reversed" on purpose (cathode on the rail): never flagged.
        let diode = lib_id.starts_with("Device:LED")
            || ((lib_id.starts_with("Device:D_") || lib_id == "Device:D")
                && !lib_id.contains("Zener")
                && !lib_id.contains("TVS")
                && !lib_id.contains("Schottky_AKA")
                && !lib_id.contains("_ALT"));
        if !polar_cap && !diode {
            continue;
        }
        let pin_of = |pred: &dyn Fn(&str, &str) -> bool| -> Option<String> {
            pin_names
                .iter()
                .find(|((sh, r, num), name)| sh == sheet && r == reference && pred(num, name))
                .map(|((_, _, num), _)| num.clone())
        };
        let (plus, minus) = if polar_cap {
            (pin_of(&|num, _| num == "1"), pin_of(&|num, _| num == "2"))
        } else {
            (
                pin_of(&|_, name| name == "A"),
                pin_of(&|_, name| name == "K"),
            )
        };
        let (Some(plus), Some(minus)) = (plus, minus) else {
            continue;
        };
        let np = pin_net
            .get(&(sheet.clone(), reference.clone(), plus.clone()))
            .map(|n| net_class(n))
            .unwrap_or(0);
        let nm = pin_net
            .get(&(sheet.clone(), reference.clone(), minus.clone()))
            .map(|n| net_class(n))
            .unwrap_or(0);
        if np == -1 && nm == 1 {
            out.push(Finding {
                refs: vec![reference.clone()],
                at_mil: pin_points.get(&(sheet.clone(), reference.clone(), plus.clone())).copied().map(mil),
                remediation: Some(
                    "rotate the part 180 degrees (set_component_transform) or swap the pin nets".into(),
                ),
                ..f(
                    "POLARITY_REVERSED",
                    if polar_cap { Severity::Error } else { Severity::Warning },
                    format!(
                        "{reference}: the {} pin is on a ground net while the {} pin is on a positive rail",
                        if polar_cap { "+" } else { "anode" },
                        if polar_cap { "-" } else { "cathode" }
                    ),
                    sheet,
                    format!("polarity:{reference}"),
                )
            });
        }
    }
    // A hierarchical sheet pin with nothing drawn on it. eeschema counts a sheet pin as a pin like
    // any other and reports it as `pin_not_connected` (an error by default); `PINMAP_UNCONNECTED`
    // only walks symbol pins, so without this the engine is short of KiCad's own ERC by exactly
    // these rows (docs/engine-conformance.md).
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let on_seg = |p: Pt, a: Pt, b: Pt| {
            (b.x - a.x) as i128 * (p.y - a.y) as i128 - (b.y - a.y) as i128 * (p.x - a.x) as i128
                == 0
                && p.x >= a.x.min(b.x)
                && p.x <= a.x.max(b.x)
                && p.y >= a.y.min(b.y)
                && p.y <= a.y.max(b.y)
        };
        let pin_points: BTreeSet<Pt> = sheet
            .symbols
            .iter()
            .filter_map(|s| Some((s, sheet.lib_symbol(&s.lib_id)?)))
            .flat_map(|(s, lib)| world_pins(s, lib).into_iter().map(|p| p.at))
            .collect();
        for sh in &sheet.sheets {
            for p in &sh.pins {
                let connected = sheet.wires.iter().any(|w| w.a == p.at || w.b == p.at)
                    || sheet.wires.iter().any(|w| {
                        on_seg(p.at, w.a, w.b) && sheet.junctions.iter().any(|j| j.at == p.at)
                    })
                    || sheet.labels.iter().any(|l| l.at == p.at)
                    || sheet.no_connects.iter().any(|n| n.at == p.at)
                    || pin_points.contains(&p.at)
                    || sh.pins.iter().any(|o| o.uuid != p.uuid && o.at == p.at)
                    || sheet
                        .sheets
                        .iter()
                        .any(|o| o.uuid != sh.uuid && o.pins.iter().any(|q| q.at == p.at));
                if !connected {
                    out.push(Finding {
                        refs: vec![format!("{}.{}", sh.name, p.name)],
                        at_mil: Some(mil(p.at)),
                        remediation: Some(format!(
                            "wire {} on sheet {} to the net it carries (add_wire / add_net_label), or delete the pin (delete_sheet_pin)",
                            p.name, sh.name
                        )),
                        ..f(
                            "SHEET_PIN_UNWIRED",
                            Severity::Error,
                            format!(
                                "sheet pin {} on {} has nothing drawn on it",
                                p.name, sh.name
                            ),
                            &inst.names,
                            format!("sheetpinwire:{}:{}", sh.uuid, p.uuid),
                        )
                    });
                }
            }
        }
    }
    // Hierarchical sheet pins and the child sheet's hierarchical labels must match one to one
    // (eeschema `hier_label_mismatch`, an error both ways).
    for child in &tree.instances {
        let Some((parent_path, sheet_uuid)) = &child.parent else {
            continue;
        };
        let Some(parent) = tree.instances.iter().find(|i| &i.path == parent_path) else {
            continue;
        };
        let Some(sym) = tree.files[&parent.file]
            .sheets
            .iter()
            .find(|sh| &sh.uuid == sheet_uuid)
        else {
            continue;
        };
        let child_sheet = &tree.files[&child.file];
        let hier: BTreeSet<&str> = child_sheet
            .labels
            .iter()
            .filter(|l| l.kind == sch_model::LabelKind::Hierarchical)
            .map(|l| l.text.as_str())
            .collect();
        let pins: BTreeSet<&str> = sym.pins.iter().map(|p| p.name.as_str()).collect();
        for p in sym.pins.iter().filter(|p| !hier.contains(p.name.as_str())) {
            out.push(Finding {
                refs: vec![sym.name.clone()],
                at_mil: Some(mil(p.at)),
                remediation: Some(format!(
                    "add a hierarchical label {0} inside {1} (add_net_label with sheet: \"{1}\", name: \"{0}\", scope: \"hierarchical\") or delete the sheet pin (delete_sheet_pin); a pin written by add_sheet / add_sheet_pin is seeded with its label, so this one came from elsewhere",
                    p.name, sym.file
                )),
                ..f(
                    "SHEET_PIN_UNMATCHED",
                    Severity::Error,
                    format!("sheet {} has pin {} but {} has no hierarchical label of that name", sym.name, p.name, sym.file),
                    &parent.names,
                    format!("sheetpin:{}:{}", sym.name, p.name),
                )
            });
        }
        for l in child_sheet.labels.iter().filter(|l| {
            l.kind == sch_model::LabelKind::Hierarchical && !pins.contains(l.text.as_str())
        }) {
            out.push(Finding {
                refs: vec![sym.name.clone()],
                at_mil: Some(mil(l.at)),
                remediation: Some(format!(
                    "add a sheet pin {} on {} in the parent (add_sheet_pin) or turn the label into a local one",
                    l.text, sym.name
                )),
                ..f(
                    "HIER_LABEL_UNMATCHED",
                    Severity::Error,
                    format!("{} has hierarchical label {} but sheet {} in the parent has no such pin", sym.file, l.text, sym.name),
                    &child.names,
                    format!("hierlabel:{}:{}", sym.name, l.text),
                )
            });
        }
    }
    // Rail aliases: +3V3 / +3.3V / 3V3 are three separate nets in KiCad.
    let mut by_key: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for net in &nets.nets {
        let bare = net.name.trim_start_matches('/');
        if !(net.powered || net.scope == NetScope::Global)
            || !looks_like_rail(bare)
            || sch_model::is_ground_net(bare)
        {
            continue;
        }
        by_key
            .entry(rail_key(bare))
            .or_default()
            .insert(bare.to_string());
    }
    for (_, names) in by_key {
        if names.len() > 1 {
            let list: Vec<String> = names.iter().cloned().collect();
            out.push(Finding {
                remediation: Some("rename_net so one rail has one name".into()),
                ..f(
                    "RAIL_ALIAS",
                    Severity::Warning,
                    format!(
                        "rails {} read as the same supply but are separate nets",
                        list.join(", ")
                    ),
                    "/",
                    format!("erc:rail_alias:{}", list.join("|")),
                )
            });
        }
    }
    out.extend(instance_refs(tree));
    sch_write::gates::attach_files(tree, &mut out);
    out
}

/// Pin references listed in a net-level finding before the message is cut short.
const MAX_LISTED_PINS: usize = 20;

/// eeschema's pin-to-pin conflict matrix ([`pin_matrix`]) applied to one net.
///
/// KiCad compares every pair of pins on the net, but the verdict depends only on the two
/// electrical types, so this walks the type pairs that are actually present (O(members) instead
/// of O(members^2): a 500-pin ground net is 144 lookups, not 125 000 comparisons). Same-type
/// pairs are skipped when every pin of that type is *stacked* — one symbol, one point, one pin
/// name — the way `SCH_PIN::IsStacked` exempts them in eeschema.
///
/// Power-symbol pins never reach `Net::members` (`sch-net` records them as `powered` /
/// `flagged`), so a power port's own `power_in` pin and a PWR_FLAG's `power_out` pin are
/// excluded here by construction. That matches eeschema's outcome: `power_in`/`power_in` (two
/// ports of one rail) and `power_out`/`power_in` (a supply feeding a rail) are `OK` cells, and
/// the cells a PWR_FLAG *can* fail are already covered by `ERC_POWER_OUT_CONFLICT`.
///
/// `Output`/`Output` and any `{Output, PowerOut}` pair are likewise left to the two older,
/// more specific codes (`ERC_OUTPUT_CONFLICT`, `ERC_POWER_OUT_CONFLICT`), which model exactly
/// those `ERR` cells plus the PWR_FLAG that the member list cannot express — so one conflict is
/// never reported twice.
fn pin_to_pin(
    net: &sch_net::Net,
    pin_points: &BTreeMap<(String, String, String), Pt>,
    pin_names: &BTreeMap<(String, String, String), String>,
) -> Vec<Finding> {
    use pin_matrix::{pin_conflict, pin_index, PIN_TYPES};

    #[derive(Default)]
    struct Bucket {
        /// `a/b` for every offending type pair, in matrix order.
        pairs: Vec<String>,
        refs: Vec<String>,
        seen: BTreeSet<String>,
        /// Sheet and position of the first offending pin.
        anchor: Option<(String, Option<Pt>)>,
    }
    let key = |m: &sch_net::NetMember| (m.sheet.clone(), m.reference.clone(), m.pin.clone());
    let mut by_type: [Vec<&sch_net::NetMember>; 12] = std::array::from_fn(|_| Vec::new());
    for m in &net.members {
        by_type[pin_index(PinType::parse(&m.pin_type))].push(m);
    }
    // 0: ERC_PIN_TO_PIN Error, 1: ERC_PIN_TO_PIN Warning, 2: ERC_UNSPECIFIED_PIN Warning.
    let mut buckets: [Bucket; 3] = std::array::from_fn(|_| Bucket::default());
    let driving = |t: PinType| matches!(t, PinType::Output | PinType::PowerOut);
    for (i, &ta) in PIN_TYPES.iter().enumerate() {
        for (j, &tb) in PIN_TYPES.iter().enumerate().skip(i) {
            let Some(sev) = pin_conflict(ta, tb) else {
                continue;
            };
            if driving(ta) && driving(tb) {
                continue;
            }
            if i == j {
                if by_type[i].len() < 2 {
                    continue;
                }
                let stacks: BTreeSet<(&str, &str, Option<Pt>, Option<&str>)> = by_type[i]
                    .iter()
                    .map(|m| {
                        let k = key(m);
                        (
                            m.sheet.as_str(),
                            m.reference.as_str(),
                            pin_points.get(&k).copied(),
                            pin_names.get(&k).map(String::as_str),
                        )
                    })
                    .collect();
                if stacks.len() < 2 {
                    continue;
                }
            } else if by_type[i].is_empty() || by_type[j].is_empty() {
                continue;
            }
            let unspecified = ta == PinType::Unspecified || tb == PinType::Unspecified;
            let no_connect = ta == PinType::NoConnect || tb == PinType::NoConnect;
            let b = &mut buckets[match (unspecified && !no_connect, sev) {
                (true, _) => 2,
                (false, Severity::Error) => 0,
                (false, _) => 1,
            }];
            b.pairs.push(format!("{}/{}", ta.as_str(), tb.as_str()));
            for m in net.members.iter().filter(|m| {
                let t = PinType::parse(&m.pin_type);
                t == ta || t == tb
            }) {
                let r = format!("{}.{}", m.reference, m.pin);
                if b.seen.insert(r.clone()) {
                    b.refs.push(r);
                }
                if b.anchor.is_none() {
                    b.anchor = Some((m.sheet.clone(), pin_points.get(&key(m)).copied()));
                }
            }
        }
    }
    let mut out = Vec::new();
    for (idx, b) in buckets.into_iter().enumerate() {
        if b.refs.is_empty() {
            continue;
        }
        let listed: Vec<String> = b.refs.iter().take(MAX_LISTED_PINS).cloned().collect();
        let more = b.refs.len() - listed.len();
        let tail = if more > 0 {
            format!(" (+{more} more)")
        } else {
            String::new()
        };
        let (sheet, at) = b.anchor.unwrap_or_else(|| ("/".into(), None));
        let (code, sev, loc, message, remediation) = match idx {
            2 => (
                "ERC_UNSPECIFIED_PIN",
                Severity::Warning,
                format!("erc:unspec:{}", net.name),
                format!(
                    "net {} connects a pin of unspecified electrical type ({}): {}{tail}",
                    net.name,
                    b.pairs.join(", "),
                    listed.join(", ")
                ),
                "give the pin an electrical type in its library symbol: eeschema cannot check an unspecified pin",
            ),
            _ => (
                "ERC_PIN_TO_PIN",
                if idx == 0 {
                    Severity::Error
                } else {
                    Severity::Warning
                },
                format!(
                    "erc:pin2pin:{}:{}",
                    if idx == 0 { "error" } else { "warning" },
                    net.name
                ),
                format!(
                    "net {} connects pin types eeschema rejects ({}): {}{tail}",
                    net.name,
                    b.pairs.join(", "),
                    listed.join(", ")
                ),
                "separate the conflicting pins onto different nets, or put a buffer or series element between them",
            ),
        };
        out.push(Finding {
            refs: listed,
            at_mil: at.map(|p| [sch_model::nm_to_mil(p.x), sch_model::nm_to_mil(p.y)]),
            remediation: Some(remediation.into()),
            ..f(code, sev, message, &sheet, loc)
        });
    }
    out
}

/// eeschema `multiple_net_names` (`ERCE_DRIVER_CONFLICT`, warning by default): two or more
/// different names drive one net, so only the winner of the driver-priority ladder reaches the
/// netlist and the other name silently names nothing.
///
/// `Net::labels` already holds every label text on the net; bus labels are dropped here because
/// `sch-net` does not count them as drivers either. A power symbol contributes no label, but
/// when one is present (`Net::powered`) its value *is* the net's name — `Priority::Power` tops
/// the ladder — so the net name stands in for it. Two labels that agree (a global and a local
/// of the same text) are one name, which is eeschema's `same_local_global_label`, not this.
fn multiple_net_names(net: &sch_net::Net, anchor: Option<Pt>) -> Option<Finding> {
    let mut names: BTreeSet<&str> = net
        .labels
        .iter()
        .filter(|l| sch_net::bus_members(l).is_empty())
        .map(String::as_str)
        .collect();
    if net.powered {
        names.insert(net.name.as_str());
    }
    if names.len() < 2 {
        return None;
    }
    // The netlist name minus its sheet path, so the message names the winning label.
    let bare = net.name.rsplit('/').next().unwrap_or(net.name.as_str());
    let winner = if names.contains(bare) {
        bare
    } else {
        net.name.as_str()
    };
    let member = net.members.iter().next()?;
    let listed: Vec<String> = net
        .members
        .iter()
        .take(MAX_LISTED_PINS)
        .map(|m| format!("{}.{}", m.reference, m.pin))
        .collect();
    let list: Vec<&str> = names.iter().copied().collect();
    Some(Finding {
        refs: listed,
        at_mil: anchor.map(|p| [sch_model::nm_to_mil(p.x), sch_model::nm_to_mil(p.y)]),
        remediation: Some(
            "keep one name per net: delete_object the extra label, or rename it (rename_net)"
                .into(),
        ),
        ..f(
            "ERC_MULTIPLE_NET_NAMES",
            Severity::Warning,
            format!(
                "net {} is named by {} labels ({}); only {} reaches the netlist",
                net.name,
                names.len(),
                list.join(", "),
                winner
            ),
            &member.sheet,
            format!("erc:names:{}", net.name),
        )
    })
}

/// FR-611: a sheet file placed more than once in the hierarchy needs one
/// `(instances (project ... (path "/<root>/<sheet>..." (reference ...))))` entry per instance
/// path on every symbol. A symbol that lacks the entry for one path is un-annotated (`R?`) in
/// that instance in eeschema, and netlist export then reports a duplicate or a missing
/// reference. One finding per sheet file, anchored at the first affected symbol.
///
/// Entries are matched by instance path only, the way eeschema looks a reference up for the
/// current sheet path; the project name is reported separately (`PROJECT_NAME_MISMATCH`,
/// Warning) so a renamed or copied project does not turn a correctly annotated sheet into an
/// error. Power symbols and `#`-prefixed references are skipped: KiCad annotates them itself
/// and they are not part of the BOM.
pub fn instance_refs(tree: &SheetTree) -> Vec<Finding> {
    /// References and instance paths listed in the message before it is cut short.
    const MAX_LISTED: usize = 20;
    let mut out = Vec::new();
    // Sheet file -> its instance paths, in depth-first tree order. BTreeMap keeps the findings
    // deterministic across runs.
    let mut by_file: BTreeMap<&std::path::Path, Vec<&sch_read::SheetInstancePath>> =
        BTreeMap::new();
    for inst in &tree.instances {
        by_file.entry(inst.file.as_path()).or_default().push(inst);
    }
    for (file, insts) in by_file {
        if insts.len() < 2 {
            continue;
        }
        let sheet = &tree.files[file];
        let mut refs: Vec<String> = Vec::new();
        let mut missing_paths: BTreeSet<&str> = BTreeSet::new();
        let mut anchor: Option<Pt> = None;
        for s in &sheet.symbols {
            let is_power = sheet
                .lib_symbol(&s.lib_id)
                .map(|l| l.is_power)
                .unwrap_or(false)
                || s.reference.starts_with('#');
            if is_power {
                continue;
            }
            let mut missing = false;
            for inst in &insts {
                if !s.instances.iter().any(|r| r.path == inst.path) {
                    missing_paths.insert(inst.path.as_str());
                    missing = true;
                }
            }
            if missing {
                let reference = if s.reference.is_empty() {
                    s.uuid.clone()
                } else {
                    s.reference.clone()
                };
                refs.push(reference);
                anchor.get_or_insert(s.placement.at);
            }
        }
        if refs.is_empty() {
            continue;
        }
        let file_label = file
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default();
        let listed: Vec<String> = refs.iter().take(MAX_LISTED).cloned().collect();
        let more = refs.len().saturating_sub(listed.len());
        let paths: Vec<&str> = missing_paths.iter().take(MAX_LISTED).copied().collect();
        let more_paths = missing_paths.len().saturating_sub(paths.len());
        out.push(Finding {
            refs: listed.clone(),
            // The whole finding is about one sheet *file* (its `sheet` is only the first of the
            // instances): the harness reads `file` instead of parsing the message.
            file: Some(tree.rel_file(file)),
            at_mil: anchor.map(|p| [sch_model::nm_to_mil(p.x), sch_model::nm_to_mil(p.y)]),
            remediation: Some(format!(
                "annotate {file_label} in KiCad so every instance gets its own reference, or re-place the parts with place_component instance_designators covering all {} instance paths",
                insts.len()
            )),
            ..f(
                "INSTANCE_REFS_REQUIRED",
                Severity::Error,
                format!(
                    "{file_label} is instantiated {} times; {} symbol{} without a reference for every instance path: {}{} (missing paths: {}{})",
                    insts.len(),
                    refs.len(),
                    if refs.len() == 1 { "" } else { "s" },
                    listed.join(", "),
                    if more > 0 {
                        format!(" and {more} more")
                    } else {
                        String::new()
                    },
                    paths.join(", "),
                    if more_paths > 0 {
                        format!(" and {more_paths} more")
                    } else {
                        String::new()
                    },
                ),
                &insts[0].names,
                format!("instrefs:{}", sheet.uuid),
            )
        });
    }
    out
}

/// Canonical key for a rail name: `+3V3`, `+3.3V`, `3V3`, `+3v3` all map to `3.3`; suffixes are kept
/// (`+5V_USB` is not `+5V`), negative rails keep their sign (`-5V` is not `+5V`).
pub fn rail_key(name: &str) -> String {
    let upper = name.to_ascii_uppercase();
    let (neg, body) = match upper.strip_prefix('-') {
        Some(rest) => (true, rest.to_string()),
        None => (false, upper.trim_start_matches('+').to_string()),
    };
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0;
    while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
        i += 1;
    }
    let sign = if neg { "NEG" } else { "" };
    if i == 0 {
        return format!("{sign}{body}");
    }
    let mut volts: String = chars[..i].iter().collect();
    let mut rest: String = chars[i..].iter().collect();
    if let Some(r) = rest.strip_prefix('V') {
        // 3V3: the digits after the V are the fraction
        let frac: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !frac.is_empty() && !volts.contains('.') {
            volts = format!("{volts}.{frac}");
        }
        rest = r[frac.len()..].to_string();
    }
    let volts = if volts.contains('.') {
        volts
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    } else {
        volts
    };
    format!("{sign}{volts}{rest}")
}

/// Pin map for one component (unit-aware).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinMapEntry {
    pub unit: u32,
    pub number: String,
    pub name: String,
    pub kind: String,
    pub net: Option<String>,
    pub at_mil: [f64; 2],
}

/// One placed pin, as `pinmap_findings` needs it: enough to decide stacking (`SCH_PIN::IsStacked`)
/// and to anchor the finding.
struct PlacedPin {
    /// Uuid of the placed symbol the pin belongs to.
    symbol: String,
    at: Pt,
    name: String,
}

/// `PINMAP_UNCONNECTED`: eeschema's `pin_not_connected` (`ERCE_PIN_NOT_CONNECTED`,
/// `connection_graph.cpp::ercCheckNoConnects`), an ERROR by default.
///
/// KiCad reports a pin whose subgraph holds no driver and no other pin. Verified against
/// `kicad-cli sch erc` (`tests/pin_not_connected.rs`): a bare wire stub does *not* clear it (that
/// is a second, `unconnected_wire_endpoint` warning), a label anywhere on the subgraph does (it
/// becomes `isolated_pin_label` instead), and the only exempt electrical types are `free`
/// (`PT_NIC`) and `no_connect` (`PT_NC`) — passive and unspecified pins *are* reported. A
/// no-connect marker on the pin clears it. Pins stacked inside one symbol (same symbol, same
/// position, same name — `SCH_PIN::IsStacked`) count as a single pin and are reported once; pins
/// of two different symbols at the same point are connected to each other and are not reported.
///
/// `location: pin:<ref>:<num>`, `refs: ["<ref>.<num>"]`. Power ports (`#`-prefixed references)
/// are left to `POWER_PORT_DANGLING`.
pub fn pinmap_findings(tree: &SheetTree, nets: &Netlist) -> Vec<Finding> {
    let mut placed: BTreeMap<(String, String, String), PlacedPin> = BTreeMap::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            if reference.starts_with('#') {
                continue;
            }
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            if lib.is_power {
                continue;
            }
            // The instance's unit decides which pins are placed (same rule as sch-net).
            let unit = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.unit)
                .unwrap_or(s.unit);
            let inst_sym = SymbolInst { unit, ..s.clone() };
            for p in world_pins(&inst_sym, lib) {
                placed.insert(
                    (inst.names.clone(), reference.clone(), p.number.clone()),
                    PlacedPin {
                        symbol: s.uuid.clone(),
                        at: p.at,
                        name: p.name.clone(),
                    },
                );
            }
        }
    }
    let mut v = Vec::new();
    for net in &nets.nets {
        // A driver (label, power port, sheet pin) means the pin is named, not unconnected; a
        // no-connect marker is the human saying "on purpose".
        if net.scope != NetScope::Unnamed || net.no_connect {
            continue;
        }
        let members: Vec<&sch_net::NetMember> = net.members.iter().collect();
        let Some(first) = members.first().copied() else {
            continue;
        };
        let mut infos = Vec::with_capacity(members.len());
        for m in &members {
            match placed.get(&(m.sheet.clone(), m.reference.clone(), m.pin.clone())) {
                Some(p) => infos.push(p),
                None => break,
            }
        }
        if infos.len() != members.len() {
            continue;
        }
        let head = infos[0];
        if !infos
            .iter()
            .all(|p| p.symbol == head.symbol && p.at == head.at && p.name == head.name)
        {
            continue;
        }
        if matches!(first.pin_type.as_str(), "free" | "no_connect") {
            continue;
        }
        v.push(Finding {
            code: "PINMAP_UNCONNECTED".into(),
            severity: Severity::Error,
            message: format!(
                "{}.{} ({}) is not connected",
                first.reference,
                first.pin,
                if head.name.is_empty() {
                    "~"
                } else {
                    head.name.as_str()
                }
            ),
            sheet: Some(first.sheet.clone()),
            file: None,
            refs: members
                .iter()
                .map(|m| format!("{}.{}", m.reference, m.pin))
                .collect(),
            at_mil: Some([nm_to_mil(head.at.x), nm_to_mil(head.at.y)]),
            remediation: Some(format!(
                "connect the pin, or add_no_connect at {}.{} when it is meant to stay open",
                first.reference, first.pin
            )),
            evidence: Default::default(),
            location: format!("pin:{}:{}", first.reference, first.pin),
        });
    }
    v.sort_by(|a, b| a.location.cmp(&b.location));
    v.dedup_by(|a, b| a.location == b.location);
    sch_write::gates::attach_files(tree, &mut v);
    v
}

pub fn pinmap(tree: &SheetTree, nets: &Netlist, reference: &str) -> Vec<PinMapEntry> {
    let pm = nets.pin_map();
    let mut out = Vec::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in sheet.symbol_by_ref(reference) {
            if let Some(lib) = sheet.lib_symbol(&s.lib_id) {
                for p in world_pins(s, lib) {
                    let key = sch_net::NetMember {
                        sheet: inst.names.clone(),
                        reference: reference.into(),
                        pin: p.number.clone(),
                        pin_type: p.kind.as_str().into(),
                    };
                    out.push(PinMapEntry {
                        unit: s.unit,
                        number: p.number.clone(),
                        name: p.name.clone(),
                        kind: p.kind.as_str().into(),
                        net: pm.get(&key).cloned(),
                        at_mil: [nm_to_mil(p.at.x), nm_to_mil(p.at.y)],
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.unit.cmp(&b.unit).then(natural_cmp(&a.number, &b.number)));
    out
}

fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        _ => a.cmp(b),
    }
}

/// Pin differences named in one `SYMBOL_CACHE_MISMATCH` message before it is truncated.
const CACHE_DIFF_LISTED: usize = 6;

/// How the schematic's cached copy of a library symbol differs from the library one, pin by pin.
///
/// eeschema's `ERCE_LIB_SYMBOL_MISMATCH` compares the flattened library symbol with the cached
/// copy (`Compare(..., EQUALITY | ERC)`), so a renamed pin, a changed electrical type or a moved
/// pin all count — not only a different pin count. Pins are matched on (unit, body style, number),
/// which is what a placed instance connects through; graphics and text placement are ignored, as
/// they cannot change the netlist. The returned lines are sorted and stable.
fn lib_pin_diff(cached: &LibSymbol, library: &LibSymbol) -> Vec<String> {
    let key = |p: &LibPin| (p.unit, p.convert, p.number.clone());
    let index = |s: &LibSymbol| -> BTreeMap<(u32, u32, String), LibPin> {
        s.pins.iter().map(|p| (key(p), p.clone())).collect()
    };
    let a = index(cached);
    let b = index(library);
    let where_ = |unit: u32| {
        if unit == 0 {
            String::new()
        } else {
            format!(" (unit {unit})")
        }
    };
    let mut out = Vec::new();
    for (k, p) in &a {
        match b.get(k) {
            None => out.push(format!(
                "pin {} is not in the library{}",
                p.number,
                where_(k.0)
            )),
            Some(q) => {
                if p.name != q.name {
                    out.push(format!(
                        "pin {} name {} vs {}{}",
                        p.number,
                        p.name,
                        q.name,
                        where_(k.0)
                    ));
                }
                if p.kind != q.kind {
                    out.push(format!(
                        "pin {} type {} vs {}{}",
                        p.number,
                        p.kind.as_str(),
                        q.kind.as_str(),
                        where_(k.0)
                    ));
                }
                if p.at != q.at {
                    out.push(format!(
                        "pin {} at {:.0},{:.0} mil vs {:.0},{:.0} mil{}",
                        p.number,
                        nm_to_mil(p.at.x),
                        nm_to_mil(p.at.y),
                        nm_to_mil(q.at.x),
                        nm_to_mil(q.at.y),
                        where_(k.0)
                    ));
                }
            }
        }
    }
    for (k, q) in &b {
        if !a.contains_key(k) {
            out.push(format!(
                "pin {} is in the library but not in the cache{}",
                q.number,
                where_(k.0)
            ));
        }
    }
    out
}

/// Project-level audit: annotation, library cache vs table, title blocks.
pub fn project(tree: &SheetTree, lib: &mut sch_read::SymbolLibrary) -> Vec<Finding> {
    let mut out = Vec::new();
    // (sheet instance, lib_id) -> (mismatch detail, refs placed from it). The detail is written by
    // the converter as a symbol property, so it survives into the schematic's `lib_symbols` cache.
    let mut mismatches: BTreeMap<(String, String), (String, BTreeSet<String>)> = BTreeMap::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            if let Some(detail) = sheet
                .lib_symbol(&s.lib_id)
                .and_then(|l| l.pin_pad_mismatch())
            {
                mismatches
                    .entry((inst.names.clone(), s.lib_id.clone()))
                    .or_insert_with(|| (detail.to_string(), BTreeSet::new()))
                    .1
                    .insert(reference.clone());
            }
            if reference.ends_with('?') {
                out.push(Finding {
                    refs: vec![reference.clone()],
                    remediation: Some(
                        "give the part a number (set_component_parameters new_designator is refused; re-place it with a leased designator, or annotate in KiCad)".into(),
                    ),
                    ..f(
                        "UNANNOTATED",
                        Severity::Error,
                        format!("{reference} is not annotated"),
                        &inst.names,
                        format!("annot:{}", s.uuid),
                    )
                });
            }
        }
        for cached in &sheet.lib_symbols {
            if cached.id.contains(':') {
                match lib.resolve(&cached.id) {
                    Some(l) => {
                        let diff = lib_pin_diff(cached, &l);
                        if !diff.is_empty() {
                            let shown: Vec<String> =
                                diff.iter().take(CACHE_DIFF_LISTED).cloned().collect();
                            let more = diff.len().saturating_sub(shown.len());
                            let tail = if more > 0 {
                                format!(" (+{more} more)")
                            } else {
                                String::new()
                            };
                            out.push(Finding {
                                remediation: Some(format!(
                                    "the cached copy of {} is stale: re-place the part, or update the symbol in KiCad so the schematic cache matches the library",
                                    cached.id
                                )),
                                ..f(
                                    "SYMBOL_CACHE_MISMATCH",
                                    Severity::Warning,
                                    format!(
                                        "{} in the schematic cache differs from the library: {}{tail}",
                                        cached.id,
                                        shown.join("; ")
                                    ),
                                    &inst.names,
                                    format!("cache:{}", cached.id),
                                )
                            });
                        }
                    }
                    None => out.push(f(
                        "SYMBOL_NOT_IN_TABLE",
                        Severity::Info,
                        format!(
                            "{} is cached in the schematic but not found in any configured library",
                            cached.id
                        ),
                        &inst.names,
                        format!("cache:{}", cached.id),
                    )),
                }
            }
        }
        let doc = &tree.docs[&inst.file];
        let has_title = doc
            .root
            .find("title_block")
            .and_then(|t| t.find("title"))
            .and_then(|t| t.arg(0))
            .map(|t| !t.is_empty())
            .unwrap_or(false);
        // A Warning, not an Info: the harness fills the title block itself on a new project, so a
        // sheet that still has no title got that way after the fact, and a plot with an empty
        // title block is the one defect a reader sees before anything else on the page.
        if !has_title {
            out.push(Finding {
                remediation: Some("set_title_block {title, rev, company} (the harness fills a single-sheet project from the sheet name)".into()),
                ..f(
                    "TITLE_BLOCK_EMPTY",
                    Severity::Warning,
                    format!("sheet {} has no title", inst.names),
                    &inst.names,
                    format!("title:{}", inst.path),
                )
            });
        }
    }
    // The converter found symbol pins with no footprint pad (or the reverse) and recorded it on the
    // library symbol. Until now that warning only existed in the `parts.convert` tool result, which
    // nothing read: this is where it reaches a human.
    for ((sheet, lib_id), (detail, refs)) in mismatches {
        let refs: Vec<String> = refs.into_iter().collect();
        out.push(Finding {
            refs: refs.clone(),
            remediation: Some(
                "compare the symbol pins and the footprint pads with the datasheet; re-convert the part or fix the library before ordering".into(),
            ),
            ..f(
                "PIN_PAD_MISMATCH",
                Severity::Warning,
                format!(
                    "{} uses {lib_id}, whose conversion recorded a pin/pad mismatch: {detail}",
                    refs.join(", ")
                ),
                &sheet,
                format!("pinpad:{lib_id}"),
            )
        });
    }
    sch_write::gates::attach_files(tree, &mut out);
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BomLine {
    pub refs: Vec<String>,
    pub value: String,
    pub footprint: String,
    pub lib_id: String,
    pub qty: usize,
    pub dnp: bool,
    pub lcsc: Option<String>,
}

/// BOM-lite grouped by (value, footprint, lib_id).
pub fn bom(tree: &SheetTree) -> Vec<BomLine> {
    let mut groups: BTreeMap<(String, String, String, bool, String), BTreeSet<String>> =
        BTreeMap::new();
    let mut lcsc: BTreeMap<String, String> = BTreeMap::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            if reference.starts_with('#') || !s.in_bom {
                continue;
            }
            let part_no = s
                .properties
                .iter()
                .find(|(k, _)| k == "LCSC" || k == "Supplier Part")
                .map(|(_, v)| v.clone());
            // Two 10k 0603 with different LCSC numbers are two purchase lines, never one.
            groups
                .entry((
                    s.value.clone(),
                    s.footprint.clone(),
                    s.lib_id.clone(),
                    s.dnp,
                    part_no.clone().unwrap_or_default(),
                ))
                .or_default()
                .insert(reference.clone());
            if let Some(v) = part_no {
                lcsc.insert(reference, v);
            }
        }
    }
    groups
        .into_iter()
        .map(|((value, footprint, lib_id, dnp, _part_no), refs)| {
            let l = refs.iter().find_map(|r| lcsc.get(r).cloned());
            let mut refs: Vec<String> = refs.into_iter().collect();
            refs.sort_by_key(|a| natural_ref(a));
            BomLine {
                qty: refs.len(),
                refs,
                value,
                footprint,
                lib_id,
                dnp,
                lcsc: l,
            }
        })
        .collect()
}

fn natural_ref(r: &str) -> (String, u64) {
    let idx = r.find(|c: char| c.is_ascii_digit()).unwrap_or(r.len());
    (r[..idx].to_string(), r[idx..].parse().unwrap_or(0))
}

/// Intent snapshot (`intent.json`): nets as REF.PIN member sets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Intent {
    pub schema_version: u32,
    pub nets: BTreeMap<String, IntentNet>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentNet {
    pub members: Vec<String>,
}

pub fn intent_snapshot(nets: &Netlist, note: &str) -> Intent {
    let mut m = BTreeMap::new();
    for n in nets.named() {
        if n.members.len() >= 2 {
            m.insert(
                n.name.clone(),
                IntentNet {
                    members: n
                        .members
                        .iter()
                        .map(|x| format!("{}.{}", x.reference, x.pin))
                        .collect(),
                },
            );
        }
    }
    Intent {
        schema_version: 1,
        nets: m,
        note: note.into(),
    }
}

/// Compare the current nets against an intent snapshot by member sets.
pub fn check_intent(nets: &Netlist, intent: &Intent) -> Vec<Finding> {
    let mut out = Vec::new();
    let current: BTreeMap<BTreeSet<String>, String> = nets
        .nets
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
        .collect();
    let pin_to_net: BTreeMap<String, String> = nets
        .nets
        .iter()
        .flat_map(|n| {
            n.members
                .iter()
                .map(move |m| (format!("{}.{}", m.reference, m.pin), n.name.clone()))
        })
        .collect();
    for (name, inet) in &intent.nets {
        let want: BTreeSet<String> = inet.members.iter().cloned().collect();
        if current.contains_key(&want) {
            continue;
        }
        // which current nets do the intended members land in?
        let mut landed: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for m in &want {
            landed
                .entry(
                    pin_to_net
                        .get(m)
                        .cloned()
                        .unwrap_or_else(|| "(missing)".into()),
                )
                .or_default()
                .push(m.clone());
        }
        let detail: Vec<String> = landed
            .iter()
            .map(|(k, v)| format!("{k}: {}", v.join(",")))
            .collect();
        out.push(Finding { refs: want.iter().cloned().collect(), remediation: Some("either restore the connection or re-snapshot the intent after confirming the change".into()), ..f("INTENT_MISMATCH", Severity::Error, format!("intended net {name} no longer matches; members now in {}", detail.join(" | ")), "/", format!("intent:{name}")) });
    }
    out
}

/// One problem per pin: `PINMAP_UNCONNECTED` (eeschema's `pin_not_connected`, an Error) and
/// `ERC_INPUT_FLOATING` (a Warning) describe the same unconnected `input` / `power_in` pin, so the
/// weaker warning is dropped whenever the error is present in the same run. `ERC_INPUT_FLOATING`
/// stays for every pin the pinmap family does not report (a power-symbol pin, a pin whose symbol
/// the pin map could not place), so the code keeps its own cases.
///
/// Matching is by ref (`U1.7`), which is how both families identify a pin; `pinmap_findings`
/// already collapses stacked pins into one finding per ref.
pub fn drop_duplicate_pin_findings(erc: Vec<Finding>, pinmap: &[Finding]) -> Vec<Finding> {
    let unconnected: BTreeSet<&str> = pinmap
        .iter()
        .filter(|f| f.code == "PINMAP_UNCONNECTED")
        .flat_map(|f| f.refs.iter().map(|r| r.as_str()))
        .collect();
    erc.into_iter()
        .filter(|f| {
            f.code != "ERC_INPUT_FLOATING"
                || !f.refs.iter().any(|r| unconnected.contains(r.as_str()))
        })
        .collect()
}

/// Aggregated `gate.run` families.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateFamily {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateReport {
    pub ok: bool,
    pub families: Vec<GateFamily>,
}

pub fn gate_run(
    tree: &SheetTree,
    nets: &Netlist,
    intent: Option<&Intent>,
    lib: Option<&mut sch_read::SymbolLibrary>,
) -> GateReport {
    let mut families = Vec::new();
    let integrity = sch_write::gates::integrity(tree);
    families.push(fam("integrity", integrity));
    families.push(fam("layout", sch_write::gates::layout(tree)));
    families.push(fam("style", sch_write::gates::style(tree)));
    let pinmap = pinmap_findings(tree, nets);
    families.push(fam(
        "erc",
        drop_duplicate_pin_findings(erc(tree, nets), &pinmap),
    ));
    families.push(fam("pinmap", pinmap));
    families.push(fam("delivery", sch_write::gates::delivery(tree, nets)));
    match intent {
        Some(i) => families.push(fam("intent", check_intent(nets, i))),
        None => families.push(GateFamily {
            name: "intent".into(),
            status: "skipped".into(),
            reason: Some("no intent.json".into()),
            findings: vec![],
        }),
    }
    match lib {
        Some(l) => families.push(fam("project", project(tree, l))),
        None => families.push(GateFamily {
            name: "project".into(),
            status: "skipped".into(),
            reason: Some("no symbol library configured".into()),
            findings: vec![],
        }),
    }
    let ok = families.iter().all(|f| f.status != "fail");
    GateReport { ok, families }
}

fn fam(name: &str, findings: Vec<Finding>) -> GateFamily {
    let fail = findings.iter().any(|f| f.severity == Severity::Error);
    GateFamily {
        name: name.into(),
        status: if fail { "fail".into() } else { "pass".into() },
        reason: None,
        findings,
    }
}
