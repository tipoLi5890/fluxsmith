// SPDX-License-Identifier: Apache-2.0
//! Own writer for KiCad symbol and footprint libraries (red line 10: no
//! KicadModTree). Input is fluxsmith's normalised `PartSpec`; the Sourcer
//! agent maps EasyEDA / vendor data into it. Every output is a CLAIM.

use serde::{Deserialize, Serialize};
use std::fmt::Write;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinSpec {
    pub number: String,
    pub name: String,
    /// input|output|bidirectional|tri_state|passive|free|unspecified|power_in|power_out|open_collector|open_emitter|no_connect
    #[serde(default = "default_pin_type")]
    pub kind: String,
    /// left|right|top|bottom
    #[serde(default = "default_side")]
    pub side: String,
}

fn default_pin_type() -> String {
    "passive".into()
}
fn default_side() -> String {
    "left".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PadSpec {
    pub number: String,
    /// smd|thru_hole
    #[serde(default = "default_pad_kind")]
    pub kind: String,
    /// rect|roundrect|circle|oval
    #[serde(default = "default_pad_shape")]
    pub shape: String,
    pub at_mm: [f64; 2],
    pub size_mm: [f64; 2],
    #[serde(default)]
    pub drill_mm: Option<f64>,
    #[serde(default)]
    pub rotation: f64,
    /// `top` (default for smd) | `bottom` | `thru` | `npth`.
    #[serde(default)]
    pub side: Option<String>,
    /// Oval drill [w,h] mm (thru_hole only); overrides `drill_mm`.
    #[serde(default)]
    pub drill_size_mm: Option<[f64; 2]>,
    /// Custom pad outline relative to `at_mm` (shape becomes `custom`).
    #[serde(default)]
    pub polygon_mm: Vec<[f64; 2]>,
}

/// Footprint graphic primitive (mm, board y-down).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FpShape {
    Line {
        start: [f64; 2],
        end: [f64; 2],
        width: f64,
        layer: String,
    },
    Circle {
        center: [f64; 2],
        radius: f64,
        width: f64,
        layer: String,
        #[serde(default)]
        fill: bool,
    },
    Arc {
        start: [f64; 2],
        mid: [f64; 2],
        end: [f64; 2],
        width: f64,
        layer: String,
    },
    Poly {
        pts: Vec<[f64; 2]>,
        width: f64,
        layer: String,
        #[serde(default)]
        fill: bool,
    },
    Rect {
        start: [f64; 2],
        end: [f64; 2],
        width: f64,
        layer: String,
        #[serde(default)]
        fill: bool,
    },
}

/// 3D model reference for a footprint.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelRef {
    pub path: String,
    #[serde(default)]
    pub offset_mm: [f64; 3],
    #[serde(default)]
    pub rotate_deg: [f64; 3],
}

/// Symbol graphic primitive (mm, library y-up).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SymShape {
    Rect {
        start: [f64; 2],
        end: [f64; 2],
        #[serde(default)]
        fill: bool,
    },
    Circle {
        center: [f64; 2],
        radius: f64,
        #[serde(default)]
        fill: bool,
    },
    Polyline {
        pts: Vec<[f64; 2]>,
        #[serde(default)]
        fill: bool,
    },
    Arc {
        start: [f64; 2],
        mid: [f64; 2],
        end: [f64; 2],
    },
    Text {
        text: String,
        at: [f64; 2],
        #[serde(default)]
        angle: f64,
        #[serde(default)]
        size: f64,
    },
}

/// Explicit pin placement (used instead of the automatic side layout).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinPlace {
    pub number: String,
    pub at_mm: [f64; 2],
    /// KiCad pin angle: 0 = pointing right (body to the right), 90 up, 180 left, 270 down.
    pub angle: i32,
    pub length_mm: f64,
}

/// Real symbol artwork (e.g. converted from a vendor CAD source).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SymbolGraphics {
    pub shapes: Vec<SymShape>,
    pub pins: Vec<PinPlace>,
    #[serde(default)]
    pub hide_pin_names: bool,
    #[serde(default)]
    pub hide_pin_numbers: bool,
}

fn default_pad_kind() -> String {
    "smd".into()
}
fn default_pad_shape() -> String {
    "roundrect".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FootprintSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub pads: Vec<PadSpec>,
    /// Courtyard / silkscreen outline as [x,y] mm polygon (optional).
    #[serde(default)]
    pub outline_mm: Vec<[f64; 2]>,
    #[serde(default)]
    pub model_path: Option<String>,
    /// Graphic primitives with explicit layers (silk, fab, courtyard...).
    #[serde(default)]
    pub graphics: Vec<FpShape>,
    /// 3D model with offset/rotation (wins over `model_path`).
    #[serde(default)]
    pub model: Option<ModelRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartSpec {
    pub name: String,
    #[serde(default)]
    pub reference_prefix: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub keywords: String,
    #[serde(default)]
    pub datasheet: String,
    #[serde(default)]
    pub mpn: String,
    #[serde(default)]
    pub lcsc: String,
    /// Library nickname the footprint is written under (`jlc`); the symbol's Footprint property is `nick:name`.
    #[serde(default)]
    pub footprint_lib: String,
    pub pins: Vec<PinSpec>,
    #[serde(default)]
    pub footprint: Option<FootprintSpec>,
    #[serde(default)]
    pub model_step_base64: Option<String>,
    /// When present the symbol body/pins use this artwork instead of the
    /// automatic rectangular layout.
    #[serde(default)]
    pub graphics: Option<SymbolGraphics>,
    /// Extra hidden `(property)` entries written verbatim on the symbol, in
    /// order. This is where provenance and claim markers live
    /// (`fluxsmith_claim`, `fluxsmith_source`, `fluxsmith_pin_pad_mismatch`):
    /// KiCad keeps unknown properties, they travel into the schematic's
    /// `lib_symbols` cache when the part is placed, and the checks read them
    /// back from there. Names that collide with a property the writer already
    /// emits are dropped.
    #[serde(default)]
    pub properties: Vec<(String, String)>,
}

// One source of truth for the provenance property names: the checks that read them back live in
// other crates, so they are defined next to `LibSymbol` in `sch-model` and re-exported here.
pub use sch_model::{CLAIM_PROPERTY, CLAIM_UNVERIFIED, PIN_PAD_MISMATCH_PROPERTY, SOURCE_PROPERTY};

fn q(s: &str) -> String {
    kicad_sexpr::quote(s)
}

/// Format a millimetre value the way KiCad writes it (max 4 decimals, no trailing zeros).
pub fn f(v: f64) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" {
        "0".into()
    } else {
        s.to_string()
    }
}

fn validate_name(n: &str) -> Result<(), String> {
    if n.is_empty() || n.contains(['/', '\\', ':', '"']) || n.len() > 200 {
        return Err(format!("invalid name {n:?}"));
    }
    Ok(())
}

/// Generate the `(symbol ...)` node text for a part: rectangular body,
/// pins on 2.54 mm pitch by side, KiCad 10 lib format.
pub fn symbol_node(p: &PartSpec) -> Result<String, String> {
    validate_name(&p.name)?;
    if p.pins.is_empty() {
        return Err("a symbol needs at least one pin".into());
    }
    let sides = ["left", "right", "top", "bottom"];
    let count = |s: &str| p.pins.iter().filter(|x| x.side == s).count() as i64;
    let (nl, nr, nt, nb) = (count("left"), count("right"), count("top"), count("bottom"));
    let rows = nl.max(nr).max(1);
    let cols = nt.max(nb).max(1);
    let pitch = 2.54;
    let half_h = ((rows + 1) as f64 * pitch / 2.0).max(2.54 * 2.0);
    let half_w = ((cols + 1) as f64 * pitch / 2.0).max(2.54 * 3.0);
    let pin_len = 2.54;
    let prefix = if p.reference_prefix.is_empty() {
        "U"
    } else {
        &p.reference_prefix
    };
    let mut s = String::new();
    let (half_w, half_h) = match &p.graphics {
        Some(g) => {
            let (mut mx, mut my) = (2.54_f64, 2.54_f64);
            for pin in &g.pins {
                mx = mx.max(pin.at_mm[0].abs());
                my = my.max(pin.at_mm[1].abs());
            }
            for sh in &g.shapes {
                for pt in shape_points(sh) {
                    mx = mx.max(pt[0].abs());
                    my = my.max(pt[1].abs());
                }
            }
            (mx, my)
        }
        None => (half_w, half_h),
    };
    let _ = writeln!(s, "\t(symbol {}", q(&p.name));
    if let Some(g) = &p.graphics {
        if g.hide_pin_names {
            let _ = writeln!(s, "\t\t(pin_names\n\t\t\t(hide yes)\n\t\t)");
        }
        if g.hide_pin_numbers {
            let _ = writeln!(s, "\t\t(pin_numbers\n\t\t\t(hide yes)\n\t\t)");
        }
    }
    let _ = writeln!(
        s,
        "\t\t(exclude_from_sim no)\n\t\t(in_bom yes)\n\t\t(on_board yes)"
    );
    let props = [
        (
            "Reference",
            prefix.to_string(),
            -half_w,
            half_h + 1.27,
            false,
        ),
        (
            "Value",
            if p.value.is_empty() {
                p.name.clone()
            } else {
                p.value.clone()
            },
            -half_w,
            -half_h - 1.27,
            false,
        ),
        (
            "Footprint",
            p.footprint
                .as_ref()
                .map(|fp| {
                    if p.footprint_lib.is_empty() {
                        fp.name.clone()
                    } else {
                        format!("{}:{}", p.footprint_lib, fp.name)
                    }
                })
                .unwrap_or_default(),
            0.0,
            -half_h - 3.81,
            true,
        ),
        ("Datasheet", p.datasheet.clone(), 0.0, -half_h - 6.35, true),
        (
            "Description",
            p.description.clone(),
            0.0,
            -half_h - 8.89,
            true,
        ),
    ];
    for (k, v, x, y, hide) in props {
        let _ = writeln!(s, "\t\t(property {} {}\n\t\t\t(at {} {} 0)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(justify left){}\n\t\t\t)\n\t\t)", q(k), q(&v), f(x), f(y), if hide { "\n\t\t\t\t(hide yes)" } else { "" });
    }
    if !p.keywords.is_empty() {
        let _ = writeln!(s, "\t\t(property \"ki_keywords\" {}\n\t\t\t(at 0 0 0)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(hide yes)\n\t\t\t)\n\t\t)", q(&p.keywords));
    }
    for (k, v) in [("MPN", &p.mpn), ("LCSC", &p.lcsc)] {
        if !v.is_empty() {
            let _ = writeln!(s, "\t\t(property {} {}\n\t\t\t(at 0 0 0)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(hide yes)\n\t\t\t)\n\t\t)", q(k), q(v));
        }
    }
    // Provenance / claim markers. `hide yes` keeps them off the canvas; KiCad round-trips them.
    let mut written: Vec<&str> = vec![
        "Reference",
        "Value",
        "Footprint",
        "Datasheet",
        "Description",
        "ki_keywords",
        "MPN",
        "LCSC",
        "ki_fp_filters",
    ];
    for (k, v) in &p.properties {
        if k.is_empty() || written.contains(&k.as_str()) {
            continue;
        }
        written.push(k.as_str());
        let _ = writeln!(s, "\t\t(property {} {}\n\t\t\t(at 0 0 0)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(hide yes)\n\t\t\t)\n\t\t)", q(k), q(v));
    }
    let _ = writeln!(s, "\t\t(property \"ki_fp_filters\" {}\n\t\t\t(at 0 0 0)\n\t\t\t(effects\n\t\t\t\t(font\n\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t)\n\t\t\t\t(hide yes)\n\t\t\t)\n\t\t)", q(&p.footprint.as_ref().map(|fp| format!("{}*", fp.name.split(':').next_back().unwrap_or(&fp.name))).unwrap_or_default()));
    if let Some(g) = &p.graphics {
        write_graphics_units(&mut s, p, g, pin_len);
        let _ = writeln!(s, "\t\t(embedded_fonts no)\n\t)");
        return Ok(s);
    }
    // Unit 0 body
    let _ = writeln!(s, "\t\t(symbol {}\n\t\t\t(rectangle\n\t\t\t\t(start {} {})\n\t\t\t\t(end {} {})\n\t\t\t\t(stroke\n\t\t\t\t\t(width 0.254)\n\t\t\t\t\t(type default)\n\t\t\t\t)\n\t\t\t\t(fill\n\t\t\t\t\t(type background)\n\t\t\t\t)\n\t\t\t)\n\t\t)", q(&format!("{}_0_1", p.name)), f(-half_w), f(half_h), f(half_w), f(-half_h));
    // Unit 1 pins
    let _ = writeln!(s, "\t\t(symbol {}", q(&format!("{}_1_1", p.name)));
    for side in sides {
        let pins: Vec<&PinSpec> = p.pins.iter().filter(|x| x.side == side).collect();
        let n = pins.len() as i64;
        for (i, pin) in pins.iter().enumerate() {
            let i = i as i64;
            let (x, y, angle) = match side {
                "left" => (
                    -half_w - pin_len,
                    (n - 1) as f64 * pitch / 2.0 - i as f64 * pitch,
                    0,
                ),
                "right" => (
                    half_w + pin_len,
                    (n - 1) as f64 * pitch / 2.0 - i as f64 * pitch,
                    180,
                ),
                "top" => (
                    -(n - 1) as f64 * pitch / 2.0 + i as f64 * pitch,
                    half_h + pin_len,
                    270,
                ),
                _ => (
                    -(n - 1) as f64 * pitch / 2.0 + i as f64 * pitch,
                    -half_h - pin_len,
                    90,
                ),
            };
            let (x, y) = (snap(x), snap(y));
            let kind = match pin.kind.as_str() {
                "input" | "output" | "bidirectional" | "tri_state" | "passive" | "free"
                | "unspecified" | "power_in" | "power_out" | "open_collector" | "open_emitter"
                | "no_connect" => pin.kind.as_str(),
                _ => "passive",
            };
            let _ = writeln!(s, "\t\t\t(pin {kind} line\n\t\t\t\t(at {} {} {angle})\n\t\t\t\t(length {})\n\t\t\t\t(name {}\n\t\t\t\t\t(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t\t(number {}\n\t\t\t\t\t(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t)", f(x), f(y), f(pin_len), q(&pin.name), q(&pin.number));
        }
    }
    let _ = writeln!(s, "\t\t)\n\t\t(embedded_fonts no)\n\t)");
    Ok(s)
}

fn snap(v: f64) -> f64 {
    (v / 1.27).round() * 1.27
}

fn shape_points(sh: &SymShape) -> Vec<[f64; 2]> {
    match sh {
        SymShape::Rect { start, end, .. } => vec![*start, *end],
        SymShape::Circle { center, radius, .. } => vec![
            [center[0] - radius, center[1] - radius],
            [center[0] + radius, center[1] + radius],
        ],
        SymShape::Polyline { pts, .. } => pts.clone(),
        SymShape::Arc { start, mid, end } => vec![*start, *mid, *end],
        SymShape::Text { at, .. } => vec![*at],
    }
}

const STROKE: &str =
    "\t\t\t\t(stroke\n\t\t\t\t\t(width 0.254)\n\t\t\t\t\t(type default)\n\t\t\t\t)";

fn fill(kind: bool) -> String {
    format!(
        "\t\t\t\t(fill\n\t\t\t\t\t(type {})\n\t\t\t\t)",
        if kind { "background" } else { "none" }
    )
}

/// Emit `<name>_0_1` (artwork) and `<name>_1_1` (pins) from explicit graphics.
fn write_graphics_units(s: &mut String, p: &PartSpec, g: &SymbolGraphics, default_len: f64) {
    let _ = writeln!(s, "\t\t(symbol {}", q(&format!("{}_0_1", p.name)));
    for sh in &g.shapes {
        match sh {
            SymShape::Rect {
                start,
                end,
                fill: fl,
            } => {
                let _ = writeln!(s, "\t\t\t(rectangle\n\t\t\t\t(start {} {})\n\t\t\t\t(end {} {})\n{STROKE}\n{}\n\t\t\t)", f(start[0]), f(start[1]), f(end[0]), f(end[1]), fill(*fl));
            }
            SymShape::Circle {
                center,
                radius,
                fill: fl,
            } => {
                let _ = writeln!(s, "\t\t\t(circle\n\t\t\t\t(center {} {})\n\t\t\t\t(radius {})\n{STROKE}\n{}\n\t\t\t)", f(center[0]), f(center[1]), f(*radius), fill(*fl));
            }
            SymShape::Polyline { pts, fill: fl } => {
                if pts.len() < 2 {
                    continue;
                }
                let xs: Vec<String> = pts
                    .iter()
                    .map(|pt| format!("\t\t\t\t\t(xy {} {})", f(pt[0]), f(pt[1])))
                    .collect();
                let _ = writeln!(
                    s,
                    "\t\t\t(polyline\n\t\t\t\t(pts\n{}\n\t\t\t\t)\n{STROKE}\n{}\n\t\t\t)",
                    xs.join("\n"),
                    fill(*fl)
                );
            }
            SymShape::Arc { start, mid, end } => {
                let _ = writeln!(s, "\t\t\t(arc\n\t\t\t\t(start {} {})\n\t\t\t\t(mid {} {})\n\t\t\t\t(end {} {})\n{STROKE}\n{}\n\t\t\t)", f(start[0]), f(start[1]), f(mid[0]), f(mid[1]), f(end[0]), f(end[1]), fill(false));
            }
            SymShape::Text {
                text,
                at,
                angle,
                size,
            } => {
                let sz = if *size > 0.0 { *size } else { 1.27 };
                let _ = writeln!(s, "\t\t\t(text {}\n\t\t\t\t(at {} {} {})\n\t\t\t\t(effects\n\t\t\t\t\t(font\n\t\t\t\t\t\t(size {} {})\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t)", q(text), f(at[0]), f(at[1]), f(*angle), f(sz), f(sz));
            }
        }
    }
    let _ = writeln!(s, "\t\t)");
    let _ = writeln!(s, "\t\t(symbol {}", q(&format!("{}_1_1", p.name)));
    for pl in &g.pins {
        let spec = p.pins.iter().find(|x| x.number == pl.number);
        let name = spec.map(|x| x.name.as_str()).unwrap_or("");
        let kind = match spec.map(|x| x.kind.as_str()).unwrap_or("passive") {
            k @ ("input" | "output" | "bidirectional" | "tri_state" | "passive" | "free"
            | "unspecified" | "power_in" | "power_out" | "open_collector" | "open_emitter"
            | "no_connect") => k,
            _ => "passive",
        };
        let len = if pl.length_mm > 0.0 {
            pl.length_mm
        } else {
            default_len
        };
        let angle = ((pl.angle % 360) + 360) % 360;
        let _ = writeln!(s, "\t\t\t(pin {kind} line\n\t\t\t\t(at {} {} {angle})\n\t\t\t\t(length {})\n\t\t\t\t(name {}\n\t\t\t\t\t(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t\t(number {}\n\t\t\t\t\t(effects\n\t\t\t\t\t\t(font\n\t\t\t\t\t\t\t(size 1.27 1.27)\n\t\t\t\t\t\t)\n\t\t\t\t\t)\n\t\t\t\t)\n\t\t\t)", f(pl.at_mm[0]), f(pl.at_mm[1]), f(len), q(name), q(&pl.number));
    }
    let _ = writeln!(s, "\t\t)");
}

/// Write (or append to) a `.kicad_sym` library.
pub fn write_symbol_lib(existing: Option<&str>, p: &PartSpec) -> Result<String, String> {
    let node = symbol_node(p)?;
    match existing {
        Some(text) if text.trim_start().starts_with("(kicad_symbol_lib") => {
            let idx = text.trim_end().rfind(')').ok_or("malformed library")?;
            Ok(format!("{}{}{}\n", &text[..idx], node, &text[idx..].trim_end()))
        }
        Some(_) => Err("existing file is not a symbol library".into()),
        None => Ok(format!("(kicad_symbol_lib\n\t(version 20241209)\n\t(generator \"fluxsmith\")\n\t(generator_version \"0.1\")\n{node})\n")),
    }
}

/// Write a `.kicad_mod` footprint.
pub fn write_footprint(fp: &FootprintSpec) -> Result<String, String> {
    validate_name(&fp.name)?;
    if fp.pads.is_empty() {
        return Err("a footprint needs at least one pad".into());
    }
    let mut s = String::new();
    let smd = fp
        .pads
        .iter()
        .filter(|p| p.side.as_deref() != Some("npth"))
        .all(|p| p.kind == "smd");
    let _ = writeln!(s, "(footprint {}\n\t(version 20241229)\n\t(generator \"fluxsmith\")\n\t(generator_version \"0.1\")\n\t(layer \"F.Cu\")\n\t(descr {})\n\t(attr {})", q(&fp.name), q(&fp.description), if smd { "smd" } else { "through_hole" });
    let (minx, miny, maxx, maxy) = fp.pads.iter().fold(
        (f64::MAX, f64::MAX, f64::MIN, f64::MIN),
        |(a, b, c, d), p| {
            (
                a.min(p.at_mm[0] - p.size_mm[0] / 2.0),
                b.min(p.at_mm[1] - p.size_mm[1] / 2.0),
                c.max(p.at_mm[0] + p.size_mm[0] / 2.0),
                d.max(p.at_mm[1] + p.size_mm[1] / 2.0),
            )
        },
    );
    let (minx, miny, maxx, maxy) =
        fp.graphics
            .iter()
            .fold((minx, miny, maxx, maxy), |(a, b, c, d), g| {
                let pts: Vec<[f64; 2]> = match g {
                    FpShape::Line {
                        start, end, layer, ..
                    }
                    | FpShape::Rect {
                        start, end, layer, ..
                    } if crtyd_layer(layer) => vec![*start, *end],
                    FpShape::Circle {
                        center,
                        radius,
                        layer,
                        ..
                    } if crtyd_layer(layer) => vec![
                        [center[0] - radius, center[1] - radius],
                        [center[0] + radius, center[1] + radius],
                    ],
                    FpShape::Poly { pts, layer, .. } if crtyd_layer(layer) => pts.clone(),
                    _ => vec![],
                };
                pts.iter().fold((a, b, c, d), |(a, b, c, d), p| {
                    (a.min(p[0]), b.min(p[1]), c.max(p[0]), d.max(p[1]))
                })
            });
    let _ = writeln!(s, "\t(property \"Reference\" \"REF**\"\n\t\t(at 0 {} 0)\n\t\t(layer \"F.SilkS\")\n\t\t(uuid {})\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.1)\n\t\t\t)\n\t\t)\n\t)", f(miny - 1.5), q(&uuid_for(&fp.name, "ref")));
    let _ = writeln!(s, "\t(property \"Value\" {}\n\t\t(at 0 {} 0)\n\t\t(layer \"F.Fab\")\n\t\t(uuid {})\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)", q(&fp.name), f(maxy + 1.5), q(&uuid_for(&fp.name, "value")));
    // Courtyard rectangle (0.25 mm clearance) and outline on F.Fab.
    let cy = 0.25;
    let _ = writeln!(s, "\t(fp_rect\n\t\t(start {} {})\n\t\t(end {} {})\n\t\t(stroke\n\t\t\t(width 0.05)\n\t\t\t(type solid)\n\t\t)\n\t\t(fill no)\n\t\t(layer \"F.CrtYd\")\n\t\t(uuid {})\n\t)", f(minx - cy), f(miny - cy), f(maxx + cy), f(maxy + cy), q(&uuid_for(&fp.name, "crtyd")));
    if fp.outline_mm.len() >= 2 {
        let pts: Vec<String> = fp
            .outline_mm
            .iter()
            .map(|p| format!("\t\t\t\t(xy {} {})", f(p[0]), f(p[1])))
            .collect();
        let _ = writeln!(s, "\t(fp_poly\n\t\t(pts\n{}\n\t\t)\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type solid)\n\t\t)\n\t\t(fill no)\n\t\t(layer \"F.Fab\")\n\t\t(uuid {})\n\t)", pts.join("\n"), q(&uuid_for(&fp.name, "fab")));
    }
    for (i, g) in fp.graphics.iter().enumerate() {
        let u = q(&uuid_for(&fp.name, &format!("g{i}")));
        match g {
            FpShape::Line {
                start,
                end,
                width,
                layer,
            } => {
                let _ = writeln!(s, "\t(fp_line\n\t\t(start {} {})\n\t\t(end {} {})\n\t\t(stroke\n\t\t\t(width {})\n\t\t\t(type solid)\n\t\t)\n\t\t(layer {})\n\t\t(uuid {u})\n\t)", f(start[0]), f(start[1]), f(end[0]), f(end[1]), f(width.max(0.01)), q(layer));
            }
            FpShape::Circle {
                center,
                radius,
                width,
                layer,
                fill: fl,
            } => {
                let _ = writeln!(s, "\t(fp_circle\n\t\t(center {} {})\n\t\t(end {} {})\n\t\t(stroke\n\t\t\t(width {})\n\t\t\t(type solid)\n\t\t)\n\t\t(fill {})\n\t\t(layer {})\n\t\t(uuid {u})\n\t)", f(center[0]), f(center[1]), f(center[0] + radius), f(center[1]), f(width.max(0.01)), if *fl { "yes" } else { "no" }, q(layer));
            }
            FpShape::Arc {
                start,
                mid,
                end,
                width,
                layer,
            } => {
                let _ = writeln!(s, "\t(fp_arc\n\t\t(start {} {})\n\t\t(mid {} {})\n\t\t(end {} {})\n\t\t(stroke\n\t\t\t(width {})\n\t\t\t(type solid)\n\t\t)\n\t\t(layer {})\n\t\t(uuid {u})\n\t)", f(start[0]), f(start[1]), f(mid[0]), f(mid[1]), f(end[0]), f(end[1]), f(width.max(0.01)), q(layer));
            }
            FpShape::Poly {
                pts,
                width,
                layer,
                fill: fl,
            } => {
                if pts.len() < 3 {
                    continue;
                }
                let xs: Vec<String> = pts
                    .iter()
                    .map(|p| format!("\t\t\t(xy {} {})", f(p[0]), f(p[1])))
                    .collect();
                let _ = writeln!(s, "\t(fp_poly\n\t\t(pts\n{}\n\t\t)\n\t\t(stroke\n\t\t\t(width {})\n\t\t\t(type solid)\n\t\t)\n\t\t(fill {})\n\t\t(layer {})\n\t\t(uuid {u})\n\t)", xs.join("\n"), f(*width), if *fl { "yes" } else { "no" }, q(layer));
            }
            FpShape::Rect {
                start,
                end,
                width,
                layer,
                fill: fl,
            } => {
                let _ = writeln!(s, "\t(fp_rect\n\t\t(start {} {})\n\t\t(end {} {})\n\t\t(stroke\n\t\t\t(width {})\n\t\t\t(type solid)\n\t\t)\n\t\t(fill {})\n\t\t(layer {})\n\t\t(uuid {u})\n\t)", f(start[0]), f(start[1]), f(end[0]), f(end[1]), f(*width), if *fl { "yes" } else { "no" }, q(layer));
            }
        }
    }
    for (i, p) in fp.pads.iter().enumerate() {
        let side = p
            .side
            .as_deref()
            .unwrap_or(if p.kind == "smd" { "top" } else { "thru" });
        let custom = !p.polygon_mm.is_empty();
        let shape = if custom {
            "custom"
        } else {
            match p.shape.as_str() {
                "rect" | "roundrect" | "circle" | "oval" => p.shape.as_str(),
                _ => "roundrect",
            }
        };
        let (pad_type, layers) = match side {
            "npth" => ("np_thru_hole", "\"*.Cu\" \"*.Mask\""),
            "thru" => ("thru_hole", "\"*.Cu\" \"*.Mask\""),
            "bottom" => ("smd", "\"B.Cu\" \"B.Paste\" \"B.Mask\""),
            _ => ("smd", "\"F.Cu\" \"F.Paste\" \"F.Mask\""),
        };
        let drill = match (pad_type, p.drill_size_mm, p.drill_mm) {
            ("smd", _, _) => String::new(),
            (_, Some([w, h]), _) if (w - h).abs() > 1e-6 => {
                format!("\n\t\t(drill oval {} {})", f(w), f(h))
            }
            (_, Some([w, _]), _) => format!("\n\t\t(drill {})", f(w)),
            (_, None, Some(d)) => format!("\n\t\t(drill {})", f(d)),
            _ => "\n\t\t(drill 0.8)".to_string(),
        };
        let rr = if shape == "roundrect" {
            "\n\t\t(roundrect_rratio 0.25)"
        } else {
            ""
        };
        let prim = if custom {
            let xs: Vec<String> = p
                .polygon_mm
                .iter()
                .map(|pt| format!("\t\t\t\t\t(xy {} {})", f(pt[0]), f(pt[1])))
                .collect();
            format!("\n\t\t(options\n\t\t\t(clearance outline)\n\t\t\t(anchor rect)\n\t\t)\n\t\t(primitives\n\t\t\t(gr_poly\n\t\t\t\t(pts\n{}\n\t\t\t\t)\n\t\t\t\t(width 0)\n\t\t\t\t(fill yes)\n\t\t\t)\n\t\t)", xs.join("\n"))
        } else {
            String::new()
        };
        let _ = writeln!(s, "\t(pad {} {pad_type} {shape}\n\t\t(at {} {} {})\n\t\t(size {} {}){drill}\n\t\t(layers {layers}){rr}{prim}\n\t\t(uuid {})\n\t)", q(&p.number), f(p.at_mm[0]), f(p.at_mm[1]), f(p.rotation), f(p.size_mm[0].max(0.01)), f(p.size_mm[1].max(0.01)), q(&uuid_for(&fp.name, &format!("pad{i}"))));
    }
    if let Some(m) = &fp.model {
        let _ = writeln!(s, "\t(model {}\n\t\t(offset\n\t\t\t(xyz {} {} {})\n\t\t)\n\t\t(scale\n\t\t\t(xyz 1 1 1)\n\t\t)\n\t\t(rotate\n\t\t\t(xyz {} {} {})\n\t\t)\n\t)", q(&m.path), f(m.offset_mm[0]), f(m.offset_mm[1]), f(m.offset_mm[2]), f(m.rotate_deg[0]), f(m.rotate_deg[1]), f(m.rotate_deg[2]));
    } else if let Some(m) = &fp.model_path {
        let _ = writeln!(s, "\t(model {}\n\t\t(offset\n\t\t\t(xyz 0 0 0)\n\t\t)\n\t\t(scale\n\t\t\t(xyz 1 1 1)\n\t\t)\n\t\t(rotate\n\t\t\t(xyz 0 0 0)\n\t\t)\n\t)", q(m));
    }
    let _ = writeln!(s, "\t(embedded_fonts no)\n)");
    Ok(s)
}

fn crtyd_layer(l: &str) -> bool {
    matches!(
        l,
        "F.Cu" | "B.Cu" | "F.Paste" | "B.Paste" | "F.Mask" | "B.Mask" | "F.Fab" | "Edge.Cuts"
    )
}

fn uuid_for(name: &str, key: &str) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("fluxsmith-fp|{name}|{key}").as_bytes(),
    )
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> PartSpec {
        PartSpec {
            name: "TEST_IC".into(),
            reference_prefix: "U".into(),
            value: "TEST_IC".into(),
            description: "test".into(),
            keywords: "test ic".into(),
            datasheet: String::new(),
            mpn: "TEST-1".into(),
            lcsc: "C1".into(),
            footprint_lib: String::new(),
            pins: vec![
                PinSpec {
                    number: "1".into(),
                    name: "VDD".into(),
                    kind: "power_in".into(),
                    side: "left".into(),
                },
                PinSpec {
                    number: "2".into(),
                    name: "GND".into(),
                    kind: "power_in".into(),
                    side: "left".into(),
                },
                PinSpec {
                    number: "3".into(),
                    name: "OUT".into(),
                    kind: "output".into(),
                    side: "right".into(),
                },
            ],
            footprint: Some(FootprintSpec {
                name: "SOT-23-3".into(),
                description: "sot23".into(),
                pads: vec![
                    PadSpec {
                        number: "1".into(),
                        kind: "smd".into(),
                        shape: "roundrect".into(),
                        at_mm: [-0.95, 1.0],
                        size_mm: [0.9, 1.0],
                        drill_mm: None,
                        rotation: 0.0,
                        side: None,
                        drill_size_mm: None,
                        polygon_mm: vec![],
                    },
                    PadSpec {
                        number: "2".into(),
                        kind: "smd".into(),
                        shape: "roundrect".into(),
                        at_mm: [0.95, 1.0],
                        size_mm: [0.9, 1.0],
                        drill_mm: None,
                        rotation: 0.0,
                        side: None,
                        drill_size_mm: None,
                        polygon_mm: vec![],
                    },
                    PadSpec {
                        number: "3".into(),
                        kind: "smd".into(),
                        shape: "roundrect".into(),
                        at_mm: [0.0, -1.0],
                        size_mm: [0.9, 1.0],
                        drill_mm: None,
                        rotation: 0.0,
                        side: None,
                        drill_size_mm: None,
                        polygon_mm: vec![],
                    },
                ],
                outline_mm: vec![],
                model_path: None,
                graphics: vec![],
                model: None,
            }),
            model_step_base64: None,
            graphics: None,
            properties: vec![
                (CLAIM_PROPERTY.into(), CLAIM_UNVERIFIED.into()),
                (
                    PIN_PAD_MISMATCH_PROPERTY.into(),
                    "symbol pins 4 have no footprint pad".into(),
                ),
                // Colliding with a property the writer already emits is dropped, not duplicated.
                ("LCSC".into(), "C-BOGUS".into()),
            ],
        }
    }

    #[test]
    fn symbol_lib_parses_and_round_trips() {
        let text = write_symbol_lib(None, &spec()).unwrap();
        let doc = kicad_sexpr::parse(&text).unwrap();
        assert_eq!(kicad_sexpr::dumps(&doc), text);
        let syms = sch_read_like(&text);
        assert_eq!(syms, 1);
        let appended = write_symbol_lib(
            Some(&text),
            &PartSpec {
                name: "OTHER".into(),
                ..spec()
            },
        )
        .unwrap();
        assert!(kicad_sexpr::parse(&appended).is_ok());
        assert_eq!(sch_read_like(&appended), 2);
    }

    /// Provenance markers reach the file exactly once, hidden, and a name the writer already
    /// emits (LCSC) never becomes a second property.
    #[test]
    fn provenance_properties_are_written_once() {
        let text = write_symbol_lib(None, &spec()).unwrap();
        assert_eq!(
            text.matches("(property \"fluxsmith_claim\" \"unverified\"")
                .count(),
            1
        );
        assert!(text.contains(
            "(property \"fluxsmith_pin_pad_mismatch\" \"symbol pins 4 have no footprint pad\""
        ));
        assert_eq!(text.matches("(property \"LCSC\"").count(), 1);
        assert!(text.contains("\"C1\""));
        assert!(!text.contains("C-BOGUS"));
        assert!(kicad_sexpr::parse(&text).is_ok());
    }

    fn sch_read_like(text: &str) -> usize {
        let doc = kicad_sexpr::parse(text).unwrap();
        doc.root.children.iter().filter(|c| matches!(c, kicad_sexpr::Node::List(l) if l.name().as_deref() == Some("symbol"))).count()
    }

    #[test]
    fn footprint_parses() {
        let text = write_footprint(spec().footprint.as_ref().unwrap()).unwrap();
        let doc = kicad_sexpr::parse(&text).unwrap();
        assert_eq!(doc.root.name().as_deref(), Some("footprint"));
        assert_eq!(text.matches("(pad ").count(), 3);
    }
}
