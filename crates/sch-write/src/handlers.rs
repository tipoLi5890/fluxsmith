// SPDX-License-Identifier: Apache-2.0
//! Op handlers: mutate the lossless document of a sheet. Each handler works
//! on a `Workset` that holds the documents and a freshly parsed model.

use crate::autoplace::{self, FieldPlace};
use crate::identity as id;
use crate::nodes;
use kicad_sexpr::{Document, List, Node};
use sch_model::*;
use sch_ops::{Anchor, Endpoint, ExpandedOp, Op, Place, Scope};
use sch_read::bbox::{
    field_bbox, label_flag_bbox, lib_body_bbox, lib_graphics_bbox, symbol_bbox,
    symbol_graphics_bbox, symbol_text_boxes, text_bbox, world_box, world_dir, BBox,
};
use sch_read::SymbolLibrary;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Created {
    pub kind: String,
    pub uuid: String,
    /// Designator of a created symbol or power port (`R7`, `#PWR012`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// Value of a created symbol (`1k`, `100n`), verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Net name of a label or power port; name of a sheet symbol or sheet pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// File the object was created in (file name only); filled in by the apply loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
}

impl Created {
    pub fn of(kind: &str, uuid: String) -> Created {
        Created {
            kind: kind.into(),
            uuid,
            reference: None,
            value: None,
            name: None,
            sheet: None,
        }
    }
    pub fn with_reference(mut self, r: &str) -> Created {
        self.reference = Some(r.to_string());
        self
    }
    pub fn with_value(mut self, v: &str) -> Created {
        self.value = Some(v.to_string());
        self
    }
    pub fn with_name(mut self, n: &str) -> Created {
        self.name = Some(n.to_string());
        self
    }
    pub fn with_sheet(mut self, s: &str) -> Created {
        self.sheet = Some(s.to_string());
        self
    }
}

/// One field an op changed on an existing object, with the value it had before.
/// Only fields whose before-value the handler read are reported (never inferred).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Changed {
    /// Designator of the component the field belongs to.
    pub reference: String,
    /// Property name as written in the file (`Value`, `Footprint`, `Reference`, a custom field).
    pub field: String,
    pub before: String,
    pub after: String,
    /// File the object lives in (file name only); filled in by the apply loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet: Option<String>,
}

/// The `before` / `after` text of a pose change (`Changed { field: "at" }`): anchor in mil and the
/// file rotation, plus the mirror axis when there is one -- `(3600,2600,90)`, `(100,200,0,mirror y)`.
pub fn pose_text(p: &Placement) -> String {
    let mirror = match p.mirror {
        Mirror::None => "",
        Mirror::X => ",mirror x",
        Mirror::Y => ",mirror y",
    };
    format!(
        "({:.0},{:.0},{}{mirror})",
        nm_to_mil(p.at.x),
        nm_to_mil(p.at.y),
        p.rot.deg()
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpResult {
    pub index: usize,
    pub op: String,
    pub status: String,
    #[serde(default)]
    pub created: Vec<Created>,
    /// Fields this op changed on objects that already existed (before/after).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed: Vec<Changed>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<sch_ops::OpError>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Counts {
    pub components_added: usize,
    pub components_deleted: usize,
    pub components_moved: usize,
    pub wires_added: usize,
    pub labels_added: usize,
    pub objects_deleted: usize,
    pub properties_changed: usize,
    pub transforms_changed: usize,
    pub attributes_changed: usize,
    pub sheets_created: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    #[error("{code}: {message}")]
    Op {
        code: String,
        message: String,
        remediation: Option<String>,
        /// Structured detail for the harness (`sch_ops::OpError::evidence`); usually `None`.
        evidence: Option<serde_json::Value>,
    },
}

fn e(code: &str, msg: impl Into<String>) -> ApplyError {
    ApplyError::Op {
        code: code.into(),
        message: msg.into(),
        remediation: None,
        evidence: None,
    }
}

fn e_rem(code: &str, msg: impl Into<String>, rem: impl Into<String>) -> ApplyError {
    ApplyError::Op {
        code: code.into(),
        message: msg.into(),
        remediation: Some(rem.into()),
        evidence: None,
    }
}

/// Step of the power-port stub search: KiCad's default schematic grid, so every
/// candidate position stays on grid.
const PORT_STUB_STEP_MIL: i64 = 50;
/// Ceiling on how far a power port may be pushed away from its pin to clear
/// neighbouring text: three 100 mil grid squares. Past that the stub wire, not the
/// port, would dominate the drawing, so the port is placed anyway and the layout
/// check reports the overlap (the fix is then to move the part, not the port).
const PORT_STUB_MAX_EXTRA_MIL: i64 = 300;
/// How far sideways off its own leg a power port may be pushed when nothing along the leg is
/// clear: two 100 mil grid squares. The stub is then an L instead of a straight run - the
/// corner a drafter draws to step a port past a neighbour's property text - and past two
/// squares the port has left the pin it belongs to.
const PORT_STUB_MAX_PERP_MIL: i64 = 200;
/// Offset of a power port's own value text from the port anchor along the body axis
/// ([`port_text_layout`]); the anchor of the stock library's own power fields.
const PORT_TEXT_GAP_MIL: f64 = 150.0;
/// Space a power port's value text keeps from a neighbouring text it shares a row with. Two
/// texts that merely abut read as one string - run 19 drew "+3V3 PWR_FLAG +3V3" across three
/// symbols - so the port's own text is grown by one grid square along its run before the
/// clearance test, which is a gap wide enough to read as a gap.
const PORT_TEXT_READ_GAP_MIL: f64 = 50.0;
/// Run out of a sideways pin before a power port turns to stand vertical, and the length of
/// that vertical leg: one 100 mil grid square each, the corner a drafter draws so a GND drops
/// below the pin row instead of standing in it.
const PORT_ELBOW_MIL: i64 = 100;
/// Step and ceiling of the sideways search for a `PWR_FLAG` that cannot stand on its pin
/// ([`Workset::flag_aside`]): the 100 mil grid, out to four squares. "PWR_FLAG" measures 377 mil
/// of value text at the 50 mil field size (`sch_read::bbox::text_width_mil`, calibrated against
/// KiCad 10 - the 320 mil this was first written for came from a metric that under-measured every
/// wide glyph), so half of it plus half of a neighbouring rail port's own text needs three
/// squares; four leaves one for a wider neighbour. `pwr_flag_is_the_width_the_flag_escape_is_sized_for`
/// in `sch-read/tests/text_metrics.rs` keeps that number and the metric in step.
const FLAG_ASIDE_STEP_MIL: i64 = 100;
const FLAG_ASIDE_MAX_MIL: i64 = 400;
/// Short wires a `move_component` walks out from a moved pin looking for a power port to
/// carry along: one for a straight stub, two for the L a sideways pin's port sits on.
const POWER_STUB_HOPS: usize = 2;
/// Ceiling on how far the placement nudge may push a part away from the position the author
/// wrote. The ring search walks the 100 mil grid, so this is six rings of Chebyshev distance: far
/// enough to clear a stacked passive and its property text (a 2-pin part with its labels occupies
/// about 500 mil), close enough that the part stays in the block it was authored into. Past that
/// the engine would be inventing a layout rather than resolving an overlap - a real run pushed a
/// diode 2600 mil away from the resistor it belonged with, and the model's only escape was
/// `exact`, which writes off-grid - so the op is refused with `PLACEMENT_BLOCKED` instead and the
/// author picks the spot.
const PLACEMENT_NUDGE_MAX_MIL: f64 = 600.0;
/// Radius around the area a placement search sweeps in which other objects are taken
/// into account (see [`Workset::port_stub_extra`] and [`Workset::hier_label_slot`]): a
/// property text sits within a few hundred mil of its symbol anchor, so a symbol
/// anchored further out than that cannot reach the candidate.
const NEIGHBOURHOOD_MIL: f64 = 1000.0;

/// Columns (mil) the hierarchical labels seeded for a sheet pin sit in inside the child
/// sheet: pins on the right edge of the sheet symbol get the right column, every other
/// side the left one, so the child reads left-to-right like the symbol does.
const HIER_LABEL_COL_MIL: (f64, f64) = (2000.0, 6000.0);
/// First row and row pitch (mil) of those columns (two 100 mil grid squares apart).
const HIER_LABEL_FIRST_ROW_MIL: f64 = 2000.0;
const HIER_LABEL_ROW_STEP_MIL: f64 = 200.0;
/// Rows the seeder may walk before it gives up and writes the label on its natural row
/// anyway; the layout check then reports the overlap for a human or the fixer, exactly as
/// the power-port search does. The corridor is sized from the pin count — a sheet with two
/// pins does not need a search 25 rows deep, and one with twenty needs more than the room
/// its own pins take — bounded by what fits on the drawable height of an A4 sheet.
const HIER_LABEL_SPARE_ROWS: i64 = 4;
const HIER_LABEL_MAX_ROWS: i64 = 25;

/// Rows the slot search may walk for a sheet with `pins` pins on the column being filled.
fn hier_label_rows(pins: usize) -> i64 {
    (pins as i64 + HIER_LABEL_SPARE_ROWS).clamp(HIER_LABEL_SPARE_ROWS + 1, HIER_LABEL_MAX_ROWS)
}

/// Outcome of the placement nudge search (see [`Workset::nudge_free_spot`]).
enum Nudge {
    /// The authored spot is free: place as authored.
    Clear,
    /// A free spot within [`PLACEMENT_NUDGE_MAX_MIL`] of the authored one, with the blocker that
    /// made the move necessary.
    Moved { to: Pt, blocker: String },
    /// The authored spot is taken and nothing within the bound is free; the string names what
    /// blocks the authored spot. The op is refused (`PLACEMENT_BLOCKED`).
    Blocked { blocker: String },
}

/// eeschema's connection grid (`SCHEMATIC_SETTINGS::m_ConnectionGridSize`, default
/// `DEFAULT_CONNECTION_GRID_MILS` = 50): pins that miss it are what `TestOffGridEndpoints`
/// reports, and wires or labels written on the grid will not meet them.
fn on_connection_grid(v: Nm) -> bool {
    v.rem_euclid(mil_to_nm(50.0)) == 0
}

/// What to do about a `PLACEMENT_OFF_GRID` warning. A placement can keep the authored position and
/// still be snapped (`no_nudge`); a move never nudges, so its only opt-out is `exact` itself.
const OFF_GRID_REMEDY_PLACE: &str =
    "Use `no_nudge: true` to keep the position and still snap it, or move the position onto a 50 mil point";
const OFF_GRID_REMEDY_MOVE: &str =
    "Drop `exact` so the destination is snapped to the grid, or move to a 50 mil point";

/// `PLACEMENT_OFF_GRID` for an `exact` placement or move: `exact` is the author's way to keep a
/// position the engine would otherwise nudge or snap, and it also skips the grid snap, so the dry
/// run has to say when the kept position leaves the anchor or a pin off the 50 mil connection grid.
/// Names the anchor when it is off-grid plus the first three offending pins (an off-grid anchor puts
/// every pin off the grid, so the list is capped rather than repeated per pin).
fn off_grid_warning(
    designator: &str,
    at: Pt,
    lib: &LibSymbol,
    unit: u32,
    pl: Placement,
    remedy: &str,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if !on_connection_grid(at.x) || !on_connection_grid(at.y) {
        parts.push(format!(
            "anchor ({:.0},{:.0}) mil",
            nm_to_mil(at.x),
            nm_to_mil(at.y)
        ));
    }
    let mut named = 0usize;
    let mut off = 0usize;
    for p in lib.pins_for_unit(unit) {
        let w = transform_point(p.at, pl);
        if on_connection_grid(w.x) && on_connection_grid(w.y) {
            continue;
        }
        off += 1;
        if named < 3 {
            named += 1;
            parts.push(format!(
                "pin {} at ({:.0},{:.0}) mil",
                p.number,
                nm_to_mil(w.x),
                nm_to_mil(w.y)
            ));
        }
    }
    if off > named {
        parts.push(format!("and {} more pins", off - named));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "PLACEMENT_OFF_GRID: {designator} is off the 50 mil connection grid ({}) because `exact` skips the grid snap; wires and labels written on the grid will not meet those pins. {remedy}",
        parts.join(", ")
    ))
}

/// How the drawing border reads in a `PLACEMENT_NUDGED` / `PLACEMENT_BLOCKED` message: the same
/// rectangle [`crate::gates::drawing_border`] gives the layout gate, named in mil so the author
/// can pick a spot from the message alone.
fn frame_blocker(paper: &str, frame: Option<&BBox>) -> String {
    match frame {
        Some(f) => format!(
            "{BORDER_BLOCKER_PREFIX} of the {paper} sheet (x {:.0}..{:.0}, y {:.0}..{:.0} mil)",
            nm_to_mil(f.min.x),
            nm_to_mil(f.max.x),
            nm_to_mil(f.min.y),
            nm_to_mil(f.max.y)
        ),
        None => BORDER_BLOCKER_PREFIX.to_string(),
    }
}

/// How a border blocker opens, so the refusal can tell it from an occupied spot.
const BORDER_BLOCKER_PREFIX: &str = "the drawing border";

/// In-memory working set for one apply run.
pub struct Workset<'a> {
    pub root_file: PathBuf,
    pub project_name: String,
    pub docs: BTreeMap<PathBuf, Document>,
    pub sheets: BTreeMap<PathBuf, Sheet>,
    /// Files created during this run (add_sheet create).
    pub created_files: Vec<PathBuf>,
    pub lib: &'a mut SymbolLibrary,
    pub counts: Counts,
    seeds: HashSet<(PathBuf, String)>,
    /// Extra symbol sources (`symbol_source` op field / template schematics).
    pub extra_cache: BTreeMap<String, List>,
}

impl<'a> Workset<'a> {
    pub fn new(
        root_file: PathBuf,
        project_name: String,
        docs: BTreeMap<PathBuf, Document>,
        lib: &'a mut SymbolLibrary,
    ) -> Result<Workset<'a>, ApplyError> {
        let mut ws = Workset {
            root_file,
            project_name,
            docs,
            sheets: BTreeMap::new(),
            created_files: Vec::new(),
            lib,
            counts: Counts::default(),
            seeds: HashSet::new(),
            extra_cache: BTreeMap::new(),
        };
        ws.refresh_all()?;
        Ok(ws)
    }

    fn refresh(&mut self, file: &Path) -> Result<(), ApplyError> {
        let doc = self
            .docs
            .get(file)
            .ok_or_else(|| e("SHEET_UNKNOWN", file.display().to_string()))?;
        let sheet =
            sch_read::sheet_from_document(doc, file).map_err(|err| e("PARSE", err.to_string()))?;
        self.sheets.insert(file.to_path_buf(), sheet);
        Ok(())
    }

    fn refresh_all(&mut self) -> Result<(), ApplyError> {
        let files: Vec<PathBuf> = self.docs.keys().cloned().collect();
        for f in files {
            self.refresh(&f)?;
        }
        Ok(())
    }

    fn root_uuid_of(&self, file: &Path) -> String {
        self.sheets
            .get(file)
            .map(|s| s.uuid.clone())
            .unwrap_or_default()
    }

    fn new_uuid(&mut self, file: &Path, seed: &str) -> Result<String, ApplyError> {
        let key = (file.to_path_buf(), seed.to_string());
        if !self.seeds.insert(key) {
            return Err(e(
                "DUPLICATE_SEED",
                format!("two ops produce the same node `{seed}`"),
            ));
        }
        Ok(id::node_uuid(&self.root_uuid_of(file), seed))
    }

    /// Instance path prefix for symbols placed in `file` (first instance of that file).
    fn instance_path(&self, file: &Path) -> String {
        // Rebuild the tree lazily from the in-memory sheets: root path + sheet uuids.
        let root_uuid = self.root_uuid_of(&self.root_file);
        if file == self.root_file {
            return format!("/{root_uuid}");
        }
        // find a sheet symbol in any file that references this file
        let mut best: Option<String> = None;
        let mut stack = vec![(self.root_file.clone(), format!("/{root_uuid}"))];
        let mut guard = 0;
        while let Some((f, path)) = stack.pop() {
            guard += 1;
            if guard > 10_000 {
                break;
            }
            if let Some(sheet) = self.sheets.get(&f) {
                for sh in &sheet.sheets {
                    let child = f.parent().unwrap_or(Path::new(".")).join(&sh.file);
                    let child = child.canonicalize().unwrap_or(child);
                    let p = format!("{path}/{}", sh.uuid);
                    if child == file && best.is_none() {
                        best = Some(p.clone());
                    }
                    stack.push((child, p));
                }
            }
        }
        best.unwrap_or_else(|| format!("/{root_uuid}"))
    }

    fn sheet(&self, file: &Path) -> Result<&Sheet, ApplyError> {
        self.sheets
            .get(file)
            .ok_or_else(|| e("SHEET_UNKNOWN", file.display().to_string()))
    }

    fn doc_mut(&mut self, file: &Path) -> Result<&mut Document, ApplyError> {
        self.docs
            .get_mut(file)
            .ok_or_else(|| e("SHEET_UNKNOWN", file.display().to_string()))
    }

    // ----- resolution helpers -----

    fn find_symbol(
        &self,
        file: &Path,
        designator: &str,
        unit: Option<u32>,
    ) -> Result<SymbolInst, ApplyError> {
        let sheet = self.sheet(file)?;
        let mut matches: Vec<&SymbolInst> = sheet
            .symbols
            .iter()
            .filter(|s| s.reference == designator)
            .collect();
        if let Some(u) = unit {
            matches.retain(|s| s.unit == u);
        }
        match matches.len() {
            0 => Err(e(
                "COMPONENT_NOT_FOUND",
                format!("{designator} not found in {}", file.display()),
            )),
            _ => Ok(matches[0].clone()),
        }
    }

    /// Resolve a symbol by `uuid` (stable across applies) or by designator.
    fn find_symbol_ref(
        &self,
        file: &Path,
        designator: Option<&str>,
        uuid: Option<&str>,
        unit: Option<u32>,
    ) -> Result<SymbolInst, ApplyError> {
        if let Some(u) = uuid.filter(|u| !u.is_empty()) {
            let sheet = self.sheet(file)?;
            return sheet
                .symbols
                .iter()
                .find(|s| s.uuid == u)
                .cloned()
                .ok_or_else(|| {
                    e(
                        "COMPONENT_NOT_FOUND",
                        format!("uuid {u} not found in {}", file.display()),
                    )
                });
        }
        match designator {
            Some(d) => self.find_symbol(file, d, unit),
            None => Err(e("COMPONENT_NOT_FOUND", "no designator or uuid given")),
        }
    }

    fn pin_world(&self, file: &Path, ep: &Endpoint) -> Result<Pt, ApplyError> {
        match ep {
            Endpoint::Point(p) => Ok(*p),
            Endpoint::Pin {
                reference,
                unit,
                pin,
            } => {
                let sheet = self.sheet(file)?;
                let cands: Vec<&SymbolInst> = sheet
                    .symbols
                    .iter()
                    .filter(|s| {
                        s.reference == *reference && unit.map(|u| s.unit == u).unwrap_or(true)
                    })
                    .collect();
                if cands.is_empty() {
                    return Err(e("COMPONENT_NOT_FOUND", format!("{reference} not found")));
                }
                for s in cands {
                    let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                        continue;
                    };
                    if let Some(p) = world_pins(s, lib).into_iter().find(|p| p.number == *pin) {
                        return Ok(p.at);
                    }
                }
                Err(e(
                    "PIN_NOT_FOUND",
                    format!("{reference}.{pin} not found (check the pin number and unit)"),
                ))
            }
        }
    }

    /// A spot `distance` beyond a pin, on the axis the pin points *away* from its own symbol
    /// (`Place::NearPin`, the `place_decoupling near:` form). The direction is the dominant
    /// component of (pin tip - the symbol's anchor), which every rotation and mirror has
    /// already gone through the single `transform` to produce: a cap anchored to the VI pin on
    /// the left edge of a regulator lands to its left, one anchored to the GND pin underneath
    /// lands below it. A fixed authored offset put it inside the body about half the time.
    /// Falls back to "one distance below the pin" when the pin sits on the anchor itself
    /// (a power symbol) or the symbol cannot be found; the grid snap and the placement nudge
    /// then finish the job as they do for any other placement.
    fn near_pin_spot(&self, file: &Path, ep: &Endpoint, distance: Nm) -> Result<Pt, ApplyError> {
        let at = self.pin_world(file, ep)?;
        let below = at.add(Pt::new(0, distance));
        let Endpoint::Pin {
            reference, unit, ..
        } = ep
        else {
            return Ok(below);
        };
        let sheet = self.sheet(file)?;
        let Some(anchor) = sheet
            .symbols
            .iter()
            .find(|s| s.reference == *reference && unit.map(|u| s.unit == u).unwrap_or(true))
            .map(|s| s.placement.at)
        else {
            return Ok(below);
        };
        let (dx, dy) = (at.x - anchor.x, at.y - anchor.y);
        if dx == 0 && dy == 0 {
            return Ok(below);
        }
        Ok(if dx.abs() >= dy.abs() {
            at.add(Pt::new(distance * dx.signum(), 0))
        } else {
            at.add(Pt::new(0, distance * dy.signum()))
        })
    }

    fn anchor_world(&self, file: &Path, a: &Anchor) -> Result<Pt, ApplyError> {
        match a {
            Anchor::Endpoint(ep) => self.pin_world(file, ep),
            Anchor::Mid(a, b) => {
                let (pa, pb) = (self.pin_world(file, a)?, self.pin_world(file, b)?);
                let grid = mil_to_nm(50.0);
                let snap = |v: Nm| ((v as f64 / grid as f64).round() as Nm) * grid;
                // Collinear pins: the label must stay on the wire, so only the coordinate along the wire
                // is snapped; snapping the other one detached the label whenever the pins themselves sat
                // off the grid (a real run: pins at x = 5666 mil, label at 5650 -> LABEL_DANGLING).
                if pa.x == pb.x {
                    return Ok(Pt::new(pa.x, snap((pa.y + pb.y) / 2)));
                }
                if pa.y == pb.y {
                    return Ok(Pt::new(snap((pa.x + pb.x) / 2), pa.y));
                }
                // Not collinear: the label must sit on the routed wire (hv route,
                // corner at (b.x, a.y)); use the midpoint of the longer leg.
                let corner = Pt::new(pb.x, pa.y);
                let leg1 = (pb.x - pa.x).abs();
                let leg2 = (pb.y - pa.y).abs();
                if leg1 >= leg2 {
                    Ok(Pt::new(snap((pa.x + corner.x) / 2), pa.y))
                } else {
                    Ok(Pt::new(corner.x, snap((corner.y + pb.y) / 2)))
                }
            }
        }
    }

    /// Direction pointing away from the symbol body at a pin, as a label rotation.
    fn pin_away_rotation(&self, file: &Path, ep: &Endpoint) -> Option<i64> {
        let Endpoint::Pin {
            reference,
            unit,
            pin,
        } = ep
        else {
            return None;
        };
        let sheet = self.sheets.get(file)?;
        let s = sheet
            .symbols
            .iter()
            .find(|s| s.reference == *reference && unit.map(|u| s.unit == u).unwrap_or(true))?;
        let lib = sheet.lib_symbol(&s.lib_id)?;
        let lp = lib.pins_for_unit(s.unit).find(|p| p.number == *pin)?;
        // lib angle: direction from the pin end toward the body; away = +180
        let away = (lp.angle + 180).rem_euclid(360);
        let (vx, vy) = match away {
            0 => (1i64, 0i64),
            90 => (0, 1),
            180 => (-1, 0),
            270 => (0, -1),
            _ => (1, 0),
        };
        // transform the vector like a point relative to the anchor
        let origin = transform_point(
            Pt::new(0, 0),
            Placement {
                at: Pt::new(0, 0),
                ..s.placement
            },
        );
        let tip = transform_point(
            Pt::new(vx, vy),
            Placement {
                at: Pt::new(0, 0),
                ..s.placement
            },
        );
        let (dx, dy) = (tip.x - origin.x, tip.y - origin.y);
        Some(match (dx.signum(), dy.signum()) {
            (1, 0) => 0,
            (0, -1) => 90,
            (-1, 0) => 180,
            (0, 1) => 270,
            _ => 0,
        })
    }

    /// The away rotation of an existing part pin standing exactly on `at`, if there is one:
    /// the direction a power symbol dropped on that point has to face away from. Power
    /// symbols already on the point are skipped - a port faces away from the part, not away
    /// from another port stacked on it.
    fn pin_away_at(&self, file: &Path, at: Pt) -> Option<i64> {
        let sheet = self.sheets.get(file)?;
        for s in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            if lib.is_power {
                continue;
            }
            let Some(pin) = world_pins(s, lib).into_iter().find(|wp| wp.at == at) else {
                continue;
            };
            return self.pin_away_rotation(
                file,
                &Endpoint::Pin {
                    reference: s.reference.clone(),
                    unit: Some(s.unit),
                    pin: pin.number.clone(),
                },
            );
        }
        None
    }

    /// Points inside `within` that already carry a pin, a wire end, a junction or a
    /// label anchor. A power port pin dropped on one of them would merge two nets (or
    /// stack two ports), so both port placers keep their moved ports off these points.
    fn busy_points(&self, file: &Path, within: &BBox) -> Vec<Pt> {
        let Ok(sheet) = self.sheet(file) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut add = |p: Pt| {
            if within.contains(p) {
                out.push(p);
            }
        };
        for w in &sheet.wires {
            add(w.a);
            add(w.b);
        }
        for l in &sheet.labels {
            add(l.at);
        }
        for j in &sheet.junctions {
            add(j.at);
        }
        for s in &sheet.symbols {
            if let Some(lib) = sheet.lib_symbol(&s.lib_id) {
                for wp in world_pins(s, lib) {
                    add(wp.at);
                }
            }
        }
        out
    }

    /// The foreign pin tips a wire routed from `a` to `b` may not land on or run across, each with
    /// the name to report. Every pin on the sheet counts except the two ends of the route itself -
    /// including the other pins of the very symbols being joined, which is how a leg drawn up a
    /// connector's pin column puts three of its pins on one net.
    fn route_obstacles(&self, file: &Path, a: Pt, b: Pt) -> Vec<(Pt, String)> {
        let Ok(sheet) = self.sheet(file) else {
            return Vec::new();
        };
        let mut out: Vec<(Pt, String)> = Vec::new();
        for s in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            for wp in world_pins(s, lib) {
                if wp.at != a && wp.at != b {
                    out.push((wp.at, format!("{}.{}", s.reference, wp.number)));
                }
            }
        }
        // Deterministic: the message names the pins in one order whatever the file order is.
        out.sort_by(|x, y| (x.0.x, x.0.y, &x.1).cmp(&(y.0.x, y.0.y, &y.1)));
        out
    }

    /// The warning for a wire drawn onto a no-connect marker, if it touches one. A no-connect says
    /// the pin is deliberately unused, so a wire that ends there (KiCad wires the pin into the net
    /// and ERC reports the contradiction) or crosses it is worth saying out loud - run 20 drew both
    /// and nothing noticed. The order of the two ops decides which end reports it: an
    /// `add_no_connect` on a pin something already reaches is refused outright.
    fn no_connect_warning(&self, file: &Path, path: &[Pt]) -> Option<String> {
        let sheet = self.sheet(file).ok()?;
        let nc: Vec<Pt> = sheet.no_connects.iter().map(|n| n.at).collect();
        let hit = path_hits(path, &nc);
        if hit.is_empty() {
            return None;
        }
        let at: Vec<String> = hit
            .iter()
            .map(|p| format!("({:.0},{:.0})", nm_to_mil(p.x), nm_to_mil(p.y)))
            .collect();
        Some(format!(
            "WIRE_ON_NO_CONNECT: this wire touches the no-connect marker at {} mil; a pin marked unused that a wire reaches is an ERC error, so delete the marker (delete_object) or route around it",
            at.join(", ")
        ))
    }

    /// What already reaches `at`, when something does: a wire that ends there, a junction, a label,
    /// or a foreign symbol's pin stacked on the point. A wire that only passes through is not a
    /// connection in eeschema (a mid-span T needs a junction), so it is not listed here.
    fn connection_at(&self, file: &Path, at: Pt, own_ref: Option<&str>) -> Option<String> {
        let sheet = self.sheet(file).ok()?;
        if sheet
            .wires
            .iter()
            .any(|w| !w.is_bus && (w.a == at || w.b == at))
        {
            return Some("a wire ending on it".into());
        }
        if sheet.junctions.iter().any(|j| j.at == at) {
            return Some("a junction on it".into());
        }
        if let Some(l) = sheet.labels.iter().find(|l| l.at == at) {
            return Some(format!("the label {}", l.text));
        }
        let own = own_ref?;
        for s in &sheet.symbols {
            if s.reference == own {
                continue;
            }
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            if let Some(wp) = world_pins(s, lib).into_iter().find(|wp| wp.at == at) {
                return Some(format!(
                    "pin {}.{} on the same point",
                    s.reference, wp.number
                ));
            }
        }
        None
    }

    /// Which side the value text of the power symbol already standing on `at` sits on, as a
    /// world unit vector. A `PWR_FLAG` hung beside a rail port shares that node with it, so it
    /// has to put its own text somewhere else or the two read as one string.
    fn port_text_side_at(&self, file: &Path, at: Pt) -> Option<(i64, i64)> {
        let doc = self.docs.get(file)?;
        let sheet = self.sheet(file).ok()?;
        for s in &sheet.symbols {
            let Some(lib) = sheet.lib_symbol(&s.lib_id) else {
                continue;
            };
            if !lib.is_power || !world_pins(s, lib).iter().any(|wp| wp.at == at) {
                continue;
            }
            let Some((_, b)) = symbol_text_boxes(doc, s)
                .into_iter()
                // `symbol_text_boxes` labels a box "<reference> <field>".
                .find(|(n, _)| n.ends_with(" value"))
            else {
                continue;
            };
            let (cx, cy) = (
                (b.min.x + b.max.x) / 2 - at.x,
                (b.min.y + b.max.y) / 2 - at.y,
            );
            return Some(if cx.abs() > cy.abs() {
                (cx.signum(), 0)
            } else {
                (0, cy.signum())
            });
        }
        None
    }

    /// Graphics box of `lib_id` in library coordinates, as the layout gate sees it
    /// (`lib_graphics_bbox` of the sheet's own `lib_symbols` entry).
    fn lib_glyph_box(&self, file: &Path, lib_id: &str) -> Option<BBox> {
        self.docs
            .get(file)?
            .root
            .find("lib_symbols")
            .and_then(|c| {
                c.find_all("symbol")
                    .find(|s| s.arg(0).as_deref() == Some(lib_id))
            })
            .map(|n| lib_graphics_bbox(n, 1))
            .filter(|b| !b.is_empty())
    }

    /// Everything a power-port placement search has to keep clear of inside `region`:
    /// property texts and label flags it must stay readable beside, foreign symbol bodies
    /// it may not sit on, and the connection points a stub may neither end on nor cross.
    /// The anchor symbol is connected to the port by design, so only its texts count, not
    /// its body.
    fn port_obstacles(&self, file: &Path, region: &BBox, anchor_ref: &str) -> PortObstacles {
        let (Some(doc), Ok(sheet)) = (self.docs.get(file), self.sheet(file)) else {
            return PortObstacles::default();
        };
        let mut obs = PortObstacles {
            busy: self.busy_points(file, region),
            ..PortObstacles::default()
        };
        for s in &sheet.symbols {
            // A neighbour counts when its anchor is in the swept region *or* when one of its
            // property texts reaches into it: an autoplaced field sits a few hundred mil off
            // its anchor, and not printing on top of one is the whole point of the search.
            let texts = symbol_text_boxes(doc, s);
            if !region.contains(s.placement.at) && !texts.iter().any(|(_, b)| b.intersects(region))
            {
                continue;
            }
            obs.texts.extend(texts.into_iter().map(|(_, b)| b));
            if s.reference != anchor_ref {
                if let Some(b) = symbol_graphics_bbox(doc, s) {
                    obs.bodies.push(b);
                }
            }
        }
        for l in &sheet.labels {
            if !region.contains(l.at) {
                continue;
            }
            let kind = match l.kind {
                LabelKind::Local => "local",
                LabelKind::Global => "global",
                _ => "hierarchical",
            };
            obs.texts
                .push(label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0));
        }
        obs
    }

    /// Where a power port anchored on a pin actually goes: the first spot on or beyond the
    /// end of its leg at which neither its glyph, nor its own value text, nor the wire that
    /// reaches it lands on something already drawn around the pin. `tip` is where the leg
    /// starts (the pin itself, or the elbow of the L a sideways pin gets) and `away` is the
    /// leg direction. The answer is `(end, extra_mil, perp_mil)`; `None` means nothing within
    /// reach was clear, and the caller then places the port anyway and warns
    /// `PORT_STUB_BLOCKED` - it is never silent.
    ///
    /// The geometry is the geometry the layout gate will use once the port is written:
    /// the port glyph is `lib_graphics_bbox` of its library symbol through the single
    /// `transform` (what `symbol_graphics_bbox` computes for a placed symbol), the
    /// neighbours are `symbol_text_boxes` / `symbol_graphics_bbox` / `label_flag_bbox`,
    /// and the rejection predicates use the same shrink values as `gates::overlap`, so a
    /// candidate is rejected exactly when the gate would report `TEXT_OVERLAP`,
    /// `SYMBOL_OVERLAP` or `LABEL_OVER_BODY` for it, and accepted as soon as it would not.
    /// The port's own value text is not a gate source (a power text over a part is normal
    /// KiCad practice), but running it into a neighbour's property text is unreadable, so it
    /// is kept clear - and one reading gap clear (`PortObstacles::clear`) - of foreign texts
    /// and labels as well.
    ///
    /// The search is deterministic: straight along the leg first, in ascending 50 mil steps
    /// (KiCad's default schematic grid, so every candidate stays on grid) up to
    /// [`PORT_STUB_MAX_EXTRA_MIL`]; then the same sweep stepped 100 mil at a time to either
    /// side, out to [`PORT_STUB_MAX_PERP_MIL`], where the stub becomes the L that `route`
    /// draws. Each sweep stops early at a candidate whose path reaches a pin, a wire end, a
    /// junction or a label (ending there or crossing it would change the netlist).
    #[allow(clippy::too_many_arguments)]
    fn port_stub_spot(
        &self,
        file: &Path,
        lib_id: &str,
        net_name: &str,
        anchor_ref: &str,
        tip: Pt,
        away: i64,
        stub0: i64,
        port_rot: i64,
        text: PortText,
    ) -> Option<(Pt, i64, i64)> {
        let placement = Placement {
            at: Pt::new(0, 0),
            rot: Rot::from_deg(port_rot as f64).unwrap_or_default(),
            mirror: Mirror::None,
        };
        let (dx, dy) = away_unit(away);
        // Perpendicular to the leg, so a blocked straight run can step aside.
        let (px, py) = (-dy, dx);
        let end_of = |extra: i64, perp: i64| {
            let len = mil_to_nm((stub0 + extra) as f64);
            let side = mil_to_nm(perp as f64);
            Pt::new(tip.x + dx * len + px * side, tip.y + dy * len + py * side)
        };
        // No cached glyph to measure: nothing here can be judged, so the caller places the
        // port at its natural spot (a `PWR_FLAG` hangs aside) and the layout check judges the
        // result. That is not a *blocked* placement, and the caller tells the two apart by
        // asking for the glyph box itself.
        let local = self.lib_glyph_box(file, lib_id)?;
        let glyph = |end: Pt| {
            world_box(
                &local,
                Placement {
                    at: end,
                    ..placement
                },
            )
        };
        let value = |end: Pt| port_value_box(net_name, end, text.val_off);
        let steps: Vec<i64> = (0..=PORT_STUB_MAX_EXTRA_MIL / PORT_STUB_STEP_MIL)
            .map(|k| k * PORT_STUB_STEP_MIL)
            .collect();
        // Straight first: an L is a bigger change to the drawing than a longer stub, so it is
        // only reached for once nothing straight is clear. Sides alternate for determinism.
        let mut perps = vec![0i64];
        let mut k = 2 * PORT_STUB_STEP_MIL;
        while k <= PORT_STUB_MAX_PERP_MIL {
            perps.push(k);
            perps.push(-k);
            k += 2 * PORT_STUB_STEP_MIL;
        }
        // Neighbourhood: everything the port can sweep, grown by [`NEIGHBOURHOOD_MIL`]
        // (the widest stock property texts are ~800 mil).
        let mut region = BBox::empty();
        for perp in &perps {
            for extra in &steps {
                let end = end_of(*extra, *perp);
                region.union(&glyph(end));
                region.union(&value(end));
            }
        }
        let region = region.expand(mil_to_nm(NEIGHBOURHOOD_MIL));
        let obs = self.port_obstacles(file, &region, anchor_ref);
        for perp in perps {
            for extra in steps.iter().copied() {
                // A step aside needs a leg to turn off: leaving the pin tip sideways is not the
                // corner a drafter draws, and a port on the pin's own axis is the convention.
                if perp != 0 && stub0 + extra < PORT_ELBOW_MIL {
                    continue;
                }
                let end = end_of(extra, perp);
                // The wire the caller will write, so the search judges the drawing it makes.
                let path = route(tip, end, "hv");
                if path.windows(2).any(|w| obs.blocked(w[0], w[1])) {
                    break;
                }
                let segs: Vec<BBox> = path.windows(2).map(|w| segment_box(w[0], w[1])).collect();
                if obs.clear(&glyph(end), &value(end), &segs) {
                    return Some((end, extra, perp));
                }
            }
        }
        None
    }

    /// Where a `PWR_FLAG` goes when it cannot stand on its own pin - a power symbol or a
    /// label already holds that point, or nothing along the pin was clear. It hangs to the
    /// side on a short wire, perpendicular to the pin, so it still reads as belonging to
    /// that node.
    ///
    /// The candidates step out on the 100 mil grid up to [`FLAG_ASIDE_MAX_MIL`],
    /// alternating sides so the result is deterministic, and the first one that satisfies
    /// [`PortObstacles::clear`] wins - "PWR_FLAG" is 377 mil of value text, so clearing the
    /// value text of the rail port it shares the node with takes 300 mil, which is why the
    /// old fixed 100 mil offset always overprinted it. A candidate whose wire would end on
    /// or run through a connection point is never taken (that would merge two nets); if
    /// nothing is clear the nearest free offset is used and the layout check reports the
    /// overlap.
    ///
    /// The answer is `(end, cleared)`; `cleared` is false when nothing within reach was
    /// clear, and the caller then warns `PORT_STUB_BLOCKED` rather than hanging the flag
    /// silently over its neighbour.
    #[allow(clippy::too_many_arguments)]
    fn flag_aside(
        &self,
        file: &Path,
        lib_id: &str,
        net_name: &str,
        anchor_ref: &str,
        p: Pt,
        away: i64,
        port_rot: i64,
        text: PortText,
    ) -> (Pt, bool) {
        let (ax, ay) = away_unit(away);
        // Perpendicular to the pin; a port with no pin direction falls back to +X.
        let (dx, dy) = if ax == 0 && ay == 0 {
            (1, 0)
        } else {
            (-ay, ax)
        };
        let fallback = Pt::new(
            p.x + dx * mil_to_nm(FLAG_ASIDE_STEP_MIL as f64),
            p.y + dy * mil_to_nm(FLAG_ASIDE_STEP_MIL as f64),
        );
        let candidates: Vec<Pt> = (1..=FLAG_ASIDE_MAX_MIL / FLAG_ASIDE_STEP_MIL)
            .flat_map(|k| {
                let d = mil_to_nm((k * FLAG_ASIDE_STEP_MIL) as f64);
                [(dx, dy), (-dx, -dy)]
                    .map(|(cx, cy)| Pt::new(p.x + cx * d, p.y + cy * d))
                    .into_iter()
            })
            .collect();
        let value = |end: Pt| port_value_box(net_name, end, text.val_off);
        // The obstacles are gathered before the glyph is looked up, so the branch
        // that has no glyph box to test still gets the connection-point filter:
        // hanging a flag onto an existing pin, wire end or junction would merge
        // two nets, and that is true whether or not the library symbol is cached.
        // The region is the swept candidates and their value texts, grown by
        // [`NEIGHBOURHOOD_MIL`]; the glyph of a power port sits inside that.
        let mut region = BBox::empty();
        for end in &candidates {
            region.include(*end);
            region.union(&value(*end));
        }
        let region = region.expand(mil_to_nm(NEIGHBOURHOOD_MIL));
        let obs = self.port_obstacles(file, &region, anchor_ref);
        let free: Vec<Pt> = candidates
            .iter()
            .copied()
            .filter(|end| !obs.blocked(p, *end))
            .collect();
        let Some(local) = self.lib_glyph_box(file, lib_id) else {
            // No cached glyph to measure: the nearest offset whose wire stays
            // clear of the connection points, and the layout check judges the
            // rest. Nothing was verified, so the caller still hears about it.
            return (free.first().copied().unwrap_or(fallback), false);
        };
        let placement = Placement {
            at: Pt::new(0, 0),
            rot: Rot::from_deg(port_rot as f64).unwrap_or_default(),
            mirror: Mirror::None,
        };
        let glyph = |end: Pt| {
            world_box(
                &local,
                Placement {
                    at: end,
                    ..placement
                },
            )
        };
        match free
            .iter()
            .copied()
            .find(|end| obs.clear(&glyph(*end), &value(*end), &[segment_box(p, *end)]))
        {
            Some(end) => (end, true),
            None => (free.first().copied().unwrap_or(fallback), false),
        }
    }

    /// Path of the file a sheet symbol in `file` points at, resolved the way `add_sheet`
    /// resolves it (the child name is relative to the parent's directory and the directory,
    /// not the file, is canonicalized so a child that does not exist yet still resolves).
    fn child_file_path(&self, file: &Path, child_file: &str) -> PathBuf {
        let child = file.parent().unwrap_or(Path::new(".")).join(child_file);
        child
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_default()
            .join(child.file_name().unwrap_or_default())
    }

    /// Anchor and rotation for the hierarchical label of a sheet pin inside the child sheet. Deterministic: the column follows the pin's side and the search walks
    /// rows from `start_row` in [`HIER_LABEL_ROW_STEP_MIL`] steps (so every candidate stays
    /// on KiCad's 100 mil grid), skipping a row whose anchor is already taken by a pin, a
    /// wire end, a junction or another label (landing there would rewire the sheet) and one
    /// whose label flag would run into a symbol body, a property text or another label. The
    /// rejection predicates use the same shrinks as `gates::overlap`, so a row is skipped
    /// exactly when the layout gate would report the overlap. After the corridor
    /// ([`hier_label_rows`], sized from `pins`) the natural row is used anyway and the gate
    /// reports it.
    fn hier_label_slot(
        &self,
        child: &Path,
        name: &str,
        side: &str,
        start_row: i64,
        pins: usize,
    ) -> (Pt, i64) {
        let right = side == "right";
        let x = mil_to_nm(if right {
            HIER_LABEL_COL_MIL.1
        } else {
            HIER_LABEL_COL_MIL.0
        });
        let rot = if right { 0 } else { 180 };
        let row_at = |r: i64| {
            Pt::new(
                x,
                mil_to_nm(HIER_LABEL_FIRST_ROW_MIL + HIER_LABEL_ROW_STEP_MIL * r as f64),
            )
        };
        let flag = |p: Pt| label_flag_bbox(name, "hierarchical", p, rot as f64, 50.0);
        let (Some(doc), Ok(sheet)) = (self.docs.get(child), self.sheet(child)) else {
            return (row_at(start_row), rot);
        };
        let rows: Vec<i64> = (start_row..start_row + hier_label_rows(pins)).collect();
        let mut region = BBox::empty();
        for r in &rows {
            region.union(&flag(row_at(*r)));
        }
        let region = region.expand(mil_to_nm(NEIGHBOURHOOD_MIL));
        let mut boxes: Vec<BBox> = Vec::new();
        for s in &sheet.symbols {
            if !region.contains(s.placement.at) {
                continue;
            }
            boxes.extend(symbol_text_boxes(doc, s).into_iter().map(|(_, b)| b));
            if let Some(b) = symbol_graphics_bbox(doc, s) {
                boxes.push(b);
            }
        }
        for l in &sheet.labels {
            if !region.contains(l.at) {
                continue;
            }
            let kind = match l.kind {
                LabelKind::Local => "local",
                LabelKind::Global => "global",
                _ => "hierarchical",
            };
            boxes.push(label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0));
        }
        // Same shrinks as `gates::overlap`: touching boxes are not a collision.
        let shrink = -mil_to_nm(5.0);
        let busy = self.busy_points(child, &region);
        for r in rows {
            let p = row_at(r);
            if busy.contains(&p) {
                continue;
            }
            let f = flag(p).expand(shrink);
            if !boxes.iter().any(|b| b.expand(shrink).intersects(&f)) {
                return (p, rot);
            }
        }
        (row_at(start_row), rot)
    }

    /// Write the hierarchical label that matches a sheet pin inside the child sheet, unless
    /// the child already has one of that name (so a second apply of the same op-list adds
    /// nothing). A sheet pin without it is an eeschema `hier_label_mismatch` — `sch-check`
    /// `SHEET_PIN_UNMATCHED` — and the pin is not connectable from inside the child, so both
    /// `add_sheet` and `add_sheet_pin` seed it through this one path.
    ///
    /// Returns the row the label went on (the caller seeds the next pin *of the same column*
    /// from the row after it), or `None` when nothing was written: the label is already there,
    /// or the child is not part of the hierarchy this run read and therefore not writable here.
    ///
    /// The row counter is per column, not per sheet. With one counter for both columns an
    /// input and the output it feeds never landed on the same row, so the scaffold opened with
    /// its two labels on a staircase and nothing to wire straight across.
    fn seed_hier_label(
        &mut self,
        child: &Path,
        name: &str,
        kind: &str,
        side: &str,
        start_row: i64,
        pins: usize,
    ) -> Result<Option<i64>, ApplyError> {
        // Red line 14: nothing outside the project root is written, whatever path a sheet symbol
        // names. The child must also be part of the hierarchy this run read, or there is no
        // document to write into (and no pre-image sha for the transaction).
        let root_dir = self
            .root_file
            .parent()
            .unwrap_or(Path::new("."))
            .canonicalize()
            .unwrap_or_default();
        if !child.starts_with(&root_dir) {
            return Ok(None);
        }
        let Ok(sheet) = self.sheet(child) else {
            return Ok(None);
        };
        if sheet
            .labels
            .iter()
            .any(|l| l.kind == LabelKind::Hierarchical && l.text == name)
        {
            return Ok(None);
        }
        let (p, rot) = self.hier_label_slot(child, name, side, start_row, pins);
        let u = self.new_uuid(child, &id::seed_label("hier", name, &id::anchor_pt(p)))?;
        let node = nodes::label("hierarchical_label", name, p, rot, Some(kind), &u, 1);
        self.push_root(child, node)?;
        self.refresh(child)?;
        self.counts.labels_added += 1;
        let row = ((nm_to_mil(p.y) - HIER_LABEL_FIRST_ROW_MIL) / HIER_LABEL_ROW_STEP_MIL) as i64;
        Ok(Some(row))
    }

    fn ensure_lib_symbol(&mut self, file: &Path, lib_id: &str) -> Result<LibSymbol, ApplyError> {
        if let Some(l) = self.sheet(file)?.lib_symbol(lib_id) {
            return Ok(l.clone());
        }
        let node = if let Some(n) = self.extra_cache.get(lib_id) {
            n.clone()
        } else {
            self.lib.cache_node(lib_id).ok_or_else(|| ApplyError::Op {
                code: "SYMBOL_NOT_FOUND".into(),
                message: format!("{lib_id} is not in the schematic cache nor in any configured symbol library"),
                remediation: Some("check the nickname in sym-lib-table or use lib.search to find the right lib_id".into()),
                evidence: None,
            })?
        };
        let doc = self.doc_mut(file)?;
        let lib_pos = doc.root.position("lib_symbols");
        let mut node = node;
        kicad_sexpr::pretty(&mut node, 2);
        match lib_pos {
            Some(i) => {
                if let Some(Node::List(ls)) = doc.root.children.get_mut(i) {
                    if ls.children.len() == 1 {
                        // `(lib_symbols)` empty: give it KiCad's block layout
                        ls.ws = vec![String::new(), "\n\t".to_string()];
                        ls.children.push(Node::List(node));
                        ls.ws.insert(1, "\n\t\t".to_string());
                    } else {
                        ls.push(Node::List(node));
                    }
                }
            }
            None => {
                let mut ls = List::new();
                ls.children.push(Node::bare("lib_symbols"));
                ls.ws = vec![String::new(), "\n\t\t".to_string(), "\n\t".to_string()];
                ls.children.push(Node::List(node));
                let pos = doc.root.position("paper").map(|i| i + 1).unwrap_or(1);
                doc.root.insert(pos, Node::List(ls));
            }
        }
        self.refresh(file)?;
        self.sheet(file)?
            .lib_symbol(lib_id)
            .cloned()
            .ok_or_else(|| e("SYMBOL_NOT_FOUND", lib_id.to_string()))
    }

    /// The next free `#`-prefixed power reference with this prefix (`#PWR`, `#FLG`), counting
    /// every reference already in the working set plus `extra` - the ones this same op has just
    /// handed out and not written yet, so a multi-instance placement gets one name per instance.
    fn next_power_ref(&self, prefix: &str, extra: &[String]) -> String {
        let mut n = 1;
        let used: HashSet<&str> = self
            .sheets
            .values()
            .flat_map(|s| s.symbols.iter().map(|x| x.reference.as_str()))
            .chain(extra.iter().map(|s| s.as_str()))
            .collect();
        loop {
            let r = format!("{prefix}{n:02}");
            if !used.contains(r.as_str()) {
                return r;
            }
            n += 1;
        }
    }

    fn push_root(&mut self, file: &Path, node: List) -> Result<(), ApplyError> {
        let doc = self.doc_mut(file)?;
        // Insert before `sheet_instances` / `embedded_fonts` if present so the
        // file keeps KiCad's ordering (objects, then instances, then fonts).
        let pos = doc
            .root
            .position("sheet_instances")
            .or_else(|| doc.root.position("embedded_fonts"));
        match pos {
            Some(i) => doc.root.insert(i, Node::List(node)),
            None => doc.root.push(Node::List(node)),
        }
        Ok(())
    }

    // ----- handlers -----

    pub fn apply(&mut self, file: &Path, x: &ExpandedOp) -> Result<OpResult, ApplyError> {
        let mut res = OpResult {
            index: x.authored_index,
            op: x.op.name().to_string(),
            status: "ok".into(),
            created: vec![],
            changed: vec![],
            warnings: vec![],
            error: None,
        };
        match &x.op {
            Op::PlaceComponent {
                lib_id,
                designator,
                place,
                rotation,
                mirror,
                unit,
                value,
                footprint,
                symbol_source,
                instance_designators,
            } => {
                if let Some(src) = symbol_source {
                    self.load_symbol_source(src, lib_id)?;
                }
                let lib = self.ensure_lib_symbol(file, lib_id)?;
                let mut at = match place {
                    Place::At(p) => *p,
                    Place::Relative { anchor, offset } => {
                        self.pin_world(file, anchor)?.add(*offset)
                    }
                    Place::NearPin { anchor, distance } => {
                        self.near_pin_spot(file, anchor, *distance)?
                    }
                };
                let value = value
                    .clone()
                    .unwrap_or_else(|| lib.property("Value").unwrap_or(&lib.id).to_string());
                // A power symbol is a port, not a part. KiCad's own convention decides which
                // way it faces - a GND bar down, a rail arrow up, a PWR_FLAG along the pin it
                // flags - and a model that writes `rotation` here writes the rotation of the
                // part it is attaching to, which stands the port across the pin row: run 19 laid
                // a PWR_FLAG over four of J1's pins that way. So the pose comes from the pin the
                // symbol lands on, or from the library's own upright pose when it lands in free
                // space, and `exact` is the author's way to keep a pose deliberately.
                let is_power = lib.is_power || lib_id.starts_with("power:");
                let power_pin = if is_power {
                    self.pin_away_at(file, at)
                } else {
                    None
                };
                let is_flag = value == "PWR_FLAG" || lib_id.ends_with(":PWR_FLAG");
                // KiCad annotates a power symbol with a `#`-prefixed reference, and that prefix is
                // what keeps a port out of the BOM and out of every part check. A model drawing
                // designators from its refdes lease writes a part designator instead - run 20
                // placed `power:PWR_FLAG` as `PWR1`, and the delivery gate then asked a port for a
                // footprint - so the reference is put back on the convention here: `#FLG` for a
                // PWR_FLAG, `#PWR` for every other port. The rename is reported, never silent, and
                // it happens before the uuid seeds and the instance list are built so the whole op
                // uses one name. An authored `#` name is kept as it is.
                let renamed = if is_power && !designator.starts_with('#') {
                    Some(self.next_power_ref(if is_flag { "#FLG" } else { "#PWR" }, &[]))
                } else {
                    None
                };
                if let Some(r) = &renamed {
                    res.warnings.push(format!(
                        "PLACEMENT_POWER_DESIGNATOR: {designator} ({lib_id}) is a power symbol, so it is annotated {r} the way KiCad names a port; a part designator on a port puts it in the BOM and makes the delivery check ask it for a footprint"
                    ));
                }
                let designator: &String = renamed.as_ref().unwrap_or(designator);
                let rotation_deg = if is_power && !x.exact {
                    match (power_pin, is_flag) {
                        (Some(a), true) => flag_rotation(a),
                        (Some(a), false) => power_port_pose(is_ground_net(&value), a).port_rot,
                        (None, _) => 0,
                    }
                } else {
                    *rotation
                };
                if rotation_deg != *rotation {
                    res.warnings.push(format!(
                        "PLACEMENT_POWER_ROTATION_IGNORED: {designator} ({lib_id}) is a power symbol, so it faces {rotation_deg} degrees the way KiCad draws a port, not the {rotation} authored; `exact: true` keeps an authored pose"
                    ));
                }
                let rot = Rot::from_deg(rotation_deg as f64).unwrap_or_default();
                let mir = match mirror.as_str() {
                    "x" => Mirror::X,
                    "y" => Mirror::Y,
                    _ => Mirror::None,
                };
                if x.exact {
                    // `exact` writes the authored position verbatim: no nudge and no grid snap. It is
                    // the author's only escape from a nudge, so it must not be silent when the position
                    // it keeps sits off the 50 mil connection grid - off-grid pins are pins that wires
                    // and labels cannot land on (`gates::OFF_GRID`, eeschema `endpoint_off_grid`). A
                    // `Place::Relative` off an off-grid anchor lands here the same way.
                    if let Some(w) = off_grid_warning(
                        designator,
                        at,
                        &lib,
                        *unit,
                        Placement {
                            at,
                            rot,
                            mirror: mir,
                        },
                        OFF_GRID_REMEDY_PLACE,
                    ) {
                        res.warnings.push(w);
                    }
                    if let Some(w) = self.off_frame_warning(
                        file,
                        lib_id,
                        *unit,
                        Placement {
                            at,
                            rot,
                            mirror: mir,
                        },
                        designator,
                    ) {
                        res.warnings.push(w);
                    }
                } else {
                    // KiCad's connection grid is 50 mil and every stock symbol pin sits on it: an anchor
                    // off that grid puts every pin off-grid (eeschema `endpoint_off_grid`). Snap first.
                    // `no_nudge` stops after this: the authored position is kept, but on the grid.
                    let g = mil_to_nm(50.0);
                    let snap = |v: Nm| ((v as f64 / g as f64).round() as Nm) * g;
                    let snapped = Pt::new(snap(at.x), snap(at.y));
                    if snapped != at {
                        res.warnings.push(format!(
                            "PLACEMENT_SNAPPED: {designator} moved from ({:.0},{:.0}) to ({:.0},{:.0}) mil onto the 50 mil grid",
                            nm_to_mil(at.x),
                            nm_to_mil(at.y),
                            nm_to_mil(snapped.x),
                            nm_to_mil(snapped.y)
                        ));
                        at = snapped;
                    }
                    let texts = [designator.as_str(), value.as_str()];
                    let pl = Placement {
                        at,
                        rot,
                        mirror: mir,
                    };
                    // A power symbol standing on a pin is connected by design: nudging it
                    // 100 mil to clear a body would take it off the node it drives.
                    if !x.no_nudge && power_pin.is_none() {
                        match self.nudge_free_spot(file, lib_id, *unit, pl, x.region_mil, texts) {
                            Some(Nudge::Moved { to, blocker }) => {
                                res.warnings.push(format!(
                                    "PLACEMENT_NUDGED: {designator} moved from ({:.0},{:.0}) to ({:.0},{:.0}) mil to clear {blocker}",
                                    nm_to_mil(at.x),
                                    nm_to_mil(at.y),
                                    nm_to_mil(to.x),
                                    nm_to_mil(to.y)
                                ));
                                at = to;
                            }
                            // Nothing free near the authored spot: refuse instead of teleporting the
                            // part across the sheet. The author - or the model, from the dry run -
                            // picks another position; `no_nudge` / `exact` keep one deliberately.
                            Some(Nudge::Blocked { blocker }) => {
                                // The border needs a different remedy from an occupied spot:
                                // nothing has to move out of the way, the part has to be authored
                                // on the page.
                                let border = blocker.starts_with(BORDER_BLOCKER_PREFIX);
                                return Err(ApplyError::Op {
                                    code: "PLACEMENT_BLOCKED".into(),
                                    message: format!(
                                        "{designator} cannot be placed at ({:.0},{:.0}) mil: {blocker} is in the way and there is no free spot within {:.0} mil",
                                        nm_to_mil(at.x),
                                        nm_to_mil(at.y),
                                        PLACEMENT_NUDGE_MAX_MIL
                                    ),
                                    remediation: Some(if border {
                                        format!("author a position for {designator} inside the border the message names; `exact: true` keeps the authored position and reports PLACEMENT_OFF_FRAME instead of refusing")
                                    } else {
                                        format!("pick another position for {designator}, or move what blocks it first; `no_nudge: true` keeps the authored position (grid snap only) and the layout gate then judges the overlap")
                                    }),
                                    evidence: None,
                                });
                            }
                            Some(Nudge::Clear) | None => {}
                        }
                    }
                }
                let seed = id::seed_symbol(designator, *unit);
                let u = self.new_uuid(file, &seed)?;
                let _ = &value;
                let mut pins = Vec::new();
                let mut dup: BTreeMap<String, usize> = BTreeMap::new();
                for p in lib.pins_for_unit(*unit) {
                    let d = dup.entry(p.number.clone()).or_default();
                    let pu = id::node_uuid(
                        &self.root_uuid_of(file),
                        &id::seed_pin(designator, *unit, &p.number, *d),
                    );
                    *d += 1;
                    pins.push((p.number.clone(), pu));
                }
                // An empty footprint means "use the library default", same as omitting it; a generic passive
                // with no library default gets the drawing convention's 0603 / 0805 package (FOOTPRINT_DEFAULTED).
                let mut footprint = footprint
                    .clone()
                    .filter(|f| !f.trim().is_empty())
                    .unwrap_or_else(|| lib.property("Footprint").unwrap_or("").to_string());
                if footprint.is_empty() {
                    if let Some(fp) = default_footprint(lib_id, &value) {
                        res.warnings.push(format!(
                            "FOOTPRINT_DEFAULTED: {designator} ({lib_id} {value}) got {fp}; pass footprint to choose another"
                        ));
                        footprint = fp.to_string();
                    }
                }
                let path = self.instance_path(file);
                let mut instances = vec![(
                    self.project_name.clone(),
                    path.clone(),
                    designator.clone(),
                    *unit,
                )];
                if let Some(map) = instance_designators {
                    instances.clear();
                    // A port renamed above is renamed on every instance path too, one free `#`
                    // name each: leaving a part designator in the instance list would put that
                    // reference back on the sheet KiCad annotates from. The first one repeats the
                    // name the symbol property carries (same working set, same first free number).
                    let mut handed_out: Vec<String> = Vec::new();
                    for (p, r) in map {
                        let r = if renamed.is_some() && !r.starts_with('#') {
                            let n = self
                                .next_power_ref(if is_flag { "#FLG" } else { "#PWR" }, &handed_out);
                            handed_out.push(n.clone());
                            n
                        } else {
                            r.clone()
                        };
                        instances.push((self.project_name.clone(), p.clone(), r, *unit));
                    }
                }
                let pl_final = Placement {
                    at,
                    rot,
                    mirror: mir,
                };
                let texts = [designator.as_str(), value.as_str()];
                let fields = self.text_spots(file, lib_id, *unit, pl_final, texts);
                // `text_spots` always answers with one place per name, but the
                // pair is destructured rather than indexed so a future field set
                // cannot panic here.
                let [ref_place, val_place] = fields.places[..] else {
                    return Err(e_rem(
                        "FIELD_PLACEMENT_FAILED",
                        format!(
                            "could not place the Reference and Value texts of {designator} ({} anchors)",
                            fields.places.len()
                        ),
                        "retry without `no_nudge`, or place the part with `exact` and set the field positions afterwards",
                    ));
                };
                let justify: Option<&[&str]> = match ref_place.justify {
                    Some("left") => Some(&["left"]),
                    Some("right") => Some(&["right"]),
                    _ => None,
                };
                let spec = nodes::SymbolSpec {
                    lib_id,
                    at,
                    rot: rotation_deg,
                    mirror,
                    unit: *unit,
                    uuid: &u,
                    reference: designator,
                    value: &value,
                    footprint: &footprint,
                    extra_props: &[],
                    pins: &pins,
                    instances: &instances,
                    dnp: false,
                    in_bom: true,
                    on_board: true,
                    ref_at: ref_place.at,
                    val_at: val_place.at,
                    text_justify: justify,
                    text_rot: ref_place.rot,
                };
                // eeschema marks a symbol whose fields it placed, so the next
                // autoplace in the GUI knows it may move them again.
                let mut node = nodes::symbol_with_autoplace(&spec, 1, fields.autoplaced);
                if is_power {
                    hide_reference(&mut node);
                }
                self.push_root(file, node)?;
                self.counts.components_added += 1;
                res.created.push(
                    Created::of("symbol", u)
                        .with_reference(designator)
                        .with_value(&value),
                );
            }
            Op::DeleteComponent {
                designator,
                cascade,
            } => {
                let sheet = self.sheet(file)?.clone();
                let syms: Vec<&SymbolInst> = sheet
                    .symbols
                    .iter()
                    .filter(|s| s.reference == *designator)
                    .collect();
                if syms.is_empty() {
                    return Err(e("COMPONENT_NOT_FOUND", designator.clone()));
                }
                let mut remove_uuids: HashSet<String> =
                    syms.iter().map(|s| s.uuid.clone()).collect();
                if *cascade {
                    for s in &syms {
                        if let Some(lib) = sheet.lib_symbol(&s.lib_id) {
                            for p in world_pins(s, lib) {
                                for l in sheet.labels.iter().filter(|l| l.at == p.at) {
                                    remove_uuids.insert(l.uuid.clone());
                                }
                                for n in sheet.no_connects.iter().filter(|n| n.at == p.at) {
                                    remove_uuids.insert(n.uuid.clone());
                                }
                            }
                        }
                    }
                }
                let removed = self.remove_nodes_by_uuid(file, &remove_uuids)?;
                self.counts.components_deleted += syms.len();
                self.counts.objects_deleted += removed.saturating_sub(syms.len());
            }
            Op::DeleteObject { uuid, matcher } => {
                let target: String = match (uuid, matcher) {
                    (Some(u), _) => u.clone(),
                    (None, Some(m)) => self.match_object(file, m)?,
                    _ => return Err(e("OPLIST_CONSTRAINT", "delete_object needs uuid or match")),
                };
                let mut set = HashSet::new();
                set.insert(target);
                let n = self.remove_nodes_by_uuid(file, &set)?;
                if n == 0 {
                    return Err(e("OBJECT_NOT_FOUND", "no object with that uuid"));
                }
                self.counts.objects_deleted += n;
            }
            Op::MoveComponent {
                designator,
                uuid,
                place,
                unit,
                carry_labels,
                carry_wires,
                carry_power,
            } => {
                let sym =
                    self.find_symbol_ref(file, designator.as_deref(), uuid.as_deref(), *unit)?;
                let sheet = self.sheet(file)?.clone();
                let mut new_at = match place {
                    Place::At(p) => *p,
                    Place::Relative { anchor, offset } => {
                        self.pin_world(file, anchor)?.add(*offset)
                    }
                    Place::NearPin { anchor, distance } => {
                        self.near_pin_spot(file, anchor, *distance)?
                    }
                };
                // A move keeps the part on the 50 mil connection grid (a Fixer delta of 16 mil would put
                // every pin off-grid); `exact` opts out.
                if !x.exact {
                    let g = mil_to_nm(50.0);
                    let snap = |v: Nm| ((v as f64 / g as f64).round() as Nm) * g;
                    let snapped = Pt::new(snap(new_at.x), snap(new_at.y));
                    if snapped != new_at {
                        res.warnings.push(format!(
                            "PLACEMENT_SNAPPED: {} moved to ({:.0},{:.0}) mil onto the 50 mil grid",
                            sym.reference,
                            nm_to_mil(snapped.x),
                            nm_to_mil(snapped.y)
                        ));
                        new_at = snapped;
                    }
                } else if let Some(w) = sheet.lib_symbol(&sym.lib_id).and_then(|l| {
                    // `exact` skips that snap, so — exactly as for an `exact` placement — the move has
                    // to say when the destination leaves the anchor or a pin off the connection grid
                    // instead of moving off-grid silently. The symbol keeps its rotation and mirror, so
                    // only the anchor changes.
                    off_grid_warning(
                        &sym.reference,
                        new_at,
                        l,
                        sym.unit,
                        Placement {
                            at: new_at,
                            ..sym.placement
                        },
                        OFF_GRID_REMEDY_MOVE,
                    )
                }) {
                    res.warnings.push(w);
                }
                let delta = new_at.sub(sym.placement.at);
                let old_pins: Vec<Pt> = sheet
                    .lib_symbol(&sym.lib_id)
                    .map(|l| world_pins(&sym, l).into_iter().map(|p| p.at).collect())
                    .unwrap_or_default();
                self.translate_symbol(file, &sym.uuid, delta)?;
                // A move is a change to a part that already existed, reported like a value edit
                // (before/after of its pose) so the summary, the canvas highlight and the rollback
                // card see it; a move to where the part already is changes nothing.
                if delta != Pt::new(0, 0) {
                    res.changed.push(Changed {
                        reference: sym.reference.clone(),
                        field: "at".to_string(),
                        before: pose_text(&sym.placement),
                        after: pose_text(&Placement {
                            at: new_at,
                            ..sym.placement
                        }),
                        sheet: None,
                    });
                }
                // `translate_symbol` carries the property texts along verbatim, which is right
                // for anchors a human chose and wrong for ones this engine placed on a grid:
                // an `exact` move off the 50 mil grid leaves them off it too. Re-running the
                // autoplace on our own symbols also gives `FIELD_OVER_OWN_BODY` an op that
                // repairs it - a move was previously a no-op for that finding.
                self.reautoplace_fields(
                    file,
                    &sym,
                    Placement {
                        at: new_at,
                        ..sym.placement
                    },
                    &sym.reference,
                    &sym.value,
                )?;
                if *carry_labels {
                    let ids: Vec<String> = sheet
                        .labels
                        .iter()
                        .filter(|l| old_pins.contains(&l.at))
                        .map(|l| l.uuid.clone())
                        .collect();
                    for u in ids {
                        self.translate_at(file, &u, delta)?;
                    }
                    let ncs: Vec<String> = sheet
                        .no_connects
                        .iter()
                        .filter(|n| old_pins.contains(&n.at))
                        .map(|n| n.uuid.clone())
                        .collect();
                    for u in ncs {
                        self.translate_at(file, &u, delta)?;
                    }
                }
                // Power symbols hanging off the moved pins — directly, or over a short stub
                // wire (<= 300 mil), or over the two legs of the L a sideways pin's port sits
                // on — ride along, stub included.
                let mut moved_whole_wires: HashSet<String> = HashSet::new();
                if *carry_power || *carry_labels {
                    let power_pin_at = |p: &SymbolInst| -> Vec<Pt> {
                        sheet
                            .lib_symbol(&p.lib_id)
                            .map(|l| world_pins(p, l).into_iter().map(|wp| wp.at).collect())
                            .unwrap_or_default()
                    };
                    let stub_max = mil_to_nm(300.0);
                    let mut anchors: Vec<Pt> = old_pins.clone();
                    // Breadth-first over short wires leaving the moved pins, remembering the
                    // path to each point so a port at the far end of an L carries both legs.
                    let mut reached: Vec<(Pt, Vec<String>)> =
                        old_pins.iter().map(|p| (*p, Vec::new())).collect();
                    let mut hop_start = 0usize;
                    for _ in 0..POWER_STUB_HOPS {
                        let hop_end = reached.len();
                        let mut next: Vec<(Pt, Vec<String>)> = Vec::new();
                        for i in hop_start..hop_end {
                            let (at, path) = (reached[i].0, reached[i].1.clone());
                            for w in &sheet.wires {
                                let far = if w.a == at {
                                    w.b
                                } else if w.b == at {
                                    w.a
                                } else {
                                    continue;
                                };
                                if (far.x - at.x).abs().max((far.y - at.y).abs()) > stub_max {
                                    continue;
                                }
                                if reached.iter().chain(next.iter()).any(|(p, _)| *p == far) {
                                    continue;
                                }
                                let mut walked = path.clone();
                                walked.push(w.uuid.clone());
                                next.push((far, walked));
                            }
                        }
                        if next.is_empty() {
                            break;
                        }
                        hop_start = hop_end;
                        reached.extend(next);
                    }
                    for (far, path) in &reached {
                        if path.is_empty() || !*carry_power {
                            continue;
                        }
                        let has_power = sheet.symbols.iter().any(|p| {
                            (p.reference.starts_with('#')
                                || sheet
                                    .lib_symbol(&p.lib_id)
                                    .map(|l| l.is_power)
                                    .unwrap_or(false))
                                && p.uuid != sym.uuid
                                && power_pin_at(p).contains(far)
                        });
                        if has_power {
                            anchors.push(*far);
                            moved_whole_wires.extend(path.iter().cloned());
                        }
                    }
                    let pwr: Vec<String> = sheet
                        .symbols
                        .iter()
                        .filter(|p| {
                            (p.reference.starts_with('#')
                                || sheet
                                    .lib_symbol(&p.lib_id)
                                    .map(|l| l.is_power)
                                    .unwrap_or(false))
                                && p.uuid != sym.uuid
                        })
                        .filter(|p| power_pin_at(p).iter().any(|at| anchors.contains(at)))
                        .map(|p| p.uuid.clone())
                        .collect();
                    for u in pwr {
                        self.translate_symbol(file, &u, delta)?;
                    }
                }
                if *carry_wires {
                    // Rubber-banding one end of a wire is what a schematic editor does, and it is
                    // also how a move turns an orthogonal segment into a diagonal one: run 21 moved
                    // two decoupling caps sideways and shipped two `LONG_WIRE: diagonal wire`
                    // findings whose cause no later step could see. A carried segment that would
                    // come out skewed is redrawn as the L a person would draw instead (`route_clear`
                    // picks the leg order that stays off foreign pin tips); when no shape is clear
                    // the move is refused rather than written diagonal.
                    let carried: Vec<(String, Pt, Pt, bool, bool)> = sheet
                        .wires
                        .iter()
                        .filter(|w| {
                            old_pins.contains(&w.a)
                                || old_pins.contains(&w.b)
                                // The far leg of a carried L touches no pin of its own.
                                || moved_whole_wires.contains(&w.uuid)
                        })
                        .map(|w| {
                            let whole = moved_whole_wires.contains(&w.uuid);
                            (
                                w.uuid.clone(),
                                w.a,
                                w.b,
                                whole || old_pins.contains(&w.a),
                                whole || old_pins.contains(&w.b),
                            )
                        })
                        .collect();
                    for (uuid, a, b, move_a, move_b) in carried {
                        let na = if move_a { a.add(delta) } else { a };
                        let nb = if move_b { b.add(delta) } else { b };
                        let was_ortho = a.x == b.x || a.y == b.y;
                        let now_ortho = na.x == nb.x || na.y == nb.y;
                        // A segment that was already diagonal is left as it was drawn: this op is
                        // not the place to redraw geometry somebody else authored.
                        if !was_ortho || now_ortho {
                            self.translate_wire_end(file, &uuid, move_a, move_b, delta)?;
                            continue;
                        }
                        let obstacles = self.route_obstacles(file, na, nb);
                        let points: Vec<Pt> = obstacles.iter().map(|(p, _)| *p).collect();
                        let (pts, blocked) = route_clear(na, nb, "auto", &points);
                        if !blocked.is_empty() || pts.len() < 2 {
                            let names: Vec<&str> = blocked
                                .iter()
                                .filter_map(|p| {
                                    obstacles
                                        .iter()
                                        .find(|(q, _)| q == p)
                                        .map(|(_, n)| n.as_str())
                                })
                                .collect();
                            return Err(e_rem(
                                "MOVE_WOULD_SKEW_WIRE",
                                format!(
                                    "moving {} to ({:.0},{:.0}) mil would leave the wire from ({:.0},{:.0}) to ({:.0},{:.0}) mil diagonal, and no L or jog clear of {} exists",
                                    sym.reference,
                                    nm_to_mil(new_at.x),
                                    nm_to_mil(new_at.y),
                                    nm_to_mil(na.x),
                                    nm_to_mil(na.y),
                                    nm_to_mil(nb.x),
                                    nm_to_mil(nb.y),
                                    if names.is_empty() {
                                        "the pins in the way".to_string()
                                    } else {
                                        names.join(", ")
                                    }
                                ),
                                "move the part along the axis of the wire attached to it, or delete the wire (delete_object) and draw it again with route_net after the move",
                            ));
                        }
                        // The first leg keeps the wire's own uuid (and whatever else the file said
                        // about that node); the rest of the path is new segments.
                        self.set_wire_ends(file, &uuid, pts[0], pts[1])?;
                        for seg in pts.windows(2).skip(1) {
                            if seg[0] == seg[1] {
                                continue;
                            }
                            let seed = id::seed_wire(seg[0], seg[1]);
                            let u = self.new_uuid(file, &seed)?;
                            let node = nodes::wire(seg[0], seg[1], &u, false, 1);
                            self.push_root(file, node)?;
                            self.counts.wires_added += 1;
                            res.created.push(Created::of("wire", u));
                        }
                        res.warnings.push(format!(
                            "WIRE_REROUTED: the wire on {} would have gone diagonal, so it was redrawn as an L through ({:.0},{:.0}) mil",
                            sym.reference,
                            nm_to_mil(pts[1].x),
                            nm_to_mil(pts[1].y)
                        ));
                    }
                }
                self.counts.components_moved += 1;
            }
            Op::SetComponentTransform {
                designator,
                uuid,
                rotation,
                mirror,
            } => {
                let sym =
                    self.find_symbol_ref(file, designator.as_deref(), uuid.as_deref(), None)?;
                self.set_transform(file, &sym.uuid, *rotation, mirror.as_deref())?;
                // A turn moves the body but not the field anchors, so texts this engine placed
                // beside the body end up lying across it (`FIELD_OVER_OWN_BODY`) and, on a
                // quarter turn, drawing sideways. Autoplace them again for the new pose - only
                // on symbols we placed; a human's anchors stay byte-identical.
                let pl = Placement {
                    at: sym.placement.at,
                    rot: rotation
                        .map(|r| Rot::from_deg(r as f64).unwrap_or_default())
                        .unwrap_or(sym.placement.rot),
                    mirror: match mirror.as_deref() {
                        Some("x") => Mirror::X,
                        Some("y") => Mirror::Y,
                        Some(_) => Mirror::None,
                        None => sym.placement.mirror,
                    },
                };
                self.reautoplace_fields(file, &sym, pl, &sym.reference, &sym.value)?;
                if pl != sym.placement {
                    res.changed.push(Changed {
                        reference: sym.reference.clone(),
                        field: "at".to_string(),
                        before: pose_text(&sym.placement),
                        after: pose_text(&pl),
                        sheet: None,
                    });
                }
                self.counts.transforms_changed += 1;
            }
            Op::SetComponentParameters {
                designator,
                new_designator,
                value,
                footprint,
                parameters,
                instance_designators,
            } => {
                let syms: Vec<SymbolInst> = self
                    .sheet(file)?
                    .symbols
                    .iter()
                    .filter(|s| s.reference == *designator)
                    .cloned()
                    .collect();
                if syms.is_empty() {
                    return Err(e("COMPONENT_NOT_FOUND", designator.clone()));
                }
                for sym in &syms {
                    // `syms` is a snapshot taken before the writes below, so it still holds the
                    // values this op replaces: reported verbatim as before/after, never inferred.
                    let mut note = |field: &str, before: &str, after: &str| {
                        if before != after {
                            res.changed.push(Changed {
                                reference: sym.reference.clone(),
                                field: field.to_string(),
                                before: before.to_string(),
                                after: after.to_string(),
                                sheet: None,
                            });
                        }
                    };
                    if let Some(v) = value {
                        note("Value", &sym.value, v);
                    }
                    if let Some(f) = footprint {
                        note("Footprint", &sym.footprint, f);
                    }
                    for (k, v) in parameters {
                        let before = sym
                            .properties
                            .iter()
                            .find(|(n, _)| n == k)
                            .map(|(_, x)| x.as_str())
                            .unwrap_or("");
                        note(k, before, v);
                    }
                    if let Some(nd) = new_designator {
                        note("Reference", &sym.reference, nd);
                    }
                    if let Some(v) = value {
                        self.set_property(file, &sym.uuid, "Value", v)?;
                    }
                    if let Some(f) = footprint {
                        self.set_property(file, &sym.uuid, "Footprint", f)?;
                    }
                    for (k, v) in parameters {
                        self.set_property(file, &sym.uuid, k, v)?;
                    }
                    if let Some(nd) = new_designator {
                        self.set_property(file, &sym.uuid, "Reference", nd)?;
                        self.set_instance_refs(file, &sym.uuid, &BTreeMap::new(), Some(nd))?;
                    }
                    if let Some(map) = instance_designators {
                        self.set_instance_refs(file, &sym.uuid, map, None)?;
                    }
                    // A wider string no longer fits where the old one did: "1k" becomes
                    // "10k 1% 0805" and runs into the body or the field below it. Fields this
                    // engine placed carry `(fields_autoplaced yes)` and are ours to move again,
                    // which is exactly what eeschema does on such a symbol; fields a human or
                    // another tool authored are left byte-identical however the new string
                    // measures (red line 2), so `edit_existing_value`'s hand-authored R1 keeps
                    // the Value anchor its author chose.
                    if value.is_some() || new_designator.is_some() {
                        let reference = new_designator.clone().unwrap_or(sym.reference.clone());
                        let val = value.clone().unwrap_or(sym.value.clone());
                        self.reautoplace_fields(file, sym, sym.placement, &reference, &val)?;
                    }
                }
                self.counts.properties_changed += 1;
            }
            Op::SetComponentAttributes {
                designator,
                dnp,
                in_bom,
                on_board,
            } => {
                let syms: Vec<SymbolInst> = self
                    .sheet(file)?
                    .symbols
                    .iter()
                    .filter(|s| s.reference == *designator)
                    .cloned()
                    .collect();
                if syms.is_empty() {
                    return Err(e("COMPONENT_NOT_FOUND", designator.clone()));
                }
                for sym in &syms {
                    for (k, v) in [("dnp", dnp), ("in_bom", in_bom), ("on_board", on_board)] {
                        if let Some(b) = v {
                            self.set_flag(file, &sym.uuid, k, *b)?;
                        }
                    }
                }
                self.counts.attributes_changed += 1;
            }
            Op::AddWire { vertices } => {
                // Schematic wires are orthogonal: a diagonal segment becomes an L
                // (horizontal first), which is what a human would draw.
                // Endpoints within 15 mil of the 50 mil grid snap to it (a near miss from
                // hand-computed coordinates); a pin tip is never moved, and anything further
                // off is left alone so it still meets whatever it was aimed at.
                let grid = mil_to_nm(50.0);
                let tol = mil_to_nm(15.0);
                let tips: HashSet<Pt> = {
                    let sheet = self.sheet(file)?;
                    sheet
                        .symbols
                        .iter()
                        .filter_map(|s| sheet.lib_symbol(&s.lib_id).map(|lib| world_pins(s, lib)))
                        .flatten()
                        .map(|p| p.at)
                        .collect()
                };
                let snap1 = |v: Nm| -> Nm {
                    let r = v.rem_euclid(grid);
                    if r == 0 {
                        v
                    } else if r <= tol {
                        v - r
                    } else if grid - r <= tol {
                        v + (grid - r)
                    } else {
                        v
                    }
                };
                let mut snapped_any = false;
                let vertices: Vec<Pt> = vertices
                    .iter()
                    .map(|v| {
                        if tips.contains(v) {
                            return *v;
                        }
                        let s = Pt::new(snap1(v.x), snap1(v.y));
                        if s != *v {
                            snapped_any = true;
                        }
                        s
                    })
                    .collect();
                if snapped_any {
                    res.warnings.push(
                        "WIRE_SNAPPED: a wire endpoint was moved onto the 50 mil grid".into(),
                    );
                }
                let mut verts: Vec<Pt> = Vec::with_capacity(vertices.len() * 2);
                for (i, v) in vertices.iter().enumerate() {
                    if i > 0 {
                        let prev = verts[verts.len() - 1];
                        if prev.x != v.x && prev.y != v.y {
                            verts.push(Pt::new(v.x, prev.y));
                            res.warnings.push(
                                "WIRE_ORTHOGONALIZED: a diagonal wire was drawn as an L".into(),
                            );
                        }
                    }
                    verts.push(*v);
                }
                if let Some(w) = self.no_connect_warning(file, &verts) {
                    res.warnings.push(w);
                }
                for w in verts.windows(2) {
                    let seed = id::seed_wire(w[0], w[1]);
                    let u = self.new_uuid(file, &seed)?;
                    let node = nodes::wire(w[0], w[1], &u, false, 1);
                    self.push_root(file, node)?;
                    self.counts.wires_added += 1;
                    res.created.push(Created::of("wire", u));
                }
            }
            Op::AddBus { vertices } => {
                for w in vertices.windows(2) {
                    let seed = id::seed_bus(w[0], w[1]);
                    let u = self.new_uuid(file, &seed)?;
                    let node = nodes::wire(w[0], w[1], &u, true, 1);
                    self.push_root(file, node)?;
                    self.counts.wires_added += 1;
                    res.created.push(Created::of("bus", u));
                }
            }
            Op::RouteNet {
                from,
                to,
                style,
                label,
                scope,
            } => {
                let a = self.pin_world(file, from)?;
                let b = self.pin_world(file, to)?;
                // The shape of the route is chosen against the pins already on the sheet, not off
                // the two ends alone: a corner on a foreign pin tip, or a leg up a pin column,
                // wires those pins into this net.
                let obstacles = self.route_obstacles(file, a, b);
                let points: Vec<Pt> = obstacles.iter().map(|(p, _)| *p).collect();
                let (pts, blocked) = route_clear(a, b, style, &points);
                if !blocked.is_empty() {
                    let names: Vec<&str> = blocked
                        .iter()
                        .filter_map(|p| {
                            obstacles
                                .iter()
                                .find(|(q, _)| q == p)
                                .map(|(_, n)| n.as_str())
                        })
                        .collect();
                    res.warnings.push(format!(
                        "ROUTE_THROUGH_PIN: no leg order and no jog was clear, so the wire from ({:.0},{:.0}) to ({:.0},{:.0}) mil is drawn as authored and runs across {}; those pins join this net",
                        nm_to_mil(a.x),
                        nm_to_mil(a.y),
                        nm_to_mil(b.x),
                        nm_to_mil(b.y),
                        names.join(", ")
                    ));
                }
                if let Some(w) = self.no_connect_warning(file, &pts) {
                    res.warnings.push(w);
                }
                for w in pts.windows(2) {
                    if w[0] == w[1] {
                        continue;
                    }
                    let seed = id::seed_wire(w[0], w[1]);
                    let u = self.new_uuid(file, &seed)?;
                    let node = nodes::wire(w[0], w[1], &u, false, 1);
                    self.push_root(file, node)?;
                    self.counts.wires_added += 1;
                    res.created.push(Created::of("wire", u));
                }
                if let Some(name) = label {
                    let mid = if pts.len() >= 2 {
                        Pt::new((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2)
                    } else {
                        a
                    };
                    let u = self.add_label(file, name, mid, 0, scope)?;
                    res.created.push(Created::of("label", u).with_name(name));
                }
            }
            Op::AddJunction { at } => {
                let u = self.new_uuid(file, &id::seed_junction(*at))?;
                let node = nodes::junction(*at, &u, 1);
                self.push_root(file, node)?;
                res.created.push(Created::of("junction", u));
            }
            Op::AddNoConnect { pin } => {
                let p = self.pin_world(file, pin)?;
                // A no-connect on a pin something already reaches is a contradiction, not a
                // drawing: KiCad puts the pin on the net and ERC reports it. Refuse with the thing
                // in the way named, so the model either removes what reaches the pin or drops the
                // marker; a wire drawn onto a marker later warns instead (`WIRE_ON_NO_CONNECT`).
                let own = match pin {
                    Endpoint::Pin { reference, .. } => Some(reference.as_str()),
                    Endpoint::Point(_) => None,
                };
                if let Some(what) = self.connection_at(file, p, own) {
                    let which = match pin {
                        Endpoint::Pin {
                            reference, pin: n, ..
                        } => format!("{reference}.{n}"),
                        Endpoint::Point(_) => {
                            format!("({:.0},{:.0}) mil", nm_to_mil(p.x), nm_to_mil(p.y))
                        }
                    };
                    return Err(e_rem(
                        "NO_CONNECT_ON_CONNECTED_PIN",
                        format!(
                            "{which} already has {what}, so a no-connect there says unused about a pin the drawing wires"
                        ),
                        format!("delete what reaches {which} (delete_object) if the pin really is unused, or drop this add_no_connect and leave the pin wired"),
                    ));
                }
                let anchor = match pin {
                    Endpoint::Pin {
                        reference,
                        unit,
                        pin,
                    } => id::seed_pin(reference, unit.unwrap_or(1), pin, 0),
                    Endpoint::Point(p) => id::anchor_pt(*p),
                };
                let u = self.new_uuid(file, &id::seed_no_connect(&anchor))?;
                let node = nodes::no_connect(p, &u, 1);
                self.push_root(file, node)?;
                res.created.push(Created::of("no_connect", u));
            }
            Op::AddNetLabel {
                name,
                at,
                scope,
                rotation,
            } => {
                let p = self.anchor_world(file, at)?;
                // A label on a pin always points away from the body: an explicit
                // rotation (models write 0 by habit) would run it into the symbol.
                let rot = match at {
                    Anchor::Endpoint(ep) => self
                        .pin_away_rotation(file, ep)
                        .unwrap_or(rotation.unwrap_or(0)),
                    _ => rotation.unwrap_or(0),
                };
                let u = self.add_label(file, name, p, rot, scope)?;
                res.created.push(Created::of("label", u).with_name(name));
            }
            Op::PlacePowerPort {
                lib_id,
                net_name,
                at,
                rotation,
            } => {
                let tip = self.anchor_world(file, at)?;
                let lib = self.ensure_lib_symbol(file, lib_id)?;
                let anchor_seed = match at {
                    Anchor::Endpoint(Endpoint::Pin {
                        reference,
                        unit,
                        pin,
                    }) => id::seed_pin(reference, unit.unwrap_or(1), pin, 0),
                    _ => id::anchor_pt(tip),
                };
                // Orientation: an explicit rotation is the drafter's call; otherwise the pin
                // direction decides — GND-class rails point down, other rails up, PWR_FLAG
                // away from the body. When the pin points sideways the port turns the corner
                // on an L of wire so the symbol can keep its natural orientation.
                let away = match at {
                    Anchor::Endpoint(ep @ Endpoint::Pin { .. }) => self.pin_away_rotation(file, ep),
                    _ => None,
                };
                let is_flag = net_name == "PWR_FLAG";
                let pose = match (rotation, away) {
                    (Some(r), _) => PortPose::straight(away.unwrap_or(0), *r),
                    (None, Some(a)) if is_flag => PortPose::straight(a, flag_rotation(a)),
                    (None, Some(a)) => power_port_pose(is_ground_net(net_name), a),
                    (None, None) => PortPose::straight(0, 0),
                };
                let derived_rot = pose.port_rot;
                let rotation = &derived_rot;
                // Value text sits on the body side of the port and draws horizontally at any
                // rotation: `port_text_layout` reads the side off the glyph itself and cancels a
                // quarter turn with the stored field angle, the way `autoplace` does for every
                // other symbol. A port used to keep angle 0 and a +/-y offset, which drew the net
                // name sideways across the pin row it was standing in.
                let glyph_local = self.lib_glyph_box(file, lib_id);
                let mut text = port_text_layout(
                    glyph_local.as_ref(),
                    derived_rot,
                    is_ground_net(net_name),
                    net_name,
                );
                let anchor_ref = match at {
                    Anchor::Endpoint(Endpoint::Pin { reference, .. }) => reference.as_str(),
                    _ => "",
                };
                // Where the port's own leg starts: on the pin, or - for a sideways pin - one
                // grid square out along it, so the leg can turn down (ground) or up (rail).
                let elbow = match away {
                    Some(a) if pose.elbow_mil > 0 => {
                        let (ex, ey) = away_unit(a);
                        let d = mil_to_nm(pose.elbow_mil as f64);
                        Pt::new(tip.x + ex * d, tip.y + ey * d)
                    }
                    _ => tip,
                };
                // The natural spot: the end of the port's own leg, before any search.
                let natural = {
                    let (lx, ly) = away_unit(pose.leg_rot);
                    let d = mil_to_nm(pose.leg_mil as f64);
                    Pt::new(elbow.x + lx * d, elbow.y + ly * d)
                };
                // When the port glyph, its own value text or the wire that reaches it would
                // land on a property text, a label or another body already drawn around the
                // pin, it slides further along its leg, or a step aside. `None` = nothing
                // within reach was clear, which for a PWR_FLAG is the cue to hang it aside.
                let found = match away {
                    Some(_) => self.port_stub_spot(
                        file,
                        lib_id,
                        net_name,
                        anchor_ref,
                        elbow,
                        pose.leg_rot,
                        pose.leg_mil,
                        derived_rot,
                        text,
                    ),
                    // Not anchored on a pin: the port stands where it was authored.
                    None => Some((natural, 0, 0)),
                };
                if let Some((_, extra, perp)) = found {
                    if extra > 0 || perp != 0 {
                        let aside = if perp == 0 {
                            String::new()
                        } else {
                            format!(" and {} mil aside", perp.abs())
                        };
                        res.warnings.push(format!(
                            "PORT_STUB_EXTENDED: {net_name} port moved {extra} mil further along the pin{aside} to clear neighbouring text"
                        ));
                    }
                }
                // Nothing within reach was clear. A PWR_FLAG hangs aside below; every other
                // port is written where it stands, and the overlap is reported, never hidden.
                let p = found.map(|(end, _, _)| end).unwrap_or(natural);
                if found.is_none() && !is_flag && glyph_local.is_some() {
                    res.warnings.push(format!(
                        "PORT_STUB_BLOCKED: {net_name} port found nothing clear within {PORT_STUB_MAX_EXTRA_MIL} mil along its pin or {PORT_STUB_MAX_PERP_MIL} mil aside; it is written at ({:.0},{:.0}) mil and the layout check reports what it overlaps",
                        nm_to_mil(p.x),
                        nm_to_mil(p.y)
                    ));
                }
                // One straight stub, or the L of a sideways pin: `route` puts the horizontal run
                // first, which is exactly the elbow above (the leg is vertical whenever the elbow
                // is non-zero), and returns a single segment when the port is straight off the pin.
                for w in route(tip, p, "hv").windows(2) {
                    if w[0] == w[1] {
                        continue;
                    }
                    let seed = id::seed_wire(w[0], w[1]);
                    let wu = self.new_uuid(file, &seed)?;
                    let node = nodes::wire(w[0], w[1], &wu, false, 1);
                    self.push_root(file, node)?;
                    self.counts.wires_added += 1;
                    res.created.push(Created::of("wire", wu));
                }
                // A PWR_FLAG on a point that already carries a power symbol would be
                // POWER_PORT_STACKED (and unreadable), and one whose leg found nowhere clear would
                // print over its neighbour: either way it hangs to the side on a short wire.
                let occupied = is_flag
                    && p == tip
                    && (found.is_none() || {
                        let sheet = self.sheet(file)?;
                        // A label on the tip would sit under the flag body just like a stacked power symbol.
                        sheet.labels.iter().any(|l| l.at == tip)
                            || sheet.symbols.iter().any(|q| {
                                (q.reference.starts_with('#')
                                    || sheet
                                        .lib_symbol(&q.lib_id)
                                        .map(|l| l.is_power)
                                        .unwrap_or(false))
                                    && sheet
                                        .lib_symbol(&q.lib_id)
                                        .map(|l| world_pins(q, l).iter().any(|wp| wp.at == tip))
                                        .unwrap_or(false)
                            })
                    });
                let p = if occupied {
                    // eeschema convention: the flag's own text goes on the far side from the
                    // text of the port it shares the node with. Both on one side and 377 mil of
                    // "PWR_FLAG" reads as one string with the rail name beside it.
                    if self.port_text_side_at(file, tip) == Some(text.side()) {
                        text = text.flipped();
                    }
                    let (end, cleared) = self.flag_aside(
                        file,
                        lib_id,
                        net_name,
                        anchor_ref,
                        p,
                        away.unwrap_or(0),
                        derived_rot,
                        text,
                    );
                    if !cleared {
                        res.warnings.push(format!(
                            "PORT_STUB_BLOCKED: {net_name} hung beside its pin found nothing clear within {FLAG_ASIDE_MAX_MIL} mil; it is written at ({:.0},{:.0}) mil and the layout check reports what it overlaps",
                            nm_to_mil(end.x),
                            nm_to_mil(end.y)
                        ));
                    }
                    let seed = id::seed_wire(p, end);
                    let wu = self.new_uuid(file, &seed)?;
                    let node = nodes::wire(p, end, &wu, false, 1);
                    self.push_root(file, node)?;
                    self.counts.wires_added += 1;
                    res.created.push(Created::of("wire", wu));
                    end
                } else {
                    p
                };
                let u = self.new_uuid(file, &id::seed_power(net_name, &anchor_seed))?;
                // `place_power_port` has always annotated `#PWR`, flags included; the reference is a
                // uuid seed, so changing it would re-identify every port in every existing file.
                let reference = self.next_power_ref("#PWR", &[]);
                let path = self.instance_path(file);
                let pins: Vec<(String, String)> = lib
                    .pins_for_unit(1)
                    .map(|pn| {
                        (
                            pn.number.clone(),
                            id::node_uuid(
                                &self.root_uuid_of(file),
                                &id::seed_pin(&reference, 1, &pn.number, 0),
                            ),
                        )
                    })
                    .collect();
                let instances = vec![(self.project_name.clone(), path, reference.clone(), 1u32)];
                let spec = nodes::SymbolSpec {
                    lib_id,
                    at: p,
                    rot: *rotation,
                    mirror: "none",
                    unit: 1,
                    uuid: &u,
                    reference: &reference,
                    value: net_name,
                    footprint: "",
                    extra_props: &[],
                    pins: &pins,
                    instances: &instances,
                    dnp: false,
                    in_bom: true,
                    on_board: true,
                    ref_at: Pt::new(p.x + text.ref_off.x, p.y + text.ref_off.y),
                    val_at: Pt::new(p.x + text.val_off.x, p.y + text.val_off.y),
                    text_justify: None,
                    text_rot: text.rot,
                };
                let mut node = nodes::symbol(&spec, 1);
                hide_reference(&mut node);
                self.push_root(file, node)?;
                self.counts.components_added += 1;
                res.created.push(
                    Created::of("power_port", u)
                        .with_reference(&reference)
                        .with_name(net_name),
                );
            }
            Op::RenameNet {
                old_name,
                new_name,
                scope,
            } => {
                // A rename reaches exactly the files the name's own scope reaches: a local label
                // names a net inside its own sheet (eeschema dialect), so renaming it must leave a
                // same-named local label on another sheet alone; a global name is project-wide by
                // definition; a hierarchical name is the sheet's label plus the parent's sheet pin.
                let (effective, jobs) =
                    self.rename_plan(file, old_name, scope.clone(), x.sheet.is_some())?;
                let mut count = 0;
                let mut touched: std::collections::BTreeSet<PathBuf> =
                    std::collections::BTreeSet::new();
                for (f, job) in &jobs {
                    let n = match job {
                        RenameJob::Labels(kind) => {
                            self.rename_labels_in_file(f, old_name, new_name, kind)?
                        }
                        RenameJob::SheetPins(child) => {
                            self.rename_sheet_pins_in_file(f, child, old_name, new_name)?
                        }
                    };
                    if n > 0 {
                        touched.insert(f.clone());
                    }
                    count += n;
                }
                if count == 0 {
                    return Err(e(
                        "NET_NOT_FOUND",
                        format!("no label or power port named {old_name}"),
                    ));
                }
                let names: Vec<String> = touched.iter().map(|p| file_label(p)).collect();
                res.warnings.push(format!(
                    "renamed {count} labels/power ports ({} scope) in {}",
                    scope_word(&effective),
                    names.join(", ")
                ));
                self.counts.properties_changed += count;
            }
            Op::AddBusEntry { at, size } => {
                let u = self.new_uuid(file, &id::seed_bus_entry(*at))?;
                let node = nodes::bus_entry(*at, *size, &u, 1);
                self.push_root(file, node)?;
                res.created.push(Created::of("bus_entry", u));
            }
            Op::AddText {
                text,
                at,
                angle,
                key,
            } => {
                let seed = key
                    .as_ref()
                    .map(|k| id::seed_keyed("text", k))
                    .unwrap_or_else(|| id::seed_text("text", *at));
                let u = self.new_uuid(file, &seed)?;
                if key.is_some() {
                    // Keyed graphics are idempotent: re-applying replaces the object with that key.
                    let mut set = HashSet::new();
                    set.insert(u.clone());
                    self.remove_nodes_by_uuid(file, &set)?;
                }
                let node = nodes::text(text, *at, *angle, &u, 1);
                self.push_root(file, node)?;
                res.created.push(Created::of("text", u));
            }
            Op::AddRectangle {
                start,
                end,
                stroke_width,
                fill,
                key,
            } => {
                let seed = key
                    .as_ref()
                    .map(|k| id::seed_keyed("rectangle", k))
                    .unwrap_or_else(|| id::seed_rect("rectangle", *start, *end));
                let u = self.new_uuid(file, &seed)?;
                if key.is_some() {
                    // Keyed graphics are idempotent: re-applying replaces the object with that key.
                    let mut set = HashSet::new();
                    set.insert(u.clone());
                    self.remove_nodes_by_uuid(file, &set)?;
                }
                let node = nodes::rectangle(*start, *end, *stroke_width, fill, &u, 1);
                self.push_root(file, node)?;
                res.created.push(Created::of("rectangle", u));
            }
            Op::AddTextBox {
                text,
                at,
                size,
                angle,
                key,
            } => {
                let seed = key
                    .as_ref()
                    .map(|k| id::seed_keyed("text_box", k))
                    .unwrap_or_else(|| id::seed_text("text_box", *at));
                let u = self.new_uuid(file, &seed)?;
                if key.is_some() {
                    // Keyed graphics are idempotent: re-applying replaces the object with that key.
                    let mut set = HashSet::new();
                    set.insert(u.clone());
                    self.remove_nodes_by_uuid(file, &set)?;
                }
                let node = nodes::text_box(text, *at, *size, *angle, &u, 1);
                self.push_root(file, node)?;
                res.created.push(Created::of("text_box", u));
            }
            Op::AddSheet {
                name,
                file: child_file,
                at,
                size,
                pins,
                create,
                paper,
            } => {
                let child_path = file.parent().unwrap_or(Path::new(".")).join(child_file);
                let root_dir = self
                    .root_file
                    .parent()
                    .unwrap_or(Path::new("."))
                    .canonicalize()
                    .unwrap_or_default();
                let resolved = self.child_file_path(file, child_file);
                if !resolved.starts_with(&root_dir) {
                    return Err(e(
                        "PATH_OUT_OF_SCOPE",
                        format!("{child_file} is outside the project root"),
                    ));
                }
                let exists = child_path.exists() || self.docs.contains_key(&resolved);
                if !exists && !*create {
                    return Err(ApplyError::Op {
                        code: "SHEET_FILE_MISSING".into(),
                        message: format!("{child_file} does not exist"),
                        remediation: Some("add `create: true` to create it (structural)".into()),
                        evidence: None,
                    });
                }
                // The paper size only reaches a file this op creates; an existing child keeps its own.
                let paper = match paper.as_deref() {
                    Some(p) if crate::gates::paper_size(p).is_none() => {
                        return Err(ApplyError::Op {
                            code: "OPLIST_SCHEMA".into(),
                            message: format!("unknown paper size {p}"),
                            remediation: Some("A0..A5, A..E, USLetter, USLegal or USLedger".into()),
                            evidence: None,
                        })
                    }
                    Some(p) => p,
                    None => "A4",
                };
                let sheet_uuid = self.new_uuid(file, &id::seed_sheet(child_file, name))?;
                if !exists {
                    let parent_root = self.root_uuid_of(file);
                    let child_root = id::node_uuid(&parent_root, &id::seed_sheet_file(child_file));
                    let src = nodes::empty_schematic(&child_root, paper);
                    let doc =
                        kicad_sexpr::parse(&src).map_err(|err| e("PARSE", err.to_string()))?;
                    self.docs.insert(resolved.clone(), doc);
                    self.created_files.push(resolved.clone());
                    self.refresh(&resolved)?;
                    self.counts.sheets_created += 1;
                }
                // Every sheet pin gets one hierarchical label of that name inside the child,
                // so KiCad's ERC `hier_label_mismatch` is clean and the pins are connectable
                // from inside immediately. A child that already existed is seeded the same
                // way (`seed_hier_label` skips the names it already carries): a second
                // instance of a sheet file, or a file the project already contains, is just
                // as unbuildable when its pins have no labels inside.
                // One row counter per column (see `seed_hier_label`): an input and an output
                // seeded together share a row, so the scaffold hands the drafter a straight
                // corridor instead of a staircase.
                let mut rows: BTreeMap<bool, i64> = BTreeMap::new();
                for spec in pins.iter() {
                    let col = spec.side == "right";
                    let row = *rows.entry(col).or_insert(0);
                    let on_col = pins.iter().filter(|p| (p.side == "right") == col).count();
                    if let Some(r) = self.seed_hier_label(
                        &resolved, &spec.name, &spec.kind, &spec.side, row, on_col,
                    )? {
                        rows.insert(col, r + 1);
                        if exists {
                            res.warnings
                                .push(format!("HIER_LABEL_SEEDED {} in {child_file}", spec.name));
                        }
                    }
                }
                let placed = layout_sheet_pins(*at, *size, pins);
                let mut pin_nodes = Vec::new();
                for (spec, (p, rot)) in pins.iter().zip(placed) {
                    let pu = id::node_uuid(
                        &self.root_uuid_of(file),
                        &id::seed_sheet_pin(child_file, name, &spec.name),
                    );
                    pin_nodes.push((spec.name.clone(), spec.kind.clone(), p, rot, pu));
                }
                let parent_path = self.instance_path(file);
                let page = (self.sheets.len() + 1).to_string();
                let spec = nodes::SheetSpec {
                    at: *at,
                    size: *size,
                    uuid: &sheet_uuid,
                    name,
                    file: child_file,
                    pins: &pin_nodes,
                    project: &self.project_name.clone(),
                    parent_path: &parent_path,
                    page: &page,
                };
                let node = nodes::sheet(&spec, 1);
                self.push_root(file, node)?;
                res.created
                    .push(Created::of("sheet", sheet_uuid).with_name(name));
            }
            Op::AddSheetPin {
                sheet,
                name,
                kind,
                side,
                offset,
            } => {
                let sh = self.find_sheet(file, sheet)?;
                // A pin of that name is the node this op names, so a second apply of the same
                // op-list re-states it instead of stacking a duplicate on the sheet symbol
                // (apply-twice idempotence). The child label below is seeded either way: the
                // pin may predate the seeding, and `seed_hier_label` skips what is there.
                if sh.pins.iter().any(|x| x.name == *name) {
                    res.warnings
                        .push(format!("SHEET_PIN_EXISTS {name} on {}", sh.name));
                } else {
                    let (p, rot) = sheet_pin_position(
                        sh.at,
                        sh.size,
                        side,
                        offset.unwrap_or(mil_to_nm(100.0) * (sh.pins.len() as Nm + 1)),
                    );
                    let pu = self.new_uuid(file, &id::seed_sheet_pin(&sh.file, &sh.name, name))?;
                    let node = nodes::sheet_pin(name, kind, p, rot, &pu);
                    let doc = self.doc_mut(file)?;
                    if let Some(Node::List(l)) = doc.root.children.get_mut(sh.node_index) {
                        let pos = l.position("instances").unwrap_or(l.children.len());
                        l.insert(pos, node);
                    }
                    res.created
                        .push(Created::of("sheet_pin", pu).with_name(name));
                }
                // The pin and its hierarchical label are written together, through the same
                // path `add_sheet` seeds a child it creates: a pin whose child has no label
                // of that name is an instant `SHEET_PIN_UNMATCHED` (eeschema
                // `hier_label_mismatch`) and cannot be wired from inside the child.
                let child = self.child_file_path(file, &sh.file);
                // Pins already on the same column (`sheet_pin_position`: the right edge is rot 0).
                let right = side == "right";
                let on_col = sh.pins.iter().filter(|p| (p.rot == 0) == right).count() + 1;
                if self
                    .seed_hier_label(&child, name, kind, side, 0, on_col)?
                    .is_some()
                {
                    res.warnings
                        .push(format!("HIER_LABEL_SEEDED {name} in {}", sh.file));
                }
            }
            Op::DeleteSheetPin { sheet, name } => {
                let sh = self.find_sheet(file, sheet)?;
                let doc = self.doc_mut(file)?;
                let mut removed = 0;
                if let Some(Node::List(l)) = doc.root.children.get_mut(sh.node_index) {
                    let mut i = 0;
                    while i < l.children.len() {
                        if matches!(&l.children[i], Node::List(p) if p.is_named("pin") && p.arg(0).as_deref() == Some(name.as_str()))
                        {
                            l.remove(i);
                            removed += 1;
                        } else {
                            i += 1;
                        }
                    }
                }
                if removed == 0 {
                    return Err(e(
                        "SHEET_PIN_NOT_FOUND",
                        format!("{sheet} has no pin {name}"),
                    ));
                }
                // The matching hierarchical label inside the child is deliberately left in
                // place: it may carry the child's own wiring (deleting it would silently cut
                // that net), the same file can be instantiated by another sheet symbol that
                // still has the pin, and turning it into a local label is a decision for the
                // author. `sch-check` reports the leftover as `HIER_LABEL_UNMATCHED` with
                // both remedies.
                self.counts.objects_deleted += removed;
            }
            Op::ResizeSheet { sheet, size, at } => {
                let sh = self.find_sheet(file, sheet)?;
                let new_at = at.unwrap_or(sh.at);
                let doc = self.doc_mut(file)?;
                if let Some(Node::List(l)) = doc.root.children.get_mut(sh.node_index) {
                    if let Some(a) = l.find_mut("at") {
                        *a = List::compact(vec![
                            Node::bare("at"),
                            Node::atom(&nm_to_mm_str(new_at.x)),
                            Node::atom(&nm_to_mm_str(new_at.y)),
                        ]);
                    }
                    if let Some(s) = l.find_mut("size") {
                        *s = List::compact(vec![
                            Node::bare("size"),
                            Node::atom(&nm_to_mm_str(size.x)),
                            Node::atom(&nm_to_mm_str(size.y)),
                        ]);
                    }
                    // redistribute pins by side
                    let mut per_side: BTreeMap<String, usize> = BTreeMap::new();
                    for c in l.children.iter_mut() {
                        if let Node::List(p) = c {
                            if p.is_named("pin") {
                                let (px, _rot) = p
                                    .find("at")
                                    .map(|a| {
                                        (a.arg_f64(0).unwrap_or(0.0), a.arg_f64(2).unwrap_or(0.0))
                                    })
                                    .unwrap_or((0.0, 0.0));
                                let old_x = mm_to_nm(px);
                                let side = if old_x <= sh.at.x { "left" } else { "right" };
                                let n = per_side.entry(side.to_string()).or_default();
                                *n += 1;
                                let (np, rot) = sheet_pin_position(
                                    new_at,
                                    *size,
                                    side,
                                    mil_to_nm(100.0) * *n as Nm,
                                );
                                if let Some(a) = p.find_mut("at") {
                                    *a = List::compact(vec![
                                        Node::bare("at"),
                                        Node::atom(&nm_to_mm_str(np.x)),
                                        Node::atom(&nm_to_mm_str(np.y)),
                                        Node::atom(&rot.to_string()),
                                    ]);
                                }
                            }
                        }
                    }
                }
                self.counts.transforms_changed += 1;
            }
            Op::ArrangeGroup {
                group,
                region,
                pitch_x,
                pitch_y,
                designators,
                only_unwired,
            } => {
                let sheet = self.sheet(file)?.clone();
                let doc = self
                    .docs
                    .get(file)
                    .ok_or_else(|| e("SHEET_NOT_FOUND", file.display().to_string()))?
                    .clone();
                let region_box = BBox {
                    min: region.0,
                    max: region.1,
                };
                let mut items: Vec<(SymbolInst, BBox)> = Vec::new();
                for s in &sheet.symbols {
                    if s.reference.starts_with('#') {
                        continue;
                    }
                    let wanted = match designators {
                        Some(d) => d.contains(&s.reference),
                        None => region_box.contains(s.placement.at),
                    };
                    if !wanted {
                        continue;
                    }
                    if *only_unwired {
                        let pins: Vec<Pt> = sheet
                            .lib_symbol(&s.lib_id)
                            .map(|l| world_pins(s, l).into_iter().map(|p| p.at).collect())
                            .unwrap_or_default();
                        let wired = sheet
                            .wires
                            .iter()
                            .any(|w| pins.contains(&w.a) || pins.contains(&w.b));
                        if wired {
                            res.warnings
                                .push(format!("{} left in place (wired)", s.reference));
                            continue;
                        }
                    }
                    let Some(b) = symbol_bbox(&doc, s) else {
                        continue;
                    };
                    items.push((s.clone(), b));
                }
                if items.is_empty() {
                    return Err(e(
                        "COMPONENT_NOT_FOUND",
                        format!("arrange_group {group}: no movable component in the region"),
                    ));
                }
                items.sort_by_key(|a| natural_key(&a.0.reference));
                let margin = mil_to_nm(100.0);
                let grid = mil_to_nm(50.0);
                let big_h = *pitch_y * 2;
                let pin_count = |s: &SymbolInst| -> usize {
                    sheet
                        .lib_symbol(&s.lib_id)
                        .map(|l| l.pins_for_unit(s.unit).count())
                        .unwrap_or(0)
                };
                // Pass 1: rows. IC-like parts (> 8 pins or taller than two pitches) get a row of
                // their own; small parts fill a row left to right until the region edge.
                let mut rows: Vec<Vec<(SymbolInst, BBox)>> = Vec::new();
                let mut cur: Vec<(SymbolInst, BBox)> = Vec::new();
                let mut cur_w: Nm = 0;
                for (s, b) in &items {
                    let w = b.max.x - b.min.x;
                    let h = b.max.y - b.min.y;
                    let big = pin_count(s) > 8 || h > big_h;
                    let cell_w = (*pitch_x).max(w + margin);
                    if big {
                        if !cur.is_empty() {
                            rows.push(std::mem::take(&mut cur));
                            cur_w = 0;
                        }
                        rows.push(vec![(s.clone(), *b)]);
                        continue;
                    }
                    if !cur.is_empty() && region.0.x + margin + cur_w + cell_w > region.1.x - margin
                    {
                        rows.push(std::mem::take(&mut cur));
                        cur_w = 0;
                    }
                    cur.push((s.clone(), *b));
                    cur_w += cell_w;
                }
                if !cur.is_empty() {
                    rows.push(cur);
                }
                // Pass 2: place each row so every body's bottom edge sits on the row baseline
                // (aligned), then snap the anchor to the 50 mil grid.
                let mut cy = region.0.y + margin;
                let mut row_h: Nm = 0;
                let mut moves: Vec<(SymbolInst, Pt)> = Vec::new();
                for row in &rows {
                    let tallest = row
                        .iter()
                        .map(|(_, b)| b.max.y - b.min.y)
                        .max()
                        .unwrap_or(0);
                    let cell_h = (*pitch_y).max(tallest + margin);
                    let baseline = cy + tallest;
                    let mut cx = region.0.x + margin;
                    for (s, b) in row {
                        let w = b.max.x - b.min.x;
                        let cell_w = (*pitch_x).max(w + margin);
                        let target = Pt::new(
                            s.placement.at.x + (cx - b.min.x),
                            s.placement.at.y + (baseline - b.max.y),
                        );
                        let snapped = Pt::new(
                            (target.x as f64 / grid as f64).round() as Nm * grid,
                            (target.y as f64 / grid as f64).round() as Nm * grid,
                        );
                        moves.push((s.clone(), snapped));
                        cx += cell_w;
                    }
                    row_h = cell_h;
                    cy += cell_h;
                }
                cy -= row_h;
                if cy + row_h > region.1.y + margin {
                    res.warnings.push(format!(
                        "arrange_group {group}: the region is too small for {} parts; extend region_mil",
                        items.len()
                    ));
                }
                for (s, to) in moves {
                    if to == s.placement.at {
                        continue;
                    }
                    let mv = ExpandedOp {
                        authored_index: x.authored_index,
                        sheet: x.sheet.clone(),
                        note: None,
                        region_mil: x.region_mil,
                        exact: true,
                        no_nudge: false,
                        op: Op::MoveComponent {
                            designator: None,
                            uuid: Some(s.uuid.clone()),
                            place: Place::At(to),
                            unit: Some(s.unit),
                            carry_labels: true,
                            carry_wires: true,
                            carry_power: true,
                        },
                    };
                    // The nested move reports its own pose change; it belongs to this op's result.
                    let moved = self.apply(file, &mv)?;
                    res.changed.extend(moved.changed);
                    res.warnings.push(format!(
                        "{} moved to ({:.0},{:.0}) mil",
                        s.reference,
                        nm_to_mil(to.x),
                        nm_to_mil(to.y)
                    ));
                }
            }
            Op::SetTitleBlock { fields } => {
                let doc = self.doc_mut(file)?;
                let pos = doc.root.position("title_block");
                let mut tb = match pos {
                    Some(i) => match doc.root.remove(i) {
                        Node::List(l) => l,
                        _ => List::compact(vec![Node::bare("title_block")]),
                    },
                    None => List::compact(vec![Node::bare("title_block")]),
                };
                for (k, v) in fields {
                    if let Some(n) = k.strip_prefix("comment") {
                        tb.remove_all_comment(n);
                        tb.push(Node::List(List::compact(vec![
                            Node::bare("comment"),
                            Node::atom(n),
                            Node::quoted(v),
                        ])));
                    } else {
                        tb.remove_all(k);
                        tb.push(Node::List(List::compact(vec![
                            Node::bare(k),
                            Node::quoted(v),
                        ])));
                    }
                }
                kicad_sexpr::pretty(&mut tb, 1);
                let insert_at = doc
                    .root
                    .position("paper")
                    .map(|i| i + 1)
                    .unwrap_or(pos.unwrap_or(1));
                doc.root.insert(insert_at, Node::List(tb));
                self.counts.properties_changed += 1;
            }
        }
        self.refresh(file)?;
        Ok(res)
    }

    /// Where the Reference / Value texts of `lib_id` go when placed at `pl`:
    /// the library symbol's own anchors when they already clear the body, the
    /// other fields and each other's row, otherwise eeschema's field autoplace
    /// (see [`crate::autoplace`]). `texts` is the drawn Reference and the drawn
    /// Value, measured through `sch_read::bbox::text_width_mil`.
    fn text_spots(
        &self,
        file: &Path,
        lib_id: &str,
        unit: u32,
        pl: Placement,
        texts: [&str; 2],
    ) -> autoplace::Fields {
        // Nothing to measure (no cached symbol yet): park the texts beside the
        // anchor and let the layout gate judge the result.
        let fallback = || autoplace::Fields {
            places: vec![
                FieldPlace {
                    at: Pt::new(pl.at.x + mil_to_nm(100.0), pl.at.y - mil_to_nm(50.0)),
                    justify: Some("left"),
                    rot: 0,
                },
                FieldPlace {
                    at: Pt::new(pl.at.x + mil_to_nm(100.0), pl.at.y + mil_to_nm(50.0)),
                    justify: Some("left"),
                    rot: 0,
                },
            ],
            autoplaced: false,
        };
        let (Ok(sheet), Some(doc)) = (self.sheet(file), self.docs.get(file)) else {
            return fallback();
        };
        let Some(node) = doc.root.find("lib_symbols").and_then(|c| {
            c.find_all("symbol")
                .find(|s| s.arg(0).as_deref() == Some(lib_id))
        }) else {
            return fallback();
        };
        let pins: Vec<(Pt, (i64, i64))> = sheet
            .lib_symbol(lib_id)
            .map(|l| {
                l.pins_for_unit(unit)
                    .map(|p| (p.at, away_vec(p.angle)))
                    .collect()
            })
            .unwrap_or_default();
        autoplace::place_fields(node, unit, &pins, pl, &["Reference", "Value"], &texts)
            .unwrap_or_else(fallback)
    }

    /// Move the Reference and Value of a symbol *this engine* placed back onto the anchors
    /// [`Workset::text_spots`] would choose for `reference` / `value` at `pl` now (the
    /// placement the symbol has *after* the op, which is not the one in the pre-op snapshot).
    /// A no-op unless the symbol carries `(fields_autoplaced yes)` - the flag eeschema and this
    /// writer both put on a symbol whose fields the tool owns - and unless the fresh answer is
    /// itself an autoplace, so the flag on the symbol stays true.
    fn reautoplace_fields(
        &mut self,
        file: &Path,
        sym: &SymbolInst,
        pl: Placement,
        reference: &str,
        value: &str,
    ) -> Result<(), ApplyError> {
        let ours = self
            .docs
            .get(file)
            .and_then(|doc| doc.root.children.get(sym.node_index))
            .and_then(|n| match n {
                Node::List(l) => Some(l.find("fields_autoplaced").is_some()),
                _ => None,
            })
            .unwrap_or(false);
        if !ours {
            return Ok(());
        }
        let fields = self.text_spots(file, &sym.lib_id, sym.unit, pl, [reference, value]);
        if !fields.autoplaced {
            return Ok(());
        }
        let [ref_place, val_place] = fields.places[..] else {
            return Ok(());
        };
        self.with_node(file, &sym.uuid, |l| {
            for c in l.children.iter_mut() {
                let Node::List(prop) = c else { continue };
                if !prop.is_named("property") {
                    continue;
                }
                let place = match prop.arg(0).as_deref() {
                    Some("Reference") => ref_place,
                    Some("Value") => val_place,
                    _ => continue,
                };
                if let Some(a) = prop.find_mut("at") {
                    if let Node::List(fresh) = nodes::at(place.at, place.rot) {
                        *a = fresh;
                    }
                }
                if let Some(eff) = prop.find_mut("effects") {
                    eff.remove_all("justify");
                    if let Some(j) = place.justify {
                        // After `font`, before a `hide`, the order KiCad writes.
                        let at = eff.position("hide").unwrap_or(eff.children.len());
                        eff.insert(at, Node::call("justify", &[j]));
                    }
                }
            }
        })?;
        Ok(())
    }

    /// Placement nudge: if the body of `lib_id` placed at `pl` would come
    /// within 50 mil of an existing symbol body, walk the 100-mil grid in
    /// growing rings (out to [`PLACEMENT_NUDGE_MAX_MIL`]) for the nearest free
    /// spot; stay inside `region_mil` when the op belongs to a group with a
    /// region. Returns [`Nudge::Clear`] when the authored spot is free,
    /// [`Nudge::Moved`] with the spot and the first blocker, or
    /// [`Nudge::Blocked`] when nothing within the bound is free. None means the
    /// search could not run (no cached symbol, empty body): place as authored
    /// and let the layout gate judge it.
    /// `PLACEMENT_OFF_FRAME` for an `exact` placement: `exact` is the author saying they chose
    /// the position, so it is written verbatim — but a body under the worksheet frame or the
    /// title block is off the printed page, and the author should hear that from the dry run
    /// rather than from the layout gate after the write. Never a refusal (same contract as
    /// `PLACEMENT_OFF_GRID`). None when the body or the paper size is unknown.
    fn off_frame_warning(
        &self,
        file: &Path,
        lib_id: &str,
        unit: u32,
        pl: Placement,
        designator: &str,
    ) -> Option<String> {
        let sheet = self.sheet(file).ok()?;
        let frame = crate::gates::drawing_border(&sheet.paper)?;
        let doc = self.docs.get(file)?;
        let node = doc
            .root
            .find("lib_symbols")?
            .find_all("symbol")
            .find(|s| s.arg(0).as_deref() == Some(lib_id))?;
        let local = lib_body_bbox(node, unit);
        if local.is_empty() {
            return None;
        }
        let b = world_box(&local, pl);
        if frame.contains_box(&b) {
            return None;
        }
        Some(format!(
            "PLACEMENT_OFF_FRAME: {designator} at ({:.0},{:.0}) mil sits outside {} because `exact` keeps the authored position; its body spans x {:.0}..{:.0}, y {:.0}..{:.0} mil. Drop `exact` so the placement nudge moves it inside, or author a position within the border",
            nm_to_mil(pl.at.x),
            nm_to_mil(pl.at.y),
            frame_blocker(&sheet.paper, Some(&frame)),
            nm_to_mil(b.min.x),
            nm_to_mil(b.max.x),
            nm_to_mil(b.min.y),
            nm_to_mil(b.max.y)
        ))
    }

    fn nudge_free_spot(
        &self,
        file: &Path,
        lib_id: &str,
        unit: u32,
        pl: Placement,
        region_mil: Option<[[f64; 2]; 2]>,
        texts: [&str; 2],
    ) -> Option<Nudge> {
        let sheet = self.sheet(file).ok()?;
        let doc = self.docs.get(file)?;
        let cache = doc.root.find("lib_symbols")?;
        let node = cache
            .find_all("symbol")
            .find(|s| s.arg(0).as_deref() == Some(lib_id))?;
        let local = lib_body_bbox(node, unit);
        if local.is_empty() {
            return None;
        }
        let world = |at: Pt| world_box(&local, Placement { at, ..pl });
        let mut others: Vec<(String, BBox)> = sheet
            .symbols
            .iter()
            .filter_map(|s| {
                if s.reference.starts_with('#') {
                    symbol_graphics_bbox(doc, s).map(|b| (s.reference.clone(), b))
                } else {
                    symbol_bbox(doc, s).map(|b| (s.reference.clone(), b))
                }
            })
            .collect();
        for s in &sheet.symbols {
            others.extend(symbol_text_boxes(doc, s));
            // their pin tips will carry labels too: keep the same stub clear
            if s.reference.starts_with('#') {
                continue;
            }
            if let Some(l) = sheet.lib_symbol(&s.lib_id) {
                for pn in l.pins_for_unit(s.unit) {
                    let tip = transform_point(pn.at, s.placement);
                    let (dx, dy) = world_dir(away_vec(pn.angle), s.placement);
                    let far = Pt::new(tip.x + dx * mil_to_nm(250.0), tip.y + dy * mil_to_nm(250.0));
                    let mut bb = BBox::empty();
                    bb.include(Pt::new(
                        tip.x.min(far.x) - mil_to_nm(50.0),
                        tip.y.min(far.y) - mil_to_nm(50.0),
                    ));
                    bb.include(Pt::new(
                        tip.x.max(far.x) + mil_to_nm(50.0),
                        tip.y.max(far.y) + mil_to_nm(50.0),
                    ));
                    others.push((format!("{} pin {}", s.reference, pn.number), bb));
                }
            }
        }
        // Existing label text is part of the occupied area.
        for l in &sheet.labels {
            let kind = match l.kind {
                LabelKind::Local => "local",
                LabelKind::Global => "global",
                _ => "hierarchical",
            };
            others.push((
                format!("label {}", l.text),
                label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0),
            ));
        }
        let clearance = mil_to_nm(50.0);
        // Label-on-pin is the default connection style: reserve a stub beyond
        // every pin tip so the labels that will follow have room.
        let reserve = mil_to_nm(250.0);
        let half = mil_to_nm(50.0);
        let lib_pins: Vec<(Pt, (i64, i64))> = sheet
            .lib_symbol(lib_id)
            .map(|l| {
                l.pins_for_unit(unit)
                    .map(|pn| (pn.at, away_vec(pn.angle)))
                    .collect()
            })
            .unwrap_or_default();
        let stubs = |at: Pt| -> Vec<BBox> {
            let p = Placement { at, ..pl };
            // Same field placement the write will use, so the nudge reserves
            // the area the property texts actually take.
            let fields =
                autoplace::place_fields(node, unit, &lib_pins, p, &["Reference", "Value"], &texts)
                    .map(|f| f.places)
                    .unwrap_or_else(|| {
                        vec![
                            FieldPlace {
                                at: Pt::new(at.x + mil_to_nm(100.0), at.y - mil_to_nm(50.0)),
                                justify: Some("left"),
                                rot: 0,
                            },
                            FieldPlace {
                                at: Pt::new(at.x + mil_to_nm(100.0), at.y + mil_to_nm(50.0)),
                                justify: Some("left"),
                                rot: 0,
                            },
                        ]
                    });
            let mut v: Vec<BBox> = fields
                .iter()
                .zip(texts.iter())
                .map(|(f, t)| {
                    field_bbox(
                        t,
                        f.at,
                        f.rot,
                        autoplace::FIELD_SIZE_MIL,
                        f.justify.unwrap_or(""),
                        p,
                    )
                })
                .collect();
            v.extend(lib_pins.iter().map(|(lp, (vx, vy))| {
                let tip = transform_point(*lp, p);
                let (dx, dy) = world_dir((*vx, *vy), pl);
                let far = Pt::new(tip.x + dx * reserve, tip.y + dy * reserve);
                let mut bb = BBox::empty();
                bb.include(Pt::new(tip.x.min(far.x) - half, tip.y.min(far.y) - half));
                bb.include(Pt::new(tip.x.max(far.x) + half, tip.y.max(far.y) + half));
                bb
            }));
            v
        };
        let region = region_mil.map(|r| BBox {
            min: Pt::new(mil_to_nm(r[0][0]), mil_to_nm(r[0][1])),
            max: Pt::new(mil_to_nm(r[1][0]), mil_to_nm(r[1][1])),
        });
        let body_blocker = |at: Pt| -> Option<String> {
            let b = world(at).expand(clearance);
            if let Some((r, _)) = others.iter().find(|(_, o)| o.intersects(&b)) {
                return Some(r.clone());
            }
            let st = stubs(at);
            others
                .iter()
                .find(|(_, o)| st.iter().any(|sb| sb.intersects(o)))
                .map(|(r, _)| r.clone())
        };
        let frame = crate::gates::drawing_border(&sheet.paper);
        let in_frame = |at: Pt| -> bool {
            let b = world(at);
            frame.as_ref().map(|f| f.contains_box(&b)).unwrap_or(true)
        };
        let in_region = |at: Pt| -> bool {
            region
                .as_ref()
                .map(|r| r.contains_box(&world(at)))
                .unwrap_or(true)
        };
        // A spot under the worksheet frame or the title block is never `Clear`, however empty it
        // is: the part would be drawn on top of the border and off the printed page. It goes
        // through the same ring search as an occupied spot (the search only ever offers in-frame
        // candidates), and is refused with `PLACEMENT_BLOCKED` when the border is out of reach.
        let first = match body_blocker(pl.at) {
            Some(b) => b,
            None if in_frame(pl.at) => return Some(Nudge::Clear),
            None => frame_blocker(&sheet.paper, frame.as_ref()),
        };
        let blocker = |at: Pt| -> Option<String> {
            if !in_region(at) {
                return Some("region edge".into());
            }
            body_blocker(at)
        };
        let step = mil_to_nm(100.0);
        // A ring is one 100 mil grid square out, so the bound is a ring count. Beyond it the part
        // would no longer be where the author put it (see `PLACEMENT_NUDGE_MAX_MIL`).
        let max_ring = (PLACEMENT_NUDGE_MAX_MIL / 100.0) as i64;
        // pass 0: inside the region; pass 1: anywhere (reported as such)
        for pass in 0..2 {
            if pass == 1 && region.is_none() {
                break;
            }
            for ring in 1..=max_ring {
                let mut cands: Vec<Pt> = Vec::new();
                for dx in -ring..=ring {
                    for dy in -ring..=ring {
                        if dx.abs().max(dy.abs()) == ring {
                            cands.push(Pt::new(pl.at.x + dx * step, pl.at.y + dy * step));
                        }
                    }
                }
                // prefer right/down (signal flow) then closest by manhattan distance
                cands.sort_by_key(|c| {
                    let d = (c.x - pl.at.x).abs() + (c.y - pl.at.y).abs();
                    // moving up/left costs an extra 300 mil per axis
                    let up = if c.y < pl.at.y { 3 * step } else { 0 };
                    let left = if c.x < pl.at.x { 3 * step } else { 0 };
                    d + up + left
                });
                for c in cands {
                    if !in_frame(c) {
                        continue;
                    }
                    let hit = if pass == 0 {
                        blocker(c)
                    } else {
                        body_blocker(c)
                    };
                    if hit.is_none() {
                        let why = if pass == 1 {
                            format!("{first} (no room inside the group region; extend region_mil)")
                        } else {
                            first.clone()
                        };
                        return Some(Nudge::Moved {
                            to: c,
                            blocker: why,
                        });
                    }
                }
            }
        }
        Some(Nudge::Blocked { blocker: first })
    }

    fn load_symbol_source(&mut self, src: &str, lib_id: &str) -> Result<(), ApplyError> {
        let path = Path::new(src);
        let text = std::fs::read_to_string(path)
            .map_err(|err| e("SYMBOL_SOURCE", format!("{src}: {err}")))?;
        let doc = kicad_sexpr::parse(&text).map_err(|err| e("SYMBOL_SOURCE", err.to_string()))?;
        let short = lib_id.rsplit(':').next().unwrap_or(lib_id);
        let container = if doc.root.is_named("kicad_sch") {
            doc.root.find("lib_symbols").cloned()
        } else {
            Some(doc.root.clone())
        };
        if let Some(c) = container {
            for s in c.find_all("symbol") {
                let n = s.arg(0).unwrap_or_default();
                if n == lib_id || n.rsplit(':').next() == Some(short) {
                    let mut node = s.clone();
                    if let Some(Node::Atom(a)) = node.children.get_mut(1) {
                        *a = kicad_sexpr::Atom::quoted(lib_id);
                    }
                    self.extra_cache.insert(lib_id.to_string(), node);
                    return Ok(());
                }
            }
        }
        Err(e(
            "SYMBOL_NOT_FOUND",
            format!("{lib_id} not found in {src}"),
        ))
    }

    fn add_label(
        &mut self,
        file: &Path,
        name: &str,
        p: Pt,
        rot: i64,
        scope: &Scope,
    ) -> Result<String, ApplyError> {
        let (kind, scope_s, shape) = match scope {
            Scope::Local => ("label", "local", None),
            Scope::Global => ("global_label", "global", Some("input")),
            Scope::Hierarchical => ("hierarchical_label", "hierarchical", Some("input")),
        };
        let u = self.new_uuid(file, &id::seed_label(scope_s, name, &id::anchor_pt(p)))?;
        let node = nodes::label(kind, name, p, rot, shape, &u, 1);
        self.push_root(file, node)?;
        self.counts.labels_added += 1;
        Ok(u)
    }

    fn find_sheet(&self, file: &Path, key: &str) -> Result<SheetInst, ApplyError> {
        let sheet = self.sheet(file)?;
        // A sheet symbol is addressed by its name or uuid; its file name (with or without .kicad_sch) is
        // accepted too, because models routinely say "power.kicad_sch" for the sheet called "power".
        let stem = |f: &str| {
            f.rsplit('/')
                .next()
                .unwrap_or(f)
                .trim_end_matches(".kicad_sch")
                .to_string()
        };
        let key_stem = stem(key);
        sheet
            .sheets
            .iter()
            .find(|s| s.name == key || s.uuid == key || s.file == key || stem(&s.file) == key_stem)
            .cloned()
            .ok_or_else(|| {
                let names: Vec<&str> = sheet.sheets.iter().map(|s| s.name.as_str()).collect();
                e(
                    "SHEET_NOT_FOUND",
                    if names.is_empty() {
                        format!("no sheet symbol named {key}: this sheet has no hierarchical sheet symbols (a sheet file is not a sheet symbol)")
                    } else {
                        format!("no sheet symbol named {key}; sheet symbols on this sheet: {}", names.join(", "))
                    },
                )
            })
    }

    fn match_object(&self, file: &Path, m: &sch_ops::MatchSpec) -> Result<String, ApplyError> {
        let sheet = self.sheet(file)?;
        let mut hits: Vec<String> = Vec::new();
        match m.kind.as_str() {
            "wire" | "bus" => {
                for w in sheet.wires.iter().filter(|w| w.is_bus == (m.kind == "bus")) {
                    let ok = match (&m.between, &m.at) {
                        (Some((a, b)), _) => (w.a == *a && w.b == *b) || (w.a == *b && w.b == *a),
                        (None, Some(p)) => w.a == *p || w.b == *p,
                        _ => false,
                    };
                    if ok {
                        hits.push(w.uuid.clone());
                    }
                }
            }
            "label" | "global_label" | "hierarchical_label" => {
                let kind = match m.kind.as_str() {
                    "label" => LabelKind::Local,
                    "global_label" => LabelKind::Global,
                    _ => LabelKind::Hierarchical,
                };
                for l in sheet.labels.iter().filter(|l| l.kind == kind) {
                    let name_ok = m.name.as_ref().map(|n| *n == l.text).unwrap_or(true);
                    let at_ok = m.at.map(|p| p == l.at).unwrap_or(true);
                    if name_ok && at_ok && (m.name.is_some() || m.at.is_some()) {
                        hits.push(l.uuid.clone());
                    }
                }
            }
            "junction" => hits.extend(
                sheet
                    .junctions
                    .iter()
                    .filter(|j| Some(j.at) == m.at)
                    .map(|j| j.uuid.clone()),
            ),
            "no_connect" => hits.extend(
                sheet
                    .no_connects
                    .iter()
                    .filter(|j| Some(j.at) == m.at)
                    .map(|j| j.uuid.clone()),
            ),
            "bus_entry" => hits.extend(
                sheet
                    .bus_entries
                    .iter()
                    .filter(|j| Some(j.at) == m.at)
                    .map(|j| j.uuid.clone()),
            ),
            "text" | "rectangle" | "text_box" => {
                // graphic items are matched via the raw document
                let doc = &self.docs[file];
                for c in doc.root.lists() {
                    if c.is_named(&m.kind) {
                        let at = c.find("at").or_else(|| c.find("start")).and_then(|a| {
                            Some(Pt::new(
                                mm_str_to_nm(&a.arg(0)?)?,
                                mm_str_to_nm(&a.arg(1)?)?,
                            ))
                        });
                        let name_ok = m
                            .name
                            .as_ref()
                            .map(|n| c.arg(0).as_deref() == Some(n.as_str()))
                            .unwrap_or(true);
                        if at.is_some() && at == m.at && name_ok
                            || (m.at.is_none() && m.name.is_some() && name_ok)
                        {
                            hits.push(c.find("uuid").and_then(|u| u.arg(0)).unwrap_or_default());
                        }
                    }
                }
            }
            _ => {}
        }
        match hits.len() {
            1 => Ok(hits.remove(0)),
            // Zero hits is not an ambiguity: MATCH_AMBIGUOUS told the model to narrow a match that
            // was already too narrow, and it kept shrinking it. Report it as the not-found it is,
            // and list what the sheet actually has of that kind.
            0 => {
                let cands = self.match_candidates(file, &m.kind);
                Err(e_rem(
                    "OBJECT_NOT_FOUND",
                    format!(
                        "no {} on {} matches this `match`",
                        m.kind,
                        file_label(file)
                    ),
                    if cands.is_empty() {
                        format!(
                            "this sheet has no {} at all; check the `sheet` the op is routed to, or read the sheet with sch.read before matching",
                            m.kind
                        )
                    } else {
                        format!(
                            "{} on this sheet: {}. Match one of these exactly, or address it by uuid",
                            m.kind,
                            cands.join("; ")
                        )
                    },
                ))
            }
            n => Err(e_rem(
                "MATCH_AMBIGUOUS",
                format!("match found {n} objects; narrow it down"),
                "add `at` (and `name` for labels and graphics) so exactly one object matches, or address it by uuid",
            )),
        }
    }

    /// What a `match` of this kind could have hit on this sheet, capped and compact: the model
    /// gets to pick from the real objects instead of guessing another spelling.
    fn match_candidates(&self, file: &Path, kind: &str) -> Vec<String> {
        const CAP: usize = 12;
        let Ok(sheet) = self.sheet(file) else {
            return Vec::new();
        };
        let pt = |p: Pt| format!("({:.0},{:.0})", nm_to_mil(p.x), nm_to_mil(p.y));
        let mut out: Vec<String> = match kind {
            "wire" | "bus" => sheet
                .wires
                .iter()
                .filter(|w| w.is_bus == (kind == "bus"))
                .map(|w| format!("{}-{}", pt(w.a), pt(w.b)))
                .collect(),
            "label" | "global_label" | "hierarchical_label" => {
                let want = match kind {
                    "label" => LabelKind::Local,
                    "global_label" => LabelKind::Global,
                    _ => LabelKind::Hierarchical,
                };
                sheet
                    .labels
                    .iter()
                    .filter(|l| l.kind == want)
                    .map(|l| format!("{} {}", l.text, pt(l.at)))
                    .collect()
            }
            "junction" => sheet.junctions.iter().map(|j| pt(j.at)).collect(),
            "no_connect" => sheet.no_connects.iter().map(|j| pt(j.at)).collect(),
            "bus_entry" => sheet.bus_entries.iter().map(|j| pt(j.at)).collect(),
            "text" | "rectangle" | "text_box" => self
                .docs
                .get(file)
                .map(|doc| {
                    doc.root
                        .lists()
                        .filter(|c| c.is_named(kind))
                        .filter_map(|c| c.arg(0))
                        .collect()
                })
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let total = out.len();
        out.truncate(CAP);
        if total > CAP {
            out.push(format!("and {} more", total - CAP));
        }
        out
    }

    fn remove_nodes_by_uuid(
        &mut self,
        file: &Path,
        uuids: &HashSet<String>,
    ) -> Result<usize, ApplyError> {
        let doc = self.doc_mut(file)?;
        let mut removed = 0;
        let mut i = 0;
        while i < doc.root.children.len() {
            let hit = match &doc.root.children[i] {
                Node::List(l) => l
                    .find("uuid")
                    .and_then(|u| u.arg(0))
                    .map(|u| uuids.contains(&u))
                    .unwrap_or(false),
                _ => false,
            };
            if hit {
                doc.root.remove(i);
                removed += 1;
            } else {
                i += 1;
            }
        }
        self.refresh(file)?;
        Ok(removed)
    }

    fn with_node<F: FnOnce(&mut List)>(
        &mut self,
        file: &Path,
        uuid: &str,
        f: F,
    ) -> Result<(), ApplyError> {
        let doc = self.doc_mut(file)?;
        for c in doc.root.children.iter_mut() {
            if let Node::List(l) = c {
                if l.find("uuid").and_then(|u| u.arg(0)).as_deref() == Some(uuid) {
                    f(l);
                    return Ok(());
                }
            }
        }
        Err(e("OBJECT_NOT_FOUND", uuid.to_string()))
    }

    fn translate_symbol(&mut self, file: &Path, uuid: &str, delta: Pt) -> Result<(), ApplyError> {
        self.with_node(file, uuid, |l| {
            shift_at(l, delta);
            for c in l.children.iter_mut() {
                if let Node::List(p) = c {
                    if p.is_named("property") {
                        shift_at(p, delta);
                    }
                }
            }
        })
    }

    fn translate_at(&mut self, file: &Path, uuid: &str, delta: Pt) -> Result<(), ApplyError> {
        self.with_node(file, uuid, |l| {
            shift_at(l, delta);
            for c in l.children.iter_mut() {
                if let Node::List(p) = c {
                    if p.is_named("property") {
                        shift_at(p, delta);
                    }
                }
            }
        })
    }

    fn translate_wire_end(
        &mut self,
        file: &Path,
        uuid: &str,
        move_a: bool,
        move_b: bool,
        delta: Pt,
    ) -> Result<(), ApplyError> {
        self.with_node(file, uuid, |l| {
            if let Some(pts) = l.find_mut("pts") {
                let mut idx = 0;
                for c in pts.children.iter_mut() {
                    if let Node::List(xy) = c {
                        if xy.is_named("xy") {
                            let should = (idx == 0 && move_a) || (idx == 1 && move_b);
                            if should {
                                let x =
                                    xy.arg(0).and_then(|s| mm_str_to_nm(&s)).unwrap_or(0) + delta.x;
                                let y =
                                    xy.arg(1).and_then(|s| mm_str_to_nm(&s)).unwrap_or(0) + delta.y;
                                *xy = List::compact(vec![
                                    Node::bare("xy"),
                                    Node::atom(&nm_to_mm_str(x)),
                                    Node::atom(&nm_to_mm_str(y)),
                                ]);
                            }
                            idx += 1;
                        }
                    }
                }
            }
        })
    }

    /// Both endpoints of one wire, written absolutely. `translate_wire_end` can only slide an end
    /// by a delta, which is exactly what leaves a carried segment diagonal; re-routing needs to say
    /// where the leg actually ends. Only the two `xy` nodes are rewritten, so everything else the
    /// file carries on that wire (stroke, uuid, unknown children) stays byte-identical.
    fn set_wire_ends(&mut self, file: &Path, uuid: &str, a: Pt, b: Pt) -> Result<(), ApplyError> {
        self.with_node(file, uuid, |l| {
            if let Some(pts) = l.find_mut("pts") {
                let mut idx = 0;
                for c in pts.children.iter_mut() {
                    if let Node::List(xy) = c {
                        if xy.is_named("xy") {
                            let p = if idx == 0 { a } else { b };
                            if idx < 2 {
                                *xy = List::compact(vec![
                                    Node::bare("xy"),
                                    Node::atom(&nm_to_mm_str(p.x)),
                                    Node::atom(&nm_to_mm_str(p.y)),
                                ]);
                            }
                            idx += 1;
                        }
                    }
                }
            }
        })
    }

    fn set_transform(
        &mut self,
        file: &Path,
        uuid: &str,
        rotation: Option<i64>,
        mirror: Option<&str>,
    ) -> Result<(), ApplyError> {
        self.with_node(file, uuid, |l| {
            if let Some(r) = rotation {
                if let Some(a) = l.find_mut("at") {
                    let x = a.arg(0).unwrap_or_default();
                    let y = a.arg(1).unwrap_or_default();
                    *a = List::compact(vec![
                        Node::bare("at"),
                        Node::atom(&x),
                        Node::atom(&y),
                        Node::atom(&r.to_string()),
                    ]);
                }
            }
            if let Some(m) = mirror {
                l.remove_all("mirror");
                if m != "none" {
                    let pos = l.position("at").map(|i| i + 1).unwrap_or(1);
                    l.insert(pos, Node::call("mirror", &[m]));
                }
            }
        })
    }

    fn set_property(
        &mut self,
        file: &Path,
        uuid: &str,
        name: &str,
        value: &str,
    ) -> Result<(), ApplyError> {
        let name = name.to_string();
        let value = value.to_string();
        self.with_node(file, uuid, |l| {
            let at = l
                .find("at")
                .and_then(|a| {
                    Some(Pt::new(
                        mm_str_to_nm(&a.arg(0)?)?,
                        mm_str_to_nm(&a.arg(1)?)?,
                    ))
                })
                .unwrap_or_default();
            for c in l.children.iter_mut() {
                if let Node::List(p) = c {
                    if p.is_named("property") && p.arg(0).as_deref() == Some(name.as_str()) {
                        if let Some(Node::Atom(a)) = p.children.get_mut(2) {
                            *a = kicad_sexpr::Atom::quoted(&value);
                        }
                        return;
                    }
                }
            }
            // new custom property, hidden
            let pos = l
                .children
                .iter()
                .rposition(|c| matches!(c, Node::List(p) if p.is_named("property")))
                .map(|i| i + 1)
                .unwrap_or(l.children.len());
            let mut prop = match nodes::property(&name, &value, at, 0, None, true) {
                Node::List(x) => x,
                _ => unreachable!(),
            };
            kicad_sexpr::pretty(&mut prop, 2);
            l.insert(pos, Node::List(prop));
        })
    }

    fn set_flag(
        &mut self,
        file: &Path,
        uuid: &str,
        key: &str,
        value: bool,
    ) -> Result<(), ApplyError> {
        let key = key.to_string();
        self.with_node(file, uuid, |l| {
            let v = if value { "yes" } else { "no" };
            if let Some(n) = l.find_mut(&key) {
                *n = List::compact(vec![Node::bare(&key), Node::bare(v)]);
            } else {
                let pos = l.position("uuid").unwrap_or(l.children.len());
                l.insert(pos, Node::call(&key, &[v]));
            }
        })
    }

    fn set_instance_refs(
        &mut self,
        file: &Path,
        uuid: &str,
        map: &BTreeMap<String, String>,
        all: Option<&str>,
    ) -> Result<(), ApplyError> {
        let map = map.clone();
        let all = all.map(|s| s.to_string());
        self.with_node(file, uuid, |l| {
            if let Some(inst) = l.find_mut("instances") {
                for proj in inst.lists_mut() {
                    for p in proj.lists_mut() {
                        if !p.is_named("path") {
                            continue;
                        }
                        let path = p.arg(0).unwrap_or_default();
                        let new_ref = all.clone().or_else(|| map.get(&path).cloned());
                        if let Some(r) = new_ref {
                            if let Some(rn) = p.find_mut("reference") {
                                *rn =
                                    List::compact(vec![Node::bare("reference"), Node::quoted(&r)]);
                            }
                        }
                    }
                }
            }
        })
    }

    /// Absolute path of the child schematic a sheet symbol placed in `parent` points at.
    fn child_path(&self, parent: &Path, sh: &SheetInst) -> PathBuf {
        let p = parent.parent().unwrap_or(Path::new(".")).join(&sh.file);
        p.canonicalize().unwrap_or(p)
    }

    /// Is this symbol a power port (its value is the net name it drives)? One definition,
    /// shared with the delivery gate.
    fn is_power_symbol(sheet: &Sheet, s: &SymbolInst) -> bool {
        crate::gates::is_power_symbol(sheet, s)
    }

    /// The scope a `rename_net` without an explicit `scope` runs at, read off the labels that
    /// carry the name today: one kind in the project is unambiguous, a mix is not (renaming a
    /// local label and a same-named global label are different edits with different reach).
    fn resolve_rename_scope(&self, old: &str) -> Result<Scope, ApplyError> {
        let mut kinds: std::collections::BTreeSet<&'static str> = std::collections::BTreeSet::new();
        let mut pin_only = false;
        for sheet in self.sheets.values() {
            for l in &sheet.labels {
                if l.text == old {
                    kinds.insert(match l.kind {
                        LabelKind::Local => "local",
                        LabelKind::Global => "global",
                        LabelKind::Hierarchical => "hierarchical",
                    });
                }
            }
            // A power port drives a global net: its value is a global name.
            for s in &sheet.symbols {
                if s.value == old && Self::is_power_symbol(sheet, s) {
                    kinds.insert("global");
                }
            }
            if sheet
                .sheets
                .iter()
                .any(|sh| sh.pins.iter().any(|p| p.name == old))
            {
                pin_only = true;
            }
        }
        let mut it = kinds.iter();
        match (it.next(), it.next()) {
            (None, _) if pin_only => Ok(Scope::Hierarchical),
            (None, _) => Err(e(
                "NET_NOT_FOUND",
                format!("no label or power port named {old}"),
            )),
            (Some(&"local"), None) => Ok(Scope::Local),
            (Some(&"global"), None) => Ok(Scope::Global),
            (Some(_), None) => Ok(Scope::Hierarchical),
            _ => {
                let sheets: Vec<String> = self
                    .sheets
                    .iter()
                    .filter(|(_, s)| s.labels.iter().any(|l| l.text == old))
                    .map(|(f, _)| file_label(f))
                    .collect();
                Err(Self::rename_scope_ambiguous(
                    old,
                    format!(
                        "{old} is used as a {} label: the reach of the rename is ambiguous",
                        kinds.iter().copied().collect::<Vec<_>>().join(" and as a ")
                    ),
                    "pass `scope`: \"local\" renames it on the op's own sheet only, \"global\" everywhere, \"hierarchical\" the sheet's label plus the parent's sheet pin".into(),
                    &sheets,
                ))
            }
        }
    }

    /// The files (and what to rewrite in each) one `rename_net` reaches. `sheet_named` says
    /// whether the op carried a `sheet` (so `file` is the model's choice, not the default target).
    fn rename_plan(
        &self,
        file: &Path,
        old: &str,
        scope: Option<Scope>,
        sheet_named: bool,
    ) -> Result<(Scope, Vec<(PathBuf, RenameJob)>), ApplyError> {
        let effective = match scope {
            Some(s) => s,
            None => self.resolve_rename_scope(old)?,
        };
        let jobs = match effective {
            // A global name is one net across the whole project: every file that spells it.
            Scope::Global => self
                .docs
                .keys()
                .map(|f| (f.clone(), RenameJob::Labels(Scope::Global)))
                .collect(),
            // A local name belongs to this sheet alone.
            Scope::Local => {
                if !self
                    .sheet(file)?
                    .labels
                    .iter()
                    .any(|l| l.text == old && l.kind == LabelKind::Local)
                {
                    // The op landed on the default target, which does not carry the name, while
                    // several other sheets do: each of those is a separate net, so the op has to
                    // say which one it means (one other sheet is `NET_NOT_FOUND` naming it).
                    if !sheet_named {
                        let sheets = self.local_label_sheets(old);
                        if sheets.len() > 1 {
                            return Err(Self::rename_scope_ambiguous(
                                old,
                                format!(
                                    "{old} is a local label on {} sheets ({}) and not on {}; local labels are separate nets, so this is {} different renames",
                                    sheets.len(),
                                    sheets.join(", "),
                                    file_label(file),
                                    sheets.len()
                                ),
                                format!(
                                    "set `sheet` on the op to the sheet whose {old} you mean (one of: {}), declared in the op-list `sheets` map; repeat the op per sheet to rename more than one",
                                    sheets.join(", ")
                                ),
                                &sheets,
                            ));
                        }
                    }
                    return Err(self.rename_not_here(file, old, "local"));
                }
                vec![(file.to_path_buf(), RenameJob::Labels(Scope::Local))]
            }
            // A hierarchical name is the child's label and the parent's sheet pin, which must keep
            // matching (`SHEET_PIN_UNMATCHED`); the op may be routed to either side.
            Scope::Hierarchical => {
                let sheet = self.sheet(file)?;
                let mut jobs = Vec::new();
                if sheet
                    .labels
                    .iter()
                    .any(|l| l.text == old && l.kind == LabelKind::Hierarchical)
                {
                    jobs.push((file.to_path_buf(), RenameJob::Labels(Scope::Hierarchical)));
                    for (parent, ps) in &self.sheets {
                        if ps.sheets.iter().any(|sh| {
                            self.child_path(parent, sh) == file
                                && sh.pins.iter().any(|p| p.name == old)
                        }) {
                            jobs.push((parent.clone(), RenameJob::SheetPins(file.to_path_buf())));
                        }
                    }
                } else {
                    let children: std::collections::BTreeSet<PathBuf> = sheet
                        .sheets
                        .iter()
                        .filter(|sh| sh.pins.iter().any(|p| p.name == old))
                        .map(|sh| self.child_path(file, sh))
                        .collect();
                    if children.is_empty() {
                        return Err(self.rename_not_here(file, old, "hierarchical"));
                    }
                    for c in children {
                        jobs.push((file.to_path_buf(), RenameJob::SheetPins(c.clone())));
                        if self.docs.contains_key(&c) {
                            jobs.push((c, RenameJob::Labels(Scope::Hierarchical)));
                        }
                    }
                }
                jobs
            }
        };
        Ok((effective, jobs))
    }

    /// The name exists in the project, but not on the sheet the op was routed to.
    fn rename_not_here(&self, file: &Path, old: &str, word: &str) -> ApplyError {
        let others: Vec<String> = self
            .sheets
            .iter()
            .filter(|(f, s)| f.as_path() != file && s.labels.iter().any(|l| l.text == old))
            .map(|(f, _)| file_label(f))
            .collect();
        ApplyError::Op {
            code: "NET_NOT_FOUND".into(),
            message: format!("no {word} label named {old} on {}", file_label(file)),
            remediation: Some(if others.is_empty() {
                "check the name with sch.nets".into()
            } else {
                format!(
                    "it is on {}; route the op there with `sheet`, or pass an explicit `scope`",
                    others.join(", ")
                )
            }),
            evidence: None,
        }
    }

    /// The sheets (file labels) on which `old` is drawn as a local label. Each is a separate net
    /// (eeschema dialect: a local label never merges across sheets), so each is a separate rename.
    fn local_label_sheets(&self, old: &str) -> Vec<String> {
        self.sheets
            .iter()
            .filter(|(_, s)| {
                s.labels
                    .iter()
                    .any(|l| l.text == old && l.kind == LabelKind::Local)
            })
            .map(|(f, _)| file_label(f))
            .collect()
    }

    /// A `rename_net` whose reach cannot be read off the op: the model is told what would
    /// disambiguate it. `sheets` is where the name is drawn; `evidence` carries the same list.
    fn rename_scope_ambiguous(
        old: &str,
        message: String,
        remediation: String,
        sheets: &[String],
    ) -> ApplyError {
        ApplyError::Op {
            code: "RENAME_SCOPE_AMBIGUOUS".into(),
            message,
            remediation: Some(remediation),
            evidence: Some(serde_json::json!({ "name": old, "sheets": sheets })),
        }
    }

    /// Rewrite the labels of one kind in one file (plus the power-port values when the kind is
    /// global: a power port's Value is the global net it drives).
    fn rename_labels_in_file(
        &mut self,
        file: &Path,
        old: &str,
        new: &str,
        kind: &Scope,
    ) -> Result<usize, ApplyError> {
        let sheet = self.sheet(file)?.clone();
        let want = match kind {
            Scope::Local => LabelKind::Local,
            Scope::Global => LabelKind::Global,
            Scope::Hierarchical => LabelKind::Hierarchical,
        };
        let mut count = 0;
        for l in &sheet.labels {
            if l.text == old && l.kind == want {
                let new_s = new.to_string();
                self.with_node(file, &l.uuid, |n| {
                    if let Some(Node::Atom(a)) = n.children.get_mut(1) {
                        *a = kicad_sexpr::Atom::quoted(&new_s);
                    }
                })?;
                count += 1;
            }
        }
        if *kind == Scope::Global {
            for s in &sheet.symbols {
                if s.value == old && Self::is_power_symbol(&sheet, s) {
                    self.set_property(file, &s.uuid, "Value", new)?;
                    count += 1;
                }
            }
        }
        if count > 0 {
            self.refresh(file)?;
        }
        Ok(count)
    }

    /// Rewrite the pins named `old` of the sheet symbols in `file` that point at `child`
    /// (sheet pins live inside the sheet node, not in the label list).
    fn rename_sheet_pins_in_file(
        &mut self,
        file: &Path,
        child: &Path,
        old: &str,
        new: &str,
    ) -> Result<usize, ApplyError> {
        let sheet = self.sheet(file)?.clone();
        let mut count = 0;
        for sh in &sheet.sheets {
            if self.child_path(file, sh) != child {
                continue;
            }
            for p in &sh.pins {
                if p.name != old {
                    continue;
                }
                let new_s = new.to_string();
                let pu = p.uuid.clone();
                self.with_node(file, &sh.uuid, |n| {
                    for c in n.children.iter_mut() {
                        if let Node::List(pin) = c {
                            if pin.is_named("pin")
                                && pin.find("uuid").and_then(|u| u.arg(0)).as_deref()
                                    == Some(pu.as_str())
                            {
                                if let Some(Node::Atom(a)) = pin.children.get_mut(1) {
                                    *a = kicad_sexpr::Atom::quoted(&new_s);
                                }
                            }
                        }
                    }
                })?;
                count += 1;
            }
        }
        if count > 0 {
            self.refresh(file)?;
        }
        Ok(count)
    }
}

/// One file's share of a `rename_net`.
enum RenameJob {
    /// Labels of this kind in the file (plus power-port values when the kind is global).
    Labels(Scope),
    /// Only the pins of the sheet symbols in this file that point at the given child file.
    SheetPins(PathBuf),
}

fn scope_word(s: &Scope) -> &'static str {
    match s {
        Scope::Local => "local",
        Scope::Global => "global",
        Scope::Hierarchical => "hierarchical",
    }
}

/// File name for a message (the full path is noise in a per-op warning).
pub(crate) fn file_label(p: &Path) -> String {
    p.file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.display().to_string())
}

trait TitleBlockExt {
    fn remove_all_comment(&mut self, n: &str);
}

impl TitleBlockExt for List {
    fn remove_all_comment(&mut self, n: &str) {
        let mut i = 0;
        while i < self.children.len() {
            if matches!(&self.children[i], Node::List(l) if l.is_named("comment") && l.arg(0).as_deref() == Some(n))
            {
                self.remove(i);
            } else {
                i += 1;
            }
        }
    }
}

/// GND-class rails (GND, AGND, DGND, VSS, PGND ...) point down; everything else up.
pub fn is_ground_net(net: &str) -> bool {
    sch_model::is_ground_net(net)
}

/// KiCad hides the Reference of a power symbol - `#PWR`/`#FLG` designators are annotation
/// bookkeeping, not something a drawing shows - so every power instance this engine writes
/// gets `(hide yes)` on its Reference, whichever op wrote it.
fn hide_reference(node: &mut List) {
    for c in node.children.iter_mut() {
        if let Node::List(l) = c {
            if l.is_named("property") && l.arg(0).as_deref() == Some("Reference") {
                if let Some(eff) = l.find_mut("effects") {
                    if eff.find("hide").is_none() {
                        eff.push(Node::call("hide", &["yes"]));
                    }
                }
            }
        }
    }
}

/// Box of the value text the writer puts on the body side of a power port
/// (`SymbolSpec::val_at`), for a port glyph anchored at `at`. The text is always drawn
/// horizontally - [`PortText`] cancels a quarter turn with the stored field angle - so the
/// box is measured at world angle 0 whatever the port's own rotation is.
fn port_value_box(net_name: &str, at: Pt, off: Pt) -> BBox {
    text_bbox(net_name, Pt::new(at.x + off.x, at.y + off.y), 0, 50.0, "")
}

/// Where a power port's Reference and Value texts go relative to the port anchor, and the
/// symbol-frame angle stored on them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PortText {
    val_off: Pt,
    ref_off: Pt,
    /// Stored field angle. KiCad composes it with the symbol rotation (see
    /// `sch_read::bbox::field_run_dir`), so 90 on a quarter-turned port is what keeps the
    /// text drawing horizontally - the same rule `autoplace` uses for every other symbol.
    rot: i64,
}

impl PortText {
    /// The same layout on the other side of the anchor.
    fn flipped(self) -> PortText {
        PortText {
            val_off: Pt::new(-self.val_off.x, -self.val_off.y),
            ref_off: Pt::new(-self.ref_off.x, -self.ref_off.y),
            rot: self.rot,
        }
    }
    /// World unit vector the value text sits on.
    fn side(self) -> (i64, i64) {
        (self.val_off.x.signum(), self.val_off.y.signum())
    }
}

/// Which way a power port's glyph sits from its anchor, as a world unit vector: the side its
/// value text belongs on. Stock power symbols draw their body on one side of the pin (a GND
/// bar below, a rail arrow above, a `PWR_FLAG` diamond above) and rotating the symbol carries
/// the body - and so the text - round with it. Ties (a glyph centred on its own pin) go to
/// the vertical axis, which is where the unrotated convention puts the text.
fn glyph_side(local: &BBox, port_rot: i64) -> (i64, i64) {
    let b = glyph_world_box(local, port_rot);
    let (cx, cy) = ((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2);
    if cx.abs() > cy.abs() {
        (cx.signum(), 0)
    } else {
        (0, cy.signum())
    }
}

/// A library-frame glyph box turned by `port_rot` about the port anchor, through the single
/// `transform`.
fn glyph_world_box(local: &BBox, port_rot: i64) -> BBox {
    world_box(
        local,
        Placement {
            at: Pt::new(0, 0),
            rot: Rot::from_deg(port_rot as f64).unwrap_or_default(),
            mirror: Mirror::None,
        },
    )
}

/// Text layout of a power port whose glyph is `glyph` (library frame) at `port_rot`.
///
/// A port turned a quarter turn used to keep `rot: 0` and a `+/-y` offset, which drew the net
/// name sideways across whatever the pin row held and left it standing inside the port's own
/// glyph. The angle now cancels the rotation the way `autoplace` does, and the offset follows
/// the body axis: along `y` it is the 150 mil the unrotated convention uses, along `x` it has
/// to clear the glyph plus half the text's own run, because a horizontal text 150 mil to the
/// side of the anchor would be drawn straight through it.
fn port_text_layout(
    glyph: Option<&BBox>,
    port_rot: i64,
    is_ground: bool,
    net_name: &str,
) -> PortText {
    let rot = if port_rot.rem_euclid(180) == 90 {
        90
    } else {
        0
    };
    let gap = mil_to_nm(PORT_TEXT_GAP_MIL);
    let dir = match glyph {
        Some(local) => glyph_side(local, port_rot),
        // No cached glyph to measure: the convention the stock library follows - a GND-class
        // body below the pin, every other rail above - flipped by a half turn.
        None => (
            0,
            if is_ground ^ (port_rot.rem_euclid(360) == 180) {
                1
            } else {
                -1
            },
        ),
    };
    if dir.0 == 0 {
        let d = dir.1 * gap;
        return PortText {
            val_off: Pt::new(0, d),
            ref_off: Pt::new(0, d * 2),
            rot,
        };
    }
    // Horizontal body axis: reach past the glyph, then half the drawn width of the net name,
    // snapped out to the 50 mil connection grid so the anchor stays landable.
    let reach = glyph
        .map(|local| {
            let b = glyph_world_box(local, port_rot);
            if dir.0 > 0 {
                b.max.x
            } else {
                -b.min.x
            }
        })
        .unwrap_or(0)
        .max(0);
    let half = text_bbox(net_name, Pt::new(0, 0), 0, 50.0, "").max.x.max(0);
    let g = mil_to_nm(50.0);
    let d = dir.0 * (((reach + gap + half) as f64 / g as f64).ceil() as Nm) * g;
    PortText {
        val_off: Pt::new(d, 0),
        // The Reference of a power port is hidden; it only needs a row of its own in case a
        // human unhides it.
        ref_off: Pt::new(d, -mil_to_nm(100.0)),
        rot,
    }
}

/// Box of an orthogonal wire segment. A zero-length segment has no box: nothing is drawn,
/// so it can collide with nothing.
fn segment_box(a: Pt, b: Pt) -> BBox {
    let mut bb = BBox::empty();
    if a != b {
        bb.include(a);
        bb.include(b);
    }
    bb
}

/// What a power-port placement search must keep clear of, gathered once for the region the
/// search sweeps (see [`Workset::port_obstacles`]).
#[derive(Default)]
struct PortObstacles {
    /// Property texts and label flags the port has to stay readable beside.
    texts: Vec<BBox>,
    /// Foreign symbol bodies the port may not sit on.
    bodies: Vec<BBox>,
    /// Connection points (pins, wire ends, junctions, labels) a stub may not touch.
    busy: Vec<Pt>,
}

impl PortObstacles {
    /// Same shrinks as `gates::overlap`: 10 mil for a box against a body, 5 mil for text
    /// against text, so touching boxes are not a collision.
    const BODY_SHRINK_MIL: f64 = 10.0;
    const TEXT_SHRINK_MIL: f64 = 5.0;

    /// True when a port whose glyph is `glyph` and whose own value text is `value`, reached
    /// by the stub wire `stub` (one segment for a straight run, two for an L), touches
    /// nothing. The stub is tested against bodies only: a wire may pass under a property text
    /// (drawings do that all the time) but a wire drawn straight through a symbol is wrong,
    /// and that is what let a `PWR_FLAG` step "past" the rail port sharing its pin instead of
    /// finding somewhere its text fits.
    ///
    /// The port's own value text is held to more than non-overlap: it is grown by
    /// [`PORT_TEXT_READ_GAP_MIL`] along the axis it runs on, so a neighbour's text that only
    /// abuts is still a collision. Two texts on one row with no gap between them read as one
    /// string whether or not their boxes touch.
    fn clear(&self, glyph: &BBox, value: &BBox, stub: &[BBox]) -> bool {
        let body = -mil_to_nm(Self::BODY_SHRINK_MIL);
        let text = -mil_to_nm(Self::TEXT_SHRINK_MIL);
        let read = mil_to_nm(PORT_TEXT_READ_GAP_MIL);
        let g = glyph.expand(body);
        // The value text always draws horizontally (see [`PortText`]), so its run is +X.
        let v = BBox {
            min: Pt::new(value.min.x - read, value.min.y - text),
            max: Pt::new(value.max.x + read, value.max.y + text),
        };
        !self
            .texts
            .iter()
            .any(|t| t.intersects(&g) || t.expand(text).intersects(&v))
            && !self
                .bodies
                .iter()
                .any(|b| b.expand(body).intersects(&g) || stub.iter().any(|seg| b.intersects(seg)))
    }

    /// True when a connection point other than `from` sits on the segment `from` -> `to`,
    /// its far end included: ending there merges two nets (or stacks two ports) and stepping
    /// past it draws a wire across a foreign pin, so a search stops at the first such
    /// candidate instead of walking on. `from` itself is exempt - that is the node the port
    /// is meant to drive.
    fn blocked(&self, from: Pt, to: Pt) -> bool {
        let (dx, dy) = ((to.x - from.x).signum(), (to.y - from.y).signum());
        if dx == 0 && dy == 0 {
            return false;
        }
        self.busy.iter().any(|q| {
            *q != from
                && if dx != 0 {
                    q.y == from.y
                        && (q.x - from.x).signum() == dx
                        && (q.x - from.x).abs() <= (to.x - from.x).abs()
                } else {
                    q.x == from.x
                        && (q.y - from.y).signum() == dy
                        && (q.y - from.y).abs() <= (to.y - from.y).abs()
                }
        })
    }
}

/// World direction unit vector for a label-style rotation (0 right, 90 up, 180 left, 270 down; +Y down).
fn away_unit(rot: i64) -> (i64, i64) {
    match rot.rem_euclid(360) {
        0 => (1, 0),
        90 => (0, -1),
        180 => (-1, 0),
        _ => (0, 1),
    }
}

/// Drawing-convention default package for a generic passive without a footprint: 0603 resistors, 0603
/// capacitors up to 1 uF and 0805 above, 0603 LEDs / inductors. Anything else stays empty (a real part
/// needs a deliberate choice).
pub fn default_footprint(lib_id: &str, value: &str) -> Option<&'static str> {
    match lib_id {
        "Device:R" | "Device:R_Small" | "Device:R_US" => Some("Resistor_SMD:R_0603_1608Metric"),
        "Device:C" | "Device:C_Small" => {
            let farads = parse_si(value, 'F');
            match farads {
                Some(f) if f > 1.0e-6 => Some("Capacitor_SMD:C_0805_2012Metric"),
                _ => Some("Capacitor_SMD:C_0603_1608Metric"),
            }
        }
        "Device:C_Polarized" | "Device:C_Polarized_Small" => Some("Capacitor_SMD:CP_Elec_4x5.4"),
        "Device:LED" | "Device:LED_Small" => Some("LED_SMD:LED_0603_1608Metric"),
        "Device:L" | "Device:L_Small" => Some("Inductor_SMD:L_0603_1608Metric"),
        _ => None,
    }
}

/// `100n`, `4.7uF`, `22u`, `4k7`, `1k5`, `2R2` -> base units (the trailing unit letter is optional).
pub fn parse_si(value: &str, unit: char) -> Option<f64> {
    let v = value
        .trim()
        .trim_end_matches(unit)
        .trim_end_matches(unit.to_ascii_lowercase());
    let v = v.trim();
    let idx = v
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(v.len());
    let num: f64 = v[..idx].parse().ok()?;
    let rest = v[idx..].trim();
    let mult = |c: char| -> Option<f64> {
        Some(match c {
            'p' => 1e-12,
            'n' => 1e-9,
            'u' | 'µ' | 'μ' => 1e-6,
            'm' => 1e-3,
            'k' | 'K' => 1e3,
            'M' => 1e6,
            'R' | 'r' => 1.0,
            _ => return None,
        })
    };
    if rest.is_empty() {
        return Some(num);
    }
    let mut chars = rest.chars();
    let c = chars.next()?;
    let m = mult(c)?;
    let frac = chars.as_str();
    if !frac.is_empty() && frac.chars().all(|d| d.is_ascii_digit()) {
        // R-notation: 4k7 = 4.7k
        let f: f64 = format!("0.{frac}").parse().ok()?;
        return Some((num + f) * m);
    }
    if frac.is_empty() {
        return Some(num * m);
    }
    None
}

/// How a power port stands off the pin it is anchored on: a run of `elbow_mil` along the
/// pin, then a leg of `leg_mil` along `leg_rot`, with `port_rot` written on the symbol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortPose {
    /// Run along the pin's own direction before the leg starts, in mil.
    pub elbow_mil: i64,
    /// Direction of the leg, in the same convention as the pin's away rotation.
    pub leg_rot: i64,
    /// Length of the leg, in mil.
    pub leg_mil: i64,
    /// Rotation written on the port symbol.
    pub port_rot: i64,
}

impl PortPose {
    /// A port that stands on the pin itself, or straight along it once the stub search has
    /// had its say.
    pub fn straight(away_rot: i64, port_rot: i64) -> PortPose {
        PortPose {
            elbow_mil: 0,
            leg_rot: away_rot,
            leg_mil: 0,
            port_rot,
        }
    }
}
/// Pose of a power port anchored on a pin whose away direction is `away_rot`
/// (0 right, 90 up, 180 left, 270 down). A GND-class port always ends up pointing down and
/// other rails up. A pin pointing the "wrong" vertical way flips the port (rot 180) instead
/// of growing a stub. A sideways pin gets an L - [`PORT_ELBOW_MIL`] out of the pin, then the
/// same again down (ground) or up (rail) - so the port stands vertical the way a drafter
/// draws it; hanging it straight off a sideways pin put it in the pin's own row, where on a
/// connector its value text collides with the neighbouring pins' labels.
pub fn power_port_pose(is_ground: bool, away_rot: i64) -> PortPose {
    let a = away_rot.rem_euclid(360);
    match (is_ground, a) {
        (true, 270) => PortPose::straight(a, 0),
        (true, 90) => PortPose::straight(a, 180),
        (false, 90) => PortPose::straight(a, 0),
        (false, 270) => PortPose::straight(a, 180),
        _ => PortPose {
            elbow_mil: PORT_ELBOW_MIL,
            leg_rot: if is_ground { 270 } else { 90 },
            leg_mil: PORT_ELBOW_MIL,
            port_rot: 0,
        },
    }
}

/// PWR_FLAG follows the pin: its body points along the away direction.
/// KiCad power symbols draw the body "up" at rot 0; rotations go counter-clockwise.
fn flag_rotation(away_rot: i64) -> i64 {
    match away_rot.rem_euclid(360) {
        90 => 0,
        180 => 90,
        270 => 180,
        _ => 270,
    }
}

/// Library pin angle -> unit vector pointing away from the body (lib frame).
fn away_vec(angle: i64) -> (i64, i64) {
    match (angle + 180).rem_euclid(360) {
        0 => (1, 0),
        90 => (0, 1),
        180 => (-1, 0),
        _ => (0, -1),
    }
}

/// Sort key that orders R2 before R10.
fn natural_key(s: &str) -> (String, u64) {
    let idx = s.find(|c: char| c.is_ascii_digit()).unwrap_or(s.len());
    let num: u64 = s[idx..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0);
    (s[..idx].to_string(), num)
}

fn shift_at(l: &mut List, delta: Pt) {
    if let Some(a) = l.find_mut("at") {
        let x = a.arg(0).and_then(|s| mm_str_to_nm(&s)).unwrap_or(0) + delta.x;
        let y = a.arg(1).and_then(|s| mm_str_to_nm(&s)).unwrap_or(0) + delta.y;
        let rot = a.arg(2);
        let mut ch = vec![
            Node::bare("at"),
            Node::atom(&nm_to_mm_str(x)),
            Node::atom(&nm_to_mm_str(y)),
        ];
        if let Some(r) = rot {
            ch.push(Node::atom(&r));
        }
        *a = List::compact(ch);
    }
}

/// Orthogonal routing between two points.
pub fn route(a: Pt, b: Pt, style: &str) -> Vec<Pt> {
    if a.x == b.x || a.y == b.y {
        return vec![a, b];
    }
    match style {
        "vh" => vec![a, Pt::new(a.x, b.y), b],
        "z" => {
            let mx = (a.x + b.x) / 2;
            vec![a, Pt::new(mx, a.y), Pt::new(mx, b.y), b]
        }
        // "hv" and "auto"
        _ => vec![a, Pt::new(b.x, a.y), b],
    }
}

/// The 50 mil connection grid the jog of a Z route lands on, so the corner stays landable.
const ROUTE_GRID_MIL: f64 = 50.0;
/// How many jog lines either side of the middle a Z route tries before it gives up: 32 lines is
/// 1600 mil, wider than any block a drafter is given a region for.
const ROUTE_JOG_MAX: usize = 32;

/// Is `q` on the axis-aligned segment `a` -> `b`, both ends included?
fn on_segment(a: Pt, b: Pt, q: Pt) -> bool {
    if a.x == b.x {
        q.x == a.x && q.y >= a.y.min(b.y) && q.y <= a.y.max(b.y)
    } else if a.y == b.y {
        q.y == a.y && q.x >= a.x.min(b.x) && q.x <= a.x.max(b.x)
    } else {
        false
    }
}

/// The obstacles lying on `path`, corners and ends included, in path order.
fn path_hits(path: &[Pt], obstacles: &[Pt]) -> Vec<Pt> {
    let mut hits: Vec<Pt> = Vec::new();
    for w in path.windows(2) {
        for q in obstacles {
            if on_segment(w[0], w[1], *q) && !hits.contains(q) {
                hits.push(*q);
            }
        }
    }
    hits
}

/// Jog lines on the 50 mil grid strictly between `lo` and `hi`, nearest the middle first.
fn jog_lines(lo: Nm, hi: Nm) -> Vec<Nm> {
    let (lo, hi) = (lo.min(hi), lo.max(hi));
    let grid = mil_to_nm(ROUTE_GRID_MIL);
    let mid = (lo + hi) / 2;
    let mut out: Vec<Nm> = Vec::new();
    let mut k = (lo / grid) * grid;
    while k <= hi {
        if k > lo && k < hi {
            out.push(k);
        }
        k += grid;
    }
    out.sort_by_key(|x| ((x - mid).abs(), *x));
    out.truncate(ROUTE_JOG_MAX);
    out
}

/// The path [`route`] draws, moved off foreign connection points when another shape is clear.
///
/// `route` is obstacle-free geometry: "auto" turns its corner at `(b.x, a.y)`, and in run 20 that
/// corner landed exactly on J1.3's tip while the leg ran on up J1's pin column - three of the
/// connector's pins joined the rail that way, one of them under a no-connect, and nothing in the
/// write path said so. The alternatives tried here are the ones a person draws: the other leg
/// order, then a Z with its jog on a free 50 mil grid line, nearest the middle first. The answer is
/// the path plus whatever obstacles are still on it; when that list is not empty the caller draws
/// the route anyway and warns, because a wire the model asked for is never silently dropped.
pub fn route_clear(a: Pt, b: Pt, style: &str, obstacles: &[Pt]) -> (Vec<Pt>, Vec<Pt>) {
    let first = route(a, b, style);
    let hits = path_hits(&first, obstacles);
    if hits.is_empty() {
        return (first, hits);
    }
    for cand in route_alternatives(a, b, &first) {
        if path_hits(&cand, obstacles).is_empty() {
            return (cand, Vec::new());
        }
    }
    (first, hits)
}

/// Other shapes for the same two ends, in the order they are tried: the two leg orders (minus the
/// one already drawn), then the Z jogs. A straight run has no other shape.
fn route_alternatives(a: Pt, b: Pt, drawn: &[Pt]) -> Vec<Vec<Pt>> {
    if a.x == b.x || a.y == b.y {
        return Vec::new();
    }
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for style in ["hv", "vh"] {
        let p = route(a, b, style);
        if p != drawn {
            out.push(p);
        }
    }
    for jx in jog_lines(a.x, b.x) {
        out.push(vec![a, Pt::new(jx, a.y), Pt::new(jx, b.y), b]);
    }
    for jy in jog_lines(a.y, b.y) {
        out.push(vec![a, Pt::new(a.x, jy), Pt::new(b.x, jy), b]);
    }
    out
}

/// Pin position and label rotation on a sheet symbol edge.
pub fn sheet_pin_position(at: Pt, size: Pt, side: &str, offset: Nm) -> (Pt, i64) {
    match side {
        "right" => (Pt::new(at.x + size.x, at.y + offset), 0),
        "top" => (Pt::new(at.x + offset, at.y), 90),
        "bottom" => (Pt::new(at.x + offset, at.y + size.y), 270),
        _ => (Pt::new(at.x, at.y + offset), 180),
    }
}

/// Lay the pins of one `add_sheet` out on the symbol's edges: 100 mil pitch, the run of pins
/// on each side centred on that edge rather than stacked under its top-left corner, and every
/// offset snapped to the 50 mil connection grid so the pins are landable (eeschema
/// `endpoint_off_grid`). An authored `offset_mil` always wins.
fn layout_sheet_pins(at: Pt, size: Pt, pins: &[sch_ops::SheetPinSpec]) -> Vec<(Pt, i64)> {
    let pitch = mil_to_nm(100.0);
    let grid = mil_to_nm(50.0);
    let mut per_side: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (i, p) in pins.iter().enumerate() {
        per_side.entry(p.side.as_str()).or_default().push(i);
    }
    let mut out = vec![(Pt::new(0, 0), 0i64); pins.len()];
    for (side, idx) in per_side {
        // The edge the run sits on: top/bottom run along the width, left/right along the height.
        let span = if side == "top" || side == "bottom" {
            size.x
        } else {
            size.y
        };
        let n = idx.len() as Nm;
        // Centre the run, then snap onto the grid and keep one full pitch clear of the corner.
        let first = ((span - (n - 1) * pitch) / 2 / grid) * grid;
        let first = first.max(pitch);
        for (k, i) in idx.into_iter().enumerate() {
            let off = pins[i].offset.unwrap_or(first + k as Nm * pitch);
            out[i] = sheet_pin_position(at, size, side, off);
        }
    }
    out
}

#[cfg(test)]
mod pose_tests {
    use super::*;

    /// The route search: the "auto" corner first, the other leg order when that corner or leg lands
    /// on a foreign pin, a Z on a free grid line when neither does, and - when nothing is clear -
    /// the authored path plus the list of what it runs across, so the caller can warn rather than
    /// drop the wire.
    #[test]
    fn route_clear_steps_off_a_pin_and_says_so_when_it_cannot() {
        let mil = |x: f64, y: f64| Pt::new(mil_to_nm(x), mil_to_nm(y));
        // The run 20 shape: the "auto" corner is clear but the leg runs up a pin column.
        let a = mil(900.0, 2200.0);
        let b = mil(1200.0, 2600.0);
        let column = [
            mil(1200.0, 2300.0),
            mil(1200.0, 2400.0),
            mil(1200.0, 2500.0),
        ];
        let (path, blocked) = route_clear(a, b, "auto", &column);
        assert!(blocked.is_empty(), "{blocked:?}");
        assert_eq!(path, vec![a, mil(900.0, 2600.0), b], "the other leg order");
        // Both leg orders blocked, so the jog moves onto a free grid line between them.
        let corners = [mil(1200.0, 2200.0), mil(900.0, 2600.0)];
        let (path, blocked) = route_clear(a, b, "auto", &corners);
        assert!(blocked.is_empty(), "{blocked:?}");
        assert_eq!(path.len(), 4, "a Z: {path:?}");
        assert_eq!(path[1].x % mil_to_nm(50.0), 0, "the jog is on the grid");
        // Two ends 10 nm apart have no grid line between them and no third shape: the wire is drawn
        // as authored and the obstacles on it are handed back.
        let (a, b) = (Pt::new(0, 0), Pt::new(10, 10));
        let both = [Pt::new(10, 0), Pt::new(0, 10)];
        let (path, blocked) = route_clear(a, b, "auto", &both);
        assert_eq!(path, route(a, b, "auto"));
        assert_eq!(blocked, vec![Pt::new(10, 0)]);
    }

    #[test]
    fn footprint_defaults_follow_the_drawing_convention() {
        let close = |a: Option<f64>, b: f64| a.map(|x| ((x - b) / b).abs() < 1e-9).unwrap_or(false);
        assert!(close(parse_si("100n", 'F'), 1.0e-7));
        assert!(close(parse_si("4.7uF", 'F'), 4.7e-6));
        assert!(close(parse_si("22u", 'F'), 2.2e-5));
        assert!(close(parse_si("4k7", 'F'), 4700.0));
        assert!(close(parse_si("2R2", 'F'), 2.2));
        assert_eq!(parse_si("green", 'F'), None);
        assert_eq!(
            default_footprint("Device:R", "1k"),
            Some("Resistor_SMD:R_0603_1608Metric")
        );
        assert_eq!(
            default_footprint("Device:C", "100n"),
            Some("Capacitor_SMD:C_0603_1608Metric")
        );
        assert_eq!(
            default_footprint("Device:C", "22uF"),
            Some("Capacitor_SMD:C_0805_2012Metric")
        );
        assert_eq!(
            default_footprint("Device:LED", "GREEN"),
            Some("LED_SMD:LED_0603_1608Metric")
        );
        assert_eq!(default_footprint("Regulator_Linear:AMS1117-3.3", "x"), None);
    }

    #[test]
    fn ground_points_down_and_drops_off_a_sideways_pin() {
        assert_eq!(power_port_pose(true, 270), PortPose::straight(270, 0));
        assert_eq!(power_port_pose(true, 90), PortPose::straight(90, 180));
        // A sideways pin turns the corner: out along the pin, then down.
        let l = PortPose {
            elbow_mil: PORT_ELBOW_MIL,
            leg_rot: 270,
            leg_mil: PORT_ELBOW_MIL,
            port_rot: 0,
        };
        assert_eq!(power_port_pose(true, 0), l);
        assert_eq!(power_port_pose(true, 180), l);
    }

    #[test]
    fn rails_point_up() {
        assert_eq!(power_port_pose(false, 90), PortPose::straight(90, 0));
        assert_eq!(power_port_pose(false, 270), PortPose::straight(270, 180));
        // Same corner as a ground, but the leg rises instead of dropping.
        assert_eq!(
            power_port_pose(false, 0),
            PortPose {
                elbow_mil: PORT_ELBOW_MIL,
                leg_rot: 90,
                leg_mil: PORT_ELBOW_MIL,
                port_rot: 0,
            }
        );
    }

    #[test]
    fn ground_classes() {
        assert!(is_ground_net("GND"));
        assert!(is_ground_net("AGND"));
        assert!(is_ground_net("VSS"));
        assert!(!is_ground_net("+3V3"));
        assert!(!is_ground_net("VBUS"));
    }
}
