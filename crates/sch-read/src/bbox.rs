// SPDX-License-Identifier: Apache-2.0
//! Bounding boxes shared by the writer (placement nudge) and the geometry
//! crate (layout gate, canvas). Library bodies are computed from the cached
//! `lib_symbols` node; world boxes go through the single `transform_point`.

use kicad_sexpr::{Document, List};
use sch_model::*;
use serde::{Deserialize, Serialize};

fn pt_of(l: &List, name: &str) -> Option<Pt> {
    let n = l.find(name)?;
    Some(Pt::new(
        mm_str_to_nm(&n.arg(0)?)?,
        mm_str_to_nm(&n.arg(1)?)?,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct BBox {
    pub min: Pt,
    pub max: Pt,
}

impl BBox {
    pub fn empty() -> BBox {
        BBox {
            min: Pt::new(i64::MAX, i64::MAX),
            max: Pt::new(i64::MIN, i64::MIN),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }
    pub fn include(&mut self, p: Pt) {
        self.min.x = self.min.x.min(p.x);
        self.min.y = self.min.y.min(p.y);
        self.max.x = self.max.x.max(p.x);
        self.max.y = self.max.y.max(p.y);
    }
    pub fn union(&mut self, o: &BBox) {
        if !o.is_empty() {
            self.include(o.min);
            self.include(o.max);
        }
    }
    pub fn intersects(&self, o: &BBox) -> bool {
        !self.is_empty()
            && !o.is_empty()
            && self.min.x < o.max.x
            && o.min.x < self.max.x
            && self.min.y < o.max.y
            && o.min.y < self.max.y
    }
    pub fn contains(&self, p: Pt) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }
    /// Whether `o` lies wholly inside this box (edges count as inside). Used for the drawing
    /// border: the placement nudge and the layout gate must ask the same question.
    pub fn contains_box(&self, o: &BBox) -> bool {
        !o.is_empty()
            && o.min.x >= self.min.x
            && o.min.y >= self.min.y
            && o.max.x <= self.max.x
            && o.max.y <= self.max.y
    }
    pub fn expand(&self, by: Nm) -> BBox {
        BBox {
            min: Pt::new(self.min.x - by, self.min.y - by),
            max: Pt::new(self.max.x + by, self.max.y + by),
        }
    }
    pub fn to_mil(&self) -> [[f64; 2]; 2] {
        [
            [nm_to_mil(self.min.x), nm_to_mil(self.min.y)],
            [nm_to_mil(self.max.x), nm_to_mil(self.max.y)],
        ]
    }
}

/// World box of a library-frame box under `pl`: every corner goes through the
/// single [`transform_point`], so a rotated or mirrored body is still one box.
pub fn world_box(local: &BBox, pl: Placement) -> BBox {
    let mut bb = BBox::empty();
    for (x, y) in [
        (local.min.x, local.min.y),
        (local.min.x, local.max.y),
        (local.max.x, local.min.y),
        (local.max.x, local.max.y),
    ] {
        bb.include(transform_point(Pt::new(x, y), pl));
    }
    bb
}

/// World direction of a library-frame vector under `pl` (rotation and mirror
/// only, the translation cancels).
pub fn world_dir(v: (i64, i64), pl: Placement) -> (i64, i64) {
    let zero = Placement {
        at: Pt::new(0, 0),
        ..pl
    };
    let o = transform_point(Pt::new(0, 0), zero);
    let t = transform_point(Pt::new(v.0, v.1), zero);
    ((t.x - o.x).signum(), (t.y - o.y).signum())
}

/// Direction a symbol field's text runs from its anchor when the stored
/// justification is `left`, after the parent symbol's rotation and mirror.
///
/// A symbol field stores an absolute position but a *symbol-frame* angle and
/// justification: KiCad composes the stored angle with the symbol rotation and
/// runs the field's bounding box through the symbol transform
/// (`SCH_FIELD::GetBoundingBox`), so `justify left` draws to the left on a
/// mirrored or 180-degree symbol. Verified against `kicad-cli sch export svg`
/// for rot 0/90/180/270 with and without mirror.
pub fn field_run_dir(stored_rot: i64, pl: Placement) -> (i64, i64) {
    let local = if stored_rot.rem_euclid(180) == 90 {
        (0, 1)
    } else {
        (1, 0)
    };
    world_dir(local, pl)
}

/// Box of a symbol field: [`text_bbox`] with the stored angle and justification
/// resolved through the parent symbol's transform (see [`field_run_dir`]).
pub fn field_bbox(
    text: &str,
    at: Pt,
    stored_rot: i64,
    size_mil: f64,
    justify: &str,
    pl: Placement,
) -> BBox {
    let run = field_run_dir(stored_rot, pl);
    // Horizontal world text runs +X when unflipped, vertical text runs -Y
    // (`text_bbox`'s own convention for `justify left`).
    let (world_rot, canonical) = if run.0 == 0 {
        (90, (0, -1))
    } else {
        (0, (1, 0))
    };
    let justify = if run == canonical {
        justify
    } else {
        match justify {
            "left" => "right",
            "right" => "left",
            other => other,
        }
    };
    text_bbox(text, at, world_rot, size_mil, justify)
}

/// Body bounding box of a library symbol unit, in library coordinates (+Y up),
/// computed from its graphic primitives and pin extents.
pub fn lib_body_bbox(sym_node: &List, unit: u32) -> BBox {
    lib_bbox(sym_node, unit, true)
}

/// Like [`lib_body_bbox`] but graphics only (no pin stubs): the area a power
/// symbol or a label must keep clear of.
pub fn lib_graphics_bbox(sym_node: &List, unit: u32) -> BBox {
    lib_bbox(sym_node, unit, false)
}

fn lib_bbox(sym_node: &List, unit: u32, include_pins: bool) -> BBox {
    let mut bb = BBox::empty();
    let base = sym_node.arg(0).unwrap_or_default();
    let base_short = base.rsplit(':').next().unwrap_or(&base).to_string();
    let mut walk = |l: &List| {
        for g in l.lists() {
            match g.name().as_deref() {
                Some("rectangle") => {
                    if let (Some(a), Some(b)) = (pt_of(g, "start"), pt_of(g, "end")) {
                        bb.include(a);
                        bb.include(b);
                    }
                }
                Some("polyline") | Some("bezier") => {
                    if let Some(pts) = g.find("pts") {
                        for xy in pts.find_all("xy") {
                            if let (Some(x), Some(y)) = (
                                xy.arg(0).and_then(|s| mm_str_to_nm(&s)),
                                xy.arg(1).and_then(|s| mm_str_to_nm(&s)),
                            ) {
                                bb.include(Pt::new(x, y));
                            }
                        }
                    }
                }
                Some("circle") => {
                    if let (Some(c), Some(r)) = (
                        pt_of(g, "center"),
                        g.find("radius")
                            .and_then(|r| r.arg(0))
                            .and_then(|s| mm_str_to_nm(&s)),
                    ) {
                        bb.include(Pt::new(c.x - r, c.y - r));
                        bb.include(Pt::new(c.x + r, c.y + r));
                    }
                }
                Some("arc") => {
                    for k in ["start", "mid", "end"] {
                        if let Some(p) = pt_of(g, k) {
                            bb.include(p);
                        }
                    }
                }
                Some("pin") if include_pins => {
                    // pin from its anchor along its direction by `length`
                    if let Some(at) = g.find("at") {
                        if let (Some(x), Some(y)) = (
                            at.arg(0).and_then(|s| mm_str_to_nm(&s)),
                            at.arg(1).and_then(|s| mm_str_to_nm(&s)),
                        ) {
                            let ang = at.arg_f64(2).unwrap_or(0.0).round() as i64;
                            let len = g
                                .find("length")
                                .and_then(|l| l.arg(0))
                                .and_then(|s| mm_str_to_nm(&s))
                                .unwrap_or(0);
                            let (dx, dy) = match ang.rem_euclid(360) {
                                0 => (len, 0),
                                90 => (0, len),
                                180 => (-len, 0),
                                _ => (0, -len),
                            };
                            bb.include(Pt::new(x, y));
                            bb.include(Pt::new(x + dx, y + dy));
                        }
                    }
                }
                _ => {}
            }
        }
    };
    walk(sym_node);
    for sub in sym_node.find_all("symbol") {
        let name = sub.arg(0).unwrap_or_default();
        let suffix = name
            .strip_prefix(&base_short)
            .and_then(|r| r.strip_prefix('_'))
            .unwrap_or("");
        let u: u32 = suffix
            .split('_')
            .next()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if u == 0 || u == unit {
            walk(sub);
        }
    }
    bb
}

/// World-space bbox of a placed symbol (from the schematic's lib_symbols cache).
pub fn symbol_bbox(doc: &Document, sym: &SymbolInst) -> Option<BBox> {
    placed_bbox(doc, sym, true)
}

/// World-space graphics-only bbox of a placed symbol (pin stubs excluded).
pub fn symbol_graphics_bbox(doc: &Document, sym: &SymbolInst) -> Option<BBox> {
    placed_bbox(doc, sym, false)
}

fn placed_bbox(doc: &Document, sym: &SymbolInst, include_pins: bool) -> Option<BBox> {
    let cache = doc.root.find("lib_symbols")?;
    let node = cache
        .find_all("symbol")
        .find(|s| s.arg(0).as_deref() == Some(sym.lib_id.as_str()))?;
    let local = lib_bbox(node, sym.unit, include_pins);
    if local.is_empty() {
        return None;
    }
    Some(world_box(&local, sym.placement))
}

/// Advance width of every printable ASCII character in KiCad's stroke font, in
/// twenty-firsts of an em (the font's own grid: every measured advance came out
/// an exact multiple of 1/21 of the text size). Index = codepoint - 0x20.
///
/// Measured against KiCad 10.0.4: `kicad-cli sch export svg` writes an invisible
/// `<text ... textLength="W">` next to every plotted string, and `W` is the width
/// KiCad itself computed for it (the `StringBoundaryLimits` that eeschema's
/// `GetTextBox` - and so `GetBoundingBox` - is built on). Each entry is the
/// difference between an eightfold and a fourfold repetition of the character,
/// divided by four, so it is the advance including side bearings and independent
/// of the neighbours. `crates/sch-read/tests/text_metrics.rs` re-measures the
/// model against kicad-cli under `FLUXSMITH_CONFORMANCE=required`.
#[rustfmt::skip]
const ADV_21: [u8; 95] = [
    // ' '  !   "   #   $   %   &   '   (   )   *   +   ,   -   .   /
       16, 10, 16, 21, 20, 24, 26, 10, 14, 14, 16, 26, 10, 26, 10, 22,
    //  0   1   2   3   4   5   6   7   8   9
       20, 20, 20, 20, 20, 20, 20, 20, 20, 20,
    //  :   ;   <   =   >   ?   @
       10, 10, 26, 26, 26, 18, 27,
    //  A   B   C   D   E   F   G   H   I   J   K   L   M
       18, 21, 21, 21, 19, 18, 21, 22, 10, 16, 21, 17, 24,
    //  N   O   P   Q   R   S   T   U   V   W   X   Y   Z
       22, 22, 21, 22, 21, 20, 16, 22, 18, 24, 20, 18, 20,
    //  [   \   ]   ^   _   `
       14, 14, 14, 12, 16,  8,
    //  a   b   c   d   e   f   g   h   i   j   k   l   m
       19, 19, 18, 19, 18, 12, 19, 19, 10, 10, 17, 11, 28,
    //  n   o   p   q   r   s   t   u   v   w   x   y   z
       19, 19, 19, 19, 13, 17, 12, 19, 16, 22, 17, 16, 17,
    //  {   |   }   ~
       14, 20, 14, 15,
];

/// Advance of the non-ASCII characters that turn up in schematic text - the unit
/// and maths symbols of a value string, the Greek letters, the typographic
/// punctuation a datasheet paste brings along - measured the same way as
/// [`ADV_21`]. Sorted by codepoint. Accented Latin is not listed: KiCad draws it
/// at the width of the base letter, which is within a twenty-first of the
/// [`ADV_21_OTHER`] default.
#[rustfmt::skip]
const ADV_21_EXTRA: [(u32, u8); 38] = [
    (0x00A0, 16), // no-break space
    (0x00A7, 18), // section
    (0x00A9, 36), // copyright
    (0x00AE, 36), // registered
    (0x00B0, 16), // degree
    (0x00B1, 26), // plus-minus
    (0x00B2, 16), // superscript two
    (0x00B3, 16), // superscript three
    (0x00B4,  8), // acute
    (0x00B5, 22), // micro
    (0x00B7, 16), // middle dot
    (0x00BD, 22), // one half
    (0x00D7, 26), // multiplication
    (0x00F7, 26), // division
    (0x0394, 18), // capital delta
    (0x03A9, 24), // capital omega
    (0x03BC, 22), // small mu
    (0x03C0, 23), // small pi
    (0x2013, 12), // en dash
    (0x2014, 24), // em dash
    (0x2018, 10), // left single quote
    (0x2019, 10), // right single quote
    (0x201C, 16), // left double quote
    (0x201D, 16), // right double quote
    (0x2026, 30), // ellipsis
    (0x2030, 36), // per mille
    (0x2032, 10), // prime
    (0x2033, 16), // double prime
    (0x20AC, 21), // euro
    (0x2122, 24), // trade mark
    (0x2126, 24), // ohm sign
    (0x2192, 26), // rightwards arrow
    (0x2211, 26), // n-ary summation
    (0x221A, 25), // square root
    (0x223C, 26), // tilde operator
    (0x2260, 26), // not equal
    (0x2264, 26), // less than or equal
    (0x2265, 26), // greater than or equal
];

/// Advance of a full-width CJK ideograph, in twenty-firsts of an em (1.476 em:
/// KiCad's stroke font draws Han characters wider than a full square).
const ADV_21_IDEOGRAPH: u32 = 31;
/// Advance of kana, CJK punctuation and the full-width forms (1.048 em).
const ADV_21_KANA: u32 = 22;
/// Advance of half-width katakana (0.524 em).
const ADV_21_HALFWIDTH: u32 = 11;
/// Advance used for a codepoint no measurement covers - accented Latin, Greek,
/// Cyrillic, symbols. The measured spread there is 16..27 twenty-firsts, so one
/// em is the middle of it and never far wrong. (Hangul is the one script KiCad
/// 10's stroke font draws nothing for, and it takes no space at all; the model
/// still reserves an em, which over-reserves rather than misses an overlap.)
const ADV_21_OTHER: u32 = 21;

/// Pen the strokes of a text are drawn with, in mil: eeschema's default line
/// width, which `kicad-cli` plots at every text size (a 25 mil and a 200 mil
/// text both come out with a 6 mil stroke). It widens the drawn text by one pen
/// over the sum of the advances.
pub const TEXT_PEN_MIL: f64 = 6.0;

/// Advance of one character in twenty-firsts of an em (see [`ADV_21`]).
fn advance_21(c: char) -> u32 {
    let u = c as u32;
    if (0x20..0x7F).contains(&u) {
        return ADV_21[(u - 0x20) as usize] as u32;
    }
    if let Ok(i) = ADV_21_EXTRA.binary_search_by_key(&u, |(cp, _)| *cp) {
        return ADV_21_EXTRA[i].1 as u32;
    }
    match u {
        // Han: unified, extension A, and the compatibility ideographs.
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF => ADV_21_IDEOGRAPH,
        // CJK punctuation, kana, kana extensions, full-width forms.
        0x3000..=0x30FF | 0x31F0..=0x31FF | 0xFF01..=0xFF60 | 0xFFE0..=0xFFE6 => ADV_21_KANA,
        0xFF61..=0xFF9F => ADV_21_HALFWIDTH,
        _ => ADV_21_OTHER,
    }
}

/// Width in mil of `text` drawn at `size_mil` with KiCad's stroke font: the sum
/// of the glyph advances plus one [`TEXT_PEN_MIL`] for the stroke itself. This
/// is the one text metric of the engine - the writer's placement searches, the
/// layout gate and the geometry the canvas draws all measure text through it.
pub fn text_width_mil(text: &str, size_mil: f64) -> f64 {
    let units: u32 = text.chars().map(advance_21).sum();
    if units == 0 {
        // Nothing is drawn, so there is nothing to collide with.
        return 0.0;
    }
    size_mil * units as f64 / 21.0 + TEXT_PEN_MIL
}

/// [`text_width_mil`] in nm.
pub fn text_width_nm(text: &str, size_mil: f64) -> Nm {
    mil_to_nm(text_width_mil(text, size_mil))
}

/// Bounding box of a label including its flag outline (approximation of
/// eeschema's `GetBoundingBox`: [`text_width_mil`] for the text, flag adds
/// ~1 size).
pub fn label_flag_bbox(text: &str, kind: &str, at: Pt, rot: f64, size_mil: f64) -> BBox {
    let mut len_mil = text_width_mil(text, size_mil) + size_mil * 0.5;
    if kind != "local" {
        len_mil += size_mil * 1.2;
    }
    let h_mil = size_mil * 1.4;
    let len = mil_to_nm(len_mil);
    let h = mil_to_nm(h_mil);
    let mut bb = BBox::empty();
    bb.include(at);
    let end = match (rot.round() as i64).rem_euclid(360) {
        0 => Pt::new(at.x + len, at.y - h),
        90 => Pt::new(at.x - h, at.y - len),
        180 => Pt::new(at.x - len, at.y - h),
        _ => Pt::new(at.x - h, at.y + len),
    };
    if kind == "local" {
        bb.include(end);
    } else {
        // global/hier flags are centred vertically on the anchor
        let hh = h / 2;
        match (rot.round() as i64).rem_euclid(360) {
            0 => {
                bb.include(Pt::new(at.x, at.y - hh));
                bb.include(Pt::new(at.x + len, at.y + hh));
            }
            90 => {
                bb.include(Pt::new(at.x - hh, at.y));
                bb.include(Pt::new(at.x + hh, at.y - len));
            }
            180 => {
                bb.include(Pt::new(at.x - len, at.y - hh));
                bb.include(Pt::new(at.x, at.y + hh));
            }
            _ => {
                bb.include(Pt::new(at.x - hh, at.y));
                bb.include(Pt::new(at.x + hh, at.y + len));
            }
        }
    }
    bb
}

/// Approximate box of `text` at `size_mil`, anchored at `at` with rotation `rot`
/// (0/90) and justification (`left`, `right`, or centred). The width comes from
/// [`text_width_mil`], so a `W` counts for more than an `i` and a Han character
/// for three of them.
pub fn text_bbox(text: &str, at: Pt, rot: i64, size_mil: f64, justify: &str) -> BBox {
    let len = text_width_nm(text, size_mil);
    let h = mil_to_nm(size_mil * 1.2);
    let (a, b) = match justify {
        "left" => (0, len),
        "right" => (-len, 0),
        _ => (-len / 2, len / 2),
    };
    let mut bb = BBox::empty();
    if rot.rem_euclid(180) == 90 {
        bb.include(Pt::new(at.x - h / 2, at.y - b));
        bb.include(Pt::new(at.x + h / 2, at.y - a));
    } else {
        bb.include(Pt::new(at.x + a, at.y - h / 2));
        bb.include(Pt::new(at.x + b, at.y + h / 2));
    }
    bb
}

/// Visible Reference / Value property texts of a placed symbol as
/// (label, box) pairs, read from the schematic node.
pub fn symbol_text_boxes(doc: &Document, sym: &SymbolInst) -> Vec<(String, BBox)> {
    property_boxes(doc, sym, false)
}

/// Every *visible* property text of a placed symbol as (label, box) pairs. Same boxes as
/// [`symbol_text_boxes`] for Reference and Value, plus any other field the author left
/// visible (a shown Footprint, a part number, a tolerance). The layout gate's field rules
/// work on this list: KiCad hides Footprint / Datasheet / Description by default, so on a
/// stock part the two lists are identical, but a field a human unhid collides like any other.
pub fn symbol_field_boxes(doc: &Document, sym: &SymbolInst) -> Vec<(String, BBox)> {
    property_boxes(doc, sym, true)
}

fn property_boxes(doc: &Document, sym: &SymbolInst, all_fields: bool) -> Vec<(String, BBox)> {
    let mut out = Vec::new();
    let Some(kicad_sexpr::Node::List(inst)) = doc.root.children.get(sym.node_index) else {
        return out;
    };
    for prop in inst.find_all("property") {
        let (Some(name), Some(val)) = (prop.arg(0), prop.arg(1)) else {
            continue;
        };
        if !all_fields && name != "Reference" && name != "Value" {
            continue;
        }
        let hidden = |l: &List| {
            l.find("hide")
                .map(|h| h.arg(0).map(|v| v == "yes").unwrap_or(true))
                .unwrap_or(false)
        };
        if hidden(prop) || prop.find("effects").map(hidden).unwrap_or(false) {
            continue;
        }
        let Some(at) = prop.find("at") else { continue };
        let (Some(x), Some(y)) = (
            at.arg(0).and_then(|v| mm_str_to_nm(&v)),
            at.arg(1).and_then(|v| mm_str_to_nm(&v)),
        ) else {
            continue;
        };
        let stored_rot = at.arg_f64(2).unwrap_or(0.0).round() as i64;
        let effects = prop.find("effects");
        let size_mil = effects
            .and_then(|e| e.find("font"))
            .and_then(|f| f.find("size"))
            .and_then(|s| s.arg_f64(0))
            .map(|mm| mm / 0.0254)
            .unwrap_or(50.0);
        let justify = effects
            .and_then(|e| e.find("justify"))
            .map(|j| {
                j.args()
                    .iter()
                    .find(|a| *a == "left" || *a == "right")
                    .cloned()
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let shown = if name == "Reference" {
            sym.reference.clone()
        } else {
            val.clone()
        };
        // An empty field draws nothing, so it has no box to collide with.
        if shown.is_empty() {
            continue;
        }
        out.push((
            format!("{} {}", sym.reference, name.to_lowercase()),
            field_bbox(
                &shown,
                Pt::new(x, y),
                stored_rot,
                size_mil,
                &justify,
                sym.placement,
            ),
        ));
    }
    out
}
