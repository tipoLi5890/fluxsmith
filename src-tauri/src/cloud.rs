// SPDX-License-Identifier: Apache-2.0
//! Cloud-sync folder detection (SPEC UJ-11, `docs/ui-states.md` `CLOUD_SYNC_FOLDER`).
//! Path-based: iCloud Drive, OneDrive, Dropbox, Google Drive. Detection only changes
//! UI advice and the watcher debounce; it never blocks Build.

use std::path::Path;

/// Returns the sync service name when `path` lies inside a known sync folder.
pub fn sync_service(path: &Path) -> Option<&'static str> {
    let s = path.to_string_lossy().replace('\\', "/");
    let lower = s.to_ascii_lowercase();
    let segs: Vec<&str> = lower.split('/').collect();
    if lower.contains("/mobile documents/")
        || lower.contains("com~apple~clouddocs")
        || segs
            .iter()
            .any(|x| *x == "icloud drive" || *x == "iclouddrive")
    {
        return Some("iCloud Drive");
    }
    if segs.iter().any(|x| x.starts_with("onedrive")) {
        return Some("OneDrive");
    }
    if segs
        .iter()
        .any(|x| *x == "dropbox" || x.starts_with("dropbox ("))
    {
        return Some("Dropbox");
    }
    if lower.contains("/google drive/")
        || lower.contains("/googledrive/")
        || segs
            .iter()
            .any(|x| *x == "my drive" || x.starts_with("googledrive-"))
        || lower.contains("/cloudstorage/")
    {
        return Some("Google Drive");
    }
    None
}

/// Watcher debounce for a project (1 s in synced folders so sync write-backs coalesce).
pub fn debounce_ms(cloud: bool) -> u64 {
    if cloud {
        1000
    } else {
        300
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[test]
    fn detects_known_services() {
        assert_eq!(
            sync_service(&PathBuf::from(
                "/Users/a/Library/Mobile Documents/com~apple~CloudDocs/proj"
            )),
            Some("iCloud Drive")
        );
        assert_eq!(
            sync_service(&PathBuf::from("C:\\Users\\a\\OneDrive - Corp\\proj")),
            Some("OneDrive")
        );
        assert_eq!(
            sync_service(&PathBuf::from("/Users/a/Dropbox/proj")),
            Some("Dropbox")
        );
        assert_eq!(
            sync_service(&PathBuf::from(
                "/Users/a/Library/CloudStorage/GoogleDrive-x@y/My Drive/p"
            )),
            Some("Google Drive")
        );
        assert_eq!(
            sync_service(&PathBuf::from("/Users/a/Documents/proj")),
            None
        );
        assert_eq!(debounce_ms(true), 1000);
    }
}
