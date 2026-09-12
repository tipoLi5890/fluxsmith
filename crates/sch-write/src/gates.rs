// SPDX-License-Identifier: Apache-2.0
//! Integrity gates (the nine checks that run before any write) and layout
//! checks. Findings are structured; severities decide whether a write is
//! refused.

use sch_model::*;
use sch_net::Netlist;
use sch_read::bbox::{
    label_flag_bbox, symbol_bbox, symbol_field_boxes, symbol_graphics_bbox, BBox,
};
use sch_read::SheetTree;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
    /// Sheet file the finding sits in, relative to the project root (`sub/sub.kicad_sch`). `sheet`
    /// is the instance names path, which does not name a file when one file is instantiated twice;
    /// this does. Absent when the emitting check has no file at hand.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub refs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_mil: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    /// What the check measured, in machine-readable form, so a repair can name its target instead
    /// of re-deriving it from the English message: the object in the way, the baseline to move to,
    /// the axis to move along. Facts only — the engine still owns the verdict, and a caller that
    /// ignores this map sees exactly the finding it saw before (red line 6).
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub evidence: BTreeMap<String, serde_json::Value>,
    /// Stable location key used for fingerprints and "introduced" comparison.
    pub location: String,
}

fn finding(
    code: &str,
    sev: Severity,
    msg: impl Into<String>,
    sheet: &str,
    location: String,
) -> Finding {
    Finding {
        code: code.into(),
        severity: sev,
        message: msg.into(),
        sheet: Some(sheet.to_string()),
        file: None,
        refs: vec![],
        at_mil: None,
        remediation: None,
        evidence: BTreeMap::new(),
        location,
    }
}

/// An evidence map from `(key, value)` pairs, for the `..finding(..)` update syntax.
fn ev<const N: usize>(
    pairs: [(&str, serde_json::Value); N],
) -> BTreeMap<String, serde_json::Value> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// The axis along which two boxes overlap least — the shorter way out of a collision.
fn least_overlap_axis(a: &BBox, b: &BBox) -> &'static str {
    let x = (a.max.x.min(b.max.x) - a.min.x.max(b.min.x)).max(0);
    let y = (a.max.y.min(b.max.y) - a.min.y.max(b.min.y)).max(0);
    if x <= y {
        "x"
    } else {
        "y"
    }
}

/// Fill `file` on every finding whose `sheet` names an instance of the tree. The checks all anchor
/// their findings on `inst.names`, which is one-to-one with a sheet file, so this resolves the file
/// once per family instead of threading it through every emitting site. Findings that already carry
/// a file (the ones that know it exactly) and findings without a sheet are left alone.
pub fn attach_files(tree: &SheetTree, findings: &mut [Finding]) {
    if findings
        .iter()
        .all(|f| f.file.is_some() || f.sheet.is_none())
    {
        return;
    }
    let by_names = tree.files_by_names();
    for f in findings.iter_mut() {
        if f.file.is_some() {
            continue;
        }
        if let Some(name) = f.sheet.as_deref() {
            f.file = by_names.get(name).cloned();
        }
    }
}

/// Is this symbol a power port rather than a part — no footprint, no BOM line, no unit count to
/// reconcile? Three signals the file itself carries, any one of which settles it: the library
/// symbol's own `(power)` flag, the stock `power:` library it was placed from (a symbol whose
/// `lib_symbols` entry has gone missing still says where it came from), and KiCad's `#` reference
/// convention. One definition, so the write handlers and the delivery gate agree on what a port is.
pub fn is_power_symbol(sheet: &Sheet, s: &SymbolInst) -> bool {
    s.reference.starts_with('#')
        || s.lib_id.starts_with("power:")
        || sheet
            .lib_symbol(&s.lib_id)
            .map(|l| l.is_power)
            .unwrap_or(false)
}

fn mil(p: Pt) -> [f64; 2] {
    [nm_to_mil(p.x), nm_to_mil(p.y)]
}

/// The rotation (file degrees) at which a power port stands upright: the one of the four that turns
/// its pin's toward-body direction — the library pin `angle` — into straight down for a GND-class
/// port (body below the pin) or straight up for a rail (body above), keeping the mirror the symbol
/// already carries. Computed through the engine's one `transform_point` (red line 3), never a table
/// of its own; `None` only for a pin drawn off the four axes, which no KiCad power symbol has.
pub fn upright_port_rotation(pin_angle: i64, mirror: Mirror, ground: bool) -> Option<i64> {
    let toward_body = match pin_angle.rem_euclid(360) {
        0 => Pt { x: 1, y: 0 },
        90 => Pt { x: 0, y: 1 },
        180 => Pt { x: -1, y: 0 },
        270 => Pt { x: 0, y: -1 },
        _ => return None,
    };
    [Rot::R0, Rot::R90, Rot::R180, Rot::R270]
        .into_iter()
        .find(|&rot| {
            // World +Y is down: a body below the pin is +y, a body above is -y.
            let d = transform_point(
                toward_body,
                Placement {
                    at: Pt { x: 0, y: 0 },
                    rot,
                    mirror,
                },
            );
            d.x == 0 && if ground { d.y > 0 } else { d.y < 0 }
        })
        .map(Rot::deg)
}

/// How far from a text's own anchor a wire has to run before it counts as running *through* the
/// text rather than being the stub the text is attached to. Every label sits on a wire end by
/// definition and every power port sits on the wire it drives, so without this exemption the
/// rule would report every label on the sheet. 50 mil is one connection-grid step: the shortest
/// stub eeschema will draw.
const TEXT_STUB_MIL: f64 = 50.0;

/// How close two labels of one name have to be before a wire is the drafting norm
/// (`LABEL_PAIR_SHOULD_BE_WIRE`). 500 mil is ten connection-grid steps: a line a reader follows
/// in one glance, far shorter than the 1500 mil at which `LONG_WIRE` asks for a label instead.
const LABEL_PAIR_NEAR_MIL: f64 = 500.0;

/// The part of the segment `a`-`b` that lies inside `bx`, as its two endpoints, or None when the
/// segment misses the box. Liang-Barsky in nm, with the box edges counting as inside: a text
/// whose baseline runs along a wire is exactly the case the text rules are looking for, and it
/// touches the box edge rather than crossing it.
fn clip_segment(a: Pt, b: Pt, bx: &BBox) -> Option<(Pt, Pt)> {
    let (dx, dy) = ((b.x - a.x) as f64, (b.y - a.y) as f64);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [
        (-dx, (a.x - bx.min.x) as f64),
        (dx, (bx.max.x - a.x) as f64),
        (-dy, (a.y - bx.min.y) as f64),
        (dy, (bx.max.y - a.y) as f64),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
            continue;
        }
        let r = q / p;
        if p < 0.0 {
            if r > t1 {
                return None;
            }
            if r > t0 {
                t0 = r;
            }
        } else {
            if r < t0 {
                return None;
            }
            if r < t1 {
                t1 = r;
            }
        }
    }
    let at = |t: f64| {
        Pt::new(
            (a.x as f64 + t * dx).round() as Nm,
            (a.y as f64 + t * dy).round() as Nm,
        )
    };
    Some((at(t0), at(t1)))
}

/// Whether `p` is further than [`TEXT_STUB_MIL`] from every one of `anchors`.
fn off_stub(p: Pt, anchors: &[Pt]) -> bool {
    let stub = mil_to_nm(TEXT_STUB_MIL);
    anchors.iter().all(|a| {
        let (dx, dy) = ((p.x - a.x) as f64, (p.y - a.y) as f64);
        dx * dx + dy * dy > (stub as f64) * (stub as f64)
    })
}

/// The first wire that runs through `bx` somewhere further than [`TEXT_STUB_MIL`] from every
/// anchor in `anchors` — that is, a wire drawn under a text rather than the stub the text names.
fn wire_through<'a>(wires: &'a [Wire], bx: &BBox, anchors: &[Pt]) -> Option<&'a Wire> {
    if bx.is_empty() {
        return None;
    }
    wires.iter().find(|w| {
        clip_segment(w.a, w.b, bx)
            .is_some_and(|(p, q)| off_stub(p, anchors) || off_stub(q, anchors))
    })
}

/// Run the nine integrity checks over a whole tree.
pub fn integrity(tree: &SheetTree) -> Vec<Finding> {
    let mut out = Vec::new();
    // Project-wide designator table: (reference, unit) -> count (excluding '#')
    let mut designators: BTreeMap<(String, u32), Vec<String>> = BTreeMap::new();

    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let sname = inst.names.clone();
        let file_label = inst
            .file
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default();

        // connection points
        let mut points: HashMap<Pt, Vec<&str>> = HashMap::new();
        let mut add = |p: Pt, what: &'static str| points.entry(p).or_default().push(what);
        let mut power_at: HashMap<Pt, Vec<String>> = HashMap::new();
        let mut uuids: HashMap<&str, usize> = HashMap::new();
        for s in &sheet.symbols {
            *uuids.entry(s.uuid.as_str()).or_default() += 1;
            let reference = s
                .instances
                .iter()
                .find(|r| r.path == inst.path)
                .map(|r| r.reference.clone())
                .unwrap_or_else(|| s.reference.clone());
            match sheet.lib_symbol(&s.lib_id) {
                None => out.push(Finding {
                    refs: vec![reference.clone()],
                    ..finding(
                        "UNRESOLVED_LIB_ID",
                        Severity::Error,
                        format!(
                            "{}: lib_id {} not in lib_symbols cache",
                            reference, s.lib_id
                        ),
                        &sname,
                        format!("symbol:{}", s.uuid),
                    )
                }),
                Some(lib) => {
                    for p in world_pins(s, lib) {
                        add(p.at, "pin");
                        if lib.is_power || reference.starts_with('#') {
                            power_at.entry(p.at).or_default().push(reference.clone());
                        }
                    }
                }
            }
            if !reference.starts_with('#') && !reference.is_empty() {
                designators
                    .entry((reference.clone(), s.unit))
                    .or_default()
                    .push(sname.clone());
            }
            // instances path validation: must start with the root uuid path
            for r in &s.instances {
                if !r.path.starts_with(&format!("/{}", tree.root_uuid)) {
                    out.push(Finding {
                        refs: vec![reference.clone()],
                        ..finding(
                            "INVALID_INSTANCES_PATH",
                            Severity::Error,
                            format!(
                                "{}: instances path {} does not start with /{}",
                                reference, r.path, tree.root_uuid
                            ),
                            &sname,
                            format!("instances:{}:{}", s.uuid, r.path),
                        )
                    });
                }
            }
        }
        for w in &sheet.wires {
            *uuids.entry(w.uuid.as_str()).or_default() += 1;
            add(w.a, if w.is_bus { "bus" } else { "wire" });
            add(w.b, if w.is_bus { "bus" } else { "wire" });
        }
        for l in &sheet.labels {
            *uuids.entry(l.uuid.as_str()).or_default() += 1;
            add(l.at, "label");
        }
        for j in &sheet.junctions {
            *uuids.entry(j.uuid.as_str()).or_default() += 1;
            add(j.at, "junction");
        }
        for n in &sheet.no_connects {
            *uuids.entry(n.uuid.as_str()).or_default() += 1;
            add(n.at, "no_connect");
        }
        for e in &sheet.bus_entries {
            *uuids.entry(e.uuid.as_str()).or_default() += 1;
            add(e.at, "bus_entry");
            add(e.end(), "bus_entry");
        }
        for sh in &sheet.sheets {
            *uuids.entry(sh.uuid.as_str()).or_default() += 1;
            for p in &sh.pins {
                add(p.at, "sheet_pin");
            }
            let dir = inst.file.parent().unwrap_or(std::path::Path::new("."));
            if !dir.join(&sh.file).exists() {
                out.push(finding(
                    "SHEET_FILE_MISSING",
                    Severity::Error,
                    format!("sheet {} references missing file {}", sh.name, sh.file),
                    &sname,
                    format!("sheet:{}", sh.uuid),
                ));
            }
        }

        // duplicate uuids
        for (u, c) in &uuids {
            if *c > 1 && !u.is_empty() {
                out.push(finding(
                    "DUPLICATE_UUID",
                    Severity::Error,
                    format!("uuid {u} appears {c} times in {file_label}"),
                    &sname,
                    format!("uuid:{u}"),
                ));
            }
        }

        // dangling wire endpoints: an endpoint connects if something else is at
        // the exact point, or it lies on the interior of another wire with a
        // junction there.
        let on_seg = |p: Pt, a: Pt, b: Pt| {
            let cross = (b.x - a.x) as i128 * (p.y - a.y) as i128
                - (b.y - a.y) as i128 * (p.x - a.x) as i128;
            cross == 0
                && p.x >= a.x.min(b.x)
                && p.x <= a.x.max(b.x)
                && p.y >= a.y.min(b.y)
                && p.y <= a.y.max(b.y)
        };
        for w in &sheet.wires {
            for end in [w.a, w.b] {
                let others = points.get(&end).map(|v| v.len()).unwrap_or(0);
                // this wire contributes one entry for this endpoint (two if a==b)
                let self_count = if w.a == w.b { 2 } else { 1 };
                let connected = others > self_count
                    || sheet.labels.iter().any(|l| l.at == end)
                    || sheet.junctions.iter().any(|j| j.at == end)
                    || sheet.wires.iter().any(|o| {
                        o.uuid != w.uuid
                            && o.is_bus == w.is_bus
                            && on_seg(end, o.a, o.b)
                            && sheet.junctions.iter().any(|j| j.at == end)
                    });
                if !connected {
                    // Deliberately stricter than eeschema, which files this as the
                    // `unconnected_wire_endpoint` *warning*: this is a write gate, and a wire the
                    // engine itself drew to nowhere is a drafting bug, not a style opinion. The
                    // gate refuses the write so the agent has to finish the connection (see
                    // docs/error-codes.md, integrity ERROR list).
                    let code = if w.is_bus {
                        "DANGLING_BUS"
                    } else {
                        "DANGLING_ENDPOINT"
                    };
                    out.push(Finding {
                        at_mil: Some(mil(end)),
                        remediation: Some(
                            "end the wire on a pin, a wire end, a label or add a junction".into(),
                        ),
                        ..finding(
                            code,
                            Severity::Error,
                            format!(
                                "{} endpoint at {} connects to nothing",
                                if w.is_bus { "bus" } else { "wire" },
                                end
                            ),
                            &sname,
                            format!("wire:{}:{}:{}", w.uuid, end.x, end.y),
                        )
                    });
                }
            }
        }
        // bus entries: one end on a bus, the other on a wire/label/pin
        for e in &sheet.bus_entries {
            let on_bus = |p: Pt| sheet.wires.iter().any(|b| b.is_bus && on_seg(p, b.a, b.b));
            let on_wire = |p: Pt| {
                sheet
                    .wires
                    .iter()
                    .any(|b| !b.is_bus && (b.a == p || b.b == p))
                    || sheet.labels.iter().any(|l| l.at == p)
                    || points.get(&p).map(|v| v.contains(&"pin")).unwrap_or(false)
            };
            let ok = (on_bus(e.at) && on_wire(e.end())) || (on_bus(e.end()) && on_wire(e.at));
            if !ok {
                out.push(Finding {
                    at_mil: Some(mil(e.at)),
                    ..finding(
                        "DANGLING_BUS_ENTRY",
                        Severity::Error,
                        format!(
                            "bus entry at {} must touch a bus on one end and a wire on the other",
                            e.at
                        ),
                        &sname,
                        format!("bus_entry:{}", e.uuid),
                    )
                });
            }
        }
        // stacked power ports
        for (p, refs) in &power_at {
            if refs.len() > 1 {
                out.push(Finding {
                    at_mil: Some(mil(*p)),
                    refs: refs.clone(),
                    ..finding(
                        "POWER_PORT_STACKED",
                        Severity::Error,
                        format!("{} power ports share the point {}", refs.len(), p),
                        &sname,
                        format!("power:{}:{}", p.x, p.y),
                    )
                });
            }
        }
        // no_connect conflicts
        for n in &sheet.no_connects {
            let kinds = points.get(&n.at).cloned().unwrap_or_default();
            if kinds.iter().any(|k| matches!(*k, "wire" | "label")) {
                out.push(Finding {
                    at_mil: Some(mil(n.at)),
                    ..finding(
                        "NO_CONNECT_CONFLICT",
                        Severity::Warning,
                        format!("no-connect at {} also has a wire or label", n.at),
                        &sname,
                        format!("no_connect:{}", n.uuid),
                    )
                });
            }
        }
    }
    // duplicate designators (same ref + unit in more than one place, or twice on one sheet)
    for ((r, u), sheets) in designators {
        if sheets.len() > 1 {
            let set: HashSet<&String> = sheets.iter().collect();
            let code = if set.len() > 1 {
                "DUPLICATE_DESIGNATOR_PROJECT"
            } else {
                "DUPLICATE_DESIGNATOR"
            };
            out.push(Finding {
                refs: vec![r.clone()],
                ..finding(
                    code,
                    Severity::Error,
                    format!("{r} unit {u} appears {} times", sheets.len()),
                    &sheets[0],
                    format!("designator:{r}:{u}"),
                )
            });
        }
    }
    out.sort_by(|a, b| a.location.cmp(&b.location).then(a.code.cmp(&b.code)));
    out.dedup();
    attach_files(tree, &mut out);
    out
}

/// Findings in `after` whose (code, location) did not exist in `before`.
pub fn introduced<'a>(before: &[Finding], after: &'a [Finding]) -> Vec<&'a Finding> {
    let seen: HashSet<(&str, &str)> = before
        .iter()
        .map(|f| (f.code.as_str(), f.location.as_str()))
        .collect();
    after
        .iter()
        .filter(|f| !seen.contains(&(f.code.as_str(), f.location.as_str())))
        .collect()
}

/// Fingerprint used by the Fixer loop to detect stalls: sha256 of the sorted
/// (code, location) pairs of ERROR findings.
pub fn fingerprint(findings: &[Finding]) -> String {
    use sha2::{Digest, Sha256};
    let mut keys: Vec<String> = findings
        .iter()
        .filter(|f| f.severity == Severity::Error)
        .map(|f| format!("{}|{}", f.code, f.location))
        .collect();
    keys.sort();
    hex::encode(Sha256::digest(keys.join("\n").as_bytes()))[..16].to_string()
}

/// Paper sizes in nm (width, height), landscape.
pub fn paper_size(paper: &str) -> Option<(Nm, Nm)> {
    let mm = |w: f64, h: f64| Some((mm_to_nm(w), mm_to_nm(h)));
    match paper {
        "A5" => mm(210.0, 148.0),
        "A4" => mm(297.0, 210.0),
        "A3" => mm(420.0, 297.0),
        "A2" => mm(594.0, 420.0),
        "A1" => mm(841.0, 594.0),
        "A0" => mm(1189.0, 841.0),
        "A" => mm(279.4, 215.9),
        "B" => mm(431.8, 279.4),
        "C" => mm(558.8, 431.8),
        "D" => mm(863.6, 558.8),
        "E" => mm(1117.6, 863.6),
        "USLetter" => mm(279.4, 215.9),
        "USLegal" => mm(355.6, 215.9),
        "USLedger" => mm(431.8, 279.4),
        _ => None,
    }
}

/// Inset (mil) of the drawing area from the paper edge on the left, right and top: KiCad's
/// worksheet draws its frame there, and anything written under it is unreadable on a printed or
/// exported sheet.
pub const FRAME_INSET_MIL: f64 = 500.0;
/// Inset (mil) at the bottom edge, where the title block sits.
pub const FRAME_BOTTOM_INSET_MIL: f64 = 1500.0;

/// The rectangle of `paper` that drawing may occupy, in nm — the paper size minus the worksheet
/// frame and title block. **The single definition of the drawing border**: the placement nudge
/// ([`crate::handlers`]) picks spots inside it and this gate reports what leaves it, so the two
/// can never disagree about where the page ends. None when the paper name is not a known size.
pub fn drawing_border(paper: &str) -> Option<BBox> {
    paper_size(paper).map(|(w, h)| BBox {
        min: Pt::new(mil_to_nm(FRAME_INSET_MIL), mil_to_nm(FRAME_INSET_MIL)),
        max: Pt::new(
            w - mil_to_nm(FRAME_INSET_MIL),
            h - mil_to_nm(FRAME_BOTTOM_INSET_MIL),
        ),
    })
}

/// Share of the drawing border a sheet has to fill before `PAGE_UNDERUSED` stops looking at it.
const PAGE_USED_MIN: f64 = 0.10;
/// How far off the middle of the page (as a share of the page's own width or height) the drawing's
/// centre has to sit before an under-filled sheet reads as a block parked in a corner rather than
/// a small circuit deliberately centred.
const PAGE_OFF_CENTRE: f64 = 0.10;

/// Everything drawn on one sheet, as one box: symbol bodies, label flags, wire and bus ends,
/// junctions, no-connects, bus entries and child sheet symbols. Empty when the sheet is blank.
fn drawn_bbox(doc: &kicad_sexpr::Document, sheet: &sch_model::Sheet) -> BBox {
    let mut b = BBox::empty();
    for s in &sheet.symbols {
        if let Some(sb) = symbol_bbox(doc, s) {
            b.union(&sb);
        }
        for (_, tb) in symbol_field_boxes(doc, s) {
            b.union(&tb);
        }
    }
    for l in &sheet.labels {
        let kind = match l.kind {
            LabelKind::Local => "local",
            LabelKind::Global => "global",
            LabelKind::Hierarchical => "hierarchical",
        };
        b.union(&label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0));
    }
    for w in &sheet.wires {
        b.include(w.a);
        b.include(w.b);
    }
    for j in &sheet.junctions {
        b.include(j.at);
    }
    for n in &sheet.no_connects {
        b.include(n.at);
    }
    for e in &sheet.bus_entries {
        b.include(e.at);
        b.include(e.end());
    }
    for sh in &sheet.sheets {
        b.include(sh.at);
        b.include(sh.at.add(sh.size));
    }
    b
}

/// Layout gate: symbols, labels and wires that leave the drawing border ([`drawing_border`]) or
/// the paper, plus `PAGE_UNDERUSED` (Info) for a sheet whose whole drawing sits in one corner of
/// it. Off the border is a Warning — the object is on the page but under the worksheet
/// frame or the title block, which is a layout mistake a human fixes, not a broken file. Off the
/// paper is an Error: an anchor outside the sheet (KiCad's own coordinates start at the top-left
/// corner) or a body with nothing on the page at all.
pub fn layout(tree: &SheetTree) -> Vec<Finding> {
    let mut out = Vec::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let doc = &tree.docs[&inst.file];
        let Some((w, h)) = paper_size(&sheet.paper) else {
            continue;
        };
        let paper = BBox {
            min: Pt::new(0, 0),
            max: Pt::new(w, h),
        };
        let border = drawing_border(&sheet.paper).unwrap_or(paper);
        let inside = |p: Pt| paper.contains(p);
        // A box that is on the paper but not wholly inside the border: the warning case.
        let off_border = |b: &BBox| !b.is_empty() && !border.contains_box(b);
        let border_note = format!(
            "the drawing border of the {} sheet (x {:.0}..{:.0}, y {:.0}..{:.0} mil)",
            sheet.paper,
            nm_to_mil(border.min.x),
            nm_to_mil(border.max.x),
            nm_to_mil(border.min.y),
            nm_to_mil(border.max.y)
        );
        for s in &sheet.symbols {
            let body = symbol_bbox(doc, s);
            let off_paper = !inside(s.placement.at) || body.is_some_and(|b| !b.intersects(&paper));
            if off_paper {
                out.push(Finding {
                    refs: vec![s.reference.clone()],
                    at_mil: Some(mil(s.placement.at)),
                    ..finding(
                        "OUT_OF_FRAME",
                        Severity::Error,
                        format!(
                            "{} at {} is outside the {} frame",
                            s.reference, s.placement.at, sheet.paper
                        ),
                        &inst.names,
                        format!("frame:{}", s.uuid),
                    )
                });
                continue;
            }
            if body.is_some_and(|b| off_border(&b)) {
                out.push(Finding {
                    refs: vec![s.reference.clone()],
                    at_mil: Some(mil(s.placement.at)),
                    remediation: Some(
                        "move it inside the border (move_component) or re-lay the block (arrange_group)"
                            .into(),
                    ),
                    ..finding(
                        "OUT_OF_FRAME",
                        Severity::Warning,
                        format!(
                            "{} at {} runs outside {border_note}",
                            s.reference, s.placement.at
                        ),
                        &inst.names,
                        format!("border:{}", s.uuid),
                    )
                });
            }
        }
        for l in &sheet.labels {
            if !inside(l.at) {
                out.push(finding(
                    "OUT_OF_FRAME",
                    Severity::Error,
                    format!("label {} at {} is outside the frame", l.text, l.at),
                    &inst.names,
                    format!("frame:{}", l.uuid),
                ));
                continue;
            }
            let kind = match l.kind {
                LabelKind::Local => "local",
                LabelKind::Global => "global",
                LabelKind::Hierarchical => "hierarchical",
            };
            let b = label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0);
            if off_border(&b) {
                out.push(Finding {
                    at_mil: Some(mil(l.at)),
                    remediation: Some("move the label inside the border".into()),
                    ..finding(
                        "OUT_OF_FRAME",
                        Severity::Warning,
                        format!("label {} at {} runs outside {border_note}", l.text, l.at),
                        &inst.names,
                        format!("border:{}", l.uuid),
                    )
                });
            }
        }
        for wire in &sheet.wires {
            let mut b = BBox::empty();
            b.include(wire.a);
            b.include(wire.b);
            let kind = if wire.is_bus { "bus" } else { "wire" };
            if !inside(wire.a) && !inside(wire.b) {
                out.push(Finding {
                    at_mil: Some(mil(wire.a)),
                    ..finding(
                        "OUT_OF_FRAME",
                        Severity::Error,
                        format!(
                            "{kind} {} - {} is outside the {} frame",
                            wire.a, wire.b, sheet.paper
                        ),
                        &inst.names,
                        format!("frame:{}", wire.uuid),
                    )
                });
                continue;
            }
            if off_border(&b) {
                out.push(Finding {
                    at_mil: Some(mil(wire.a)),
                    remediation: Some("route it inside the border".into()),
                    ..finding(
                        "OUT_OF_FRAME",
                        Severity::Warning,
                        format!("{kind} {} - {} runs outside {border_note}", wire.a, wire.b),
                        &inst.names,
                        format!("border:{}", wire.uuid),
                    )
                });
            }
        }
        // Page use: everything drawn on the sheet crowded into one corner of an otherwise empty
        // page. Info, and never fixed automatically — a small circuit is not a mistake, and the
        // two remedies (spread the blocks out, or choose a smaller paper) are the author's call.
        // Both halves have to hold: a small block in the middle of the page is a drawing, a small
        // block in a corner is a sheet nobody laid out.
        let drawn = drawn_bbox(doc, sheet);
        let side = |b: &BBox, vertical: bool| {
            nm_to_mil(if vertical {
                b.max.y - b.min.y
            } else {
                b.max.x - b.min.x
            })
        };
        let page = side(&border, false) * side(&border, true);
        if !drawn.is_empty() && page > 0.0 {
            let used = side(&drawn, false) * side(&drawn, true) / page;
            let off = |vertical: bool| {
                let (d, f) = if vertical {
                    (drawn.min.y + drawn.max.y, border.min.y + border.max.y)
                } else {
                    (drawn.min.x + drawn.max.x, border.min.x + border.max.x)
                };
                nm_to_mil((d - f) / 2).abs() / side(&border, vertical)
            };
            let off_centre = off(false).max(off(true));
            if used < PAGE_USED_MIN && off_centre > PAGE_OFF_CENTRE {
                out.push(Finding {
                    at_mil: Some(mil(drawn.min)),
                    remediation: Some(
                        "spread the blocks over the sheet (arrange_group) or move them toward the middle (move_component); a smaller sheet is the other answer, and only a human chooses that"
                            .into(),
                    ),
                    ..finding(
                        "PAGE_UNDERUSED",
                        Severity::Info,
                        format!(
                            "the drawing fills {:.1}% of {border_note} and its centre is {:.0}% of the page away from the middle",
                            used * 100.0,
                            off_centre * 100.0
                        ),
                        &inst.names,
                        format!("page:{}", inst.path),
                    )
                });
            }
        }
    }
    out.extend(overlap(tree));
    attach_files(tree, &mut out);
    out
}

/// Overlap findings for the layout gate. Symbol bodies (graphics + pin stubs)
/// of two different symbols must not intersect (`GROUP_OVERLAP` for two
/// regular parts, `SYMBOL_OVERLAP` when a power symbol is involved); label
/// text must not run over a foreign body (`LABEL_OVER_BODY`); two labels
/// should not overlap (`LABEL_OVERLAP`, warning). Boxes are shrunk by 10 mil
/// so touching pin tips do not count.
///
/// The text rules live here too, because KiCad's own ERC has no geometric text check at all —
/// nothing else in the pipeline can see these:
/// `TEXT_OVERLAP` (a field over a foreign body *or one of its pin leads*, or over a label),
/// `FIELD_OVER_OWN_BODY` (an autoplaced field inside its own symbol outline),
/// `FIELD_OVER_FIELD` (two symbols' fields on top of each other),
/// `LABEL_OVER_WIRE` (a net name — a label, or a power port's Value — with a wire drawn along or
/// through it) and `LABEL_PAIR_SHOULD_BE_WIRE` (the same name written twice a short clear run
/// apart, Info). All warnings but the last.
pub fn overlap(tree: &SheetTree) -> Vec<Finding> {
    let mut out = Vec::new();
    let shrink = -mil_to_nm(10.0);
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let doc = &tree.docs[&inst.file];
        // (reference, full box incl. pins, graphics-only box, is_power)
        let boxes: Vec<(String, BBox, BBox, bool)> = sheet
            .symbols
            .iter()
            .filter_map(|s| {
                let b = symbol_bbox(doc, s)?;
                let g = symbol_graphics_bbox(doc, s).unwrap_or(b);
                (b.min != b.max).then_some((
                    s.reference.clone(),
                    b,
                    g,
                    s.reference.starts_with('#'),
                ))
            })
            .collect();
        // Pin tips per reference: a power symbol whose pin sits exactly on another
        // symbol's pin is connected to it by design, never "overlapping" it.
        let pin_tips: HashMap<String, Vec<Pt>> = sheet
            .symbols
            .iter()
            .filter_map(|s| {
                let lib = sheet.lib_symbol(&s.lib_id)?;
                Some((
                    s.reference.clone(),
                    world_pins(s, lib).into_iter().map(|p| p.at).collect(),
                ))
            })
            .collect();
        // A PWR_FLAG hangs beside the rail symbol it drives by design (KiCad's own convention):
        // flag-vs-power-symbol proximity is never an overlap finding.
        let flags: std::collections::HashSet<String> = sheet
            .symbols
            .iter()
            .filter(|s| s.lib_id.ends_with(":PWR_FLAG") || s.value == "PWR_FLAG")
            .map(|s| s.reference.clone())
            .collect();
        // The line each pin draws from its tip to the body. A symbol's bounding box is a rectangle
        // and most symbols leave a lot of it blank — a two-plate capacitor draws ink in a band
        // across the middle and a line out of each end — so a text is tested against the graphics
        // *and* against these leads, never against the rectangle that merely contains both. The
        // lead is reconstructed as the segment from the tip to the nearest point of the body,
        // which is where the pin points by construction.
        let stubs: HashMap<String, Vec<(Pt, Pt)>> = sheet
            .symbols
            .iter()
            .filter_map(|s| {
                let lib = sheet.lib_symbol(&s.lib_id)?;
                let g = symbol_graphics_bbox(doc, s)?;
                Some((
                    s.reference.clone(),
                    world_pins(s, lib)
                        .into_iter()
                        .map(|p| {
                            (
                                p.at,
                                Pt::new(
                                    p.at.x.clamp(g.min.x, g.max.x),
                                    p.at.y.clamp(g.min.y, g.max.y),
                                ),
                            )
                        })
                        .collect(),
                ))
            })
            .collect();
        let shares_pin = |a: &str, b: &str| -> bool {
            match (pin_tips.get(a), pin_tips.get(b)) {
                (Some(pa), Some(pb)) => pa.iter().any(|x| pb.contains(x)),
                _ => false,
            }
        };
        for i in 0..boxes.len() {
            for j in i + 1..boxes.len() {
                if boxes[i].0 == boxes[j].0 {
                    continue;
                }
                let power = boxes[i].3 || boxes[j].3;
                if power && shares_pin(&boxes[i].0, &boxes[j].0) {
                    continue;
                }
                if boxes[i].3
                    && boxes[j].3
                    && (flags.contains(&boxes[i].0) || flags.contains(&boxes[j].0))
                {
                    continue;
                }
                // A power symbol sits on a pin tip by design: compare it with
                // the other symbol's graphics only, not its pin stubs.
                let (a, b) = if power {
                    (boxes[i].2.expand(shrink), boxes[j].2.expand(shrink))
                } else {
                    (boxes[i].1.expand(shrink), boxes[j].1.expand(shrink))
                };
                if !a.intersects(&b) {
                    continue;
                }
                let code = if power {
                    "SYMBOL_OVERLAP"
                } else {
                    "GROUP_OVERLAP"
                };
                out.push(Finding {
                    refs: vec![boxes[i].0.clone(), boxes[j].0.clone()],
                    at_mil: Some([
                        nm_to_mil(a.min.x.max(b.min.x)),
                        nm_to_mil(a.min.y.max(b.min.y)),
                    ]),
                    remediation: Some(
                        "move one of them (move_component) or re-lay the block (arrange_group)"
                            .into(),
                    ),
                    ..finding(
                        code,
                        Severity::Error,
                        format!("{} and {} overlap", boxes[i].0, boxes[j].0),
                        &inst.names,
                        format!("overlap:{}:{}", boxes[i].0, boxes[j].0),
                    )
                });
            }
        }
        let labels: Vec<(&Label, BBox)> = sheet
            .labels
            .iter()
            .map(|l| {
                let kind = match l.kind {
                    LabelKind::Local => "local",
                    LabelKind::Global => "global",
                    _ => "hierarchical",
                };
                (l, label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0))
            })
            .collect();
        for (l, lb) in &labels {
            for (r, b, _, _) in &boxes {
                // the symbol the label is attached to: its pin tip is on the box edge
                if b.expand(mil_to_nm(1.0)).contains(l.at) {
                    continue;
                }
                if lb.intersects(&b.expand(shrink)) {
                    out.push(Finding {
                        refs: vec![r.clone()],
                        at_mil: Some(mil(l.at)),
                        remediation: Some(format!(
                            "move {r} away from the label (move_component) or rotate the label",
                        )),
                        ..finding(
                            "LABEL_OVER_BODY",
                            Severity::Error,
                            format!("label {} overlaps the body of {r}", l.text),
                            &inst.names,
                            format!("labelbody:{}:{r}", l.uuid),
                        )
                    });
                }
            }
        }
        // Field texts (every visible property) over something they must not sit on.
        //
        // KiCad's own ERC has no geometric text rule, so this family is the only place a text
        // collision can be reported at all. The rules, all warnings:
        //
        // * `TEXT_OVERLAP`      — a field over a *foreign* body, or over a label.
        // * `FIELD_OVER_OWN_BODY` — a field over the body of the part it belongs to (the
        //   autoplaced Reference/Value landing inside the symbol outline).
        // * `FIELD_OVER_FIELD`  — two fields of two different symbols on top of each other.
        //
        // A power port (`#PWR..`) is exempt only where KiCad's own convention puts its value:
        // on the pin (and the wire) it feeds. That is exactly the symbol it shares a pin tip
        // with, so the exemption is scoped to that pair — never to its own glyph, never to a
        // label, and never to another symbol's field. Text on text is not a convention.
        let fields: Vec<(&SymbolInst, Vec<(String, BBox)>)> = sheet
            .symbols
            .iter()
            .map(|s| (s, symbol_field_boxes(doc, s)))
            .collect();
        let text_shrink = -mil_to_nm(5.0);
        for (s, tbs) in &fields {
            let power = s.reference.starts_with('#');
            let own = symbol_graphics_bbox(doc, s);
            for (what, tb) in tbs {
                // The neighbour's body *and its pin leads*: a text written across a connector's
                // pins hides the lines a reader traces to find them, and on a wide connector the
                // pins are most of what the part occupies. Only the `shares_pin` pair below is
                // exempt; the symbol's own body is the separate `FIELD_OVER_OWN_BODY` rule.
                let own_tips: &[Pt] = pin_tips
                    .get(&s.reference)
                    .map(|v| v.as_slice())
                    .unwrap_or(&[]);
                for (r, _, gb, _) in &boxes {
                    if *r == s.reference {
                        continue;
                    }
                    // The part this power port feeds: its value text sits on the pin they share,
                    // and over that part's body, by KiCad's own convention. The exemption stops
                    // there — a flag hung on pin 4 of a connector is not licensed to write its
                    // name across pins 1 to 3, so the *other* leads of that part still count.
                    let shared = power && shares_pin(&s.reference, r);
                    let over_lead = || {
                        stubs.get(r).is_some_and(|ss| {
                            ss.iter().any(|(tip, body)| {
                                !(shared && own_tips.contains(tip))
                                    && clip_segment(*tip, *body, tb).is_some()
                            })
                        })
                    };
                    if (!shared && tb.intersects(&gb.expand(shrink))) || over_lead() {
                        out.push(Finding {
                            refs: vec![s.reference.clone(), r.clone()],
                            at_mil: Some(mil(tb.min)),
                            evidence: ev([
                                ("blocker", r.clone().into()),
                                ("axis", least_overlap_axis(tb, &gb.expand(shrink)).into()),
                            ]),
                            remediation: Some(
                                "move the part (move_component) so its texts clear the neighbour"
                                    .into(),
                            ),
                            ..finding(
                                "TEXT_OVERLAP",
                                Severity::Warning,
                                format!("{what} text runs over {r}"),
                                &inst.names,
                                format!("text:{}:{r}", s.uuid),
                            )
                        });
                    }
                }
                if let Some(g) = own {
                    if tb.expand(text_shrink).intersects(&g.expand(shrink)) {
                        out.push(Finding {
                            refs: vec![s.reference.clone()],
                            at_mil: Some(mil(tb.min)),
                            remediation: Some(
                                "re-place the part (move_component) so its fields are laid out again, or rotate it (set_component_transform)"
                                    .into(),
                            ),
                            ..finding(
                                "FIELD_OVER_OWN_BODY",
                                Severity::Warning,
                                format!("{what} text runs over the body of {}", s.reference),
                                &inst.names,
                                format!("fieldbody:{}:{what}", s.uuid),
                            )
                        });
                    }
                }
                for (l, lb) in &labels {
                    if tb.expand(text_shrink).intersects(lb) {
                        out.push(Finding {
                            refs: vec![s.reference.clone()],
                            at_mil: Some(mil(tb.min)),
                            evidence: ev([
                                ("blocker", l.uuid.clone().into()),
                                (
                                    "axis",
                                    least_overlap_axis(&tb.expand(text_shrink), lb).into(),
                                ),
                            ]),
                            remediation: Some("space the parts further apart".into()),
                            ..finding(
                                "TEXT_OVERLAP",
                                Severity::Warning,
                                format!("{what} text runs over label {}", l.text),
                                &inst.names,
                                format!("textlabel:{}:{}", s.uuid, l.uuid),
                            )
                        });
                    }
                }
            }
        }
        // Field against field, once per unordered pair of symbols.
        for i in 0..fields.len() {
            for j in i + 1..fields.len() {
                let (a, abs) = &fields[i];
                let (b, bbs) = &fields[j];
                if a.reference == b.reference {
                    continue;
                }
                for (wa, ta) in abs {
                    for (wb, tbx) in bbs {
                        if !ta.expand(text_shrink).intersects(&tbx.expand(text_shrink)) {
                            continue;
                        }
                        out.push(Finding {
                            refs: vec![a.reference.clone(), b.reference.clone()],
                            at_mil: Some(mil(ta.min)),
                            evidence: ev([
                                ("blocker", b.reference.clone().into()),
                                (
                                    "axis",
                                    least_overlap_axis(
                                        &ta.expand(text_shrink),
                                        &tbx.expand(text_shrink),
                                    )
                                    .into(),
                                ),
                            ]),
                            remediation: Some(
                                "move one of the parts (move_component) so the two texts clear each other"
                                    .into(),
                            ),
                            ..finding(
                                "FIELD_OVER_FIELD",
                                Severity::Warning,
                                format!("{wa} text runs over {wb} text"),
                                &inst.names,
                                format!("fieldfield:{}:{wa}:{}:{wb}", a.uuid, b.uuid),
                            )
                        });
                    }
                }
            }
        }
        // A net name with a wire drawn through it: eeschema paints the text over the
        // copper-coloured line and a reader cannot tell where the name ends and the wire
        // begins. Pure geometry — the text box against every wire and bus on the sheet, not
        // only the one the text is attached to — with the text's own stub exempted
        // ([`TEXT_STUB_MIL`]), because a label always sits on a wire end and a power port
        // always sits on the wire it drives.
        //
        // Two shapes of it, and only these two: the wire that *leaves the anchor* in the
        // direction the text is written, which eeschema plots along the whole name; and any
        // other wire that crosses the text box itself. A label written beside a wire it merely
        // sits on — the mid-span label, the standard way to name a net — grazes the box edge
        // and is left alone, which is why the box is shrunk by a pen width first.
        for (l, lb) in &labels {
            let dir: (Nm, Nm) = match l.rot.rem_euclid(360) {
                0 => (1, 0),
                90 => (0, -1),
                180 => (-1, 0),
                _ => (0, 1),
            };
            let along = sheet.wires.iter().find(|w| {
                [(w.a, w.b), (w.b, w.a)].iter().any(|(from, to)| {
                    *from == l.at
                        && (to.x - from.x).signum() == dir.0
                        && (to.y - from.y).signum() == dir.1
                })
            });
            let hit = match along {
                Some(w) => Some((
                    w,
                    format!(
                        "label {} is written along the wire leaving its anchor",
                        l.text
                    ),
                )),
                None => wire_through(&sheet.wires, &lb.expand(text_shrink), &[l.at]).map(|w| {
                    (
                        w,
                        format!(
                            "a {} runs through the text of label {}",
                            if w.is_bus { "bus" } else { "wire" },
                            l.text
                        ),
                    )
                }),
            };
            if let Some((w, message)) = hit {
                out.push(Finding {
                    at_mil: Some(mil(l.at)),
                    remediation: Some(
                        "rotate the label 180 degrees so it reads away from the wire, or move it to the far end (add_net_label rotation)"
                            .into(),
                    ),
                    ..finding(
                        "LABEL_OVER_WIRE",
                        Severity::Warning,
                        message,
                        &inst.names,
                        format!("labelwire:{}:{}", l.uuid, w.uuid),
                    )
                });
            }
        }
        // The same rule for a power port's Value: it is a net name written on the sheet like any
        // label, it is just not a `label` object, so no other rule in this family ever sees it.
        // Its anchors are its own pin tips — that is where the wire it drives arrives.
        for (s, tbs) in &fields {
            if !s.reference.starts_with('#') {
                continue;
            }
            let anchors: Vec<Pt> = pin_tips.get(&s.reference).cloned().unwrap_or_default();
            for (what, tb) in tbs {
                if !what.ends_with(" value") {
                    continue;
                }
                if let Some(w) = wire_through(&sheet.wires, &tb.expand(text_shrink), &anchors) {
                    out.push(Finding {
                        refs: vec![s.reference.clone()],
                        at_mil: Some(mil(tb.min)),
                        remediation: Some(
                            "move the port off the wire it is written over (move_component), or rotate it (set_component_transform)"
                                .into(),
                        ),
                        ..finding(
                            "LABEL_OVER_WIRE",
                            Severity::Warning,
                            format!("a {} runs through the {what} text", if w.is_bus { "bus" } else { "wire" }),
                            &inst.names,
                            format!("labelwire:{}:{}", s.uuid, w.uuid),
                        )
                    });
                }
            }
        }
        // Two labels of one name close enough together that a wire is what a drafter would have
        // drawn: the name is repeated where a line would have said the same thing more directly.
        // Info — a repeated label is a legal and sometimes deliberate way to join two points, so
        // this states the drafting norm and never more.
        for i in 0..labels.len() {
            for j in i + 1..labels.len() {
                let (la, _) = &labels[i];
                let (lb2, _) = &labels[j];
                if la.text != lb2.text || la.at == lb2.at {
                    continue;
                }
                let (dx, dy) = ((la.at.x - lb2.at.x) as f64, (la.at.y - lb2.at.y) as f64);
                if (dx * dx + dy * dy).sqrt() > mil_to_nm(LABEL_PAIR_NEAR_MIL) as f64 {
                    continue;
                }
                // A body drawn between them is why the two names exist: the wire would have to
                // go round it, which is the case the convention does not cover.
                if boxes
                    .iter()
                    .any(|(_, b, _, _)| clip_segment(la.at, lb2.at, &b.expand(shrink)).is_some())
                {
                    continue;
                }
                out.push(Finding {
                    at_mil: Some(mil(la.at)),
                    remediation: Some(
                        "join the two points with a wire (add_wire) and delete one label, or leave the pair if the wire would cross the block"
                            .into(),
                    ),
                    ..finding(
                        "LABEL_PAIR_SHOULD_BE_WIRE",
                        Severity::Info,
                        format!(
                            "{} is written twice {:.0} mil apart with nothing drawn in between",
                            la.text,
                            nm_to_mil((dx * dx + dy * dy).sqrt() as Nm)
                        ),
                        &inst.names,
                        format!("labelpair:{}:{}", la.uuid, lb2.uuid),
                    )
                });
            }
        }
        for i in 0..labels.len() {
            for j in i + 1..labels.len() {
                let (la, a) = &labels[i];
                let (lb, b) = &labels[j];
                if la.at == lb.at || la.text == lb.text {
                    continue;
                }
                if a.expand(-mil_to_nm(5.0))
                    .intersects(&b.expand(-mil_to_nm(5.0)))
                {
                    out.push(Finding {
                        at_mil: Some(mil(la.at)),
                        remediation: Some("space the labels further apart".into()),
                        ..finding(
                            "LABEL_OVERLAP",
                            Severity::Warning,
                            format!("labels {} and {} overlap", la.text, lb.text),
                            &inst.names,
                            format!("labels:{}:{}", la.uuid, lb.uuid),
                        )
                    });
                }
            }
        }
    }
    attach_files(tree, &mut out);
    out
}

/// Largest distance (mil) a decoupling capacitor may sit from the pin it decouples before
/// `DECAP_FAR` says so. Two 250 mil grid steps: far enough for a stub and a junction, close
/// enough that the pair still reads as one block.
const DECAP_FAR_MIL: f64 = 500.0;
/// Capacitance window (farads) the check treats as decoupling. Below it the part is a filter
/// or a load cap, above it a bulk reservoir that belongs at the regulator, not at a pin.
const DECAP_RANGE_F: (f64, f64) = (100e-9, 10e-6);

/// `DECAP_FAR` (warning): a decoupling capacitor drawn away from the pin it decouples.
///
/// Pure geometry over eeschema's own data, and no circuit judgement beyond the drawing
/// convention: a `C*` part whose value is in [`DECAP_RANGE_F`], with a pin on a net that
/// carries a power port and at least one `power_in` pin on the same sheet, and further than
/// [`DECAP_FAR_MIL`] from every one of those pins. Nothing is inferred about whether the part
/// *should* be there — only about how far away it was drawn — and it is never a refusal.
fn decoupling_distance(tree: &SheetTree, nets: &Netlist) -> Vec<Finding> {
    let mut out = Vec::new();
    let far = mil_to_nm(DECAP_FAR_MIL) as f64;
    // (sheet instance, reference, pin) -> the net that member sits on.
    let mut net_of: HashMap<(&str, &str, &str), &sch_net::Net> = HashMap::new();
    for n in &nets.nets {
        for m in &n.members {
            net_of.insert((m.sheet.as_str(), m.reference.as_str(), m.pin.as_str()), n);
        }
    }
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        // World pin positions of this sheet instance.
        let mut at_of: HashMap<(&str, String), Pt> = HashMap::new();
        for s in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            for p in world_pins(s, lib) {
                at_of.insert((s.reference.as_str(), p.number.clone()), p.at);
            }
        }
        for s in &sheet.symbols {
            if !s.reference.starts_with('C') {
                continue;
            }
            match crate::handlers::parse_si(&s.value, 'F') {
                Some(f) if (DECAP_RANGE_F.0..=DECAP_RANGE_F.1).contains(&f) => {}
                _ => continue,
            }
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            // One finding per capacitor, not one per pin: a decap sits between two rails and
            // being far from both is one placement mistake. The worst of the two is reported.
            // (distance, net, own pin, the power_in pin that distance was measured to, its point)
            let mut worst: Option<(f64, String, String, String, Pt)> = None;
            for p in world_pins(s, lib) {
                let Some(net) = net_of
                    .get(&(inst.names.as_str(), s.reference.as_str(), p.number.as_str()))
                    .copied()
                else {
                    continue;
                };
                if !net.powered {
                    continue;
                }
                // The closest power_in pin on that net, and which one it is: a repair that moves
                // the cap has to be told the pin to move it to, not only how far off it is.
                let nearest = net
                    .members
                    .iter()
                    .filter(|m| {
                        m.sheet == inst.names
                            && m.pin_type == "power_in"
                            && m.reference != s.reference
                    })
                    .filter_map(|m| {
                        let t = *at_of.get(&(m.reference.as_str(), m.pin.clone()))?;
                        let (dx, dy) = ((t.x - p.at.x) as f64, (t.y - p.at.y) as f64);
                        Some((
                            (dx * dx + dy * dy).sqrt(),
                            format!("{}.{}", m.reference, m.pin),
                            t,
                        ))
                    })
                    .min_by(|a, b| a.0.total_cmp(&b.0));
                let Some((nearest, target, target_at)) = nearest else {
                    continue;
                };
                if nearest <= far {
                    continue;
                }
                if worst.as_ref().map(|w| nearest > w.0).unwrap_or(true) {
                    worst = Some((
                        nearest,
                        net.name.clone(),
                        p.number.clone(),
                        target,
                        target_at,
                    ));
                }
            }
            if let Some((nearest, net_name, pin, target, target_at)) = worst {
                out.push(Finding {
                    refs: vec![format!("{}.{}", s.reference, pin)],
                    at_mil: Some(mil(s.placement.at)),
                    evidence: ev([
                        ("nearest_pin", target.into()),
                        (
                            "nearest_pin_at_mil",
                            serde_json::json!(mil(target_at).to_vec()),
                        ),
                    ]),
                    remediation: Some(format!(
                        "place the cap at the pin it decouples: place_decoupling near \"<REF>.<PIN>\" on {net_name}, or move_component {}",
                        s.reference
                    )),
                    ..finding(
                        "DECAP_FAR",
                        Severity::Warning,
                        format!(
                            "{} ({}) is {} mil from the nearest power pin on {net_name}",
                            s.reference,
                            s.value,
                            nm_to_mil(nearest as Nm).round() as i64,
                        ),
                        &inst.names,
                        format!("decap:{}", s.uuid),
                    )
                });
            }
        }
    }
    out
}

/// Most pins a part may have and still read as one of a row of small parts. A wide IC is placed
/// on its own, not lined up with its neighbours, so aligning it with them is not a drafting rule.
const ROW_MAX_PINS: usize = 8;
/// Furthest apart (mil) two parts may sit along a row and still be read as neighbours in it.
const ROW_SIDEWAYS_MIL: f64 = 800.0;
/// Largest offset (mil) that still reads as "these two were meant to line up". Beyond it the
/// author put the second part on another line on purpose.
const ROW_NEAR_MIL: f64 = 150.0;
/// The placement grid a deliberate step in a row is a multiple of. A part one or more whole steps
/// off its neighbour was moved there; a part a fraction of a step off was left there.
const ROW_STEP_MIL: f64 = 100.0;

/// A part that reads as one of a row: at most [`ROW_MAX_PINS`] pins, all of them on one line, so
/// the line the row aligns on is unambiguous.
struct RowPart {
    uuid: String,
    reference: String,
    pins: usize,
    rot: Rot,
    mirror: Mirror,
    /// True when the pins share an x — the part is drawn standing up and belongs to a *horizontal*
    /// row; false when they share a y and it belongs to a vertical column.
    upright: bool,
    /// The coordinate the row lines up on: the first pin tip across the row.
    across: Nm,
    /// Where the part sits along the row.
    along: Nm,
    body: BBox,
}

/// Classify a placed symbol as one of a row, or None when it is not a row part: too many pins,
/// fewer than two, no library body, or pins that do not all sit on one line (an IC with pins on
/// two sides has no single line to align).
fn row_part(
    sheet: &sch_model::Sheet,
    doc: &kicad_sexpr::Document,
    s: &SymbolInst,
) -> Option<RowPart> {
    let lib = sheet.lib_symbol(&s.lib_id)?;
    if lib.is_power || s.reference.starts_with('#') {
        return None;
    }
    let pins: Vec<Pt> = world_pins(s, lib).into_iter().map(|p| p.at).collect();
    if pins.len() < 2 || pins.len() > ROW_MAX_PINS {
        return None;
    }
    let upright = pins.iter().all(|p| p.x == pins[0].x);
    if !upright && !pins.iter().all(|p| p.y == pins[0].y) {
        return None;
    }
    let body = symbol_bbox(doc, s)?;
    Some(RowPart {
        uuid: s.uuid.clone(),
        reference: s.reference.clone(),
        pins: pins.len(),
        rot: s.placement.rot,
        mirror: s.placement.mirror,
        upright,
        across: pins
            .iter()
            .map(|p| if upright { p.y } else { p.x })
            .min()
            .unwrap_or(0),
        along: if upright { pins[0].x } else { pins[0].y },
        body,
    })
}

/// Delivery-readiness checks (attached to plan blocks): footprints and units.
/// Style findings (all warnings, never a refusal): readability rules a human
/// drafter follows by habit. Locations key on uuids so `introduced()` stays
/// stable across re-applies.
///
/// * `POWER_PORT_ORIENTATION` — a GND-class port whose body is above its pin,
///   or another rail whose body is below it (PWR_FLAG exempt).
/// * `OFF_GRID` — eeschema's `endpoint_off_grid` (`erc.cpp::TestOffGridEndpoints`): a pin
///   position, wire or bus endpoint, bus-entry end or label anchor that is not an exact multiple
///   of the connection grid (`DEFAULT_CONNECTION_GRID_MILS`, 50 mil). Zero tolerance, like KiCad's
///   integer modulo; the symbol *anchor* is not checked (KiCad checks the pins it carries).
/// * `ROW_MISALIGNED` — two parts of the same shape ([`row_part`]) drawn as neighbours in one
///   row, whose pin tips are out of line by a fraction of a placement step. Every clause of it
///   ([`ROW_NEAR_MIL`], [`ROW_STEP_MIL`], [`ROW_SIDEWAYS_MIL`]) is there to leave deliberate
///   layout alone: a whole step is a decision, and a part of another shape is not one of the row.
pub fn style(tree: &SheetTree) -> Vec<Finding> {
    let mut out = Vec::new();
    // Long wires: connections between blocks belong to labels; a wire longer than
    // 1500 mil (or any diagonal one) is clutter a reader has to trace.
    let long = mil_to_nm(1500.0);
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for w in &sheet.wires {
            if w.is_bus {
                continue;
            }
            let dx = (w.b.x - w.a.x).abs();
            let dy = (w.b.y - w.a.y).abs();
            let diagonal = dx != 0 && dy != 0;
            if dx.max(dy) > long || diagonal {
                out.push(Finding {
                    refs: vec![],
                    at_mil: Some([nm_to_mil(w.a.x), nm_to_mil(w.a.y)]),
                    remediation: Some(
                        "replace the wire with a net label on each end (delete_object + add_net_label)".into(),
                    ),
                    ..finding(
                        "LONG_WIRE",
                        Severity::Warning,
                        if diagonal { "diagonal wire".to_string() } else { format!("wire longer than 1500 mil ({} mil)", nm_to_mil(dx.max(dy)) as i64) },
                        &inst.names,
                        format!("style:wire:{}", w.uuid),
                    )
                });
            }
        }
    }
    // eeschema's connection grid: `SCHEMATIC_SETTINGS::m_ConnectionGridSize`, whose default is
    // `DEFAULT_CONNECTION_GRID_MILS` = 50. `TestOffGridEndpoints` takes an exact integer modulo
    // against it, so this does too.
    let grid = mil_to_nm(50.0);
    let on_grid = |v: Nm| v.rem_euclid(grid) == 0;
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let doc = &tree.docs[&inst.file];
        // Parts that read as one of a row, and every symbol body, for the row check below.
        let mut rows: Vec<RowPart> = Vec::new();
        let mut bodies: Vec<(String, BBox)> = Vec::new();
        for s in &sheet.symbols {
            if let Some(b) = symbol_bbox(doc, s) {
                bodies.push((s.uuid.clone(), b));
            }
            if let Some(r) = row_part(sheet, doc, s) {
                rows.push(r);
            }
        }
        for s in &sheet.symbols {
            let lib = sheet.lib_symbol(&s.lib_id);
            let is_power = s.reference.starts_with('#') || lib.map(|l| l.is_power).unwrap_or(false);
            // KiCad checks the pins, not the anchor: a symbol placed on the grid can still carry
            // pins off it, and those are the points other items have to land on.
            if let Some(lib) = lib {
                for p in world_pins(s, lib) {
                    if !on_grid(p.at.x) || !on_grid(p.at.y) {
                        out.push(Finding {
                            refs: vec![format!("{}.{}", s.reference, p.number)],
                            at_mil: Some(mil(p.at)),
                            remediation: Some(
                                "move_component so the pin lands on a 50 mil grid point (or fix the library symbol)"
                                    .into(),
                            ),
                            ..finding(
                                "OFF_GRID",
                                Severity::Warning,
                                format!(
                                    "pin {}.{} at {} is off the 50 mil connection grid",
                                    s.reference, p.number, p.at
                                ),
                                &inst.names,
                                format!("style:grid:{}:{}", s.uuid, p.number),
                            )
                        });
                    }
                }
            }
            if is_power {
                if s.value == "PWR_FLAG" {
                    continue;
                }
                let Some(lib) = lib else { continue };
                let Some(lib_pin) = lib.pins_for_unit(s.unit).next() else {
                    continue;
                };
                let Some(pin) = world_pins(s, lib).into_iter().next() else {
                    continue;
                };
                let Some(g) = symbol_graphics_bbox(doc, s) else {
                    continue;
                };
                let centre_y = (g.min.y + g.max.y) / 2;
                let ground = crate::handlers::is_ground_net(&s.value);
                let body_below = centre_y > pin.at.y;
                let wrong = if ground { !body_below } else { body_below };
                if wrong && centre_y != pin.at.y {
                    // The finding carries its own target so the repair does not have to guess:
                    // the rotation that stands this port upright, keeping the mirror it has.
                    let upright = upright_port_rotation(lib_pin.angle, s.placement.mirror, ground);
                    let rotation_arg = match upright {
                        Some(r) => format!("rotation={r}"),
                        None => "rotation".to_string(),
                    };
                    let mut evidence =
                        ev([("current_rotation", serde_json::json!(s.placement.rot.deg()))]);
                    if let Some(r) = upright {
                        evidence.insert("rotation".into(), serde_json::json!(r));
                    }
                    out.push(Finding {
                        refs: vec![s.reference.clone()],
                        at_mil: Some(mil(s.placement.at)),
                        remediation: Some(if ground {
                            format!("GND ports point down: set_component_transform {{uuid, {rotation_arg}}} or re-place with place_gnd (the engine orients it from the pin)")
                        } else {
                            format!("power rails point up: set_component_transform {{uuid, {rotation_arg}}} or re-place with place_power_port")
                        }),
                        evidence,
                        ..finding(
                            "POWER_PORT_ORIENTATION",
                            Severity::Warning,
                            format!(
                                "{} ({}) points {} instead of {}",
                                s.reference,
                                s.value,
                                if body_below { "down" } else { "up" },
                                if ground { "down" } else { "up" }
                            ),
                            &inst.names,
                            format!("style:power:{}", s.uuid),
                        )
                    });
                }
                continue;
            }
        }
        // Buses are connectable lines too, so KiCad checks their endpoints as well.
        for w in &sheet.wires {
            let what = if w.is_bus { "bus" } else { "wire" };
            for (tag, p) in [("start", w.a), ("end", w.b)] {
                if !on_grid(p.x) || !on_grid(p.y) {
                    out.push(Finding {
                        at_mil: Some(mil(p)),
                        remediation: Some("wire and bus endpoints sit on pin tips or 50 mil grid points (delete_object + add_wire on grid)".into()),
                        ..finding(
                            "OFF_GRID",
                            Severity::Warning,
                            format!("{what} {tag} {p} is off the 50 mil connection grid"),
                            &inst.names,
                            format!("style:wire:{}:{}", w.uuid, tag),
                        )
                    });
                }
            }
        }
        for e in &sheet.bus_entries {
            for (tag, p) in [("start", e.at), ("end", e.end())] {
                if !on_grid(p.x) || !on_grid(p.y) {
                    out.push(Finding {
                        at_mil: Some(mil(p)),
                        remediation: Some(
                            "bus entries connect a wire to a bus: both ends belong on 50 mil grid points"
                                .into(),
                        ),
                        ..finding(
                            "OFF_GRID",
                            Severity::Warning,
                            format!("bus entry {tag} {p} is off the 50 mil connection grid"),
                            &inst.names,
                            format!("style:busentry:{}:{}", e.uuid, tag),
                        )
                    });
                }
            }
        }
        for l in &sheet.labels {
            if !on_grid(l.at.x) || !on_grid(l.at.y) {
                out.push(Finding {
                    at_mil: Some(mil(l.at)),
                    remediation: Some("labels sit on pin tips or 50 mil grid points".into()),
                    ..finding(
                        "OFF_GRID",
                        Severity::Warning,
                        format!(
                            "label {} at {} is off the 50 mil connection grid",
                            l.text, l.at
                        ),
                        &inst.names,
                        format!("style:grid:{}", l.uuid),
                    )
                });
            }
        }
        // Rows: two parts a reader takes for neighbours in one row whose pin tips do not quite
        // line up. Every clause is there to keep the rule off deliberate layout on a 50 mil grid:
        //
        // * same pin count, same rotation and mirror — a three-pin regulator is not one of a row
        //   of two-pin passives, and a part turned the other way up is not out of line with them;
        // * pin tips, not the bounding box bottom — a cap and a resistor with the same pin span
        //   line up on their pins, and their bodies are different heights;
        // * nothing drawn between them along the row — otherwise every part on the sheet is
        //   compared with every other one within [`ROW_SIDEWAYS_MIL`];
        // * an offset that is not a whole [`ROW_STEP_MIL`] step — a part moved a deliberate step
        //   is on another line on purpose, a part left a fraction of a step off is a staircase.
        let near = mil_to_nm(ROW_NEAR_MIL);
        let sideways = mil_to_nm(ROW_SIDEWAYS_MIL);
        let step = mil_to_nm(ROW_STEP_MIL);
        let mut flagged: HashSet<String> = HashSet::new();
        for i in 0..rows.len() {
            for j in i + 1..rows.len() {
                let (a, b) = (&rows[i], &rows[j]);
                if a.pins != b.pins
                    || a.rot != b.rot
                    || a.mirror != b.mirror
                    || a.upright != b.upright
                {
                    continue;
                }
                let apart = (a.along - b.along).abs();
                let d = (a.across - b.across).abs();
                if apart == 0 || apart > sideways || d == 0 || d > near || d % step == 0 {
                    continue;
                }
                // The gap between the two bodies, across the band both of them occupy: anything
                // drawn in it means they are not neighbours in a row.
                let (lo, hi) = if a.along <= b.along { (a, b) } else { (b, a) };
                let (from, to) = if a.upright {
                    (lo.body.max.x, hi.body.min.x)
                } else {
                    (lo.body.max.y, hi.body.min.y)
                };
                let gap = if a.upright {
                    BBox {
                        min: Pt::new(from, lo.body.min.y.min(hi.body.min.y)),
                        max: Pt::new(to, lo.body.max.y.max(hi.body.max.y)),
                    }
                } else {
                    BBox {
                        min: Pt::new(lo.body.min.x.min(hi.body.min.x), from),
                        max: Pt::new(lo.body.max.x.max(hi.body.max.x), to),
                    }
                };
                // `from >= to` means the two bodies already touch or overlap along the row: there
                // is no gap, so nothing can be drawn in it.
                if from < to
                    && bodies
                        .iter()
                        .any(|(u, body)| *u != a.uuid && *u != b.uuid && body.intersects(&gap))
                {
                    continue;
                }
                // The baseline the pair should share: whichever of the two is on the placement
                // grid, so both findings name one line and the part that is off it gets the
                // non-zero `delta_mil`. `delta_mil` is signed the way that part has to move.
                let target = if a.across.rem_euclid(step) == 0 || b.across.rem_euclid(step) != 0 {
                    a.across
                } else {
                    b.across
                };
                for p in [a, b] {
                    if flagged.insert(p.uuid.clone()) {
                        out.push(Finding {
                            refs: vec![p.reference.clone()],
                            at_mil: Some(mil(if a.upright {
                                Pt::new(p.along, p.across)
                            } else {
                                Pt::new(p.across, p.along)
                            })),
                            evidence: ev([
                                (
                                    if a.upright { "target_y_mil" } else { "target_x_mil" },
                                    serde_json::json!(nm_to_mil(target)),
                                ),
                                (
                                    "delta_mil",
                                    serde_json::json!(nm_to_mil(target - p.across)),
                                ),
                            ]),
                            remediation: Some("align the row: arrange_group, or move_component by the difference".into()),
                            ..finding(
                                "ROW_MISALIGNED",
                                Severity::Warning,
                                format!(
                                    "{} and {} sit in one row but their pins are {:.0} mil out of line",
                                    a.reference, b.reference, nm_to_mil(d)
                                ),
                                &inst.names,
                                format!("style:row:{}", p.uuid),
                            )
                        });
                    }
                }
            }
        }
    }
    attach_files(tree, &mut out);
    out
}

/// The global rail names a sheet is on: its global labels, and the net name each power port drives
/// (`PWR_FLAG` is not a name, red line 4). These are the nets that cross a sheet boundary without a
/// sheet pin.
fn global_rails(sheet: &Sheet) -> BTreeSet<&str> {
    let mut out = BTreeSet::new();
    for l in &sheet.labels {
        if l.kind == LabelKind::Global {
            out.insert(l.text.as_str());
        }
    }
    for s in &sheet.symbols {
        if is_power_symbol(sheet, s) && s.value != "PWR_FLAG" {
            out.insert(s.value.as_str());
        }
    }
    out
}

/// Does everything that leaves `child` leave on a global rail, so a sheet symbol without pins is
/// the design rather than an unfinished scaffold?
///
/// A plan can join its blocks entirely on power: a regulator sheet whose whole interface is
/// VBUS_5V in, +3V3 out and GND merges with the rest of the project through the global net alone,
/// and it needs no sheet pin to do it. It is a scaffold, and `SHEET_NO_PINS` is right, when
/// something on the child asks for a boundary of its own instead: a hierarchical label (which is
/// only connected through a sheet pin of the same name) or a local label the parent also carries,
/// where the two names read as one net and are not one (a local label does not cross a sheet).
fn crosses_on_rails_only(parent: &Sheet, child: &Sheet) -> bool {
    if global_rails(child).is_empty() {
        return false;
    }
    if child
        .labels
        .iter()
        .any(|l| l.kind == LabelKind::Hierarchical)
    {
        return false;
    }
    let up: BTreeSet<&str> = parent
        .labels
        .iter()
        .filter(|l| l.kind == LabelKind::Local)
        .map(|l| l.text.as_str())
        .collect();
    !child
        .labels
        .iter()
        .any(|l| l.kind == LabelKind::Local && up.contains(l.text.as_str()))
}

pub fn delivery(tree: &SheetTree, nets: &Netlist) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut units_seen: BTreeMap<String, (u32, HashSet<u32>)> = BTreeMap::new();
    // (sheet instance, lib_id) -> the refs placed from an unverified converted symbol.
    let mut unverified: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        for s in &sheet.symbols {
            // A power symbol is a port, not a part: it has no footprint, no BOM line and no unit
            // count to reconcile. KiCad marks it by the `#` reference it annotates, but a model can
            // place one under a leased designator (`PWR1` on a `power:PWR_FLAG` in run 20), and the
            // reference alone then said "part". The library flag and the `power:` library are the
            // two ways the symbol itself says what it is, so both are read here — `place_component`
            // also rewrites such a designator to `#FLG`/`#PWR`, and this holds for the files
            // already on disk with the old one.
            if is_power_symbol(sheet, s) {
                continue;
            }
            if s.footprint.is_empty() && !s.dnp {
                out.push(Finding {
                    refs: vec![s.reference.clone()],
                    remediation: Some(format!(
                        "set_component_parameters {} with footprint (e.g. Resistor_SMD:R_0603_1608Metric); the PCB cannot place a part without one",
                        s.reference
                    )),
                    ..finding(
                        "FOOTPRINT_MISSING",
                        Severity::Warning,
                        format!("{} has no footprint", s.reference),
                        &inst.names,
                        format!("footprint:{}", s.uuid),
                    )
                });
            }
            if let Some(lib) = sheet.lib_symbol(&s.lib_id) {
                let e = units_seen
                    .entry(s.reference.clone())
                    .or_insert((lib.unit_count, HashSet::new()));
                e.1.insert(s.unit);
                // A symbol fluxsmith converted from vendor CAD is a CLAIM until a human checked it
                // against the datasheet (red line 10). Delivery says so once per library symbol —
                // a Warning, never a block: the human decides whether to ship an unverified part.
                if lib.unverified_claim() {
                    unverified
                        .entry((inst.names.clone(), s.lib_id.clone()))
                        .or_default()
                        .insert(s.reference.clone());
                }
            }
        }
    }
    for ((sheet, lib_id), refs) in unverified {
        let refs: Vec<String> = refs.into_iter().collect();
        out.push(Finding {
            refs: refs.clone(),
            remediation: Some(format!(
                "compare {lib_id} pin by pin with the datasheet, then remove the {} property from the library symbol",
                sch_model::CLAIM_PROPERTY
            )),
            ..finding(
                "PART_UNVERIFIED",
                Severity::Warning,
                format!(
                    "{} uses {lib_id}, a converted library symbol nobody has verified against the datasheet",
                    refs.join(", ")
                ),
                &sheet,
                format!("claim:{lib_id}"),
            )
        });
    }
    for (r, (total, placed)) in units_seen {
        if placed.len() < total as usize {
            out.push(Finding {
                refs: vec![r.clone()],
                ..finding(
                    "UNITS_INCOMPLETE",
                    Severity::Warning,
                    format!("{r}: {} of {total} units placed", placed.len()),
                    "/",
                    format!("units:{r}"),
                )
            });
        }
    }
    // rails present as local labels on more than one sheet with the same name.
    // A `(power local)` symbol is sheet-instance scoped by definition (eeschema
    // `PRIORITY::LOCAL_POWER_PIN`): the same name on two sheet instances is what the human drew,
    // not a rail that leaked out of one sheet, so those nets are not a scope split.
    let mut local_by_name: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    for n in &nets.nets {
        if n.local_power {
            continue;
        }
        if n.scope == sch_net::NetScope::Local {
            if let Some(idx) = n.name.rfind('/') {
                local_by_name
                    .entry(n.name[idx + 1..].to_string())
                    .or_default()
                    .insert(n.name[..=idx].to_string());
            }
        }
    }
    // A rail drawn as a local label with no power symbol of that net on the same sheet: it joins
    // nothing outside the sheet and KiCad flags every single-pin instance (isolated_pin_label).
    for (path, sheet) in &tree.files {
        let ports: HashSet<&str> = sheet
            .symbols
            .iter()
            .filter(|s| {
                s.lib_id.starts_with("power:")
                    || sheet
                        .lib_symbol(&s.lib_id)
                        .map(|l| l.is_power)
                        .unwrap_or(false)
            })
            .map(|s| s.value.as_str())
            .collect();
        // A local label that shares its net with a hierarchical / global label is not a rail drawn as a label.
        let joined: HashSet<&str> = nets
            .nets
            .iter()
            .filter(|n| n.scope != sch_net::NetScope::Local)
            .flat_map(|n| n.labels.iter().map(|l| l.as_str()))
            .collect();
        let sheet_name = path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut seen: HashSet<String> = HashSet::new();
        for l in &sheet.labels {
            if l.kind != LabelKind::Local {
                continue;
            }
            let n = l.text.trim_start_matches('/');
            if looks_like_rail(n)
                && !ports.contains(n)
                && !joined.contains(n)
                && seen.insert(n.to_string())
            {
                // This walk is per file, not per instance, so `sheet` here is a file name and not
                // an instance names path: `file` is set from the path being walked.
                out.push(Finding {
                    file: Some(tree.rel_file(path)),
                    ..finding(
                        "RAIL_AS_LABEL",
                        Severity::Warning,
                        format!(
                            "rail {n} is drawn as a local label on {sheet_name}; use a power port (place_power_port / place_gnd)"
                        ),
                        &sheet_name,
                        format!("rail_label:{n}"),
                    )
                });
            }
        }
    }
    // Hierarchy scaffold: a sheet symbol was created but the block was never wired through it.
    //
    // Names that do not correspond are already `SHEET_PIN_UNMATCHED` / `HIER_LABEL_UNMATCHED`
    // (errors, one per name, in the erc family); what nothing sees is a sheet symbol with no pins
    // at all in front of a child that has a circuit on it — no signal crosses the boundary, so
    // the block hangs on power rails or on nothing.
    for inst in &tree.instances {
        let sheet = &tree.files[&inst.file];
        let dir = inst.file.parent().unwrap_or(std::path::Path::new("."));
        for sh in &sheet.sheets {
            let Some(child) = tree.files.get(&dir.join(&sh.file)) else {
                continue;
            };
            let drawn = child.symbols.len() + child.labels.len() + child.sheets.len();
            if drawn == 0 {
                out.push(Finding {
                    refs: vec![sh.name.clone()],
                    at_mil: Some(mil(sh.at)),
                    remediation: Some(format!(
                        "draw the block on {} (place_component / add_wire with sheet: \"{}\"), or delete the sheet symbol",
                        sh.file, sh.file
                    )),
                    ..finding(
                        "SHEET_CHILD_EMPTY",
                        Severity::Warning,
                        format!("sheet {} points at {}, which has nothing drawn on it", sh.name, sh.file),
                        &inst.names,
                        format!("sheetempty:{}", sh.uuid),
                    )
                });
                continue;
            }
            if sh.pins.is_empty() && !crosses_on_rails_only(sheet, child) {
                out.push(Finding {
                    refs: vec![sh.name.clone()],
                    at_mil: Some(mil(sh.at)),
                    remediation: Some(format!(
                        "add the sheet pins the block needs (add_sheet_pin) and the matching hierarchical labels inside {}, or keep the block on this sheet",
                        sh.file
                    )),
                    ..finding(
                        "SHEET_NO_PINS",
                        Severity::Warning,
                        format!(
                            "sheet {} has no pins, so nothing crosses the boundary into {}",
                            sh.name, sh.file
                        ),
                        &inst.names,
                        format!("sheetpins:{}", sh.uuid),
                    )
                });
            }
        }
    }
    out.extend(decoupling_distance(tree, nets));
    for (name, sheets) in local_by_name {
        if sheets.len() > 1 {
            let message = format!(
                "local label {name} exists on {} sheets as separate nets",
                sheets.len()
            );
            // A rail split this way wants a power port on each sheet (the rails section of the
            // net-naming skill); any other name is a naming question -- one signal spelled as a
            // local label on two sheets, or two signals that happen to share a name.
            if looks_like_rail(&name) {
                out.push(finding(
                    "RAIL_SCOPE_SPLIT",
                    Severity::Warning,
                    message,
                    "/",
                    format!("rail_scope:{name}"),
                ));
            } else {
                out.push(Finding {
                    remediation: Some(
                        "if the sheets share this signal, make it a global label (or a hierarchical label with a sheet pin) on each; if not, rename_net one side with `sheet` set"
                            .into(),
                    ),
                    ..finding(
                        "LABEL_SCOPE_SPLIT",
                        Severity::Warning,
                        message,
                        "/",
                        format!("label_scope:{name}"),
                    )
                });
            }
        }
    }
    attach_files(tree, &mut out);
    out
}
