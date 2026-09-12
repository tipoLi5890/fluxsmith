# `crates/` — the Rust-native KiCad schematic engine

A Cargo workspace of small crates that read, write, netlist and check `.kicad_sch` files directly.
There is no Python, no subprocess and no FFI at runtime. KiCad itself is the correctness oracle:
`kicad-cli` is a test-time judge (and, at runtime, an optional advisory second opinion whose absence
is never fatal).

| Crate | Responsibility | Depends on |
|---|---|---|
| `kicad-sexpr` | Lossless S-expression I/O: byte-identical round-trip, unknown nodes preserved verbatim, safety limits, a single quoter, `{token}` escaping | — |
| `sch-model` | The normalised model: integer nanometres, +Y down, the one `transform` implementation, `PinRef` | `kicad-sexpr` |
| `sch-read` | `.kicad_sch`, `.kicad_sym` (with `extends` flattened), `.kicad_pro`, `sym-lib-table` (nested expansion, KiCad data directory discovery), and the sheet tree | `sch-model` |
| `sch-ops` | The fluxsmith op vocabulary (opspec v1), validation, macro expansion, group and sheet routing | `sch-model` |
| `sch-net` | Netlist construction in the eeschema dialect — buses, scope, driver-priority naming, membership-hash ids — plus net diffing | `sch-read` |
| `sch-write` | Identity (the frozen UUIDv5 seed rules), op handlers, the nine write gates, atomic transactions, the net gate, checkpoints and the journal | `sch-net`, `sch-ops` |
| `sch-check` | ERC-lite, diff, nets, pin map, integrity, BOM, power, layout and intent checks | `sch-write` |
| `sch-geom` | Typed geometry for the canvas (every point through the same transform) | `sch-write` |
| `sch-libwrite` | `.kicad_sym` and `.kicad_mod` writers, used by parts conversion | `sch-model` |
| `easyeda-convert` | EasyEDA/LCSC CAD to KiCad symbol and footprint conversion. Its output is a **claim**, not a fact: it must be checked against the datasheet | `sch-libwrite` |
| `fluxsmith-cli` | `read`, `nets`, `net`, `component`, `pins`, `bbox`, `geom`, `plan`, `draw`, `check`, `diff`, `checkpoint`, `restore`, `new`, `golden`, `capabilities`, all `--json`. Used by conformance, the golden set and scripts | all |

Each crate depends only on crates above it in that table (the column names the highest one).

## Invariants

These are the properties the test suites exist to defend, and they are not negotiable:

1. **Lossless serialisation.** A node fluxsmith did not touch is written back byte for byte. Unknown
   nodes survive. Depth and size limits return a structured error and never panic.
2. **Integer nanometres everywhere.** Rotate then mirror; a file angle of `+90` maps `(x,y)` to
   `(y,-x)`. Reader, writer and geometry share one `transform` function — no crate reimplements it.
3. **The eeschema dialect decides connectivity.** A mid-span T without a junction is not connected;
   a local label merges with a same-named global or power symbol on its own sheet but not across
   sheets; `PWR_FLAG` does not name a net; net ids are membership hashes; naming follows the
   driver-priority ladder.
4. **One write path.** `sch-write`'s atomic transaction: a temp file in the same directory, fsync,
   `.bak` rotation, two-phase for multiple files. A `~<name>.lck` refuses the write, and the target
   file's sha256 is snapshotted before applying.
5. **The write gate** is nine integrity checks plus a strict net diff, and it shares its connectivity
   function with the netlist builder. Nothing outside the engine may decide whether a circuit is
   correct.
6. **The engine makes no I/O decisions.** `sch-write::atomic` is the only module that writes to
   disk, and only on commit.

## Conformance

Merging requires parity with KiCad: byte-exact round-trips, netlists matching
`kicad-cli sch export netlist`, no annotation errors from `kicad-cli sch erc` after a write, files
that open in the KiCad GUI, and idempotent double-apply. The pinned KiCad version is in
`../tests/conformance/KICAD_VERSION`, and the toolchain paths in `../tests/conformance/env.toml`;
tests that need a real KiCad skip when it is absent.

## Dependencies

Third-party crates are kept to a deliberately short list: `uuid`, `serde` / `serde_json`, `regex`,
`tempfile`, `sha2`, `thiserror`. Additions must be Apache-2.0, MIT or BSD-class — see
`../deny.toml`.
