// SPDX-License-Identifier: Apache-2.0
//! The only path that writes design files: temp file in the same directory,
//! fsync, rename over the target, `.bak` rotation, lock-file refusal,
//! sha256 snapshot check (TOCTOU), and multi-file two-phase transactions.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum AtomicError {
    #[error("TARGET_LOCKED: KiCad lock file present for {0}")]
    Locked(PathBuf),
    #[error("VERIFY_FAILED: {path} changed on disk (expected sha {expected}, found {found})")]
    Stale {
        path: PathBuf,
        expected: String,
        found: String,
    },
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn file_sha(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|b| sha256_hex(&b))
}

/// KiCad's GUI lock file for `foo.kicad_sch` is `~foo.kicad_sch.lck` in the same directory.
pub fn lock_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    target.with_file_name(format!("~{name}.lck"))
}

pub fn is_locked(target: &Path) -> bool {
    lock_path(target).exists()
}

/// A prepared write: the temp file is fully written and fsynced; `commit`
/// renames it into place, `abort` removes it.
pub struct Prepared {
    target: PathBuf,
    temp: PathBuf,
    expected_sha: Option<String>,
    backup_depth: usize,
}

fn io(path: &Path, e: std::io::Error) -> AtomicError {
    AtomicError::Io {
        path: path.to_path_buf(),
        source: e,
    }
}

/// Write `bytes` to a temp file next to `target`. `expected_sha` is the sha of
/// the target as it was read; if the file changed meanwhile the write is
/// refused (checked again at commit).
pub fn prepare(
    target: &Path,
    bytes: &[u8],
    expected_sha: Option<&str>,
    backup_depth: usize,
) -> Result<Prepared, AtomicError> {
    if is_locked(target) {
        return Err(AtomicError::Locked(target.to_path_buf()));
    }
    check_sha(target, expected_sha)?;
    let dir = target.parent().unwrap_or(Path::new("."));
    let stem = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let temp = dir.join(format!(".{stem}.fluxsmith-tmp-{}", std::process::id()));
    let mut f = fs::File::create(&temp).map_err(|e| io(&temp, e))?;
    f.write_all(bytes).map_err(|e| io(&temp, e))?;
    f.sync_all().map_err(|e| io(&temp, e))?;
    Ok(Prepared {
        target: target.to_path_buf(),
        temp,
        expected_sha: expected_sha.map(|s| s.to_string()),
        backup_depth,
    })
}

fn check_sha(target: &Path, expected: Option<&str>) -> Result<(), AtomicError> {
    if let Some(exp) = expected {
        let found = file_sha(target).unwrap_or_default();
        if found != exp {
            return Err(AtomicError::Stale {
                path: target.to_path_buf(),
                expected: exp.to_string(),
                found,
            });
        }
    }
    Ok(())
}

impl Prepared {
    pub fn target(&self) -> &Path {
        &self.target
    }

    /// Rotate backups and rename the temp file over the target.
    pub fn commit(self) -> Result<(), AtomicError> {
        if is_locked(&self.target) {
            let _ = fs::remove_file(&self.temp);
            return Err(AtomicError::Locked(self.target.clone()));
        }
        if let Err(e) = check_sha(&self.target, self.expected_sha.as_deref()) {
            let _ = fs::remove_file(&self.temp);
            return Err(e);
        }
        if self.target.exists() && self.backup_depth > 0 {
            rotate_backups(&self.target, self.backup_depth)?;
            fs::copy(&self.target, backup_name(&self.target, 0))
                .map_err(|e| io(&self.target, e))?;
        }
        replace_file(&self.temp, &self.target)?;
        // fsync the directory so the rename is durable
        if let Some(dir) = self.target.parent() {
            if let Ok(d) = fs::File::open(dir) {
                let _ = d.sync_all();
            }
        }
        Ok(())
    }

    pub fn abort(self) {
        let _ = fs::remove_file(&self.temp);
    }
}

fn replace_file(temp: &Path, target: &Path) -> Result<(), AtomicError> {
    // Windows: rename over an open file can fail with a sharing violation
    // (antivirus, indexers). Retry a few times with backoff.
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..5 {
        match fs::rename(temp, target) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(20 * (attempt + 1)));
            }
        }
    }
    let _ = fs::remove_file(temp);
    Err(io(target, last.unwrap()))
}

pub fn backup_name(target: &Path, n: usize) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if n == 0 {
        target.with_file_name(format!("{name}.bak"))
    } else {
        target.with_file_name(format!("{name}.bak{n}"))
    }
}

fn rotate_backups(target: &Path, depth: usize) -> Result<(), AtomicError> {
    // .bak{depth-1} is dropped; .bak{k} -> .bak{k+1}; .bak -> .bak1
    if depth == 0 {
        return Ok(());
    }
    let last = backup_name(target, depth - 1);
    if last.exists() {
        fs::remove_file(&last).map_err(|e| io(&last, e))?;
    }
    for k in (0..depth.saturating_sub(1)).rev() {
        let from = backup_name(target, k);
        if from.exists() {
            let to = backup_name(target, k + 1);
            fs::rename(&from, &to).map_err(|e| io(&from, e))?;
        }
    }
    Ok(())
}

/// Multi-file transaction: prepare every file, then commit all. If any commit
/// fails, already-committed files are restored from the pre-images kept in
/// memory (best effort), so the set is all-or-nothing on a healthy disk.
pub struct Txn {
    prepared: Vec<Prepared>,
    pre_images: Vec<(PathBuf, Option<Vec<u8>>)>,
}

impl Txn {
    pub fn new() -> Txn {
        Txn {
            prepared: Vec::new(),
            pre_images: Vec::new(),
        }
    }

    pub fn add(
        &mut self,
        target: &Path,
        bytes: &[u8],
        expected_sha: Option<&str>,
        backup_depth: usize,
    ) -> Result<(), AtomicError> {
        let pre = fs::read(target).ok();
        self.prepared
            .push(prepare(target, bytes, expected_sha, backup_depth)?);
        self.pre_images.push((target.to_path_buf(), pre));
        Ok(())
    }

    pub fn commit(self) -> Result<(), AtomicError> {
        let mut done: Vec<usize> = Vec::new();
        let pre = self.pre_images;
        let mut prepared = self.prepared;
        let n = prepared.len();
        for i in 0..n {
            let p = prepared.remove(0);
            match p.commit() {
                Ok(()) => done.push(i),
                Err(e) => {
                    // abort the rest, restore the committed ones
                    for rest in prepared {
                        rest.abort();
                    }
                    for &d in &done {
                        let (path, image) = &pre[d];
                        match image {
                            Some(bytes) => {
                                let _ = fs::write(path, bytes);
                            }
                            None => {
                                let _ = fs::remove_file(path);
                            }
                        }
                    }
                    return Err(e);
                }
            }
        }
        Ok(())
    }

    pub fn abort(self) {
        for p in self.prepared {
            p.abort();
        }
    }
}

impl Default for Txn {
    fn default() -> Self {
        Txn::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_rotate_and_refuse_when_locked_or_stale() {
        let dir = tempfile::tempdir().unwrap();
        let t = dir.path().join("a.kicad_sch");
        fs::write(&t, b"v1").unwrap();
        let sha1 = file_sha(&t).unwrap();
        prepare(&t, b"v2", Some(&sha1), 2)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(&t).unwrap(), b"v2");
        assert_eq!(fs::read(backup_name(&t, 0)).unwrap(), b"v1");
        let sha2 = file_sha(&t).unwrap();
        prepare(&t, b"v3", Some(&sha2), 2)
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(backup_name(&t, 1)).unwrap(), b"v1");
        // stale
        assert!(matches!(
            prepare(&t, b"x", Some(&sha1), 2),
            Err(AtomicError::Stale { .. })
        ));
        // locked
        fs::write(lock_path(&t), b"").unwrap();
        assert!(matches!(
            prepare(&t, b"x", None, 2),
            Err(AtomicError::Locked(_))
        ));
        assert_eq!(fs::read(&t).unwrap(), b"v3");
    }
}
