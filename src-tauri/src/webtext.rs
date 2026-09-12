// SPDX-License-Identifier: Apache-2.0
//! HTML → plain text for `web.fetch` (M3). The conversion runs in Rust so the
//! webview never sees raw HTML; the result is untrusted evidence for the model.

use crate::error::err;
use crate::ipc::IpcError;
use serde_json::{json, Value};

/// Text handed to the model per fetch (bytes, before the tool-result cap).
pub const WEB_TEXT_CAP: usize = 32 * 1024;

/// Convert HTML to readable text: block elements become newlines, scripts,
/// styles and tags are dropped, entities are decoded. Runs of blank lines are
/// collapsed so the cap is spent on content.
pub fn html_to_text(html: &str) -> String {
    let raw = nanohtml2text::html2text(html);
    let mut out = String::with_capacity(raw.len());
    let mut blank = 0;
    for line in raw.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(t);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Cut a string at a char boundary at most `cap` bytes in; returns (text, truncated).
pub fn cap_text(s: &str, cap: usize) -> (String, bool) {
    if s.len() <= cap {
        return (s.to_string(), false);
    }
    let mut end = cap;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (s[..end].to_string(), true)
}

/// Shape the landed fetch (`net::fetch_and_land` result) into the `web.fetch`
/// tool result: HTML is converted, text-like bodies are passed through, PDFs
/// and binaries only return their sha256 handle.
pub fn shape(landed: &Value, body: &[u8]) -> Result<Value, IpcError> {
    let ct = landed
        .get("content_type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| err("BAD_CONFIG", "landed fetch has no content type"))?;
    let (kind, text) = match ct {
        "text/html" => ("html", Some(html_to_text(&String::from_utf8_lossy(body)))),
        "text/plain" | "text/csv" | "application/json" => {
            ("text", Some(String::from_utf8_lossy(body).to_string()))
        }
        "application/pdf" => ("pdf", None),
        _ => ("binary", None),
    };
    let (text, truncated) = match text {
        Some(t) => {
            let (t, tr) = cap_text(&t, WEB_TEXT_CAP);
            (Some(t), tr)
        }
        None => (None, false),
    };
    let note = match kind {
        "pdf" => Some("PDF landed; read it with docs.pdf_text {sha256}"),
        "binary" => Some("binary content landed; only the sha256 handle is available"),
        _ => None,
    };
    Ok(json!({
        "sha256": landed.get("sha256"),
        "url": landed.get("url"),
        "content_type": ct,
        "size": landed.get("size"),
        "kind": kind,
        "text": text,
        "truncated": truncated,
        "note": note,
        "trust": "untrusted",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_tags_scripts_and_collapses_blank_lines() {
        let html = "<html><head><title>T</title><style>p{}</style><script>alert(1)</script></head><body><h1>Hello</h1>\n\n\n<p>World &amp; friends</p><ul><li>a</li><li>b</li></ul></body></html>";
        let t = html_to_text(html);
        assert!(t.contains("Hello"));
        assert!(t.contains("World & friends"));
        assert!(!t.contains("alert"));
        assert!(!t.contains('<'));
        assert!(!t.contains("\n\n\n"));
    }

    #[test]
    fn cap_respects_char_boundaries() {
        let s = "ab\u{4e2d}\u{6587}cd";
        let (t, tr) = cap_text(s, 3);
        assert_eq!(t, "ab");
        assert!(tr);
        let (t, tr) = cap_text(s, 100);
        assert_eq!(t, s);
        assert!(!tr);
    }

    #[test]
    fn shape_by_content_type() {
        let landed =
            json!({"sha256": "s", "url": "https://x", "content_type": "text/html", "size": 3});
        let v = shape(&landed, b"<p>hi</p>").unwrap();
        assert_eq!(v["kind"], "html");
        assert_eq!(v["text"], "hi");
        let landed = json!({"sha256": "s", "url": "https://x", "content_type": "application/pdf", "size": 3});
        let v = shape(&landed, b"%PDF").unwrap();
        assert_eq!(v["kind"], "pdf");
        assert!(v["text"].is_null());
        assert!(v["note"].as_str().unwrap().contains("docs.pdf_text"));
    }
}
