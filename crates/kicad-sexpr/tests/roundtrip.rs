// SPDX-License-Identifier: Apache-2.0
use std::fs;
use std::path::PathBuf;

fn fixture_dirs() -> Vec<PathBuf> {
    let mut v =
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/fixtures")];
    if let Ok(extra) = std::env::var("FLUXSMITH_EXTRA_FIXTURES") {
        for p in extra.split(':') {
            v.push(PathBuf::from(p));
        }
    }
    v
}

fn walk(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
            if matches!(ext, "kicad_sch" | "kicad_sym" | "kicad_pcb" | "kicad_mod")
                || p.file_name()
                    .map(|f| f == "sym-lib-table" || f == "fp-lib-table")
                    .unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
}

#[test]
fn every_fixture_roundtrips_byte_identical() {
    let mut files = Vec::new();
    for d in fixture_dirs() {
        walk(&d, &mut files);
    }
    assert!(!files.is_empty(), "no fixtures found");
    for f in files {
        let src = fs::read_to_string(&f).unwrap();
        let doc = kicad_sexpr::parse(&src).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let out = kicad_sexpr::dumps(&doc);
        assert!(out == src, "round-trip mismatch: {}", f.display());
    }
}

#[test]
fn malformed_inputs_do_not_panic() {
    let cases = [
        "", "(", ")", "((", "(a \"", "(a)(b)", "(a b))", "\u{0}(", "(a \\)",
    ];
    for c in cases {
        let _ = kicad_sexpr::parse(c);
    }
}
