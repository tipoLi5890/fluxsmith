// SPDX-License-Identifier: Apache-2.0
//! `docs.pdf_text`: per-page text of a cached PDF (addressed by sha256).
//! Extraction uses `pdf-extract` inside `catch_unwind` on a blocking thread
//! (malformed PDFs can panic the parser) and is cached once as
//! `external/<sha>.txt` (pages separated by form feeds) so `facts.write` can
//! verify quotes against the very same text.

use crate::error::err;
use crate::ipc::IpcError;
use crate::paths::write_atomic;
use crate::state::AppState;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Bytes of page text handed back per call (before the tool-result cap).
pub const PDF_TEXT_CAP: usize = 32 * 1024;
/// Page separator inside the `.txt` cache.
pub const PAGE_SEP: char = '\u{c}';

pub fn txt_cache_path(sha: &str) -> PathBuf {
    crate::net::external_dir().join(format!("{sha}.txt"))
}

/// Extract page texts; a parser panic becomes `PDF_UNPARSEABLE` instead of
/// taking the process down.
pub fn extract_pages(bytes: &[u8]) -> Result<Vec<String>, IpcError> {
    // `extract_text_from_mem` concatenates pages with no separator; the by-pages API keeps them apart.
    let r = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes));
    match r {
        Ok(Ok(pages)) => Ok(pages),
        Ok(Err(e)) => Err(err("PDF_UNPARSEABLE", e.to_string())),
        Err(_) => Err(
            err("PDF_UNPARSEABLE", "the PDF parser panicked on this file")
                .with_remediation("the file may be malformed; try another copy of the datasheet"),
        ),
    }
}

pub fn split_pages(all: &str) -> Vec<String> {
    let mut pages: Vec<String> = all.split(PAGE_SEP).map(|s| s.to_string()).collect();
    // pdf-extract ends each page with a form feed, leaving one empty tail entry.
    if pages.len() > 1 && pages.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        pages.pop();
    }
    pages
}

/// Page texts for a cached PDF: served from `<sha>.txt` when present, else
/// extracted and cached. `bytes` is only read when the cache is cold.
pub fn pages_cached(
    sha: &str,
    bytes: impl FnOnce() -> Result<Vec<u8>, IpcError>,
) -> Result<Vec<String>, IpcError> {
    let p = txt_cache_path(sha);
    if let Ok(s) = std::fs::read_to_string(&p) {
        return Ok(split_pages(&s));
    }
    let pages = extract_pages(&bytes()?)?;
    let joined = pages.join(&PAGE_SEP.to_string());
    // Best effort: a failed cache write only costs a re-extraction next time.
    let _ = write_atomic(&p, joined.as_bytes());
    Ok(pages)
}

/// Text of one page from the cache (1-based), if the cache holds it.
pub fn page_text_cached(sha: &str, page: u32) -> Option<String> {
    let s = std::fs::read_to_string(txt_cache_path(sha)).ok()?;
    split_pages(&s).get(page.checked_sub(1)? as usize).cloned()
}

fn cut(s: &str, limit: usize) -> (String, bool) {
    let mut end = limit.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), end < s.len())
}

/// Build the tool result: requested pages (default: all) under the byte cap.
pub fn page_result(sha: &str, pages: &[String], want: Option<&[u32]>) -> Value {
    let want: Vec<u32> = match want {
        Some(w) if !w.is_empty() => w.to_vec(),
        _ => (1..=pages.len() as u32).collect(),
    };
    let mut out = Vec::new();
    let mut budget = PDF_TEXT_CAP;
    let mut truncated = false;
    let mut missing = Vec::new();
    for n in want {
        let Some(t) = n.checked_sub(1).and_then(|i| pages.get(i as usize)) else {
            missing.push(n);
            continue;
        };
        if budget == 0 {
            truncated = true;
            break;
        }
        let (t, cutted) = cut(t, budget);
        budget = budget.saturating_sub(t.len());
        out.push(json!({"n": n, "text": t}));
        if cutted {
            truncated = true;
            break;
        }
    }
    json!({
        "sha256": sha,
        "total_pages": pages.len(),
        "pages": out,
        "missing_pages": missing,
        "truncated": truncated,
        "hint": if truncated { Some("ask for fewer pages at a time") } else { None },
        "trust": "untrusted",
    })
}

/// `pdf_text` command body: blocking extraction off the async runtime.
pub async fn pdf_text(
    state: Arc<AppState>,
    sha: String,
    pages: Option<Vec<u32>>,
) -> Result<Value, IpcError> {
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(err("BAD_CONFIG", "sha256 expected"));
    }
    let st = state.clone();
    let sha2 = sha.clone();
    let texts = tauri::async_runtime::spawn_blocking(move || {
        pages_cached(&sha2, || crate::intake::cached_bytes(&st, &sha2))
    })
    .await
    .map_err(|e| err("ENGINE_PANIC", e.to_string()))??;
    Ok(page_result(&sha, &texts, pages.as_deref()))
}

/// A minimal single-font PDF with the given page texts (tests and fixtures).
#[cfg(test)]
pub fn tiny_pdf(pages: &[&str]) -> Vec<u8> {
    let mut objs: Vec<String> = Vec::new();
    // 1 catalog, 2 pages, 3 font, then per page: page obj + content obj.
    let n = pages.len();
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objs.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    objs.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        n
    ));
    objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    for (i, text) in pages.iter().enumerate() {
        let content = format!(
            "BT /F1 12 Tf 72 700 Td ({}) Tj ET",
            text.replace('(', "\\(").replace(')', "\\)")
        );
        objs.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>",
            5 + i * 2
        ));
        objs.push(format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            content.len(),
            content
        ));
    }
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, o) in objs.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, o));
    }
    let xref = out.len();
    out.push_str(&format!(
        "xref\n0 {}\n0000000000 65535 f \n",
        objs.len() + 1
    ));
    for off in offsets {
        out.push_str(&format!("{off:010} 00000 n \n"));
    }
    out.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        objs.len() + 1,
        xref
    ));
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_per_page_text() {
        let pdf = tiny_pdf(&["VDD operating voltage 1.7 to 3.6 V", "Second page here"]);
        let pages = extract_pages(&pdf).unwrap();
        assert_eq!(pages.len(), 2, "{pages:?}");
        assert!(pages[0].contains("1.7 to 3.6 V"));
        assert!(pages[1].contains("Second page"));
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        let r = extract_pages(b"%PDF-1.4 this is not a pdf \x00\x01\x02");
        assert!(r.is_err() || r.unwrap().iter().all(|p| p.trim().is_empty()));
    }

    #[test]
    fn page_result_selects_and_reports_missing() {
        let pages = vec!["a".to_string(), "b".to_string()];
        let v = page_result("s", &pages, Some(&[2, 5]));
        assert_eq!(v["pages"].as_array().unwrap().len(), 1);
        assert_eq!(v["pages"][0]["n"], 2);
        assert_eq!(v["missing_pages"][0], 5);
        assert_eq!(v["total_pages"], 2);
        let all = page_result("s", &pages, None);
        assert_eq!(all["pages"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn split_drops_trailing_empty_page() {
        assert_eq!(split_pages("a\u{c}b\u{c}").len(), 2);
        assert_eq!(split_pages("only").len(), 1);
    }
}
