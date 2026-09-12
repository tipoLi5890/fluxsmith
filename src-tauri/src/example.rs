// SPDX-License-Identifier: Apache-2.0
//! The bundled example project (`examples/ldo_3v3`). A first run has nothing to open: this copies
//! the example out of the read-only bundle into a folder the human picked (or the app data
//! `examples` folder) so it can be opened, edited and rolled back like any other project. Plain file
//! copy -- no engine, no write path (it only ever creates new files, never touches an existing one).

use crate::error::{err, io_err};
use crate::ipc::IpcError;
use crate::paths::{app_data_dir, ensure_dir, long_path};
use std::path::{Path, PathBuf};

/// Folder name of the example inside `examples/`, and the files that make it up. The sidecar
/// (`.fluxsmith/`), engine backups and anything else next to them are deliberately not copied.
pub const EXAMPLE: &str = "ldo_3v3";
const FILES: &[&str] = &["ldo_3v3.kicad_pro", "ldo_3v3.kicad_sch"];
/// The file the app opens after the copy.
const PROJECT_FILE: &str = "ldo_3v3.kicad_pro";
/// How many `-2`, `-3`… suffixes are tried before giving up on a name.
const MAX_COPIES: u32 = 100;

/// Where the bundled examples live: `FLUXSMITH_EXAMPLES_DIR` when set, the bundle's resource dir in
/// an installed app (`../examples/**` is bundled under `_up_/examples`), the repo when run from
/// source. Mirrors `skills::builtin_dir`.
pub fn examples_dir(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Ok(p) = std::env::var("FLUXSMITH_EXAMPLES_DIR") {
        return PathBuf::from(p);
    }
    if let Some(a) = app {
        use tauri::Manager;
        if let Ok(r) = a.path().resource_dir() {
            for c in [
                r.join("examples"),
                r.join("_up_").join("examples"),
                r.join("../examples"),
            ] {
                if c.is_dir() {
                    return c;
                }
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
    if dev.is_dir() {
        return dev;
    }
    PathBuf::from("examples")
}

/// A folder named `ldo_3v3` under `parent` that does not exist yet (`ldo_3v3-2`, `-3`, …).
fn free_dir(parent: &Path) -> Result<PathBuf, IpcError> {
    let first = parent.join(EXAMPLE);
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..=MAX_COPIES {
        let c = parent.join(format!("{EXAMPLE}-{n}"));
        if !c.exists() {
            return Ok(c);
        }
    }
    Err(err(
        "FS_TRANSIENT",
        format!(
            "{} already holds {MAX_COPIES} copies of the example",
            parent.display()
        ),
    ))
}

/// Copy `<examples>/ldo_3v3` into a new folder under `dest_parent`; returns the copied `.kicad_pro`.
pub fn install_from(examples: &Path, dest_parent: &Path) -> Result<String, IpcError> {
    let src = examples.join(EXAMPLE);
    for f in FILES {
        let p = src.join(f);
        if !p.is_file() {
            return Err(io_err(
                &p,
                std::io::Error::new(std::io::ErrorKind::NotFound, "example file is missing"),
            ));
        }
    }
    ensure_dir(dest_parent)?;
    let dest = free_dir(dest_parent)?;
    ensure_dir(&dest)?;
    for f in FILES {
        std::fs::copy(src.join(f), dest.join(f)).map_err(|e| io_err(&dest.join(f), e))?;
    }
    Ok(dest.join(PROJECT_FILE).to_string_lossy().to_string())
}

/// Install into the folder the human picked, or into app data `examples/` when none was given.
pub fn install(
    app: Option<&tauri::AppHandle>,
    dest_parent: Option<&str>,
) -> Result<String, IpcError> {
    let parent = match dest_parent {
        Some(d) if !d.trim().is_empty() => long_path(Path::new(d)),
        _ => app_data_dir().join("examples"),
    };
    install_from(&examples_dir(app), &parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source tree with the two example files, plus what must not be copied.
    fn fixture(examples: &Path) {
        let src = examples.join(EXAMPLE);
        std::fs::create_dir_all(src.join(".fluxsmith")).unwrap();
        for f in FILES {
            std::fs::write(src.join(f), format!("({f})")).unwrap();
        }
        std::fs::write(src.join("ldo_3v3.kicad_sch.bak"), "(old)").unwrap();
    }

    #[test]
    fn copies_only_the_project_files_and_never_overwrites() {
        let tmp = tempfile::tempdir().unwrap();
        let examples = tmp.path().join("examples");
        fixture(&examples);
        let out = tmp.path().join("out");
        let first = install_from(&examples, &out).unwrap();
        assert!(first.ends_with(PROJECT_FILE), "{first}");
        assert!(out.join(EXAMPLE).join("ldo_3v3.kicad_sch").is_file());
        assert!(!out.join(EXAMPLE).join("ldo_3v3.kicad_sch.bak").exists());
        assert!(!out.join(EXAMPLE).join(".fluxsmith").exists());
        let second = install_from(&examples, &out).unwrap();
        assert!(second.contains(&format!("{EXAMPLE}-2")), "{second}");
        // The first copy is untouched by the second install.
        assert_eq!(
            std::fs::read_to_string(out.join(EXAMPLE).join(PROJECT_FILE)).unwrap(),
            format!("({PROJECT_FILE})")
        );
    }

    #[test]
    fn missing_source_is_a_file_error() {
        let tmp = tempfile::tempdir().unwrap();
        let e = install_from(&tmp.path().join("examples"), &tmp.path().join("out")).unwrap_err();
        assert_eq!(e.code, "FILE_UNREADABLE");
        assert!(
            !tmp.path().join("out").exists(),
            "nothing is created on failure"
        );
    }
}
