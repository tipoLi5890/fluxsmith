// SPDX-License-Identifier: Apache-2.0
//! Skill packs (docs/skill-packs.md): builtin (bundled), user (app data),
//! project (`.fluxsmith/skills`). Parsing, sha, trust, lint, drafts, zip.

use crate::error::{err, io_err};
use crate::ipc::*;
use crate::paths::{app_data_dir, ensure_dir, sha256_hex, write_atomic};
use crate::state::AppState;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const D_TOOLS: &[&str] = &[
    "sch.apply",
    "sch.apply_waived",
    "sheet.create",
    "project.new",
    "parts.convert",
    "policy.waive",
    "intent.snapshot",
];

pub fn builtin_dir(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Ok(p) = std::env::var("FLUXSMITH_SKILLS_DIR") {
        return PathBuf::from(p);
    }
    if let Some(a) = app {
        use tauri::Manager;
        if let Ok(r) = a.path().resource_dir() {
            for c in [
                r.join("skills"),
                r.join("_up_").join("skills"),
                r.join("../skills"),
            ] {
                if c.is_dir() {
                    return c;
                }
            }
        }
    }
    // Dev / run-from-source: repo root relative to the crate.
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills");
    if dev.is_dir() {
        return dev;
    }
    PathBuf::from("skills")
}

pub fn user_dir() -> PathBuf {
    app_data_dir().join("skills")
}

/// Parse `---` YAML-ish front matter (flat keys, `[a, b]` lists) + `{#id}` anchors.
pub fn parse_skill(text: &str) -> (Value, Vec<String>, usize) {
    let mut fm = serde_json::Map::new();
    let mut body = text;
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let block = &rest[..end];
            body = &rest[end + 4..];
            let mut cur_key: Option<String> = None;
            let mut cur_val = String::new();
            let flush = |k: &Option<String>, v: &str, fm: &mut serde_json::Map<String, Value>| {
                if let Some(k) = k {
                    fm.insert(k.clone(), parse_scalar(v.trim()));
                }
            };
            for line in block.lines() {
                if line.starts_with(' ') || line.starts_with('\t') {
                    cur_val.push(' ');
                    cur_val.push_str(line.trim());
                    continue;
                }
                if let Some((k, v)) = line.split_once(':') {
                    flush(&cur_key, &cur_val, &mut fm);
                    cur_key = Some(k.trim().to_string());
                    cur_val = v.trim().trim_start_matches(">-").trim().to_string();
                }
            }
            flush(&cur_key, &cur_val, &mut fm);
        }
    }
    let re = regex::Regex::new(r"\{#([A-Za-z0-9_\-]+)\}").unwrap();
    let sections: Vec<String> = re.captures_iter(body).map(|c| c[1].to_string()).collect();
    // L0 = description + section list (what goes into the system index).
    let l0 = fm
        .get("description")
        .and_then(|d| d.as_str())
        .map(|s| s.len())
        .unwrap_or(0)
        + sections.iter().map(|s| s.len() + 2).sum::<usize>();
    (Value::Object(fm), sections, l0)
}

fn parse_scalar(v: &str) -> Value {
    let v = v.trim();
    if let Some(inner) = v.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        return Value::Array(
            inner
                .split(',')
                .map(|x| Value::String(x.trim().trim_matches('"').trim_matches('\'').to_string()))
                .filter(|x| !x.as_str().unwrap().is_empty())
                .collect(),
        );
    }
    match v {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        _ => Value::String(v.trim_matches('"').trim_matches('\'').to_string()),
    }
}

fn pack_sha(dir: &Path) -> String {
    let mut files: Vec<PathBuf> = walk(dir);
    files.sort();
    let mut acc = Vec::new();
    for f in files {
        let rel = f
            .strip_prefix(dir)
            .map(|r| r.to_string_lossy().to_string())
            .unwrap_or_default();
        acc.extend_from_slice(rel.as_bytes());
        acc.push(0);
        acc.extend_from_slice(&std::fs::read(&f).unwrap_or_default());
        acc.push(0);
    }
    sha256_hex(&acc)
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Static workflow rules (red line 20).
pub fn lint_workflow(yaml_text: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let doc: Value = match serde_yaml_like(yaml_text) {
        Some(v) => v,
        None => {
            problems.push("workflow.yaml is not valid YAML".into());
            return problems;
        }
    };
    let mode = doc.get("mode").and_then(|m| m.as_str()).unwrap_or("plan");
    let steps = doc
        .get("steps")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    let mut has_d = false;
    let mut seen_approval = false;
    for (i, s) in steps.iter().enumerate() {
        let kind = s.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let tools: Vec<&str> = s
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let d_here = tools.iter().any(|t| D_TOOLS.contains(t));
        if d_here {
            has_d = true;
        }
        if kind == "agent" && d_here {
            problems.push(format!("step {i}: agent steps may not use D tools"));
        }
        if kind == "approval" {
            seen_approval = true;
        }
        if kind == "structural" && !seen_approval {
            problems.push(format!(
                "step {i}: structural step without a prior approval step"
            ));
        }
        if kind == "gate" {
            let src = s.get("verdict").and_then(|v| v.as_str()).unwrap_or("");
            if !src.starts_with("engine.") && !src.starts_with("result.") {
                problems.push(format!(
                    "step {i}: gate verdict must come from an engine result field"
                ));
            }
        }
        if kind == "shell" || s.get("run").is_some() || s.get("command").is_some() {
            problems.push(format!("step {i}: shell steps are not allowed"));
        }
    }
    if has_d && mode != "build" {
        problems.push("workflows that use D tools must declare mode: build".into());
    }
    if has_d && doc.get("limits").is_none() {
        problems.push("workflows that use D tools must declare limits".into());
    }
    problems
}

/// Minimal YAML subset reader (maps, lists of maps, scalars, flow lists) so
/// the lint runs without a YAML dependency in Rust; the full interpreter is
/// in the webview.
fn serde_yaml_like(text: &str) -> Option<Value> {
    let json_try = serde_json::from_str::<Value>(text);
    if let Ok(v) = json_try {
        return Some(v);
    }
    let mut root = serde_json::Map::new();
    let mut steps: Vec<Value> = Vec::new();
    let mut in_steps = false;
    let mut cur: Option<serde_json::Map<String, Value>> = None;
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if indent == 0 {
            if let Some(c) = cur.take() {
                steps.push(Value::Object(c));
            }
            if t == "steps:" {
                in_steps = true;
                continue;
            }
            in_steps = false;
            if let Some((k, v)) = t.split_once(':') {
                root.insert(
                    k.trim().to_string(),
                    if v.trim().is_empty() {
                        json!({})
                    } else {
                        parse_scalar(v)
                    },
                );
            }
            continue;
        }
        if in_steps {
            if let Some(rest) = t.strip_prefix("- ") {
                if let Some(c) = cur.take() {
                    steps.push(Value::Object(c));
                }
                let mut m = serde_json::Map::new();
                if let Some((k, v)) = rest.split_once(':') {
                    m.insert(k.trim().to_string(), parse_scalar(v));
                }
                cur = Some(m);
            } else if let Some(c) = cur.as_mut() {
                if let Some((k, v)) = t.split_once(':') {
                    c.insert(k.trim().to_string(), parse_scalar(v));
                }
            }
        } else if let Some((k, v)) = t.split_once(':') {
            // nested map under the last root key (e.g. limits)
            if let Some((_, Value::Object(o))) = root.iter_mut().last() {
                o.insert(k.trim().to_string(), parse_scalar(v));
            }
        }
    }
    if let Some(c) = cur.take() {
        steps.push(Value::Object(c));
    }
    if !steps.is_empty() {
        root.insert("steps".into(), Value::Array(steps));
    }
    Some(Value::Object(root))
}

fn scan_pack(
    dir: &Path,
    layer: &str,
    state: &AppState,
    project_key: Option<&str>,
) -> Option<SkillPackInfo> {
    let pack = dir.file_name()?.to_string_lossy().to_string();
    let mut skills = Vec::new();
    let mut workflows = Vec::new();
    let mut lint = Vec::new();
    let mut origin_agent = false;
    for f in walk(dir) {
        let name = f.file_name()?.to_string_lossy().to_string();
        let rel = f
            .strip_prefix(dir)
            .ok()?
            .to_string_lossy()
            .replace('\\', "/");
        if name == "SKILL.md" {
            let text = std::fs::read_to_string(&f).ok()?;
            let (fm, sections, l0) = parse_skill(&text);
            if fm.get("origin").and_then(|o| o.as_str()) == Some("agent") {
                origin_agent = true;
            }
            if fm.get("name").is_none() {
                lint.push(format!("{rel}: missing name in front matter"));
            }
            if fm
                .get("description")
                .and_then(|d| d.as_str())
                .map(|d| d.is_empty())
                .unwrap_or(true)
            {
                lint.push(format!("{rel}: missing description"));
            }
            if l0 > 4096 {
                lint.push(format!("{rel}: L0 index exceeds 4 KB"));
            }
            if text.contains("innerHTML") || text.to_lowercase().contains("shell:") {
                lint.push(format!("{rel}: forbidden content"));
            }
            skills.push(SkillFileInfo {
                name: fm
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or(&pack)
                    .to_string(),
                path: rel.clone(),
                front_matter: fm,
                sections,
                l0_chars: l0,
            });
        } else if name == "workflow.yaml" || name.ends_with(".workflow.yaml") {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            for p in lint_workflow(&text) {
                lint.push(format!("{rel}: {p}"));
            }
            workflows.push(rel);
        } else if !rel.starts_with("references/")
            && name != "README.md"
            && !name.ends_with(".md")
            && !name.ends_with(".yaml")
            && !name.ends_with(".json")
            && !name.ends_with(".txt")
        {
            lint.push(format!("{rel}: unexpected file type in pack"));
        }
    }
    if skills.is_empty() {
        return None;
    }
    let sha = pack_sha(dir);
    let trusted = layer == "builtin"
        || state
            .db
            .lock()
            .approval_check(project_key, "pack", &pack, &sha)
            .unwrap_or(false);
    let workflows_trusted = layer == "builtin"
        || (trusted
            && state
                .db
                .lock()
                .approval_check(project_key, "workflows", &pack, &sha)
                .unwrap_or(false));
    Some(SkillPackInfo {
        pack,
        layer: layer.into(),
        path: dir.to_string_lossy().to_string(),
        sha256: sha,
        trusted,
        origin_agent,
        skills,
        workflows,
        lint,
        workflows_trusted,
    })
}

pub fn list(state: &AppState, project_key: Option<&str>) -> Result<Vec<SkillPackInfo>, IpcError> {
    let mut out = Vec::new();
    let mut roots: Vec<(PathBuf, &str)> = vec![
        (builtin_dir(state.handle.get()), "builtin"),
        (user_dir(), "user"),
    ];
    if let Some(pk) = project_key {
        if let Ok(h) = state.project(pk) {
            roots.push((h.root.join(".fluxsmith/skills"), "project"));
        }
    }
    for (root, layer) in roots {
        let Ok(rd) = std::fs::read_dir(&root) else {
            continue;
        };
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for d in dirs {
            if let Some(p) = scan_pack(&d, layer, state, project_key) {
                out.push(p);
            }
        }
    }
    Ok(out)
}

fn find_pack(
    state: &AppState,
    pack: &str,
    project_key: Option<&str>,
) -> Result<SkillPackInfo, IpcError> {
    list(state, project_key)?
        .into_iter()
        .find(|p| p.pack == pack)
        .ok_or_else(|| err("SKILL_PACK_UNTRUSTED", format!("pack {pack} not found")))
}

pub fn read(state: &AppState, pack: &str, rel: &str) -> Result<String, IpcError> {
    let p = find_pack(state, pack, None).or_else(|_| {
        // project packs need any open project
        let keys: Vec<String> = state.projects.read().keys().cloned().collect();
        keys.iter()
            .find_map(|k| find_pack(state, pack, Some(k)).ok())
            .ok_or_else(|| err("SKILL_PACK_UNTRUSTED", format!("pack {pack} not found")))
    })?;
    let base = PathBuf::from(&p.path);
    let f = crate::paths::scoped(&base, rel)?;
    std::fs::read_to_string(&f).map_err(|e| io_err(&f, e))
}

pub fn trust(
    state: &AppState,
    pack: &str,
    sha: &str,
    consent: &str,
    project_key: Option<&str>,
) -> Result<SkillPackInfo, IpcError> {
    let p = find_pack(state, pack, project_key)?;
    if p.sha256 != sha {
        return Err(err(
            "SKILL_PACK_UNTRUSTED",
            "the pack changed since it was reviewed",
        )
        .with_remediation("review it again"));
    }
    if !p.lint.is_empty() {
        return Err(err("SKILL_PACK_LINT_FAILED", "the pack has lint problems")
            .with_evidence(json!(p.lint)));
    }
    let db = state.db.lock();
    if !db.consent_exists(consent)? {
        return Err(err("CONSENT_REQUIRED", "unknown consent event"));
    }
    db.approval_upsert(project_key, "pack", pack, sha, consent, &state.app_version)?;
    drop(db);
    find_pack(state, pack, project_key)
}

/// Second consent, separate from skill trust (agent-runtime.md §9.3): lets the
/// pack's `mode: build` workflows run. Requires the pack to be trusted first and
/// is keyed to the same sha, so any edit revokes it implicitly.
pub fn trust_workflows(
    state: &AppState,
    pack: &str,
    sha: &str,
    consent: &str,
    project_key: Option<&str>,
) -> Result<SkillPackInfo, IpcError> {
    let p = find_pack(state, pack, project_key)?;
    if p.sha256 != sha {
        return Err(err(
            "SKILL_PACK_UNTRUSTED",
            "the pack changed since it was reviewed",
        )
        .with_remediation("review it again"));
    }
    if !p.trusted {
        return Err(err(
            "SKILL_PACK_UNTRUSTED",
            "trust the pack's skills before its workflows",
        ));
    }
    if p.workflows.is_empty() {
        return Err(err("WORKFLOW_NOT_FOUND", "the pack declares no workflow"));
    }
    let db = state.db.lock();
    if !db.consent_exists(consent)? {
        return Err(err("CONSENT_REQUIRED", "unknown consent event"));
    }
    db.approval_upsert(
        project_key,
        "workflows",
        pack,
        sha,
        consent,
        &state.app_version,
    )?;
    drop(db);
    find_pack(state, pack, project_key)
}

/// Revoke the workflow consent only (skill trust stays).
pub fn revoke_workflows(
    state: &AppState,
    pack: &str,
    project_key: Option<&str>,
) -> Result<SkillPackInfo, IpcError> {
    let db = state.db.lock();
    for row in db.approval_list(project_key, Some("workflows"))? {
        if row.get("ref").and_then(|v| v.as_str()) == Some(pack)
            && row.get("revoked_at").map(|v| v.is_null()).unwrap_or(true)
        {
            if let Some(id) = row.get("id").and_then(|v| v.as_i64()) {
                db.approval_revoke(id)?;
            }
        }
    }
    drop(db);
    find_pack(state, pack, project_key)
}

#[allow(clippy::too_many_arguments)]
pub fn write_draft(
    state: &AppState,
    pack: &str,
    name: &str,
    section_text: &str,
    activation: Option<&str>,
    scope: &str,
    project_key: Option<&str>,
    grant: &str,
) -> Result<SkillPackInfo, IpcError> {
    let pk = project_key.unwrap_or("");
    state
        .sessions
        .lock()
        .consume_grant(grant, pk, "skill_draft", None)?;
    if pack.is_empty()
        || pack.contains(['/', '\\', '.'])
        || name.is_empty()
        || name.contains(['/', '\\'])
    {
        return Err(err("BAD_CONFIG", "invalid pack or skill name"));
    }
    if crate::sidecar::looks_like_instruction(section_text) {
        return Err(err(
            "SKILL_PACK_LINT_FAILED",
            "skill text may not start with an instruction to the model about its own rules",
        ));
    }
    let base = match scope {
        "project" => state.project(pk)?.root.join(".fluxsmith/skills"),
        _ => user_dir(),
    };
    let dir = base.join(pack);
    ensure_dir(&dir)?;
    let p = dir.join("SKILL.md");
    let text = match std::fs::read_to_string(&p) {
        Ok(existing) => format!("{}\n\n## {} {{#{}}}\n{}\n", existing.trim_end(), name, slug(name), section_text.trim()),
        Err(_) => format!("---\nname: {pack}\ndescription: >-\n  {}\norigin: agent\nactivation: {}\n---\n\n# {pack}\n\n## {} {{#{}}}\n{}\n", name, activation.unwrap_or("manual"), name, slug(name), section_text.trim()),
    };
    write_atomic(&p, text.as_bytes())?;
    // A draft is never trusted until reviewed: nothing written to approvals.
    find_pack(state, pack, project_key)
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

pub fn import_zip(
    state: &AppState,
    path: &str,
    scope: &str,
    project_key: Option<&str>,
) -> Result<SkillPackInfo, IpcError> {
    let bytes = std::fs::read(path).map_err(|e| io_err(Path::new(path), e))?;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(&bytes))
        .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
    if z.len() > 200 {
        return Err(err("ATTACH_TOO_LARGE", "pack zip has too many entries"));
    }
    let base = match scope {
        "project" => state
            .project(project_key.unwrap_or(""))?
            .root
            .join(".fluxsmith/skills"),
        _ => user_dir(),
    };
    let mut pack_name: Option<String> = None;
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for i in 0..z.len() {
        let mut f = z
            .by_index(i)
            .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
        let name = f.name().to_string();
        if name.contains("..") || name.starts_with('/') {
            return Err(err("PATH_OUT_OF_SCOPE", name));
        }
        if f.is_dir() {
            continue;
        }
        let first = name.split('/').next().unwrap_or("").to_string();
        if first.is_empty() {
            return Err(err(
                "SKILL_PACK_LINT_FAILED",
                "zip must contain a single top-level pack folder",
            ));
        }
        match &pack_name {
            None => pack_name = Some(first),
            Some(p) if *p != first => {
                return Err(err(
                    "SKILL_PACK_LINT_FAILED",
                    "zip must contain a single top-level pack folder",
                ))
            }
            _ => {}
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| err("ATTACH_TYPE_REJECTED", e.to_string()))?;
        if buf.len() > 2 * 1024 * 1024 {
            return Err(err("ATTACH_TOO_LARGE", format!("{name} exceeds 2 MB")));
        }
        entries.push((name, buf));
    }
    let pack = pack_name.ok_or_else(|| err("SKILL_PACK_LINT_FAILED", "empty zip"))?;
    let dir = base.join(&pack);
    if dir.exists() {
        return Err(err(
            "LIB_NICKNAME_CONFLICT",
            format!("pack {pack} already exists"),
        ));
    }
    for (name, buf) in entries {
        let p = base.join(&name);
        ensure_dir(p.parent().unwrap())?;
        write_atomic(&p, &buf)?;
    }
    find_pack(state, &pack, project_key)
}

pub fn export_zip(state: &AppState, pack: &str, out: &str) -> Result<(), IpcError> {
    let p = read_pack_any(state, pack)?;
    let base = PathBuf::from(&p.path);
    let file = std::fs::File::create(out).map_err(|e| io_err(Path::new(out), e))?;
    let mut z = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for f in walk(&base) {
        let rel = format!(
            "{}/{}",
            pack,
            f.strip_prefix(&base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        );
        z.start_file(rel, opts)
            .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
        z.write_all(&std::fs::read(&f).map_err(|e| io_err(&f, e))?)
            .map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    }
    z.finish().map_err(|e| err("FS_TRANSIENT", e.to_string()))?;
    Ok(())
}

fn read_pack_any(state: &AppState, pack: &str) -> Result<SkillPackInfo, IpcError> {
    if let Ok(p) = find_pack(state, pack, None) {
        return Ok(p);
    }
    let keys: Vec<String> = state.projects.read().keys().cloned().collect();
    keys.iter()
        .find_map(|k| find_pack(state, pack, Some(k)).ok())
        .ok_or_else(|| err("SKILL_PACK_UNTRUSTED", format!("pack {pack} not found")))
}

/// Editor preview: front matter, section ids, L0 size and the L0 text the model sees, plus the
/// same lint the loader applies (no file is written).
pub fn preview(text: &str) -> crate::ipc::SkillPreview {
    let (fm, sections, l0) = parse_skill(text);
    let mut lint = Vec::new();
    let name = fm.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let desc = fm.get("description").and_then(|v| v.as_str()).unwrap_or("");
    if name.is_empty() {
        lint.push("missing name in front matter".into());
    }
    if desc.is_empty() {
        lint.push("missing description".into());
    }
    if l0 > 4096 {
        lint.push("L0 index exceeds 4 KB".into());
    }
    if crate::sidecar::looks_like_instruction(text) {
        lint.push(
            "forbidden content: skill text may not instruct the model about its own rules".into(),
        );
    }
    let l0_text = if sections.is_empty() {
        format!("{name}: {desc}")
    } else {
        format!(
            "{name}: {desc}\n  sections: {}",
            sections
                .iter()
                .map(|s| format!("#{s}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    crate::ipc::SkillPreview {
        front_matter: fm,
        sections,
        l0_chars: l0,
        l0_text,
        lint,
    }
}

/// Save a file of a user/project pack from the editor. Only `SKILL.md` and `references/*.md`
/// are writable; builtin packs are read-only. The pack's sha changes, so it drops to untrusted
/// until the human reviews it again (trust is a separate consent).
pub fn write_file(
    state: &AppState,
    pack: &str,
    rel: &str,
    text: &str,
    scope: &str,
    project_key: Option<&str>,
) -> Result<SkillPackInfo, IpcError> {
    if pack.is_empty() || pack.contains(['/', '\\', '.']) {
        return Err(err("BAD_CONFIG", "invalid pack name"));
    }
    let ok_path = rel == "SKILL.md"
        || (rel.starts_with("references/") && rel.ends_with(".md") && !rel.contains(".."));
    if !ok_path {
        return Err(err(
            "PATH_OUT_OF_SCOPE",
            "only SKILL.md and references/*.md are editable",
        ));
    }
    if rel == "SKILL.md" {
        let p = preview(text);
        if p.lint
            .iter()
            .any(|l| l.starts_with("forbidden") || l.starts_with("missing"))
        {
            return Err(err("SKILL_PACK_LINT_FAILED", "the skill has lint problems")
                .with_evidence(json!(p.lint)));
        }
    }
    let base = match scope {
        "project" => state
            .project(project_key.unwrap_or(""))?
            .root
            .join(".fluxsmith/skills"),
        _ => user_dir(),
    };
    let dir = base.join(pack);
    ensure_dir(&dir)?;
    if let Some(parent) = Path::new(rel).parent() {
        ensure_dir(&dir.join(parent))?;
    }
    write_atomic(&dir.join(rel), text.as_bytes())?;
    find_pack(state, pack, project_key)
}

/// Replay the pack's `tests/` golden cases through the engine (docs/skill-packs.md).
pub fn test(
    state: &AppState,
    pack: &str,
    project_key: Option<&str>,
) -> Result<crate::ipc::SkillTestReport, IpcError> {
    let info = find_pack(state, pack, project_key)?;
    let (_, rows) = state.lib_env();
    crate::skilltest::run(pack, Path::new(&info.path), rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repo_skills() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills");
        let mut n = 0;
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path().join("SKILL.md");
            if !p.exists() {
                continue;
            }
            let (fm, sections, l0) = parse_skill(&std::fs::read_to_string(&p).unwrap());
            assert!(fm.get("name").is_some(), "{}", p.display());
            assert!(!sections.is_empty(), "{}", p.display());
            assert!(l0 <= 4096);
            n += 1;
        }
        assert!(n >= 5);
    }

    #[test]
    fn workflow_lint_rules() {
        let bad = "name: x\nmode: plan\nsteps:\n  - kind: agent\n    tools: [sch.apply]\n  - kind: structural\n  - kind: gate\n    verdict: model.says\n";
        let p = lint_workflow(bad);
        assert!(p.iter().any(|x| x.contains("agent steps")));
        assert!(p.iter().any(|x| x.contains("structural")));
        assert!(p.iter().any(|x| x.contains("gate verdict")));
        assert!(p.iter().any(|x| x.contains("mode: build")));
        assert!(p.iter().any(|x| x.contains("limits")));
        let good = "name: y\nmode: build\nlimits:\n  components_added: 10\nsteps:\n  - kind: approval\n  - kind: structural\n  - kind: gate\n    verdict: engine.gate_run.ok\n";
        assert!(lint_workflow(good).is_empty(), "{:?}", lint_workflow(good));
    }
}
