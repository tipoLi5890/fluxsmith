// SPDX-License-Identifier: Apache-2.0
//! Full render geometry for the self-drawn canvas (S-C1 outcome: KiCanvas is
//! not vendored; the webview draws this structure on a Canvas 2D context
//! following eeschema drawing rules).
//!
//! Every coordinate is world space in mil (`f64`, +Y down). Library-local
//! primitives are mapped with `sch_model::transform_point` — the one and only
//! transform (red line 3) — so pins land exactly where `world_pins` puts them.

use crate::{label_flag_bbox, BBox};
use kicad_sexpr::{Document, List, Node};
use sch_model::*;
use sch_read::SheetTree;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub type Mil = [f64; 2];

/// Payload precision: 0.01 mil. Everything the canvas receives is rounded here, at the JSON
/// boundary only (the model and every transform stay in integer nm; INV-24 compares whole mil).
/// Full f64 digits were ~40% of the render payload and carry no visual information.
pub fn round_mil(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn mil(p: Pt) -> Mil {
    [round_mil(nm_to_mil(p.x)), round_mil(nm_to_mil(p.y))]
}

fn mm_to_mil_f(mm: f64) -> f64 {
    round_mil(mm / 0.0254)
}

/// Bounding box in mil, rounded outwards so it still contains every point it was built from.
fn bbox_mil(bb: &BBox) -> [Mil; 2] {
    let m = bb.to_mil();
    let lo = |v: f64| (v * 100.0).floor() / 100.0;
    let hi = |v: f64| (v * 100.0).ceil() / 100.0;
    [[lo(m[0][0]), lo(m[0][1])], [hi(m[1][0]), hi(m[1][1])]]
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RStroke {
    pub width_mil: f64,
    /// `default` | `solid` | `dash` | `dot` | `dash_dot` | `dash_dot_dot`
    pub style: String,
}

impl Default for RStroke {
    fn default() -> Self {
        RStroke {
            width_mil: 0.0,
            style: "default".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RShape {
    Polyline {
        pts: Vec<Mil>,
        stroke: RStroke,
        /// `none` | `outline` | `background` | `color`
        fill: String,
    },
    Rectangle {
        a: Mil,
        b: Mil,
        stroke: RStroke,
        fill: String,
    },
    Circle {
        center: Mil,
        radius_mil: f64,
        stroke: RStroke,
        fill: String,
    },
    /// Arc through three points (direction-safe under mirroring).
    Arc {
        start: Mil,
        mid: Mil,
        end: Mil,
        center: Mil,
        radius_mil: f64,
        stroke: RStroke,
        fill: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RText {
    pub text: String,
    pub at: Mil,
    /// World rotation in degrees (0/90/180/270; text is always drawn readable).
    pub rotation: f64,
    pub size_mil: f64,
    /// `left` | `center` | `right`
    pub justify_h: String,
    /// `top` | `center` | `bottom`
    pub justify_v: String,
    pub bold: bool,
    pub italic: bool,
    pub hide: bool,
    /// `reference` | `value` | `footprint` | `datasheet` | `user` | `text` | `lib_text` | `sheet_name` | `sheet_file`
    pub role: String,
    /// Property name for `user` role (untrusted display string).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RPin {
    pub number: String,
    pub name: String,
    /// Electrical type as in `.kicad_sym` (`passive`, `input`, ...).
    pub electrical: String,
    /// Graphic style (`line`, `inverted`, `clock`, `inverted_clock`, `input_low`, `clock_low`, `output_low`, `edge_clock_high`, `non_logic`).
    pub shape: String,
    /// Connection point (identical to `world_pins`).
    pub at: Mil,
    /// Body-side end of the pin stub.
    pub end: Mil,
    /// Unit direction from `at` towards the body (world space).
    pub dir: Mil,
    pub length_mil: f64,
    pub hide: bool,
    pub name_hidden: bool,
    pub number_hidden: bool,
    pub name_size_mil: f64,
    pub number_size_mil: f64,
    /// `pin_names offset` of the library symbol (0 = names outside the body).
    pub name_offset_mil: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RSymbol {
    pub reference: String,
    pub value: String,
    pub uuid: String,
    pub lib_id: String,
    pub unit: u32,
    pub dnp: bool,
    pub is_power: bool,
    pub at: Mil,
    pub rotation: f64,
    /// `none` | `x` | `y`
    pub mirror: String,
    pub shapes: Vec<RShape>,
    pub pins: Vec<RPin>,
    pub texts: Vec<RText>,
    pub bbox: [Mil; 2],
    /// Library symbol has no body in the cache (`UNRESOLVED_LIB_ID`).
    pub unresolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RWire {
    pub uuid: String,
    pub a: Mil,
    pub b: Mil,
    pub is_bus: bool,
    pub stroke: RStroke,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RJunction {
    pub uuid: String,
    pub at: Mil,
    pub diameter_mil: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RPoint {
    pub uuid: String,
    pub at: Mil,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RSegment {
    pub uuid: String,
    pub a: Mil,
    pub b: Mil,
    pub stroke: RStroke,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RLabel {
    pub uuid: String,
    pub text: String,
    /// `local` | `global` | `hierarchical` | `netclass`
    pub kind: String,
    /// `input` | `output` | `bidirectional` | `tri_state` | `passive` (global/hier only)
    pub shape: String,
    pub at: Mil,
    pub rotation: f64,
    pub size_mil: f64,
    pub justify_h: String,
    pub justify_v: String,
    pub bbox: [Mil; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RSheetPin {
    pub uuid: String,
    pub name: String,
    pub shape: String,
    pub at: Mil,
    pub rotation: f64,
    /// `left` | `right` | `top` | `bottom`
    pub side: String,
    pub size_mil: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RSheetSymbol {
    pub uuid: String,
    pub name: String,
    pub file: String,
    pub at: Mil,
    pub size: Mil,
    pub stroke: RStroke,
    pub fill: String,
    pub pins: Vec<RSheetPin>,
    pub texts: Vec<RText>,
    pub bbox: [Mil; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RTextBox {
    pub uuid: String,
    pub text: RText,
    pub a: Mil,
    pub b: Mil,
    pub stroke: RStroke,
    pub fill: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RBox {
    pub uuid: String,
    pub bbox: [Mil; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RenderSheet {
    pub sheet_path: String,
    pub file: String,
    pub paper: String,
    /// Paper size in mm (width, height) after orientation.
    pub paper_mm: [f64; 2],
    pub title_block: BTreeMap<String, String>,
    pub symbols: Vec<RSymbol>,
    pub wires: Vec<RWire>,
    pub junctions: Vec<RJunction>,
    pub no_connects: Vec<RPoint>,
    pub bus_entries: Vec<RSegment>,
    pub labels: Vec<RLabel>,
    pub sheets: Vec<RSheetSymbol>,
    pub texts: Vec<RText>,
    pub text_boxes: Vec<RTextBox>,
    pub graphics: Vec<RShape>,
    pub images: Vec<RBox>,
    /// Union of every drawable item (mil).
    pub bbox: [Mil; 2],
}

// ---------------------------------------------------------------------------
// S-expression helpers
// ---------------------------------------------------------------------------

fn pt_nm(l: &List, name: &str) -> Option<Pt> {
    let n = l.find(name)?;
    Some(Pt::new(
        mm_str_to_nm(&n.arg(0)?)?,
        mm_str_to_nm(&n.arg(1)?)?,
    ))
}

fn at_of(l: &List) -> Option<(Pt, f64)> {
    let at = l.find("at")?;
    let p = Pt::new(mm_str_to_nm(&at.arg(0)?)?, mm_str_to_nm(&at.arg(1)?)?);
    Some((p, at.arg_f64(2).unwrap_or(0.0)))
}

fn uuid_of(l: &List) -> String {
    l.find("uuid").and_then(|u| u.arg(0)).unwrap_or_default()
}

fn yes(l: &List, name: &str) -> bool {
    l.find(name)
        .map(|n| n.arg(0).map(|v| v == "yes").unwrap_or(true))
        .unwrap_or(false)
}

fn stroke_of(l: &List) -> RStroke {
    let Some(s) = l.find("stroke") else {
        return RStroke::default();
    };
    RStroke {
        width_mil: s
            .find("width")
            .and_then(|w| w.arg_f64(0))
            .map(mm_to_mil_f)
            .unwrap_or(0.0),
        style: s
            .find("type")
            .and_then(|t| t.arg(0))
            .unwrap_or_else(|| "default".into()),
    }
}

fn fill_of(l: &List) -> String {
    l.find("fill")
        .and_then(|f| f.find("type"))
        .and_then(|t| t.arg(0))
        .unwrap_or_else(|| "none".into())
}

#[derive(Clone)]
struct Effects {
    size_mil: f64,
    hide: bool,
    justify_h: String,
    justify_v: String,
    bold: bool,
    italic: bool,
}

impl Default for Effects {
    fn default() -> Self {
        Effects {
            size_mil: 50.0,
            hide: false,
            justify_h: "center".into(),
            justify_v: "center".into(),
            bold: false,
            italic: false,
        }
    }
}

fn effects_of(l: &List) -> Effects {
    let mut e = Effects::default();
    // `(hide yes)` may sit directly on the item (properties) or in effects.
    if yes(l, "hide") {
        e.hide = true;
    }
    let Some(ef) = l.find("effects") else {
        return e;
    };
    if yes(ef, "hide") {
        e.hide = true;
    }
    if let Some(font) = ef.find("font") {
        if let Some(sz) = font
            .find("size")
            .and_then(|s| s.arg_f64(1).or(s.arg_f64(0)))
        {
            e.size_mil = mm_to_mil_f(sz);
        }
        e.bold = font.find("bold").is_some() && yes(font, "bold")
            || font
                .find("bold")
                .map(|b| b.args().is_empty())
                .unwrap_or(false);
        e.italic = font.find("italic").is_some() && yes(font, "italic")
            || font
                .find("italic")
                .map(|b| b.args().is_empty())
                .unwrap_or(false);
    }
    if let Some(j) = ef.find("justify") {
        for a in j.args() {
            match a.as_str() {
                "left" | "right" => e.justify_h = a,
                "top" | "bottom" => e.justify_v = a,
                _ => {}
            }
        }
    }
    e
}

fn text_of(text: String, at: Pt, rot: f64, e: &Effects, role: &str, name: Option<String>) -> RText {
    RText {
        text,
        at: mil(at),
        rotation: rot.rem_euclid(360.0),
        size_mil: e.size_mil,
        justify_h: e.justify_h.clone(),
        justify_v: e.justify_v.clone(),
        bold: e.bold,
        italic: e.italic,
        hide: e.hide,
        role: role.into(),
        name,
    }
}

fn paper_size_mm(paper: &str, root: &List) -> [f64; 2] {
    let p = root.find("paper");
    let portrait = p
        .map(|p| p.args().iter().any(|a| a == "portrait"))
        .unwrap_or(false);
    let (w, h) = match paper {
        "A0" => (1189.0, 841.0),
        "A1" => (841.0, 594.0),
        "A2" => (594.0, 420.0),
        "A3" => (420.0, 297.0),
        "A4" => (297.0, 210.0),
        "A5" => (210.0, 148.0),
        "A" => (279.4, 215.9),
        "B" => (431.8, 279.4),
        "C" => (558.8, 431.8),
        "D" => (863.6, 558.8),
        "E" => (1117.6, 863.6),
        "USLetter" => (279.4, 215.9),
        "USLegal" => (355.6, 215.9),
        "USLedger" => (431.8, 279.4),
        "User" => {
            let w = p.and_then(|p| p.arg_f64(1)).unwrap_or(297.0);
            let h = p.and_then(|p| p.arg_f64(2)).unwrap_or(210.0);
            (w, h)
        }
        _ => (297.0, 210.0),
    };
    if portrait && paper != "User" {
        [h, w]
    } else {
        [w, h]
    }
}

fn title_block_of(root: &List) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(tb) = root.find("title_block") {
        for item in tb.lists() {
            match item.name().as_deref() {
                Some("comment") => {
                    if let (Some(n), Some(v)) = (item.arg(0), item.arg(1)) {
                        out.insert(format!("comment{n}"), v);
                    }
                }
                Some(k) => {
                    if let Some(v) = item.arg(0) {
                        out.insert(k.to_string(), v);
                    }
                }
                None => {}
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Library symbol body → world primitives
// ---------------------------------------------------------------------------

fn circumcenter(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> Option<([f64; 2], f64)> {
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if d.abs() < 1e-9 {
        return None;
    }
    let a2 = a[0] * a[0] + a[1] * a[1];
    let b2 = b[0] * b[0] + b[1] * b[1];
    let c2 = c[0] * c[0] + c[1] * c[1];
    let ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    let uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    let r = ((a[0] - ux).powi(2) + (a[1] - uy).powi(2)).sqrt();
    Some(([ux, uy], r))
}

fn flatten_bezier(pts: &[Pt], p: Placement) -> Vec<Mil> {
    if pts.len() != 4 {
        return pts.iter().map(|q| mil(transform_point(*q, p))).collect();
    }
    let f = |q: Pt| (q.x as f64, q.y as f64);
    let (p0, p1, p2, p3) = (f(pts[0]), f(pts[1]), f(pts[2]), f(pts[3]));
    (0..=16)
        .map(|i| {
            let t = i as f64 / 16.0;
            let u = 1.0 - t;
            let x = u * u * u * p0.0
                + 3.0 * u * u * t * p1.0
                + 3.0 * u * t * t * p2.0
                + t * t * t * p3.0;
            let y = u * u * u * p0.1
                + 3.0 * u * u * t * p1.1
                + 3.0 * u * t * t * p2.1
                + t * t * t * p3.1;
            mil(transform_point(
                Pt::new(x.round() as Nm, y.round() as Nm),
                p,
            ))
        })
        .collect()
}

fn unit_of_subsymbol(base_short: &str, name: &str) -> (u32, u32) {
    let suffix = name
        .strip_prefix(base_short)
        .and_then(|r| r.strip_prefix('_'))
        .unwrap_or("");
    let mut parts = suffix.split('_');
    let unit = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let convert = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (unit, convert)
}

fn walk_primitives(
    l: &List,
    p: Placement,
    shapes: &mut Vec<RShape>,
    texts: &mut Vec<RText>,
    bb: &mut BBox,
) {
    for g in l.lists() {
        match g.name().as_deref() {
            Some("polyline") | Some("bezier") => {
                let Some(ptsl) = g.find("pts") else { continue };
                let raw: Vec<Pt> = ptsl
                    .find_all("xy")
                    .filter_map(|xy| {
                        Some(Pt::new(
                            mm_str_to_nm(&xy.arg(0)?)?,
                            mm_str_to_nm(&xy.arg(1)?)?,
                        ))
                    })
                    .collect();
                if raw.is_empty() {
                    continue;
                }
                let pts: Vec<Mil> = if g.is_named("bezier") {
                    flatten_bezier(&raw, p)
                } else {
                    raw.iter().map(|q| mil(transform_point(*q, p))).collect()
                };
                for q in &raw {
                    bb.include(transform_point(*q, p));
                }
                shapes.push(RShape::Polyline {
                    pts,
                    stroke: stroke_of(g),
                    fill: fill_of(g),
                });
            }
            Some("rectangle") => {
                if let (Some(a), Some(b)) = (pt_nm(g, "start"), pt_nm(g, "end")) {
                    let wa = transform_point(a, p);
                    let wb = transform_point(b, p);
                    bb.include(wa);
                    bb.include(wb);
                    shapes.push(RShape::Rectangle {
                        a: mil(wa),
                        b: mil(wb),
                        stroke: stroke_of(g),
                        fill: fill_of(g),
                    });
                }
            }
            Some("circle") => {
                if let (Some(c), Some(r)) = (
                    pt_nm(g, "center"),
                    g.find("radius")
                        .and_then(|r| r.arg(0))
                        .and_then(|s| mm_str_to_nm(&s)),
                ) {
                    let wc = transform_point(c, p);
                    bb.include(Pt::new(wc.x - r, wc.y - r));
                    bb.include(Pt::new(wc.x + r, wc.y + r));
                    shapes.push(RShape::Circle {
                        center: mil(wc),
                        radius_mil: round_mil(nm_to_mil(r)),
                        stroke: stroke_of(g),
                        fill: fill_of(g),
                    });
                }
            }
            Some("arc") => {
                if let (Some(s), Some(m), Some(e)) =
                    (pt_nm(g, "start"), pt_nm(g, "mid"), pt_nm(g, "end"))
                {
                    let (ws, wm, we) = (
                        transform_point(s, p),
                        transform_point(m, p),
                        transform_point(e, p),
                    );
                    let (sm, mm, em) = (mil(ws), mil(wm), mil(we));
                    let (center, radius_mil) = circumcenter(sm, mm, em).unwrap_or((mm, 0.0));
                    for q in [ws, wm, we] {
                        bb.include(q);
                    }
                    shapes.push(RShape::Arc {
                        start: sm,
                        mid: mm,
                        end: em,
                        center,
                        radius_mil,
                        stroke: stroke_of(g),
                        fill: fill_of(g),
                    });
                }
            }
            Some("text") => {
                if let (Some(t), Some((at, rot))) = (g.arg(0), at_of(g)) {
                    let w = transform_point(at, p);
                    let e = effects_of(g);
                    // Rotation in lib text is in tenths of degrees in old files; KiCad 6+ uses degrees.
                    let rot = (rot + p.rot.deg() as f64).rem_euclid(360.0);
                    texts.push(text_of(t, w, rot, &e, "lib_text", None));
                }
            }
            _ => {}
        }
    }
}

fn lib_pin_render(
    g: &List,
    p: Placement,
    names_hidden: bool,
    numbers_hidden: bool,
    name_offset_mil: f64,
    bb: &mut BBox,
) -> Option<RPin> {
    let (at, ang) = at_of(g)?;
    let len = g
        .find("length")
        .and_then(|l| l.arg(0))
        .and_then(|s| mm_str_to_nm(&s))
        .unwrap_or(0);
    let angle = (ang.round() as i64).rem_euclid(360);
    let (dx, dy) = match angle {
        0 => (1i64, 0i64),
        90 => (0, 1),
        180 => (-1, 0),
        _ => (0, -1),
    };
    let end_local = Pt::new(at.x + dx * len, at.y + dy * len);
    let probe_local = Pt::new(at.x + dx * 1_000_000, at.y + dy * 1_000_000);
    let wat = transform_point(at, p);
    let wend = transform_point(end_local, p);
    let wprobe = transform_point(probe_local, p);
    let ddx = (wprobe.x - wat.x).signum() as f64;
    let ddy = (wprobe.y - wat.y).signum() as f64;
    bb.include(wat);
    bb.include(wend);
    let name_node = g.find("name");
    let number_node = g.find("number");
    let electrical = g.arg(0).unwrap_or_else(|| "passive".into());
    let shape = g.arg(1).unwrap_or_else(|| "line".into());
    let hide = yes(g, "hide") || g.args().iter().any(|a| a == "hide");
    Some(RPin {
        number: number_node.and_then(|n| n.arg(0)).unwrap_or_default(),
        name: name_node.and_then(|n| n.arg(0)).unwrap_or_default(),
        electrical,
        shape,
        at: mil(wat),
        end: mil(wend),
        dir: [ddx, ddy],
        length_mil: round_mil(nm_to_mil(len)),
        hide,
        name_hidden: names_hidden,
        number_hidden: numbers_hidden,
        name_size_mil: name_node.map(|n| effects_of(n).size_mil).unwrap_or(50.0),
        number_size_mil: number_node.map(|n| effects_of(n).size_mil).unwrap_or(50.0),
        name_offset_mil,
    })
}

/// Render one placed symbol from the sheet's `lib_symbols` cache.
pub fn render_symbol(doc: &Document, sheet: &Sheet, sym: &SymbolInst, reference: &str) -> RSymbol {
    let cache = doc.root.find("lib_symbols");
    let node = cache.and_then(|c| {
        c.find_all("symbol")
            .find(|s| s.arg(0).as_deref() == Some(sym.lib_id.as_str()))
    });
    render_symbol_with(doc, sym, reference, node, sheet.lib_symbol(&sym.lib_id))
}

/// First `lib_symbols` child per lib id and first `LibSymbol` per id, built once per sheet so
/// `render_sheet` does not rescan the cache for every instance (first match wins, exactly like
/// the linear `find` in `render_symbol`, so the output is byte-identical).
struct LibLookup<'a> {
    nodes: HashMap<String, &'a List>,
    libs: HashMap<&'a str, &'a LibSymbol>,
}

impl<'a> LibLookup<'a> {
    fn new(doc: &'a Document, sheet: &'a Sheet) -> Self {
        let mut nodes: HashMap<String, &'a List> = HashMap::new();
        if let Some(cache) = doc.root.find("lib_symbols") {
            for child in &cache.children {
                if let Node::List(l) = child {
                    if l.name().as_deref() == Some("symbol") {
                        if let Some(id) = l.arg(0) {
                            nodes.entry(id).or_insert(l);
                        }
                    }
                }
            }
        }
        let mut libs: HashMap<&'a str, &'a LibSymbol> = HashMap::new();
        for l in &sheet.lib_symbols {
            libs.entry(l.id.as_str()).or_insert(l);
        }
        LibLookup { nodes, libs }
    }
}

fn render_symbol_with(
    doc: &Document,
    sym: &SymbolInst,
    reference: &str,
    node: Option<&List>,
    lib: Option<&LibSymbol>,
) -> RSymbol {
    let mut shapes = Vec::new();
    let mut texts = Vec::new();
    let mut pins = Vec::new();
    let mut bb = BBox::empty();
    let mut unresolved = true;
    if let Some(node) = node {
        unresolved = false;
        let base = node.arg(0).unwrap_or_default();
        let base_short = base.rsplit(':').next().unwrap_or(&base).to_string();
        let names_hidden = node
            .find("pin_names")
            .map(|n| yes(n, "hide"))
            .unwrap_or(false);
        let numbers_hidden = node
            .find("pin_numbers")
            .map(|n| yes(n, "hide"))
            .unwrap_or(false);
        let name_offset_mil = node
            .find("pin_names")
            .and_then(|n| n.find("offset"))
            .and_then(|o| o.arg_f64(0))
            .map(mm_to_mil_f)
            .unwrap_or(20.0);
        let p = sym.placement;
        walk_primitives(node, p, &mut shapes, &mut texts, &mut bb);
        for g in node.find_all("pin") {
            if let Some(rp) =
                lib_pin_render(g, p, names_hidden, numbers_hidden, name_offset_mil, &mut bb)
            {
                pins.push(rp);
            }
        }
        for sub in node.find_all("symbol") {
            let name = sub.arg(0).unwrap_or_default();
            let (u, convert) = unit_of_subsymbol(&base_short, &name);
            if (u == 0 || u == sym.unit) && convert <= 1 {
                walk_primitives(sub, p, &mut shapes, &mut texts, &mut bb);
                for g in sub.find_all("pin") {
                    if let Some(rp) =
                        lib_pin_render(g, p, names_hidden, numbers_hidden, name_offset_mil, &mut bb)
                    {
                        pins.push(rp);
                    }
                }
            }
        }
    }
    // Property texts live in world coordinates in the schematic file.
    if let Some(Node::List(inst)) = doc.root.children.get(sym.node_index) {
        for prop in inst.find_all("property") {
            let (Some(name), Some(val)) = (prop.arg(0), prop.arg(1)) else {
                continue;
            };
            let (at, rot0) = at_of(prop).unwrap_or((sym.placement.at, 0.0));
            // eeschema (SCH_FIELD::GetDrawRotation): the file stores the field angle in the symbol's own
            // frame; when the symbol transform swaps the axes (rotation 90 / 270) a "90" field is drawn
            // horizontal and a "0" field vertical. Verified against `kicad-cli sch export svg`.
            let rot = if matches!(sym.placement.rot.deg(), 90 | 270) {
                match rot0.rem_euclid(360.0) as i64 {
                    0 => 90.0,
                    90 => 0.0,
                    180 => 270.0,
                    270 => 180.0,
                    _ => rot0,
                }
            } else {
                rot0
            };
            let mut e = effects_of(prop);
            let role = match name.as_str() {
                "Reference" => "reference",
                "Value" => "value",
                "Footprint" => "footprint",
                "Datasheet" => "datasheet",
                _ => "user",
            };
            if role == "reference" && lib.map(|l| l.is_power).unwrap_or(false) {
                e.hide = true;
            }
            let shown = if role == "reference" {
                reference.to_string()
            } else {
                val
            };
            texts.push(text_of(
                shown,
                at,
                rot,
                &e,
                role,
                if role == "user" { Some(name) } else { None },
            ));
        }
    }
    if bb.is_empty() {
        bb.include(sym.placement.at);
    }
    RSymbol {
        reference: reference.to_string(),
        value: sym.value.clone(),
        uuid: sym.uuid.clone(),
        lib_id: sym.lib_id.clone(),
        unit: sym.unit,
        dnp: sym.dnp,
        is_power: lib.map(|l| l.is_power).unwrap_or(false),
        at: mil(sym.placement.at),
        rotation: sym.placement.rot.deg() as f64,
        mirror: match sym.placement.mirror {
            Mirror::None => "none",
            Mirror::X => "x",
            Mirror::Y => "y",
        }
        .into(),
        shapes,
        pins,
        texts,
        bbox: bbox_mil(&bb),
        unresolved,
    }
}

// ---------------------------------------------------------------------------
// Labels / sheets / sheet-level graphics
// ---------------------------------------------------------------------------

fn render_label(l: &List, kind: &str) -> Option<RLabel> {
    let text = l.arg(0)?;
    let (at, rot) = at_of(l)?;
    let e = effects_of(l);
    let shape = l
        .find("shape")
        .and_then(|s| s.arg(0))
        .unwrap_or_else(|| "passive".into());
    let bb = label_flag_bbox(&text, kind, at, rot, e.size_mil);
    Some(RLabel {
        uuid: uuid_of(l),
        text,
        kind: kind.into(),
        shape,
        at: mil(at),
        rotation: rot.rem_euclid(360.0),
        size_mil: e.size_mil,
        justify_h: e.justify_h,
        justify_v: e.justify_v,
        bbox: bbox_mil(&bb),
    })
}

fn render_sheet_symbol(l: &List) -> Option<RSheetSymbol> {
    let (at, _) = at_of(l)?;
    let size = pt_nm(l, "size")?;
    let mut texts = Vec::new();
    let mut name = String::new();
    let mut file = String::new();
    for prop in l.find_all("property") {
        let (Some(k), Some(v)) = (prop.arg(0), prop.arg(1)) else {
            continue;
        };
        let (pat, prot) = at_of(prop).unwrap_or((at, 0.0));
        let e = effects_of(prop);
        let role = match k.as_str() {
            "Sheetname" | "Sheet name" => {
                name = v.clone();
                "sheet_name"
            }
            "Sheetfile" | "Sheet file" => {
                file = v.clone();
                "sheet_file"
            }
            _ => "user",
        };
        texts.push(text_of(
            v,
            pat,
            prot,
            &e,
            role,
            if role == "user" { Some(k) } else { None },
        ));
    }
    let bbox = BBox {
        min: at,
        max: at.add(size),
    };
    let mut pins = Vec::new();
    for p in l.find_all("pin") {
        let (Some(pname), Some((pat, prot))) = (p.arg(0), at_of(p)) else {
            continue;
        };
        let side = if pat.x <= at.x {
            "left"
        } else if pat.x >= at.x + size.x {
            "right"
        } else if pat.y <= at.y {
            "top"
        } else {
            "bottom"
        };
        pins.push(RSheetPin {
            uuid: uuid_of(p),
            name: pname,
            shape: p.arg(1).unwrap_or_else(|| "passive".into()),
            at: mil(pat),
            rotation: prot.rem_euclid(360.0),
            side: side.into(),
            size_mil: effects_of(p).size_mil,
        });
    }
    Some(RSheetSymbol {
        uuid: uuid_of(l),
        name,
        file,
        at: mil(at),
        size: mil(size),
        stroke: stroke_of(l),
        fill: l
            .find("fill")
            .map(|f| {
                if f.find("color").is_some() {
                    "color".to_string()
                } else {
                    fill_of(l)
                }
            })
            .unwrap_or_else(|| "none".into()),
        pins,
        texts,
        bbox: bbox_mil(&bbox),
    })
}

fn render_sheet_graphic(g: &List, shapes: &mut Vec<RShape>, bb: &mut BBox) {
    let id = Placement::default();
    // Sheet-level graphics are already in world coordinates (+Y down); the
    // identity placement still flips Y, so pre-flip before reuse.
    let flip = |p: Pt| Pt::new(p.x, -p.y);
    match g.name().as_deref() {
        Some("polyline") | Some("bezier") => {
            let Some(ptsl) = g.find("pts") else { return };
            let raw: Vec<Pt> = ptsl
                .find_all("xy")
                .filter_map(|xy| {
                    Some(flip(Pt::new(
                        mm_str_to_nm(&xy.arg(0)?)?,
                        mm_str_to_nm(&xy.arg(1)?)?,
                    )))
                })
                .collect();
            if raw.is_empty() {
                return;
            }
            let pts: Vec<Mil> = if g.is_named("bezier") {
                flatten_bezier(&raw, id)
            } else {
                raw.iter().map(|q| mil(transform_point(*q, id))).collect()
            };
            for q in &raw {
                bb.include(transform_point(*q, id));
            }
            shapes.push(RShape::Polyline {
                pts,
                stroke: stroke_of(g),
                fill: fill_of(g),
            });
        }
        Some("rectangle") => {
            if let (Some(a), Some(b)) = (pt_nm(g, "start"), pt_nm(g, "end")) {
                bb.include(a);
                bb.include(b);
                shapes.push(RShape::Rectangle {
                    a: mil(a),
                    b: mil(b),
                    stroke: stroke_of(g),
                    fill: fill_of(g),
                });
            }
        }
        Some("circle") => {
            if let (Some(c), Some(r)) = (
                pt_nm(g, "center"),
                g.find("radius")
                    .and_then(|r| r.arg(0))
                    .and_then(|s| mm_str_to_nm(&s)),
            ) {
                bb.include(Pt::new(c.x - r, c.y - r));
                bb.include(Pt::new(c.x + r, c.y + r));
                shapes.push(RShape::Circle {
                    center: mil(c),
                    radius_mil: round_mil(nm_to_mil(r)),
                    stroke: stroke_of(g),
                    fill: fill_of(g),
                });
            }
        }
        Some("arc") => {
            if let (Some(s), Some(m), Some(e)) =
                (pt_nm(g, "start"), pt_nm(g, "mid"), pt_nm(g, "end"))
            {
                for q in [s, m, e] {
                    bb.include(q);
                }
                let (sm, mm, em) = (mil(s), mil(m), mil(e));
                let (center, radius_mil) = circumcenter(sm, mm, em).unwrap_or((mm, 0.0));
                shapes.push(RShape::Arc {
                    start: sm,
                    mid: mm,
                    end: em,
                    center,
                    radius_mil,
                    stroke: stroke_of(g),
                    fill: fill_of(g),
                });
            }
        }
        _ => {}
    }
}

/// Everything needed to draw one sheet instance. `sheet_path` accepts either
/// the human path (`/child/`) or the uuid path.
pub fn render_sheet(tree: &SheetTree, sheet_path: &str) -> Option<RenderSheet> {
    let inst = tree
        .instances
        .iter()
        .find(|i| i.names == sheet_path || i.path == sheet_path)?;
    let sheet = &tree.files[&inst.file];
    let doc = &tree.docs[&inst.file];
    let root = &doc.root;
    let mut bb = BBox::empty();
    let lookup = LibLookup::new(doc, sheet);

    let mut symbols = Vec::new();
    for s in &sheet.symbols {
        let reference = s
            .instances
            .iter()
            .find(|r| r.path == inst.path)
            .map(|r| r.reference.clone())
            .unwrap_or_else(|| s.reference.clone());
        let rs = render_symbol_with(
            doc,
            s,
            &reference,
            lookup.nodes.get(s.lib_id.as_str()).copied(),
            lookup.libs.get(s.lib_id.as_str()).copied(),
        );
        let b = BBox {
            min: Pt::new(mil_to_nm(rs.bbox[0][0]), mil_to_nm(rs.bbox[0][1])),
            max: Pt::new(mil_to_nm(rs.bbox[1][0]), mil_to_nm(rs.bbox[1][1])),
        };
        bb.union(&b);
        symbols.push(rs);
    }

    let mut wires = Vec::new();
    let mut junctions = Vec::new();
    let mut no_connects = Vec::new();
    let mut bus_entries = Vec::new();
    let mut labels = Vec::new();
    let mut sheets = Vec::new();
    let mut texts = Vec::new();
    let mut text_boxes = Vec::new();
    let mut graphics = Vec::new();
    let mut images = Vec::new();

    for child in &root.children {
        let Node::List(l) = child else { continue };
        let Some(name) = l.name() else { continue };
        match name.as_str() {
            "wire" | "bus" => {
                let pts: Vec<Pt> = l
                    .find("pts")
                    .map(|p| {
                        p.find_all("xy")
                            .filter_map(|xy| {
                                Some(Pt::new(
                                    mm_str_to_nm(&xy.arg(0)?)?,
                                    mm_str_to_nm(&xy.arg(1)?)?,
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                for w in pts.windows(2) {
                    bb.include(w[0]);
                    bb.include(w[1]);
                    wires.push(RWire {
                        uuid: uuid_of(l),
                        a: mil(w[0]),
                        b: mil(w[1]),
                        is_bus: name == "bus",
                        stroke: stroke_of(l),
                    });
                }
            }
            "junction" => {
                if let Some((at, _)) = at_of(l) {
                    bb.include(at);
                    junctions.push(RJunction {
                        uuid: uuid_of(l),
                        at: mil(at),
                        diameter_mil: l
                            .find("diameter")
                            .and_then(|d| d.arg_f64(0))
                            .map(mm_to_mil_f)
                            .filter(|d| *d > 0.0)
                            .unwrap_or(36.0),
                    });
                }
            }
            "no_connect" => {
                if let Some((at, _)) = at_of(l) {
                    bb.include(at);
                    no_connects.push(RPoint {
                        uuid: uuid_of(l),
                        at: mil(at),
                    });
                }
            }
            "bus_entry" => {
                if let Some((at, _)) = at_of(l) {
                    let size = pt_nm(l, "size").unwrap_or(Pt::new(2_540_000, 2_540_000));
                    let end = at.add(size);
                    bb.include(at);
                    bb.include(end);
                    bus_entries.push(RSegment {
                        uuid: uuid_of(l),
                        a: mil(at),
                        b: mil(end),
                        stroke: stroke_of(l),
                    });
                }
            }
            "label" | "global_label" | "hierarchical_label" | "netclass_flag" => {
                let kind = match name.as_str() {
                    "label" => "local",
                    "global_label" => "global",
                    "hierarchical_label" => "hierarchical",
                    _ => "netclass",
                };
                if let Some(rl) = render_label(l, kind) {
                    bb.include(Pt::new(mil_to_nm(rl.bbox[0][0]), mil_to_nm(rl.bbox[0][1])));
                    bb.include(Pt::new(mil_to_nm(rl.bbox[1][0]), mil_to_nm(rl.bbox[1][1])));
                    labels.push(rl);
                }
            }
            "sheet" => {
                if let Some(rs) = render_sheet_symbol(l) {
                    bb.include(Pt::new(mil_to_nm(rs.bbox[0][0]), mil_to_nm(rs.bbox[0][1])));
                    bb.include(Pt::new(mil_to_nm(rs.bbox[1][0]), mil_to_nm(rs.bbox[1][1])));
                    sheets.push(rs);
                }
            }
            "text" => {
                if let (Some(t), Some((at, rot))) = (l.arg(0), at_of(l)) {
                    bb.include(at);
                    texts.push(text_of(t, at, rot, &effects_of(l), "text", None));
                }
            }
            "text_box" => {
                if let (Some(t), Some((at, rot)), Some(size)) =
                    (l.arg(0), at_of(l), pt_nm(l, "size"))
                {
                    let end = at.add(size);
                    bb.include(at);
                    bb.include(end);
                    let mut e = effects_of(l);
                    if e.justify_h == "center" {
                        e.justify_h = "left".into();
                    }
                    if e.justify_v == "center" {
                        e.justify_v = "top".into();
                    }
                    text_boxes.push(RTextBox {
                        uuid: uuid_of(l),
                        text: text_of(t, at, rot, &e, "text", None),
                        a: mil(at),
                        b: mil(end),
                        stroke: stroke_of(l),
                        fill: fill_of(l),
                    });
                }
            }
            "polyline" | "rectangle" | "circle" | "arc" | "bezier" => {
                render_sheet_graphic(l, &mut graphics, &mut bb);
            }
            "image" => {
                if let Some((at, _)) = at_of(l) {
                    // Payload is skipped; KiCad images are 300 dpi bitmaps scaled by `scale`.
                    let scale = l.find("scale").and_then(|s| s.arg_f64(0)).unwrap_or(1.0);
                    let half = mil_to_nm(500.0 * scale);
                    let b = BBox {
                        min: Pt::new(at.x - half, at.y - half),
                        max: Pt::new(at.x + half, at.y + half),
                    };
                    bb.union(&b);
                    images.push(RBox {
                        uuid: uuid_of(l),
                        bbox: bbox_mil(&b),
                    });
                }
            }
            _ => {}
        }
    }
    if bb.is_empty() {
        bb.include(Pt::new(0, 0));
    }
    Some(RenderSheet {
        sheet_path: inst.names.clone(),
        file: inst.file.to_string_lossy().into_owned(),
        paper: sheet.paper.clone(),
        paper_mm: paper_size_mm(&sheet.paper, root),
        title_block: title_block_of(root),
        symbols,
        wires,
        junctions,
        no_connects,
        bus_entries,
        labels,
        sheets,
        texts,
        text_boxes,
        graphics,
        images,
        bbox: bbox_mil(&bb),
    })
}
