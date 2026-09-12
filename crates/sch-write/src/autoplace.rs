// SPDX-License-Identifier: Apache-2.0
//! Field autoplace for symbols this engine places, equivalent to eeschema's
//! `AUTOPLACE_FIELDS` (`eeschema/autoplace_fields.cpp`), which runs on every
//! newly placed symbol while "Automatically place symbol fields" is on - the
//! default. KiCad's own libraries rely on it: `Device:R` anchors its Value on
//! the symbol origin (inside the body) and `Regulator_Linear:AMS1117-3.3` puts
//! Reference and Value on one row.
//!
//! The algorithm, in eeschema's order:
//!
//! 1. Body box = the unit's *graphics* box (`SCH_SYMBOL::GetBodyBoundingBox`
//!    excludes pins and fields), taken through the single `transform_point`.
//! 2. Each pin's outward direction, also through `transform_point`, marks the
//!    side of the body it occupies.
//! 3. The field block goes on the first side of `SIDE_T`'s own preference
//!    order - right, top, left, bottom - that carries the fewest pins. A
//!    two-pin part drawn vertically therefore gets its fields on the right, a
//!    horizontal one gets them on top, and an IC with pins left/right/bottom
//!    (an LDO) gets them on top.
//! 4. Fields stack in order (Reference, Value, then any other visible field) at
//!    a 100 mil pitch, centred on the body across the stack axis, justified
//!    towards the body and set clear of it by 50 mil, every anchor snapped to
//!    the 50 mil grid away from the body.
//!
//! Calibrated against KiCad 10's own autoplaced output in
//! `SharedSupport/template/STM32_Nucleo-64_Morpho`: `Conn_02x19_Odd_Even` (top
//! side, fields at -29.21 / -26.67 mm from a body whose top edge is 24.13 mm
//! up and whose centre is +1.27 mm across) and `MountingHole` (right side,
//! `justify left`, -1.27 / +1.27 mm about the body centre) both come out of
//! the rules above.
//!
//! A symbol is only autoplaced when the library's own anchors would not do: an
//! anchor set that already clears the body, clears the other fields and gives
//! every field its own row is kept verbatim (`Device:C`, `Device:LED`,
//! `Device:Crystal`), so those symbols keep the position the library author
//! chose.

use kicad_sexpr::List;
use sch_model::*;
use sch_read::bbox::{field_bbox, lib_graphics_bbox, world_box, world_dir, BBox};

/// The only text size the writer emits (KiCad's default field size).
pub const FIELD_SIZE_MIL: f64 = 50.0;
/// Clear space kept between the body edge and the near edge of the field block.
const FIELD_GAP_MIL: f64 = 50.0;
/// Row pitch of a stacked field block (KiCad's autoplaced fields sit 100 mil
/// apart; see the `Conn_02x19_Odd_Even` and `MountingHole` calibration above).
const FIELD_PITCH_MIL: f64 = 100.0;
/// Everything the writer emits lives on eeschema's 50 mil connection grid.
const GRID_MIL: f64 = 50.0;

/// Side of the body a field block sits on, in eeschema's `SIDE_T` order, which
/// is also its preference order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Right,
    Top,
    Left,
    Bottom,
}

const SIDES: [Side; 4] = [Side::Right, Side::Top, Side::Left, Side::Bottom];

/// One placed property text. `rot` and `justify` are stored in the symbol
/// frame: KiCad composes `rot` with the symbol rotation and runs the box
/// through the symbol transform (see `sch_read::bbox::field_run_dir`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FieldPlace {
    pub at: Pt,
    pub justify: Option<&'static str>,
    pub rot: i64,
}

/// Where a symbol's visible property texts go, and whether the engine chose the
/// positions (`autoplaced`) or kept the library's own anchors.
#[derive(Clone, Debug)]
pub struct Fields {
    pub places: Vec<FieldPlace>,
    pub autoplaced: bool,
}

fn grid() -> Nm {
    mil_to_nm(GRID_MIL)
}

/// Snap to the grid line at or beyond `v` in the `+`/`-` direction, so a snap
/// never moves a field towards the body it was cleared from.
fn snap_away(v: Nm, positive: bool) -> Nm {
    let g = grid();
    if positive {
        v.div_euclid(g) * g + if v.rem_euclid(g) == 0 { 0 } else { g }
    } else {
        v.div_euclid(g) * g
    }
}

fn snap_round(v: Nm) -> Nm {
    let g = grid();
    ((v as f64 / g as f64).round() as Nm) * g
}

/// Which side of the body a pin sticks out of, from its outward direction.
fn pin_side(away: (i64, i64)) -> Option<Side> {
    match away {
        (1, 0) => Some(Side::Right),
        (-1, 0) => Some(Side::Left),
        // world +Y is down, so an outward vector of (0,-1) leaves the top edge
        (0, -1) => Some(Side::Top),
        (0, 1) => Some(Side::Bottom),
        _ => None,
    }
}

/// The side eeschema would choose: fewest pins, ties broken by `SIDE_T` order.
fn choose_side(pins: &[(Pt, (i64, i64))], pl: Placement) -> Side {
    let mut counts = [0usize; 4];
    for (_, v) in pins {
        if let Some(s) = pin_side(world_dir(*v, pl)) {
            counts[SIDES.iter().position(|x| *x == s).unwrap()] += 1;
        }
    }
    let min = counts.iter().copied().min().unwrap_or(0);
    SIDES[counts.iter().position(|c| *c == min).unwrap_or(0)]
}

/// Stack `n` fields on `side` of `body`. `stored_rot` keeps the drawn text
/// horizontal (KiCad composes it with the symbol rotation), and `run` is the
/// direction that text then runs in for a `left` justification.
fn stack(body: &BBox, side: Side, n: usize, stored_rot: i64, run: (i64, i64)) -> Vec<FieldPlace> {
    let gap = mil_to_nm(FIELD_GAP_MIL);
    let pitch = mil_to_nm(FIELD_PITCH_MIL);
    // `text_bbox` gives a 50 mil text a 60 mil box, so its centre sits 30 mil
    // from the near edge; a vertically centred row needs that much more room.
    let half_h = mil_to_nm(FIELD_SIZE_MIL * 1.2 / 2.0);
    let n_i = n as i64;
    // Rows are centred on the block, so row i is offset by (2i - (n-1))/2 pitch.
    let row = |i: usize| (2 * i as i64 - (n_i - 1)) * pitch / 2;
    // A `left` justification draws away from the anchor along `run`; to grow
    // away from the body the token flips when the transform flipped `run`.
    let toward = |want: (i64, i64)| -> Option<&'static str> {
        Some(if run == want { "left" } else { "right" })
    };
    match side {
        Side::Right => {
            let x = snap_away(body.max.x + gap, true);
            let cy = snap_round((body.min.y + body.max.y) / 2);
            let j = toward((1, 0));
            (0..n)
                .map(|i| FieldPlace {
                    at: Pt::new(x, cy + row(i)),
                    justify: j,
                    rot: stored_rot,
                })
                .collect()
        }
        Side::Left => {
            let x = snap_away(body.min.x - gap, false);
            let cy = snap_round((body.min.y + body.max.y) / 2);
            let j = toward((-1, 0));
            (0..n)
                .map(|i| FieldPlace {
                    at: Pt::new(x, cy + row(i)),
                    justify: j,
                    rot: stored_rot,
                })
                .collect()
        }
        Side::Top => {
            let cx = snap_round((body.min.x + body.max.x) / 2);
            // The last row is the one nearest the body; the block grows upward.
            let last = snap_away(body.min.y - gap - half_h, false);
            (0..n)
                .map(|i| FieldPlace {
                    at: Pt::new(cx, last - (n_i - 1 - i as i64) * pitch),
                    justify: None,
                    rot: stored_rot,
                })
                .collect()
        }
        Side::Bottom => {
            let cx = snap_round((body.min.x + body.max.x) / 2);
            let first = snap_away(body.max.y + gap + half_h, true);
            (0..n)
                .map(|i| FieldPlace {
                    at: Pt::new(cx, first + i as i64 * pitch),
                    justify: None,
                    rot: stored_rot,
                })
                .collect()
        }
    }
}

/// eeschema-equivalent autoplace for a symbol placed at `pl`. `texts` is the
/// drawn string of each visible field, Reference first (the stack only needs
/// how many there are; the widths decide whether a library's own anchors can
/// stand instead - see [`fields_clear`]).
pub fn autoplace(
    lib_node: &List,
    unit: u32,
    pins: &[(Pt, (i64, i64))],
    pl: Placement,
    texts: &[&str],
) -> Option<Vec<FieldPlace>> {
    let local = lib_graphics_bbox(lib_node, unit);
    if local.is_empty() || texts.is_empty() {
        return None;
    }
    let body = world_box(&local, pl);
    // The stored angle cancels the symbol rotation so the text draws
    // horizontally, which is what eeschema's autoplace always produces.
    let stored_rot = if matches!(pl.rot, Rot::R90 | Rot::R270) {
        90
    } else {
        0
    };
    let run = sch_read::bbox::field_run_dir(stored_rot, pl);
    Some(stack(
        &body,
        choose_side(pins, pl),
        texts.len(),
        stored_rot,
        run,
    ))
}

/// The library symbol's own anchors for `names`, transformed to world space and
/// snapped to the 50 mil grid. `None` when a name is missing or hidden, when
/// the fields disagree about angle or justification (this writer stores one of
/// each per symbol), or when the symbol is turned a quarter turn - the stored
/// angles then draw the texts sideways, which is exactly the case eeschema
/// autoplaces.
pub fn library_fields(lib_node: &List, pl: Placement, names: &[&str]) -> Option<Vec<FieldPlace>> {
    if matches!(pl.rot, Rot::R90 | Rot::R270) {
        return None;
    }
    let mut out = Vec::new();
    let mut angle: Option<i64> = None;
    let mut justify: Option<Option<&'static str>> = None;
    for name in names {
        let prop = lib_node
            .find_all("property")
            .find(|p| p.arg(0).as_deref() == Some(*name))?;
        let hidden = prop.find("hide").is_some()
            || prop
                .find("effects")
                .map(|e| e.find("hide").is_some())
                .unwrap_or(false);
        if hidden {
            return None;
        }
        let at = prop.find("at")?;
        let p = Pt::new(mm_str_to_nm(&at.arg(0)?)?, mm_str_to_nm(&at.arg(1)?)?);
        let a = (at.arg_f64(2).unwrap_or(0.0).round() as i64).rem_euclid(180);
        let j = prop
            .find("effects")
            .and_then(|e| e.find("justify"))
            .and_then(|l| {
                l.args().iter().find_map(|s| match s.as_str() {
                    "left" => Some("left"),
                    "right" => Some("right"),
                    _ => None,
                })
            });
        if *angle.get_or_insert(a) != a || *justify.get_or_insert(j) != j {
            return None;
        }
        let w = transform_point(p, pl);
        out.push(FieldPlace {
            at: Pt::new(snap_round(w.x), snap_round(w.y)),
            justify: j,
            rot: a,
        });
    }
    // Two fields on the same anchor is a library that never meant them to be
    // read where they are.
    if out.windows(2).any(|w| w[0].at == w[1].at) {
        return None;
    }
    Some(out)
}

/// Whether a field set can stand as it is: every box clear of the body, clear
/// of the other fields, and on a row of its own. eeschema's autoplace always
/// stacks fields one per row, and libraries lean on that -
/// `Regulator_Linear:AMS1117-3.3` parks `U` and `AMS1117-3.3` on one row where
/// an 11-character value runs off the end of the part.
pub fn fields_clear(places: &[FieldPlace], texts: &[&str], body: &BBox, pl: Placement) -> bool {
    let boxes: Vec<BBox> = places
        .iter()
        .zip(texts)
        .map(|(f, t)| field_bbox(t, f.at, f.rot, FIELD_SIZE_MIL, f.justify.unwrap_or(""), pl))
        .collect();
    if boxes.iter().any(|b| b.intersects(body)) {
        return false;
    }
    for (i, a) in boxes.iter().enumerate() {
        for (j, b) in boxes.iter().enumerate().skip(i + 1) {
            if a.intersects(b) {
                return false;
            }
            // Same row: the two boxes overlap across the axis their text runs
            // along, so they read as one line however far apart they sit.
            let run_a = sch_read::bbox::field_run_dir(places[i].rot, pl);
            let run_b = sch_read::bbox::field_run_dir(places[j].rot, pl);
            if run_a.0 != run_b.0 || run_a.1 != run_b.1 {
                continue;
            }
            let same_row = if run_a.0 == 0 {
                a.min.x < b.max.x && b.min.x < a.max.x
            } else {
                a.min.y < b.max.y && b.min.y < a.max.y
            };
            if same_row {
                return false;
            }
        }
    }
    true
}

/// Field anchors for a symbol of `lib_node` placed at `pl`: the library's own
/// anchors when they already read well, otherwise eeschema's autoplace.
pub fn place_fields(
    lib_node: &List,
    unit: u32,
    pins: &[(Pt, (i64, i64))],
    pl: Placement,
    names: &[&str],
    texts: &[&str],
) -> Option<Fields> {
    let local = lib_graphics_bbox(lib_node, unit);
    let body = world_box(&local, pl);
    if !local.is_empty() {
        if let Some(places) = library_fields(lib_node, pl, names) {
            if fields_clear(&places, texts, &body, pl) {
                return Some(Fields {
                    places,
                    autoplaced: false,
                });
            }
        }
    }
    autoplace(lib_node, unit, pins, pl, texts).map(|places| Fields {
        places,
        autoplaced: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_away_never_moves_towards_zero() {
        let g = grid();
        assert_eq!(snap_away(g, true), g);
        assert_eq!(snap_away(g + 1, true), 2 * g);
        assert_eq!(snap_away(-g - 1, false), -2 * g);
        assert_eq!(snap_away(-g, false), -g);
    }

    #[test]
    fn two_pin_vertical_part_takes_the_right_side() {
        let pl = Placement {
            at: Pt::new(0, 0),
            rot: Rot::R0,
            mirror: Mirror::None,
        };
        // outward directions of a part with pins up and down
        let pins = [(Pt::new(0, 0), (0, 1)), (Pt::new(0, 0), (0, -1))];
        assert_eq!(choose_side(&pins, pl), Side::Right);
    }

    #[test]
    fn two_pin_horizontal_part_takes_the_top_side() {
        let pl = Placement {
            at: Pt::new(0, 0),
            rot: Rot::R0,
            mirror: Mirror::None,
        };
        let pins = [(Pt::new(0, 0), (1, 0)), (Pt::new(0, 0), (-1, 0))];
        assert_eq!(choose_side(&pins, pl), Side::Top);
    }
}
