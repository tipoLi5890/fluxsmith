// SPDX-License-Identifier: Apache-2.0
//! File log in app data `logs/` with secret masking at the write point.

use crate::paths::{app_data_dir, ensure_dir, now_iso};
use parking_lot::Mutex;
use std::io::Write;
use std::sync::OnceLock;

static LOG: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();
static LEVEL: Mutex<u8> = Mutex::new(1);

fn file() -> &'static Mutex<Option<std::fs::File>> {
    LOG.get_or_init(|| {
        let dir = app_data_dir().join("logs");
        let _ = ensure_dir(&dir);
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("fluxsmith.log"))
            .ok();
        Mutex::new(f)
    })
}

pub fn set_level(level: &str) {
    *LEVEL.lock() = if level == "debug" { 0 } else { 1 };
}

/// Mask anything that looks like an API key / bearer token / OAuth token.
pub fn mask(s: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"(?i)(sk-[a-z0-9_\-]{8,}|sk-ant-[a-z0-9_\-]{8,}|bearer\s+[a-z0-9._\-]{8,}|x-api-key[\"':\s=]+[a-z0-9._\-]{8,}|eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{5,}|AIza[0-9A-Za-z_\-]{20,}|(?:refresh_token|access_token|api_key|apikey|key|token|secret)=[a-z0-9._\-]{8,})"#).unwrap());
    re.replace_all(s, "[masked]").into_owned()
}

pub fn write(level: &str, message: &str, req_id: &str) {
    let lvl = match level {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        _ => 3,
    };
    if lvl < *LEVEL.lock() {
        return;
    }
    let line = format!("{} {} {} {}\n", now_iso(), level, req_id, mask(message));
    if let Some(f) = file().lock().as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
    let _ = std::io::stderr().write_all(line.as_bytes());
}

pub fn info(msg: &str) {
    write("info", msg, "-");
}
pub fn warn(msg: &str) {
    write("warn", msg, "-");
}

pub fn log_path() -> std::path::PathBuf {
    app_data_dir().join("logs").join("fluxsmith.log")
}

#[cfg(test)]
mod tests {
    #[test]
    fn masks_secrets() {
        let m = super::mask("key sk-ant-abcdefghijklmnop and Bearer abcdefghijklmnop");
        assert!(!m.contains("abcdefghijklmnop"), "{m}");
    }
}

/// Crash record `logs/crashes/<ts>-<req_id>.json` (crash-recovery.md §5). Returns the path.
pub fn write_crash(
    req_id: &str,
    kind: &str,
    message: &str,
    extra: serde_json::Value,
) -> Option<std::path::PathBuf> {
    let dir = app_data_dir().join("logs").join("crashes");
    ensure_dir(&dir).ok()?;
    let ts = now_iso().replace([':', '.'], "-");
    let p = dir.join(format!("{ts}-{req_id}.json"));
    let v = serde_json::json!({"ts": now_iso(), "req_id": req_id, "kind": kind, "message": mask(message), "extra": extra});
    std::fs::write(&p, serde_json::to_string_pretty(&v).ok()?).ok()?;
    Some(p)
}

// ---------------------------------------------------------------------------
// Structured JSONL events (docs/logging.md §1, §3): `logs/app-<YYYY-MM-DD>.jsonl`,
// first line `app.start` with the four-face fingerprint, rotate at 20 MB into
// `app-<date>.<n>.jsonl`, keep the newest 10 files or 14 days (whichever first).
// ---------------------------------------------------------------------------

pub const ROTATE_BYTES: u64 = 20 * 1024 * 1024;
pub const KEEP_FILES: usize = 10;
pub const KEEP_DAYS: i64 = 14;

/// Events the app emits (the catalogue in docs/logging.md §3). Unknown names are still written
/// but flagged so a typo does not silently create a new event.
pub const EVENT_CATALOGUE: &[&str] = &[
    "app.start",
    "app.exit",
    "project.open",
    "project.close",
    "turn.start",
    "turn.end",
    "step.start",
    "step.end",
    "tool.call",
    "tool.result",
    "hook.decision",
    "apply",
    "checkpoint",
    "rollback",
    "consent",
    "grant",
    "compaction",
    "model.call",
    "net.fetch",
    "engine.panic",
    "watch.external",
    "recovery.scan",
    "intake",
    "skill.load",
    "update.check",
];

struct Jsonl {
    day: String,
    file: Option<std::fs::File>,
    bytes: u64,
}

static JSONL: Mutex<Option<Jsonl>> = Mutex::new(None);
static HEADER: OnceLock<serde_json::Value> = OnceLock::new();

/// Registered once at startup; written as the first line of every JSONL file.
pub fn set_header(fingerprint: serde_json::Value) {
    let _ = HEADER.set(fingerprint);
}

fn today() -> String {
    now_iso()[..10].to_string()
}

fn open_jsonl(dir: &std::path::Path, day: &str) -> Option<(std::fs::File, u64)> {
    let _ = ensure_dir(dir);
    let p = dir.join(format!("app-{day}.jsonl"));
    let fresh = !p.exists();
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .ok()?;
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut f = f;
    if fresh || len == 0 {
        let hdr = serde_json::json!({"ts": now_iso(), "event": "app.start", "level": "info", "fields": HEADER.get().cloned().unwrap_or(serde_json::Value::Null)});
        let _ = writeln!(f, "{}", hdr);
    }
    Some((f, len))
}

/// Rotate the current day file into `app-<day>.<n>.jsonl` (n = next free) and prune old files.
fn rotate(dir: &std::path::Path, day: &str) {
    let cur = dir.join(format!("app-{day}.jsonl"));
    let mut n = 1;
    while dir.join(format!("app-{day}.{n}.jsonl")).exists() {
        n += 1;
    }
    let _ = std::fs::rename(&cur, dir.join(format!("app-{day}.{n}.jsonl")));
    prune(dir);
}

/// Keep the newest `KEEP_FILES` JSONL files and drop anything older than `KEEP_DAYS`.
pub fn prune(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("app-") && n.ends_with(".jsonl"))
                .unwrap_or(false)
        })
        .filter_map(|p| p.metadata().and_then(|m| m.modified()).ok().map(|t| (p, t)))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(KEEP_DAYS as u64 * 86_400);
    for (i, (p, t)) in files.iter().enumerate() {
        if i >= KEEP_FILES || *t < cutoff {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Write one structured event. Values are masked at the write point; `fields` should already
/// follow the catalogue (no URL paths, headers, bodies, or file contents).
pub fn event(level: &str, name: &str, fields: serde_json::Value, req_id: Option<&str>) {
    let lvl = match level {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        _ => 3,
    };
    if lvl < *LEVEL.lock() {
        return;
    }
    let known = EVENT_CATALOGUE.contains(&name);
    let line = serde_json::json!({
        "ts": now_iso(), "event": name, "level": level, "req_id": req_id,
        "fields": mask_value(fields), "uncatalogued": if known { serde_json::Value::Null } else { serde_json::Value::Bool(true) },
    });
    let text = line.to_string();
    let dir = app_data_dir().join("logs");
    let day = today();
    let mut g = JSONL.lock();
    let need_open = match g.as_ref() {
        Some(j) => j.day != day || j.file.is_none(),
        None => true,
    };
    if need_open {
        let (file, bytes) = open_jsonl(&dir, &day)
            .map(|(f, b)| (Some(f), b))
            .unwrap_or((None, 0));
        *g = Some(Jsonl {
            day: day.clone(),
            file,
            bytes,
        });
    }
    if let Some(j) = g.as_mut() {
        if j.bytes + text.len() as u64 + 1 > ROTATE_BYTES {
            j.file = None;
            rotate(&dir, &day);
            let (file, bytes) = open_jsonl(&dir, &day)
                .map(|(f, b)| (Some(f), b))
                .unwrap_or((None, 0));
            j.file = file;
            j.bytes = bytes;
        }
        if let Some(f) = j.file.as_mut() {
            if writeln!(f, "{text}").is_ok() {
                j.bytes += text.len() as u64 + 1;
            }
        }
    }
}

fn mask_value(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(mask(&s)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.into_iter().map(mask_value).collect())
        }
        serde_json::Value::Object(o) => {
            serde_json::Value::Object(o.into_iter().map(|(k, v)| (k, mask_value(v))).collect())
        }
        other => other,
    }
}

pub fn jsonl_dir() -> std::path::PathBuf {
    app_data_dir().join("logs")
}

#[cfg(test)]
mod jsonl_tests {
    use super::*;

    /// NFR-15 leak regression: every corpus line's secret must be masked; benign lines untouched.
    #[test]
    fn leak_corpus_is_masked() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/logging/leak-corpus.jsonl");
        let text = std::fs::read_to_string(&p).expect("corpus");
        let mut n = 0;
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let input = v["input"].as_str().unwrap();
            let bad = v["must_not_contain"].as_str().unwrap();
            let out = mask(input);
            assert!(!out.contains(bad), "{}: {out}", v["id"]);
            n += 1;
        }
        assert!(n >= 10);
    }

    #[test]
    fn rotation_and_prune_keep_bounds() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..14 {
            std::fs::write(
                d.path().join(format!("app-2026-01-{:02}.jsonl", i + 1)),
                "x",
            )
            .unwrap();
        }
        prune(d.path());
        let left = std::fs::read_dir(d.path()).unwrap().count();
        assert_eq!(left, KEEP_FILES);
        rotate(d.path(), "2026-01-14");
        assert!(d.path().join("app-2026-01-14.1.jsonl").exists());
    }

    #[test]
    fn events_are_masked_and_catalogued() {
        let v = mask_value(
            serde_json::json!({"a": "Bearer abcdefghijklmnop", "b": ["sk-ant-abcdefghijklmnop"], "c": 1}),
        );
        assert_eq!(v["a"], "[masked]");
        assert_eq!(v["b"][0], "[masked]");
        assert!(EVENT_CATALOGUE.contains(&"model.call"));
    }
}
