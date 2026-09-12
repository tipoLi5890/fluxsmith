// SPDX-License-Identifier: Apache-2.0
//! L7: `sch-read` on arbitrary S-expressions returns `Err` or a `Sheet`, never panics.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(src) = std::str::from_utf8(data) else { return };
    let limits = kicad_sexpr::Limits { max_bytes: 1 << 22, max_depth: 256, max_children: 1 << 16, max_atom_bytes: 1 << 16 };
    if let Ok(doc) = kicad_sexpr::parse_with(src, limits) {
        let _ = sch_read::sheet_from_document(&doc, std::path::Path::new("fuzz.kicad_sch"));
        let _ = sch_read::parse_symbol_lib(src, "fuzz", std::path::Path::new("fuzz.kicad_sym"));
    }
});
