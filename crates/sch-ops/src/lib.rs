// SPDX-License-Identifier: Apache-2.0
//! fluxsmith opspec v1: the op-list vocabulary, validation and macro expansion.
//!
//! Human-readable version: docs/opspec-v1.md. This file is the single source
//! of truth (`protocol_version` 1). Coordinates in op-lists are mils; the
//! expanded form is integer nm in world space (group origins applied).

use sch_model::{mil_to_nm, Nm, Pt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

pub const PROTOCOL_VERSION: u32 = 1;

/// Pitch `place_array` clamps to when its elements carry per-pin labels or power ports and the
/// array marches along the pin axis: a 2-pin passive is 300 mil tip to tip, a power port plus its
/// value text adds ~250 mil below the lower pin and a label ~100 mil above the upper one.
const WIRED_ARRAY_PITCH_MIL: f64 = 700.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpError {
    pub index: usize,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    /// Structured detail the harness can act on (`RENAME_SCOPE_AMBIGUOUS` carries
    /// `{name, sheets}`); most refusals have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
}

fn err(index: usize, code: &str, msg: impl Into<String>) -> OpError {
    OpError {
        index,
        code: code.to_string(),
        message: msg.into(),
        remediation: None,
        evidence: None,
    }
}

impl OpError {
    /// Attach the one line that tells the caller what to do instead.
    pub fn with_remediation(mut self, r: impl Into<String>) -> Self {
        self.remediation = Some(r.into());
        self
    }
}

/// A non-fatal finding of the op-list parser. Same shape as [`OpError`], but the op-list is
/// still expanded: the model is told what was ignored instead of being left to wonder why a
/// field it wrote had no effect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpWarning {
    pub index: usize,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}

/// Fields the envelope defines for every op; never an unknown field.
const COMMON_FIELDS: &[&str] = &[
    "op", "group", "sheet", "in_sheet", "note", "exact", "no_nudge",
];

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Group {
    pub origin_mil: [f64; 2],
    /// Optional world-space region `[[x0,y0],[x1,y1]]` (mil). Placement nudges
    /// and `arrange_group` stay inside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_mil: Option<[[f64; 2]; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpList {
    pub protocol_version: u32,
    #[serde(default = "default_target_format")]
    pub target_format: String,
    #[serde(default)]
    pub groups: BTreeMap<String, Group>,
    #[serde(default)]
    pub sheets: BTreeMap<String, String>,
    pub ops: Vec<Value>,
}

fn default_target_format() -> String {
    "kicad".to_string()
}

impl OpList {
    pub fn from_json(src: &str) -> Result<OpList, OpError> {
        let mut de = serde_json::Deserializer::from_str(src);
        serde_path_to_error::deserialize::<_, OpList>(&mut de).map_err(|e| {
            err(
                0,
                "OPLIST_SCHEMA",
                format!("invalid op-list at `{}`: {}", e.path(), e.inner()),
            )
        })
    }

    /// Same as `from_json` for an already-parsed JSON value; errors name the
    /// exact field (`ops[3].x_mil`) so a model can fix its own output.
    pub fn from_value(v: serde_json::Value) -> Result<OpList, OpError> {
        serde_path_to_error::deserialize::<_, OpList>(v).map_err(|e| {
            err(
                0,
                "OPLIST_SCHEMA",
                format!("invalid op-list at `{}`: {}", e.path(), e.inner()),
            )
        })
    }
}

// ---------------------------------------------------------------------------
// Typed ops (expanded, world-space nm)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Endpoint {
    /// `REF.PIN` optionally with `#uN` unit suffix on the reference.
    Pin {
        reference: String,
        unit: Option<u32>,
        pin: String,
    },
    Point(Pt),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Anchor {
    Endpoint(Endpoint),
    Mid(Endpoint, Endpoint),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scope {
    Local,
    Global,
    Hierarchical,
}

impl Scope {
    fn parse(s: &str) -> Option<Scope> {
        match s {
            "local" => Some(Scope::Local),
            "global" => Some(Scope::Global),
            "hierarchical" => Some(Scope::Hierarchical),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchSpec {
    pub kind: String,
    pub at: Option<Pt>,
    pub name: Option<String>,
    pub between: Option<(Pt, Pt)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SheetPinSpec {
    pub name: String,
    pub kind: String,
    pub side: String,
    pub offset: Option<Nm>,
}

/// How far (mil) below the anchored pin `place_decoupling near:` puts the capacitor. One
/// 300 mil hop: clear of the pin's own stub and of the part's texts, and well inside the
/// 500 mil the `DECAP_FAR` check allows even after the writer nudges it to a free slot.
const DECAP_NEAR_OFFSET_MIL: f64 = 300.0;

/// Clearance (mil) kept between the outermost sheet pin and a corner of the symbol.
const SHEET_PIN_MARGIN_MIL: f64 = 200.0;
/// Smallest sheet symbol the default draws: enough for a readable name and file line.
const SHEET_MIN_MIL: (f64, f64) = (1600.0, 800.0);

/// Size of the sheet symbol `add_sheet` draws when the author gave no `size`: tall enough for
/// the pins on its busiest vertical edge at KiCad's 100 mil pitch with a margin above and
/// below, wide enough for the pins on a horizontal edge. A scaffold whose height does not
/// follow its pin count either crowds the pins into a corner or leaves an empty box.
pub fn default_sheet_size(pins: &[SheetPinSpec]) -> Pt {
    let count = |f: &dyn Fn(&str) -> bool| pins.iter().filter(|p| f(&p.side)).count() as f64;
    let vertical = count(&|s| s != "top" && s != "bottom").max(1.0);
    let horizontal = count(&|s| s == "top" || s == "bottom").max(1.0);
    Pt::new(
        mil_to_nm((SHEET_PIN_MARGIN_MIL * 2.0 + horizontal * 100.0).max(SHEET_MIN_MIL.0)),
        mil_to_nm((SHEET_PIN_MARGIN_MIL * 2.0 + vertical * 100.0).max(SHEET_MIN_MIL.1)),
    )
}

/// Placement target for a component: absolute point or relative to a pin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Place {
    At(Pt),
    Relative {
        anchor: Endpoint,
        offset: Pt,
    },
    /// `distance` beyond a pin, on the axis that pin points away from its own symbol body
    /// (`place_decoupling near:`). Unlike [`Place::Relative`] the direction is not authored:
    /// the writer reads it off the geometry, so a cap anchored to a pin on the left edge of an
    /// IC lands to its left and one on the bottom edge lands below it, whatever the part's
    /// rotation. Authoring a fixed offset instead put the cap inside the IC half the time.
    NearPin {
        anchor: Endpoint,
        distance: Nm,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Op {
    PlaceComponent {
        lib_id: String,
        designator: String,
        place: Place,
        rotation: i64,
        mirror: String,
        unit: u32,
        value: Option<String>,
        footprint: Option<String>,
        symbol_source: Option<String>,
        instance_designators: Option<BTreeMap<String, String>>,
    },
    DeleteComponent {
        designator: String,
        cascade: bool,
    },
    DeleteObject {
        uuid: Option<String>,
        matcher: Option<MatchSpec>,
    },
    MoveComponent {
        /// Either `designator` or `uuid` addresses the symbol.
        designator: Option<String>,
        uuid: Option<String>,
        place: Place,
        unit: Option<u32>,
        carry_labels: bool,
        carry_wires: bool,
        /// Power symbols hanging off the moved pins (directly or over a short stub wire) move too.
        carry_power: bool,
    },
    SetComponentTransform {
        designator: Option<String>,
        uuid: Option<String>,
        rotation: Option<i64>,
        mirror: Option<String>,
    },
    SetComponentParameters {
        designator: String,
        new_designator: Option<String>,
        value: Option<String>,
        footprint: Option<String>,
        parameters: BTreeMap<String, String>,
        instance_designators: Option<BTreeMap<String, String>>,
    },
    SetComponentAttributes {
        designator: String,
        dnp: Option<bool>,
        in_bom: Option<bool>,
        on_board: Option<bool>,
    },
    AddWire {
        vertices: Vec<Pt>,
    },
    RouteNet {
        from: Endpoint,
        to: Endpoint,
        style: String,
        label: Option<String>,
        scope: Scope,
    },
    AddJunction {
        at: Pt,
    },
    AddNoConnect {
        pin: Endpoint,
    },
    AddNetLabel {
        name: String,
        at: Anchor,
        scope: Scope,
        rotation: Option<i64>,
    },
    PlacePowerPort {
        lib_id: String,
        net_name: String,
        at: Anchor,
        /// `None`: derived from the pin direction (GND down, other rails up, PWR_FLAG away).
        rotation: Option<i64>,
    },
    RenameNet {
        old_name: String,
        new_name: String,
        scope: Option<Scope>,
    },
    AddBus {
        vertices: Vec<Pt>,
    },
    AddBusEntry {
        at: Pt,
        size: Pt,
    },
    AddText {
        text: String,
        at: Pt,
        angle: i64,
        key: Option<String>,
    },
    AddRectangle {
        start: Pt,
        end: Pt,
        stroke_width: Nm,
        fill: String,
        key: Option<String>,
    },
    AddTextBox {
        text: String,
        at: Pt,
        size: Pt,
        angle: i64,
        key: Option<String>,
    },
    AddSheet {
        name: String,
        file: String,
        at: Pt,
        size: Pt,
        pins: Vec<SheetPinSpec>,
        create: bool,
        /// Paper size of the child file when this op creates it (`A4` when omitted).
        /// Ignored for a child that already exists: it keeps its own page settings.
        paper: Option<String>,
    },
    AddSheetPin {
        sheet: String,
        name: String,
        kind: String,
        side: String,
        offset: Option<Nm>,
    },
    DeleteSheetPin {
        sheet: String,
        name: String,
    },
    ResizeSheet {
        sheet: String,
        size: Pt,
        at: Option<Pt>,
    },
    /// Re-lay the unwired components of a group on a grid inside a region.
    ArrangeGroup {
        group: String,
        /// World-space region in nm.
        region: (Pt, Pt),
        pitch_x: Nm,
        pitch_y: Nm,
        /// Only these designators (default: every symbol inside the region).
        designators: Option<Vec<String>>,
        only_unwired: bool,
    },
    SetTitleBlock {
        fields: BTreeMap<String, String>,
    },
}

impl Op {
    pub fn name(&self) -> &'static str {
        match self {
            Op::PlaceComponent { .. } => "place_component",
            Op::DeleteComponent { .. } => "delete_component",
            Op::DeleteObject { .. } => "delete_object",
            Op::MoveComponent { .. } => "move_component",
            Op::SetComponentTransform { .. } => "set_component_transform",
            Op::SetComponentParameters { .. } => "set_component_parameters",
            Op::SetComponentAttributes { .. } => "set_component_attributes",
            Op::AddWire { .. } => "add_wire",
            Op::RouteNet { .. } => "route_net",
            Op::AddJunction { .. } => "add_junction",
            Op::AddNoConnect { .. } => "add_no_connect",
            Op::AddNetLabel { .. } => "add_net_label",
            Op::PlacePowerPort { .. } => "place_power_port",
            Op::RenameNet { .. } => "rename_net",
            Op::AddBus { .. } => "add_bus",
            Op::AddBusEntry { .. } => "add_bus_entry",
            Op::AddText { .. } => "add_text",
            Op::AddRectangle { .. } => "add_rectangle",
            Op::AddTextBox { .. } => "add_text_box",
            Op::AddSheet { .. } => "add_sheet",
            Op::AddSheetPin { .. } => "add_sheet_pin",
            Op::DeleteSheetPin { .. } => "delete_sheet_pin",
            Op::ResizeSheet { .. } => "resize_sheet",
            Op::SetTitleBlock { .. } => "set_title_block",
            Op::ArrangeGroup { .. } => "arrange_group",
        }
    }

    /// Whether this op writes anything (all core ops do except none).
    pub fn is_structural(&self) -> bool {
        matches!(
            self,
            Op::AddSheet { .. } | Op::DeleteSheetPin { .. } | Op::ResizeSheet { .. }
        )
    }
}

/// One expanded op with provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExpandedOp {
    /// Index of the authored op this came from.
    pub authored_index: usize,
    /// Sheet key (from the envelope) or None for the target file.
    pub sheet: Option<String>,
    pub note: Option<String>,
    /// World-space region (mil) of the authored op's group, when declared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_mil: Option<[[f64; 2]; 2]>,
    /// `exact: true` on the authored op disables the placement nudge *and* the 50 mil grid snap:
    /// the position is written verbatim, so the handler reports `PLACEMENT_OFF_GRID` when the
    /// anchor or a pin lands off the connection grid.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
    /// Keep the authored position (no nudge) but still snap it to the 50 mil grid. Authorable as
    /// `no_nudge: true` on any op, and always on for macro parts: their geometry is designed (the
    /// wire between them is 100 mil) and must not be pulled apart.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_nudge: bool,
    pub op: Op,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Expanded {
    pub ops: Vec<ExpandedOp>,
    /// authored index -> expanded indices
    pub mapping: Vec<Vec<usize>>,
    /// Non-fatal findings of the parser (currently `OPLIST_UNKNOWN_FIELD`). Not part of
    /// `expanded_sha256`: it hashes `ops` only.
    #[serde(default)]
    pub warnings: Vec<OpWarning>,
}

pub const CORE_OPS: &[&str] = &[
    "place_component",
    "delete_component",
    "delete_object",
    "move_component",
    "set_component_transform",
    "set_component_parameters",
    "set_component_attributes",
    "add_wire",
    "route_net",
    "add_junction",
    "add_no_connect",
    "add_net_label",
    "place_power_port",
    "place_gnd",
    "place_vcc",
    "rename_net",
    "add_bus",
    "add_bus_entry",
    "add_text",
    "add_rectangle",
    "add_text_box",
    "add_sheet",
    "add_sheet_pin",
    "delete_sheet_pin",
    "resize_sheet",
    "set_title_block",
];
pub const MACRO_OPS: &[&str] = &[
    "place_divider",
    "place_decoupling",
    "place_pullup",
    "place_led_indicator",
    "place_rc_filter",
    "place_crystal",
    "place_array",
    "connect_and_label",
    "place_pwr_flag",
    "terminate_unused_unit",
    "arrange_group",
];

/// Op names that are not in the vocabulary and never will be, with what to do instead. Models
/// invent these from KiCad's own menus; naming the closest real op is not enough, because there
/// is none -- the action lives somewhere else entirely.
fn non_op_hint(name: &str) -> Option<&'static str> {
    Some(match name {
        "create_root_schematic" | "create_schematic" | "new_schematic" | "init_schematic" => {
            "no op creates the root schematic: the project's root .kicad_sch already exists. Write into it directly, and use `add_sheet` with `create: true` for child sheets"
        }
        "annotate" | "auto_annotate" | "renumber" | "update_references" => {
            "no op annotates: designators come from the refdes lease, so put the leased designator on `place_component` (or `set_component_parameters.new_designator` to change one)"
        }
        "run_erc" | "erc" | "run_drc" | "check_schematic" => {
            "ERC is not an op: apply the op-list first, then call the `sch.check` tool"
        }
        _ => return None,
    })
}

fn edit_distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.chars().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let sub = prev[j] + usize::from(ca != *cb);
            cur[j + 1] = sub.min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Words that mean the same thing in the vocabulary as in the names models write. Raw spellings
/// find nothing useful: `add_symbol` and `place_component` share no character run at all, yet
/// they are the same request.
fn synonym(w: &str) -> &str {
    match w {
        "add" | "create" | "new" | "insert" | "make" => "place",
        "remove" | "erase" => "delete",
        "update" | "change" | "modify" => "set",
        "symbol" | "part" | "device" => "component",
        "hier" | "hierarchical" => "sheet",
        other => other,
    }
}

/// The verbs. A shared verb says nothing (every `place_*` op shares one), so only the nouns count
/// as evidence that two names mean the same thing.
const OP_VERBS: &[&str] = &[
    "place",
    "set",
    "delete",
    "move",
    "route",
    "resize",
    "rename",
    "connect",
    "terminate",
    "arrange",
];

fn canon_op_name(name: &str) -> String {
    name.trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_")
        .split('_')
        .filter(|w| !w.is_empty())
        .map(synonym)
        .collect::<Vec<_>>()
        .join("_")
}

/// Op names closest to `name`, best first, at most three: an exact match after synonym folding,
/// then names sharing a noun, then names within a length-scaled edit distance.
pub fn nearest_ops(name: &str) -> Vec<&'static str> {
    let q = canon_op_name(name);
    if q.is_empty() {
        return Vec::new();
    }
    let nouns = |s: &str| -> Vec<String> {
        s.split('_')
            .filter(|w| w.len() >= 3 && !OP_VERBS.contains(w))
            .map(|w| w.to_string())
            .collect()
    };
    let q_nouns = nouns(&q);
    let limit = 2.max(q.len() / 3);
    let mut scored: Vec<(usize, &'static str)> = Vec::new();
    for op in CORE_OPS.iter().chain(MACRO_OPS.iter()).copied() {
        let c = canon_op_name(op);
        let d = edit_distance(&q, &c);
        if c == q {
            scored.push((d, op));
        } else if nouns(&c).iter().any(|n| q_nouns.contains(n)) {
            scored.push((10 + d, op));
        } else if d <= limit {
            scored.push((100 + d, op));
        }
    }
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(b.1)));
    scored.into_iter().take(3).map(|(_, op)| op).collect()
}

/// One line the model can act on after an unknown op name: either the action that replaces a
/// name with no op at all, or the closest real names plus where the full vocabulary lives.
pub fn unknown_op_remediation(name: &str) -> String {
    if let Some(h) = non_op_hint(&name.trim().to_ascii_lowercase()) {
        return h.to_string();
    }
    let near = nearest_ops(name);
    if near.is_empty() {
        "call ops.list for the whole op vocabulary, then ops.template for the fields of the op you pick".into()
    } else {
        format!(
            "did you mean {}? call ops.list for the whole op vocabulary and ops.template for the fields of one op",
            near.join(", ")
        )
    }
}

// ---------------------------------------------------------------------------
// Field access helpers
// ---------------------------------------------------------------------------

struct F<'a> {
    i: usize,
    v: &'a Value,
    origin: Pt,
    /// Every field name this op's branch looked at. What is left over on the authored object
    /// is a field no branch reads (`OPLIST_UNKNOWN_FIELD`); direct `self.v.get(..)` reads must
    /// call [`F::mark`] themselves.
    seen: RefCell<BTreeSet<String>>,
}

impl<'a> F<'a> {
    fn new(i: usize, v: &'a Value, origin: Pt) -> F<'a> {
        F {
            i,
            v,
            origin,
            seen: RefCell::new(BTreeSet::new()),
        }
    }
    /// Record a field name as read (see [`F::seen`]).
    fn mark(&self, k: &str) {
        self.seen.borrow_mut().insert(k.to_string());
    }
    /// Fields of the authored op that no branch read.
    fn unread(&self) -> Vec<String> {
        let seen = self.seen.borrow();
        match self.v.as_object() {
            Some(m) => m
                .keys()
                .filter(|k| !seen.contains(*k) && !COMMON_FIELDS.contains(&k.as_str()))
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }
    fn has(&self, k: &str) -> bool {
        self.mark(k);
        self.v.get(k).map(|x| !x.is_null()).unwrap_or(false)
    }
    /// A required name that must not be blank: an empty label / net / pin name is never what the author
    /// meant, and eeschema writes it as `(label "")`, a nameless net that ERC then reports.
    fn name(&self, k: &str) -> Result<String, OpError> {
        let v = self.str(k)?;
        if v.trim().is_empty() {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!("`{k}` must not be empty"),
            ));
        }
        Ok(v)
    }
    /// An optional name where an empty string means "not given".
    fn opt_name(&self, k: &str) -> Result<Option<String>, OpError> {
        Ok(self.opt_str(k)?.filter(|v| !v.trim().is_empty()))
    }
    fn str(&self, k: &str) -> Result<String, OpError> {
        self.mark(k);
        match self.v.get(k) {
            Some(Value::String(s)) => Ok(s.clone()),
            Some(Value::Null) | None => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("missing required field `{k}`"),
            )),
            _ => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("field `{k}` must be a string"),
            )),
        }
    }
    fn opt_str(&self, k: &str) -> Result<Option<String>, OpError> {
        if self.has(k) {
            self.str(k).map(Some)
        } else {
            Ok(None)
        }
    }
    fn num(&self, k: &str) -> Result<f64, OpError> {
        self.mark(k);
        match self.v.get(k) {
            Some(Value::Number(n)) => n
                .as_f64()
                .ok_or_else(|| err(self.i, "OPLIST_SCHEMA", format!("bad number `{k}`"))),
            Some(Value::String(s)) => s.parse().map_err(|_| {
                err(
                    self.i,
                    "OPLIST_SCHEMA",
                    format!("field `{k}` must be a number"),
                )
            }),
            Some(Value::Null) | None => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("missing required field `{k}`"),
            )),
            _ => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("field `{k}` must be a number"),
            )),
        }
    }
    fn opt_num(&self, k: &str) -> Result<Option<f64>, OpError> {
        if self.has(k) {
            self.num(k).map(Some)
        } else {
            Ok(None)
        }
    }
    fn opt_bool(&self, k: &str) -> Result<Option<bool>, OpError> {
        self.mark(k);
        match self.v.get(k) {
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(Value::Null) | None => Ok(None),
            _ => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("field `{k}` must be a boolean"),
            )),
        }
    }
    fn bool_or(&self, k: &str, d: bool) -> Result<bool, OpError> {
        Ok(self.opt_bool(k)?.unwrap_or(d))
    }
    fn opt_rotation(&self, k: &str) -> Result<Option<i64>, OpError> {
        if self.has(k) {
            Ok(Some(self.rotation(k, 0)?))
        } else {
            Ok(None)
        }
    }
    fn rotation(&self, k: &str, d: i64) -> Result<i64, OpError> {
        let Some(r) = self.opt_num(k)? else {
            return Ok(d);
        };
        let r = r.round() as i64;
        if ![0, 90, 180, 270].contains(&r) {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!("`{k}` must be 0/90/180/270, got {r}"),
            ));
        }
        Ok(r)
    }
    fn mirror(&self) -> Result<String, OpError> {
        let m = self
            .opt_str("mirror")?
            .unwrap_or_else(|| "none".to_string());
        if !["none", "x", "y"].contains(&m.as_str()) {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                "`mirror` must be none/x/y",
            ));
        }
        Ok(m)
    }
    /// A `[x_mil, y_mil]` point value, translated by the group origin.
    fn point_val(&self, val: &Value, what: &str) -> Result<Pt, OpError> {
        let arr = val.as_array().ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{what}` must be [x_mil, y_mil]"),
            )
        })?;
        if arr.len() != 2 {
            return Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{what}` must be [x_mil, y_mil]"),
            ));
        }
        let x = arr[0].as_f64().ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{what}` x must be a number"),
            )
        })?;
        let y = arr[1].as_f64().ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{what}` y must be a number"),
            )
        })?;
        Ok(self.world(x, y))
    }
    fn point(&self, k: &str) -> Result<Pt, OpError> {
        self.mark(k);
        let v = self.v.get(k).filter(|v| !v.is_null()).ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("missing required field `{k}`"),
            )
        })?;
        self.point_val(v, k)
    }
    fn opt_point(&self, k: &str) -> Result<Option<Pt>, OpError> {
        if self.has(k) {
            self.point(k).map(Some)
        } else {
            Ok(None)
        }
    }
    fn world(&self, x_mil: f64, y_mil: f64) -> Pt {
        Pt::new(
            mil_to_nm(x_mil) + self.origin.x,
            mil_to_nm(y_mil) + self.origin.y,
        )
    }
    /// `x_mil`/`y_mil` pair (group-local) or `anchor` + `offset_mil`.
    fn place(&self) -> Result<Place, OpError> {
        let has_xy = self.has("x_mil") || self.has("y_mil");
        let has_anchor = self.has("anchor");
        match (has_xy, has_anchor) {
            (true, false) => Ok(Place::At(
                self.world(self.num("x_mil")?, self.num("y_mil")?),
            )),
            (false, true) => {
                let anchor = self.endpoint_val(self.v.get("anchor").unwrap(), "anchor")?;
                self.mark("offset_mil");
                let offset = match self.v.get("offset_mil") {
                    Some(v) if !v.is_null() => {
                        let arr = v.as_array().ok_or_else(|| {
                            err(self.i, "OPLIST_SCHEMA", "`offset_mil` must be [dx, dy]")
                        })?;
                        if arr.len() != 2 {
                            return Err(err(
                                self.i,
                                "OPLIST_SCHEMA",
                                "`offset_mil` must be [dx, dy]",
                            ));
                        }
                        Pt::new(
                            mil_to_nm(arr[0].as_f64().unwrap_or(0.0)),
                            mil_to_nm(arr[1].as_f64().unwrap_or(0.0)),
                        )
                    }
                    _ => Pt::new(0, 0),
                };
                Ok(Place::Relative { anchor, offset })
            }
            (true, true) => Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                "give either x_mil/y_mil or anchor, not both",
            )),
            (false, false) => Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                "give x_mil/y_mil or anchor",
            )),
        }
    }
    fn endpoint_val(&self, v: &Value, what: &str) -> Result<Endpoint, OpError> {
        match v {
            Value::String(s) => parse_pin_ref(s)
                .map(|(r, u, p)| Endpoint::Pin {
                    reference: r,
                    unit: u,
                    pin: p,
                })
                .ok_or_else(|| {
                    err(
                        self.i,
                        "OPLIST_SCHEMA",
                        format!("`{what}` must be REF.PIN or [x_mil, y_mil]"),
                    )
                }),
            Value::Array(_) => Ok(Endpoint::Point(self.point_val(v, what)?)),
            _ => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{what}` must be REF.PIN or [x_mil, y_mil]"),
            )),
        }
    }
    fn endpoint(&self, k: &str) -> Result<Endpoint, OpError> {
        self.mark(k);
        let v = self.v.get(k).filter(|v| !v.is_null()).ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("missing required field `{k}`"),
            )
        })?;
        self.endpoint_val(v, k)
    }
    fn anchor(&self, k: &str) -> Result<Anchor, OpError> {
        self.mark(k);
        let v = self.v.get(k).filter(|v| !v.is_null()).ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("missing required field `{k}`"),
            )
        })?;
        if let Value::String(s) = v {
            if let Some(inner) = s.strip_prefix("mid(").and_then(|x| x.strip_suffix(')')) {
                let (a, b) = inner
                    .split_once(',')
                    .ok_or_else(|| err(self.i, "OPLIST_SCHEMA", "mid(REF.PIN, REF.PIN)"))?;
                let ea = self.endpoint_val(&Value::String(a.trim().to_string()), k)?;
                let eb = self.endpoint_val(&Value::String(b.trim().to_string()), k)?;
                return Ok(Anchor::Mid(ea, eb));
            }
        }
        Ok(Anchor::Endpoint(self.endpoint_val(v, k)?))
    }
    fn vertices(&self, k: &str) -> Result<Vec<Pt>, OpError> {
        self.mark(k);
        let arr = self.v.get(k).and_then(|v| v.as_array()).ok_or_else(|| {
            err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{k}` must be an array of points"),
            )
        })?;
        if arr.len() < 2 {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!("`{k}` needs at least 2 points"),
            ));
        }
        arr.iter().map(|p| self.point_val(p, k)).collect()
    }
    fn scope(&self, d: Scope) -> Result<Scope, OpError> {
        Ok(self.opt_scope("scope")?.unwrap_or(d))
    }
    fn opt_scope(&self, k: &str) -> Result<Option<Scope>, OpError> {
        match self.opt_str(k)? {
            None => Ok(None),
            Some(s) => Scope::parse(&s).map(Some).ok_or_else(|| {
                err(
                    self.i,
                    "OPLIST_CONSTRAINT",
                    format!("`{k}` must be local/global/hierarchical"),
                )
            }),
        }
    }
    /// Per-element wiring of one pin of a `place_array` element: `pinN_labels` (alias
    /// `pinN_nets`) one net name per element, or `pinN_rail` for the same rail on every
    /// element. `pinN_scope` forces the label scope; without it a rail name still becomes a
    /// power port (red line 4: a rail drawn as a local label never leaves its sheet).
    fn pin_wiring(&self, n: u32, count: usize) -> Result<PinWiring, OpError> {
        let (lk, nk) = (format!("pin{n}_labels"), format!("pin{n}_nets"));
        let (rk, sk) = (format!("pin{n}_rail"), format!("pin{n}_scope"));
        let (has_l, has_n) = (self.has(&lk), self.has(&nk));
        if has_l && has_n {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!("give `{lk}` or `{nk}`, not both (they are the same field)"),
            ));
        }
        let key = if has_n { nk } else { lk };
        let labels = if has_l || has_n {
            self.strlist(&key)?
        } else {
            Vec::new()
        };
        let rail = self.opt_str(&rk)?.filter(|r| !r.trim().is_empty());
        if !labels.is_empty() && rail.is_some() {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!("give `{key}` or `{rk}`, not both: pin {n} carries one net"),
            ));
        }
        if !labels.is_empty() && labels.len() != count {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!(
                    "`{key}` has {} entries but `count` is {count}: one net name per element",
                    labels.len()
                ),
            ));
        }
        if let Some((j, _)) = labels.iter().enumerate().find(|(_, l)| l.trim().is_empty()) {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!("`{key}[{j}]` is empty: every element needs a net name"),
            ));
        }
        Ok(PinWiring {
            pin: n.to_string(),
            labels,
            scope: self.opt_scope(&sk)?,
            rail,
        })
    }
    fn dict(&self, k: &str) -> Result<BTreeMap<String, String>, OpError> {
        self.mark(k);
        match self.v.get(k) {
            Some(Value::Object(m)) => m
                .iter()
                .map(|(kk, vv)| match vv {
                    Value::String(s) => Ok((kk.clone(), s.clone())),
                    Value::Number(n) => Ok((kk.clone(), n.to_string())),
                    Value::Bool(b) => Ok((kk.clone(), b.to_string())),
                    _ => Err(err(
                        self.i,
                        "OPLIST_SCHEMA",
                        format!("`{k}.{kk}` must be a string"),
                    )),
                })
                .collect(),
            Some(Value::Null) | None => Ok(BTreeMap::new()),
            _ => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{k}` must be an object"),
            )),
        }
    }
    /// `designators` of a macro, checked against the roles the macro binds positionally
    /// (`R` for the resistor slot, `D` for the LED slot, ...). A swapped order is refused
    /// instead of silently producing a BOM where the resistor is called D1.
    fn designators(&self, k: &str, roles: &[&str]) -> Result<Vec<String>, OpError> {
        let des = self.strlist(k)?;
        if des.len() > roles.len() {
            return Err(err(
                self.i,
                "OPLIST_CONSTRAINT",
                format!(
                    "`{k}` takes at most {} entries (order: {})",
                    roles.len(),
                    roles.join(", ")
                ),
            ));
        }
        for (i, d) in des.iter().enumerate() {
            let prefix: String = d.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
            if prefix.is_empty() || prefix.eq_ignore_ascii_case(roles[i]) {
                continue;
            }
            return Err(OpError {
                index: self.i,
                code: "OPLIST_CONSTRAINT".into(),
                message: format!(
                    "`{k}[{i}]` = `{d}` but that slot is the {} part; `{k}` is positional (order: {})",
                    roles[i],
                    roles.join(", ")
                ),
                remediation: Some(format!("reorder `{k}` as [{}]", roles.iter().map(|r| format!("{r}?")).collect::<Vec<_>>().join(", "))),
                evidence: None,
            });
        }
        Ok(des)
    }

    fn strlist(&self, k: &str) -> Result<Vec<String>, OpError> {
        self.mark(k);
        match self.v.get(k) {
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| {
                    x.as_str().map(|s| s.to_string()).ok_or_else(|| {
                        err(self.i, "OPLIST_SCHEMA", format!("`{k}` must be strings"))
                    })
                })
                .collect(),
            Some(Value::Null) | None => Ok(Vec::new()),
            _ => Err(err(
                self.i,
                "OPLIST_SCHEMA",
                format!("`{k}` must be an array"),
            )),
        }
    }
}

/// One pin's per-element wiring in `place_array` (see [`F::pin_wiring`]).
struct PinWiring {
    pin: String,
    labels: Vec<String>,
    scope: Option<Scope>,
    rail: Option<String>,
}

impl PinWiring {
    fn wired(&self) -> bool {
        !self.labels.is_empty() || self.rail.is_some()
    }
    /// The op that terminates this pin on element `k`, if any.
    fn op_for(&self, k: usize, designator: &str) -> Option<Op> {
        let at = pin(designator, &self.pin);
        if let Some(r) = &self.rail {
            return Some(rail_or_label(r, at));
        }
        let name = self.labels.get(k)?;
        match &self.scope {
            // An explicit scope is the drafter's call; otherwise a rail name becomes a power port.
            Some(sc) => Some(Op::AddNetLabel {
                name: name.clone(),
                at: Anchor::Endpoint(at),
                scope: sc.clone(),
                rotation: None,
            }),
            None => Some(rail_or_label(name, at)),
        }
    }
}

/// Parse `REF.PIN` / `REF#u2.PIN`.
pub fn parse_pin_ref(s: &str) -> Option<(String, Option<u32>, String)> {
    let (r, p) = s.rsplit_once('.')?;
    if r.is_empty() || p.is_empty() {
        return None;
    }
    let (reference, unit) = match r.split_once("#u") {
        Some((rr, u)) => (rr.to_string(), u.parse().ok()),
        None => (r.to_string(), None),
    };
    Some((reference, unit, p.to_string()))
}

fn wrap(i: usize, sheet: Option<String>, note: Option<String>, op: Op) -> ExpandedOp {
    ExpandedOp {
        authored_index: i,
        sheet,
        note,
        region_mil: None,
        exact: false,
        no_nudge: false,
        op,
    }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/// Validate and expand an op-list into world-space core ops. Errors carry the
/// authored index. Group and sheet keys are checked against the envelope.
pub fn expand(list: &OpList) -> Result<Expanded, Vec<OpError>> {
    let mut errors = Vec::new();
    let mut out = Vec::new();
    let mut mapping = Vec::new();
    if list.protocol_version != PROTOCOL_VERSION {
        errors.push(err(
            0,
            "OPLIST_SCHEMA",
            format!(
                "unsupported protocol_version {} (engine speaks {PROTOCOL_VERSION})",
                list.protocol_version
            ),
        ));
    }
    if list.target_format != "kicad" {
        errors.push(err(
            0,
            "OPLIST_SCHEMA",
            format!("unsupported target_format {}", list.target_format),
        ));
    }
    let mut warnings = Vec::new();
    for (i, v) in list.ops.iter().enumerate() {
        let start = out.len();
        match expand_one(i, v, list, &mut warnings) {
            Ok(ops) => out.extend(ops),
            Err(e) => errors.push(e),
        }
        mapping.push((start..out.len()).collect());
    }
    if errors.is_empty() {
        Ok(Expanded {
            ops: out,
            mapping,
            warnings,
        })
    } else {
        Err(errors)
    }
}

fn expand_one(
    i: usize,
    v: &Value,
    list: &OpList,
    warnings: &mut Vec<OpWarning>,
) -> Result<Vec<ExpandedOp>, OpError> {
    let obj = v
        .as_object()
        .ok_or_else(|| err(i, "OPLIST_SCHEMA", "op must be an object"))?;
    let name = obj
        .get("op")
        .and_then(|o| o.as_str())
        .ok_or_else(|| err(i, "OPLIST_SCHEMA", "missing `op`"))?
        .to_string();
    let group = obj
        .get("group")
        .and_then(|g| g.as_str())
        .map(|s| s.to_string());
    let mut region_mil = None;
    let origin = match &group {
        Some(g) => {
            let gr = list.groups.get(g).ok_or_else(|| {
                err(
                    i,
                    "GROUP_UNKNOWN",
                    format!("group `{g}` not declared in envelope"),
                )
            })?;
            region_mil = gr.region_mil;
            // A group origin is snapped to the 50 mil connection grid before it is added to any op: an
            // `exact` placement keeps its geometry relative to the origin, so an off-grid origin would put
            // every pin of the block off the grid (a real run placed a whole block at x = 5666 mil).
            let snap = |v: f64| (v / 50.0).round() * 50.0;
            Pt::new(
                mil_to_nm(snap(gr.origin_mil[0])),
                mil_to_nm(snap(gr.origin_mil[1])),
            )
        }
        None => Pt::new(0, 0),
    };
    let exact = obj.get("exact").and_then(|b| b.as_bool()).unwrap_or(false);
    // `no_nudge` keeps the authored position without giving up the grid snap: the middle setting
    // between "let the engine move it" and `exact` (which writes the position verbatim, off-grid
    // included). Macro parts are always no_nudge, so the authored flag only ever adds.
    let no_nudge = obj
        .get("no_nudge")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    // `sheet` is the envelope routing key, except for the sheet-symbol ops where
    // it names the sheet symbol itself (those route with `in_sheet`).
    let sheet_symbol_op = matches!(
        name.as_str(),
        "add_sheet_pin" | "delete_sheet_pin" | "resize_sheet"
    );
    let sheet = if sheet_symbol_op {
        obj.get("in_sheet")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
    } else {
        obj.get("sheet")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string())
    };
    if let Some(s) = &sheet {
        if !list.sheets.contains_key(s) {
            return Err(err(
                i,
                "SHEET_UNKNOWN",
                format!("sheet `{s}` not declared in envelope"),
            ));
        }
    }
    let note = obj
        .get("note")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string());
    let f = F::new(i, v, origin);
    let w = |op: Op| wrap(i, sheet.clone(), note.clone(), op);
    let ops: Vec<ExpandedOp> = match name.as_str() {
        // ---------------- core ----------------
        "place_component" => vec![w(Op::PlaceComponent {
            lib_id: f.str("lib_id")?,
            designator: f.str("designator")?,
            place: f.place()?,
            rotation: f.rotation("rotation", 0)?,
            mirror: f.mirror()?,
            unit: f.opt_num("unit")?.map(|u| u as u32).unwrap_or(1),
            value: f.opt_str("value")?,
            footprint: f.opt_str("footprint")?,
            symbol_source: f.opt_str("symbol_source")?,
            instance_designators: if f.has("instance_designators") {
                Some(f.dict("instance_designators")?)
            } else {
                None
            },
        })],
        "delete_component" => vec![w(Op::DeleteComponent {
            designator: f.str("designator")?,
            cascade: f.bool_or("cascade", false)?,
        })],
        "delete_object" => {
            let uuid = f.opt_name("uuid")?;
            f.mark("match");
            if uuid.is_none() && v.get("match").map(|m| m.is_null()).unwrap_or(true) {
                return Err(err(
                    i,
                    "OPLIST_SCHEMA",
                    "delete_object needs `uuid` or `match` {kind, at|name|between}; a bare delete_object deletes nothing and is refused",
                ));
            }
            let matcher = match v.get("match") {
                Some(m) if !m.is_null() => {
                    let mf = F::new(i, m, origin);
                    let kind = mf.str("kind")?;
                    if ![
                        "wire",
                        "bus",
                        "label",
                        "global_label",
                        "hierarchical_label",
                        "junction",
                        "no_connect",
                        "text",
                        "bus_entry",
                        "rectangle",
                        "text_box",
                    ]
                    .contains(&kind.as_str())
                    {
                        return Err(err(
                            i,
                            "OPLIST_CONSTRAINT",
                            format!("unknown match kind `{kind}`"),
                        ));
                    }
                    let between = match m.get("between") {
                        Some(Value::Array(a)) if a.len() == 2 => Some((
                            mf.point_val(&a[0], "between")?,
                            mf.point_val(&a[1], "between")?,
                        )),
                        Some(Value::Null) | None => None,
                        _ => {
                            return Err(err(i, "OPLIST_SCHEMA", "`between` must be [point, point]"))
                        }
                    };
                    Some(MatchSpec {
                        kind,
                        at: mf.opt_point("at")?,
                        name: mf.opt_str("name")?,
                        between,
                    })
                }
                _ => None,
            };
            if uuid.is_some() == matcher.is_some() {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "delete_object needs exactly one of `uuid` or `match`",
                ));
            }
            vec![w(Op::DeleteObject { uuid, matcher })]
        }
        "move_component" => {
            let designator = f.opt_str("designator")?;
            let uuid = f.opt_str("uuid")?;
            if designator.is_none() && uuid.is_none() {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "move_component needs `designator` or `uuid`",
                ));
            }
            vec![w(Op::MoveComponent {
                designator,
                uuid,
                place: f.place()?,
                unit: f.opt_num("unit")?.map(|u| u as u32),
                carry_labels: f.bool_or("carry_labels", true)?,
                carry_wires: f.bool_or("carry_wires", true)?,
                carry_power: f.bool_or("carry_power", true)?,
            })]
        }
        "set_component_transform" => {
            let rotation = if f.has("rotation") {
                Some(f.rotation("rotation", 0)?)
            } else {
                None
            };
            let mirror = if f.has("mirror") {
                Some(f.mirror()?)
            } else {
                None
            };
            if rotation.is_none() && mirror.is_none() {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "set_component_transform needs rotation and/or mirror",
                ));
            }
            let designator = f.opt_str("designator")?;
            let uuid = f.opt_str("uuid")?;
            if designator.is_none() && uuid.is_none() {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "set_component_transform needs `designator` or `uuid`",
                ));
            }
            vec![w(Op::SetComponentTransform {
                designator,
                uuid,
                rotation,
                mirror,
            })]
        }
        "set_component_parameters" => {
            let mut parameters = f.dict("parameters")?;
            for k in ["dnp", "in_bom", "on_board"] {
                if parameters.contains_key(k) {
                    return Err(err(
                        i,
                        "OPLIST_CONSTRAINT",
                        format!("`parameters.{k}` is an attribute; use set_component_attributes"),
                    ));
                }
            }
            // An empty string in the top-level slots means "leave unchanged" (the op template ships them
            // as ""); clearing Value/Footprint is never what a caller wants.
            let non_empty = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
            let mut value = non_empty(f.opt_str("value")?);
            let mut footprint = non_empty(f.opt_str("footprint")?);
            // Built-in fields written into `parameters` under any letter case are folded onto their
            // canonical slot. Without this, `parameters.value` would be written as a brand-new property
            // named "value" next to the untouched "Value" (observed with real models), and the apply
            // would report success while the visible value stayed the same.
            for key in parameters.keys().cloned().collect::<Vec<_>>() {
                let canonical = match key.to_ascii_lowercase().as_str() {
                    "value" => "Value",
                    "footprint" => "Footprint",
                    "datasheet" => "Datasheet",
                    "description" => "Description",
                    _ => continue,
                };
                let Some(v) = parameters.remove(&key) else {
                    continue;
                };
                let v = non_empty(Some(v));
                match canonical {
                    "Value" => match (&value, v) {
                        (Some(a), Some(b)) if *a != b => {
                            return Err(err(
                                i,
                                "OPLIST_CONSTRAINT",
                                "`value` and `parameters.value` disagree; give the value once",
                            ))
                        }
                        (None, Some(b)) => value = Some(b),
                        _ => {}
                    },
                    "Footprint" => match (&footprint, v) {
                        (Some(a), Some(b)) if *a != b => {
                            return Err(err(
                                i,
                                "OPLIST_CONSTRAINT",
                                "`footprint` and `parameters.footprint` disagree; give the footprint once",
                            ))
                        }
                        (None, Some(b)) => footprint = Some(b),
                        _ => {}
                    },
                    _ => {
                        if let Some(b) = v {
                            parameters.entry(canonical.to_string()).or_insert(b);
                        }
                    }
                }
            }
            let op = Op::SetComponentParameters {
                designator: f.str("designator")?,
                new_designator: non_empty(f.opt_str("new_designator")?),
                value,
                footprint,
                parameters,
                instance_designators: if f.has("instance_designators") {
                    Some(f.dict("instance_designators")?)
                } else {
                    None
                },
            };
            if let Op::SetComponentParameters {
                new_designator: None,
                value: None,
                footprint: None,
                parameters,
                instance_designators: None,
                ..
            } = &op
            {
                if parameters.is_empty() {
                    return Err(err(
                        i,
                        "OPLIST_CONSTRAINT",
                        "set_component_parameters changes nothing",
                    ));
                }
            }
            vec![w(op)]
        }
        "set_component_attributes" => {
            let (dnp, in_bom, on_board) = (
                f.opt_bool("dnp")?,
                f.opt_bool("in_bom")?,
                f.opt_bool("on_board")?,
            );
            if dnp.is_none() && in_bom.is_none() && on_board.is_none() {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "set_component_attributes needs dnp/in_bom/on_board",
                ));
            }
            vec![w(Op::SetComponentAttributes {
                designator: f.str("designator")?,
                dnp,
                in_bom,
                on_board,
            })]
        }
        "add_wire" => vec![w(Op::AddWire {
            vertices: f.vertices("vertices")?,
        })],
        "route_net" => {
            let style = f.opt_str("style")?.unwrap_or_else(|| "auto".to_string());
            if !["auto", "hv", "vh", "z"].contains(&style.as_str()) {
                return Err(err(i, "OPLIST_CONSTRAINT", "`style` must be auto/hv/vh/z"));
            }
            vec![w(Op::RouteNet {
                from: f.endpoint("from")?,
                to: f.endpoint("to")?,
                style,
                label: f.opt_name("label")?,
                scope: f.scope(Scope::Local)?,
            })]
        }
        "add_junction" => vec![w(Op::AddJunction { at: f.point("at")? })],
        "add_no_connect" => vec![w(Op::AddNoConnect {
            pin: f.endpoint("pin")?,
        })],
        "add_net_label" => vec![w(Op::AddNetLabel {
            name: f.name("name")?,
            at: f.anchor("at")?,
            scope: f.scope(Scope::Local)?,
            rotation: if f.has("rotation") {
                Some(f.rotation("rotation", 0)?)
            } else {
                None
            },
        })],
        "place_power_port" => {
            let lib_id = f.str("lib_id")?;
            let net_name = f.name("net_name")?;
            // PWR_FLAG is an assertion, not a rail: eeschema treats its pin as a power output and a
            // flag named after a rail turns into a second driver of that rail (seen with real models:
            // `place_power_port lib_id=power:PWR_FLAG net_name=VBUS`, which KiCad then reported as
            // power_out/power_out conflicts while the rail itself had no port at all).
            let symbol = lib_id.rsplit(':').next().unwrap_or(lib_id.as_str());
            if symbol.eq_ignore_ascii_case("PWR_FLAG") && net_name != "PWR_FLAG" {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    format!(
                        "power:PWR_FLAG is not a rail port (net_name `{net_name}`); place the rail with place_power_port lib_id=power:{net_name} (or place_gnd / place_vcc) and add the flag with place_pwr_flag"
                    ),
                ));
            }
            vec![w(Op::PlacePowerPort {
                lib_id,
                net_name,
                at: f.anchor("at")?,
                rotation: f.opt_rotation("rotation")?,
            })]
        }
        "place_gnd" | "place_vcc" => {
            let default_net = if name == "place_gnd" { "GND" } else { "VCC" };
            let net_name = f
                .opt_str("net_name")?
                .unwrap_or_else(|| default_net.to_string());
            // Without a `lib_id` the glyph follows the rail: `place_vcc net_name=VBUS` is a VBUS
            // port, not a VCC one. The old default wrote `power:VCC` for every rail, so a real run
            // drew four VCC glyphs on a VBUS rail (the net was still VBUS - KiCad names a power net
            // after the Value - but the sheet read as the wrong supply). `power_glyph` is the one
            // rule: the rail's own stock symbol, else the nearest glyph, reported when it borrows.
            let lib_id = match f.opt_str("lib_id")? {
                Some(l) => l,
                None => {
                    let glyph = power_glyph(&net_name);
                    if glyph != net_name {
                        warnings.push(OpWarning {
                            index: i,
                            code: "OPLIST_RAIL_GLYPH_BORROWED".into(),
                            message: format!(
                                "`{name}` has no stock power symbol for `{net_name}`: drawn with the `power:{glyph}` glyph, with `{net_name}` in its Value (that is the net name KiCad reads)"
                            ),
                            remediation: Some(format!(
                                "pass `lib_id` to choose another glyph, or keep `power:{glyph}`"
                            )),
                        });
                    }
                    format!("power:{glyph}")
                }
            };
            vec![w(Op::PlacePowerPort {
                lib_id,
                net_name,
                at: f.anchor("at")?,
                rotation: f.opt_rotation("rotation")?,
            })]
        }
        "rename_net" => {
            // No `scope` (the template's empty string included) means "read it off the labels that
            // carry the name": the engine resolves it and refuses a name spelled as two kinds.
            let scope = if f.opt_str("scope")?.filter(|s| !s.is_empty()).is_some() {
                Some(f.scope(Scope::Local)?)
            } else {
                None
            };
            vec![w(Op::RenameNet {
                old_name: f.name("old_name")?,
                new_name: f.name("new_name")?,
                scope,
            })]
        }
        "add_bus" => vec![w(Op::AddBus {
            vertices: f.vertices("vertices")?,
        })],
        "add_bus_entry" => {
            f.mark("size");
            let size = match v.get("size") {
                Some(s) if !s.is_null() => {
                    let arr = s
                        .as_array()
                        .ok_or_else(|| err(i, "OPLIST_SCHEMA", "`size` must be [dx, dy]"))?;
                    Pt::new(
                        mil_to_nm(arr.first().and_then(|x| x.as_f64()).unwrap_or(100.0)),
                        mil_to_nm(arr.get(1).and_then(|x| x.as_f64()).unwrap_or(100.0)),
                    )
                }
                _ => Pt::new(mil_to_nm(100.0), mil_to_nm(100.0)),
            };
            vec![w(Op::AddBusEntry {
                at: f.point("at")?,
                size,
            })]
        }
        "add_text" => vec![w(Op::AddText {
            text: f.str("text")?,
            at: f.point("at")?,
            angle: f.rotation("angle", 0)?,
            key: f.opt_str("key")?,
        })],
        "add_rectangle" => {
            let fill = f.opt_str("fill")?.unwrap_or_else(|| "none".to_string());
            if !["none", "outline", "background"].contains(&fill.as_str()) {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "`fill` must be none/outline/background",
                ));
            }
            vec![w(Op::AddRectangle {
                start: f.point("start")?,
                end: f.point("end")?,
                stroke_width: mil_to_nm(f.opt_num("stroke_width_mil")?.unwrap_or(0.0)),
                fill,
                key: f.opt_str("key")?,
            })]
        }
        "add_text_box" => {
            f.mark("size");
            let size =
                f.v.get("size")
                    .filter(|s| !s.is_null())
                    .ok_or_else(|| err(i, "OPLIST_SCHEMA", "missing required field `size`"))?;
            let arr = size
                .as_array()
                .ok_or_else(|| err(i, "OPLIST_SCHEMA", "`size` must be [w, h]"))?;
            let size = Pt::new(
                mil_to_nm(arr.first().and_then(|x| x.as_f64()).unwrap_or(0.0)),
                mil_to_nm(arr.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0)),
            );
            vec![w(Op::AddTextBox {
                text: f.str("text")?,
                at: f.point("at")?,
                size,
                angle: f.rotation("angle", 0)?,
                key: f.opt_str("key")?,
            })]
        }
        "add_sheet" => {
            f.mark("size");
            f.mark("pins");
            let pins = parse_sheetpins(i, v.get("pins"))?;
            // `size` is optional: without it the symbol is sized from its pin count
            // (`default_sheet_size`), which is what a scaffold wants and what a model
            // guessing a box rarely gets right.
            let size = match f.v.get("size").filter(|s| !s.is_null()) {
                None => default_sheet_size(&pins),
                Some(size) => {
                    let arr = size
                        .as_array()
                        .ok_or_else(|| err(i, "OPLIST_SCHEMA", "`size` must be [w, h]"))?;
                    Pt::new(
                        mil_to_nm(arr.first().and_then(|x| x.as_f64()).unwrap_or(0.0)),
                        mil_to_nm(arr.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0)),
                    )
                }
            };
            let file = f.str("file")?;
            if file.contains("..") || file.starts_with('/') || file.contains('\\') {
                return Err(err(
                    i,
                    "PATH_OUT_OF_SCOPE",
                    "sheet `file` must be a relative path inside the project",
                ));
            }
            vec![w(Op::AddSheet {
                name: f.str("name")?,
                file,
                at: f.point("at")?,
                size,
                pins,
                create: f.bool_or("create", false)?,
                paper: f.opt_str("paper")?.filter(|p| !p.is_empty()),
            })]
        }
        "add_sheet_pin" => {
            let kind = f.str("type")?;
            let side = f.str("side")?;
            check_sheet_pin(i, &kind, &side)?;
            vec![w(Op::AddSheetPin {
                sheet: f.str("sheet")?,
                name: f.str("name")?,
                kind,
                side,
                offset: f.opt_num("offset_mil")?.map(mil_to_nm),
            })]
        }
        "delete_sheet_pin" => vec![w(Op::DeleteSheetPin {
            sheet: f.str("sheet")?,
            name: f.str("name")?,
        })],
        "resize_sheet" => {
            f.mark("size");
            let size =
                f.v.get("size")
                    .filter(|s| !s.is_null())
                    .ok_or_else(|| err(i, "OPLIST_SCHEMA", "missing required field `size`"))?;
            let arr = size
                .as_array()
                .ok_or_else(|| err(i, "OPLIST_SCHEMA", "`size` must be [w, h]"))?;
            let size = Pt::new(
                mil_to_nm(arr.first().and_then(|x| x.as_f64()).unwrap_or(0.0)),
                mil_to_nm(arr.get(1).and_then(|x| x.as_f64()).unwrap_or(0.0)),
            );
            vec![w(Op::ResizeSheet {
                sheet: f.str("sheet")?,
                size,
                at: f.opt_point("at")?,
            })]
        }
        "set_title_block" => {
            let mut fields = BTreeMap::new();
            for k in ["title", "date", "rev", "company"] {
                if let Some(s) = f.opt_str(k)? {
                    fields.insert(k.to_string(), s);
                }
            }
            for n in 1..=9 {
                let k = format!("comment{n}");
                if let Some(s) = f.opt_str(&k)? {
                    fields.insert(k, s);
                }
            }
            if fields.is_empty() {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "set_title_block needs at least one field",
                ));
            }
            vec![w(Op::SetTitleBlock { fields })]
        }
        // ---------------- macros ----------------
        "place_divider" => {
            let (x, y) = (f.num("x_mil")?, f.num("y_mil")?);
            let des = f.designators("designators", &["R", "R"])?;
            let vals = f.strlist("values")?;
            let (rt, rb) = (
                des.first().cloned().unwrap_or_else(|| "R?".into()),
                des.get(1).cloned().unwrap_or_else(|| "R?".into()),
            );
            let (vt, vb) = (
                vals.first().cloned().unwrap_or_else(|| "10k".into()),
                vals.get(1).cloned().unwrap_or_else(|| "10k".into()),
            );
            // The mid label sits on the wire between the two parts: below 500 mil it lands on a body (LABEL_OVER_BODY).
            let spacing = f.opt_num("spacing_mil")?.unwrap_or(500.0).max(500.0);
            let lib = f.opt_str("lib_id")?.unwrap_or_else(|| "Device:R".into());
            let (top, mid, bot) = (f.str("top_net")?, f.str("mid_net")?, f.str("bottom_net")?);
            let fp = f.opt_str("footprint")?;
            vec![
                w(place_fp(&lib, &rt, f.world(x, y), 0, Some(vt), fp.clone())),
                w(place_fp(
                    &lib,
                    &rb,
                    f.world(x, y + spacing),
                    0,
                    Some(vb),
                    fp,
                )),
                w(rail_or_label(&top, pin(&rt, "1"))),
                w(wire_mid(pin(&rt, "2"), pin(&rb, "1"), &mid)),
                w(rail_or_label(&bot, pin(&rb, "2"))),
            ]
        }
        "place_decoupling" => {
            let des = f.opt_str("designator")?.unwrap_or_else(|| "C?".into());
            let lib = f.opt_str("lib_id")?.unwrap_or_else(|| "Device:C".into());
            // `near: "U1.3"` anchors the cap to the pin it decouples, through the same anchor
            // path `place_power_port` resolves (`Endpoint::Pin` -> `pin_world`), one short hop
            // clear of it. The writer then snaps the spot to the 50 mil connection grid and
            // nudges it to the nearest free one, so the pair stays inside `DECAP_FAR_MIL`
            // instead of landing wherever a model guessed x/y would be free.
            let pl = if f.has("near") {
                if f.has("x_mil") || f.has("y_mil") || f.has("anchor") {
                    return Err(err(
                        i,
                        "OPLIST_CONSTRAINT",
                        "give either `near` or x_mil/y_mil, not both",
                    ));
                }
                f.mark("near");
                let anchor = f.endpoint_val(f.v.get("near").unwrap(), "near")?;
                Place::NearPin {
                    anchor,
                    distance: mil_to_nm(DECAP_NEAR_OFFSET_MIL),
                }
            } else {
                f.place()?
            };
            let power = f.str("power_net")?;
            let gnd = f.opt_str("gnd_net")?.unwrap_or_else(|| "GND".into());
            vec![
                w(Op::PlaceComponent {
                    lib_id: lib,
                    designator: des.clone(),
                    place: pl,
                    rotation: 0,
                    mirror: "none".into(),
                    unit: 1,
                    value: Some(f.opt_str("value")?.unwrap_or_else(|| "100n".into())),
                    footprint: f.opt_str("footprint")?,
                    symbol_source: None,
                    instance_designators: None,
                }),
                w(rail_or_label(&power, pin(&des, "1"))),
                w(rail_or_label(&gnd, pin(&des, "2"))),
            ]
        }
        "place_pullup" => {
            let des = f.opt_str("designator")?.unwrap_or_else(|| "R?".into());
            let lib = f.opt_str("lib_id")?.unwrap_or_else(|| "Device:R".into());
            let pl = f.place()?;
            vec![
                w(Op::PlaceComponent {
                    lib_id: lib,
                    designator: des.clone(),
                    place: pl,
                    rotation: 0,
                    mirror: "none".into(),
                    unit: 1,
                    value: Some(f.opt_str("value")?.unwrap_or_else(|| "10k".into())),
                    footprint: f.opt_str("footprint")?,
                    symbol_source: None,
                    instance_designators: None,
                }),
                w(rail_or_label(&f.str("rail_net")?, pin(&des, "1"))),
                w(label(&f.str("net")?, pin(&des, "2"))),
            ]
        }
        "place_led_indicator" => {
            let (x, y) = (f.num("x_mil")?, f.num("y_mil")?);
            let des = f.designators("designators", &["R", "D"])?;
            let (r, d) = (
                des.first().cloned().unwrap_or_else(|| "R?".into()),
                des.get(1).cloned().unwrap_or_else(|| "D?".into()),
            );
            let spacing = f.opt_num("spacing_mil")?.unwrap_or(500.0).max(500.0);
            let net = f.name("net")?;
            // The node between the resistor and the LED is one short wire between two adjacent
            // pins; a human never names it. Only label it when the author asked for a name:
            // an auto-minted `<net>_LED` reads as machine output on the finished sheet, and
            // KiCad names the node itself in the netlist either way.
            let mid = f.opt_str("mid_net")?.filter(|s| !s.is_empty());
            let gnd = f.opt_str("gnd_net")?.unwrap_or_else(|| "GND".into());
            vec![
                w(place(
                    "Device:R",
                    &r,
                    f.world(x, y),
                    0,
                    Some(f.opt_str("r_value")?.unwrap_or_else(|| "1k".into())),
                )),
                w(place("Device:LED", &d, f.world(x, y + spacing), 90, None)),
                w(label(&net, pin(&r, "1"))),
                w(match &mid {
                    Some(name) => wire_mid(pin(&r, "2"), pin(&d, "2"), name),
                    None => wire(pin(&r, "2"), pin(&d, "2")),
                }),
                w(rail_or_label(&gnd, pin(&d, "1"))),
            ]
        }
        "place_rc_filter" => {
            let (x, y) = (f.num("x_mil")?, f.num("y_mil")?);
            let des = f.designators("designators", &["R", "C"])?;
            let (r, c) = (
                des.first().cloned().unwrap_or_else(|| "R?".into()),
                des.get(1).cloned().unwrap_or_else(|| "C?".into()),
            );
            let spacing = f.opt_num("spacing_mil")?.unwrap_or(400.0);
            let (inn, out) = (f.str("in_net")?, f.str("out_net")?);
            let gnd = f.opt_str("gnd_net")?.unwrap_or_else(|| "GND".into());
            vec![
                w(place_fp(
                    "Device:R",
                    &r,
                    f.world(x, y),
                    90,
                    Some(f.opt_str("r_value")?.unwrap_or_else(|| "1k".into())),
                    f.opt_str("r_footprint")?,
                )),
                w(place_fp(
                    "Device:C",
                    &c,
                    f.world(x + spacing, y + spacing),
                    0,
                    Some(f.opt_str("c_value")?.unwrap_or_else(|| "100n".into())),
                    f.opt_str("c_footprint")?,
                )),
                w(label(&inn, pin(&r, "1"))),
                w(label(&out, pin(&r, "2"))),
                w(wire(pin(&r, "2"), pin(&c, "1"))),
                w(rail_or_label(&gnd, pin(&c, "2"))),
            ]
        }
        "place_crystal" => {
            let (x, y) = (f.num("x_mil")?, f.num("y_mil")?);
            let des = f.designators("designators", &["Y", "C", "C"])?;
            let (yy, c1, c2) = (
                des.first().cloned().unwrap_or_else(|| "Y?".into()),
                des.get(1).cloned().unwrap_or_else(|| "C?".into()),
                des.get(2).cloned().unwrap_or_else(|| "C?".into()),
            );
            let spacing = f.opt_num("spacing_mil")?.unwrap_or(300.0);
            let (inn, out) = (f.str("in_net")?, f.str("out_net")?);
            let gnd = f.opt_str("gnd_net")?.unwrap_or_else(|| "GND".into());
            let load = f.opt_str("load_c")?.unwrap_or_else(|| "12p".into());
            vec![
                w(place(
                    "Device:Crystal",
                    &yy,
                    f.world(x, y),
                    0,
                    Some(f.opt_str("value")?.unwrap_or_else(|| "8MHz".into())),
                )),
                w(place(
                    "Device:C",
                    &c1,
                    f.world(x - spacing, y + spacing),
                    0,
                    Some(load.clone()),
                )),
                w(place(
                    "Device:C",
                    &c2,
                    f.world(x + spacing, y + spacing),
                    0,
                    Some(load),
                )),
                w(label(&inn, pin(&yy, "1"))),
                w(label(&out, pin(&yy, "2"))),
                w(wire(pin(&yy, "1"), pin(&c1, "1"))),
                w(rail_or_label(&gnd, pin(&c1, "2"))),
                w(wire(pin(&yy, "2"), pin(&c2, "1"))),
                w(rail_or_label(&gnd, pin(&c2, "2"))),
            ]
        }
        "place_array" => {
            let lib = f.str("lib_id")?;
            let prefix = f.str("designator_prefix")?;
            let count = f.num("count")? as usize;
            if count == 0 || count > 200 {
                return Err(err(i, "OPLIST_CONSTRAINT", "`count` must be 1..=200"));
            }
            let (x, y) = (f.num("x_mil")?, f.num("y_mil")?);
            let start = f.opt_num("start_index")?.unwrap_or(1.0) as usize;
            let mut pitch = f.opt_num("pitch_mil")?.unwrap_or(400.0);
            let dir = f.opt_str("direction")?.unwrap_or_else(|| "right".into());
            if !["right", "left", "down", "up"].contains(&dir.as_str()) {
                return Err(err(
                    i,
                    "OPLIST_CONSTRAINT",
                    "`direction` must be right/down/left/up",
                ));
            }
            let rotation = f.rotation("rotation", 0)?;
            let value = f.opt_str("value")?;
            let values = f.strlist("values")?;
            let footprint = f.opt_str("footprint")?;
            // Per-element wiring. Like every other macro that terminates pins (place_divider,
            // place_led_indicator) the pin numbers are hard-coded: `place_array` wires pin "1"
            // and pin "2", so pinN_* is for 2-pin parts only. A symbol with more pins is still
            // placed; its other pins stay for the drafter to wire.
            let pin1 = f.pin_wiring(1, count)?;
            let pin2 = f.pin_wiring(2, count)?;
            if pin1.wired() || pin2.wired() {
                // A label or a power port sticks out along the pin axis. An array marching that
                // way at the default pitch would drop one element's label on the next element's
                // body, so clamp it the way the chain macros clamp `spacing_mil`.
                let along_pins = matches!(
                    (rotation, dir.as_str()),
                    (0 | 180, "down" | "up") | (90 | 270, "right" | "left")
                );
                if along_pins {
                    pitch = pitch.max(WIRED_ARRAY_PITCH_MIL);
                }
            }
            let (dx, dy) = match dir.as_str() {
                "right" => (pitch, 0.0),
                "left" => (-pitch, 0.0),
                "down" => (0.0, pitch),
                _ => (0.0, -pitch),
            };
            let mut out = Vec::with_capacity(count * 3);
            for k in 0..count {
                let des = format!("{prefix}{}", start + k);
                out.push(w(Op::PlaceComponent {
                    lib_id: lib.clone(),
                    designator: des.clone(),
                    place: Place::At(f.world(x + dx * k as f64, y + dy * k as f64)),
                    rotation,
                    mirror: "none".into(),
                    unit: 1,
                    value: values.get(k).cloned().or_else(|| value.clone()),
                    footprint: footprint.clone(),
                    symbol_source: None,
                    instance_designators: None,
                }));
                out.extend(pin1.op_for(k, &des).map(&w));
                out.extend(pin2.op_for(k, &des).map(&w));
            }
            out
        }
        "connect_and_label" => {
            let from = f.endpoint("from")?;
            let to = f.endpoint("to")?;
            let net = f.name("net")?;
            let scope = f.scope(Scope::Local)?;
            vec![
                w(Op::RouteNet {
                    from: from.clone(),
                    to: to.clone(),
                    style: "auto".into(),
                    label: None,
                    scope: scope.clone(),
                }),
                w(Op::AddNetLabel {
                    name: net,
                    at: Anchor::Mid(from, to),
                    scope,
                    rotation: None,
                }),
            ]
        }
        "place_pwr_flag" => vec![w(Op::PlacePowerPort {
            lib_id: "power:PWR_FLAG".into(),
            net_name: "PWR_FLAG".into(),
            at: f.anchor("at")?,
            rotation: f.opt_rotation("rotation")?,
        })],
        "terminate_unused_unit" => {
            let des = f.str("designator")?;
            let unit = f.num("unit")? as u32;
            let at = f.point("at")?;
            let vcc = f.opt_str("vcc")?.unwrap_or_else(|| "VCC".into());
            let gnd = f.opt_str("gnd")?.unwrap_or_else(|| "GND".into());
            vec![
                w(Op::PlaceComponent {
                    lib_id: f.str("lib_id")?,
                    designator: des.clone(),
                    place: Place::At(at),
                    rotation: 0,
                    mirror: "none".into(),
                    unit,
                    value: None,
                    footprint: None,
                    symbol_source: None,
                    instance_designators: None,
                }),
                w(Op::PlacePowerPort {
                    lib_id: format!("power:{vcc}"),
                    net_name: vcc,
                    at: Anchor::Endpoint(pin_u(&des, unit, &f.str("in_plus")?)),
                    rotation: None,
                }),
                w(Op::PlacePowerPort {
                    lib_id: format!("power:{gnd}"),
                    net_name: gnd,
                    at: Anchor::Endpoint(pin_u(&des, unit, &f.str("in_minus")?)),
                    rotation: None,
                }),
                w(Op::AddNoConnect {
                    pin: pin_u(&des, unit, &f.str("out")?),
                }),
            ]
        }
        "arrange_group" => {
            let g = group
                .clone()
                .ok_or_else(|| err(i, "OPLIST_SCHEMA", "arrange_group needs `group`"))?;
            f.mark("region_mil");
            let region = match (f.has("region_mil"), region_mil) {
                (true, _) => {
                    let a = v
                        .get("region_mil")
                        .and_then(|r| r.as_array())
                        .filter(|a| a.len() == 2)
                        .ok_or_else(|| {
                            err(i, "OPLIST_SCHEMA", "`region_mil` must be [[x0,y0],[x1,y1]]")
                        })?;
                    // absolute world coordinates (a region is a floorplan rectangle)
                    let p0 = f.point_val(&a[0], "region_mil")?;
                    let p1 = f.point_val(&a[1], "region_mil")?;
                    (
                        Pt::new(p0.x.min(p1.x), p0.y.min(p1.y)),
                        Pt::new(p0.x.max(p1.x), p0.y.max(p1.y)),
                    )
                }
                (false, Some(r)) => (
                    Pt::new(mil_to_nm(r[0][0]), mil_to_nm(r[0][1])),
                    Pt::new(mil_to_nm(r[1][0]), mil_to_nm(r[1][1])),
                ),
                (false, None) => {
                    return Err(err(
                        i,
                        "OPLIST_SCHEMA",
                        "arrange_group needs `region_mil` or a group with region_mil",
                    ))
                }
            };
            vec![w(Op::ArrangeGroup {
                group: g,
                region,
                pitch_x: mil_to_nm(f.opt_num("pitch_mil")?.unwrap_or(600.0)),
                pitch_y: mil_to_nm(f.opt_num("pitch_y_mil")?.unwrap_or(400.0)),
                designators: if f.has("designators") {
                    Some(f.strlist("designators")?)
                } else {
                    None
                },
                only_unwired: f.bool_or("only_unwired", true)?,
            })]
        }
        other => {
            // Bare "unknown op `x`" left the model guessing; name the closest real ops (or the
            // action that has no op) so the next attempt is the corrected one.
            let rem = unknown_op_remediation(other);
            return Err(
                err(i, "OPLIST_SCHEMA", format!("unknown op `{other}`")).with_remediation(rem)
            );
        }
    };
    // Everything the branch above never looked at was silently dropped before: a model that
    // invented `pin1_labels` on `place_array` got a schematic with floating pins and no word
    // about why. Report it, naming the fields the op does have.
    let unread = f.unread();
    if !unread.is_empty() {
        let known = template(&name, false)
            .and_then(|t| {
                t.as_object().map(|m| {
                    m.keys()
                        .filter(|k| k.as_str() != "op")
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                })
            })
            .unwrap_or_default();
        for k in unread {
            warnings.push(OpWarning {
                index: i,
                code: "OPLIST_UNKNOWN_FIELD".into(),
                message: format!("unknown field `{k}` on `{name}` was ignored (known: {known})"),
                remediation: Some(format!(
                    "call ops.template for `{name}` and use one of its fields, or express `{k}` with another op"
                )),
            });
        }
    }
    let ops = ops
        .into_iter()
        .map(|mut x| {
            x.region_mil = region_mil;
            x.exact = exact;
            // A macro's parts are designed geometry (the wire between them is 100 mil): never nudged apart.
            x.no_nudge = no_nudge || MACRO_OPS.contains(&name.as_str());
            x
        })
        .collect();
    Ok(ops)
}

fn parse_sheetpins(i: usize, v: Option<&Value>) -> Result<Vec<SheetPinSpec>, OpError> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let arr = v
        .as_array()
        .ok_or_else(|| err(i, "OPLIST_SCHEMA", "`pins` must be an array"))?;
    let mut out = Vec::new();
    for p in arr {
        let name = p
            .get("name")
            .and_then(|x| x.as_str())
            .ok_or_else(|| err(i, "OPLIST_SCHEMA", "sheet pin needs `name`"))?
            .to_string();
        let kind = p
            .get("type")
            .and_then(|x| x.as_str())
            .unwrap_or("passive")
            .to_string();
        let side = p
            .get("side")
            .and_then(|x| x.as_str())
            .unwrap_or("left")
            .to_string();
        check_sheet_pin(i, &kind, &side)?;
        out.push(SheetPinSpec {
            name,
            kind,
            side,
            offset: p.get("offset_mil").and_then(|x| x.as_f64()).map(mil_to_nm),
        });
    }
    Ok(out)
}

fn check_sheet_pin(i: usize, kind: &str, side: &str) -> Result<(), OpError> {
    if !["input", "output", "bidirectional", "tri_state", "passive"].contains(&kind) {
        return Err(err(
            i,
            "OPLIST_CONSTRAINT",
            format!("sheet pin type `{kind}` invalid"),
        ));
    }
    if !["left", "right", "top", "bottom"].contains(&side) {
        return Err(err(
            i,
            "OPLIST_CONSTRAINT",
            format!("sheet pin side `{side}` invalid"),
        ));
    }
    Ok(())
}

fn place_fp(
    lib: &str,
    des: &str,
    at: Pt,
    rotation: i64,
    value: Option<String>,
    footprint: Option<String>,
) -> Op {
    match place(lib, des, at, rotation, value) {
        Op::PlaceComponent {
            lib_id,
            designator,
            place,
            rotation,
            mirror,
            unit,
            value,
            symbol_source,
            instance_designators,
            ..
        } => Op::PlaceComponent {
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
        },
        other => other,
    }
}

fn place(lib: &str, des: &str, at: Pt, rotation: i64, value: Option<String>) -> Op {
    Op::PlaceComponent {
        lib_id: lib.to_string(),
        designator: des.to_string(),
        place: Place::At(at),
        rotation,
        mirror: "none".into(),
        unit: 1,
        value,
        footprint: None,
        symbol_source: None,
        instance_designators: None,
    }
}

fn pin(des: &str, p: &str) -> Endpoint {
    Endpoint::Pin {
        reference: des.to_string(),
        unit: None,
        pin: p.to_string(),
    }
}

fn pin_u(des: &str, unit: u32, p: &str) -> Endpoint {
    Endpoint::Pin {
        reference: des.to_string(),
        unit: Some(unit),
        pin: p.to_string(),
    }
}

/// Power-library symbols that exist in a stock KiCad 10 install (`power.kicad_sym`): a rail with one of
/// these names gets its own glyph; any other rail borrows the generic `VCC` / `GND` / `VEE` glyph and
/// carries the real net name in its Value (KiCad names a power net after the Value, not the symbol).
pub const KNOWN_POWER_SYMBOLS: &[&str] = &[
    "GND", "GNDA", "GNDD", "GNDPWR", "GNDREF", "GNDS", "Earth", "VCC", "VDD", "VDDA", "VSS", "VEE",
    "VBUS", "VDC", "VAA", "VPP", "VCOM", "+1V0", "+1V1", "+1V2", "+1V35", "+1V5", "+1V8", "+2V5",
    "+2V8", "+3V0", "+3V3", "+3.3V", "+3V8", "+4V", "+5V", "+5VA", "+5VD", "+5VP", "+6V", "+7.5V",
    "+8V", "+9V", "+9VA", "+10V", "+12V", "+12VA", "+15V", "+24V", "+28V", "+36V", "+48V", "-5V",
    "-5VA", "-6V", "-8V", "-9V", "-12V", "-12VA", "-15V", "-24V", "-36V", "-48V",
];

/// A macro's rail parameter: a power port whenever the name reads as a rail (a rail drawn as a local
/// label never joins other sheets and trips KiCad's single-pin-label ERC); anything else stays a label.
fn rail_or_label(name: &str, at: Endpoint) -> Op {
    let n = name.trim_start_matches('/');
    if sch_model::looks_like_rail(n) {
        Op::PlacePowerPort {
            lib_id: format!("power:{}", power_glyph(n)),
            net_name: n.to_string(),
            at: Anchor::Endpoint(at),
            rotation: None,
        }
    } else {
        label(name, at)
    }
}

/// Whether `name` carries `token` as a whole token: delimited by a non-alphanumeric character or
/// by the ends of the name, compared without ASCII case. `USB_5V` carries `5V`; `AUX15V` and
/// `VCC5V` do not (the digits run into a letter, so the name is not naming that rail).
fn carries_token(name: &str, token: &str) -> bool {
    let n = name.to_ascii_uppercase();
    let t = token.to_ascii_uppercase();
    let b = n.as_bytes();
    let mut from = 0usize;
    while from <= n.len() {
        let Some(i) = n[from..].find(&t) else {
            return false;
        };
        let (s, e) = (from + i, from + i + t.len());
        let before = s == 0 || !b[s - 1].is_ascii_alphanumeric();
        let after = e == b.len() || !b[e].is_ascii_alphanumeric();
        if before && after {
            return true;
        }
        from = s + 1;
    }
    false
}

/// Stock glyph for a rail name: its own symbol when KiCad ships one, else the stock rail whose
/// name the rail carries (`USB_5V` -> `+5V`, `VDD_3V3` -> `+3V3`, `-12V_FAN` -> `-12V`), else
/// GND / VEE / VCC by class.
///
/// The borrow is deterministic: exact match first, then ground class, then the longest stock rail
/// of the same polarity carried as a whole token (see [`carries_token`], so `MYRAIL` and `VCC5V`
/// fall through), then the class glyph. A borrowed glyph changes only the drawing - the real name
/// travels in the symbol's Value, and KiCad names a power net after the Value, not the symbol.
pub fn power_glyph(rail: &str) -> &str {
    if KNOWN_POWER_SYMBOLS.contains(&rail) {
        return rail;
    }
    if sch_model::is_ground_net(rail) {
        return "GND";
    }
    let negative = rail.starts_with('-');
    let sign = if negative { '-' } else { '+' };
    let mut best: Option<&'static str> = None;
    for sym in KNOWN_POWER_SYMBOLS {
        let Some(core) = sym.strip_prefix(sign) else {
            continue;
        };
        if !carries_token(rail, core) {
            continue;
        }
        // Longest first, so `USB_5VA` borrows `+5VA` rather than `+5V`.
        if best.is_none_or(|b| b.len() < sym.len()) {
            best = Some(sym);
        }
    }
    if let Some(b) = best {
        return b;
    }
    if negative {
        "VEE"
    } else {
        "VCC"
    }
}

/// One wire between two adjacent pins with the net label on its midpoint (`connect_and_label`): the
/// internal node of a chain macro is drawn, not implied by two labels.
fn wire_mid(a: Endpoint, b: Endpoint, name: &str) -> Op {
    Op::RouteNet {
        from: a,
        to: b,
        style: "hv".into(),
        label: Some(name.to_string()),
        scope: Scope::Local,
    }
}

/// One L-shaped wire between two pins, no label (the label sits on one of the pins).
fn wire(a: Endpoint, b: Endpoint) -> Op {
    Op::RouteNet {
        from: a,
        to: b,
        style: "hv".into(),
        label: None,
        scope: Scope::Local,
    }
}

fn label(name: &str, at: Endpoint) -> Op {
    Op::AddNetLabel {
        name: name.to_string(),
        at: Anchor::Endpoint(at),
        scope: Scope::Local,
        rotation: None,
    }
}

/// Field template for an op (for `ops.template`).
pub fn template(op: &str, required_only: bool) -> Option<Value> {
    use serde_json::json;
    let t = match op {
        "place_component" => {
            json!({"op":"place_component","lib_id":"Device:R","designator":"R1","x_mil":0,"y_mil":0,"rotation":0,"mirror":"none","unit":1,"value":"10k","footprint":"","group":"","sheet":"","note":"","no_nudge":false})
        }
        "delete_component" => json!({"op":"delete_component","designator":"R1","cascade":false}),
        "delete_object" => {
            json!({"op":"delete_object","uuid":"","match":{"kind":"wire","at":[0,0],"name":"","between":[[0,0],[0,0]]}})
        }
        "move_component" => {
            json!({"op":"move_component","designator":"R1","uuid":"","x_mil":0,"y_mil":0,"carry_labels":true,"carry_wires":true,"carry_power":true})
        }
        "set_component_transform" => {
            json!({"op":"set_component_transform","designator":"R1","uuid":"","rotation":90,"mirror":"none"})
        }
        "set_component_parameters" => {
            // `value`/`footprint` are the built-in fields; `parameters` is only for custom fields. Empty strings mean unchanged.
            json!({"op":"set_component_parameters","designator":"R1","new_designator":"","value":"10k","footprint":"","parameters":{}})
        }
        "set_component_attributes" => {
            json!({"op":"set_component_attributes","designator":"R1","dnp":false,"in_bom":true,"on_board":true})
        }
        "add_wire" => json!({"op":"add_wire","vertices":[[0,0],[100,0]]}),
        "route_net" => {
            json!({"op":"route_net","from":"R1.2","to":"C1.1","style":"auto","label":"","scope":"local"})
        }
        "add_junction" => json!({"op":"add_junction","at":[0,0]}),
        "add_no_connect" => json!({"op":"add_no_connect","pin":"U1.7"}),
        "add_net_label" => {
            json!({"op":"add_net_label","name":"NET","at":"R1.1","scope":"local","rotation":0})
        }
        "place_power_port" => {
            json!({"op":"place_power_port","lib_id":"power:GND","net_name":"GND","at":"C1.2","rotation":0})
        }
        "place_gnd" => json!({"op":"place_gnd","at":"C1.2"}),
        "place_vcc" => json!({"op":"place_vcc","at":"C1.1","net_name":"VCC"}),
        // `scope` (local|global|hierarchical) says how far the rename reaches; omitted, it is read
        // off the labels that carry the name today, and a name spelled as two kinds is refused.
        // (`sheet`, as on every op, routes it to the file that carries the label.)
        "rename_net" => json!({"op":"rename_net","old_name":"OLD","new_name":"NEW","scope":""}),
        "add_bus" => json!({"op":"add_bus","vertices":[[0,0],[1000,0]]}),
        "add_bus_entry" => json!({"op":"add_bus_entry","at":[0,0],"size":[100,100]}),
        "add_text" => json!({"op":"add_text","text":"Block","at":[0,0],"angle":0,"key":""}),
        "add_rectangle" => {
            json!({"op":"add_rectangle","start":[0,0],"end":[1000,1000],"stroke_width_mil":0,"fill":"none","key":""})
        }
        "add_text_box" => {
            json!({"op":"add_text_box","text":"","at":[0,0],"size":[1000,500],"angle":0,"key":""})
        }
        "add_sheet" => {
            json!({"op":"add_sheet","name":"power","file":"power.kicad_sch","at":[0,0],"pins":[{"name":"VIN","type":"input","side":"left"}],"create":true,"paper":""})
        }
        "add_sheet_pin" => {
            json!({"op":"add_sheet_pin","sheet":"power","name":"VIN","type":"input","side":"left","offset_mil":100})
        }
        "delete_sheet_pin" => json!({"op":"delete_sheet_pin","sheet":"power","name":"VIN"}),
        "resize_sheet" => json!({"op":"resize_sheet","sheet":"power","size":[1200,800]}),
        "set_title_block" => {
            json!({"op":"set_title_block","title":"","date":"","rev":"","company":"","comment1":""})
        }
        "place_divider" => {
            json!({"op":"place_divider","x_mil":0,"y_mil":0,"top_net":"VBUS","mid_net":"VSENSE","bottom_net":"GND","designators":["R1","R2"],"values":["100k","27k"],"spacing_mil":500,"footprint":"Resistor_SMD:R_0603_1608Metric"})
        }
        "place_decoupling" => {
            json!({"op":"place_decoupling","power_net":"+3V3","near":"U1.3","designator":"C1","value":"100n","gnd_net":"GND"})
        }
        "place_pullup" => {
            json!({"op":"place_pullup","net":"SDA","rail_net":"+3V3","x_mil":0,"y_mil":0,"designator":"R1","value":"4.7k","footprint":"Resistor_SMD:R_0603_1608Metric"})
        }
        "place_led_indicator" => {
            json!({"op":"place_led_indicator","x_mil":0,"y_mil":0,"net":"PA5","designators":["R1","D1"],"r_value":"1k","gnd_net":"GND"})
        }
        "place_rc_filter" => {
            json!({"op":"place_rc_filter","x_mil":0,"y_mil":0,"in_net":"IN","out_net":"OUT","designators":["R1","C1"],"r_value":"1k","c_value":"100n","r_footprint":"Resistor_SMD:R_0603_1608Metric","c_footprint":"Capacitor_SMD:C_0603_1608Metric"})
        }
        "place_crystal" => {
            json!({"op":"place_crystal","x_mil":0,"y_mil":0,"in_net":"XIN","out_net":"XOUT","designators":["Y1","C1","C2"],"value":"8MHz","load_c":"12p"})
        }
        "place_array" => {
            // `pin1_labels` / `pin2_labels` take one net name per element (alias `pin1_nets` /
            // `pin2_nets`); `pin1_rail` / `pin2_rail` put the same rail on every element as a
            // power port. Pin numbers are fixed: the macro wires 2-pin parts.
            json!({"op":"place_array","lib_id":"Device:R","designator_prefix":"R","count":4,"x_mil":0,"y_mil":0,"pitch_mil":400,"direction":"right","start_index":1,"rotation":0,"value":"10k","footprint":"","pin1_labels":["IN0","IN1","IN2","IN3"],"pin2_rail":"GND"})
        }
        "connect_and_label" => {
            json!({"op":"connect_and_label","from":"R1.2","to":"C1.1","net":"OUT"})
        }
        "place_pwr_flag" => json!({"op":"place_pwr_flag","at":"J1.1"}),
        "arrange_group" => {
            json!({"op":"arrange_group","group":"","region_mil":[[0,0],[0,0]],"pitch_mil":600,"pitch_y_mil":400,"designators":[],"only_unwired":true})
        }
        "terminate_unused_unit" => {
            json!({"op":"terminate_unused_unit","designator":"U1","lib_id":"Amplifier_Operational:LM358","unit":2,"at":[0,0],"in_plus":"5","in_minus":"6","out":"7","vcc":"VCC","gnd":"GND"})
        }
        _ => return None,
    };
    if required_only {
        // Best-effort: strip empty strings and defaults for a compact template.
        if let Value::Object(m) = &t {
            let m2: serde_json::Map<String, Value> = m
                .iter()
                .filter(|(_, v)| !matches!(v, Value::String(s) if s.is_empty()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            return Some(Value::Object(m2));
        }
    }
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    // F13: an unknown op name must come back with something the model can act on in one retry.
    #[test]
    fn unknown_op_carries_remediation() {
        let list = OpList::from_json(
            r#"{"protocol_version":1,"ops":[{"op":"add_symbol","lib_id":"Device:R"}]}"#,
        )
        .unwrap();
        let errs = expand(&list).unwrap_err();
        let e = errs
            .iter()
            .find(|e| e.message.contains("add_symbol"))
            .unwrap();
        let rem = e.remediation.as_deref().unwrap_or("");
        assert!(!rem.is_empty(), "unknown op has no remediation: {e:?}");
        assert!(rem.contains("place_component"), "{rem}");
    }

    #[test]
    fn nearest_ops_finds_the_real_name() {
        assert!(nearest_ops("add_symbol").contains(&"place_component"));
        assert!(nearest_ops("add_hierarchical_pin").contains(&"add_sheet_pin"));
        assert!(nearest_ops("add_wier").contains(&"add_wire"));
        assert!(nearest_ops("zzzzzzzzzzzzzzzz").is_empty());
    }

    // The three names models invent that have no op at all: the remediation must name the
    // action that replaces them, not a lookalike op.
    #[test]
    fn non_ops_say_what_to_do_instead() {
        let root = unknown_op_remediation("create_root_schematic");
        assert!(
            root.contains("already exists") && root.contains("add_sheet"),
            "{root}"
        );
        let ann = unknown_op_remediation("annotate");
        assert!(ann.contains("lease"), "{ann}");
        let erc = unknown_op_remediation("run_erc");
        assert!(erc.contains("sch.check"), "{erc}");
    }

    #[test]
    fn expands_macro_and_groups() {
        let src = r#"{"protocol_version":1,"groups":{"ldo":{"origin_mil":[1000,2000]}},"ops":[
          {"op":"place_decoupling","group":"ldo","power_net":"+3V3","x_mil":100,"y_mil":0,"designator":"C1"},
          {"op":"add_wire","vertices":[[0,0],[100,0]]}
        ]}"#;
        let list = OpList::from_json(src).unwrap();
        let ex = expand(&list).unwrap();
        assert_eq!(ex.ops.len(), 4);
        assert_eq!(ex.mapping, vec![vec![0, 1, 2], vec![3]]);
        match &ex.ops[0].op {
            Op::PlaceComponent {
                place: Place::At(p),
                ..
            } => assert_eq!(*p, Pt::new(mil_to_nm(1100.0), mil_to_nm(2000.0))),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn set_component_parameters_folds_builtin_fields_from_parameters() {
        let list = OpList::from_json(
            r#"{"protocol_version":1,"ops":[
              {"op":"set_component_parameters","designator":"R1","parameters":{"value":"2k2","datasheet":"x.pdf"}},
              {"op":"set_component_parameters","designator":"R2","value":"","footprint":"","parameters":{"Footprint":"Resistor_SMD:R_0603_1608Metric"}}
            ]}"#,
        )
        .unwrap();
        let ex = expand(&list).unwrap();
        match &ex.ops[0].op {
            Op::SetComponentParameters {
                value, parameters, ..
            } => {
                assert_eq!(value.as_deref(), Some("2k2"));
                assert!(!parameters.contains_key("value"));
                assert_eq!(
                    parameters.get("Datasheet").map(String::as_str),
                    Some("x.pdf")
                );
            }
            other => panic!("{other:?}"),
        }
        match &ex.ops[1].op {
            Op::SetComponentParameters {
                value,
                footprint,
                parameters,
                ..
            } => {
                assert_eq!(*value, None);
                assert_eq!(footprint.as_deref(), Some("Resistor_SMD:R_0603_1608Metric"));
                assert!(parameters.is_empty());
            }
            other => panic!("{other:?}"),
        }
        let bad = OpList::from_json(r#"{"protocol_version":1,"ops":[{"op":"set_component_parameters","designator":"R1","value":"1k","parameters":{"Value":"2k2"}}]}"#).unwrap();
        let errs = expand(&bad).unwrap_err();
        assert_eq!(errs[0].code, "OPLIST_CONSTRAINT");
        assert!(errs[0].message.contains("disagree"));
    }

    #[test]
    fn pwr_flag_cannot_be_used_as_a_rail_port() {
        let bad = OpList::from_json(r#"{"protocol_version":1,"ops":[{"op":"place_power_port","lib_id":"power:PWR_FLAG","net_name":"VBUS","at":"J1.1"}]}"#).unwrap();
        let errs = expand(&bad).unwrap_err();
        assert_eq!(errs[0].code, "OPLIST_CONSTRAINT");
        assert!(errs[0].message.contains("place_pwr_flag"));
        let ok = OpList::from_json(r#"{"protocol_version":1,"ops":[{"op":"place_power_port","lib_id":"power:PWR_FLAG","net_name":"PWR_FLAG","at":"J1.1"},{"op":"place_pwr_flag","at":"J1.1"}]}"#).unwrap();
        assert!(expand(&ok).is_ok());
    }

    #[test]
    fn blank_names_and_bare_deletes_are_refused() {
        for op in [
            r#"{"op":"add_net_label","name":"","at":"R1.1"}"#,
            r#"{"op":"rename_net","old_name":"","new_name":"GND"}"#,
            r#"{"op":"connect_and_label","from":"R1.2","to":"C1.1","net":" "}"#,
            r#"{"op":"place_power_port","lib_id":"power:GND","net_name":"","at":"R1.1"}"#,
            r#"{"op":"delete_object"}"#,
        ] {
            let list =
                OpList::from_json(&format!(r#"{{"protocol_version":1,"ops":[{op}]}}"#)).unwrap();
            let errs = expand(&list).expect_err(op);
            assert!(
                errs[0].code == "OPLIST_CONSTRAINT" || errs[0].code == "OPLIST_SCHEMA",
                "{op}: {errs:?}"
            );
        }
        // route_net with label "" (the template's placeholder) routes without a label instead of writing (label "").
        let ok = OpList::from_json(r#"{"protocol_version":1,"ops":[{"op":"route_net","from":"C2.2","to":"C3.2","label":"","scope":"local"}]}"#).unwrap();
        let ex = expand(&ok).unwrap();
        match &ex.ops[0].op {
            Op::RouteNet { label, .. } => assert!(label.is_none()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn group_origins_are_snapped_to_the_grid_even_for_exact_placements() {
        let list = OpList::from_json(r#"{"protocol_version":1,"groups":{"led":{"origin_mil":[4166,20]}},"ops":[{"op":"place_component","group":"led","lib_id":"Device:R","designator":"R1","x_mil":1500,"y_mil":1300,"exact":true}]}"#).unwrap();
        let ex = expand(&list).unwrap();
        match &ex.ops[0].op {
            Op::PlaceComponent {
                place: Place::At(p),
                ..
            } => {
                assert_eq!(*p, Pt::new(mil_to_nm(5650.0), mil_to_nm(1300.0)));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejects_bad_ops() {
        let list = OpList::from_json(r#"{"protocol_version":1,"ops":[{"op":"place_component","lib_id":"Device:R","designator":"R1"},{"op":"nope"},{"op":"set_component_parameters","designator":"R1","parameters":{"dnp":"yes"}}]}"#).unwrap();
        let errs = expand(&list).unwrap_err();
        assert_eq!(errs.len(), 3);
        assert_eq!(errs[0].code, "OPLIST_CONSTRAINT");
        assert_eq!(errs[1].code, "OPLIST_SCHEMA");
        assert!(errs[2].message.contains("set_component_attributes"));
    }

    #[test]
    fn pin_refs() {
        assert_eq!(
            parse_pin_ref("U1#u2.7"),
            Some(("U1".into(), Some(2), "7".into()))
        );
        assert_eq!(parse_pin_ref("R1.1"), Some(("R1".into(), None, "1".into())));
        assert_eq!(parse_pin_ref("R1"), None);
    }

    #[test]
    fn every_op_has_template() {
        for op in CORE_OPS.iter().chain(MACRO_OPS.iter()) {
            let t = template(op, false).unwrap_or_else(|| panic!("no template for {op}"));
            let list = OpList {
                protocol_version: 1,
                target_format: "kicad".into(),
                groups: BTreeMap::new(),
                sheets: BTreeMap::new(),
                ops: vec![t],
            };
            // templates with empty strings may fail constraints; schema must at least be recognised
            match expand(&list) {
                Ok(_) => {}
                Err(e) => assert_ne!(e[0].message, format!("unknown op `{op}`")),
            }
        }
    }
}
