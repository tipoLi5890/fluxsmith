// SPDX-License-Identifier: Apache-2.0
//! Whole-tree checkpoints (bytes + manifest) and verified restore.
//! Storage location is the caller's (app data); the project only ever gets a
//! reference to the checkpoint id.

use crate::atomic::{sha256_hex, Txn};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub project_root_sha256: String,
    pub files: Vec<ManifestEntry>,
}

#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("CHECKPOINT_TAMPERED: {0}")]
    Tampered(String),
    #[error("ROLLBACK_STALE: {0}")]
    Stale(String),
    #[error("PATH_OUT_OF_SCOPE: {0}")]
    OutOfScope(String),
    #[error(transparent)]
    Atomic(#[from] crate::atomic::AtomicError),
}

fn io(path: &Path, e: std::io::Error) -> CheckpointError {
    CheckpointError::Io {
        path: path.to_path_buf(),
        source: e,
    }
}

/// Copy `files` (absolute paths under `project_root`) into `dir/files/NNNN`
/// and write `dir/manifest.json`. Returns the manifest sha256 (to be stored
/// by the caller outside the project for tamper detection).
pub fn create(
    project_root: &Path,
    files: &[PathBuf],
    dir: &Path,
) -> Result<(Manifest, String), CheckpointError> {
    let blobs = dir.join("files");
    fs::create_dir_all(&blobs).map_err(|e| io(&blobs, e))?;
    let mut entries = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let rel = f
            .strip_prefix(project_root)
            .map_err(|_| CheckpointError::OutOfScope(f.display().to_string()))?;
        let bytes = fs::read(f).map_err(|e| io(f, e))?;
        let blob = format!("files/{i:04}");
        let dest = dir.join(&blob);
        fs::write(&dest, &bytes).map_err(|e| io(&dest, e))?;
        entries.push(ManifestEntry {
            path: rel.to_string_lossy().replace('\\', "/"),
            sha256: sha256_hex(&bytes),
            size: bytes.len() as u64,
            blob,
        });
    }
    let manifest = Manifest {
        schema_version: 1,
        project_root_sha256: sha256_hex(project_root.to_string_lossy().as_bytes()),
        files: entries,
    };
    let json = serde_json::to_string_pretty(&manifest).unwrap();
    let mpath = dir.join("manifest.json");
    fs::write(&mpath, json.as_bytes()).map_err(|e| io(&mpath, e))?;
    Ok((manifest, sha256_hex(json.as_bytes())))
}

/// Options for [`restore`].
#[derive(Default)]
pub struct RestoreOptions<'a> {
    /// Manifest sha recorded outside the project (tamper detection); `None` skips the check.
    pub expected_manifest_sha: Option<&'a str>,
    /// The design files observed under the project when the caller decided to
    /// restore (absolute path, sha256). Manifest files are optimistic-locked
    /// against it (mismatch -> `ROLLBACK_STALE`, nothing is written); files
    /// listed here but absent from the manifest were created after the
    /// checkpoint and are moved into the backup instead of being left behind.
    /// `None` skips both (no lock, no move).
    pub current: Option<&'a [(PathBuf, String)]>,
    pub backup_depth: usize,
    /// Where files created since the checkpoint are moved, keeping their
    /// relative path (default: `dir/removed`). They are never deleted.
    pub removed_dir: Option<&'a Path>,
}

#[derive(Debug, Default, Clone)]
pub struct RestoreOutcome {
    /// Files written back from the checkpoint (absolute).
    pub restored: Vec<PathBuf>,
    /// Files created after the checkpoint and moved into the backup
    /// (absolute: the path they had in the project).
    pub removed: Vec<PathBuf>,
}

/// The path of `p` relative to the project root, normalised the way [`create`]
/// writes manifest paths. `root` is the canonicalised root and `project_root`
/// the caller's (possibly un-canonicalised) one: on macOS the two differ
/// (`/var` vs `/private/var`) and the caller's file list is built from the second.
fn rel_key(root: &Path, project_root: &Path, p: &Path) -> Option<String> {
    let norm = |r: &Path| r.to_string_lossy().replace('\\', "/");
    if let Ok(r) = p.strip_prefix(root) {
        return Some(norm(r));
    }
    if let Ok(r) = p.strip_prefix(project_root) {
        return Some(norm(r));
    }
    p.canonicalize()
        .ok()
        .and_then(|c| c.strip_prefix(root).map(norm).ok())
}

/// A `VERIFY_FAILED` inside a restore is the optimistic lock firing, which the
/// app reports as `ROLLBACK_STALE`; anything else stays an atomic error.
fn as_stale(e: crate::atomic::AtomicError) -> CheckpointError {
    match e {
        crate::atomic::AtomicError::Stale { path, .. } => {
            CheckpointError::Stale(path.display().to_string())
        }
        other => CheckpointError::Atomic(other),
    }
}

/// Move a file created after the checkpoint into the backup, keeping its
/// relative path. Never deletes: a failed rename falls back to copy + remove.
fn move_aside(src: &Path, dest: &Path) -> Result<(), CheckpointError> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    if fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    fs::copy(src, dest).map_err(|e| io(src, e))?;
    fs::remove_file(src).map_err(|e| io(src, e))?;
    Ok(())
}

/// Verify the checkpoint (manifest sha, every blob sha, paths inside root,
/// no symlink following) and restore every file atomically as one
/// transaction. Files created after the checkpoint (present in `opts.current`,
/// absent from the manifest) are moved into the backup once the transaction
/// commits, so a rolled-back sheet leaves no orphan on disk.
pub fn restore(
    project_root: &Path,
    dir: &Path,
    opts: RestoreOptions<'_>,
) -> Result<RestoreOutcome, CheckpointError> {
    let mpath = dir.join("manifest.json");
    let json = fs::read(&mpath).map_err(|e| io(&mpath, e))?;
    if let Some(exp) = opts.expected_manifest_sha {
        if sha256_hex(&json) != exp {
            return Err(CheckpointError::Tampered("manifest sha mismatch".into()));
        }
    }
    let manifest: Manifest = serde_json::from_slice(&json)
        .map_err(|e| CheckpointError::Tampered(format!("manifest unreadable: {e}")))?;
    let root = project_root
        .canonicalize()
        .map_err(|e| io(project_root, e))?;
    // The caller's observation, keyed the same way as the manifest paths.
    let mut current: Vec<(String, PathBuf, String)> = Vec::new();
    for (p, sha) in opts.current.unwrap_or(&[]) {
        match rel_key(&root, project_root, p) {
            Some(rel) if !rel.is_empty() && !rel.contains("..") => {
                current.push((rel, p.clone(), sha.clone()))
            }
            _ => return Err(CheckpointError::OutOfScope(p.display().to_string())),
        }
    }
    let mut txn = Txn::new();
    let mut restored = Vec::new();
    for entry in &manifest.files {
        if entry.path.contains("..") || Path::new(&entry.path).is_absolute() {
            return Err(CheckpointError::OutOfScope(entry.path.clone()));
        }
        let target = root.join(&entry.path);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                return Err(CheckpointError::OutOfScope(format!(
                    "{} is a symlink",
                    entry.path
                )));
            }
        }
        let blob = dir.join(&entry.blob);
        let bytes = fs::read(&blob).map_err(|e| io(&blob, e))?;
        if sha256_hex(&bytes) != entry.sha256 {
            return Err(CheckpointError::Tampered(format!(
                "blob sha mismatch for {}",
                entry.path
            )));
        }
        let expected = current
            .iter()
            .find(|(rel, _, _)| *rel == entry.path)
            .map(|(_, _, sha)| sha.clone());
        // A file that changed (or disappeared) since the caller looked is not
        // the file the human was shown: refuse the whole restore.
        if let Some(exp) = &expected {
            if crate::atomic::file_sha(&target).as_deref() != Some(exp.as_str()) {
                return Err(CheckpointError::Stale(entry.path.clone()));
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
        }
        txn.add(&target, &bytes, expected.as_deref(), opts.backup_depth)
            .map_err(as_stale)?;
        restored.push(target);
    }
    // Files created after the checkpoint. The same staleness rule applies, and
    // they are checked before anything is written so a restore stays all-or-nothing.
    let mut extras: Vec<(String, PathBuf)> = Vec::new();
    for (rel, path, sha) in &current {
        if manifest.files.iter().any(|e| e.path == *rel) {
            continue;
        }
        let target = root.join(rel);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if meta.file_type().is_symlink() {
                return Err(CheckpointError::OutOfScope(format!("{rel} is a symlink")));
            }
        }
        if crate::atomic::file_sha(&target).as_deref() != Some(sha.as_str()) {
            return Err(CheckpointError::Stale(rel.clone()));
        }
        if crate::atomic::is_locked(&target) {
            return Err(CheckpointError::Atomic(crate::atomic::AtomicError::Locked(
                path.clone(),
            )));
        }
        extras.push((rel.clone(), target));
    }
    txn.commit().map_err(as_stale)?;
    let removed_root = opts
        .removed_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| dir.join("removed"));
    let mut removed = Vec::new();
    for (rel, target) in extras {
        move_aside(&target, &removed_root.join(&rel))?;
        removed.push(target);
    }
    Ok(RestoreOutcome { restored, removed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(sha: &str) -> RestoreOptions<'_> {
        RestoreOptions {
            expected_manifest_sha: Some(sha),
            backup_depth: 1,
            ..Default::default()
        }
    }

    #[test]
    fn checkpoint_roundtrip_and_tamper_detection() {
        let proj = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let a = proj.path().join("a.kicad_sch");
        fs::write(&a, b"original").unwrap();
        let (_m, msha) = create(proj.path(), std::slice::from_ref(&a), store.path()).unwrap();
        fs::write(&a, b"changed").unwrap();
        let out = restore(proj.path(), store.path(), opts(&msha)).unwrap();
        assert_eq!(out.restored.len(), 1);
        assert!(out.removed.is_empty());
        assert_eq!(fs::read(&a).unwrap(), b"original");
        // tamper the blob
        fs::write(store.path().join("files/0000"), b"evil").unwrap();
        assert!(matches!(
            restore(proj.path(), store.path(), opts(&msha)),
            Err(CheckpointError::Tampered(_))
        ));
    }

    /// The optimistic lock: a file edited after the caller observed it is not
    /// the file the human approved restoring over, so nothing is written.
    #[test]
    fn stale_observation_refuses_the_whole_restore() {
        let proj = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let a = proj.path().join("a.kicad_sch");
        let b = proj.path().join("b.kicad_sch");
        fs::write(&a, b"a0").unwrap();
        fs::write(&b, b"b0").unwrap();
        let (_m, msha) = create(proj.path(), &[a.clone(), b.clone()], store.path()).unwrap();
        fs::write(&a, b"a1").unwrap();
        fs::write(&b, b"b1").unwrap();
        let observed = vec![
            (a.clone(), sha256_hex(b"a1")),
            (b.clone(), sha256_hex(b"b1")),
        ];
        // KiCad writes b again between the observation and the restore.
        fs::write(&b, b"b2").unwrap();
        let e = restore(
            proj.path(),
            store.path(),
            RestoreOptions {
                expected_manifest_sha: Some(&msha),
                current: Some(&observed),
                backup_depth: 1,
                removed_dir: None,
            },
        )
        .unwrap_err();
        assert!(matches!(e, CheckpointError::Stale(_)), "{e}");
        assert_eq!(fs::read(&a).unwrap(), b"a1", "no file is written");
        assert_eq!(fs::read(&b).unwrap(), b"b2");
        // Observed as they are now: the restore goes through.
        let observed = vec![
            (a.clone(), sha256_hex(b"a1")),
            (b.clone(), sha256_hex(b"b2")),
        ];
        restore(
            proj.path(),
            store.path(),
            RestoreOptions {
                expected_manifest_sha: Some(&msha),
                current: Some(&observed),
                backup_depth: 1,
                removed_dir: None,
            },
        )
        .unwrap();
        assert_eq!(fs::read(&a).unwrap(), b"a0");
        assert_eq!(fs::read(&b).unwrap(), b"b0");
    }

    /// A sheet created after the checkpoint is not in the manifest: restoring
    /// the parent alone would leave it orphaned on disk.
    #[test]
    fn files_created_since_the_checkpoint_move_into_the_backup() {
        let proj = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let backup = tempfile::tempdir().unwrap();
        let root = proj.path().join("root.kicad_sch");
        fs::write(&root, b"r0").unwrap();
        let (_m, msha) = create(proj.path(), std::slice::from_ref(&root), store.path()).unwrap();
        fs::write(&root, b"r1").unwrap();
        fs::create_dir_all(proj.path().join("sub")).unwrap();
        let child = proj.path().join("sub/child.kicad_sch");
        fs::write(&child, b"c0").unwrap();
        let observed = vec![
            (root.clone(), sha256_hex(b"r1")),
            (child.clone(), sha256_hex(b"c0")),
        ];
        let out = restore(
            proj.path(),
            store.path(),
            RestoreOptions {
                expected_manifest_sha: Some(&msha),
                current: Some(&observed),
                backup_depth: 1,
                removed_dir: Some(backup.path()),
            },
        )
        .unwrap();
        assert_eq!(fs::read(&root).unwrap(), b"r0");
        assert!(!child.exists(), "the orphan sheet is gone from the project");
        assert_eq!(out.removed, vec![child.canonicalize_lossy()]);
        assert_eq!(
            fs::read(backup.path().join("sub/child.kicad_sch")).unwrap(),
            b"c0",
            "kept in the backup, never deleted"
        );
    }

    /// Without `removed_dir` the extras land inside the checkpoint directory.
    #[test]
    fn extras_default_to_the_checkpoint_directory() {
        let proj = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let root = proj.path().join("root.kicad_sch");
        fs::write(&root, b"r0").unwrap();
        let (_m, msha) = create(proj.path(), std::slice::from_ref(&root), store.path()).unwrap();
        let extra = proj.path().join("extra.kicad_sch");
        fs::write(&extra, b"x").unwrap();
        let observed = vec![
            (root.clone(), sha256_hex(b"r0")),
            (extra.clone(), sha256_hex(b"x")),
        ];
        restore(
            proj.path(),
            store.path(),
            RestoreOptions {
                expected_manifest_sha: Some(&msha),
                current: Some(&observed),
                backup_depth: 1,
                removed_dir: None,
            },
        )
        .unwrap();
        assert!(!extra.exists());
        assert_eq!(
            fs::read(store.path().join("removed/extra.kicad_sch")).unwrap(),
            b"x"
        );
    }

    trait CanonLossy {
        fn canonicalize_lossy(&self) -> PathBuf;
    }
    impl CanonLossy for PathBuf {
        fn canonicalize_lossy(&self) -> PathBuf {
            // `restore` reports paths under the canonicalised root; on macOS the
            // temp dir is a symlink (/var -> /private/var).
            let parent = self.parent().unwrap().canonicalize().unwrap();
            parent.join(self.file_name().unwrap())
        }
    }
}
