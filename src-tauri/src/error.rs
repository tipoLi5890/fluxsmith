// SPDX-License-Identifier: Apache-2.0
//! Error helpers: every command returns `IpcError` (docs/error-codes.md).

use crate::ipc::IpcError;
use std::sync::atomic::{AtomicU64, Ordering};

static REQ_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Short request id for log correlation (`r-<hex>`), never random per call
/// so it stays deterministic within a process lifetime.
pub fn req_id() -> String {
    format!("r-{:x}", REQ_COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub fn err(code: &str, msg: impl Into<String>) -> IpcError {
    let mut e = IpcError::new(code, msg);
    e.req_id = req_id();
    e
}

/// Evidence key carrying which `std::io::ErrorKind` produced a `FILE_UNREADABLE`.
/// One user-facing code covers both a file that is not there and a file that is
/// there but cannot be opened, and the two want opposite remediation, so the kind
/// travels as a machine-readable field instead of being sniffed back out of the
/// message (`localize` used to key on the `.kicad_sch` suffix alone and told the
/// author of a locked-down sheet to run the scaffold step, which recreates
/// nothing and fails again on the next read).
const IO_KIND: &str = "io_kind";
pub const IO_NOT_FOUND: &str = "not_found";
pub const IO_PERMISSION_DENIED: &str = "permission_denied";

/// The `io_kind` tag of an error, when it carries one.
fn io_kind(e: &IpcError) -> Option<&str> {
    e.evidence.as_ref()?.get(IO_KIND)?.as_str()
}

pub fn io_err(path: &std::path::Path, e: std::io::Error) -> IpcError {
    // `<abs path>: No such file or directory (os error 2)` told the model an errno and a host
    // path and nothing it could act on. Say what is wrong in words; `localize` below turns the
    // path project-relative and adds the sheet-specific remediation when a project is in hand.
    match e.kind() {
        std::io::ErrorKind::NotFound => err(
            "FILE_UNREADABLE",
            format!("{} does not exist", path.display()),
        )
        .with_remediation("create the file before reading it, or address one that exists")
        .with_evidence(serde_json::json!({ IO_KIND: IO_NOT_FOUND })),
        std::io::ErrorKind::PermissionDenied => err(
            "FILE_UNREADABLE",
            format!("{} cannot be read (permission denied)", path.display()),
        )
        .with_remediation("check the file permissions, then retry")
        .with_evidence(serde_json::json!({ IO_KIND: IO_PERMISSION_DENIED })),
        _ => err("FS_TRANSIENT", format!("{}: {e}", path.display())),
    }
}

/// Make an error safe and useful to hand to a model: strip the host-absolute project root from
/// every path in the message, and, for a missing `.kicad_sch`, say what creates it and which
/// sheets the project has right now. Applied once at the engine boundary, where the root is known.
pub fn localize(mut e: IpcError, root: &std::path::Path) -> IpcError {
    let mut prefixes: Vec<String> = Vec::new();
    for p in [root.to_path_buf(), root.canonicalize().unwrap_or_default()] {
        let s = p.to_string_lossy().to_string();
        if !s.is_empty() {
            prefixes.push(format!("{s}/"));
            prefixes.push(format!("{s}\\"));
            prefixes.push(s);
        }
    }
    prefixes.sort_by_key(|b| std::cmp::Reverse(b.len()));
    prefixes.dedup();
    // Paths *outside* the root reach here too -- `sch-write`'s `Refused` names the target and the
    // hierarchy root, `scoped()` names a parent that is out of scope -- and those cannot be made
    // project-relative. The home directory is the part of them that identifies the machine and its
    // user, so it becomes `~`.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| h.to_string_lossy().to_string())
        .filter(|h| h.len() > 1);
    let scrub = |s: &str| -> String {
        let mut out = s.to_string();
        for p in &prefixes {
            if out.contains(p.as_str()) {
                out = out.replace(p.as_str(), "");
            }
        }
        if let Some(h) = &home {
            if out.contains(h.as_str()) {
                out = out.replace(h.as_str(), "~");
            }
        }
        out
    };
    e.message = scrub(&e.message);
    // Remediation and evidence carry paths just as often as the message does (a
    // `PATH_OUT_OF_SCOPE` says which file, `FILE_UNREADABLE` lists candidates), and they go to the
    // model and into the transcript through the same channel.
    if let Some(r) = e.remediation.take() {
        e.remediation = Some(scrub(&r));
    }
    if let Some(ev) = e.evidence.take() {
        e.evidence = Some(scrub_value(ev, &scrub));
    }
    // Only a sheet that is *not there* is the scaffold step's business: a sheet
    // that exists but cannot be opened keeps `io_err`'s own remediation.
    if e.code == "FILE_UNREADABLE"
        && e.message.contains(".kicad_sch")
        && io_kind(&e) != Some(IO_PERMISSION_DENIED)
    {
        e.remediation = Some(
            "that sheet file does not exist yet: a sheet named in the plan is only created by the scaffold step (`add_sheet` with `create: true`) -- run it before reading, planning or writing that sheet"
                .into(),
        );
        let sheets = sheet_files(root);
        if !sheets.is_empty() {
            match e.evidence {
                Some(serde_json::Value::Object(ref mut obj)) => {
                    obj.entry("sheets_present")
                        .or_insert_with(|| serde_json::json!(sheets));
                }
                // Evidence the caller already built for another purpose stays as it is.
                Some(_) => {}
                None => e.evidence = Some(serde_json::json!({ "sheets_present": sheets })),
            }
        }
    }
    e
}

/// Apply a string rewrite to every string leaf of an evidence value (object keys are field names we
/// author, never paths).
fn scrub_value(v: serde_json::Value, f: &impl Fn(&str) -> String) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::String(s) => Value::String(f(&s)),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| scrub_value(x, f)).collect()),
        Value::Object(o) => {
            Value::Object(o.into_iter().map(|(k, x)| (k, scrub_value(x, f))).collect())
        }
        other => other,
    }
}

/// Schematic files directly under the project root, for the candidate list of a missing sheet.
fn sheet_files(root: &std::path::Path) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter_map(|d| {
            let n = d.file_name().to_string_lossy().to_string();
            n.ends_with(".kicad_sch").then_some(n)
        })
        .collect();
    out.sort();
    out.truncate(50);
    out
}

impl From<sch_read::ReadError> for IpcError {
    fn from(e: sch_read::ReadError) -> Self {
        use sch_read::ReadError as R;
        // An io error keeps the kind (and so the right remediation): the reader
        // hits exactly the same missing / unreadable split as `io_err`.
        if let R::Io { path, source } = e {
            return io_err(&path, source);
        }
        let code = match &e {
            R::Io { .. } => "FILE_UNREADABLE",
            R::Parse { .. } => "SEXPR_PARSE",
            R::NotSchematic { .. } | R::NotSymbolLib { .. } => "VERSION_UNSUPPORTED",
            R::UnsupportedVersion { .. } => "VERSION_UNSUPPORTED",
            R::SheetFileMissing { .. } => "SHEET_FILE_MISSING",
            R::SheetRecursion { .. } => "PROJECT_ROOT_AMBIGUOUS",
        };
        err(code, e.to_string())
    }
}

impl From<sch_write::WriteError> for IpcError {
    fn from(e: sch_write::WriteError) -> Self {
        use sch_write::WriteError as W;
        match e {
            W::Read(r) => r.into(),
            W::OpList(errs) => err("OPLIST_SCHEMA", "op-list invalid")
                .with_evidence(serde_json::to_value(errs).unwrap_or_default()),
            W::Apply(a) => err("OPLIST_CONSTRAINT", a.to_string()),
            W::Atomic(a) => {
                let s = a.to_string();
                let code = if s.contains("lock") || s.contains(".lck") {
                    "TARGET_LOCKED"
                } else if s.contains("sha") || s.contains("changed") {
                    "VERIFY_FAILED"
                } else {
                    "FS_TRANSIENT"
                };
                err(code, s)
            }
            W::Refused(s) => err("PATH_OUT_OF_SCOPE", s),
            W::Io { path, source } => io_err(&path, source),
        }
    }
}

impl From<rusqlite::Error> for IpcError {
    fn from(e: rusqlite::Error) -> Self {
        err("DB_ERROR", e.to_string())
    }
}

impl From<serde_json::Error> for IpcError {
    fn from(e: serde_json::Error) -> Self {
        err("BAD_CONFIG", e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P2-5: `localize` only scrubbed `message`, so the same host paths went out untouched in
    /// `remediation` and in every string leaf of `evidence` -- and a path outside the root (a
    /// `sch-write` `Refused`, a parent that is out of scope) has no project-relative form at all,
    /// so the home directory in it becomes `~`.
    #[test]
    fn remediation_and_evidence_are_scrubbed_too() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_string_lossy().to_string();
        let raw = err(
            "PATH_OUT_OF_SCOPE",
            format!("{root}/power.kicad_sch is outside"),
        )
        .with_remediation(format!("write to {root}/root.kicad_sch instead"))
        .with_evidence(serde_json::json!({
            "target": format!("{root}/sub/analog.kicad_sch"),
            "candidates": [format!("{root}/a.kicad_sch")],
            "nested": { "root": root.clone() },
            "count": 2,
        }));
        let e = localize(raw, d.path());
        assert!(!e.message.contains(&root), "{}", e.message);
        let rem = e.remediation.clone().unwrap();
        assert!(!rem.contains(&root), "{rem}");
        let ev = serde_json::to_string(&e.evidence).unwrap();
        assert!(!ev.contains(&root), "{ev}");
        assert!(ev.contains("sub/analog.kicad_sch"), "{ev}");
        assert!(ev.contains("\"count\":2"), "{ev}");
    }

    #[test]
    fn a_path_outside_the_root_loses_the_home_directory() {
        let Some(home) = std::env::var_os("HOME").map(|h| h.to_string_lossy().to_string()) else {
            return;
        };
        let d = tempfile::tempdir().unwrap();
        let outside = format!("{home}/Documents/other/root.kicad_sch");
        let e = localize(
            err(
                "PATH_OUT_OF_SCOPE",
                format!("target {outside} is not part of the hierarchy"),
            ),
            d.path(),
        );
        assert!(!e.message.contains(&home), "{}", e.message);
        assert!(
            e.message.contains("~/Documents/other/root.kicad_sch"),
            "{}",
            e.message
        );
    }

    // F13: `FILE_UNREADABLE: <abs host path>: No such file or directory (os error 2)` leaked the
    // machine's directory layout and told the model nothing it could do about it.
    #[test]
    fn missing_sheet_is_project_relative_and_says_what_creates_it() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("root.kicad_sch"), "(kicad_sch)").unwrap();
        let missing = d.path().join("sensor_board.kicad_sch");
        let raw = io_err(
            &missing,
            std::io::Error::new(std::io::ErrorKind::NotFound, "No such file or directory"),
        );
        assert_eq!(raw.code, "FILE_UNREADABLE");
        assert!(!raw.message.contains("os error"), "{}", raw.message);

        let e = localize(raw, d.path());
        assert_eq!(e.message, "sensor_board.kicad_sch does not exist");
        assert!(
            !e.message.contains(d.path().to_string_lossy().as_ref()),
            "{}",
            e.message
        );
        let rem = e.remediation.unwrap_or_default();
        assert!(rem.contains("add_sheet") && rem.contains("create"), "{rem}");
        let ev = e.evidence.expect("the sheets that do exist");
        assert_eq!(ev["sheets_present"][0], "root.kicad_sch");
    }

    // P2-7: `localize` keyed on the code plus a `.kicad_sch` in the message, and `io_err`
    // hands the same code to a permission error, so "check the file permissions" was
    // overwritten with "run the scaffold step" - advice that recreates nothing and sends the
    // model round the create loop on a file that is there.
    #[test]
    fn an_unreadable_sheet_keeps_the_permission_remediation() {
        let d = tempfile::tempdir().unwrap();
        let locked = d.path().join("root.kicad_sch");
        std::fs::write(&locked, "(kicad_sch)").unwrap();
        let raw = io_err(
            &locked,
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Permission denied"),
        );
        assert_eq!(raw.code, "FILE_UNREADABLE");
        assert_eq!(io_kind(&raw), Some(IO_PERMISSION_DENIED));

        let e = localize(raw, d.path());
        assert_eq!(
            e.message,
            "root.kicad_sch cannot be read (permission denied)"
        );
        let rem = e.remediation.unwrap_or_default();
        assert!(rem.contains("permissions"), "{rem}");
        assert!(!rem.contains("add_sheet"), "{rem}");
    }

    #[test]
    fn a_missing_sheet_is_tagged_not_found_and_keeps_both_evidence_fields() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("root.kicad_sch"), "(kicad_sch)").unwrap();
        let raw = io_err(
            &d.path().join("child.kicad_sch"),
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );
        assert_eq!(io_kind(&raw), Some(IO_NOT_FOUND));
        let e = localize(raw, d.path());
        let ev = e.evidence.expect("evidence");
        assert_eq!(ev["io_kind"], IO_NOT_FOUND);
        assert_eq!(ev["sheets_present"][0], "root.kicad_sch");
        assert!(e.remediation.unwrap_or_default().contains("add_sheet"));
    }

    // A read error carries the same split, so the reader's own io failures land on the same
    // two remediations instead of `io {path}: {errno}`.
    #[test]
    fn a_read_error_keeps_the_io_kind() {
        for (kind, tag) in [
            (std::io::ErrorKind::NotFound, IO_NOT_FOUND),
            (std::io::ErrorKind::PermissionDenied, IO_PERMISSION_DENIED),
        ] {
            let e: IpcError = sch_read::ReadError::Io {
                path: std::path::PathBuf::from("/p/child.kicad_sch"),
                source: std::io::Error::from(kind),
            }
            .into();
            assert_eq!(e.code, "FILE_UNREADABLE");
            assert_eq!(io_kind(&e), Some(tag));
            assert!(!e.message.contains("os error"), "{}", e.message);
        }
    }

    #[test]
    fn localize_leaves_a_non_project_error_alone() {
        let d = tempfile::tempdir().unwrap();
        let e = localize(err("OP_UNKNOWN", "`add_symbol` is not an op"), d.path());
        assert_eq!(e.message, "`add_symbol` is not an op");
        assert!(e.remediation.is_none());
    }
}
