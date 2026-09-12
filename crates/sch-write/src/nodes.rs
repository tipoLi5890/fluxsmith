// SPDX-License-Identifier: Apache-2.0
//! Builders for new KiCad 10 schematic nodes. Every builder produces a
//! `kicad_sexpr::List` laid out with `pretty()` at the given indent so the
//! result matches KiCad's own formatter closely enough (KiCad re-formats on
//! save anyway; our own round-trip is byte-identical by construction).

use kicad_sexpr::{pretty, List, Node};
use sch_model::{nm_to_mm_str, Pt};

pub fn xy(p: Pt) -> Node {
    Node::call("xy", &[&nm_to_mm_str(p.x), &nm_to_mm_str(p.y)])
}

pub fn at(p: Pt, rot: i64) -> Node {
    Node::call(
        "at",
        &[&nm_to_mm_str(p.x), &nm_to_mm_str(p.y), &rot.to_string()],
    )
}

pub fn at2(p: Pt) -> Node {
    Node::call("at", &[&nm_to_mm_str(p.x), &nm_to_mm_str(p.y)])
}

pub fn uuid(u: &str) -> Node {
    Node::List(List::compact(vec![Node::bare("uuid"), Node::quoted(u)]))
}

fn font() -> Node {
    Node::List(List::compact(vec![
        Node::bare("font"),
        Node::call("size", &["1.27", "1.27"]),
    ]))
}

pub fn effects(justify: Option<&[&str]>, hide: bool) -> Node {
    let mut ch = vec![Node::bare("effects"), font()];
    if let Some(j) = justify {
        let mut jl = vec![Node::bare("justify")];
        for s in j {
            jl.push(Node::bare(s));
        }
        ch.push(Node::List(List::compact(jl)));
    }
    if hide {
        ch.push(Node::call("hide", &["yes"]));
    }
    Node::List(List::compact(ch))
}

pub fn stroke(width_nm: i64) -> Node {
    Node::List(List::compact(vec![
        Node::bare("stroke"),
        Node::call("width", &[&nm_to_mm_str(width_nm)]),
        Node::call("type", &["default"]),
    ]))
}

pub fn fill(kind: &str) -> Node {
    Node::List(List::compact(vec![
        Node::bare("fill"),
        Node::call("type", &[kind]),
    ]))
}

pub fn property(
    name: &str,
    value: &str,
    p: Pt,
    rot: i64,
    justify: Option<&[&str]>,
    hide: bool,
) -> Node {
    Node::List(List::compact(vec![
        Node::bare("property"),
        Node::quoted(name),
        Node::quoted(value),
        at(p, rot),
        effects(justify, hide),
    ]))
}

pub struct SymbolSpec<'a> {
    pub lib_id: &'a str,
    pub at: Pt,
    pub rot: i64,
    pub mirror: &'a str,
    pub unit: u32,
    pub uuid: &'a str,
    pub reference: &'a str,
    pub value: &'a str,
    pub footprint: &'a str,
    pub extra_props: &'a [(String, String)],
    /// (pin number, pin uuid)
    pub pins: &'a [(String, String)],
    /// (project name, instance path, reference, unit)
    pub instances: &'a [(String, String, String, u32)],
    pub dnp: bool,
    pub in_bom: bool,
    pub on_board: bool,
    /// Text placement for Reference/Value: offsets from the anchor.
    pub ref_at: Pt,
    pub val_at: Pt,
    pub text_justify: Option<&'a [&'a str]>,
    /// Property text angle (symbol frame); 90 keeps texts horizontal on a
    /// symbol rotated 90/270.
    pub text_rot: i64,
}

pub fn symbol(s: &SymbolSpec, indent: usize) -> List {
    symbol_with_autoplace(s, indent, false)
}

/// Like [`symbol`], but marks the symbol `(fields_autoplaced yes)` when the
/// engine, not the library, chose where the property texts go - the same flag
/// eeschema writes after `AUTOPLACE_FIELDS`, in the same slot (after `dnp`).
pub fn symbol_with_autoplace(s: &SymbolSpec, indent: usize, fields_autoplaced: bool) -> List {
    let yn = |b: bool| if b { "yes" } else { "no" };
    let mut ch = vec![
        Node::bare("symbol"),
        Node::List(List::compact(vec![
            Node::bare("lib_id"),
            Node::quoted(s.lib_id),
        ])),
        at(s.at, s.rot),
    ];
    if s.mirror != "none" {
        ch.push(Node::call("mirror", &[s.mirror]));
    }
    ch.push(Node::call("unit", &[&s.unit.to_string()]));
    ch.push(Node::call("exclude_from_sim", &["no"]));
    ch.push(Node::call("in_bom", &[yn(s.in_bom)]));
    ch.push(Node::call("on_board", &[yn(s.on_board)]));
    ch.push(Node::call("dnp", &[yn(s.dnp)]));
    if fields_autoplaced {
        ch.push(Node::call("fields_autoplaced", &["yes"]));
    }
    ch.push(uuid(s.uuid));
    ch.push(property(
        "Reference",
        s.reference,
        s.ref_at,
        s.text_rot,
        s.text_justify,
        false,
    ));
    ch.push(property(
        "Value",
        s.value,
        s.val_at,
        s.text_rot,
        s.text_justify,
        false,
    ));
    ch.push(property("Footprint", s.footprint, s.at, 0, None, true));
    ch.push(property("Datasheet", "", s.at, 0, None, true));
    ch.push(property("Description", "", s.at, 0, None, true));
    for (k, v) in s.extra_props {
        ch.push(property(k, v, s.at, 0, None, true));
    }
    for (num, pu) in s.pins {
        ch.push(Node::List(List::compact(vec![
            Node::bare("pin"),
            Node::quoted(num),
            uuid(pu),
        ])));
    }
    let mut inst = vec![Node::bare("instances")];
    // group by project
    let mut projects: Vec<&str> = Vec::new();
    for (p, _, _, _) in s.instances {
        if !projects.contains(&p.as_str()) {
            projects.push(p);
        }
    }
    for p in projects {
        let mut proj = vec![Node::bare("project"), Node::quoted(p)];
        for (pp, path, reference, unit) in s.instances {
            if pp == p {
                proj.push(Node::List(List::compact(vec![
                    Node::bare("path"),
                    Node::quoted(path),
                    Node::List(List::compact(vec![
                        Node::bare("reference"),
                        Node::quoted(reference),
                    ])),
                    Node::call("unit", &[&unit.to_string()]),
                ])));
            }
        }
        inst.push(Node::List(List::compact(proj)));
    }
    ch.push(Node::List(List::compact(inst)));
    let mut l = List::compact(ch);
    pretty(&mut l, indent);
    l
}

pub fn wire(a: Pt, b: Pt, u: &str, is_bus: bool, indent: usize) -> List {
    let mut l = List::compact(vec![
        Node::bare(if is_bus { "bus" } else { "wire" }),
        Node::List(List::compact(vec![Node::bare("pts"), xy(a), xy(b)])),
        stroke(0),
        uuid(u),
    ]);
    pretty(&mut l, indent);
    l
}

pub fn junction(p: Pt, u: &str, indent: usize) -> List {
    let mut l = List::compact(vec![
        Node::bare("junction"),
        at2(p),
        Node::call("diameter", &["0"]),
        Node::call("color", &["0", "0", "0", "0"]),
        uuid(u),
    ]);
    pretty(&mut l, indent);
    l
}

pub fn no_connect(p: Pt, u: &str, indent: usize) -> List {
    let mut l = List::compact(vec![Node::bare("no_connect"), at2(p), uuid(u)]);
    pretty(&mut l, indent);
    l
}

pub fn bus_entry(p: Pt, size: Pt, u: &str, indent: usize) -> List {
    let mut l = List::compact(vec![
        Node::bare("bus_entry"),
        at2(p),
        Node::call("size", &[&nm_to_mm_str(size.x), &nm_to_mm_str(size.y)]),
        stroke(0),
        uuid(u),
    ]);
    pretty(&mut l, indent);
    l
}

/// `kind` is `label`, `global_label` or `hierarchical_label`.
pub fn label(
    kind: &str,
    text: &str,
    p: Pt,
    rot: i64,
    shape: Option<&str>,
    u: &str,
    indent: usize,
) -> List {
    let justify: &[&str] = match rot {
        0 | 90 => &["left", "bottom"],
        _ => &["right", "bottom"],
    };
    let mut ch = vec![Node::bare(kind), Node::quoted(text)];
    if let Some(s) = shape {
        ch.push(Node::call("shape", &[s]));
    }
    ch.push(at(p, rot));
    if kind == "global_label" {
        ch.push(Node::call("fields_autoplaced", &["yes"]));
    }
    ch.push(effects(Some(justify), false));
    ch.push(uuid(u));
    if kind == "global_label" {
        ch.push(property(
            "Intersheetrefs",
            "${INTERSHEET_REFS}",
            p,
            rot,
            Some(justify),
            true,
        ));
    }
    let mut l = List::compact(ch);
    pretty(&mut l, indent);
    l
}

pub fn text(t: &str, p: Pt, angle: i64, u: &str, indent: usize) -> List {
    let mut l = List::compact(vec![
        Node::bare("text"),
        Node::quoted(t),
        Node::call("exclude_from_sim", &["no"]),
        at(p, angle),
        effects(Some(&["left", "bottom"]), false),
        uuid(u),
    ]);
    pretty(&mut l, indent);
    l
}

pub fn rectangle(a: Pt, b: Pt, width_nm: i64, fill_kind: &str, u: &str, indent: usize) -> List {
    let mut l = List::compact(vec![
        Node::bare("rectangle"),
        Node::call("start", &[&nm_to_mm_str(a.x), &nm_to_mm_str(a.y)]),
        Node::call("end", &[&nm_to_mm_str(b.x), &nm_to_mm_str(b.y)]),
        stroke(width_nm),
        fill(fill_kind),
        uuid(u),
    ]);
    pretty(&mut l, indent);
    l
}

pub fn text_box(t: &str, p: Pt, size: Pt, angle: i64, u: &str, indent: usize) -> List {
    let mut l = List::compact(vec![
        Node::bare("text_box"),
        Node::quoted(t),
        Node::call("exclude_from_sim", &["no"]),
        at(p, angle),
        Node::call("size", &[&nm_to_mm_str(size.x), &nm_to_mm_str(size.y)]),
        Node::call("margins", &["0.9525", "0.9525", "0.9525", "0.9525"]),
        stroke(0),
        fill("none"),
        effects(Some(&["left", "top"]), false),
        uuid(u),
    ]);
    pretty(&mut l, indent);
    l
}

pub fn sheet_pin(name: &str, kind: &str, p: Pt, rot: i64, u: &str) -> Node {
    let justify: &[&str] = match rot {
        0 | 90 => &["left"],
        _ => &["right"],
    };
    Node::List(List::compact(vec![
        Node::bare("pin"),
        Node::quoted(name),
        Node::bare(kind),
        at(p, rot),
        effects(Some(justify), false),
        uuid(u),
    ]))
}

pub struct SheetSpec<'a> {
    pub at: Pt,
    pub size: Pt,
    pub uuid: &'a str,
    pub name: &'a str,
    pub file: &'a str,
    /// (name, kind, position, rotation, uuid)
    pub pins: &'a [(String, String, Pt, i64, String)],
    pub project: &'a str,
    pub parent_path: &'a str,
    pub page: &'a str,
}

pub fn sheet(s: &SheetSpec, indent: usize) -> List {
    let mut ch = vec![
        Node::bare("sheet"),
        at2(s.at),
        Node::call("size", &[&nm_to_mm_str(s.size.x), &nm_to_mm_str(s.size.y)]),
        Node::call("exclude_from_sim", &["no"]),
        Node::call("in_bom", &["yes"]),
        Node::call("on_board", &["yes"]),
        Node::call("dnp", &["no"]),
        Node::call("fields_autoplaced", &["yes"]),
        stroke(152_400),
        Node::List(List::compact(vec![
            Node::bare("fill"),
            Node::call("color", &["0", "0", "0", "0.0000"]),
        ])),
        uuid(s.uuid),
        property(
            "Sheetname",
            s.name,
            Pt::new(s.at.x, s.at.y - 711_200),
            0,
            Some(&["left", "bottom"]),
            false,
        ),
        property(
            "Sheetfile",
            s.file,
            Pt::new(s.at.x, s.at.y + s.size.y + 584_200),
            0,
            Some(&["left", "top"]),
            false,
        ),
    ];
    for (name, kind, p, rot, u) in s.pins {
        ch.push(sheet_pin(name, kind, *p, *rot, u));
    }
    ch.push(Node::List(List::compact(vec![
        Node::bare("instances"),
        Node::List(List::compact(vec![
            Node::bare("project"),
            Node::quoted(s.project),
            Node::List(List::compact(vec![
                Node::bare("path"),
                Node::quoted(s.parent_path),
                Node::List(List::compact(vec![
                    Node::bare("page"),
                    Node::quoted(s.page),
                ])),
            ])),
        ])),
    ])));
    let mut l = List::compact(ch);
    pretty(&mut l, indent);
    l
}

/// A brand-new empty schematic file (KiCad 10).
pub fn empty_schematic(root_uuid: &str, paper: &str) -> String {
    format!(
        "(kicad_sch\n\t(version {})\n\t(generator \"eeschema\")\n\t(generator_version \"{}\")\n\t(uuid \"{}\")\n\t(paper \"{}\")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n",
        sch_read::WRITE_VERSION,
        sch_read::WRITE_GENERATOR_VERSION,
        root_uuid,
        paper
    )
}

/// Minimal KiCad project file (`.kicad_pro`) accepted by `kicad-cli` and the
/// GUI; KiCad fills in the remaining sections on first save.
pub fn empty_project(name: &str) -> String {
    format!(
        "{{\n  \"board\": {{\n    \"design_settings\": {{}},\n    \"layer_presets\": [],\n    \"viewports\": []\n  }},\n  \"boards\": [],\n  \"cvpcb\": {{\n    \"equivalence_files\": []\n  }},\n  \"libraries\": {{\n    \"pinned_footprint_libs\": [],\n    \"pinned_symbol_libs\": []\n  }},\n  \"meta\": {{\n    \"filename\": \"{name}.kicad_pro\",\n    \"version\": 3\n  }},\n  \"net_settings\": {{\n    \"classes\": [\n      {{\n        \"name\": \"Default\",\n        \"priority\": 2147483647\n      }}\n    ],\n    \"meta\": {{\n      \"version\": 4\n    }}\n  }},\n  \"pcbnew\": {{\n    \"page_layout_descr_file\": \"\"\n  }},\n  \"schematic\": {{\n    \"legacy_lib_dir\": \"\",\n    \"legacy_lib_list\": []\n  }},\n  \"sheets\": [],\n  \"text_variables\": {{}}\n}}\n"
    )
}
