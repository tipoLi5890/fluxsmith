// SPDX-License-Identifier: Apache-2.0
//! `facts.write` static checks (workspace-format.md §8, schema_version 2).
//! A fact is only written when its quote is a verbatim substring of the
//! extracted text of the named page of the named PDF, and every fact of the
//! document points at the same `source.sha256`. The page loader is injected
//! so the rules are testable without an app-data directory.

use crate::error::err;
use crate::ipc::IpcError;
use crate::paths::now_iso;
use serde_json::{json, Map, Value};

pub const SCHEMA_VERSION: u64 = 2;
pub const EXTRACTOR_VERSION: u64 = 1;
pub const QUOTE_MAX: usize = 400;

/// Loader: page text (1-based) of the PDF with this sha256, `None` when the
/// PDF or its text cache is unavailable.
pub type PageLoader<'a> = dyn Fn(&str, u32) -> Option<String> + 'a;

fn norm_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Validate the `facts.write` payload and return the normalised v2 document
/// plus the file stem to write (`<MPN>` or `<MPN>@<rev>` when an earlier
/// document for the same MPN points at a different PDF).
pub fn validate(
    mpn: &str,
    payload: &Value,
    existing: Option<&Value>,
    load_page: &PageLoader<'_>,
) -> Result<(Value, String), IpcError> {
    let list = payload
        .get("facts")
        .and_then(|f| f.as_array())
        .cloned()
        .or_else(|| payload.as_array().cloned())
        .unwrap_or_default();
    if list.is_empty() {
        return Err(err("FACT_PROVENANCE", "facts[] is empty"));
    }
    // Source: `source.sha256`, or a top-level `sha256` (v1 shape), or the
    // sha every fact carries; all of them must agree.
    let src = payload.get("source").cloned().unwrap_or(Value::Null);
    let mut sha: Option<String> = src
        .get("sha256")
        .or_else(|| payload.get("sha256"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    for f in &list {
        if let Some(s) = f.get("sha256").and_then(|v| v.as_str()) {
            match &sha {
                None => sha = Some(s.to_string()),
                Some(have) if have != s => {
                    return Err(err(
                        "FACT_SOURCE_MIXED",
                        "all facts of one document must cite the same source.sha256",
                    )
                    .with_evidence(json!({"expected": have, "got": s, "key": f.get("key")})));
                }
                _ => {}
            }
        }
    }
    let sha = sha.filter(|s| is_sha(s)).ok_or_else(|| {
        err(
            "FACT_PROVENANCE",
            "source.sha256 (the datasheet PDF handle from parts.datasheet) is required",
        )
    })?;
    let mut facts = Vec::with_capacity(list.len());
    for f in &list {
        let key = f.get("key").and_then(|v| v.as_str()).unwrap_or("").trim();
        if key.is_empty() {
            return Err(err("FACT_PROVENANCE", "every fact needs a key"));
        }
        let value = match f.get("value") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => {
                return Err(err("FACT_PROVENANCE", "every fact needs a value")
                    .with_evidence(json!({"key": key})))
            }
            Some(o) => o.to_string(),
        };
        let page = f
            .get("page")
            .and_then(|p| p.as_u64())
            .filter(|p| *p >= 1)
            .ok_or_else(|| {
                err(
                    "FACT_PROVENANCE",
                    "every fact needs a page number (1-based)",
                )
                .with_evidence(json!({"key": key}))
            })? as u32;
        let quote = f
            .get("quote")
            .and_then(|q| q.as_str())
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or_else(|| {
                err("FACT_PROVENANCE", "every fact needs a verbatim quote")
                    .with_evidence(json!({"key": key}))
            })?;
        if quote.len() > QUOTE_MAX {
            return Err(err("FACT_PROVENANCE", "quote longer than 400 bytes")
                .with_evidence(json!({"key": key})));
        }
        let text = load_page(&sha, page).ok_or_else(|| {
            err(
                "FACT_SOURCE_MISSING",
                "the datasheet page text is not available for quote verification",
            )
            .with_remediation("call docs.pdf_text {sha256, pages:[page]} first; the PDF must come from parts.datasheet")
            .with_evidence(json!({"key": key, "page": page, "sha256": sha}))
        })?;
        if !norm_ws(&text).contains(&norm_ws(quote)) {
            return Err(err(
                "FACT_QUOTE_MISMATCH",
                format!("quote for `{key}` is not found verbatim on page {page}"),
            )
            .with_remediation("copy the quote exactly as docs.pdf_text returned it (whitespace may differ, wording may not)")
            .with_evidence(json!({"key": key, "page": page})));
        }
        let mut m = Map::new();
        m.insert("key".into(), json!(key));
        m.insert("value".into(), json!(value));
        m.insert("page".into(), json!(page));
        m.insert("quote".into(), json!(quote));
        if let Some(u) = f.get("unit") {
            m.insert("unit".into(), u.clone());
        }
        if let Some(c) = f.get("condition") {
            m.insert("condition".into(), c.clone());
        }
        m.insert("audited".into(), json!(false));
        if let Some(by) = f
            .get("extracted_by")
            .or_else(|| payload.get("extracted_by"))
        {
            m.insert("extracted_by".into(), by.clone());
        }
        m.insert("ts".into(), json!(now_iso()));
        facts.push(Value::Object(m));
    }
    let pins = payload
        .get("pins")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    for p in &pins {
        if p.get("number").and_then(|v| v.as_str()).is_none()
            || p.get("name").and_then(|v| v.as_str()).is_none()
        {
            return Err(err(
                "FACT_PROVENANCE",
                "pins[] entries need number and name",
            ));
        }
    }
    let revision = src
        .get("revision")
        .or_else(|| payload.get("revision"))
        .cloned()
        .unwrap_or(Value::Null);
    let stem = match existing
        .and_then(|e| e.pointer("/source/sha256").or_else(|| e.get("sha256")))
        .and_then(|v| v.as_str())
    {
        Some(old) if old != sha => {
            let rev = revision
                .as_str()
                .map(|r| {
                    r.chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
                        .collect::<String>()
                })
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| sha[..8].to_string());
            format!("{mpn}@{rev}")
        }
        _ => mpn.to_string(),
    };
    let doc = json!({
        "schema_version": SCHEMA_VERSION,
        "mpn": mpn,
        "written": now_iso(),
        "source": {
            "sha256": sha,
            "pointer": src.get("pointer").cloned().unwrap_or(Value::Null),
            "revision": revision,
            "pages": src.get("pages").cloned().unwrap_or(Value::Null),
            "extractor_version": EXTRACTOR_VERSION,
            "skill_sha": src.get("skill_sha").cloned().unwrap_or(Value::Null),
        },
        "facts": facts,
        "pins": pins,
    });
    Ok((doc, stem))
}

/// Production loader: the `external/<sha>.txt` cache written by `docs.pdf_text`,
/// falling back to a fresh extraction of `external/<sha>` when the cache is cold.
pub fn app_page_loader(sha: &str, page: u32) -> Option<String> {
    if let Some(t) = crate::pdftext::page_text_cached(sha, page) {
        return Some(t);
    }
    let bytes = std::fs::read(crate::intake::cached_path(sha)).ok()?;
    let pages = crate::pdftext::pages_cached(sha, || Ok(bytes)).ok()?;
    pages.get(page.checked_sub(1)? as usize).cloned()
}

/// Facts as one-line, untrusted brief entries: `MPN key=value (p.N, unaudited)`.
pub fn brief_lines(docs: &[Value], cap: usize) -> Vec<String> {
    let mut out = Vec::new();
    for d in docs {
        let mpn = d.get("mpn").and_then(|v| v.as_str()).unwrap_or("?");
        for f in d
            .get("facts")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            if out.len() >= cap {
                return out;
            }
            let key = f.get("key").and_then(|v| v.as_str()).unwrap_or("?");
            let value = match f.get("value") {
                Some(Value::String(s)) => s.clone(),
                Some(o) => o.to_string(),
                None => String::new(),
            };
            let page = f.get("page").and_then(|v| v.as_u64()).unwrap_or(0);
            let audited = f.get("audited").and_then(|v| v.as_bool()).unwrap_or(false);
            out.push(format!(
                "{mpn} {key}={} (p.{page}, {})",
                norm_ws(&value),
                if audited { "audited" } else { "unaudited" }
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    fn loader(sha: &str, page: u32) -> Option<String> {
        if sha != SHA {
            return None;
        }
        match page {
            1 => Some("Absolute maximum ratings\nVDD operating   voltage 1.7 to 3.6 V\n".into()),
            2 => Some("Pin 5 VDD power".into()),
            _ => None,
        }
    }

    #[test]
    fn accepts_verbatim_quote_modulo_whitespace() {
        let p = json!({"source": {"sha256": SHA, "revision": "Rev 5"}, "facts": [{"key": "vdd_range", "value": "1.7-3.6 V", "page": 1, "quote": "VDD operating voltage 1.7 to 3.6 V"}]});
        let (doc, stem) = validate("STM32G071", &p, None, &loader).unwrap();
        assert_eq!(stem, "STM32G071");
        assert_eq!(doc["schema_version"], 2);
        assert_eq!(doc["source"]["sha256"], SHA);
        assert_eq!(doc["facts"][0]["audited"], false);
    }

    #[test]
    fn rejects_missing_page_quote_or_source() {
        let no_page = json!({"source": {"sha256": SHA}, "facts": [{"key": "k", "value": "v", "quote": "VDD"}]});
        assert_eq!(
            validate("X", &no_page, None, &loader).unwrap_err().code,
            "FACT_PROVENANCE"
        );
        let no_quote =
            json!({"source": {"sha256": SHA}, "facts": [{"key": "k", "value": "v", "page": 1}]});
        assert_eq!(
            validate("X", &no_quote, None, &loader).unwrap_err().code,
            "FACT_PROVENANCE"
        );
        let no_src = json!({"facts": [{"key": "k", "value": "v", "page": 1, "quote": "VDD"}]});
        assert_eq!(
            validate("X", &no_src, None, &loader).unwrap_err().code,
            "FACT_PROVENANCE"
        );
    }

    #[test]
    fn rejects_quote_not_on_page_and_mixed_sources() {
        let wrong = json!({"source": {"sha256": SHA}, "facts": [{"key": "k", "value": "v", "page": 2, "quote": "VDD operating voltage"}]});
        assert_eq!(
            validate("X", &wrong, None, &loader).unwrap_err().code,
            "FACT_QUOTE_MISMATCH"
        );
        let missing = json!({"source": {"sha256": SHA}, "facts": [{"key": "k", "value": "v", "page": 9, "quote": "VDD"}]});
        assert_eq!(
            validate("X", &missing, None, &loader).unwrap_err().code,
            "FACT_SOURCE_MISSING"
        );
        let other = "f".repeat(64);
        let mixed = json!({"source": {"sha256": SHA}, "facts": [{"key": "k", "value": "v", "page": 1, "quote": "VDD", "sha256": other}]});
        assert_eq!(
            validate("X", &mixed, None, &loader).unwrap_err().code,
            "FACT_SOURCE_MIXED"
        );
    }

    #[test]
    fn new_revision_gets_its_own_file() {
        let existing = json!({"schema_version": 2, "source": {"sha256": "a".repeat(64)}});
        let p = json!({"source": {"sha256": SHA, "revision": "Rev 5"}, "facts": [{"key": "k", "value": "v", "page": 2, "quote": "Pin 5 VDD"}]});
        let (_, stem) = validate("MPN", &p, Some(&existing), &loader).unwrap();
        assert_eq!(stem, "MPN@Rev5");
    }

    #[test]
    fn brief_lines_are_capped_and_marked() {
        let docs = vec![
            json!({"mpn": "M", "facts": [{"key": "a", "value": "1", "page": 3}, {"key": "b", "value": "2", "page": 4, "audited": true}]}),
        ];
        let l = brief_lines(&docs, 1);
        assert_eq!(l, vec!["M a=1 (p.3, unaudited)"]);
        assert_eq!(brief_lines(&docs, 10)[1], "M b=2 (p.4, audited)");
    }
}
