// SPDX-License-Identifier: Apache-2.0
//! `export_file`: the only write outside the project, always to a path the
//! user chose in the OS dialog (S tier).

use crate::error::{err, io_err};
use crate::ipc::IpcError;
use crate::state::AppState;
use serde_json::Value;
use std::path::Path;

pub fn export(
    state: &AppState,
    project_key: &str,
    kind: &str,
    payload: &Value,
    out: &str,
) -> Result<String, IpcError> {
    let h = state.project(project_key)?;
    let out_p = Path::new(out);
    if out_p.starts_with(&h.root) && !out_p.starts_with(h.root.join("exports")) {
        return Err(err(
            "PATH_OUT_OF_SCOPE",
            "exports may not overwrite project files",
        )
        .with_remediation("choose a location outside the project or its exports/ folder"));
    }
    let bytes: Vec<u8> = match kind {
        "svg" => svg(&h, payload)?.into_bytes(),
        "netlist" => {
            let tree = sch_read::read_project(&h.root_sheet)?;
            let nets = sch_net::build_nets(&tree);
            netlist_sexpr(&nets).into_bytes()
        }
        // A review report: Markdown for a human to read or attach, JSON for anything else to parse.
        // The rows are the ones the findings panel is showing; nothing here judges the circuit.
        "findings" => {
            if out.ends_with(".md") || out.ends_with(".markdown") {
                let project = payload
                    .get("project")
                    .and_then(|p| p.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        h.root
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    });
                findings_markdown(payload, &project, &crate::paths::now_iso()).into_bytes()
            } else {
                serde_json::to_string_pretty(payload)?.into_bytes()
            }
        }
        "plan" | "metrics" => serde_json::to_string_pretty(payload)?.into_bytes(),
        "bom" => {
            // Payload: the `parts.bom` result (or nothing: build it now).
            let report = if payload.get("lines").is_some() {
                payload.clone()
            } else {
                crate::parts::bom(state, project_key, false, None)?
            };
            if out.ends_with(".csv") {
                bom_csv(&report).into_bytes()
            } else {
                serde_json::to_string_pretty(&report)?.into_bytes()
            }
        }
        "transcript" => {
            let s = payload
                .get("jsonl")
                .and_then(|j| j.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| serde_json::to_string_pretty(payload).unwrap_or_default());
            crate::log::mask(&s).into_bytes()
        }
        "costs" => {
            if out.ends_with(".csv") {
                let rows = payload.as_array().cloned().unwrap_or_default();
                let mut s = String::from("id,plan_id,plan_version,turn,step,role,model,input,cache_creation,cache_read,output,cost_usd,latency_ms,ts\n");
                for r in rows {
                    let g = |k: &str| {
                        r.get(k)
                            .map(|v| match v {
                                Value::String(x) => x.replace(',', ";"),
                                Value::Null => String::new(),
                                o => o.to_string(),
                            })
                            .unwrap_or_default()
                    };
                    s.push_str(&format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
                        g("id"),
                        g("plan_id"),
                        g("plan_version"),
                        g("turn"),
                        g("step"),
                        g("role"),
                        g("model"),
                        g("input"),
                        g("cache_creation"),
                        g("cache_read"),
                        g("output"),
                        g("cost_usd"),
                        g("latency_ms"),
                        g("ts")
                    ));
                }
                s.into_bytes()
            } else {
                serde_json::to_string_pretty(payload)?.into_bytes()
            }
        }
        _ => return Err(err("BAD_CONFIG", "unknown export kind")),
    };
    crate::paths::write_atomic(out_p, &bytes)
        .map_err(|e| io_err(out_p, std::io::Error::other(e.message)))?;
    Ok(out.to_string())
}

/// Which of the three sources a finding row came from. Mirrors `src/agent/findings.ts`
/// (`findingBucket`): only the engine gate decides pass/fail, `kicad-cli sch erc` is KiCad's own
/// second opinion, everything else the model suggested. The report keeps them apart so a reader
/// never takes a suggestion for a verdict.
fn findings_bucket(row: &Value) -> &'static str {
    let code = row.get("code").and_then(|c| c.as_str()).unwrap_or_default();
    if code.starts_with("KICAD_") {
        return "kicad";
    }
    if row.get("origin").and_then(|o| o.as_str()) == Some("advisory") {
        "model"
    } else {
        "engine"
    }
}

/// A waiver expiry as a calendar day: the record carries an ISO instant, and a report is read by a
/// human who wants the date, not the second. Anything that is not a date is passed through as it is.
fn waiver_day(v: &str) -> String {
    let head = v.get(0..10).unwrap_or(v);
    let looks_like_a_day = head.len() == 10
        && head.char_indices().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        });
    if looks_like_a_day {
        head.to_string()
    } else {
        v.to_string()
    }
}

/// What the check measured (`sch-write/src/gates.rs` `evidence`), on one line: `key=value` pairs in
/// the map's own order. Untrusted engine data, written as plain text.
fn evidence_line(v: &Value) -> String {
    match v.as_object() {
        Some(map) => map
            .iter()
            .map(|(k, val)| {
                let text = match val {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                format!("{k}={text}")
            })
            .collect::<Vec<_>>()
            .join("; "),
        None => match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
    }
}

/// The findings report as Markdown: title, project, date, counts per bucket and severity, then one
/// section per sheet with every row's code, severity, refs, message, remediation and waiver expiry.
/// Plain text only (red line 23: no emoji, no dingbat ticks anywhere in an exported report).
fn findings_markdown(payload: &Value, project: &str, now: &str) -> String {
    let rows: Vec<&Value> = payload
        .get("findings")
        .and_then(|f| f.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let str_of = |row: &Value, k: &str| -> String {
        row.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let mut out = String::from("# Review findings\n\n");
    out.push_str(&format!("- Project: {project}\n"));
    out.push_str(&format!("- Exported: {now}\n"));
    out.push_str(&format!("- Findings: {}\n\n", rows.len()));
    out.push_str("## Counts\n\n");
    out.push_str("| Source | Errors | Warnings | Other | Total |\n");
    out.push_str("| --- | --- | --- | --- | --- |\n");
    for (bucket, label) in [
        ("engine", "Engine gate"),
        ("kicad", "KiCad ERC"),
        ("model", "Suggested"),
    ] {
        let of_bucket: Vec<&&Value> = rows
            .iter()
            .filter(|r| findings_bucket(r) == bucket)
            .collect();
        let sev = |name: &str| {
            of_bucket
                .iter()
                .filter(|r| str_of(r, "severity").eq_ignore_ascii_case(name))
                .count()
        };
        let (e, w) = (sev("error"), sev("warning"));
        out.push_str(&format!(
            "| {label} | {e} | {w} | {} | {} |\n",
            of_bucket.len() - e - w,
            of_bucket.len()
        ));
    }
    // One section per sheet, in the order the sheets first appear; rows the engine could not place
    // on a sheet (project-level checks, the library audit) come last under their own heading.
    let mut sheets: Vec<String> = Vec::new();
    for r in &rows {
        let s = str_of(r, "sheet");
        if !sheets.contains(&s) {
            sheets.push(s);
        }
    }
    sheets.sort_by_key(|s| (s.is_empty(), s.clone()));
    for sheet in sheets {
        out.push_str(&format!(
            "\n## {}\n",
            if sheet.is_empty() {
                "Project level".to_string()
            } else {
                sheet.clone()
            }
        ));
        for r in rows.iter().filter(|r| str_of(r, "sheet") == sheet) {
            let severity = str_of(r, "severity");
            out.push_str(&format!(
                "\n### {} ({})\n",
                str_of(r, "code"),
                if severity.is_empty() {
                    "Info".into()
                } else {
                    severity
                }
            ));
            // The English title of the code, when the UI knew one (`src/i18n/findings/en.ts`): the
            // code stays the identifier, the title says what it names. Never the interface language:
            // an exported report is read outside this app.
            let title = str_of(r, "title");
            if !title.is_empty() {
                out.push_str(&format!("- Title: {title}\n"));
            }
            // What the check looked at, from the same table as the title: a reader outside the app
            // has no other way to know what the code names (red line 6: it never judges the circuit).
            let detail = str_of(r, "detail");
            if !detail.is_empty() {
                out.push_str(&format!("- Detail: {detail}\n"));
            }
            out.push_str(&format!("- Source: {}\n", findings_bucket(r)));
            let refs: Vec<&str> = r
                .get("refs")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                .unwrap_or_default();
            let where_ = if refs.is_empty() {
                str_of(r, "location")
            } else {
                refs.join(", ")
            };
            if !where_.is_empty() {
                out.push_str(&format!("- Where: {where_}\n"));
            }
            // The sheet file the engine placed the row in; the section heading is the instance path.
            let file = str_of(r, "file");
            if !file.is_empty() {
                out.push_str(&format!("- File: {file}\n"));
            }
            let message = str_of(r, "message");
            if !message.is_empty() {
                out.push_str(&format!("- {message}\n"));
            }
            let remediation = str_of(r, "remediation");
            if !remediation.is_empty() {
                out.push_str(&format!("- Remediation: {remediation}\n"));
            }
            // The usual fix for the code, from the app's own table (English, like the title).
            let remedy = str_of(r, "remedy");
            if !remedy.is_empty() {
                out.push_str(&format!("- Remedy: {remedy}\n"));
            }
            let evidence = r.get("evidence").map(evidence_line).unwrap_or_default();
            if !evidence.is_empty() {
                out.push_str(&format!("- Evidence: {evidence}\n"));
            }
            let waived = str_of(r, "waived_until");
            if !waived.is_empty() {
                out.push_str(&format!("- Waived until: {}\n", waiver_day(&waived)));
            }
            // Why it was waived: without it a report says a finding is hidden and never says why.
            let waived_reason = str_of(r, "waived_reason");
            if !waived_reason.is_empty() {
                out.push_str(&format!("- Waived reason: {waived_reason}\n"));
            }
            if r.get("resolved").and_then(|v| v.as_bool()) == Some(true) {
                out.push_str("- Status: resolved\n");
            }
        }
    }
    out
}

/// Simple SVG from the overlay geometry: symbol boxes, wires, labels.
fn svg(h: &crate::state::ProjectHandle, payload: &Value) -> Result<String, IpcError> {
    let tree = sch_read::read_project(&h.root_sheet)?;
    let sp = payload.get("sheet").and_then(|s| s.as_str()).unwrap_or("/");
    let g =
        sch_geom::sheet_geometry(&tree, sp).ok_or_else(|| err("SHEET_UNKNOWN", sp.to_string()))?;
    let (w, hgt) = sch_write::gates::paper_size(&g.paper)
        .map(|(a, b)| (sch_model::nm_to_mil(a), sch_model::nm_to_mil(b)))
        .unwrap_or((11693.0, 8268.0));
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let mut out = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {hgt}\" font-family=\"monospace\" font-size=\"50\">\n<rect width=\"{w}\" height=\"{hgt}\" fill=\"white\"/>\n");
    for wire in &g.wires {
        out.push_str(&format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"#0a0\" stroke-width=\"6\"/>\n",
            wire[0][0], wire[0][1], wire[1][0], wire[1][1]
        ));
    }
    for s in &g.symbols {
        let b = s.bbox_mil;
        out.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"none\" stroke=\"#800\" stroke-width=\"6\"/>\n<text x=\"{}\" y=\"{}\">{}</text>\n", b[0][0], b[0][1], b[1][0] - b[0][0], b[1][1] - b[0][1], b[0][0], b[0][1] - 10.0, esc(&s.reference)));
        for p in &s.pins {
            out.push_str(&format!(
                "<circle cx=\"{}\" cy=\"{}\" r=\"8\" fill=\"#800\"/>\n",
                p.at_mil[0], p.at_mil[1]
            ));
        }
    }
    for (t, at, _) in &g.labels {
        out.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" fill=\"#008\">{}</text>\n",
            at[0],
            at[1],
            esc(t)
        ));
    }
    for (name, b) in &g.sheet_symbols {
        out.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"none\" stroke=\"#808\" stroke-width=\"6\"/>\n<text x=\"{}\" y=\"{}\">{}</text>\n", b[0][0], b[0][1], b[1][0] - b[0][0], b[1][1] - b[0][1], b[0][0], b[0][1] - 10.0, esc(name)));
    }
    out.push_str("</svg>\n");
    Ok(out)
}

fn netlist_sexpr(nets: &sch_net::Netlist) -> String {
    let mut s = String::from("(export (version \"E\")\n  (nets\n");
    for (i, n) in nets.nets.iter().enumerate() {
        s.push_str(&format!(
            "    (net (code \"{}\") (name {})\n",
            i + 1,
            kicad_sexpr::quote(&n.name)
        ));
        for m in &n.members {
            s.push_str(&format!(
                "      (node (ref {}) (pin {}) (pintype {}))\n",
                kicad_sexpr::quote(&m.reference),
                kicad_sexpr::quote(&m.pin),
                kicad_sexpr::quote(&m.pin_type)
            ));
        }
        s.push_str("    )\n");
    }
    s.push_str("  )\n)\n");
    s
}

/// BOM CSV in the column order KiCad users expect (refs, qty, value, footprint, LCSC, MPN, package,
/// stock, price, dnp), plus the two columns that say where the row came from: `lib_id` and `claim`
/// (`unverified` = a converted symbol nobody checked against the datasheet, `catalogue` = the JLC
/// snapshot, empty = neither). Dropping them shipped a claim as if it were a fact.
pub fn bom_csv(report: &Value) -> String {
    let cell = |v: Option<&Value>| -> String {
        let s = match v {
            Some(Value::String(x)) => x.clone(),
            Some(Value::Null) | None => String::new(),
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|x| x.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            Some(o) => o.to_string(),
        };
        if s.contains(',') || s.contains('"') || s.contains('\n') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s
        }
    };
    let mut s = String::from(
        "refs,qty,value,footprint,lcsc,mpn,package,stock,price_usd,dnp,substituted,lib_id,claim\n",
    );
    for l in report
        .get("lines")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        s.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            cell(l.get("refs")),
            cell(l.get("qty")),
            cell(l.get("value")),
            cell(l.get("footprint")),
            cell(l.get("lcsc")),
            cell(l.get("mpn")),
            cell(l.get("package")),
            cell(l.get("stock")),
            cell(l.get("price_usd")),
            cell(l.get("dnp")),
            cell(l.get("substituted")),
            cell(l.get("lib_id")),
            cell(l.get("claim")),
        ));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn findings_markdown_has_counts_per_bucket_and_a_section_per_sheet() {
        let payload = serde_json::json!({"project": "amp", "findings": [
            {"code": "ERC_POWER_IN_UNDRIVEN", "severity": "Error", "message": "VBUS is not driven", "sheet": "/", "file": "amp.kicad_sch", "refs": ["U1.5"], "remediation": "place a PWR_FLAG", "origin": "engine", "title": "Power input with no source", "detail": "Which power inputs no output or flag drives", "remedy": "Place a PWR_FLAG on the net", "evidence": {"net": "VBUS", "pins": 3}},
            {"code": "KICAD_PIN_NOT_CONNECTED", "severity": "Warning", "message": "pin not connected", "sheet": "/power/", "refs": ["U2.3"], "origin": "advisory"},
            {"code": "STYLE_HINT", "severity": "Warning", "message": "label style", "sheet": "/power/", "location": "style:1", "origin": "advisory"},
            {"code": "LIB_UNVERIFIED_CLAIM", "severity": "Info", "message": "converted symbol", "origin": "engine", "waived_until": "2099-01-01T00:00:00Z", "waived_reason": "the symbol is checked against the datasheet before the next build"}
        ]});
        let md = findings_markdown(&payload, "amp", "2026-09-06T00:00:00Z");
        assert!(md.starts_with("# Review findings\n"));
        assert!(md.contains("- Project: amp\n"));
        assert!(md.contains("- Exported: 2026-09-06T00:00:00Z\n"));
        assert!(md.contains("- Findings: 4\n"));
        // Counts are per source: one engine error, one KiCad warning, one model warning.
        assert!(md.contains("| Engine gate | 1 | 0 | 1 | 2 |"), "{md}");
        assert!(md.contains("| KiCad ERC | 0 | 1 | 0 | 1 |"), "{md}");
        assert!(md.contains("| Suggested | 0 | 1 | 0 | 1 |"), "{md}");
        // One section per sheet, the unplaceable rows last under their own heading.
        assert!(md.contains("\n## /\n"));
        assert!(md.contains("\n## /power/\n"));
        assert!(md.find("## /power/") < md.find("## Project level"));
        assert!(md.contains("### ERC_POWER_IN_UNDRIVEN (Error)"));
        // The code stays the identifier; the English title from the UI table says what it names.
        assert!(md.contains("- Title: Power input with no source\n"), "{md}");
        // A row without a title (a model advisory) simply has no title line.
        assert!(!md.contains("- Title: \n"), "{md}");
        assert!(md.contains("- Where: U1.5\n"));
        assert!(md.contains("- Remediation: place a PWR_FLAG\n"));
        assert!(md.contains("- Where: style:1\n"));
        // The finding-copy table travels with the row: what the check measured and the usual fix.
        assert!(
            md.contains("- Detail: Which power inputs no output or flag drives\n"),
            "{md}"
        );
        assert!(
            md.contains("- Remedy: Place a PWR_FLAG on the net\n"),
            "{md}"
        );
        assert!(md.contains("- File: amp.kicad_sch\n"), "{md}");
        // The engine's own evidence, one line of key=value pairs.
        assert!(md.contains("- Evidence: net=VBUS; pins=3\n"), "{md}");
        // A waiver expiry is a calendar day in a report, not an ISO instant, and it says why.
        assert!(md.contains("- Waived until: 2099-01-01\n"), "{md}");
        assert!(md.contains("- Waived reason: the symbol is checked against the datasheet before the next build\n"), "{md}");
        // Red line 23: an exported report carries no emoji or dingbat ticks.
        assert!(md.chars().all(|c| c < '\u{2190}'), "{md}");
    }

    #[test]
    fn bom_csv_quotes_commas() {
        let r = serde_json::json!({"lines": [{"refs": ["R1", "R2"], "qty": 2, "value": "10k, 1%", "footprint": "R_0603", "lcsc": "C25804", "mpn": "", "package": "0603", "stock": 5, "price_usd": 0.001, "dnp": false, "substituted": false}]});
        let csv = bom_csv(&r);
        assert!(csv.starts_with("refs,qty,value"));
        assert!(csv.contains("R1 R2,2,\"10k, 1%\",R_0603,C25804"));
    }

    /// A converted part must not leave the app as an anonymous BOM row: the CSV names the library
    /// symbol it came from and says the values are a claim.
    #[test]
    fn bom_csv_carries_lib_id_and_claim() {
        let r = serde_json::json!({"lines": [
            {"refs": ["U1"], "qty": 1, "value": "AMS1117-3.3", "footprint": "jlc:SOT-223", "lcsc": "C6186", "mpn": "AMS1117-3.3", "package": "SOT-223", "stock": 9, "price_usd": 0.1, "dnp": false, "substituted": null, "lib_id": "jlc:AMS1117-3.3", "claim": "unverified"},
            {"refs": ["R1"], "qty": 1, "value": "10k", "footprint": "R_0603", "lcsc": null, "mpn": null, "package": null, "stock": null, "price_usd": null, "dnp": false, "substituted": null, "lib_id": "Device:R", "claim": ""},
        ]});
        let csv = bom_csv(&r);
        let mut rows = csv.lines();
        assert!(rows.next().unwrap().ends_with(",substituted,lib_id,claim"));
        assert!(rows
            .next()
            .unwrap()
            .ends_with(",jlc:AMS1117-3.3,unverified"));
        assert!(rows.next().unwrap().ends_with(",Device:R,"));
    }
}
