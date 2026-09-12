// SPDX-License-Identifier: Apache-2.0
//! EasyEDA / LCSC CAD JSON → `sch_libwrite::PartSpec` (symbol artwork,
//! footprint pads/graphics, 3D model reference).
//!
//! The shape-string grammar and unit conventions are ported from the
//! JLC2KiCadLib project (TousstNicolas, MIT) — a design reference, not a
//! dependency: no Python and no GPL `KicadModTree` are involved. Every result
//! is a CLAIM: pin names, numbers and pad geometry must be verified against
//! the datasheet before they are trusted.
//!
//! Input is the JSON returned by
//! `https://easyeda.com/api/products/<LCSC>/components?version=6.4.19.5`
//! (`result.dataStr` = symbol document, `result.packageDetail.dataStr` =
//! footprint document). Coordinates in both documents are in EasyEDA units of
//! 10 mil (`x * 0.254 mm`). Symbols are y-down in EasyEDA and y-up in KiCad
//! libraries, so symbol y is negated; footprints keep y-down.

use sch_libwrite::{
    FootprintSpec, FpShape, ModelRef, PadSpec, PartSpec, PinPlace, PinSpec, SymShape,
    SymbolGraphics,
};
use serde_json::Value;

/// 10 mil in millimetres.
const UNIT_MM: f64 = 0.254;

/// What the converter learned about a part before writing anything.
#[derive(Debug, Clone)]
pub struct Converted {
    pub spec: PartSpec,
    /// EasyEDA uuid of the 3D model (`SVGNODE.attrs.uuid`), if any.
    pub model_uuid: Option<String>,
    /// Vendor-provided datasheet link, if any.
    pub datasheet_url: Option<String>,
    pub manufacturer: String,
    pub package: String,
    pub warnings: Vec<String>,
    /// Shape kinds that were skipped (unknown handlers).
    pub skipped: Vec<String>,
}

fn mm(v: f64) -> f64 {
    round4(v * UNIT_MM)
}

fn round4(v: f64) -> f64 {
    let r = (v * 10000.0).round() / 10000.0;
    if r == 0.0 {
        0.0
    } else {
        r
    }
}

fn snap(v: f64, grid: f64) -> f64 {
    round4((v / grid).round() * grid)
}

fn num(s: &str) -> Option<f64> {
    s.trim().trim_end_matches("pt").parse::<f64>().ok()
}

fn str_of<'a>(v: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut cur = v;
    for p in path {
        cur = cur.get(p)?;
    }
    cur.as_str()
}

fn f64_of(v: &Value, path: &[&str]) -> Option<f64> {
    let mut cur = v;
    for p in path {
        cur = cur.get(p)?;
    }
    cur.as_f64().or_else(|| cur.as_str().and_then(num))
}

/// Make a name safe for `(symbol "...")` / file names.
pub fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        match ch {
            '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*' | ' ' => out.push('_'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    if out.is_empty() {
        "PART".into()
    } else {
        out.chars().take(120).collect()
    }
}

/// Convert the product JSON (`{"success":true,"result":{...}}` or the bare
/// `result` object).
pub fn convert(product: &Value) -> Result<Converted, String> {
    let r = product.get("result").unwrap_or(product);
    let head = r
        .get("dataStr")
        .and_then(|d| d.get("head"))
        .ok_or("EasyEDA JSON has no dataStr.head")?;
    let c_para = head.get("c_para").cloned().unwrap_or(Value::Null);
    let lcsc = str_of(r, &["lcsc", "number"])
        .or_else(|| str_of(&c_para, &["Supplier Part"]))
        .unwrap_or("")
        .to_string();
    let title = r
        .get("title")
        .and_then(|t| t.as_str())
        .or_else(|| str_of(&c_para, &["name"]))
        .unwrap_or("PART");
    let mpn = str_of(&c_para, &["Manufacturer Part"])
        .unwrap_or(title)
        .to_string();
    let manufacturer = str_of(&c_para, &["Manufacturer"]).unwrap_or("").to_string();
    let package = str_of(&c_para, &["package"]).unwrap_or("").to_string();
    let prefix = str_of(&c_para, &["pre"])
        .unwrap_or("U?")
        .trim_end_matches('?')
        .to_string();
    let description = r
        .get("description")
        .and_then(|d| d.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let tags: Vec<&str> = r
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            format!("{mpn} {package} {}", tags.join(" "))
                .trim()
                .to_string()
        });
    let mut warnings = Vec::new();
    let mut skipped = Vec::new();

    // ---- symbol
    let origin = (
        f64_of(head, &["x"]).unwrap_or(0.0),
        f64_of(head, &["y"]).unwrap_or(0.0),
    );
    let shapes: Vec<&str> = r
        .get("dataStr")
        .and_then(|d| d.get("shape"))
        .and_then(|s| s.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let mut sym = SymbolGraphics {
        hide_pin_names: true,
        hide_pin_numbers: true,
        ..Default::default()
    };
    let mut pins: Vec<PinSpec> = Vec::new();
    for line in shapes {
        let args: Vec<&str> = line.split('~').collect();
        match args.first().copied().unwrap_or("") {
            "P" => symbol_pin(&args[1..], origin, &mut sym, &mut pins, &mut warnings),
            "R" => {
                if let (Some(x), Some(y), Some(w), Some(h)) = (
                    args.get(1).and_then(|s| num(s)),
                    args.get(2).and_then(|s| num(s)),
                    args.get(5).and_then(|s| num(s)),
                    args.get(6).and_then(|s| num(s)),
                ) {
                    sym.shapes.push(SymShape::Rect {
                        start: [mm(x - origin.0), mm(-(y - origin.1))],
                        end: [mm(x + w - origin.0), mm(-(y + h - origin.1))],
                        fill: true,
                    });
                }
            }
            "E" => {
                if let (Some(x), Some(y), Some(rx)) = (
                    args.get(1).and_then(|s| num(s)),
                    args.get(2).and_then(|s| num(s)),
                    args.get(3).and_then(|s| num(s)),
                ) {
                    sym.shapes.push(SymShape::Circle {
                        center: [mm(x - origin.0), mm(-(y - origin.1))],
                        radius: mm(rx),
                        fill: false,
                    });
                }
            }
            "PL" | "PG" | "PT" => {
                let pts = points_of(args.get(1).copied().unwrap_or(""));
                let mut v: Vec<[f64; 2]> = pts
                    .iter()
                    .map(|p| [mm(p.0 - origin.0), mm(-(p.1 - origin.1))])
                    .collect();
                let closed = args[0] != "PL";
                if closed && v.len() >= 2 && v.first() != v.last() {
                    v.push(v[0]);
                }
                if v.len() >= 2 {
                    sym.shapes.push(SymShape::Polyline {
                        pts: v,
                        fill: closed,
                    });
                }
            }
            "A" => {
                if let Some((s, m, e)) = svg_arc(args.get(1).copied().unwrap_or("")) {
                    sym.shapes.push(SymShape::Arc {
                        start: [mm(s.0 - origin.0), mm(-(s.1 - origin.1))],
                        mid: [mm(m.0 - origin.0), mm(-(m.1 - origin.1))],
                        end: [mm(e.0 - origin.0), mm(-(e.1 - origin.1))],
                    });
                }
            }
            "T" => {
                // T~<mark>~x~y~rot~color~font~size~...~text~...
                let text = args.get(12).copied().unwrap_or("").trim();
                let mark = args.get(1).copied().unwrap_or("");
                // Skip the symbol's own name/prefix labels (KiCad has properties).
                if text.is_empty() || matches!(mark, "N" | "P") {
                    continue;
                }
                if let (Some(x), Some(y)) = (
                    args.get(2).and_then(|s| num(s)),
                    args.get(3).and_then(|s| num(s)),
                ) {
                    let size = args.get(7).and_then(|s| num(s)).unwrap_or(7.0) * 0.1667;
                    sym.shapes.push(SymShape::Text {
                        text: text.to_string(),
                        at: [mm(x - origin.0), mm(-(y - origin.1))],
                        angle: args.get(4).and_then(|s| num(s)).unwrap_or(0.0),
                        size: round4(size.clamp(0.8, 2.54)),
                    });
                }
            }
            other => {
                if !other.is_empty() {
                    skipped.push(format!("symbol:{other}"));
                }
            }
        }
    }
    if pins.is_empty() {
        return Err("EasyEDA symbol has no pins".into());
    }
    // Duplicate pin numbers are legal in EasyEDA (stacked pins); KiCad accepts
    // duplicates in the same unit too, but warn so the reviewer looks at them.
    {
        let mut seen = std::collections::BTreeSet::new();
        for p in &pins {
            if !seen.insert(p.number.clone()) {
                warnings.push(format!("duplicate pin number {}", p.number));
            }
        }
    }

    // ---- footprint
    let mut model_uuid = None;
    let mut datasheet_url = None;
    let mut footprint = None;
    if let Some(pd) = r.get("packageDetail") {
        let fp_head = pd.get("dataStr").and_then(|d| d.get("head"));
        let fp_origin = (
            fp_head.and_then(|h| f64_of(h, &["x"])).unwrap_or(0.0),
            fp_head.and_then(|h| f64_of(h, &["y"])).unwrap_or(0.0),
        );
        datasheet_url = fp_head
            .and_then(|h| str_of(h, &["c_para", "link"]))
            .filter(|s| s.starts_with("http"))
            .map(|s| s.to_string());
        let fp_name_raw = pd
            .get("title")
            .and_then(|t| t.as_str())
            .or_else(|| fp_head.and_then(|h| str_of(h, &["c_para", "package"])))
            .unwrap_or(&package);
        let fp_name = sanitize_name(fp_name_raw);
        let fp_shapes: Vec<&str> = pd
            .get("dataStr")
            .and_then(|d| d.get("shape"))
            .and_then(|s| s.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let mut fp = FootprintSpec {
            name: fp_name,
            description: format!("{package} (EasyEDA/LCSC {lcsc}, converted claim)"),
            pads: vec![],
            outline_mm: vec![],
            model_path: None,
            graphics: vec![],
            model: None,
        };
        let mut model_attrs: Option<(String, [f64; 3], [f64; 3])> = None;
        for line in fp_shapes {
            let args: Vec<&str> = line.split('~').collect();
            match args.first().copied().unwrap_or("") {
                "PAD" => fp_pad(&args[1..], fp_origin, &mut fp, &mut warnings),
                "TRACK" => {
                    let width = args.get(1).and_then(|s| num(s)).map(mm).unwrap_or(0.1);
                    let layer = layer_name(args.get(2).copied().unwrap_or(""));
                    let pts = points_of(args.get(4).copied().unwrap_or(""));
                    for w in pts.windows(2) {
                        fp.graphics.push(FpShape::Line {
                            start: [mm(w[0].0 - fp_origin.0), mm(w[0].1 - fp_origin.1)],
                            end: [mm(w[1].0 - fp_origin.0), mm(w[1].1 - fp_origin.1)],
                            width,
                            layer: layer.clone(),
                        });
                    }
                }
                "CIRCLE" => {
                    // CIRCLE~cx~cy~r~width~layer~id...
                    if args.get(5).copied() == Some("100") {
                        continue; // pad-decoration circles
                    }
                    if let (Some(x), Some(y), Some(rad)) = (
                        args.get(1).and_then(|s| num(s)),
                        args.get(2).and_then(|s| num(s)),
                        args.get(3).and_then(|s| num(s)),
                    ) {
                        fp.graphics.push(FpShape::Circle {
                            center: [mm(x - fp_origin.0), mm(y - fp_origin.1)],
                            radius: mm(rad),
                            width: args.get(4).and_then(|s| num(s)).map(mm).unwrap_or(0.1),
                            layer: layer_name(args.get(5).copied().unwrap_or("")),
                            fill: false,
                        });
                    }
                }
                "ARC" => {
                    // ARC~width~layer~net~path~...
                    if let Some((s, m, e)) = svg_arc(args.get(4).copied().unwrap_or("")) {
                        let width = args.get(1).and_then(|s| num(s)).map(mm).unwrap_or(0.1);
                        let layer = layer_name(args.get(2).copied().unwrap_or(""));
                        if (s.0 - e.0).abs() < 1e-6 && (s.1 - e.1).abs() < 1e-6 {
                            // full circle drawn as an arc
                            let r = ((m.0 - s.0).powi(2) + (m.1 - s.1).powi(2)).sqrt() / 2.0;
                            fp.graphics.push(FpShape::Circle {
                                center: [
                                    mm((s.0 + m.0) / 2.0 - fp_origin.0),
                                    mm((s.1 + m.1) / 2.0 - fp_origin.1),
                                ],
                                radius: mm(r),
                                width,
                                layer,
                                fill: false,
                            });
                        } else {
                            fp.graphics.push(FpShape::Arc {
                                start: [mm(s.0 - fp_origin.0), mm(s.1 - fp_origin.1)],
                                mid: [mm(m.0 - fp_origin.0), mm(m.1 - fp_origin.1)],
                                end: [mm(e.0 - fp_origin.0), mm(e.1 - fp_origin.1)],
                                width,
                                layer,
                            });
                        }
                    }
                }
                "SOLIDREGION" => {
                    // SOLIDREGION~layer~net~path~type~id...
                    let layer = if args.get(4).copied() == Some("npth") {
                        "Edge.Cuts".to_string()
                    } else {
                        layer_name(args.get(1).copied().unwrap_or(""))
                    };
                    let pts = svg_path_points(args.get(3).copied().unwrap_or(""));
                    let v: Vec<[f64; 2]> = pts
                        .iter()
                        .map(|p| [mm(p.0 - fp_origin.0), mm(p.1 - fp_origin.1)])
                        .collect();
                    if v.len() >= 3 {
                        fp.graphics.push(FpShape::Poly {
                            pts: v,
                            width: 0.0,
                            layer,
                            fill: true,
                        });
                    }
                }
                "RECT" => {
                    // RECT~x~y~w~h~layer~id~~width
                    if let (Some(x), Some(y), Some(w), Some(h)) = (
                        args.get(1).and_then(|s| num(s)),
                        args.get(2).and_then(|s| num(s)),
                        args.get(3).and_then(|s| num(s)),
                        args.get(4).and_then(|s| num(s)),
                    ) {
                        let width = args.get(8).and_then(|s| num(s)).map(mm).unwrap_or(0.0);
                        fp.graphics.push(FpShape::Rect {
                            start: [mm(x - fp_origin.0), mm(y - fp_origin.1)],
                            end: [mm(x + w - fp_origin.0), mm(y + h - fp_origin.1)],
                            width: if width == 0.0 { 0.05 } else { width },
                            layer: layer_name(args.get(5).copied().unwrap_or("")),
                            fill: width == 0.0,
                        });
                    }
                }
                "HOLE" => {
                    if let (Some(x), Some(y), Some(rad)) = (
                        args.get(1).and_then(|s| num(s)),
                        args.get(2).and_then(|s| num(s)),
                        args.get(3).and_then(|s| num(s)),
                    ) {
                        fp.pads.push(PadSpec {
                            number: String::new(),
                            kind: "thru_hole".into(),
                            shape: "circle".into(),
                            at_mm: [mm(x - fp_origin.0), mm(y - fp_origin.1)],
                            size_mm: [mm(rad * 2.0), mm(rad * 2.0)],
                            drill_mm: Some(mm(rad * 2.0)),
                            rotation: 0.0,
                            side: Some("npth".into()),
                            drill_size_mm: None,
                            polygon_mm: vec![],
                        });
                    }
                }
                "SVGNODE" => {
                    if let Ok(v) = serde_json::from_str::<Value>(args.get(1).copied().unwrap_or(""))
                    {
                        let attrs = v.get("attrs").cloned().unwrap_or(Value::Null);
                        if let Some(uuid) = attrs.get("uuid").and_then(|u| u.as_str()) {
                            let co: Vec<f64> = attrs
                                .get("c_origin")
                                .and_then(|s| s.as_str())
                                .map(|s| s.split(',').filter_map(num).collect())
                                .unwrap_or_default();
                            let rot: Vec<f64> = attrs
                                .get("c_rotation")
                                .and_then(|s| s.as_str())
                                .map(|s| s.split(',').filter_map(num).collect())
                                .unwrap_or_default();
                            let z = attrs
                                .get("z")
                                .and_then(|s| s.as_str())
                                .and_then(num)
                                .unwrap_or(0.0);
                            let off = [
                                mm(co.first().copied().unwrap_or(fp_origin.0) - fp_origin.0),
                                -mm(co.get(1).copied().unwrap_or(fp_origin.1) - fp_origin.1),
                                mm(z),
                            ];
                            let rt = [
                                -rot.first().copied().unwrap_or(0.0),
                                -rot.get(1).copied().unwrap_or(0.0),
                                -rot.get(2).copied().unwrap_or(0.0),
                            ];
                            model_attrs = Some((uuid.to_string(), off, rt));
                        }
                    }
                }
                "VIA" => {
                    warnings.push("footprint has vias (not converted); check thermal design".into())
                }
                "TEXT" => {}
                other => {
                    if !other.is_empty() {
                        skipped.push(format!("footprint:{other}"));
                    }
                }
            }
        }
        if let Some((uuid, off, rt)) = model_attrs {
            model_uuid = Some(uuid);
            fp.model = Some(ModelRef {
                path: String::new(),
                offset_mm: off,
                rotate_deg: rt,
            });
        }
        if fp.pads.iter().any(|p| p.side.as_deref() != Some("npth")) {
            footprint = Some(fp);
        } else {
            warnings.push("EasyEDA package has no pads; footprint skipped".into());
        }
    } else {
        warnings.push("no packageDetail in EasyEDA JSON; footprint skipped".into());
    }
    skipped.sort();
    skipped.dedup();

    // EasyEDA pin type 0 ("unspecified") on a passive is just "not filled in": KiCad ERC would warn on every
    // converted R / C / L, so two-pin parts and passive prefixes get `passive`.
    let passive_prefix = matches!(
        prefix.as_str(),
        "R" | "C" | "L" | "D" | "FB" | "Y" | "F" | "TVS"
    );
    if pins.iter().all(|p| p.kind == "unspecified") && (pins.len() == 2 || passive_prefix) {
        for p in pins.iter_mut() {
            p.kind = "passive".into();
        }
    }
    // Symbol pins and footprint pads must name the same set (the classic EasyEDA failure is an exposed pad
    // the symbol never mentions, or pin "A1" against pad "1").
    if let Some(fp) = &footprint {
        let pin_nums: std::collections::BTreeSet<&str> =
            pins.iter().map(|p| p.number.as_str()).collect();
        let pad_nums: std::collections::BTreeSet<&str> = fp
            .pads
            .iter()
            .map(|p| p.number.as_str())
            .filter(|n| !n.is_empty())
            .collect();
        let pins_without_pad: Vec<&str> = pin_nums.difference(&pad_nums).copied().collect();
        let pads_without_pin: Vec<&str> = pad_nums.difference(&pin_nums).copied().collect();
        if !pins_without_pad.is_empty() {
            warnings.push(format!(
                "PIN_PAD_MISMATCH: symbol pins {} have no footprint pad",
                pins_without_pad.join(", ")
            ));
        }
        if !pads_without_pin.is_empty() {
            warnings.push(format!(
                "PIN_PAD_MISMATCH: footprint pads {} have no symbol pin",
                pads_without_pin.join(", ")
            ));
        }
        if fp.pads.iter().any(|p| p.number.is_empty()) {
            warnings.push("PIN_PAD_MISMATCH: a footprint pad has no number".into());
        }
    }
    // Provenance travels with the symbol: the conversion is a CLAIM, and the pin/pad mismatches
    // found above are the concrete reason to distrust it. `sch-check` reads these back from the
    // schematic's `lib_symbols` cache (PIN_PAD_MISMATCH) and the delivery gate lists the claim
    // (PART_UNVERIFIED) — without them the warnings died inside this function.
    let mut properties: Vec<(String, String)> = vec![(
        sch_libwrite::CLAIM_PROPERTY.to_string(),
        sch_libwrite::CLAIM_UNVERIFIED.to_string(),
    )];
    if !lcsc.is_empty() {
        properties.push((
            sch_libwrite::SOURCE_PROPERTY.to_string(),
            format!("easyeda:{lcsc}"),
        ));
    }
    let mismatch: Vec<&str> = warnings
        .iter()
        .filter_map(|w| w.strip_prefix("PIN_PAD_MISMATCH: "))
        .collect();
    if !mismatch.is_empty() {
        properties.push((
            sch_libwrite::PIN_PAD_MISMATCH_PROPERTY.to_string(),
            mismatch.join("; "),
        ));
    }
    let spec = PartSpec {
        name: sanitize_name(&mpn),
        reference_prefix: if prefix.is_empty() {
            "U".into()
        } else {
            prefix
        },
        value: mpn.clone(),
        description,
        keywords: format!("{lcsc} {package}").trim().to_string(),
        datasheet: datasheet_url.clone().unwrap_or_default(),
        mpn: mpn.clone(),
        lcsc: lcsc.clone(),
        footprint_lib: String::new(),
        pins,
        footprint,
        model_step_base64: None,
        graphics: Some(sym),
        properties,
    };
    Ok(Converted {
        spec,
        model_uuid,
        datasheet_url,
        manufacturer,
        package,
        warnings,
        skipped,
    })
}

fn symbol_pin(
    d: &[&str],
    origin: (f64, f64),
    sym: &mut SymbolGraphics,
    pins: &mut Vec<PinSpec>,
    warnings: &mut Vec<String>,
) {
    // Indices follow the `~`-split of the whole pin string (the `^^` group
    // separators stay inside fields), exactly as JLC2KiCadLib documents them.
    let kind = match d.get(1).copied() {
        Some("1") => "input",
        Some("2") => "output",
        Some("3") => "bidirectional",
        Some("4") => "power_in",
        _ => "unspecified",
    };
    let number_raw = d.get(2).copied().unwrap_or("");
    let shown = d.get(21).copied().unwrap_or("").trim();
    let number = if shown.is_empty() { number_raw } else { shown }
        .trim()
        .to_string();
    let name = d.get(13).copied().unwrap_or("").trim().to_string();
    let (Some(x), Some(y)) = (d.get(3).and_then(|s| num(s)), d.get(4).and_then(|s| num(s))) else {
        warnings.push(format!("pin {number}: no position"));
        return;
    };
    let rot = d.get(5).and_then(|s| num(s)).unwrap_or(0.0) as i32;
    let angle = ((rot + 180) % 360 + 360) % 360;
    // d[8] = "<y>^^M x y h -10": pin path; length is the h/v magnitude.
    let path = d.get(8).copied().unwrap_or("");
    let len_units = path
        .rsplit(['h', 'v'])
        .next()
        .and_then(|s| num(s.trim()))
        .map(|v| v.abs())
        .unwrap_or(10.0);
    let length = mm(len_units);
    if d.get(9)
        .map(|s| s.split("^^").nth(1) != Some("0"))
        .unwrap_or(false)
    {
        sym.hide_pin_names = false;
    }
    if d.get(17)
        .map(|s| s.split("^^").nth(1) != Some("0"))
        .unwrap_or(false)
    {
        sym.hide_pin_numbers = false;
    }
    if number.is_empty() {
        warnings.push(format!("pin at ({x},{y}) has no number; skipped"));
        return;
    }
    let at = [
        snap(mm(x - origin.0), 1.27),
        snap(mm(-(y - origin.1)), 1.27),
    ];
    sym.pins.push(PinPlace {
        number: number.clone(),
        at_mm: at,
        angle,
        length_mm: if length > 0.0 { length } else { 2.54 },
    });
    pins.push(PinSpec {
        number,
        name: if name.is_empty() { "~".into() } else { name },
        kind: kind.into(),
        side: match angle {
            180 => "right".into(),
            0 => "left".into(),
            90 => "bottom".into(),
            _ => "top".into(),
        },
    });
}

fn fp_pad(d: &[&str], origin: (f64, f64), fp: &mut FootprintSpec, warnings: &mut Vec<String>) {
    // PAD~shape~x~y~w~h~layer~net~number~drillRadius~polygon~rotation~id~drillOffset~..~plated
    let shape = d.first().copied().unwrap_or("");
    let (Some(x), Some(y), Some(w), Some(h)) = (
        d.get(1).and_then(|s| num(s)),
        d.get(2).and_then(|s| num(s)),
        d.get(3).and_then(|s| num(s)),
        d.get(4).and_then(|s| num(s)),
    ) else {
        warnings.push("pad without geometry skipped".into());
        return;
    };
    let layer = d.get(5).copied().unwrap_or("1");
    let number = d.get(7).copied().unwrap_or("").trim().to_string();
    let drill_d = d.get(8).and_then(|s| num(s)).unwrap_or(0.0) * 2.0;
    let rotation = d.get(10).and_then(|s| num(s)).unwrap_or(0.0);
    let drill_off = d.get(12).and_then(|s| num(s)).unwrap_or(0.0);
    let plated = d.get(14).copied().map(|s| s.trim() != "N").unwrap_or(true);
    let at = [mm(x - origin.0), mm(y - origin.1)];
    let (kind, side) = match layer {
        "11" => ("thru_hole", if plated { "thru" } else { "npth" }),
        "2" => ("smd", "bottom"),
        "1" => ("smd", "top"),
        _ => {
            warnings.push(format!(
                "pad {number}: unknown layer {layer}, assumed top SMD"
            ));
            ("smd", "top")
        }
    };
    let mut size = [mm(w), mm(h)];
    let mut polygon = vec![];
    let kshape = match shape {
        "OVAL" => "oval",
        "RECT" => "rect",
        "ELLIPSE" => "circle",
        "POLYGON" => {
            let pts = points_of(d.get(9).copied().unwrap_or(""));
            polygon = pts
                .iter()
                .map(|p| [mm(p.0 - origin.0) - at[0], mm(p.1 - origin.1) - at[1]])
                .collect();
            size = [0.1, 0.1];
            "custom"
        }
        other => {
            warnings.push(format!("pad {number}: unknown shape {other}, using oval"));
            "oval"
        }
    };
    let drill_size = if kind == "thru_hole" && drill_d > 0.0 {
        if drill_off > 0.0 && shape == "OVAL" {
            let (a, b) = (mm(drill_d), mm(drill_off));
            // orient the slot like the pad
            if (drill_d < drill_off) ^ (w > h) {
                Some([a, b])
            } else {
                Some([b, a])
            }
        } else if drill_off > 0.0 {
            Some([mm(drill_d), mm(drill_off)])
        } else {
            Some([mm(drill_d), mm(drill_d)])
        }
    } else {
        None
    };
    fp.pads.push(PadSpec {
        number,
        kind: kind.into(),
        shape: kshape.into(),
        at_mm: at,
        size_mm: size,
        drill_mm: drill_size.map(|d| d[0]),
        rotation,
        side: Some(side.into()),
        drill_size_mm: drill_size,
        polygon_mm: polygon,
    });
}

fn layer_name(id: &str) -> String {
    match id.trim() {
        "1" => "F.Cu",
        "2" => "B.Cu",
        "3" => "F.SilkS",
        "4" => "B.SilkS",
        "5" => "F.Paste",
        "6" => "B.Paste",
        "7" => "F.Mask",
        "8" => "B.Mask",
        "10" => "Edge.Cuts",
        "12" => "F.Fab",
        "13" => "B.Fab",
        "14" => "F.CrtYd",
        "15" => "B.CrtYd",
        _ => "Cmts.User",
    }
    .to_string()
}

fn points_of(s: &str) -> Vec<(f64, f64)> {
    let nums: Vec<f64> = s
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter_map(|t| {
            let t = t.trim_matches(|c: char| c.is_alphabetic());
            num(t)
        })
        .collect();
    nums.chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| (c[0], c[1]))
        .collect()
}

/// SVG path (`M x y L x y A rx ry rot large sweep x y Z`) → polyline points
/// (arcs flattened to 8 segments).
fn svg_path_points(path: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut cur = (0.0, 0.0);
    let mut cmd = 'M';
    let mut nums: Vec<f64> = Vec::new();
    let flush =
        |cmd: char, nums: &mut Vec<f64>, cur: &mut (f64, f64), out: &mut Vec<(f64, f64)>| {
            match cmd {
                'M' | 'L' => {
                    for c in nums.chunks(2) {
                        if c.len() == 2 {
                            *cur = (c[0], c[1]);
                            out.push(*cur);
                        }
                    }
                }
                'A' => {
                    for c in nums.chunks(7) {
                        if c.len() == 7 {
                            let end = (c[5], c[6]);
                            if let Some((cx, cy, r, a0, da)) =
                                arc_center(*cur, c[0], c[3] != 0.0, c[4] != 0.0, end)
                            {
                                for i in 1..=8 {
                                    let a = a0 + da * (i as f64) / 8.0;
                                    out.push((cx + r * a.cos(), cy + r * a.sin()));
                                }
                            } else {
                                out.push(end);
                            }
                            *cur = end;
                        }
                    }
                }
                _ => {}
            }
            nums.clear();
        };
    for tok in path
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|t| !t.is_empty())
    {
        let c = tok.chars().next().unwrap();
        if c.is_ascii_alphabetic() {
            flush(cmd, &mut nums, &mut cur, &mut out);
            cmd = c.to_ascii_uppercase();
            let rest = &tok[1..];
            if let Some(v) = num(rest) {
                nums.push(v);
            }
        } else if let Some(v) = num(tok) {
            nums.push(v);
        }
    }
    flush(cmd, &mut nums, &mut cur, &mut out);
    out
}

/// Circle-arc centre from SVG endpoint parameters (rx == ry assumed).
/// Returns (cx, cy, r, start_angle, sweep).
fn arc_center(
    s: (f64, f64),
    r: f64,
    large: bool,
    sweep: bool,
    e: (f64, f64),
) -> Option<(f64, f64, f64, f64, f64)> {
    let (dx, dy) = ((e.0 - s.0) / 2.0, (e.1 - s.1) / 2.0);
    let d2 = dx * dx + dy * dy;
    if d2 == 0.0 || r <= 0.0 {
        return None;
    }
    let r = r.max(d2.sqrt());
    let h = ((r * r - d2).max(0.0) / d2).sqrt();
    let sign = if large == sweep { -1.0 } else { 1.0 };
    let (mx, my) = (s.0 + dx, s.1 + dy);
    let (cx, cy) = (mx + sign * h * -dy, my + sign * h * dx);
    let a0 = (s.1 - cy).atan2(s.0 - cx);
    let a1 = (e.1 - cy).atan2(e.0 - cx);
    let mut da = a1 - a0;
    let tau = std::f64::consts::TAU;
    if sweep && da < 0.0 {
        da += tau;
    } else if !sweep && da > 0.0 {
        da -= tau;
    }
    Some((cx, cy, r, a0, da))
}

/// SVG `M x y A rx ry rot large sweep x y` → (start, mid, end) points.
type Pt = (f64, f64);

fn svg_arc(path: &str) -> Option<(Pt, Pt, Pt)> {
    let mut nums: Vec<f64> = Vec::new();
    for tok in path
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|t| !t.is_empty())
    {
        let t = tok.trim_start_matches(|c: char| c.is_ascii_alphabetic());
        if let Some(v) = num(t) {
            nums.push(v);
        }
    }
    if nums.len() < 9 {
        return None;
    }
    let s = (nums[0], nums[1]);
    let (r, large, sweep) = (nums[2], nums[5] != 0.0, nums[6] != 0.0);
    let e = (nums[7], nums[8]);
    if (s.0 - e.0).abs() < 1e-9 && (s.1 - e.1).abs() < 1e-9 {
        // full circle: report the diametrically opposite point as "mid"
        let c = if sweep {
            (s.0 + r, s.1)
        } else {
            (s.0 - r, s.1)
        };
        return Some((s, (2.0 * c.0 - s.0, 2.0 * c.1 - s.1), e));
    }
    let (cx, cy, r, a0, da) = arc_center(s, r, large, sweep, e)?;
    let am = a0 + da / 2.0;
    Some((s, (cx + r * am.cos(), cy + r * am.sin()), e))
}

/// STEP model download URL for an EasyEDA 3D model uuid (the bucket id is a
/// constant of the EasyEDA web client, as documented by JLC2KiCadLib).
pub fn step_model_url(model_uuid: &str) -> String {
    format!("https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{model_uuid}")
}

/// EasyEDA product endpoint for an LCSC number.
pub fn product_url(lcsc: &str) -> String {
    format!(
        "https://easyeda.com/api/products/{}/components?version=6.4.19.5",
        normalize_lcsc(lcsc)
    )
}

/// `c2040` / `2040` / ` C2040 ` → `C2040`.
pub fn normalize_lcsc(s: &str) -> String {
    let t = s.trim().trim_start_matches(['c', 'C']);
    format!("C{}", t.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    #[test]
    fn rp2040_symbol_and_footprint() {
        let c = convert(&fixture("C2040.json")).unwrap();
        assert_eq!(c.spec.lcsc, "C2040");
        assert_eq!(c.spec.name, "RP2040");
        assert_eq!(c.spec.pins.len(), 57, "56 pins + EP");
        let g = c.spec.graphics.as_ref().unwrap();
        assert_eq!(g.pins.len(), 57);
        // every pin sits on the 1.27 mm grid
        for p in &g.pins {
            for v in p.at_mm {
                assert!(((v / 1.27).round() * 1.27 - v).abs() < 1e-6, "{v}");
            }
        }
        let fp = c.spec.footprint.as_ref().unwrap();
        assert!(
            fp.pads.iter().filter(|p| p.number == "57").count() >= 1,
            "exposed pad present"
        );
        assert!(fp.pads.len() >= 57);
        assert!(fp.pads.iter().all(|p| p.kind == "smd"));
        assert!(c.model_uuid.is_some());
        assert!(c.datasheet_url.as_deref().unwrap_or("").ends_with(".pdf"));
        let text = sch_libwrite::write_symbol_lib(None, &c.spec).unwrap();
        let syms = sch_read::parse_symbol_lib(&text, "jlc", std::path::Path::new("jlc.kicad_sym"))
            .unwrap();
        assert_eq!(syms.len(), 1);
        assert_eq!(syms[0].pins.len(), 57);
        let p1 = syms[0].pins.iter().find(|p| p.number == "1").unwrap();
        assert_eq!(p1.name, "IOVDD");
        assert_eq!(
            syms[0].pins.iter().find(|p| p.number == "57").unwrap().name,
            "GND"
        );
        assert!(
            c.warnings.iter().all(|w| !w.contains("duplicate")),
            "{:?}",
            c.warnings
        );
        assert_eq!(syms[0].property("Footprint"), Some(fp.name.as_str()));
        let fp_text = sch_libwrite::write_footprint(fp).unwrap();
        let doc = kicad_sexpr::parse(&fp_text).unwrap();
        assert_eq!(kicad_sexpr::dumps(&doc), fp_text);
    }

    #[test]
    fn capacitor_0603_is_two_pad_smd() {
        let c = convert(&fixture("C14663.json")).unwrap();
        assert_eq!(c.spec.reference_prefix, "C");
        assert_eq!(c.spec.pins.len(), 2);
        let fp = c.spec.footprint.as_ref().unwrap();
        assert_eq!(fp.pads.len(), 2);
        let d = (fp.pads[0].at_mm[0] - fp.pads[1].at_mm[0]).abs();
        assert!((d - 1.4).abs() < 0.05, "0603 pad pitch {d}");
        assert!(fp
            .graphics
            .iter()
            .any(|g| matches!(g, FpShape::Line { layer, .. } if layer == "F.SilkS")));
    }

    #[test]
    fn header_is_through_hole() {
        let c = convert(&fixture("C124375.json")).unwrap();
        let fp = c.spec.footprint.as_ref().unwrap();
        assert_eq!(fp.pads.len(), 2);
        assert!(fp
            .pads
            .iter()
            .all(|p| p.kind == "thru_hole" && p.side.as_deref() == Some("thru")));
        let drill = fp.pads[0].drill_mm.unwrap();
        assert!((drill - 1.1).abs() < 0.05, "drill {drill}");
        let text = sch_libwrite::write_footprint(fp).unwrap();
        assert!(text.contains("(attr through_hole)"));
        let sym = sch_libwrite::write_symbol_lib(None, &c.spec).unwrap();
        assert!(
            sch_read::parse_symbol_lib(&sym, "jlc", std::path::Path::new("x.kicad_sym")).is_ok()
        );
    }

    /// The claim and its pin/pad mismatch detail must leave `convert` as symbol properties: they
    /// are the only way `sch-check` / the delivery gate can see them once the part is placed.
    #[test]
    fn claim_and_mismatch_travel_as_symbol_properties() {
        let c = convert(&fixture("C14663.json")).unwrap();
        assert!(c
            .warnings
            .iter()
            .all(|w| !w.starts_with("PIN_PAD_MISMATCH")));
        let get = |spec: &PartSpec, k: &str| {
            spec.properties
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            get(&c.spec, "fluxsmith_claim").as_deref(),
            Some("unverified")
        );
        assert_eq!(
            get(&c.spec, "fluxsmith_source").as_deref(),
            Some("easyeda:C14663")
        );
        assert!(get(&c.spec, "fluxsmith_pin_pad_mismatch").is_none());

        // Same part with pad "1" renamed "A1": the symbol pin "1" now has no pad and pad "A1" has
        // no pin, and both halves are recorded on the symbol.
        let mut fx = fixture("C14663.json");
        let shapes = fx["result"]["packageDetail"]["dataStr"]["shape"]
            .as_array_mut()
            .unwrap();
        for s in shapes.iter_mut() {
            let text = s.as_str().unwrap_or("").to_string();
            if text.starts_with("PAD~") {
                let mut parts: Vec<&str> = text.split('~').collect();
                if parts.get(8).copied() == Some("1") {
                    parts[8] = "A1";
                    *s = Value::String(parts.join("~"));
                }
            }
        }
        let c = convert(&fx).unwrap();
        let detail = get(&c.spec, "fluxsmith_pin_pad_mismatch").unwrap();
        assert!(
            detail.contains("symbol pins 1 have no footprint pad"),
            "{detail}"
        );
        assert!(
            detail.contains("footprint pads A1 have no symbol pin"),
            "{detail}"
        );
        let text = sch_libwrite::write_symbol_lib(None, &c.spec).unwrap();
        let syms = sch_read::parse_symbol_lib(&text, "jlc", std::path::Path::new("jlc.kicad_sym"))
            .unwrap();
        assert_eq!(syms[0].property("fluxsmith_claim"), Some("unverified"));
        assert_eq!(
            syms[0].property("fluxsmith_pin_pad_mismatch"),
            Some(detail.as_str())
        );
    }

    #[test]
    fn helpers() {
        assert_eq!(normalize_lcsc(" c2040 "), "C2040");
        assert_eq!(normalize_lcsc("2040"), "C2040");
        assert_eq!(sanitize_name("AMS1117-3.3/SOT"), "AMS1117-3.3_SOT");
        let pts = svg_path_points("M 0 0 L 10 0 L 10 10 Z");
        assert_eq!(pts.len(), 3);
        let arc = svg_arc("M 0 0 A 5 5 0 0 1 10 0").unwrap();
        assert!((arc.1 .0 - 5.0).abs() < 1e-6);
        assert!((arc.1 .1.abs() - 5.0).abs() < 1e-6);
    }

    /// Runs only when kicad-cli is installed; `cargo test -p easyeda-convert -- --ignored`.
    #[test]
    #[ignore]
    fn kicad_cli_accepts_output() {
        let cli = [
            "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
            "kicad-cli",
        ]
        .iter()
        .find(|p| {
            std::process::Command::new(p)
                .arg("--version")
                .output()
                .is_ok()
        })
        .copied();
        let Some(cli) = cli else {
            eprintln!("kicad-cli not found; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        for fx in ["C2040.json", "C14663.json", "C124375.json"] {
            let c = convert(&fixture(fx)).unwrap();
            let sym = dir.path().join(format!("{}.kicad_sym", c.spec.name));
            std::fs::write(&sym, sch_libwrite::write_symbol_lib(None, &c.spec).unwrap()).unwrap();
            let out = std::process::Command::new(cli)
                .args(["sym", "export", "svg", "-o"])
                .arg(dir.path().join("svg"))
                .arg(&sym)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{fx} sym: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            let fp = c.spec.footprint.as_ref().unwrap();
            let pretty = dir.path().join("jlc.pretty");
            std::fs::create_dir_all(&pretty).unwrap();
            std::fs::write(
                pretty.join(format!("{}.kicad_mod", fp.name)),
                sch_libwrite::write_footprint(fp).unwrap(),
            )
            .unwrap();
            let out = std::process::Command::new(cli)
                .args(["fp", "export", "svg", "-o"])
                .arg(dir.path().join("fpsvg"))
                .arg(&pretty)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{fx} fp: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }
}
