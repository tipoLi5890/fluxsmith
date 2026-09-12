// SPDX-License-Identifier: Apache-2.0
//! Secret store (red line 17, revised 2026-08-28): provider secrets and OAuth
//! tokens live in `<app data>/secrets.json` (mode 0600 on Unix), written
//! atomically by Rust and never sent to the webview. The OS keychain is not
//! used: it prompts on every rebuild of an unsigned binary and is invisible to
//! run-from-source users. This mirrors how pi-coding-agent keeps
//! `~/.pi/agent/auth.json`.

use crate::error::err;
use crate::ipc::IpcError;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::path::PathBuf;

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    crate::paths::app_data_dir().join("secrets.json")
}

fn load() -> Result<BTreeMap<String, String>, IpcError> {
    let p = path();
    if !p.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(&p).map_err(|e| {
        err(
            "KEYRING_UNAVAILABLE",
            format!("cannot read {}: {e}", p.display()),
        )
    })?;
    serde_json::from_str(&text).map_err(|e| {
        err(
            "KEYRING_UNAVAILABLE",
            format!("secrets.json is corrupt: {e}"),
        )
        .with_remediation("delete secrets.json in the app data folder and enter the keys again")
    })
}

fn store(map: &BTreeMap<String, String>) -> Result<(), IpcError> {
    let p = path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            err(
                "KEYRING_UNAVAILABLE",
                format!("cannot create {}: {e}", dir.display()),
            )
        })?;
    }
    let tmp = p.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(map).unwrap();
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| {
        err(
            "KEYRING_UNAVAILABLE",
            format!("cannot write {}: {e}", tmp.display()),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| {
        err(
            "KEYRING_UNAVAILABLE",
            format!("cannot replace {}: {e}", p.display()),
        )
    })?;
    Ok(())
}

pub fn set(provider_id: &str, secret: &str) -> Result<(), IpcError> {
    if secret.trim().is_empty() {
        return Err(err("BAD_CONFIG", "empty secret"));
    }
    let _g = LOCK.lock();
    let mut map = load()?;
    map.insert(provider_id.to_string(), secret.to_string());
    store(&map)
}

pub fn get(provider_id: &str) -> Result<Option<String>, IpcError> {
    let _g = LOCK.lock();
    Ok(load()?.get(provider_id).cloned())
}

pub fn has(provider_id: &str) -> bool {
    matches!(get(provider_id), Ok(Some(_)))
}

pub fn delete(provider_id: &str) -> Result<(), IpcError> {
    let _g = LOCK.lock();
    let mut map = load()?;
    if map.remove(provider_id).is_some() {
        store(&map)?;
    }
    Ok(())
}

/// Probe whether the store is usable (app data writable, file parseable).
pub fn available() -> bool {
    let _g = LOCK.lock();
    if load().is_err() {
        return false;
    }
    let dir = crate::paths::app_data_dir();
    std::fs::create_dir_all(&dir).is_ok()
        && std::fs::metadata(&dir)
            .map(|m| !m.permissions().readonly())
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_delete_round_trip() {
        // Share the process-wide test app-data dir (set once by
        // `AppState::for_tests`) instead of racing other tests for the env var.
        let _state = crate::state::AppState::for_tests();
        set("keyring-test-p1", "sk-test").unwrap();
        assert_eq!(get("keyring-test-p1").unwrap().as_deref(), Some("sk-test"));
        assert!(has("keyring-test-p1"));
        delete("keyring-test-p1").unwrap();
        assert!(!has("keyring-test-p1"));
        assert!(available());
    }
}
