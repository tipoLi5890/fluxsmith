// SPDX-License-Identifier: Apache-2.0
//! Connectivity (netbuild) and net diff in the eeschema dialect.
//!
//! Rules implemented (docs/engine-architecture.md §3.4, red line 4):
//! - Wires connect at shared endpoints; a wire endpoint on another wire's
//!   interior connects only through a `(junction)` at that point.
//! - Pins connect at wire endpoints, at other pins, at labels, and at
//!   junctions; a pin on a wire interior needs a junction.
//! - Labels connect anywhere along a wire (endpoint or interior).
//! - Local labels are sheet-scoped; global labels and `(power global)` symbols
//!   are project-scoped; a `(power local)` symbol is scoped to one sheet
//!   instance and its net name carries the instance names path; hierarchical
//!   labels pair with the parent's sheet pin of the same name.
//! - A hidden `power_in` pin on a symbol that is *not* a power symbol is
//!   KiCad's legacy invisible power pin: it connects implicitly to the global
//!   net named after the pin, unless the schematic wires it explicitly.
//! - Driver priority, highest first: power pin, global label, local power pin,
//!   local label, hierarchical label / sheet pin, pin. Ties go to the
//!   lexicographically smallest name; every driver name is escaped with KiCad's
//!   `EscapeString( ..., CTX_NETNAME )` (`/` becomes `{slash}`).
//! - With no other driver the pins name the net (`SCH_PIN::GetDefaultNetName`):
//!   `Net-(<ref><unit>-<pin name>)`, `-Pad<n>` appended when the net is
//!   unconnected or the symbol repeats the name, and `Net-(<ref>-Pad<n>)` when the
//!   pin has no usable name. `unconnected-(...)` replaces `Net-(...)` when the net
//!   carries a no-connect, when the pin is a `no_connect` pin, or when it is the
//!   net's only pin. Between pins, a candidate containing "-Pad" sorts last and
//!   then the lexicographically smallest wins (`candidate_cmp`).
//! - A `no_connect` pin propagates connection to nothing.
//! - `PWR_FLAG` never names a net.
//! - Buses: bus wires carry bus labels (`NAME[a..b]`, `{A B}`, `PREFIX{A B}`);
//!   bus entries join a wire-side net to the bus member with the same name. A
//!   hierarchical sheet pin whose name is a bus name is a bus-layer item, so a
//!   bus crosses the sheet boundary through it.

use sch_model::*;
use sch_read::SheetTree;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

// ---------------------------------------------------------------------------
// Union-find
// ---------------------------------------------------------------------------

struct Dsu {
    parent: Vec<usize>,
}

impl Dsu {
    fn new(n: usize) -> Dsu {
        Dsu {
            parent: (0..n).collect(),
        }
    }
    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra.max(rb)] = ra.min(rb);
        }
    }
}

// ---------------------------------------------------------------------------
// Auto-generated pin names (eeschema `SCH_PIN::GetDefaultNetName`)
// ---------------------------------------------------------------------------

/// The pieces `SCH_PIN::GetDefaultNetName` (eeschema `sch_pin.cpp`) needs, resolved
/// once per placed pin. The subgraph decides only whether the name reads
/// `Net-(...)` or `unconnected-(...)`.
#[derive(Debug, Clone)]
struct AutoName {
    /// `<reference with unit suffix>-<escaped pin name>`; `None` when the pin name
    /// is empty or equal to the pin number, or the symbol is unannotated -- then
    /// KiCad falls back to the pad form.
    named: Option<String>,
    /// `<reference without unit suffix>-Pad<number>`, or `<symbol uuid>-Pad<number>`
    /// for an unannotated symbol (a reference ending in `?`).
    pad: String,
    /// `-Pad<number>`, appended to the named form when the subgraph is unconnected
    /// or another pin of the same placed symbol shows the same name (KiCad's
    /// `has_multiple`).
    pad_suffix: String,
    /// Another pin of the same placed symbol shows the same name.
    repeats: bool,
}

impl AutoName {
    fn render(&self, unconnected: bool) -> String {
        let open = if unconnected {
            "unconnected-("
        } else {
            "Net-("
        };
        match &self.named {
            Some(n) if unconnected || self.repeats => format!("{open}{n}{})", self.pad_suffix),
            Some(n) => format!("{open}{n})"),
            None => format!("{open}{})", self.pad),
        }
    }
}

/// KiCad's `LIB_SYMBOL::SubReference` with the default project settings
/// (first sub-reference id `A`, no separator): unit 1 -> `A`, 27 -> `AA`.
/// The `subpart_id_separator` / `subpart_first_id` project settings are not read.
fn unit_suffix(unit: u32) -> String {
    let mut out = String::new();
    let mut u = unit.max(1) - 1;
    while u >= 26 {
        let q = (u / 26).min(26);
        out.push((b'A' + (q - 1) as u8) as char);
        u %= 26;
    }
    out.push((b'A' + u as u8) as char);
    out
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum ItemKind {
    Pin {
        reference: String,
        number: String,
        kind: PinType,
        /// The auto-generated net name this pin offers when nothing names the net
        /// (`SCH_PIN::GetDefaultNetName`).
        auto: AutoName,
        /// The net name this pin declares (power port value, or the pin name of
        /// a legacy invisible power pin). `None` for ordinary pins.
        power_name: Option<String>,
        /// The power name is sheet-instance scoped (`(power local)` symbol).
        power_local: bool,
        #[allow(dead_code)]
        unit: u32,
        hidden_from_netlist: bool,
    },
    Wire {
        a: Pt,
        b: Pt,
    },
    Bus {
        a: Pt,
        b: Pt,
    },
    Label {
        text: String,
        kind: LabelKind,
    },
    Junction,
    NoConnect,
    BusEntry {
        a: Pt,
        b: Pt,
    },
    /// Sheet pin on a sheet symbol (lives in the parent sheet instance).
    SheetPin {
        name: String,
        child_path: String,
    },
}

#[derive(Debug, Clone)]
struct Item {
    /// Instance path of the sheet this item lives in.
    sheet: usize,
    at: Pt,
    kind: ItemKind,
    /// File uuid of the wire / bus / label / sheet pin this item came from (None for pins, junctions, ...).
    uuid: Option<String>,
}

/// `SCH_PIN::ConnectionPropagatesTo` (eeschema `sch_pin.cpp`): a `no_connect` pin
/// propagates connection to nothing, so it forms a subgraph of its own however it
/// is wired. Every other item propagates.
fn propagates(k: &ItemKind) -> bool {
    !matches!(
        k,
        ItemKind::Pin {
            kind: PinType::NoConnect,
            ..
        }
    )
}

fn on_segment(p: Pt, a: Pt, b: Pt) -> bool {
    // collinear and within bounding box (integer arithmetic, no overflow for nm ranges)
    let cross =
        (b.x - a.x) as i128 * (p.y - a.y) as i128 - (b.y - a.y) as i128 * (p.x - a.x) as i128;
    if cross != 0 {
        return false;
    }
    p.x >= a.x.min(b.x) && p.x <= a.x.max(b.x) && p.y >= a.y.min(b.y) && p.y <= a.y.max(b.y)
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct NetMember {
    /// Sheet names path, e.g. `/` or `/amp/`.
    pub sheet: String,
    pub reference: String,
    pub pin: String,
    pub pin_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NetScope {
    Global,
    Local,
    Hierarchical,
    Unnamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Net {
    /// KiCad-style name (`GND`, `/VBAT`, `/amp/OUT`, `Net-(R1-Pad1)`).
    pub name: String,
    pub scope: NetScope,
    pub members: BTreeSet<NetMember>,
    /// Content-addressed id: sha256 of the sorted member set (stable across renames).
    pub id: String,
    /// All label texts attached (for diagnostics).
    pub labels: BTreeSet<String>,
    /// Pins marked no-connect on this net.
    pub no_connect: bool,
    /// A `PWR_FLAG` sits on this net (it never names the net, but it declares it driven).
    #[serde(default)]
    pub flagged: bool,
    /// A power-port symbol (power:+3V3, power:GND ...) sits on the net: it is driven.
    #[serde(default)]
    pub powered: bool,
    /// The net is named by a `(power local)` symbol pin (`Priority::LocalPower`): its name repeats
    /// per sheet instance by design, so a scope check must not read that as a split local label.
    /// Skipped when false so the netlist JSON of a project without local power stays byte-identical.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local_power: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Netlist {
    pub nets: Vec<Net>,
}

/// Which net every wire / bus / label item belongs to, keyed by sheet instance path then item
/// uuid. Built alongside the netlist (same DSU, same driver ladder) so the canvas can highlight a
/// net without re-deriving connectivity; kept out of `Netlist` so its JSON stays byte-identical.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetItemMap {
    /// `instance path -> wire/bus uuid -> net name`
    pub wires: BTreeMap<String, BTreeMap<String, String>>,
    /// `instance path -> label uuid -> net name`
    pub labels: BTreeMap<String, BTreeMap<String, String>>,
    /// `parent instance path -> sheet pin uuid -> net name` (a sheet pin lives in the parent sheet).
    pub sheet_pins: BTreeMap<String, BTreeMap<String, String>>,
    /// `instance path -> junction uuid -> net name`
    pub junctions: BTreeMap<String, BTreeMap<String, String>>,
    /// `instance path -> no-connect uuid -> net name`
    pub no_connects: BTreeMap<String, BTreeMap<String, String>>,
}

impl Netlist {
    pub fn by_name(&self, name: &str) -> Option<&Net> {
        self.nets.iter().find(|n| n.name == name)
    }
    /// Map `REF.PIN` (with sheet) -> net name.
    pub fn pin_map(&self) -> BTreeMap<NetMember, String> {
        let mut m = BTreeMap::new();
        for n in &self.nets {
            for mem in &n.members {
                m.insert(mem.clone(), n.name.clone());
            }
        }
        m
    }
    pub fn named(&self) -> impl Iterator<Item = &Net> {
        self.nets.iter().filter(|n| n.scope != NetScope::Unnamed)
    }
}

// ---------------------------------------------------------------------------
// Bus label parsing
// ---------------------------------------------------------------------------

/// Expand a bus label into member names. `D[0..3]` -> D0..D3; `{A B}` -> A, B;
/// `PRE{A B}` -> PRE.A, PRE.B (KiCad group-bus naming). Non-bus labels return
/// an empty vector.
pub fn bus_members(label: &str) -> Vec<String> {
    let label = label.trim();
    if let Some(open) = label.find('[') {
        if let Some(close) = label.rfind(']') {
            let base = &label[..open];
            let range = &label[open + 1..close];
            if let Some((a, b)) = range.split_once("..") {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<i64>(), b.trim().parse::<i64>()) {
                    let (lo, hi) = (a.min(b), a.max(b));
                    return (lo..=hi).map(|i| format!("{base}{i}")).collect();
                }
            }
        }
    }
    if let Some(open) = label.find('{') {
        if let Some(close) = label.rfind('}') {
            let prefix = label[..open].trim();
            let inner = &label[open + 1..close];
            return inner
                .split_whitespace()
                .flat_map(|m| {
                    let subs = bus_members(m);
                    if subs.is_empty() {
                        vec![m.to_string()]
                    } else {
                        subs
                    }
                })
                .map(|m| {
                    if prefix.is_empty() {
                        m
                    } else {
                        format!("{prefix}.{m}")
                    }
                })
                .collect();
        }
    }
    Vec::new()
}

// ---------------------------------------------------------------------------
// Netbuild
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[allow(dead_code)]
enum Priority {
    Unnamed = 0,
    SheetPin = 2,
    Hier = 3,
    Local = 4,
    /// `(power local)` symbol pin: eeschema's `PRIORITY::LOCAL_POWER_PIN`, above
    /// a local label and below a global name (measured against kicad-cli 10.0.4).
    LocalPower = 5,
    Global = 6,
    Power = 7,
}

struct Driver {
    priority: Priority,
    name: String,
    /// depth of the sheet (root = 0) for tie-breaking
    depth: usize,
}

fn sheet_depth(names: &str) -> usize {
    names.matches('/').count().saturating_sub(1)
}

/// Build the netlist of a whole sheet tree.
pub fn build_nets(tree: &SheetTree) -> Netlist {
    build_nets_with_map(tree).0
}

/// `build_nets` plus the item -> net map (see `NetItemMap`).
pub fn build_nets_with_map(tree: &SheetTree) -> (Netlist, NetItemMap) {
    let mut items: Vec<Item> = Vec::new();
    // Candidate legacy invisible power pins: (item index, pin name).
    let mut implicit_power: Vec<(usize, String)> = Vec::new();
    // instance path string -> instance index (for sheet pins -> child hier labels)
    let inst_index: HashMap<&str, usize> = tree
        .instances
        .iter()
        .enumerate()
        .map(|(i, inst)| (inst.path.as_str(), i))
        .collect();

    for (si, inst) in tree.instances.iter().enumerate() {
        let sheet = &tree.files[&inst.file];
        for sym in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&sym.lib_id) else {
                continue;
            };
            // Reference may differ per instance path.
            let reference = sym
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| sym.reference.clone());
            let unit = sym
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.unit)
                .unwrap_or(sym.unit);
            let placed = SymbolInst {
                unit,
                ..sym.clone()
            };
            let world = world_pins(&placed, lib);
            // KiCad's `has_multiple`: another pin of *this placed symbol* (its unit's
            // pins plus the common ones) shows the same name under a different number.
            let repeats: Vec<bool> = {
                let mut first: HashMap<&str, &str> = HashMap::new();
                let mut shared: HashSet<&str> = HashSet::new();
                for p in &world {
                    match first.get(p.name.as_str()) {
                        Some(&number) if number != p.number => {
                            shared.insert(p.name.as_str());
                        }
                        Some(_) => {}
                        None => {
                            first.insert(&p.name, &p.number);
                        }
                    }
                }
                world
                    .iter()
                    .map(|p| shared.contains(p.name.as_str()))
                    .collect()
            };
            for (pi, p) in world.into_iter().enumerate() {
                // Symbols whose reference starts with '#' (power ports, PWR_FLAG)
                // never appear in the netlist; power ports name the net.
                let is_power_port = lib.is_power || reference.starts_with('#');
                let power_name =
                    if is_power_port && sym.value != "PWR_FLAG" && !sym.value.is_empty() {
                        Some(sym.value.clone())
                    } else {
                        None
                    };
                // KiCad's legacy invisible power pin (`SCH_PIN::IsGlobalPower`): a
                // hidden `power_in` pin on a symbol that is not a power symbol
                // connects implicitly to the global net named after the pin --
                // unless the user wired it, which is resolved below once every
                // item point is known.
                if power_name.is_none() && p.kind == PinType::PowerIn && p.hide && !lib.is_power {
                    implicit_power.push((items.len(), p.name.clone()));
                }
                // `SCH_PIN::GetDefaultNetName`: an unannotated symbol names its pads
                // after the symbol uuid; a pin whose name is neither empty nor equal
                // to its number names the net (with the unit token, because pin names
                // are not unique between units); everything else is `-Pad<number>`.
                let unannotated = reference.ends_with('?');
                let named = if unannotated || p.name.is_empty() || p.name == p.number {
                    None
                } else {
                    let unit_tok = if lib.unit_count > 1 {
                        unit_suffix(unit)
                    } else {
                        String::new()
                    };
                    Some(format!(
                        "{reference}{unit_tok}-{}",
                        escape_net_name(&p.name)
                    ))
                };
                let auto = AutoName {
                    named,
                    pad: format!(
                        "{}-Pad{}",
                        if unannotated { &sym.uuid } else { &reference },
                        p.number
                    ),
                    pad_suffix: format!("-Pad{}", p.number),
                    repeats: repeats[pi],
                };
                items.push(Item {
                    sheet: si,
                    at: p.at,
                    kind: ItemKind::Pin {
                        reference: reference.clone(),
                        number: p.number,
                        kind: p.kind,
                        auto,
                        power_name,
                        power_local: p.power_local,
                        unit,
                        hidden_from_netlist: is_power_port,
                    },
                    uuid: None,
                });
            }
        }
        for w in &sheet.wires {
            let kind = if w.is_bus {
                ItemKind::Bus { a: w.a, b: w.b }
            } else {
                ItemKind::Wire { a: w.a, b: w.b }
            };
            items.push(Item {
                sheet: si,
                at: w.a,
                kind,
                uuid: Some(w.uuid.clone()),
            });
        }
        for l in &sheet.labels {
            items.push(Item {
                sheet: si,
                at: l.at,
                kind: ItemKind::Label {
                    text: l.text.clone(),
                    kind: l.kind,
                },
                uuid: Some(l.uuid.clone()),
            });
        }
        for j in &sheet.junctions {
            items.push(Item {
                sheet: si,
                at: j.at,
                kind: ItemKind::Junction,
                uuid: Some(j.uuid.clone()),
            });
        }
        for n in &sheet.no_connects {
            items.push(Item {
                sheet: si,
                at: n.at,
                kind: ItemKind::NoConnect,
                uuid: Some(n.uuid.clone()),
            });
        }
        for e in &sheet.bus_entries {
            items.push(Item {
                sheet: si,
                at: e.at,
                kind: ItemKind::BusEntry {
                    a: e.at,
                    b: e.end(),
                },
                uuid: None,
            });
        }
        for sh in &sheet.sheets {
            let child_path = format!("{}/{}", inst.path, sh.uuid);
            for p in &sh.pins {
                items.push(Item {
                    sheet: si,
                    at: p.at,
                    kind: ItemKind::SheetPin {
                        name: p.name.clone(),
                        child_path: child_path.clone(),
                    },
                    uuid: Some(p.uuid.clone()),
                });
            }
        }
    }

    let n = items.len();
    let mut dsu = Dsu::new(n);

    // Index items by (sheet, point) for O(1) point lookups.
    let mut by_point: HashMap<(usize, Pt), Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        match &it.kind {
            ItemKind::Wire { a, b } | ItemKind::Bus { a, b } | ItemKind::BusEntry { a, b } => {
                by_point.entry((it.sheet, *a)).or_default().push(i);
                by_point.entry((it.sheet, *b)).or_default().push(i);
            }
            _ => {
                by_point.entry((it.sheet, it.at)).or_default().push(i);
            }
        }
    }

    // Legacy invisible power pins keep the implicit global connection only while
    // nothing else sits on their point (eeschema
    // `connection_graph.cpp::generateGlobalPowerPinSubGraphs` skips a global power
    // pin on a non-power symbol that the user wired up).
    for (idx, pin_name) in implicit_power {
        let (sheet, at) = (items[idx].sheet, items[idx].at);
        let wired = by_point
            .get(&(sheet, at))
            .map(|ids| ids.iter().any(|&j| j != idx && propagates(&items[j].kind)))
            .unwrap_or(false);
        if wired {
            continue;
        }
        if let ItemKind::Pin { power_name, .. } = &mut items[idx].kind {
            *power_name = Some(pin_name);
        }
    }

    let is_wire = |k: &ItemKind| matches!(k, ItemKind::Wire { .. });
    let is_bus = |k: &ItemKind| matches!(k, ItemKind::Bus { .. });
    // A sheet pin whose name is a bus name is a bus-layer item: eeschema
    // segregates bus from net by the *connection type* of the item's name
    // (`SCH_LINE::ConnectionPropagatesTo`), not by item class, so a bus line and
    // such a sheet pin sharing a point connect.
    let is_bus_sheet_pin = |k: &ItemKind| matches!(k, ItemKind::SheetPin { name, .. } if !bus_members(name).is_empty());

    // 1. Point coincidences: everything sharing an exact point connects,
    //    except wire-interior cases handled below. Wires and buses do not mix.
    for ((_sheet, _pt), ids) in &by_point {
        for &i in ids {
            for &j in ids {
                if i >= j {
                    continue;
                }
                let (ki, kj) = (&items[i].kind, &items[j].kind);
                if !propagates(ki) || !propagates(kj) {
                    continue;
                }
                let bus_i = is_bus(ki);
                let bus_j = is_bus(kj);
                let entry_i = matches!(ki, ItemKind::BusEntry { .. });
                let entry_j = matches!(kj, ItemKind::BusEntry { .. });
                // Buses connect only to buses, junctions and (bus) labels. Bus
                // entries belong to the wire side; their bus-side membership is
                // resolved by name in step 6, never by union.
                let allowed = if bus_i || bus_j {
                    let other_ok = |k: &ItemKind| {
                        matches!(
                            k,
                            ItemKind::Bus { .. } | ItemKind::Junction | ItemKind::Label { .. }
                        ) || is_bus_sheet_pin(k)
                    };
                    other_ok(ki) && other_ok(kj)
                } else if entry_i || entry_j {
                    let other_ok = |k: &ItemKind| {
                        matches!(
                            k,
                            ItemKind::Wire { .. }
                                | ItemKind::BusEntry { .. }
                                | ItemKind::Junction
                                | ItemKind::Label { .. }
                                | ItemKind::Pin { .. }
                        )
                    };
                    other_ok(ki) && other_ok(kj)
                } else {
                    true
                };
                if allowed {
                    dsu.union(i, j);
                }
            }
        }
    }

    // 2. Interior connections: labels anywhere on a wire/bus; junctions on a
    //    wire interior join it; sheet pins / bus entries anywhere on a bus.
    let seg_items: Vec<usize> = (0..n)
        .filter(|&i| is_wire(&items[i].kind) || is_bus(&items[i].kind))
        .collect();
    for &w in &seg_items {
        let (a, b, wire_is_bus) = match &items[w].kind {
            ItemKind::Wire { a, b } => (*a, *b, false),
            ItemKind::Bus { a, b } => (*a, *b, true),
            _ => unreachable!(),
        };
        let sheet = items[w].sheet;
        for (i, it) in items.iter().enumerate() {
            if it.sheet != sheet || i == w {
                continue;
            }
            let joins = match &it.kind {
                ItemKind::Label { .. } | ItemKind::Junction => on_segment(it.at, a, b),
                ItemKind::BusEntry { .. } if wire_is_bus => false,
                ItemKind::BusEntry { a: ea, b: eb } => {
                    on_segment(*ea, a, b) || on_segment(*eb, a, b)
                }
                _ => false,
            };
            if joins {
                dsu.union(w, i);
            }
        }
    }

    // 3. Hierarchy: sheet pin (parent) <-> hierarchical label (child) by name.
    let mut hier_labels: HashMap<(usize, String), Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        if let ItemKind::Label {
            text,
            kind: LabelKind::Hierarchical,
        } = &it.kind
        {
            hier_labels
                .entry((it.sheet, text.clone()))
                .or_default()
                .push(i);
        }
    }
    for (i, it) in items.iter().enumerate() {
        if let ItemKind::SheetPin { name, child_path } = &it.kind {
            if let Some(&child) = inst_index.get(child_path.as_str()) {
                if let Some(ids) = hier_labels.get(&(child, name.clone())) {
                    for &j in ids {
                        dsu.union(i, j);
                    }
                }
            }
        }
    }

    // 4. Global scope: global labels and power pins with the same name connect
    //    across the whole project.
    let mut globals: HashMap<String, usize> = HashMap::new();
    // Sheets on which a global label with that name exists, and names that are power
    // symbols anywhere (a local label merges with those regardless of sheet, I10).
    let mut global_sheets: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut power_names: HashSet<String> = HashSet::new();
    for (i, it) in items.iter().enumerate() {
        let name = match &it.kind {
            ItemKind::Label {
                text,
                kind: LabelKind::Global,
            } => {
                global_sheets
                    .entry(text.clone())
                    .or_default()
                    .insert(it.sheet);
                Some(text.clone())
            }
            // `(power local)` pins are not global: they are handled with the local
            // labels in step 5 (eeschema `PRIORITY::LOCAL_POWER_PIN`).
            ItemKind::Pin {
                power_name: Some(pn),
                power_local: false,
                ..
            } => {
                power_names.insert(pn.clone());
                Some(pn.clone())
            }
            _ => None,
        };
        if let Some(name) = name {
            match globals.get(&name) {
                Some(&first) => dsu.union(first, i),
                None => {
                    globals.insert(name, i);
                }
            }
        }
    }

    // 5. Local labels: same name within the same sheet instance connect.
    //    `(power local)` symbol pins carry the same scope (eeschema's local
    //    label cache is keyed by sheet path + name and holds both).
    //    (eeschema also merges a local label with a same-named global/power
    //    net on the same sheet.)
    let mut locals: HashMap<(usize, String), usize> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        let text = match &it.kind {
            ItemKind::Label {
                text,
                kind: LabelKind::Local,
            } => text,
            ItemKind::Pin {
                power_name: Some(pn),
                power_local: true,
                ..
            } => pn,
            _ => continue,
        };
        let key = (it.sheet, text.clone());
        match locals.get(&key) {
            Some(&first) => dsu.union(first, i),
            None => {
                locals.insert(key, i);
            }
        }
    }
    for ((sheet, text), &i) in &locals {
        if let Some(&g) = globals.get(text) {
            // only if a same-named global label lives on this sheet or the name is a power net
            let on_sheet = global_sheets
                .get(text)
                .map(|s| s.contains(sheet))
                .unwrap_or(false);
            if on_sheet || power_names.contains(text) {
                dsu.union(i, g);
            }
        }
    }

    // 6. Buses: group members by bus label; a bus entry connects its wire-side
    //    net to the member net with the matching wire-side name.
    //    A hierarchical sheet pin names its bus too, so a bus that only carries a
    //    sheet pin (no label of its own) still has members; the sheet pin and the
    //    child's hierarchical label share the name by construction, which is
    //    exactly eeschema's `matchBusMember` (vector members are generated in
    //    ascending index order, so `D[7..0]` and `D[0..7]` expand alike and
    //    matching by member name and by vector index agree).
    let mut bus_groups: HashMap<usize, BTreeSet<String>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        let text = match &it.kind {
            ItemKind::Label { text, .. } => text,
            ItemKind::SheetPin { name, .. } => name,
            _ => continue,
        };
        let members = bus_members(text);
        if !members.is_empty() {
            let root = dsu.find(i);
            bus_groups.entry(root).or_default().extend(members);
        }
    }
    if !bus_groups.is_empty() {
        // Determine, for each bus entry, its wire-side net root and that net's label names.
        let mut entry_info: Vec<(usize, usize, Vec<String>)> = Vec::new(); // (entry idx, bus root, wire-side names)
        for (i, it) in items.iter().enumerate() {
            let ItemKind::BusEntry { a, b } = &it.kind else {
                continue;
            };
            // find bus root: a bus segment containing a or b
            let mut bus_root = None;
            let mut wire_root = None;
            for (j, other) in items.iter().enumerate() {
                if other.sheet != it.sheet {
                    continue;
                }
                match &other.kind {
                    ItemKind::Bus { a: ba, b: bb }
                        if on_segment(*a, *ba, *bb) || on_segment(*b, *ba, *bb) =>
                    {
                        bus_root = Some(dsu.find(j));
                    }
                    ItemKind::Wire { a: wa, b: wb }
                        if *a == *wa || *a == *wb || *b == *wa || *b == *wb =>
                    {
                        wire_root = Some(dsu.find(j));
                    }
                    _ => {}
                }
            }
            if let (Some(br), Some(wr)) = (bus_root, wire_root) {
                let names: Vec<String> = items
                    .iter()
                    .enumerate()
                    .filter(|(k, o)| dsu.find(*k) == wr && matches!(o.kind, ItemKind::Label { .. }))
                    .filter_map(|(_, o)| match &o.kind {
                        ItemKind::Label { text, .. } => Some(text.clone()),
                        _ => None,
                    })
                    .collect();
                entry_info.push((i, br, names));
            }
        }
        // Join entries on the same bus with the same wire-side member name.
        let mut member_first: HashMap<(usize, String), usize> = HashMap::new();
        for (entry, bus_root, names) in entry_info {
            let Some(members) = bus_groups.get(&bus_root).cloned() else {
                continue;
            };
            for nm in names {
                if members.contains(&nm) {
                    match member_first.get(&(bus_root, nm.clone())) {
                        Some(&first) => dsu.union(first, entry),
                        None => {
                            member_first.insert((bus_root, nm), entry);
                        }
                    }
                }
            }
        }
        // The bus entry itself belongs to the wire side; make sure it is unioned
        // with its wire (point map already did when endpoints coincide).
    }

    // Detach bus entries and bus wires from the wire nets? A bus entry is part
    // of the wire-side net; the bus wire is its own group. Since step 1 only
    // connected buses to bus-entries (allowed), the bus root now contains the
    // entries — split them back out by re-unioning entries only with wires.
    // Simpler: nets are reported from pins only, and bus wires carry no pins,
    // so bus groups never appear as nets by themselves. However an entry
    // connects a wire net to the bus group, which would merge every wire on
    // the bus into one net. To prevent that we never unioned entry<->bus in
    // step 1 for wire nets: fix by excluding Bus/BusEntry adjacency.
    // (Implemented above: BusEntry joins buses in step 2 only for bus
    // membership resolution; we rebuild wire-side unions explicitly.)

    // Collect groups.
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for i in 0..n {
        groups.entry(dsu.find(i)).or_default().push(i);
    }

    let mut nets: Vec<Net> = Vec::new();
    let mut item_map = NetItemMap::default();
    // Item indices of every net, parallel to `nets`.
    let mut item_owners: Vec<Vec<usize>> = Vec::new();
    for (_root, ids) in groups {
        let mut members = BTreeSet::new();
        let mut drivers: Vec<Driver> = Vec::new();
        let mut labels = BTreeSet::new();
        let mut no_connect = false;
        let mut flagged = false;
        let mut powered = false;
        // Pins that offer an auto-generated name, with their `no_connect` type flag.
        let mut auto_names: Vec<(&AutoName, bool)> = Vec::new();
        for &i in &ids {
            let it = &items[i];
            let names = &tree.instances[it.sheet].names;
            match &it.kind {
                ItemKind::Pin {
                    reference,
                    number,
                    kind,
                    auto,
                    power_name,
                    power_local,
                    hidden_from_netlist,
                    ..
                } => {
                    if *hidden_from_netlist && power_name.is_none() {
                        flagged = true;
                    }
                    if *hidden_from_netlist && power_name.is_some() {
                        powered = true;
                    }
                    if !hidden_from_netlist {
                        members.insert(NetMember {
                            sheet: names.clone(),
                            reference: reference.clone(),
                            pin: number.clone(),
                            pin_type: kind.as_str().to_string(),
                        });
                        auto_names.push((auto, *kind == PinType::NoConnect));
                    }
                    if let Some(pn) = power_name {
                        if *power_local {
                            drivers.push(Driver {
                                priority: Priority::LocalPower,
                                name: format!("{names}{}", escape_net_name(pn)),
                                depth: sheet_depth(names),
                            });
                        } else {
                            drivers.push(Driver {
                                priority: Priority::Power,
                                name: escape_net_name(pn),
                                depth: 0,
                            });
                        }
                    }
                }
                ItemKind::Label { text, kind } => {
                    labels.insert(text.clone());
                    if !bus_members(text).is_empty() {
                        continue;
                    }
                    let d = sheet_depth(names);
                    // eeschema escapes every label-derived name
                    // (`CONNECTION_SUBGRAPH::GetNameForDriver`); the sheet path in
                    // front of it is not part of the escaped text.
                    let text = escape_net_name(text);
                    match kind {
                        LabelKind::Global => drivers.push(Driver {
                            priority: Priority::Global,
                            name: text,
                            depth: d,
                        }),
                        LabelKind::Local => drivers.push(Driver {
                            priority: Priority::Local,
                            name: format!("{names}{text}"),
                            depth: d,
                        }),
                        LabelKind::Hierarchical => drivers.push(Driver {
                            priority: Priority::Hier,
                            name: format!("{names}{text}"),
                            depth: d,
                        }),
                    }
                }
                ItemKind::SheetPin { name, .. } => {
                    drivers.push(Driver {
                        priority: Priority::SheetPin,
                        name: format!("{names}{}", escape_net_name(name)),
                        depth: sheet_depth(names),
                    });
                }
                ItemKind::NoConnect => no_connect = true,
                _ => {}
            }
        }
        if members.is_empty() && drivers.is_empty() {
            continue;
        }
        let (name, scope) = if let Some(best) = drivers.iter().max_by(|a, b| {
            a.priority
                .cmp(&b.priority)
                .then_with(|| b.depth.cmp(&a.depth))
                .then_with(|| b.name.cmp(&a.name))
        }) {
            let scope = match best.priority {
                Priority::Power | Priority::Global => NetScope::Global,
                Priority::Local | Priority::LocalPower => NetScope::Local,
                _ => NetScope::Hierarchical,
            };
            (best.name.clone(), scope)
        } else {
            // Nothing names the net: eeschema's lowest driver tier is the pins
            // themselves. Every pin offers `SCH_PIN::GetDefaultNetName` and
            // `CONNECTION_SUBGRAPH::ResolveDrivers` sorts them with `candidate_cmp`:
            // a name containing "-Pad" is low quality and sorts last, then the
            // lexicographically smallest wins.
            // The subgraph reads `unconnected-(...)` when it carries a no-connect,
            // when the pin itself is a `no_connect` pin, or when it holds a single
            // netlist pin (all three measured against kicad-cli 10.0.4).
            let force_nc = no_connect || members.len() <= 1;
            let mut candidates: Vec<String> = auto_names
                .iter()
                .map(|(a, nc)| a.render(force_nc || *nc))
                .collect();
            candidates.sort_by(|a, b| {
                a.contains("-Pad")
                    .cmp(&b.contains("-Pad"))
                    .then_with(|| a.cmp(b))
            });
            match candidates.into_iter().next() {
                Some(n) => (n, NetScope::Unnamed),
                None => continue,
            }
        };
        if members.is_empty() {
            continue;
        }
        // The item map is filled once the names are final (see the uniqueness pass).
        item_owners.push(ids);
        let id = net_id(&members);
        // A local-power driver outranks every other local driver, so a Local net that carries one
        // is named by it.
        let local_power =
            scope == NetScope::Local && drivers.iter().any(|d| d.priority == Priority::LocalPower);
        nets.push(Net {
            name,
            scope,
            members,
            id,
            labels,
            no_connect,
            flagged,
            powered,
            local_power,
        });
    }

    // Auto-generated names are not unique by construction: a multi-unit symbol whose
    // common pin has no name exposes the same `<ref>-Pad<n>` from every placed unit.
    // eeschema disambiguates with a `_1`, `_2`, ... suffix; do the same, in group
    // order, so `by_name` / `pin_map` / the item map never drop a net.
    let mut taken: HashSet<String> = HashSet::new();
    for net in nets.iter_mut() {
        if taken.insert(net.name.clone()) {
            continue;
        }
        // Only auto-generated names are renumbered. A named net that appears twice
        // means two subgraphs that should have merged, and hiding that behind a
        // suffix would invent a net the schematic does not have.
        if is_named(&net.name) {
            continue;
        }
        for k in 1.. {
            let candidate = format!("{}_{k}", net.name);
            if taken.insert(candidate.clone()) {
                net.name = candidate;
                break;
            }
        }
    }
    debug_assert!(
        {
            let auto: Vec<&String> = nets
                .iter()
                .map(|n| &n.name)
                .filter(|n| !is_named(n))
                .collect();
            let uniq: HashSet<&&String> = auto.iter().collect();
            auto.len() == uniq.len()
        },
        "auto-generated net names must be unique"
    );

    for (net, ids) in nets.iter().zip(item_owners.iter()) {
        for &i in ids {
            let it = &items[i];
            let Some(u) = &it.uuid else { continue };
            let path = tree.instances[it.sheet].path.clone();
            match it.kind {
                ItemKind::Wire { .. } | ItemKind::Bus { .. } => {
                    item_map
                        .wires
                        .entry(path)
                        .or_default()
                        .insert(u.clone(), net.name.clone());
                }
                ItemKind::Label { .. } => {
                    item_map
                        .labels
                        .entry(path)
                        .or_default()
                        .insert(u.clone(), net.name.clone());
                }
                ItemKind::SheetPin { .. } => {
                    item_map
                        .sheet_pins
                        .entry(path)
                        .or_default()
                        .insert(u.clone(), net.name.clone());
                }
                // Junctions and no-connect flags are on a net like anything else; the canvas reads
                // them out instead of showing a bare "Junction" with no net.
                ItemKind::Junction => {
                    item_map
                        .junctions
                        .entry(path)
                        .or_default()
                        .insert(u.clone(), net.name.clone());
                }
                ItemKind::NoConnect => {
                    item_map
                        .no_connects
                        .entry(path)
                        .or_default()
                        .insert(u.clone(), net.name.clone());
                }
                _ => {}
            }
        }
    }
    nets.sort_by(|a, b| a.name.cmp(&b.name));
    (Netlist { nets }, item_map)
}

/// KiCad escapes a few characters inside generated net names.
/// False for KiCad auto-names (`Net-(R1-Pad1)`, `unconnected-(...)`).
pub fn is_named(name: &str) -> bool {
    !(name.starts_with("Net-(") || name.starts_with("unconnected-(") || name.is_empty())
}

/// KiCad's `EscapeString( ..., CTX_NETNAME )` (`common/string_utils.cpp`): only `/`
/// is escaped (it separates sheet path segments) and line breaks are dropped.
/// Braces are *not* escaped -- kicad-cli 10.0.4 names a pin `A{B}` net
/// `Net-(U1-A{B})`.
pub fn escape_net_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '/' => out.push_str("{slash}"),
            '\n' | '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// Content-addressed net id: sha256 over sorted `sheet|ref|pin` members.
pub fn net_id(members: &BTreeSet<NetMember>) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for m in members {
        h.update(m.sheet.as_bytes());
        h.update(b"|");
        h.update(m.reference.as_bytes());
        h.update(b"|");
        h.update(m.pin.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())[..16].to_string()
}

/// Convenience: read a project and build nets.
pub fn nets_of(root: &Path) -> std::result::Result<Netlist, sch_read::ReadError> {
    let tree = sch_read::read_project(root)?;
    Ok(build_nets(&tree))
}

// ---------------------------------------------------------------------------
// Net diff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum NetChange {
    Created {
        name: String,
        members: usize,
    },
    Removed {
        name: String,
        members: usize,
    },
    Renamed {
        from: String,
        to: String,
    },
    /// One net's members ended up in two or more nets.
    Split {
        name: String,
        into: Vec<String>,
    },
    /// Members of two or more nets ended up in one net.
    Merged {
        into: String,
        from: Vec<String>,
    },
    MembersChanged {
        name: String,
        added: Vec<NetMember>,
        removed: Vec<NetMember>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NetDiff {
    pub changes: Vec<NetChange>,
    /// True when a named (non-unnamed) net was split or merged.
    pub has_risk: bool,
}

impl NetDiff {
    pub fn summary(&self) -> (usize, usize, usize, usize) {
        let mut s = (0, 0, 0, 0);
        for c in &self.changes {
            match c {
                NetChange::Split { .. } => s.0 += 1,
                NetChange::Merged { .. } => s.1 += 1,
                NetChange::Created { .. } => s.2 += 1,
                NetChange::Removed { .. } => s.3 += 1,
                _ => {}
            }
        }
        s
    }
}

/// Diff two netlists by pin membership. Pins are matched by (sheet, ref, pin).
pub fn diff_nets(before: &Netlist, after: &Netlist) -> NetDiff {
    let bmap = before.pin_map();
    let amap = after.pin_map();
    let mut changes = Vec::new();
    let mut has_risk = false;

    // For each before-net, which after-nets do its members land in?
    let mut before_to_after: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (pin, bname) in &bmap {
        if let Some(aname) = amap.get(pin) {
            before_to_after
                .entry(bname.clone())
                .or_default()
                .insert(aname.clone());
        }
    }
    let mut after_to_before: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (pin, aname) in &amap {
        if let Some(bname) = bmap.get(pin) {
            after_to_before
                .entry(aname.clone())
                .or_default()
                .insert(bname.clone());
        }
    }
    let is_named = |n: &str| !n.starts_with("Net-(") && !n.starts_with("unconnected-(");

    for (b, afters) in &before_to_after {
        if afters.len() > 1 {
            let into: Vec<String> = afters.iter().cloned().collect();
            if is_named(b) {
                has_risk = true;
            }
            changes.push(NetChange::Split {
                name: b.clone(),
                into,
            });
        }
    }
    for (a, befores) in &after_to_before {
        if befores.len() > 1 {
            let from: Vec<String> = befores.iter().cloned().collect();
            if befores.iter().filter(|n| is_named(n)).count() >= 2 {
                has_risk = true;
            }
            changes.push(NetChange::Merged {
                into: a.clone(),
                from,
            });
        }
    }
    // Renames: one-to-one mapping with different names.
    for (b, afters) in &before_to_after {
        if afters.len() == 1 {
            let a = afters.iter().next().unwrap();
            if a != b
                && after_to_before
                    .get(a)
                    .map(|s| s.len() == 1)
                    .unwrap_or(false)
            {
                changes.push(NetChange::Renamed {
                    from: b.clone(),
                    to: a.clone(),
                });
            }
        }
    }
    // Created / removed / member changes.
    for n in &after.nets {
        if !after_to_before.contains_key(&n.name) {
            changes.push(NetChange::Created {
                name: n.name.clone(),
                members: n.members.len(),
            });
        }
    }
    for n in &before.nets {
        if !before_to_after.contains_key(&n.name) {
            changes.push(NetChange::Removed {
                name: n.name.clone(),
                members: n.members.len(),
            });
        }
    }
    for n in &after.nets {
        if let Some(bn) = before.by_name(&n.name) {
            let added: Vec<NetMember> = n.members.difference(&bn.members).cloned().collect();
            let removed: Vec<NetMember> = bn.members.difference(&n.members).cloned().collect();
            if !added.is_empty() || !removed.is_empty() {
                changes.push(NetChange::MembersChanged {
                    name: n.name.clone(),
                    added,
                    removed,
                });
            }
        }
    }
    NetDiff { changes, has_risk }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bus_label_expansion() {
        assert_eq!(bus_members("D[0..3]"), vec!["D0", "D1", "D2", "D3"]);
        assert_eq!(bus_members("{A B C}"), vec!["A", "B", "C"]);
        assert_eq!(bus_members("USB{DP DM}"), vec!["USB.DP", "USB.DM"]);
        assert!(bus_members("GND").is_empty());
    }

    #[test]
    fn segment_test() {
        assert!(on_segment(Pt::new(5, 0), Pt::new(0, 0), Pt::new(10, 0)));
        assert!(!on_segment(Pt::new(5, 1), Pt::new(0, 0), Pt::new(10, 0)));
        assert!(!on_segment(Pt::new(11, 0), Pt::new(0, 0), Pt::new(10, 0)));
    }
}
