// SPDX-License-Identifier: Apache-2.0
//! Reader for `.kicad_sch`, `.kicad_sym`, and the sheet tree of a project.
//!
//! The reader never rewrites anything: it maps the lossless
//! [`kicad_sexpr::Document`] into the [`sch_model`] types and remembers the
//! root-child index of every top-level object so the writer can locate nodes.

use kicad_sexpr::{Document, List, Node};
use sch_model::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

pub mod bbox;

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("parse {path}: {source}")]
    Parse {
        path: PathBuf,
        source: kicad_sexpr::Error,
    },
    #[error("not a schematic: {path}")]
    NotSchematic { path: PathBuf },
    #[error("not a symbol library: {path}")]
    NotSymbolLib { path: PathBuf },
    #[error("unsupported schematic version {version} in {path}")]
    UnsupportedVersion { path: PathBuf, version: i64 },
    #[error("sheet file missing: {file} (referenced from {from})")]
    SheetFileMissing { file: String, from: PathBuf },
    #[error("sheet recursion: {file}")]
    SheetRecursion { file: String },
}

pub type Result<T> = std::result::Result<T, ReadError>;

/// Schematic `(version N)` integers fluxsmith knows how to read.
/// KiCad 6 = 20211123, 7 = 20230121, 8 = 20231120, 9 = 20250114, 10 = 20260306.
pub const KNOWN_VERSIONS_MIN: i64 = 20211123;
/// Versions strictly newer than this are refused (D-15 whitelist; extend per release).
pub const KNOWN_VERSIONS_MAX: i64 = 20260306;
/// The version fluxsmith writes for new files (KiCad 10).
pub const WRITE_VERSION: i64 = 20260306;
pub const WRITE_GENERATOR_VERSION: &str = "10.0";

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

fn at_of(l: &List) -> Option<(Pt, i64)> {
    let at = l.find("at")?;
    let x = mm_str_to_nm(&at.arg(0)?)?;
    let y = mm_str_to_nm(&at.arg(1)?)?;
    let r = at
        .arg(2)
        .and_then(|s| s.parse::<f64>().ok())
        .map(|v| v.round() as i64)
        .unwrap_or(0);
    Some((Pt::new(x, y), r))
}

fn uuid_of(l: &List) -> String {
    l.find("uuid").and_then(|u| u.arg(0)).unwrap_or_default()
}

fn yes_no(l: &List, name: &str, default: bool) -> bool {
    match l.find(name).and_then(|n| n.arg(0)) {
        Some(v) => v == "yes",
        None => default,
    }
}

fn properties_of(l: &List) -> Vec<(String, String)> {
    l.find_all("property")
        .filter_map(|p| Some((p.arg(0)?, p.arg(1).unwrap_or_default())))
        .collect()
}

fn prop<'a>(props: &'a [(String, String)], name: &str) -> Option<&'a str> {
    props
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

// ---------------------------------------------------------------------------
// Library symbols
// ---------------------------------------------------------------------------

fn parse_lib_pin(p: &List, unit: u32, convert: u32) -> Option<LibPin> {
    // (pin passive line (at x y angle) (length l) (name "N" ...) (number "1" ...) (hide yes)?)
    let kind = PinType::parse(&p.arg(0).unwrap_or_default());
    let (at, angle) = at_of(p)?;
    let length = p
        .find("length")
        .and_then(|l| l.arg(0))
        .and_then(|s| mm_str_to_nm(&s))
        .unwrap_or(0);
    let name = p.find("name").and_then(|n| n.arg(0)).unwrap_or_default();
    let number = p.find("number").and_then(|n| n.arg(0)).unwrap_or_default();
    let hide = p
        .find("hide")
        .map(|h| h.arg(0).as_deref() != Some("no"))
        .unwrap_or(false)
        || p.args().iter().any(|a| a == "hide");
    Some(LibPin {
        number,
        name,
        kind,
        at,
        angle,
        length,
        unit,
        convert,
        hide,
    })
}

/// Parse a `(symbol "Name" ...)` library symbol (with nested unit symbols).
pub fn parse_lib_symbol(s: &List, id_override: Option<&str>) -> Option<LibSymbol> {
    let raw_id = s.arg(0)?;
    let id = id_override.map(|x| x.to_string()).unwrap_or(raw_id.clone());
    // `(power)` / `(power global)` / `(power local)`. KiCad 9 added the argument;
    // an absent one means global (that is what a KiCad 8 file means).
    let power = s.find("power");
    let is_power = power.is_some();
    let power_scope = match power.and_then(|p| p.arg(0)).as_deref() {
        Some("local") => PowerScope::Local,
        _ => PowerScope::Global,
    };
    let extends = s.find("extends").and_then(|e| e.arg(0));
    let properties = properties_of(s);
    let mut pins = Vec::new();
    let mut unit_count = 1u32;
    // pins directly under the symbol (rare, unit 0)
    for p in s.find_all("pin") {
        if let Some(lp) = parse_lib_pin(p, 0, 0) {
            pins.push(lp);
        }
    }
    let base_name = raw_id.rsplit(':').next().unwrap_or(&raw_id).to_string();
    for sub in s.find_all("symbol") {
        let name = sub.arg(0).unwrap_or_default();
        // "<base>_<unit>_<convert>"
        let suffix = name
            .strip_prefix(&base_name)
            .and_then(|r| r.strip_prefix('_'))
            .unwrap_or("");
        let mut parts = suffix.split('_');
        let unit: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let convert: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        if unit > unit_count {
            unit_count = unit;
        }
        for p in sub.find_all("pin") {
            if let Some(lp) = parse_lib_pin(p, unit, convert) {
                pins.push(lp);
            }
        }
    }
    Some(LibSymbol {
        id,
        pins,
        unit_count,
        is_power,
        power_scope,
        extends,
        properties,
    })
}

/// Resolve `(extends)` chains inside one library: derived symbols inherit pins
/// and unit count from the parent, overriding properties.
pub fn flatten_extends(symbols: &mut [LibSymbol]) {
    let by_name: HashMap<String, LibSymbol> = symbols
        .iter()
        .map(|s| (short_name(&s.id).to_string(), s.clone()))
        .collect();
    for s in symbols.iter_mut() {
        let mut chain: Vec<String> = Vec::new();
        let mut cur = s.extends.clone();
        let mut pins: Option<Vec<LibPin>> = None;
        let mut unit_count = s.unit_count;
        let mut is_power = s.is_power;
        let mut power_scope = s.power_scope;
        while let Some(parent_name) = cur {
            if chain.contains(&parent_name) || chain.len() > 16 {
                break;
            }
            chain.push(parent_name.clone());
            let Some(parent) = by_name.get(&parent_name) else {
                break;
            };
            if pins.is_none() && !parent.pins.is_empty() {
                pins = Some(parent.pins.clone());
                unit_count = parent.unit_count;
                if !is_power && parent.is_power {
                    power_scope = parent.power_scope;
                }
                is_power = is_power || parent.is_power;
            }
            for (k, v) in &parent.properties {
                if !s.properties.iter().any(|(pk, _)| pk == k) {
                    s.properties.push((k.clone(), v.clone()));
                }
            }
            cur = parent.extends.clone();
        }
        if let Some(p) = pins {
            if s.pins.is_empty() {
                s.pins = p;
                s.unit_count = unit_count;
                s.is_power = is_power;
                s.power_scope = power_scope;
            }
        }
    }
}

fn short_name(id: &str) -> &str {
    id.rsplit(':').next().unwrap_or(id)
}

/// Parse a `.kicad_sym` file. Ids are prefixed with `nickname:`.
pub fn parse_symbol_lib(src: &str, nickname: &str, path: &Path) -> Result<Vec<LibSymbol>> {
    let doc = kicad_sexpr::parse(src).map_err(|e| ReadError::Parse {
        path: path.to_path_buf(),
        source: e,
    })?;
    if !doc.root.is_named("kicad_symbol_lib") {
        return Err(ReadError::NotSymbolLib {
            path: path.to_path_buf(),
        });
    }
    let mut out = Vec::new();
    for s in doc.root.find_all("symbol") {
        let raw = s.arg(0).unwrap_or_default();
        let id = format!("{nickname}:{raw}");
        if let Some(sym) = parse_lib_symbol(s, Some(&id)) {
            out.push(sym);
        }
    }
    flatten_extends(&mut out);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Schematic
// ---------------------------------------------------------------------------

fn parse_instances(l: &List) -> Vec<InstanceRef> {
    let mut out = Vec::new();
    if let Some(inst) = l.find("instances") {
        for proj in inst.find_all("project") {
            let project = proj.arg(0).unwrap_or_default();
            for p in proj.find_all("path") {
                out.push(InstanceRef {
                    project: project.clone(),
                    path: p.arg(0).unwrap_or_default(),
                    reference: p
                        .find("reference")
                        .and_then(|r| r.arg(0))
                        .unwrap_or_default(),
                    unit: p
                        .find("unit")
                        .and_then(|u| u.arg(0))
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(1),
                });
            }
        }
    }
    out
}

fn parse_symbol_inst(s: &List, node_index: usize) -> Option<SymbolInst> {
    let lib_id = s.find("lib_id").and_then(|l| l.arg(0))?;
    let lib_name = s.find("lib_name").and_then(|l| l.arg(0));
    let (at, rot) = at_of(s)?;
    let rot = Rot::from_deg(rot as f64).unwrap_or(Rot::R0);
    let mirror = match s.find("mirror").and_then(|m| m.arg(0)).as_deref() {
        Some("x") => Mirror::X,
        Some("y") => Mirror::Y,
        _ => Mirror::None,
    };
    let unit = s
        .find("unit")
        .and_then(|u| u.arg(0))
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let properties = properties_of(s);
    Some(SymbolInst {
        uuid: uuid_of(s),
        // A locally modified symbol references its lib_symbols entry by lib_name.
        lib_id: lib_name.unwrap_or(lib_id),
        placement: Placement { at, rot, mirror },
        unit,
        reference: prop(&properties, "Reference").unwrap_or("").to_string(),
        value: prop(&properties, "Value").unwrap_or("").to_string(),
        footprint: prop(&properties, "Footprint").unwrap_or("").to_string(),
        dnp: yes_no(s, "dnp", false),
        in_bom: yes_no(s, "in_bom", true),
        on_board: yes_no(s, "on_board", true),
        exclude_from_sim: yes_no(s, "exclude_from_sim", false),
        properties,
        instances: parse_instances(s),
        node_index,
    })
}

fn parse_pts(l: &List) -> Vec<Pt> {
    l.find("pts")
        .map(|pts| {
            pts.find_all("xy")
                .filter_map(|xy| {
                    Some(Pt::new(
                        mm_str_to_nm(&xy.arg(0)?)?,
                        mm_str_to_nm(&xy.arg(1)?)?,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_label(l: &List, kind: LabelKind, node_index: usize) -> Option<Label> {
    let text = l.arg(0)?;
    let (at, rot) = at_of(l)?;
    let shape = l.find("shape").and_then(|s| s.arg(0));
    Some(Label {
        uuid: uuid_of(l),
        kind,
        text,
        at,
        rot,
        shape,
        node_index,
    })
}

fn parse_sheet_inst(l: &List, node_index: usize) -> Option<SheetInst> {
    let (at, _) = at_of(l)?;
    let size = l.find("size").and_then(|s| {
        Some(Pt::new(
            mm_str_to_nm(&s.arg(0)?)?,
            mm_str_to_nm(&s.arg(1)?)?,
        ))
    })?;
    let props = properties_of(l);
    let name = prop(&props, "Sheetname")
        .or(prop(&props, "Sheet name"))
        .unwrap_or("")
        .to_string();
    let file = prop(&props, "Sheetfile")
        .or(prop(&props, "Sheet file"))
        .unwrap_or("")
        .to_string();
    let mut pins = Vec::new();
    for p in l.find_all("pin") {
        let Some((pat, prot)) = at_of(p) else {
            continue;
        };
        pins.push(SheetPin {
            name: p.arg(0).unwrap_or_default(),
            shape: p.arg(1).unwrap_or_default(),
            at: pat,
            rot: prot,
            uuid: uuid_of(p),
        });
    }
    let mut instances = Vec::new();
    if let Some(inst) = l.find("instances") {
        for proj in inst.find_all("project") {
            let project = proj.arg(0).unwrap_or_default();
            for p in proj.find_all("path") {
                instances.push(SheetInstanceRef {
                    project: project.clone(),
                    path: p.arg(0).unwrap_or_default(),
                    page: p.find("page").and_then(|g| g.arg(0)).unwrap_or_default(),
                });
            }
        }
    }
    Some(SheetInst {
        uuid: uuid_of(l),
        at,
        size,
        name,
        file,
        pins,
        instances,
        node_index,
    })
}

/// Parse a schematic document into the model.
pub fn sheet_from_document(doc: &Document, path: &Path) -> Result<Sheet> {
    let root = &doc.root;
    if !root.is_named("kicad_sch") {
        return Err(ReadError::NotSchematic {
            path: path.to_path_buf(),
        });
    }
    let version = root.find("version").and_then(|v| v.arg_i64(0)).unwrap_or(0);
    if !(KNOWN_VERSIONS_MIN..=KNOWN_VERSIONS_MAX).contains(&version) {
        return Err(ReadError::UnsupportedVersion {
            path: path.to_path_buf(),
            version,
        });
    }
    let mut sheet = Sheet {
        version,
        generator: root
            .find("generator")
            .and_then(|g| g.arg(0))
            .unwrap_or_default(),
        generator_version: root
            .find("generator_version")
            .and_then(|g| g.arg(0))
            .unwrap_or_default(),
        uuid: uuid_of(root),
        paper: root
            .find("paper")
            .and_then(|p| p.arg(0))
            .unwrap_or_else(|| "A4".to_string()),
        lib_symbols: Vec::new(),
        symbols: Vec::new(),
        wires: Vec::new(),
        labels: Vec::new(),
        junctions: Vec::new(),
        no_connects: Vec::new(),
        bus_entries: Vec::new(),
        sheets: Vec::new(),
        sheet_instances: Vec::new(),
    };
    for (i, child) in root.children.iter().enumerate() {
        let Node::List(l) = child else { continue };
        let Some(name) = l.name() else { continue };
        match name.as_str() {
            "lib_symbols" => {
                for s in l.find_all("symbol") {
                    if let Some(sym) = parse_lib_symbol(s, None) {
                        sheet.lib_symbols.push(sym);
                    }
                }
                flatten_extends(&mut sheet.lib_symbols);
            }
            "symbol" => {
                if let Some(s) = parse_symbol_inst(l, i) {
                    sheet.symbols.push(s);
                }
            }
            "wire" | "bus" => {
                let pts = parse_pts(l);
                if pts.len() >= 2 {
                    // KiCad writes exactly two points per wire; be tolerant of
                    // polylines by splitting into segments sharing the uuid.
                    for w in pts.windows(2) {
                        sheet.wires.push(Wire {
                            uuid: uuid_of(l),
                            a: w[0],
                            b: w[1],
                            is_bus: name == "bus",
                            node_index: i,
                        });
                    }
                }
            }
            "label" => {
                if let Some(lb) = parse_label(l, LabelKind::Local, i) {
                    sheet.labels.push(lb);
                }
            }
            "global_label" => {
                if let Some(lb) = parse_label(l, LabelKind::Global, i) {
                    sheet.labels.push(lb);
                }
            }
            "hierarchical_label" => {
                if let Some(lb) = parse_label(l, LabelKind::Hierarchical, i) {
                    sheet.labels.push(lb);
                }
            }
            "junction" => {
                if let Some((at, _)) = at_of(l) {
                    sheet.junctions.push(Junction {
                        uuid: uuid_of(l),
                        at,
                        node_index: i,
                    });
                }
            }
            "no_connect" => {
                if let Some((at, _)) = at_of(l) {
                    sheet.no_connects.push(NoConnect {
                        uuid: uuid_of(l),
                        at,
                        node_index: i,
                    });
                }
            }
            "bus_entry" => {
                if let Some((at, _)) = at_of(l) {
                    let size = l
                        .find("size")
                        .and_then(|s| {
                            Some(Pt::new(
                                mm_str_to_nm(&s.arg(0)?)?,
                                mm_str_to_nm(&s.arg(1)?)?,
                            ))
                        })
                        .unwrap_or(Pt::new(2_540_000, 2_540_000));
                    sheet.bus_entries.push(BusEntry {
                        uuid: uuid_of(l),
                        at,
                        size,
                        node_index: i,
                    });
                }
            }
            "sheet" => {
                if let Some(s) = parse_sheet_inst(l, i) {
                    sheet.sheets.push(s);
                }
            }
            "sheet_instances" => {
                for p in l.find_all("path") {
                    sheet.sheet_instances.push((
                        p.arg(0).unwrap_or_default(),
                        p.find("page").and_then(|g| g.arg(0)).unwrap_or_default(),
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(sheet)
}

/// Read and parse one schematic file. Returns the model and the lossless
/// document (the writer needs both).
pub fn read_sheet(path: &Path) -> Result<(Sheet, Document)> {
    let src = std::fs::read_to_string(path).map_err(|e| ReadError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let doc = kicad_sexpr::parse(&src).map_err(|e| ReadError::Parse {
        path: path.to_path_buf(),
        source: e,
    })?;
    let sheet = sheet_from_document(&doc, path)?;
    Ok((sheet, doc))
}

// ---------------------------------------------------------------------------
// Sheet tree (hierarchy with instance paths)
// ---------------------------------------------------------------------------

/// One instantiation of a sheet file in the hierarchy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SheetInstancePath {
    /// `/root-uuid/sheet-symbol-uuid/...` (KiCad instance path; root is `/<root uuid>`).
    pub path: String,
    /// `/` for root, `/Name/Sub/` style human path (sheet names).
    pub names: String,
    /// File this instance is backed by (canonical path).
    pub file: PathBuf,
    /// Parent instance path and the sheet symbol uuid that created this instance.
    pub parent: Option<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct SheetTree {
    pub root_file: PathBuf,
    pub root_uuid: String,
    /// All distinct files, parsed once.
    pub files: BTreeMap<PathBuf, Sheet>,
    /// Lossless documents for each file.
    pub docs: BTreeMap<PathBuf, Document>,
    /// Instances in depth-first order; the first is the root.
    pub instances: Vec<SheetInstancePath>,
}

impl SheetTree {
    pub fn sheet(&self, file: &Path) -> Option<&Sheet> {
        self.files.get(file)
    }
    pub fn root(&self) -> &Sheet {
        &self.files[&self.root_file]
    }
    pub fn instances_of<'a>(
        &'a self,
        file: &'a Path,
    ) -> impl Iterator<Item = &'a SheetInstancePath> + 'a {
        self.instances.iter().filter(move |i| i.file == file)
    }
    /// A sheet file the way the project names it: relative to the project root (the directory the
    /// root sheet lives in), with forward slashes. A file outside that directory keeps its own
    /// name, so the result is never an absolute path that could leak the user's home directory.
    pub fn rel_file(&self, file: &Path) -> String {
        match self
            .root_file
            .parent()
            .and_then(|b| file.strip_prefix(b).ok())
        {
            Some(r) => r.to_string_lossy().replace('\\', "/"),
            None => file
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default(),
        }
    }
    /// Sheet file per instance names path (`/`, `/Power/`), for decorating findings that only
    /// carry the names path with the file they belong to.
    pub fn files_by_names(&self) -> BTreeMap<&str, String> {
        self.instances
            .iter()
            .map(|i| (i.names.as_str(), self.rel_file(&i.file)))
            .collect()
    }
}

/// Load a whole hierarchy starting at the root sheet. Child files are resolved
/// relative to the directory of the referencing file. The same file may be
/// instantiated more than once (each gets its own instance path).
pub fn read_project(root: &Path) -> Result<SheetTree> {
    let root = root.canonicalize().map_err(|e| ReadError::Io {
        path: root.to_path_buf(),
        source: e,
    })?;
    let mut files = BTreeMap::new();
    let mut docs = BTreeMap::new();
    let (root_sheet, root_doc) = read_sheet(&root)?;
    let root_uuid = root_sheet.uuid.clone();
    files.insert(root.clone(), root_sheet);
    docs.insert(root.clone(), root_doc);
    let mut instances = vec![SheetInstancePath {
        path: format!("/{root_uuid}"),
        names: "/".to_string(),
        file: root.clone(),
        parent: None,
    }];
    // explicit stack: (instance index, ancestors files)
    let mut stack: Vec<(usize, Vec<PathBuf>)> = vec![(0, vec![root.clone()])];
    while let Some((idx, ancestors)) = stack.pop() {
        let inst = instances[idx].clone();
        let children: Vec<SheetInst> = files[&inst.file].sheets.clone();
        for sh in children {
            let dir = inst.file.parent().unwrap_or(Path::new("."));
            let child_path = dir.join(&sh.file);
            let child_path =
                child_path
                    .canonicalize()
                    .map_err(|_| ReadError::SheetFileMissing {
                        file: sh.file.clone(),
                        from: inst.file.clone(),
                    })?;
            if ancestors.contains(&child_path) {
                return Err(ReadError::SheetRecursion {
                    file: sh.file.clone(),
                });
            }
            if !files.contains_key(&child_path) {
                let (s, d) = read_sheet(&child_path)?;
                files.insert(child_path.clone(), s);
                docs.insert(child_path.clone(), d);
            }
            let path = format!("{}/{}", inst.path, sh.uuid);
            let names = if inst.names == "/" {
                format!("/{}/", sh.name)
            } else {
                format!("{}{}/", inst.names, sh.name)
            };
            instances.push(SheetInstancePath {
                path,
                names,
                file: child_path.clone(),
                parent: Some((inst.path.clone(), sh.uuid.clone())),
            });
            let mut anc = ancestors.clone();
            anc.push(child_path);
            stack.push((instances.len() - 1, anc));
        }
    }
    Ok(SheetTree {
        root_file: root,
        root_uuid,
        files,
        docs,
        instances,
    })
}

// ---------------------------------------------------------------------------
// Symbol library tables
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibTableRow {
    pub nickname: String,
    pub kind: String,
    pub uri: String,
    pub descr: String,
}

/// Parse a `sym-lib-table` / `fp-lib-table` file. Nested `(type "Table")`
/// rows (KiCad 9+) are expanded by reading the referenced table.
pub fn parse_lib_table(
    path: &Path,
    env: &HashMap<String, String>,
    depth: usize,
) -> Result<Vec<LibTableRow>> {
    if depth > 4 {
        return Ok(Vec::new());
    }
    let src = std::fs::read_to_string(path).map_err(|e| ReadError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;
    let doc = kicad_sexpr::parse(&src).map_err(|e| ReadError::Parse {
        path: path.to_path_buf(),
        source: e,
    })?;
    let mut rows = Vec::new();
    for lib in doc.root.find_all("lib") {
        let get = |k: &str| lib.find(k).and_then(|n| n.arg(0)).unwrap_or_default();
        let row = LibTableRow {
            nickname: get("name"),
            kind: get("type"),
            uri: expand_env(&get("uri"), env),
            descr: get("descr"),
        };
        if row.kind == "Table" {
            let nested = Path::new(&row.uri);
            let nested = if nested.is_absolute() {
                nested.to_path_buf()
            } else {
                path.parent().unwrap_or(Path::new(".")).join(nested)
            };
            if nested.exists() {
                rows.extend(parse_lib_table(&nested, env, depth + 1)?);
            }
        } else {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Expand `${VAR}` references using `env`, leaving unknown variables intact.
pub fn expand_env(s: &str, env: &HashMap<String, String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let var = &after[..end];
            match env.get(var) {
                Some(v) => out.push_str(v),
                None => {
                    out.push_str("${");
                    out.push_str(var);
                    out.push('}');
                }
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// Parse a KiCad version string or version directory name (`10.0`, `9.0.1`,
/// `10.99.0-rc1`) into `(major, minor)`. `None` when it does not start with a
/// number: callers treat that as "unknown version", never as version 0.
pub fn parse_version(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.trim().split(['.', '-', '_', ' ']);
    let major = leading_number(parts.next()?)?;
    let minor = parts.next().and_then(leading_number).unwrap_or(0);
    Some((major, minor))
}

fn leading_number(s: &str) -> Option<u32> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// Sort KiCad version directories newest first. A lexicographic sort puts `9.0`
/// ahead of `10.0`, which is why every candidate list goes through this: the key
/// is the parsed `(major, minor)`. Names that carry no version keep their
/// relative order and sort last.
pub fn sort_version_dirs(dirs: &mut [PathBuf]) {
    dirs.sort_by(|a, b| {
        let key = |p: &PathBuf| {
            p.file_name()
                .and_then(|n| n.to_str())
                .and_then(parse_version)
        };
        match (key(a), key(b)) {
            (Some(x), Some(y)) => y.cmp(&x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
}

/// Version sub-directories of a KiCad install base (`C:\\Program Files\\KiCad`,
/// `%LOCALAPPDATA%\\Programs\\KiCad`), newest first.
pub fn kicad_version_dirs(base: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = match std::fs::read_dir(base) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => return Vec::new(),
    };
    sort_version_dirs(&mut dirs);
    dirs
}

/// Discover KiCad's global symbol library table and data directories on this
/// machine. Returns the environment map (KICAD*_SYMBOL_DIR etc.) and the
/// global table path if found.
pub fn discover_kicad(
    kicad_app_override: Option<&Path>,
) -> (HashMap<String, String>, Option<PathBuf>) {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = kicad_app_override {
        candidates.push(p.to_path_buf());
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/Applications/KiCad/KiCad.app"));
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(PathBuf::from(home).join("Applications/KiCad/KiCad.app"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for base in ["C:\\Program Files\\KiCad", "C:\\Program Files (x86)\\KiCad"] {
            candidates.extend(kicad_version_dirs(Path::new(base)));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let base = PathBuf::from(local).join("Programs").join("KiCad");
            candidates.extend(kicad_version_dirs(&base));
        }
    }
    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr"));
        candidates.push(PathBuf::from("/usr/local"));
    }
    for c in &candidates {
        let share = if c.extension().map(|e| e == "app").unwrap_or(false) {
            c.join("Contents/SharedSupport")
        } else {
            c.join("share").join("kicad")
        };
        let symbols = share.join("symbols");
        if symbols.is_dir() {
            for major in ["10", "9", "8"] {
                env.entry(format!("KICAD{major}_SYMBOL_DIR"))
                    .or_insert_with(|| symbols.to_string_lossy().into_owned());
                env.entry(format!("KICAD{major}_FOOTPRINT_DIR"))
                    .or_insert_with(|| share.join("footprints").to_string_lossy().into_owned());
                env.entry(format!("KICAD{major}_3DMODEL_DIR"))
                    .or_insert_with(|| share.join("3dmodels").to_string_lossy().into_owned());
                env.entry(format!("KICAD{major}_TEMPLATE_DIR"))
                    .or_insert_with(|| share.join("template").to_string_lossy().into_owned());
            }
            break;
        }
    }
    // Global table lives in the per-user config directory.
    let mut table = None;
    let config_dirs: Vec<PathBuf> = {
        let mut v = Vec::new();
        #[cfg(target_os = "macos")]
        if let Ok(home) = std::env::var("HOME") {
            v.push(PathBuf::from(home).join("Library/Preferences/kicad"));
        }
        #[cfg(target_os = "windows")]
        if let Ok(appdata) = std::env::var("APPDATA") {
            v.push(PathBuf::from(appdata).join("kicad"));
        }
        #[cfg(target_os = "linux")]
        if let Ok(home) = std::env::var("HOME") {
            v.push(PathBuf::from(home).join(".config/kicad"));
        }
        v
    };
    'outer: for dir in config_dirs {
        for major in ["10.0", "9.0", "8.0"] {
            let p = dir.join(major).join("sym-lib-table");
            if p.exists() {
                table = Some(p);
                break 'outer;
            }
        }
    }
    (env, table)
}

/// A resolved library: nickname -> parsed symbols, loaded lazily on demand.
#[derive(Debug, Default)]
pub struct SymbolLibrary {
    pub rows: Vec<LibTableRow>,
    loaded: HashMap<String, Vec<LibSymbol>>,
    /// nickname -> (short symbol name -> raw `(symbol ...)` node from the library file)
    raw: HashMap<String, HashMap<String, List>>,
    missing: HashSet<String>,
}

/// Produce the `lib_symbols` cache entry for `lib_id` from a library file's raw
/// symbol nodes: derived (`extends`) symbols are flattened into a full copy of
/// the parent with the derived name and properties, as KiCad does when saving.
pub fn flattened_cache_node(
    raw: &HashMap<String, List>,
    nickname: &str,
    name: &str,
) -> Option<List> {
    let node = raw.get(name)?;
    let mut chain = vec![node.clone()];
    let mut cur = node.find("extends").and_then(|e| e.arg(0));
    while let Some(parent_name) = cur {
        if chain.len() > 16 {
            break;
        }
        let Some(parent) = raw.get(&parent_name) else {
            break;
        };
        chain.push(parent.clone());
        cur = parent.find("extends").and_then(|e| e.arg(0));
    }
    // Start from the root ancestor and layer properties from each derived level.
    let mut base = chain.last().unwrap().clone();
    let base_name = base.arg(0).unwrap_or_default();
    for derived in chain.iter().rev().skip(1) {
        for p in derived.find_all("property") {
            let pname = p.arg(0).unwrap_or_default();
            if let Some(idx) = base.children.iter().position(|c| matches!(c, Node::List(l) if l.is_named("property") && l.arg(0).as_deref() == Some(pname.as_str()))) {
                base.children[idx] = Node::List(p.clone());
            } else {
                // insert after the last property
                let pos = base.children.iter().rposition(|c| matches!(c, Node::List(l) if l.is_named("property"))).map(|i| i + 1).unwrap_or(1);
                base.insert(pos, Node::List(p.clone()));
            }
        }
        for key in [
            "power",
            "pin_numbers",
            "pin_names",
            "exclude_from_sim",
            "in_bom",
            "on_board",
        ] {
            if let Some(n) = derived.find(key) {
                if let Some(idx) = base.position(key) {
                    base.children[idx] = Node::List(n.clone());
                }
            }
        }
    }
    base.remove_all("extends");
    // rename: symbol id and unit sub-symbols "<base>_<u>_<c>" -> "<name>_<u>_<c>"
    let full = format!("{nickname}:{name}");
    if let Some(Node::Atom(a)) = base.children.get_mut(1) {
        *a = kicad_sexpr::Atom::quoted(&full);
    }
    for c in base.children.iter_mut() {
        if let Node::List(l) = c {
            if l.is_named("symbol") {
                if let Some(sub) = l.arg(0) {
                    if let Some(rest) = sub.strip_prefix(&base_name) {
                        let renamed = format!("{name}{rest}");
                        if let Some(Node::Atom(a)) = l.children.get_mut(1) {
                            *a = kicad_sexpr::Atom::quoted(&renamed);
                        }
                    }
                }
            }
        }
    }
    Some(base)
}

impl SymbolLibrary {
    pub fn new(rows: Vec<LibTableRow>) -> SymbolLibrary {
        SymbolLibrary {
            rows,
            loaded: HashMap::new(),
            raw: HashMap::new(),
            missing: HashSet::new(),
        }
    }

    /// The flattened `lib_symbols` cache node for `lib_id` (loads the library if needed).
    pub fn cache_node(&mut self, lib_id: &str) -> Option<List> {
        self.resolve(lib_id)?;
        let (nick, name) = lib_id.split_once(':')?;
        flattened_cache_node(self.raw.get(nick)?, nick, name)
    }

    /// Resolve `Nick:Name`, loading the `.kicad_sym` file on first use.
    pub fn resolve(&mut self, lib_id: &str) -> Option<LibSymbol> {
        let (nick, name) = lib_id.split_once(':')?;
        if self.missing.contains(nick) {
            return None;
        }
        if !self.loaded.contains_key(nick) {
            let Some(row) = self.rows.iter().find(|r| r.nickname == nick) else {
                self.missing.insert(nick.to_string());
                return None;
            };
            let path = PathBuf::from(&row.uri);
            let mut sources: Vec<(PathBuf, String)> = Vec::new();
            if path.is_dir() {
                // KiCad 10 `.kicad_symdir`: one file per symbol.
                if let Ok(rd) = std::fs::read_dir(&path) {
                    for e in rd.flatten() {
                        let p = e.path();
                        if p.extension().map(|x| x == "kicad_sym").unwrap_or(false) {
                            if let Ok(src) = std::fs::read_to_string(&p) {
                                sources.push((p, src));
                            }
                        }
                    }
                }
            } else {
                match std::fs::read_to_string(&path) {
                    Ok(src) => sources.push((path.clone(), src)),
                    Err(_) => {
                        self.missing.insert(nick.to_string());
                        return None;
                    }
                }
            }
            let mut symbols = Vec::new();
            let mut raw = HashMap::new();
            for (p, src) in sources {
                if let Ok(mut syms) = parse_symbol_lib(&src, nick, &p) {
                    symbols.append(&mut syms);
                }
                if let Ok(doc) = kicad_sexpr::parse(&src) {
                    for sym in doc.root.find_all("symbol") {
                        if let Some(n) = sym.arg(0) {
                            raw.insert(n, sym.clone());
                        }
                    }
                }
            }
            self.loaded.insert(nick.to_string(), symbols);
            self.raw.insert(nick.to_string(), raw);
        }
        self.loaded
            .get(nick)?
            .iter()
            .find(|s| short_name(&s.id) == name)
            .cloned()
    }

    pub fn nicknames(&self) -> impl Iterator<Item = &str> {
        self.rows.iter().map(|r| r.nickname.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_expansion() {
        let mut env = HashMap::new();
        env.insert("KICAD10_SYMBOL_DIR".to_string(), "/x".to_string());
        assert_eq!(
            expand_env("${KICAD10_SYMBOL_DIR}/Device.kicad_sym", &env),
            "/x/Device.kicad_sym"
        );
        assert_eq!(expand_env("${NOPE}/a", &env), "${NOPE}/a");
    }

    #[test]
    fn version_parsing_is_numeric_not_lexicographic() {
        assert_eq!(parse_version("10.0"), Some((10, 0)));
        assert_eq!(parse_version("9.0.1"), Some((9, 0)));
        assert_eq!(parse_version("10.99.0-rc1"), Some((10, 99)));
        assert_eq!(parse_version("10"), Some((10, 0)));
        // Unparseable output is unknown, never version 0.
        assert_eq!(parse_version("nightly"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn version_dirs_sort_newest_first() {
        let mut dirs: Vec<PathBuf> = ["9.0", "10.0", "8.0", "extras", "10.99"]
            .iter()
            .map(|n| PathBuf::from("C:\\Program Files\\KiCad").join(n))
            .collect();
        sort_version_dirs(&mut dirs);
        let names: Vec<String> = dirs
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["10.99", "10.0", "9.0", "8.0", "extras"]);
    }
}
