// SPDX-License-Identifier: Apache-2.0
//! Attachment intake and reads (docs/chat-references-and-attachments.md).
//! Files are sniffed, size-gated, stored content-addressed in app data and
//! read back through structured, capped views.

use crate::error::err;
use crate::ipc::*;
use crate::paths::{ensure_dir, sha256_hex, write_atomic};
use crate::state::AppState;
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::Read;
use std::path::Path;

pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
pub const TEXT_CAP: usize = 32 * 1024;

pub fn sniff(bytes: &[u8], filename: Option<&str>) -> (AttachKindS, &'static str) {
    let ext = filename
        .and_then(|f| Path::new(f).extension().and_then(|e| e.to_str()))
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let head = &bytes[..bytes.len().min(512)];
    let text = std::str::from_utf8(head).unwrap_or("").trim_start();
    if bytes.starts_with(b"%PDF") {
        return (AttachKindS::Pdf, "application/pdf");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return (AttachKindS::Image, "image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return (AttachKindS::Image, "image/jpeg");
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return (AttachKindS::Image, "image/webp");
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return (
            if ext == "xlsx" {
                AttachKindS::Bom
            } else {
                AttachKindS::ProjectZip
            },
            if ext == "xlsx" {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            } else {
                "application/zip"
            },
        );
    }
    if text.starts_with("(kicad_symbol_lib") {
        return (AttachKindS::Lib, "application/x-kicad-symbol-lib");
    }
    if text.starts_with("(kicad_sch") {
        // A schematic fragment (clipboard) has no version/uuid at root level in KiCad copies.
        return (AttachKindS::Sch, "application/x-kicad-schematic");
    }
    if text.starts_with("(export") && text.contains("(version") {
        return (AttachKindS::Netlist, "application/x-kicad-netlist");
    }
    if text.starts_with("(symbol") || text.starts_with("(wire") || text.starts_with("(lib_symbols")
    {
        return (AttachKindS::Fragment, "application/x-kicad-fragment");
    }
    match ext.as_str() {
        "csv" | "tsv" => (AttachKindS::Bom, "text/csv"),
        "md" | "txt" => (AttachKindS::Doc, "text/plain"),
        "json" => (AttachKindS::Doc, "application/json"),
        "net" => (AttachKindS::Netlist, "application/x-kicad-netlist"),
        _ if std::str::from_utf8(bytes).is_ok() => (AttachKindS::Doc, "text/plain"),
        _ => (AttachKindS::Unknown, "application/octet-stream"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachKindS {
    Lib,
    Pdf,
    Doc,
    Sch,
    Image,
    Netlist,
    Bom,
    Fragment,
    ProjectZip,
    Unknown,
}

impl AttachKindS {
    pub fn as_str(self) -> &'static str {
        match self {
            AttachKindS::Lib => "lib",
            AttachKindS::Pdf => "pdf",
            AttachKindS::Doc => "doc",
            AttachKindS::Sch => "sch",
            AttachKindS::Image => "image",
            AttachKindS::Netlist => "netlist",
            AttachKindS::Bom => "bom",
            AttachKindS::Fragment => "fragment",
            AttachKindS::ProjectZip => "project_zip",
            AttachKindS::Unknown => "unknown",
        }
    }
}

pub fn cached_path(sha: &str) -> std::path::PathBuf {
    crate::net::external_dir().join(sha)
}

pub fn cached_bytes(state: &AppState, sha: &str) -> Result<Vec<u8>, IpcError> {
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(err("BAD_CONFIG", "sha256 expected"));
    }
    let p = cached_path(sha);
    let bytes = std::fs::read(&p).map_err(|_| {
        err(
            "EXTERNAL_FILE_MISSING",
            "the attachment is no longer in the local cache",
        )
        .with_remediation("attach the file again")
    })?;
    if sha256_hex(&bytes) != sha {
        return Err(err(
            "REVISION_CHANGED",
            "cached bytes do not match their sha",
        ));
    }
    let _ = state;
    Ok(bytes)
}

/// Downscale + strip metadata for images; returns (png bytes, w, h).
fn process_image(bytes: &[u8], max_px: u32) -> Result<(Vec<u8>, u32, u32), IpcError> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| err("ATTACH_TYPE_REJECTED", format!("image unreadable: {e}")))?;
    let (w, h) = (img.width(), img.height());
    let img = if w.max(h) > max_px {
        img.resize(max_px, max_px, image::imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
    Ok((out.into_inner(), img.width(), img.height()))
}

fn est_tokens(w: u32, h: u32) -> u32 {
    ((w as f64 * h as f64) / 750.0).ceil() as u32
}

fn zip_check(bytes: &[u8]) -> Result<Vec<String>, IpcError> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
    if z.len() > 500 {
        return Err(err("ATTACH_TOO_LARGE", "zip has more than 500 entries"));
    }
    let mut names = Vec::new();
    let mut total = 0u64;
    for i in 0..z.len() {
        let f = z
            .by_index(i)
            .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
        let name = f.name().to_string();
        if name.contains("..") || name.starts_with('/') || name.contains(":\\") {
            return Err(err(
                "PATH_OUT_OF_SCOPE",
                format!("zip entry {name} escapes"),
            ));
        }
        total += f.size();
        if total > MAX_BYTES * 4 {
            return Err(err("ATTACH_TOO_LARGE", "zip expands beyond 200 MB"));
        }
        names.push(name);
    }
    Ok(names)
}

pub fn intake(state: &AppState, req: &IntakeRequest) -> Result<AttachInfo, IpcError> {
    let (bytes, filename) = match (&req.path, &req.bytes_base64) {
        (Some(p), _) => {
            let path = Path::new(p);
            let meta = std::fs::metadata(path).map_err(|e| crate::error::io_err(path, e))?;
            if meta.len() > MAX_BYTES {
                return Err(err("ATTACH_TOO_LARGE", "files over 50 MB are not accepted"));
            }
            (
                std::fs::read(path).map_err(|e| crate::error::io_err(path, e))?,
                req.filename
                    .clone()
                    .or_else(|| path.file_name().map(|s| s.to_string_lossy().to_string())),
            )
        }
        (None, Some(b)) => (
            base64::engine::general_purpose::STANDARD
                .decode(b)
                .map_err(|_| err("ATTACH_TYPE_REJECTED", "bad base64"))?,
            req.filename.clone(),
        ),
        _ => return Err(err("BAD_CONFIG", "path or bytes required")),
    };
    if bytes.len() as u64 > MAX_BYTES {
        return Err(err("ATTACH_TOO_LARGE", "files over 50 MB are not accepted"));
    }
    let (kind, ct) = sniff(&bytes, filename.as_deref());
    let mut warnings = Vec::new();
    let mut image = None;
    let mut pages = None;
    let stored: Vec<u8> = match kind {
        AttachKindS::Unknown => return Err(err("ATTACH_TYPE_REJECTED", "unsupported file type").with_remediation("supported: .kicad_sym, .kicad_sch, PDF, PNG/JPEG/WebP, CSV/XLSX BOM, KiCad netlist, zip")),
        AttachKindS::Image => {
            let max = if state.settings.read().advanced.images_size == "large" { 2048 } else { 1568 };
            let (png, w, h) = process_image(&bytes, max)?;
            image = Some(ImageInfo { width: w, height: h, est_tokens: est_tokens(w, h) });
            png
        }
        AttachKindS::ProjectZip => {
            let names = zip_check(&bytes)?;
            if !names.iter().any(|n| n.ends_with(".kicad_pro") || n.ends_with(".kicad_sch")) {
                warnings.push("zip contains no KiCad project".into());
            }
            bytes
        }
        AttachKindS::Pdf => {
            pages = pdf_page_count(&bytes);
            if crate::pdftext::extract_pages(&bytes).map(|p| p.iter().all(|t| t.trim().is_empty())).unwrap_or(true) {
                warnings.push("NO_TEXT_LAYER".into());
            }
            bytes
        }
        AttachKindS::Lib => {
            let text = String::from_utf8_lossy(&bytes);
            if let Err(e) = sch_read::parse_symbol_lib(&text, "attached", Path::new("attached.kicad_sym")) {
                return Err(err("LIB_PARSE_ERROR", e.to_string()));
            }
            bytes
        }
        _ => bytes,
    };
    let ext = filename
        .as_deref()
        .and_then(|f| Path::new(f).extension().and_then(|e| e.to_str()))
        .unwrap_or(match kind {
            AttachKindS::Image => "png",
            AttachKindS::Pdf => "pdf",
            _ => "bin",
        });
    let ct = if kind == AttachKindS::Image {
        "image/png"
    } else {
        ct
    };
    let sha = crate::net::land_bytes(state, &stored, ext, ct, Some("local"), None)?;
    let label = filename
        .clone()
        .unwrap_or_else(|| format!("{}-{}", kind.as_str(), &sha[..8]));
    state.db.lock().query(
        DbQuery::AttachmentUpsert {
            project_key: req.project_key.clone(),
            sha256: sha.clone(),
            kind_: kind.as_str().into(),
            label: label.clone(),
            bound_to: None,
        },
        &state.app_version,
    )?;
    Ok(AttachInfo {
        sha256: sha,
        kind: kind.as_str().into(),
        label,
        size: stored.len() as u64,
        content_type: ct.into(),
        pages,
        image,
        bound_to: None,
        warnings,
    })
}

fn pdf_page_count(bytes: &[u8]) -> Option<u32> {
    let s = String::from_utf8_lossy(bytes);
    let re = regex::Regex::new(r"/Type\s*/Page[^s]").ok()?;
    let n = re.find_iter(&s).count() as u32;
    if n == 0 {
        None
    } else {
        Some(n)
    }
}

fn cut(s: &str, offset: usize, limit: usize) -> (String, bool) {
    let start = offset.min(s.len());
    let mut end = (start + limit).min(s.len());
    while end > start && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut st = start;
    while st < end && !s.is_char_boundary(st) {
        st += 1;
    }
    (s[st..end].to_string(), end < s.len())
}

pub fn read(state: &AppState, project_key: &str, r: &AttachRead) -> Result<Value, IpcError> {
    let _ = project_key;
    match r {
        AttachRead::Text {
            sha256,
            offset,
            limit,
        } => {
            let b = cached_bytes(state, sha256)?;
            let s = String::from_utf8_lossy(&b);
            let (text, truncated) = cut(
                &s,
                offset.unwrap_or(0) as usize,
                (limit.unwrap_or(TEXT_CAP as u64) as usize).min(TEXT_CAP),
            );
            Ok(
                json!({"text": text, "truncated": truncated, "hint": if truncated { Some("use offset/limit to page") } else { None }, "trust": "untrusted"}),
            )
        }
        AttachRead::PdfText { sha256, pages } => {
            // Same cached per-page text as `docs.pdf_text` (panic-safe, `external/<sha>.txt`).
            let texts = crate::pdftext::pages_cached(sha256, || cached_bytes(state, sha256))?;
            Ok(crate::pdftext::page_result(
                sha256,
                &texts,
                pages.as_deref(),
            ))
        }
        AttachRead::PdfPageImage { .. } => Err(err(
            "NOT_SUPPORTED",
            "PDF rasterising is not available in this build",
        )
        .with_remediation("attach a screenshot of the page instead")),
        AttachRead::Image { sha256, size } => {
            let b = cached_bytes(state, sha256)?;
            let max = if size.as_deref() == Some("large") {
                2048
            } else {
                1568
            };
            let (png, w, h) = process_image(&b, max)?;
            Ok(
                json!({"media_type": "image/png", "mime": "image/png", "data_base64": base64::engine::general_purpose::STANDARD.encode(&png), "width": w, "height": h, "est_tokens": est_tokens(w, h), "trust": "untrusted"}),
            )
        }
        AttachRead::Sch {
            sha256,
            r#match,
            limit,
        } => {
            let b = cached_bytes(state, sha256)?;
            let tmp = tempfile::tempdir().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            let p = tmp.path().join("attached.kicad_sch");
            std::fs::write(&p, &b).map_err(|e| crate::error::io_err(&p, e))?;
            let (sheet, _) = sch_read::read_sheet(&p)?;
            let m = r#match.as_deref().map(|s| s.to_lowercase());
            let lim = limit.unwrap_or(200) as usize;
            let symbols: Vec<Value> = sheet.symbols.iter().filter(|s| m.as_ref().map(|m| s.reference.to_lowercase().contains(m) || s.value.to_lowercase().contains(m) || s.lib_id.to_lowercase().contains(m)).unwrap_or(true)).take(lim).map(|s| json!({"reference": s.reference, "lib_id": s.lib_id, "value": s.value, "footprint": s.footprint, "unit": s.unit, "x_mil": sch_model::nm_to_mil(s.placement.at.x), "y_mil": sch_model::nm_to_mil(s.placement.at.y)})).collect();
            let labels: Vec<Value> = sheet
                .labels
                .iter()
                .filter(|l| {
                    m.as_ref()
                        .map(|m| l.text.to_lowercase().contains(m))
                        .unwrap_or(true)
                })
                .take(lim)
                .map(|l| json!({"text": l.text, "kind": format!("{:?}", l.kind).to_lowercase()}))
                .collect();
            let tree = sch_read::read_project(&p).ok();
            let nets: Vec<Value> = tree.map(|t| sch_net::build_nets(&t).nets.iter().filter(|n| !n.name.starts_with("unconnected-")).take(lim).map(|n| json!({"name": n.name, "members": n.members.iter().map(|mm| format!("{}.{}", mm.reference, mm.pin)).collect::<Vec<_>>()})).collect()).unwrap_or_default();
            Ok(
                json!({"paper": sheet.paper, "version": sheet.version, "symbols": symbols, "labels": labels, "nets": nets, "total": {"symbols": sheet.symbols.len(), "labels": sheet.labels.len(), "wires": sheet.wires.len()}, "trust": "untrusted"}),
            )
        }
        AttachRead::Netlist { sha256 } => {
            let b = cached_bytes(state, sha256)?;
            let s = String::from_utf8_lossy(&b);
            parse_kicad_netlist(&s)
                .ok_or_else(|| err("ATTACH_TYPE_REJECTED", "not a KiCad s-expression netlist"))
        }
        AttachRead::Bom { sha256 } => {
            let b = cached_bytes(state, sha256)?;
            if b.starts_with(b"PK") {
                return xlsx_bom(&b);
            }
            let s = String::from_utf8_lossy(&b);
            Ok(csv_bom(&s))
        }
        AttachRead::Fragment { sha256 } => {
            let b = cached_bytes(state, sha256)?;
            let s = String::from_utf8_lossy(&b);
            let wrapped = if s.trim_start().starts_with("(kicad_sch") {
                s.to_string()
            } else {
                format!("(kicad_sch (version 20260306) (generator \"fluxsmith\") (generator_version \"10.0\") (uuid \"00000000-0000-4000-8000-000000000000\") (paper \"A4\")\n{s}\n)")
            };
            let tmp = tempfile::tempdir().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
            let p = tmp.path().join("fragment.kicad_sch");
            std::fs::write(&p, wrapped.as_bytes()).map_err(|e| crate::error::io_err(&p, e))?;
            let (sheet, _) = sch_read::read_sheet(&p)?;
            Ok(
                json!({"symbols": sheet.symbols.iter().map(|s| json!({"reference": s.reference, "lib_id": s.lib_id, "value": s.value, "x_mil": sch_model::nm_to_mil(s.placement.at.x), "y_mil": sch_model::nm_to_mil(s.placement.at.y), "rotation": s.placement.rot.deg()})).collect::<Vec<_>>(), "wires": sheet.wires.len(), "labels": sheet.labels.iter().map(|l| l.text.clone()).collect::<Vec<_>>(), "lib_symbols": sheet.lib_symbols.iter().map(|l| l.id.clone()).collect::<Vec<_>>(), "trust": "untrusted"}),
            )
        }
    }
}

/// Parse `kicad-cli sch export netlist --format kicadsexpr` output.
pub fn parse_kicad_netlist(text: &str) -> Option<Value> {
    let doc = kicad_sexpr::parse(text).ok()?;
    if doc.root.name().as_deref() != Some("export") {
        return None;
    }
    let mut components = Vec::new();
    if let Some(comps) = doc.root.find("components") {
        for c in comps.find_all("comp") {
            let r = c.find("ref").and_then(|l| l.arg(0)).unwrap_or_default();
            let v = c.find("value").and_then(|l| l.arg(0)).unwrap_or_default();
            let fp = c.find("footprint").and_then(|l| l.arg(0));
            components.push(json!({"ref": r, "value": v, "footprint": fp, "pins": []}));
        }
    }
    let mut nets = Vec::new();
    if let Some(ns) = doc.root.find("nets") {
        for n in ns.find_all("net") {
            let name = n.find("name").and_then(|l| l.arg(0)).unwrap_or_default();
            let members: Vec<String> = n
                .find_all("node")
                .filter_map(|node| {
                    Some(format!(
                        "{}.{}",
                        node.find("ref")?.arg(0)?,
                        node.find("pin")?.arg(0)?
                    ))
                })
                .collect();
            for m in &members {
                if let Some((r, p)) = m.rsplit_once('.') {
                    if let Some(c) = components.iter_mut().find(|c| c["ref"] == r) {
                        c["pins"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"number": p, "net": name}));
                    }
                }
            }
            nets.push(json!({"name": name, "members": members}));
        }
    }
    Some(json!({"components": components, "nets": nets, "trust": "untrusted"}))
}

fn detect_columns(header: &[String]) -> Vec<(usize, &'static str)> {
    let mut out = Vec::new();
    for (i, h) in header.iter().enumerate() {
        let h = h.to_lowercase();
        let key = if h.contains("ref") || h.contains("designator") {
            "ref"
        } else if h.contains("value") || h.contains("comment") {
            "value"
        } else if h.contains("footprint") || h.contains("package") {
            "footprint"
        } else if h.contains("mpn") || h.contains("part number") || h.contains("manufacturer part")
        {
            "mpn"
        } else if h.contains("lcsc") || h.contains("supplier part") {
            "lcsc"
        } else if h.contains("qty") || h.contains("quantity") {
            "qty"
        } else {
            continue;
        };
        out.push((i, key));
    }
    out
}

pub fn csv_bom(s: &str) -> Value {
    let delim = if s
        .lines()
        .next()
        .map(|l| l.matches('\t').count() > l.matches(',').count())
        .unwrap_or(false)
    {
        '\t'
    } else {
        ','
    };
    let mut lines = s.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<String> = lines
        .next()
        .map(|l| split_csv(l, delim))
        .unwrap_or_default();
    let cols = detect_columns(&header);
    let mut rows = Vec::new();
    for l in lines.take(2000) {
        let cells = split_csv(l, delim);
        let mut row = serde_json::Map::new();
        for (i, key) in &cols {
            if let Some(c) = cells.get(*i) {
                if *key == "qty" {
                    row.insert(
                        key.to_string(),
                        c.trim()
                            .parse::<u64>()
                            .map(Value::from)
                            .unwrap_or(Value::Null),
                    );
                } else {
                    row.insert(key.to_string(), Value::String(c.trim().to_string()));
                }
            }
        }
        rows.push(Value::Object(row));
    }
    json!({"columns_detected": cols.iter().map(|(_, k)| *k).collect::<Vec<_>>(), "rows": rows, "trust": "untrusted"})
}

fn split_csv(line: &str, delim: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut inq = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if inq && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => inq = !inq,
            c if c == delim && !inq => {
                out.push(std::mem::take(&mut cur));
            }
            c => cur.push(c),
        }
    }
    out.push(cur);
    out
}

fn xlsx_bom(bytes: &[u8]) -> Result<Value, IpcError> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
    let mut shared = Vec::new();
    if let Ok(mut f) = z.by_name("xl/sharedStrings.xml") {
        let mut s = String::new();
        f.read_to_string(&mut s).ok();
        let re = regex::Regex::new(r"<t[^>]*>([^<]*)</t>").unwrap();
        for c in re.captures_iter(&s) {
            shared.push(c[1].to_string());
        }
    }
    let mut sheet = String::new();
    z.by_name("xl/worksheets/sheet1.xml")
        .map_err(|_| err("ATTACH_TYPE_REJECTED", "xlsx without sheet1"))?
        .read_to_string(&mut sheet)
        .ok();
    let row_re = regex::Regex::new(r"<row[^>]*>(.*?)</row>").unwrap();
    let cell_re = regex::Regex::new(
        r#"<c r="([A-Z]+)\d+"(?:[^>]*t="(\w+)")?[^>]*>(?:<v>([^<]*)</v>|<is><t>([^<]*)</t></is>)?"#,
    )
    .unwrap();
    let mut lines: Vec<String> = Vec::new();
    for r in row_re.captures_iter(&sheet) {
        let mut cells: Vec<(usize, String)> = Vec::new();
        for c in cell_re.captures_iter(&r[1]) {
            let col = c[1]
                .bytes()
                .fold(0usize, |a, b| a * 26 + (b - b'A' + 1) as usize)
                - 1;
            let val = match (c.get(2).map(|m| m.as_str()), c.get(3), c.get(4)) {
                (Some("s"), Some(v), _) => shared
                    .get(v.as_str().parse::<usize>().unwrap_or(usize::MAX))
                    .cloned()
                    .unwrap_or_default(),
                (_, Some(v), _) => v.as_str().to_string(),
                (_, _, Some(t)) => t.as_str().to_string(),
                _ => String::new(),
            };
            cells.push((col, val));
        }
        let width = cells.iter().map(|(c, _)| c + 1).max().unwrap_or(0);
        let mut row = vec![String::new(); width];
        for (c, v) in cells {
            row[c] = v;
        }
        lines.push(
            row.iter()
                .map(|v| format!("\"{}\"", v.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    Ok(csv_bom(&lines.join("\n")))
}

pub fn bind_to_project(
    state: &AppState,
    project_key: &str,
    sha: &str,
    dest: &str,
) -> Result<String, IpcError> {
    let h = state.project(project_key)?;
    let bytes = cached_bytes(state, sha)?;
    let (ext, _ct, _) = state.db.lock().external_get(sha)?.unwrap_or((
        "bin".into(),
        "application/octet-stream".into(),
        0,
    ));
    let label = state
        .db
        .lock()
        .query(
            DbQuery::AttachmentList {
                project_key: project_key.into(),
            },
            &state.app_version,
        )?
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|x| x["sha256"] == sha)
                .and_then(|x| x["label"].as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| format!("{}.{ext}", &sha[..12]));
    let sub = match dest {
        "datasheets" => "datasheets",
        "libs" => "libs",
        _ => return Err(err("BAD_CONFIG", "dest must be datasheets|libs")),
    };
    let dir = h.root.join(sub);
    ensure_dir(&dir)?;
    let safe: String = label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let target = dir.join(&safe);
    if !target.exists() {
        write_atomic(&target, &bytes)?;
    }
    let pointer = dir.join(format!("{safe}.json"));
    write_atomic(&pointer, serde_json::to_string_pretty(&json!({"schema_version": 1, "sha256": sha, "size": bytes.len(), "label": label, "copied": crate::paths::now_iso()}))?.as_bytes())?;
    state
        .db
        .lock()
        .external_ref(sha, project_key, &crate::paths::rel_to(&h.root, &pointer))?;
    Ok(crate::paths::rel_to(&h.root, &target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffing() {
        assert_eq!(sniff(b"%PDF-1.7 ...", None).0, AttachKindS::Pdf);
        assert_eq!(sniff(b"\x89PNG\r\n", None).0, AttachKindS::Image);
        assert_eq!(
            sniff(b"(kicad_symbol_lib (version 1))", Some("x.kicad_sym")).0,
            AttachKindS::Lib
        );
        assert_eq!(
            sniff(b"(kicad_sch (version 20260306))", None).0,
            AttachKindS::Sch
        );
        assert_eq!(
            sniff(b"(export (version \"E\"))", None).0,
            AttachKindS::Netlist
        );
        assert_eq!(
            sniff(b"Ref,Value\nR1,10k", Some("bom.csv")).0,
            AttachKindS::Bom
        );
        assert_eq!(
            sniff(&[0, 1, 2, 255], Some("x.bin")).0,
            AttachKindS::Unknown
        );
    }

    #[test]
    fn csv_bom_detects_columns() {
        let v = csv_bom("Designator,Comment,Footprint,LCSC Part #\nR1,\"10k, 1%\",0603,C25804\n");
        assert_eq!(v["rows"][0]["ref"], "R1");
        assert_eq!(v["rows"][0]["value"], "10k, 1%");
        assert_eq!(v["rows"][0]["lcsc"], "C25804");
    }

    #[test]
    fn netlist_parse() {
        let v = parse_kicad_netlist(r#"(export (version "E") (components (comp (ref "R1") (value "10k"))) (nets (net (code "1") (name "VCC") (node (ref "R1") (pin "1")))))"#).unwrap();
        assert_eq!(v["nets"][0]["members"][0], "R1.1");
        assert_eq!(v["components"][0]["pins"][0]["net"], "VCC");
    }
}
