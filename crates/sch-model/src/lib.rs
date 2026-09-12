// SPDX-License-Identifier: Apache-2.0
//! Normalised schematic model shared by reader, netbuild, writer and geometry.
//!
//! Coordinate rules (docs/engine-architecture.md, red line 3):
//! - All coordinates are integer nanometres. File values are millimetres.
//! - Schematic space is +Y down (KiCad file convention). Library symbol
//!   artwork is +Y up and is flipped exactly once, in [`transform_point`].
//! - Placement is rotate-then-mirror; the file rotation `+90` maps a local
//!   point `(x, y)` to `(y, -x)` in +Y-down space.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Integer nanometres.
pub type Nm = i64;

pub const NM_PER_MM: f64 = 1_000_000.0;
pub const NM_PER_MIL: f64 = 25_400.0;

/// Parse a KiCad millimetre string to nm (round half away from zero).
pub fn mm_str_to_nm(s: &str) -> Option<Nm> {
    let v: f64 = s.trim().parse().ok()?;
    Some(mm_to_nm(v))
}

pub fn mm_to_nm(mm: f64) -> Nm {
    (mm * NM_PER_MM).round() as Nm
}

pub fn mil_to_nm(mil: f64) -> Nm {
    (mil * NM_PER_MIL).round() as Nm
}

pub fn nm_to_mm(nm: Nm) -> f64 {
    nm as f64 / NM_PER_MM
}

pub fn nm_to_mil(nm: Nm) -> f64 {
    nm as f64 / NM_PER_MIL
}

/// Format nm as the shortest millimetre string KiCad would write
/// (KiCad prints doubles with up to 6 decimals and strips trailing zeros).
pub fn nm_to_mm_str(nm: Nm) -> String {
    let mm = nm_to_mm(nm);
    let s = format!("{mm:.6}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s == "-0" {
        "0".to_string()
    } else {
        s
    }
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
pub struct Pt {
    pub x: Nm,
    pub y: Nm,
}

impl Pt {
    pub const fn new(x: Nm, y: Nm) -> Pt {
        Pt { x, y }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, o: Pt) -> Pt {
        Pt {
            x: self.x + o.x,
            y: self.y + o.y,
        }
    }
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, o: Pt) -> Pt {
        Pt {
            x: self.x - o.x,
            y: self.y - o.y,
        }
    }
}

impl fmt::Display for Pt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", nm_to_mm_str(self.x), nm_to_mm_str(self.y))
    }
}

/// Rotation in degrees, one of 0 / 90 / 180 / 270 (file convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum Rot {
    #[default]
    R0,
    R90,
    R180,
    R270,
}

impl Rot {
    pub fn from_deg(d: f64) -> Option<Rot> {
        let d = ((d.round() as i64) % 360 + 360) % 360;
        match d {
            0 => Some(Rot::R0),
            90 => Some(Rot::R90),
            180 => Some(Rot::R180),
            270 => Some(Rot::R270),
            _ => None,
        }
    }
    pub fn deg(self) -> i64 {
        match self {
            Rot::R0 => 0,
            Rot::R90 => 90,
            Rot::R180 => 180,
            Rot::R270 => 270,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum Mirror {
    #[default]
    None,
    /// `(mirror x)`: mirrored about the X axis (Y negated).
    X,
    /// `(mirror y)`: mirrored about the Y axis (X negated).
    Y,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub struct Placement {
    pub at: Pt,
    pub rot: Rot,
    pub mirror: Mirror,
}

/// The single transform of the engine: library-local point (+Y up) to
/// schematic world point (+Y down). Rotate first, then mirror, then translate.
pub fn transform_point(local_y_up: Pt, p: Placement) -> Pt {
    // 1. flip to +Y down
    let (x, y) = (local_y_up.x, -local_y_up.y);
    // 2. rotate (file +90 => (y, -x))
    let (x, y) = match p.rot {
        Rot::R0 => (x, y),
        Rot::R90 => (y, -x),
        Rot::R180 => (-x, -y),
        Rot::R270 => (-y, x),
    };
    // 3. mirror
    let (x, y) = match p.mirror {
        Mirror::None => (x, y),
        Mirror::X => (x, -y),
        Mirror::Y => (-x, y),
    };
    Pt {
        x: p.at.x + x,
        y: p.at.y + y,
    }
}

/// Inverse of [`transform_point`] (world -> library-local, +Y up).
pub fn inverse_transform_point(world: Pt, p: Placement) -> Pt {
    let (x, y) = (world.x - p.at.x, world.y - p.at.y);
    let (x, y) = match p.mirror {
        Mirror::None => (x, y),
        Mirror::X => (x, -y),
        Mirror::Y => (-x, y),
    };
    let (x, y) = match p.rot {
        Rot::R0 => (x, y),
        Rot::R90 => (-y, x),
        Rot::R180 => (-x, -y),
        Rot::R270 => (y, -x),
    };
    Pt { x, y: -y }
}

/// Pin electrical type as written in `.kicad_sym`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PinType {
    Input,
    Output,
    Bidirectional,
    TriState,
    Passive,
    Free,
    Unspecified,
    PowerIn,
    PowerOut,
    OpenCollector,
    OpenEmitter,
    NoConnect,
}

impl PinType {
    pub fn parse(s: &str) -> PinType {
        match s {
            "input" => PinType::Input,
            "output" => PinType::Output,
            "bidirectional" => PinType::Bidirectional,
            "tri_state" => PinType::TriState,
            "passive" => PinType::Passive,
            "free" => PinType::Free,
            "power_in" => PinType::PowerIn,
            "power_out" => PinType::PowerOut,
            "open_collector" => PinType::OpenCollector,
            "open_emitter" => PinType::OpenEmitter,
            "no_connect" => PinType::NoConnect,
            _ => PinType::Unspecified,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            PinType::Input => "input",
            PinType::Output => "output",
            PinType::Bidirectional => "bidirectional",
            PinType::TriState => "tri_state",
            PinType::Passive => "passive",
            PinType::Free => "free",
            PinType::Unspecified => "unspecified",
            PinType::PowerIn => "power_in",
            PinType::PowerOut => "power_out",
            PinType::OpenCollector => "open_collector",
            PinType::OpenEmitter => "open_emitter",
            PinType::NoConnect => "no_connect",
        }
    }
}

/// A pin definition inside a library symbol (local coordinates, +Y up).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibPin {
    pub number: String,
    pub name: String,
    pub kind: PinType,
    /// Pin anchor (the connectable end) in library coordinates.
    pub at: Pt,
    /// Pin direction in degrees (0 = points right, i.e. the body is to the left).
    pub angle: i64,
    pub length: Nm,
    /// Which unit this pin belongs to (0 = all units).
    pub unit: u32,
    /// Body style / De Morgan variant (0 = all).
    pub convert: u32,
    pub hide: bool,
}

/// Scope of a power symbol: the `local` / `global` argument of `(power ...)`.
/// KiCad 9 added `(power local)`; a bare `(power)` (KiCad 8 and older) is global.
/// A global power port merges project-wide by name; a local one merges only
/// within one sheet instance and its net name carries the sheet path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum PowerScope {
    #[default]
    Global,
    Local,
}

/// Property name of the claim marker fluxsmith writes on every symbol it converted from a vendor
/// CAD source: the geometry is a CLAIM until a human checks it against the datasheet (red line 10).
pub const CLAIM_PROPERTY: &str = "fluxsmith_claim";
/// Property name holding the pin/pad mismatch detail recorded at conversion time.
pub const PIN_PAD_MISMATCH_PROPERTY: &str = "fluxsmith_pin_pad_mismatch";
/// Property name holding where the symbol was converted from (`easyeda:C14663`).
pub const SOURCE_PROPERTY: &str = "fluxsmith_source";
/// Value of [`CLAIM_PROPERTY`] on a symbol nobody has checked against the datasheet.
pub const CLAIM_UNVERIFIED: &str = "unverified";

/// A library symbol (from `lib_symbols` in a schematic or a `.kicad_sym`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibSymbol {
    /// Full id as it appears in the file, e.g. `Device:R`.
    pub id: String,
    pub pins: Vec<LibPin>,
    pub unit_count: u32,
    /// `(power)` flag: the symbol is a power port.
    pub is_power: bool,
    /// `(power local)` vs `(power global)`; meaningless when `is_power` is false.
    #[serde(default)]
    pub power_scope: PowerScope,
    /// The `(extends "Parent")` name, if this is a derived symbol.
    pub extends: Option<String>,
    pub properties: Vec<(String, String)>,
}

impl LibSymbol {
    /// Pins a placed instance of `unit` exposes: the unit's own pins plus the common
    /// (unit 0) pins, body style 1 only (De Morgan `_<unit>_2` bodies redefine the same
    /// pin numbers and must not be collected twice; I18).
    pub fn pins_for_unit(&self, unit: u32) -> impl Iterator<Item = &LibPin> {
        self.pins
            .iter()
            .filter(move |p| (p.unit == 0 || p.unit == unit) && p.convert <= 1)
    }
    pub fn property(&self, name: &str) -> Option<&str> {
        self.properties
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    /// True when this symbol came out of a fluxsmith conversion and nobody has verified it
    /// against the datasheet yet ([`CLAIM_PROPERTY`] = [`CLAIM_UNVERIFIED`]).
    pub fn unverified_claim(&self) -> bool {
        self.property(CLAIM_PROPERTY) == Some(CLAIM_UNVERIFIED)
    }
    /// The pin/pad mismatch the conversion recorded, if any.
    pub fn pin_pad_mismatch(&self) -> Option<&str> {
        self.property(PIN_PAD_MISMATCH_PROPERTY)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// A placed symbol instance in a sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolInst {
    pub uuid: String,
    pub lib_id: String,
    pub placement: Placement,
    pub unit: u32,
    pub reference: String,
    pub value: String,
    pub footprint: String,
    pub dnp: bool,
    pub in_bom: bool,
    pub on_board: bool,
    pub exclude_from_sim: bool,
    /// All `(property ...)` entries in file order (name, value).
    pub properties: Vec<(String, String)>,
    /// Per-instance-path references `(instances (project ... (path "/..." (reference "R1") (unit 1))))`.
    pub instances: Vec<InstanceRef>,
    /// Index of the `(symbol ...)` node among the root list children.
    pub node_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceRef {
    pub project: String,
    pub path: String,
    pub reference: String,
    pub unit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wire {
    pub uuid: String,
    pub a: Pt,
    pub b: Pt,
    pub is_bus: bool,
    pub node_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum LabelKind {
    Local,
    Global,
    Hierarchical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    pub uuid: String,
    pub kind: LabelKind,
    pub text: String,
    pub at: Pt,
    pub rot: i64,
    /// `(shape input|output|bidirectional|tri_state|passive)` for global/hier labels.
    pub shape: Option<String>,
    pub node_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Junction {
    pub uuid: String,
    pub at: Pt,
    pub node_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoConnect {
    pub uuid: String,
    pub at: Pt,
    pub node_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusEntry {
    pub uuid: String,
    pub at: Pt,
    pub size: Pt,
    pub node_index: usize,
}

impl BusEntry {
    pub fn end(&self) -> Pt {
        self.at.add(self.size)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetPin {
    pub name: String,
    pub shape: String,
    pub at: Pt,
    pub rot: i64,
    pub uuid: String,
}

/// A hierarchical sheet symbol placed in a parent sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetInst {
    pub uuid: String,
    pub at: Pt,
    pub size: Pt,
    pub name: String,
    pub file: String,
    pub pins: Vec<SheetPin>,
    pub instances: Vec<SheetInstanceRef>,
    pub node_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetInstanceRef {
    pub project: String,
    pub path: String,
    pub page: String,
}

/// One parsed `.kicad_sch` file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sheet {
    pub version: i64,
    pub generator: String,
    pub generator_version: String,
    pub uuid: String,
    pub paper: String,
    pub lib_symbols: Vec<LibSymbol>,
    pub symbols: Vec<SymbolInst>,
    pub wires: Vec<Wire>,
    pub labels: Vec<Label>,
    pub junctions: Vec<Junction>,
    pub no_connects: Vec<NoConnect>,
    pub bus_entries: Vec<BusEntry>,
    pub sheets: Vec<SheetInst>,
    /// Root-level `(sheet_instances (path "/" (page "1")))` entries.
    pub sheet_instances: Vec<(String, String)>,
}

impl Sheet {
    pub fn lib_symbol(&self, id: &str) -> Option<&LibSymbol> {
        self.lib_symbols.iter().find(|s| s.id == id)
    }
    pub fn symbol_by_ref<'a>(
        &'a self,
        reference: &'a str,
    ) -> impl Iterator<Item = &'a SymbolInst> + 'a {
        self.symbols
            .iter()
            .filter(move |s| s.reference == reference)
    }
}

/// World-space pin of a placed symbol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorldPin {
    pub reference: String,
    pub unit: u32,
    pub number: String,
    pub name: String,
    pub kind: PinType,
    pub at: Pt,
    pub symbol_uuid: String,
    pub is_power_symbol: bool,
    /// The power net name for power symbols (the symbol's Value).
    pub power_name: Option<String>,
    /// `(hide yes)` on the library pin. A hidden `power_in` pin on a symbol that
    /// is *not* a power symbol is KiCad's legacy implicit global power pin
    /// (`SCH_PIN::IsGlobalPower`), so netbuild needs the flag.
    #[serde(default)]
    pub hide: bool,
    /// The power symbol is `(power local)`: it merges per sheet instance, not
    /// project-wide.
    #[serde(default)]
    pub power_local: bool,
}

/// Resolve all world-space pins of a placed symbol from its library symbol.
pub fn world_pins(sym: &SymbolInst, lib: &LibSymbol) -> Vec<WorldPin> {
    lib.pins_for_unit(sym.unit)
        .map(|p| WorldPin {
            reference: sym.reference.clone(),
            unit: sym.unit,
            number: p.number.clone(),
            name: p.name.clone(),
            kind: p.kind,
            at: transform_point(p.at, sym.placement),
            symbol_uuid: sym.uuid.clone(),
            is_power_symbol: lib.is_power,
            power_name: if lib.is_power {
                Some(sym.value.clone())
            } else {
                None
            },
            hide: p.hide,
            // KiCad's SCH_PIN::IsLocalPower(): power_in pin on a `(power local)` symbol.
            power_local: lib.is_power
                && lib.power_scope == PowerScope::Local
                && p.kind == PinType::PowerIn,
        })
        .collect()
}

/// Ground-class net names (`GND`, `AGND`, `DGND`, `PGND`, `GNDREF`, `VSS*`, `VEE`): the one classifier the
/// writer (power-port pose), the checks and the macro expansion share.
pub fn is_ground_net(net: &str) -> bool {
    let u = net.trim_start_matches('/').to_ascii_uppercase();
    u.contains("GND")
        || u.starts_with("VSS")
        || u == "VEE"
        || u == "AVSS"
        || u == "DVSS"
        || u == "EARTH"
}

/// `3V3`, `3.3V`, `5V`, `5VA`, `12`: digits with an optional V / decimal and at most one trailing letter.
fn is_voltage_token(t: &str) -> bool {
    let mut chars = t.chars().peekable();
    let mut digits = 0;
    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() || *c == '.' {
            digits += 1;
            chars.next();
        } else {
            break;
        }
    }
    if digits == 0 {
        return false;
    }
    let rest: String = chars.collect();
    let rest = rest.strip_prefix('V').unwrap_or(&rest).to_string();
    let rest: String = rest
        .trim_start_matches(|c: char| c.is_ascii_digit())
        .to_string();
    rest.is_empty() || (rest.len() == 1 && rest.chars().all(|c| c.is_ascii_uppercase()))
}

/// Net names that read as supply rails (used by ERC-lite, the macro expansion and the prompts).
/// Conservative prefix set: a false positive only changes a label into a power port.
pub fn looks_like_rail(name: &str) -> bool {
    let n = name.trim_start_matches('/');
    is_ground_net(n)
        // +3V3, +3.3V, +5V, +5VA, +12V: a plus sign followed by a voltage; "+3V3_LED" is a (badly named) signal.
        || (n.starts_with('+')
            && (is_voltage_token(&n[1..])
                || matches!(
                    &n[1..],
                    "BATT" | "VBAT" | "VIN" | "VOUT" | "VSW" | "VBUS" | "VCC" | "VDD" | "VSYS" | "V"
                )))
        || n.starts_with("VCC")
        || n.starts_with("VDD")
        || n.starts_with("VBUS")
        || n.starts_with("VBAT")
        || n.starts_with("VSYS")
        || n.starts_with("VIN")
        || n.starts_with("AVDD")
        || n.starts_with("DVDD")
        || n == "VDC"
        || n == "VOUT"
        || n == "VREG"
        || n == "VCORE"
        || n.starts_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plus_rails_need_a_voltage_token() {
        assert!(looks_like_rail("+3V3"));
        assert!(looks_like_rail("+3.3V"));
        assert!(looks_like_rail("+5VA"));
        assert!(looks_like_rail("+12V"));
        assert!(looks_like_rail("GND"));
        assert!(looks_like_rail("AGND"));
        assert!(!looks_like_rail("+3V3_LED"));
        assert!(!looks_like_rail("+LED"));
        assert!(!looks_like_rail("VSENSE"));
    }

    #[test]
    fn transform_rotations() {
        let p = Placement {
            at: Pt::new(0, 0),
            rot: Rot::R0,
            mirror: Mirror::None,
        };
        // local (0, +2.54 up) -> world (0, -2.54) i.e. above the anchor
        assert_eq!(
            transform_point(Pt::new(0, 2_540_000), p),
            Pt::new(0, -2_540_000)
        );
        let p90 = Placement { rot: Rot::R90, ..p };
        // (0, up) -> y-down (0,-1) -> rot90 (y,-x) = (-1, 0)
        assert_eq!(transform_point(Pt::new(0, 1), p90), Pt::new(-1, 0));
        let pm = Placement {
            mirror: Mirror::Y,
            ..p
        };
        assert_eq!(transform_point(Pt::new(1, 0), pm), Pt::new(-1, 0));
        for rot in [Rot::R0, Rot::R90, Rot::R180, Rot::R270] {
            for mirror in [Mirror::None, Mirror::X, Mirror::Y] {
                let pl = Placement {
                    at: Pt::new(7, -3),
                    rot,
                    mirror,
                };
                let local = Pt::new(12, 34);
                assert_eq!(
                    inverse_transform_point(transform_point(local, pl), pl),
                    local
                );
            }
        }
    }

    #[test]
    fn mm_strings() {
        assert_eq!(mm_str_to_nm("30.48"), Some(30_480_000));
        assert_eq!(nm_to_mm_str(30_480_000), "30.48");
        assert_eq!(nm_to_mm_str(0), "0");
        assert_eq!(nm_to_mm_str(-1_270_000), "-1.27");
        assert_eq!(mil_to_nm(100.0), 2_540_000);
    }
}
