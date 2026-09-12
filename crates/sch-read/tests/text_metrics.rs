// SPDX-License-Identifier: Apache-2.0
//! The engine's text metric against KiCad itself.
//!
//! `kicad-cli sch export svg` plots stroke text as paths and, next to every one
//! of them, an invisible `<text ... textLength="W">` placeholder whose `W` is the
//! width KiCad computed for that string - the `StringBoundaryLimits` eeschema's
//! `GetTextBox` and `GetBoundingBox` are built on. That is the oracle here: the
//! probe sheet below is exported, the placeholders are read back and compared
//! against `sch_read::bbox::text_width_mil`.
//!
//! The two disagree by a fixed `18 mil - size/5` (KiCad adds that to the sum of
//! the glyph advances, the model adds one 6 mil pen), which is under 2.5% of any
//! string of two characters or more at the 50 mil field size - hence the 5% band.
//!
//! `FLUXSMITH_CONFORMANCE=required` makes a missing kicad-cli fatal.

use sch_read::bbox::text_width_mil;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Strings the metric is judged on: the writer's own fixed texts, refdes and
/// values as the golden set writes them, the narrow / wide / full-width extremes
/// the old `chars x 0.8 x size` model was furthest out on, and CJK.
const STRINGS: [&str; 15] = [
    "PWR_FLAG",
    "WWWWW",
    "iiiii",
    "MMMMMMMM",
    "R101",
    "10uF",
    "MCP1700-3302E/TT",
    "AMS1117-3.3",
    "VBUS_5V",
    "0.1uF",
    "lil.,:;",
    "10\u{b5}F \u{b1}5%",
    "\u{96fb}\u{5bb9}\u{5668}",
    "\u{30b3}\u{30f3}\u{30c7}\u{30f3}\u{30b5}",
    "\u{5165}\u{529b}\u{96fb}\u{5727} 3.3V",
];

fn kicad_cli() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("KICAD_CLI") {
        return Some(PathBuf::from(p));
    }
    for c in [
        "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
        "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
        "/usr/bin/kicad-cli",
    ] {
        if Path::new(c).exists() {
            return Some(PathBuf::from(c));
        }
    }
    let required = std::env::var("FLUXSMITH_CONFORMANCE")
        .map(|v| v == "required")
        .unwrap_or(false);
    assert!(
        !required,
        "FLUXSMITH_CONFORMANCE=required but kicad-cli was not found (set KICAD_CLI or install KiCad 10)"
    );
    eprintln!("kicad-cli not installed: text metric oracle skipped");
    None
}

/// A sheet carrying one `(text)` item per string, all at `size_mil`, spaced far
/// enough apart that no two share a row.
fn probe_sheet(strings: &[&str], size_mil: f64) -> String {
    let mm = size_mil * 0.0254;
    let mut s = String::from(
        "(kicad_sch\n\t(version 20250114)\n\t(generator \"fluxsmith\")\n\t(generator_version \"10.0\")\n\t(uuid \"0e7b7e4e-1b3c-4c2e-9a10-000000000001\")\n\t(paper \"A0\")\n\t(lib_symbols)\n",
    );
    for (i, t) in strings.iter().enumerate() {
        assert!(
            !t.contains(['"', '\\', '&', '<', '>']),
            "probe strings stay plain so the s-expression and the SVG need no escaping: {t}"
        );
        s.push_str(&format!(
            "\t(text \"{t}\"\n\t\t(exclude_from_sim no)\n\t\t(at 20 {} 0)\n\t\t(effects (font (size {mm} {mm})) (justify left bottom))\n\t\t(uuid \"0e7b7e4e-1b3c-4c2e-9a10-{i:012}\")\n\t)\n",
            20 + i * 10
        ));
    }
    s.push_str("\t(sheet_instances\n\t\t(path \"/\"\n\t\t\t(page \"1\")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n");
    s
}

/// `text -> textLength` (mil) of every placeholder in the SVG.
fn svg_text_lengths(svg: &str) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for chunk in svg.split("textLength=\"").skip(1) {
        let Some((num, rest)) = chunk.split_once('"') else {
            continue;
        };
        let Ok(mm) = num.parse::<f64>() else { continue };
        // ... the rest of the opening tag, then the content up to `</text>`.
        let Some(gt) = rest.find('>') else { continue };
        let body = &rest[gt + 1..];
        let Some(end) = body.find("</text>") else {
            continue;
        };
        out.insert(body[..end].to_string(), mm / 0.0254);
    }
    out
}

/// Widths KiCad reports for `strings` drawn at `size_mil`.
fn kicad_widths(cli: &Path, dir: &Path, strings: &[&str], size_mil: f64) -> BTreeMap<String, f64> {
    let sch = dir.join(format!("probe{size_mil}.kicad_sch"));
    std::fs::write(&sch, probe_sheet(strings, size_mil)).unwrap();
    let out = Command::new(cli)
        .args(["sch", "export", "svg", "--no-background-color", "-o"])
        .arg(dir)
        .arg(&sch)
        .output()
        .expect("run kicad-cli");
    assert!(
        out.status.success(),
        "kicad-cli sch export svg failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let svg = sch.with_extension("svg");
    let bytes = std::fs::read(&svg).unwrap_or_else(|e| panic!("{}: {e}", svg.display()));
    svg_text_lengths(&String::from_utf8_lossy(&bytes))
}

// P1-2: the metric was `chars x size x 0.8` for every character, which is 30%
// short on `WWWWW`, 46% short on CJK and 15% over on `iiiii` - and it feeds the
// layout gate, the placement nudge, the power-port and PWR_FLAG escapes and the
// boxes the canvas draws.
#[test]
fn text_width_matches_kicad_within_five_percent() {
    let Some(cli) = kicad_cli() else { return };
    let dir = tempfile::tempdir().unwrap();
    for size_mil in [25.0f64, 50.0, 100.0] {
        // KiCad's width is the sum of the advances plus `18 mil - size/5`, the
        // model's is the sum plus one 6 mil pen: a constant of the text size, not
        // of the string. At the 50 mil the writer emits the two agree to 2 mil and
        // the band is the plain 5%; at another size that constant is allowed on top
        // of it, or a five-character `iiiii` at 25 mil would fail on 7 mil of
        // offset alone.
        let slack = (18.0 - size_mil / 5.0 - 6.0).abs();
        let widths = kicad_widths(cli.as_path(), dir.path(), &STRINGS, size_mil);
        for t in STRINGS {
            let kicad = *widths
                .get(t)
                .unwrap_or_else(|| panic!("kicad-cli plotted no placeholder for {t:?}"));
            let model = text_width_mil(t, size_mil);
            assert!(
                (model - kicad).abs() <= 0.05 * kicad + slack,
                "{t:?} at {size_mil} mil: model {model:.1} mil, kicad {kicad:.1} mil ({:+.1}%)",
                (model - kicad) / kicad * 100.0
            );
        }
    }
}

// The old model measured every character the same, so it could not tell these
// apart at all; the ratios are the point of the table.
#[test]
fn the_table_separates_narrow_normal_wide_and_full_width() {
    let w = |s: &str| text_width_mil(s, 50.0) - 6.0;
    assert!(w("iiiii") < w("ooooo"), "narrow before normal");
    assert!(w("ooooo") < w("WWWWW"), "normal before wide");
    // A Han character is three narrow ones, and kana sits between.
    assert!(
        (w("\u{96fb}") / w("i") - 3.1).abs() < 0.05,
        "{}",
        w("\u{96fb}")
    );
    assert!(w("\u{30a2}") < w("\u{96fb}"));
    // An empty string draws nothing, so it has no width to collide with.
    assert_eq!(text_width_mil("", 50.0), 0.0);
    // Width scales with the text size (the pen does not).
    assert!(
        (text_width_mil("R1", 100.0) - 6.0 - 2.0 * (text_width_mil("R1", 50.0) - 6.0)).abs() < 1e-9
    );
}

// The `PWR_FLAG` escape's 100 mil step and 400 mil ceiling are sized from this
// number; it was written when the metric said 320 mil.
#[test]
fn pwr_flag_is_the_width_the_flag_escape_is_sized_for() {
    let w = text_width_mil("PWR_FLAG", 50.0);
    assert!((w - 377.4).abs() < 0.5, "{w}");
}
