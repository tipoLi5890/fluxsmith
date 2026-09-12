// SPDX-License-Identifier: Apache-2.0
//! Skill-pack golden tests (`docs/skill-packs.md` "pack 自帶 golden 測試"): each
//! `tests/<case>/` in a pack holds `reference.ops.json` (an op-list) and `expected.json`
//! (the golden-set oracle shape: component fingerprints + anchored nets). The runner
//! replays the op-list into a scratch project through the real engine (no model) and scores
//! it with the same partial-credit rule as `fluxsmith-cli golden match --score`.

use crate::ipc::{IpcError, SkillTestCase, SkillTestReport};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(serde::Deserialize)]
struct Expected {
    #[serde(default)]
    components: BTreeMap<String, usize>,
    #[serde(default)]
    anchored_nets: BTreeMap<String, Vec<String>>,
}

/// Same fingerprint as the golden matcher: `lib_id|value|` (connector values are free text).
pub fn fingerprint(lib_id: &str, value: &str) -> String {
    let v = if lib_id.starts_with("Connector") {
        String::new()
    } else {
        value_norm(value)
    };
    format!("{lib_id}|{v}|")
}

/// Identical to `fluxsmith-cli`'s `value_norm` so a pack's `expected.json` (produced by
/// `golden extract`) and the in-app runner agree byte for byte.
pub fn value_norm(v: &str) -> String {
    let s: String = v
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    let s = s
        .replace(['µ', 'μ'], "u")
        .replace('Ω', "")
        .replace("ohm", "")
        .replace(
            'r',
            if s.chars().filter(|c| c.is_ascii_digit()).count() > 0 && s.ends_with('r') {
                ""
            } else {
                "r"
            },
        );
    let mut t = s.clone();
    for unit in ["f", "h"] {
        if t.ends_with(unit) && t.len() > 1 {
            let prev = t.chars().nth(t.len() - 2).unwrap();
            if prev.is_ascii_digit() || "pnumk".contains(prev) {
                t.pop();
            }
        }
    }
    if let Some((num, prefix)) = split_num(&t) {
        let mult = match prefix {
            "p" => 1e-12,
            "n" => 1e-9,
            "u" => 1e-6,
            "m" => 1e-3,
            "k" => 1e3,
            "meg" | "M" => 1e6,
            "g" => 1e9,
            "" => 1.0,
            _ => return t,
        };
        return format!("{:e}", num * mult);
    }
    t
}

fn split_num(s: &str) -> Option<(f64, &str)> {
    let idx = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    if idx == 0 {
        return None;
    }
    let num: f64 = s[..idx].parse().ok()?;
    let rest = &s[idx..];
    if rest.chars().all(|c| c.is_ascii_alphabetic()) && rest.len() <= 3 {
        Some((num, rest))
    } else {
        None
    }
}

fn symmetric_two_pin(lib_id: &str) -> bool {
    matches!(
        lib_id,
        "Device:R"
            | "Device:C"
            | "Device:L"
            | "Device:R_Small"
            | "Device:C_Small"
            | "Device:L_Small"
            | "Device:Jumper"
            | "Device:Crystal"
            | "Device:Fuse"
            | "Device:Ferrite_Bead"
    )
}

/// A project's component multiset (fingerprint -> count) and its anchored nets
/// (net name -> members), as `canonical` returns them.
pub type Canonical = (BTreeMap<String, usize>, BTreeMap<String, Vec<String>>);

/// Component multiset + anchored nets of a project (members as `fingerprint#pin`, `#*` for symmetric parts).
pub fn canonical(root_sheet: &Path) -> Result<Canonical, IpcError> {
    let tree = sch_read::read_project(root_sheet)?;
    let nets = sch_net::build_nets(&tree);
    let mut fp_by_ref: BTreeMap<String, (String, bool)> = BTreeMap::new();
    let mut components: BTreeMap<String, usize> = BTreeMap::new();
    for s in tree.files.values().flat_map(|s| s.symbols.iter()) {
        if s.reference.starts_with('#') {
            continue;
        }
        let fp = fingerprint(&s.lib_id, &s.value);
        if !fp_by_ref.contains_key(&s.reference) {
            *components.entry(fp.clone()).or_default() += 1;
        }
        fp_by_ref
            .entry(s.reference.clone())
            .or_insert((fp, symmetric_two_pin(&s.lib_id)));
    }
    let mut anchored: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for n in &nets.nets {
        if !sch_net::is_named(&n.name) {
            continue;
        }
        let name = n.name.trim_start_matches('/').to_string();
        let mut members: Vec<String> = n
            .members
            .iter()
            .filter_map(|m| {
                fp_by_ref
                    .get(&m.reference)
                    .map(|(fp, sym)| format!("{fp}#{}", if *sym { "*" } else { m.pin.as_str() }))
            })
            .collect();
        members.sort();
        anchored.insert(name, members);
    }
    Ok((components, anchored))
}

/// Partial credit in 0..=1: half component-multiset Jaccard, half mean per-net member Jaccard.
pub fn score(
    exp_c: &BTreeMap<String, usize>,
    have_c: &BTreeMap<String, usize>,
    exp_n: &BTreeMap<String, Vec<String>>,
    have_n: &BTreeMap<String, Vec<String>>,
) -> f64 {
    let keys: BTreeSet<&String> = exp_c.keys().chain(have_c.keys()).collect();
    let (mut inter, mut union) = (0usize, 0usize);
    for k in keys {
        let a = exp_c.get(k).copied().unwrap_or(0);
        let b = have_c.get(k).copied().unwrap_or(0);
        inter += a.min(b);
        union += a.max(b);
    }
    let comp = if union == 0 {
        1.0
    } else {
        inter as f64 / union as f64
    };
    let net = if exp_n.is_empty() {
        1.0
    } else {
        let mut total = 0.0;
        for (name, want) in exp_n {
            let Some(have) = have_n.get(name) else {
                continue;
            };
            let w: BTreeSet<&String> = want.iter().collect();
            let h: BTreeSet<&String> = have.iter().collect();
            let u = w.union(&h).count();
            if u > 0 {
                total += w.intersection(&h).count() as f64 / u as f64;
            }
        }
        total / exp_n.len() as f64
    };
    ((0.5 * comp + 0.5 * net) * 1000.0).round() / 1000.0
}

/// Scratch project (root sheet path) in `dir`.
fn scratch_project(dir: &Path) -> Result<std::path::PathBuf, IpcError> {
    let root_uuid = uuid::Uuid::new_v4().to_string();
    let sch = sch_write::nodes::empty_schematic(&root_uuid, "A4");
    let p = dir.join("scratch.kicad_sch");
    std::fs::write(&p, sch).map_err(|e| crate::error::io_err(&p, e))?;
    Ok(p)
}

/// Runs every `tests/<case>/` of `pack_dir`. Cases without both files are reported as failures with a reason.
pub fn run(
    pack: &str,
    pack_dir: &Path,
    lib_rows: Vec<sch_read::LibTableRow>,
) -> Result<SkillTestReport, IpcError> {
    let tests = pack_dir.join("tests");
    let mut cases = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&tests) {
        let mut dirs: Vec<_> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for d in dirs {
            let name = d
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            cases.push(run_case(&name, &d, lib_rows.clone()));
        }
    }
    let pass = cases.iter().filter(|c| c.pass).count();
    Ok(SkillTestReport {
        pack: pack.into(),
        total: cases.len(),
        pass,
        cases,
    })
}

fn run_case(name: &str, dir: &Path, lib_rows: Vec<sch_read::LibTableRow>) -> SkillTestCase {
    let fail = |detail: String| SkillTestCase {
        name: name.into(),
        pass: false,
        score: 0.0,
        detail,
    };
    let ops_text = match std::fs::read_to_string(dir.join("reference.ops.json")) {
        Ok(t) => t,
        Err(_) => return fail("reference.ops.json missing".into()),
    };
    let expected: Expected = match std::fs::read_to_string(dir.join("expected.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
    {
        Some(e) => e,
        None => return fail("expected.json missing or invalid".into()),
    };
    let ops: Value = match serde_json::from_str(&ops_text) {
        Ok(v) => v,
        Err(e) => return fail(format!("reference.ops.json: {e}")),
    };
    let oplist = match sch_ops::OpList::from_value(ops) {
        Ok(o) => o,
        Err(e) => return fail(format!("op-list invalid: {e:?}")),
    };
    let tmp = match tempfile::tempdir() {
        Ok(t) => t,
        Err(e) => return fail(e.to_string()),
    };
    let target = match scratch_project(tmp.path()) {
        Ok(p) => p,
        Err(e) => return fail(e.message),
    };
    let mut engine = sch_write::Engine::new(sch_read::SymbolLibrary::new(lib_rows));
    let req = sch_write::DrawRequest {
        target: target.clone(),
        root: None,
        oplist,
        strict_nets: false,
        strict_layout: false,
        expected_merges: Vec::new(),
        note: Some(format!("skill test {name}")),
        backup_depth: 0,
        journal: None,
        expected_target_sha: None,
        run_backup_dir: None,
    };
    match engine.apply(&req) {
        Ok(r) if r.applied => {}
        Ok(r) => {
            return fail(format!(
                "engine refused: {} integrity finding(s)",
                r.integrity_introduced.len()
            ))
        }
        Err(e) => return fail(format!("apply failed: {e}")),
    }
    let (have_c, have_n) = match canonical(&target) {
        Ok(v) => v,
        Err(e) => return fail(e.message),
    };
    let s = score(
        &expected.components,
        &have_c,
        &expected.anchored_nets,
        &have_n,
    );
    let missing: Vec<String> = expected
        .components
        .keys()
        .filter(|k| !have_c.contains_key(*k))
        .cloned()
        .collect();
    let detail = if s >= 1.0 {
        "match".into()
    } else if missing.is_empty() {
        "nets differ".into()
    } else {
        format!("missing: {}", missing.join(", "))
    };
    SkillTestCase {
        name: name.into(),
        pass: s >= 1.0,
        score: s,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn value_norm_and_score() {
        assert_eq!(value_norm("4.7k"), "4.7e3");
        assert_eq!(value_norm("10k"), "1e4");
        assert_eq!(fingerprint("Device:R", "10k"), "Device:R|1e4|");
        let mut e = BTreeMap::new();
        e.insert("Device:R|1e4|".to_string(), 2usize);
        let mut h = BTreeMap::new();
        h.insert("Device:R|1e4|".to_string(), 1usize);
        assert_eq!(score(&e, &h, &BTreeMap::new(), &BTreeMap::new()), 0.75);
        assert_eq!(score(&e, &e, &BTreeMap::new(), &BTreeMap::new()), 1.0);
    }
}
