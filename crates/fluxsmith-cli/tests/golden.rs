// SPDX-License-Identifier: Apache-2.0
//! Golden matcher self-check (tests/golden-set/README.md "Matcher 自驗"):
//! refdes shuffles must still match; a wrong value or wrong net must fail
//! with a pointed problem.

use std::path::{Path, PathBuf};
use std::process::Command;

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_fluxsmith-cli"))
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Every reference here is built by applying an op-list that places `Device:R`,
/// `Device:C` and friends, so this file needs KiCad's own symbol libraries: there is
/// nothing in the repository to resolve those `lib_id`s against, and without them the
/// write gate refuses the apply with `SYMBOL_NOT_FOUND`. Hosted CI has no KiCad, so
/// the self-check is skipped there and enforced on the conformance runner, which sets
/// `FLUXSMITH_CONFORMANCE=required` - the same contract the `kicad-cli` oracles use.
fn kicad_symbols() -> Option<PathBuf> {
    // An explicit override is authoritative: it must itself be usable and it suppresses
    // the built-in locations, so the skip path can be exercised on a machine that does
    // have KiCad installed.
    let candidates: Vec<PathBuf> = match std::env::var("KICAD_SYMBOL_DIR") {
        Ok(p) => vec![PathBuf::from(p)],
        Err(_) => [
            "/Applications/KiCad/KiCad.app/Contents/SharedSupport/symbols",
            "C:\\Program Files\\KiCad\\10.0\\share\\kicad\\symbols",
            "/usr/share/kicad/symbols",
        ]
        .iter()
        .map(PathBuf::from)
        .collect(),
    };
    if let Some(dir) = candidates
        .into_iter()
        .find(|c| c.join("Device.kicad_sym").exists())
    {
        return Some(dir);
    }
    let required = std::env::var("FLUXSMITH_CONFORMANCE")
        .map(|v| v == "required")
        .unwrap_or(false);
    assert!(
        !required,
        "FLUXSMITH_CONFORMANCE=required but KiCad's symbol libraries were not found \
         (set KICAD_SYMBOL_DIR or install KiCad 10)"
    );
    eprintln!("KiCad symbol libraries not installed: golden matcher self-check skipped");
    None
}

fn build(task: &str, dir: &Path) -> PathBuf {
    let out = cli()
        .args(["new", dir.to_str().unwrap(), "ref"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let sch = dir.join("ref.kicad_sch");
    let ops = repo()
        .join("tests/golden-set/tasks")
        .join(task)
        .join("reference.ops.json");
    let out = cli()
        .args([
            "draw",
            sch.to_str().unwrap(),
            "--ops",
            ops.to_str().unwrap(),
            "--apply",
            "--journal",
            "/dev/null",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    sch
}

fn matches(expected: &Path, sch: &Path) -> (bool, String) {
    let out = cli()
        .args([
            "golden",
            "match",
            expected.to_str().unwrap(),
            sch.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
    )
}

#[test]
fn reference_matches_itself_and_refdes_shuffle_is_invisible() {
    if kicad_symbols().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let sch = build("decoupling_3v3", tmp.path());
    let expected = repo().join("tests/golden-set/tasks/decoupling_3v3/expected.json");
    assert!(matches(&expected, &sch).0);
    // Swap C1 <-> C2 (both 100n): must still match.
    let text = std::fs::read_to_string(&sch).unwrap();
    let swapped = text
        .replace("\"C1\"", "\"C9\"")
        .replace("\"C2\"", "\"C1\"")
        .replace("\"C9\"", "\"C2\"");
    std::fs::write(&sch, swapped).unwrap();
    let (ok, report) = matches(&expected, &sch);
    assert!(ok, "{report}");
}

#[test]
fn wrong_value_and_wrong_net_are_reported() {
    if kicad_symbols().is_none() {
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let sch = build("rc_lowpass", tmp.path());
    let expected = repo().join("tests/golden-set/tasks/rc_lowpass/expected.json");
    let original = std::fs::read_to_string(&sch).unwrap();
    // Wrong value.
    std::fs::write(&sch, original.replace("\"100n\"", "\"220n\"")).unwrap();
    let (ok, report) = matches(&expected, &sch);
    assert!(!ok);
    assert!(report.contains("Device:C"), "{report}");
    // Wrong net: rename the OUT label to OUTX.
    std::fs::write(&sch, original.replace("\"OUT\"", "\"OUTX\"")).unwrap();
    let (ok, report) = matches(&expected, &sch);
    assert!(!ok);
    assert!(report.contains("net OUT"), "{report}");
}

/// `ROW_MISALIGNED` over every task in the golden set, replayed from its own reference op-list.
///
/// The row rule is the one style check whose whole difficulty is *not* firing: two parts a
/// deliberate 100 mil step apart, or a regulator beside a capacitor, are not a staircase, and the
/// reference drawings are what a KiCad engineer signed off as correct. Any hit here is a false
/// positive by construction, so the assertion is a flat zero across all of them.
#[test]
fn reg_row_misaligned_is_silent_on_every_golden_reference() {
    if kicad_symbols().is_none() {
        return;
    }
    let mut checked = 0;
    let mut noisy: Vec<String> = Vec::new();
    let mut names: Vec<String> = std::fs::read_dir(repo().join("tests/golden-set/tasks"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for task in names {
        let tmp = tempfile::tempdir().unwrap();
        let dir = repo().join("tests/golden-set/tasks").join(&task);
        // A task that starts from a fixture project is replayed on a copy of it; the rest start
        // from an empty project, exactly as `build` does.
        let sch = if dir.join("fixture").is_dir() {
            let mut root = None;
            for e in std::fs::read_dir(dir.join("fixture")).unwrap() {
                let p = e.unwrap().path();
                let to = tmp.path().join(p.file_name().unwrap());
                std::fs::copy(&p, &to).unwrap();
                if p.extension().is_some_and(|x| x == "kicad_sch") {
                    root = Some(to);
                }
            }
            let sch = root.expect("fixture root schematic");
            let out = cli()
                .args([
                    "draw",
                    sch.to_str().unwrap(),
                    "--ops",
                    dir.join("reference.ops.json").to_str().unwrap(),
                    "--apply",
                    "--journal",
                    "/dev/null",
                ])
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{task}: {}",
                String::from_utf8_lossy(&out.stdout)
            );
            sch
        } else {
            build(&task, tmp.path())
        };
        let out = cli()
            .args(["check", sch.to_str().unwrap()])
            .output()
            .unwrap();
        let report = String::from_utf8_lossy(&out.stdout).to_string();
        assert!(report.contains("families"), "{task}: {report}");
        checked += 1;
        for line in report.lines() {
            if line.contains("ROW_MISALIGNED") {
                noisy.push(format!("{task}: {}", line.trim()));
            }
        }
    }
    assert!(checked >= 12, "only {checked} golden tasks replayed");
    assert!(noisy.is_empty(), "{noisy:#?}");
}
