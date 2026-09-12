// SPDX-License-Identifier: Apache-2.0
//! Typed geometry for the canvas, overlays, bounding boxes and the layout
//! gate. The webview draws `render::RenderSheet` on a Canvas 2D context
//! (S-C1: KiCanvas is not vendored); the engine *decides* with the bboxes and
//! pin positions computed here (group overlap, layout gate, hit-test).

pub mod render;
pub use render::*;

use sch_model::*;
use sch_read::SheetTree;
use sch_write::gates::Finding;
use serde::{Deserialize, Serialize};

pub use sch_read::bbox::{label_flag_bbox, lib_body_bbox, symbol_bbox, BBox};

/// Approximate label text bbox: 1.27 mm font, ~1.0 mm per character.
pub fn label_bbox(l: &Label) -> BBox {
    let w = mm_to_nm(1.0) * l.text.chars().count() as Nm + mm_to_nm(0.5);
    let h = mm_to_nm(1.6);
    let mut bb = BBox::empty();
    bb.include(l.at);
    let end = match l.rot.rem_euclid(360) {
        0 => Pt::new(l.at.x + w, l.at.y - h),
        90 => Pt::new(l.at.x - h, l.at.y - w),
        180 => Pt::new(l.at.x - w, l.at.y - h),
        _ => Pt::new(l.at.x - h, l.at.y + w),
    };
    bb.include(end);
    bb
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeomSymbol {
    pub reference: String,
    pub uuid: String,
    pub unit: u32,
    pub bbox_mil: [[f64; 2]; 2],
    pub pins: Vec<GeomPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeomPin {
    pub number: String,
    pub name: String,
    pub at_mil: [f64; 2],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeomSheet {
    pub sheet_path: String,
    pub file: String,
    pub paper: String,
    pub symbols: Vec<GeomSymbol>,
    pub wires: Vec<[[f64; 2]; 2]>,
    pub labels: Vec<(String, [f64; 2], i64)>,
    pub sheet_symbols: Vec<(String, [[f64; 2]; 2])>,
}

/// Overlay geometry for one sheet instance (mil, +Y down).
pub fn sheet_geometry(tree: &SheetTree, sheet_path: &str) -> Option<GeomSheet> {
    let inst = tree
        .instances
        .iter()
        .find(|i| i.names == sheet_path || i.path == sheet_path)?;
    let sheet = &tree.files[&inst.file];
    let doc = &tree.docs[&inst.file];
    let mut symbols = Vec::new();
    for s in &sheet.symbols {
        let bb = symbol_bbox(doc, s).unwrap_or(BBox {
            min: s.placement.at,
            max: s.placement.at,
        });
        let pins = sheet
            .lib_symbol(&s.lib_id)
            .map(|l| {
                world_pins(s, l)
                    .into_iter()
                    .map(|p| GeomPin {
                        number: p.number,
                        name: p.name,
                        at_mil: [nm_to_mil(p.at.x), nm_to_mil(p.at.y)],
                    })
                    .collect()
            })
            .unwrap_or_default();
        let reference = s
            .instances
            .iter()
            .find(|r| r.path == inst.path)
            .map(|r| r.reference.clone())
            .unwrap_or_else(|| s.reference.clone());
        symbols.push(GeomSymbol {
            reference,
            uuid: s.uuid.clone(),
            unit: s.unit,
            bbox_mil: bb.to_mil(),
            pins,
        });
    }
    Some(GeomSheet {
        sheet_path: inst.names.clone(),
        file: inst.file.to_string_lossy().into_owned(),
        paper: sheet.paper.clone(),
        symbols,
        wires: sheet
            .wires
            .iter()
            .map(|w| {
                [
                    [nm_to_mil(w.a.x), nm_to_mil(w.a.y)],
                    [nm_to_mil(w.b.x), nm_to_mil(w.b.y)],
                ]
            })
            .collect(),
        labels: sheet
            .labels
            .iter()
            .map(|l| {
                (
                    l.text.clone(),
                    [nm_to_mil(l.at.x), nm_to_mil(l.at.y)],
                    l.rot,
                )
            })
            .collect(),
        sheet_symbols: sheet
            .sheets
            .iter()
            .map(|s| {
                (
                    s.name.clone(),
                    BBox {
                        min: s.at,
                        max: s.at.add(s.size),
                    }
                    .to_mil(),
                )
            })
            .collect(),
    })
}

/// Bounding box query over references or a region.
pub fn bbox_of(tree: &SheetTree, file: &std::path::Path, refs: &[String]) -> Option<BBox> {
    let sheet = tree.files.get(file)?;
    let doc = tree.docs.get(file)?;
    let mut bb = BBox::empty();
    for s in &sheet.symbols {
        if refs.is_empty() || refs.contains(&s.reference) {
            if let Some(b) = symbol_bbox(doc, s) {
                bb.union(&b);
            }
        }
    }
    (!bb.is_empty()).then_some(bb)
}

/// Overlap findings (`GROUP_OVERLAP`, `SYMBOL_OVERLAP`, `LABEL_OVER_BODY`,
/// `LABEL_OVERLAP`, and the text rules `TEXT_OVERLAP`, `FIELD_OVER_OWN_BODY`,
/// `FIELD_OVER_FIELD`, `LABEL_OVER_WIRE`) now live in `sch_write::gates::overlap`
/// so the write gate and the canvas agree; kept as an alias for callers.
pub fn overlap_findings(tree: &SheetTree) -> Vec<Finding> {
    sch_write::gates::overlap(tree)
}
