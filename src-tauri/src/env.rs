// SPDX-License-Identifier: Apache-2.0
//! Environment check (D-51): KiCad presence, version, symbol libraries,
//! sym-lib-table, keyring. `EnvIncomplete` blocks AI features in the UI.

use crate::ipc::{EnvProblem, EnvReport, KicadSettings};
use crate::paths::now_iso;
use std::path::{Path, PathBuf};

pub fn kicad_app_candidates(override_path: Option<&str>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(p) = override_path {
        v.push(PathBuf::from(p));
    }
    #[cfg(target_os = "macos")]
    {
        v.push(PathBuf::from("/Applications/KiCad/KiCad.app"));
        if let Ok(home) = std::env::var("HOME") {
            v.push(PathBuf::from(home).join("Applications/KiCad/KiCad.app"));
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Newest first by parsed version, not by name: a lexicographic sort would put a
        // leftover `9.0` install ahead of `10.0` and the first hit wins below.
        for base in ["C:\\Program Files\\KiCad", "C:\\Program Files (x86)\\KiCad"] {
            v.extend(sch_read::kicad_version_dirs(Path::new(base)));
        }
        // Per-user install (`sch_read::discover_kicad` looks here too).
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.extend(sch_read::kicad_version_dirs(
                &PathBuf::from(local).join("Programs").join("KiCad"),
            ));
        }
    }
    #[cfg(target_os = "linux")]
    {
        v.push(PathBuf::from("/usr"));
        v.push(PathBuf::from("/usr/local"));
    }
    v
}

pub fn cli_path_for(app: &Path) -> Option<PathBuf> {
    let candidates = [
        app.join("Contents/MacOS/kicad-cli"),
        app.join("bin/kicad-cli.exe"),
        app.join("bin/kicad-cli"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

pub fn symbol_dir_for(app: &Path) -> Option<PathBuf> {
    let candidates = [
        app.join("Contents/SharedSupport/symbols"),
        app.join("share/kicad/symbols"),
    ];
    candidates.into_iter().find(|p| p.is_dir())
}

/// Run `kicad-cli version` with a short timeout and no network env.
pub fn cli_version(cli: &Path) -> Option<String> {
    let out = crate::sandbox::run(cli, &["version"], None, 10).ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// `incomplete` (any fatal problem: `EnvIncomplete`, AI features off) | `degraded`
/// (reads fine, cannot write: KiCad 9 with resolvable libraries — Review and Q&A stay,
/// Plan and Build are stopped) | `ok`. A missing `kicad-cli` only skips the advisory
/// checks, so it stays `ok` with a non-fatal `KICAD_CLI_MISSING` note.
fn status_for(problems: &[EnvProblem]) -> String {
    if problems.iter().any(|p| p.fatal) {
        "incomplete".into()
    } else if problems
        .iter()
        .any(|p| p.code == "KICAD_VERSION_UNSUPPORTED")
    {
        "degraded".into()
    } else {
        "ok".into()
    }
}

pub fn check(k: &KicadSettings) -> EnvReport {
    let mut problems = Vec::new();
    let app = kicad_app_candidates(k.app_path.as_deref())
        .into_iter()
        .find(|p| p.exists());
    let cli = k
        .cli_path
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| app.as_ref().and_then(|a| cli_path_for(a)));
    let version = cli.as_ref().and_then(|c| cli_version(c));
    let symbol_dir = k
        .symbol_dir_override
        .as_ref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| app.as_ref().and_then(|a| symbol_dir_for(a)));
    let symbol_lib_count = symbol_dir
        .as_ref()
        .and_then(|d| std::fs::read_dir(d).ok())
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|x| x == "kicad_sym")
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    let (_, table) = sch_read::discover_kicad(app.as_deref());
    if app.is_none() {
        problems.push(EnvProblem {
            code: "KICAD_NOT_FOUND".into(),
            message: "KiCad 10 was not found on this machine".into(),
            remediation: "install KiCad 10 or set the application path in Settings > Environment"
                .into(),
            fatal: true,
        });
    }
    if let Some(v) = &version {
        match sch_read::parse_version(v).map(|(major, _)| major) {
            // Nightlies report 10.99 and count as 10.
            Some(major) if major >= 10 => {}
            // KiCad 9 opens, but new projects are written in the v10 file format and every copy says 10:
            // not fatal, `degraded` (UJ-0) keeps Review and Q&A and stops Plan / Build.
            Some(9) => problems.push(EnvProblem {
                code: "KICAD_VERSION_UNSUPPORTED".into(),
                message: format!("KiCad {v} was found, but writing needs KiCad 10.x"),
                remediation: "install KiCad 10 or point the application path at a KiCad 10 install"
                    .into(),
                fatal: false,
            }),
            Some(_) => problems.push(EnvProblem {
                code: "KICAD_VERSION_UNSUPPORTED".into(),
                message: format!("KiCad {v} was found, but fluxsmith needs KiCad 10.x"),
                remediation: "install KiCad 10 or point the application path at a KiCad 10 install"
                    .into(),
                fatal: true,
            }),
            // `kicad-cli version` printed something this build does not understand. Treating that as
            // version 0 used to disable every AI feature on a healthy install: it is a note, not a stop.
            None => problems.push(EnvProblem {
                code: "KICAD_VERSION_UNKNOWN".into(),
                message: format!("the KiCad version could not be read from kicad-cli ({v})"),
                remediation: "check the version in KiCad > About if something looks wrong".into(),
                fatal: false,
            }),
        }
    } else if app.is_some() {
        problems.push(EnvProblem {
            code: "KICAD_CLI_MISSING".into(),
            message: "kicad-cli was not found; advisory checks are disabled".into(),
            remediation: "set the kicad-cli path in Settings > Environment".into(),
            fatal: false,
        });
    }
    if symbol_lib_count == 0 {
        problems.push(EnvProblem {
            code: "KICAD_DATA_DIR_NOT_FOUND".into(),
            message: "no KiCad symbol libraries found".into(),
            remediation: "install the KiCad symbol libraries or set the symbol directory override"
                .into(),
            fatal: true,
        });
    }
    if table.is_none() {
        problems.push(EnvProblem {
            code: "SYMBOL_TABLE_NOT_FOUND".into(),
            message: "the global sym-lib-table was not found".into(),
            remediation: "launch KiCad once so it creates its configuration, then re-check".into(),
            fatal: true,
        });
    }
    let keyring_available = crate::keyring::available();
    if !keyring_available {
        problems.push(EnvProblem {
            code: "KEYRING_UNAVAILABLE".into(),
            message: "the secret store (secrets.json in app data) is not writable; API keys cannot be stored".into(),
            remediation: "make the app data folder writable (no system keychain is used)".into(),
            fatal: false,
        });
    }
    EnvReport {
        status: status_for(&problems),
        kicad_app_path: app.map(|p| p.to_string_lossy().to_string()),
        kicad_cli_path: cli.map(|p| p.to_string_lossy().to_string()),
        kicad_version: version,
        symbol_dir: symbol_dir.map(|p| p.to_string_lossy().to_string()),
        symbol_lib_count,
        sym_lib_table: table.map(|p| p.to_string_lossy().to_string()),
        keyring_available,
        problems,
        checked_at: now_iso(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn problem(code: &str, fatal: bool) -> EnvProblem {
        EnvProblem {
            code: code.into(),
            message: String::new(),
            remediation: String::new(),
            fatal,
        }
    }

    #[test]
    fn kicad_10_wins_over_9_in_the_candidate_order() {
        // Windows keeps every major version in its own directory; the reversed lexicographic
        // sort this used to do put "9.0" first and reported KICAD_VERSION_UNSUPPORTED on a
        // machine that has 10.
        let tmp = std::env::temp_dir().join(format!("fluxsmith-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for name in ["9.0", "10.0", "8.0"] {
            std::fs::create_dir_all(tmp.join(name)).unwrap();
        }
        std::fs::write(tmp.join("uninstall.exe"), b"").unwrap();
        let dirs = sch_read::kicad_version_dirs(&tmp);
        let names: Vec<String> = dirs
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["10.0", "9.0", "8.0"]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn version_strings_parse_by_number() {
        assert_eq!(sch_read::parse_version("10.0.0"), Some((10, 0)));
        assert_eq!(sch_read::parse_version("9.0.1"), Some((9, 0)));
        assert_eq!(sch_read::parse_version("10.99.0"), Some((10, 99)));
        assert_eq!(sch_read::parse_version("Application: kicad-cli"), None);
    }

    #[test]
    fn status_reflects_fatal_and_degraded_problems() {
        assert_eq!(status_for(&[]), "ok");
        assert_eq!(status_for(&[problem("KICAD_CLI_MISSING", false)]), "ok");
        assert_eq!(status_for(&[problem("KICAD_VERSION_UNKNOWN", false)]), "ok");
        assert_eq!(
            status_for(&[problem("KICAD_VERSION_UNSUPPORTED", false)]),
            "degraded"
        );
        assert_eq!(
            status_for(&[
                problem("KICAD_VERSION_UNSUPPORTED", false),
                problem("SYMBOL_TABLE_NOT_FOUND", true),
            ]),
            "incomplete"
        );
    }
}
