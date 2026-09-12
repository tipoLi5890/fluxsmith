// SPDX-License-Identifier: Apache-2.0
//! Update check and first-run disclosure (`docs/updates-and-compatibility.md` §1, §4).
//! Private period: no network. The check reads the user's local release folder
//! (`releases/v<ver>/`) or, for source builds, the git tags of the source checkout
//! (`.git/refs/tags` + `packed-refs`, plain files — no `git` subprocess, red line 8).

use crate::ipc::UpdateCheck;
use crate::state::AppState;
use std::path::{Path, PathBuf};

const CHANGELOG: &str = include_str!("../../CHANGELOG.md");

/// Parses `1.2.3` / `v1.2.3` / `1.2.3-beta.1` into a comparable tuple (pre-release sorts lower).
pub fn parse_semver(s: &str) -> Option<(u64, u64, u64, bool)> {
    let s = s.trim().trim_start_matches('v');
    let (core, pre) = match s.split_once('-') {
        Some((c, _)) => (c, true),
        None => (s, false),
    };
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next().unwrap_or("0").parse().ok()?;
    let c = it.next().unwrap_or("0").parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c, !pre))
}

fn newer(a: &str, b: &str) -> bool {
    match (parse_semver(a), parse_semver(b)) {
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

/// Newest `v<semver>` folder under `dir` (only folders that contain a `SHA256SUMS` or any bundle count).
pub fn newest_release(dir: &Path) -> Option<(String, PathBuf)> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut best: Option<(String, PathBuf)> = None;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let ver = name.trim_start_matches('v').to_string();
        if parse_semver(&ver).is_none() {
            continue;
        }
        if best.as_ref().map(|(b, _)| newer(&ver, b)).unwrap_or(true) {
            best = Some((ver, p));
        }
    }
    best
}

/// Newest semver tag of a git checkout, read from loose refs and `packed-refs`.
pub fn newest_git_tag(repo: &Path) -> Option<String> {
    let git = repo.join(".git");
    let mut tags: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(git.join("refs/tags")) {
        for e in rd.flatten() {
            tags.push(e.file_name().to_string_lossy().to_string());
        }
    }
    if let Ok(packed) = std::fs::read_to_string(git.join("packed-refs")) {
        for line in packed.lines() {
            if let Some(rest) = line.split_whitespace().nth(1) {
                if let Some(t) = rest.strip_prefix("refs/tags/") {
                    tags.push(t.to_string());
                }
            }
        }
    }
    tags.retain(|t| parse_semver(t).is_some());
    tags.sort_by_key(|a| parse_semver(a));
    tags.pop().map(|t| t.trim_start_matches('v').to_string())
}

pub fn check(state: &AppState) -> UpdateCheck {
    let current = state.app_version.clone();
    let release_dir = state.settings.read().advanced.release_dir.clone();
    if let Some(dir) = release_dir.as_deref().filter(|d| !d.is_empty()) {
        let dir = PathBuf::from(dir);
        if let Some((ver, folder)) = newest_release(&dir) {
            let changelog =
                std::fs::read_to_string(folder.join(format!("CHANGELOG-{ver}.md"))).ok();
            let status = if newer(&ver, &current) {
                "available"
            } else {
                "up_to_date"
            };
            return UpdateCheck {
                status: status.into(),
                current,
                latest: Some(ver),
                source: Some("release_dir".into()),
                folder: Some(folder.to_string_lossy().to_string()),
                changelog,
            };
        }
        return UpdateCheck {
            status: "up_to_date".into(),
            current,
            latest: None,
            source: Some("release_dir".into()),
            folder: Some(dir.to_string_lossy().to_string()),
            changelog: None,
        };
    }
    // Source build: the checkout this binary was compiled from.
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    if let Some(tag) = newest_git_tag(&repo) {
        let status = if newer(&tag, &current) {
            "available"
        } else {
            "up_to_date"
        };
        return UpdateCheck {
            status: status.into(),
            current,
            latest: Some(tag),
            source: Some("git_tag".into()),
            folder: None,
            changelog: None,
        };
    }
    UpdateCheck {
        status: "unset".into(),
        current,
        latest: None,
        source: None,
        folder: None,
        changelog: None,
    }
}

/// CHANGELOG entries for `[Unreleased]` and the section of `version`; `bytes_affecting` are the
/// ones tagged `[bytes-affecting]` / `[identity]` / `[schema]` / `[opspec]` (D-8 disclosure).
pub fn disclosure(version: &str) -> (Vec<String>, Vec<String>) {
    let mut entries = Vec::new();
    let mut in_section = false;
    for line in CHANGELOG.lines() {
        if let Some(h) = line.strip_prefix("## ") {
            let h = h.trim();
            in_section = h.starts_with("[Unreleased]")
                || h.contains(&format!("[{version}]"))
                || h.starts_with(version);
            continue;
        }
        if in_section {
            if let Some(item) = line.trim_start().strip_prefix("- ") {
                entries.push(item.trim().to_string());
            }
        }
    }
    let bytes: Vec<String> = entries
        .iter()
        .filter(|e| {
            ["[bytes-affecting]", "[identity]", "[schema]", "[opspec]"]
                .iter()
                .any(|t| e.contains(t))
        })
        .cloned()
        .collect();
    (bytes, entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semver_order_and_release_folders() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(!newer("0.1.0-beta.1", "0.1.0"));
        assert!(newer("v1.0.0", "0.9.9"));
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("v0.1.0")).unwrap();
        std::fs::create_dir_all(d.path().join("v0.3.0")).unwrap();
        std::fs::create_dir_all(d.path().join("notes")).unwrap();
        let (v, _) = newest_release(d.path()).unwrap();
        assert_eq!(v, "0.3.0");
    }
    #[test]
    fn git_tags_from_packed_refs() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".git/refs/tags")).unwrap();
        std::fs::write(d.path().join(".git/refs/tags/v0.2.0"), "abc\n").unwrap();
        std::fs::write(
            d.path().join(".git/packed-refs"),
            "# pack-refs\nabc refs/tags/v0.1.0\nabc refs/heads/main\n",
        )
        .unwrap();
        assert_eq!(newest_git_tag(d.path()).as_deref(), Some("0.2.0"));
    }
    #[test]
    fn disclosure_parses_unreleased() {
        let (bytes, entries) = disclosure("0.1.0");
        assert!(!entries.is_empty());
        for b in &bytes {
            assert!(
                b.contains("[bytes-affecting]")
                    || b.contains("[identity]")
                    || b.contains("[schema]")
                    || b.contains("[opspec]")
            );
        }
    }
}
