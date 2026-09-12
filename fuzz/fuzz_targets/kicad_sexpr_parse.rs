// SPDX-License-Identifier: Apache-2.0
//! L7: the lossless S-expression parser must never panic and must round-trip
//! every input it accepts (docs/engine-conformance.md E0).
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let Ok(src) = std::str::from_utf8(data) else { return };
    let limits = kicad_sexpr::Limits { max_bytes: 1 << 22, max_depth: 256, max_children: 1 << 16, max_atom_bytes: 1 << 16 };
    if let Ok(doc) = kicad_sexpr::parse_with(src, limits) {
        let out = kicad_sexpr::dumps(&doc);
        assert_eq!(out, src, "accepted input must round-trip byte-identically");
    }
});
