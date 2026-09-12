// SPDX-License-Identifier: Apache-2.0
//! App-data layout and project-scope path checks (red line 14).

use crate::error::err;
use crate::ipc::IpcError;
use std::path::{Path, PathBuf};

/// `<app data>/fluxsmith` (macOS: ~/Library/Application Support/fluxsmith;
/// Windows: %APPDATA%\fluxsmith). Overridable with `FLUXSMITH_APP_DATA` for tests.
pub fn app_data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("FLUXSMITH_APP_DATA") {
        return long_path(&PathBuf::from(p));
    }
    long_path(
        &dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("fluxsmith"),
    )
}

/// Windows long-path form (`docs/platform-notes.md` §1.1): absolute paths get the `\\?\`
/// verbatim prefix so Win32 calls are not bound by MAX_PATH. UNC paths become `\\?\UNC\…`.
/// Already-verbatim and relative paths are returned unchanged; on other platforms it is identity.
pub fn long_path(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if s.starts_with("\\\\?\\") || !p.is_absolute() {
            return p.to_path_buf();
        }
        if let Some(rest) = s.strip_prefix("\\\\") {
            return PathBuf::from(format!("\\\\?\\UNC\\{rest}"));
        }
        return PathBuf::from(format!("\\\\?\\{s}"));
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

pub fn ensure_dir(p: &Path) -> Result<(), IpcError> {
    std::fs::create_dir_all(p).map_err(|e| crate::error::io_err(p, e))
}

/// Resolve `rel` (project-relative or absolute) and require it to stay under
/// `root`. Non-existent files are allowed (creation) as long as the parent
/// exists and is in scope. Symlinks are resolved and must not escape.
pub fn scoped(root: &Path, rel: &str) -> Result<PathBuf, IpcError> {
    if rel.is_empty() {
        return Err(err("PATH_OUT_OF_SCOPE", "empty path"));
    }
    let p = Path::new(rel);
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    };
    let root_c = root
        .canonicalize()
        .map_err(|e| crate::error::io_err(root, e))?;
    let canon = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| crate::error::io_err(&joined, e))?
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| err("PATH_OUT_OF_SCOPE", rel))?;
        let name = joined
            .file_name()
            .ok_or_else(|| err("PATH_OUT_OF_SCOPE", rel))?;
        if name.to_string_lossy().contains("..") {
            return Err(err("PATH_OUT_OF_SCOPE", rel));
        }
        // Named by the caller's own relative string, never by the resolved absolute parent: that
        // parent is by definition allowed to be outside the root, so its path is exactly the host
        // layout `localize` cannot make project-relative.
        parent
            .canonicalize()
            .map_err(|_| {
                err(
                    "PATH_OUT_OF_SCOPE",
                    format!("the directory {rel} would go in does not exist"),
                )
                .with_remediation(
                    "create the directory first, or address a path under the project root",
                )
            })?
            .join(name)
    };
    if !canon.starts_with(&root_c) {
        return Err(
            err("PATH_OUT_OF_SCOPE", format!("{rel} is outside the project"))
                .with_remediation("only files under the project root can be addressed"),
        );
    }
    Ok(canon)
}

pub fn rel_to(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn sha256_hex(b: &[u8]) -> String {
    sch_write::atomic::sha256_hex(b)
}

/// Atomic write for app-data files (settings, pointers): temp + rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), IpcError> {
    let parent = path.parent().unwrap_or(Path::new("."));
    ensure_dir(parent)?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| crate::error::io_err(&tmp, e))?;
    if let Ok(f) = std::fs::File::open(&tmp) {
        let _ = f.sync_all();
    }
    std::fs::rename(&tmp, path).map_err(|e| crate::error::io_err(path, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_rejects_escape_and_accepts_inside() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.kicad_sch"), "x").unwrap();
        assert!(scoped(d.path(), "a.kicad_sch").is_ok());
        assert!(scoped(d.path(), "new.kicad_sch").is_ok());
        assert!(scoped(d.path(), "../x").is_err());
        assert!(scoped(d.path(), "/etc/passwd").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", d.path().join("link")).unwrap();
            assert!(scoped(d.path(), "link/passwd").is_err());
        }
    }

    /// P2-5: a path whose parent does not exist used to be reported through `io_err(parent, ..)`,
    /// which names the resolved host-absolute parent -- a path that is by definition allowed to be
    /// outside the root, so `localize` cannot make it project-relative. The refusal names the
    /// caller's own relative string instead.
    #[test]
    fn a_missing_parent_is_named_by_the_relative_path() {
        let d = tempfile::tempdir().unwrap();
        let e = scoped(d.path(), "nope/deeper/new.kicad_sch").unwrap_err();
        assert_eq!(e.code, "PATH_OUT_OF_SCOPE");
        assert!(
            e.message.contains("nope/deeper/new.kicad_sch"),
            "{}",
            e.message
        );
        assert!(
            !e.message.contains(d.path().to_string_lossy().as_ref()),
            "{}",
            e.message
        );
    }
}
