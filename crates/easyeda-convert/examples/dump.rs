// SPDX-License-Identifier: Apache-2.0
//! `cargo run -p easyeda-convert --example dump -- <product.json> <out_dir>`
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let c = easyeda_convert::convert(&v).unwrap();
    let out = std::path::Path::new(&a[2]);
    std::fs::create_dir_all(out.join("jlc.pretty")).unwrap();
    std::fs::write(
        out.join("jlc.kicad_sym"),
        sch_libwrite::write_symbol_lib(None, &c.spec).unwrap(),
    )
    .unwrap();
    if let Some(fp) = &c.spec.footprint {
        std::fs::write(
            out.join("jlc.pretty")
                .join(format!("{}.kicad_mod", fp.name)),
            sch_libwrite::write_footprint(fp).unwrap(),
        )
        .unwrap();
    }
    println!(
        "{} warnings={:?} skipped={:?}",
        c.spec.name, c.warnings, c.skipped
    );
}
