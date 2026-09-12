# fuzz

`cargo fuzz` targets for the lossless parser and the schematic reader (docs/engine-conformance.md §5, L7).
Not a workspace member (needs nightly + libFuzzer). Seeds: every fixture under `tests/conformance/fixtures`.

```sh
cargo install cargo-fuzz
cd fuzz
cargo +nightly fuzz run kicad_sexpr_parse -- -max_total_time=60
cargo +nightly fuzz run sch_read_sheet   -- -max_total_time=60
# seed corpus
mkdir -p corpus/kicad_sexpr_parse && cp ../tests/conformance/fixtures/*/*.kicad_sch corpus/kicad_sexpr_parse/
```

Stable CI covers the same no-panic contract deterministically via
`crates/kicad-sexpr/tests/invariants.rs::ugly_inputs_never_panic` and
`crates/sch-read/tests/invariants.rs::ugly_inputs_never_panic`.
