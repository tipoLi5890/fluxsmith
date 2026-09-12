# examples/

Small KiCad projects that ship with fluxsmith. They contain no real or private design data.

## `ldo_3v3/` — the bundled example project

The project the welcome screen offers under "Open the example project". It is bundled as an app
resource (`src-tauri/tauri.conf.json` → `bundle.resources`) and copied out of the read-only bundle
into a folder you choose (or the app data `examples/` folder) before it is opened, so editing it,
applying turns and rolling back all work as they do for any other project. The copy is never
overwritten: a second "open the example" lands next to the first one as `ldo_3v3-2`.

Two files are bundled and copied — `ldo_3v3.kicad_pro` and `ldo_3v3.kicad_sch`. The engine writes a
`.bak` beside any file it rewrites; those are ignored, not committed, and not part of the example.

What the schematic holds (one A4 sheet, KiCad 10 / `version 20260306`):

| | |
|---|---|
| `U1` | `Regulator_Linear:AMS1117-3.3`, a fixed 3.3 V LDO |
| `C1`, `C2` | `Device:C`, the input and output capacitors |
| power symbols | `VDC` on `U1`'s VI pin, `VCC` on its VO pin, `GND` under it |
| `PWR_FLAG` ×2 | on `C1`'s two pins |

There are no wire segments: `U1` connects through the power symbols placed directly on its pins, and
`C2` is placed but not yet connected. That makes it a small, honest starting point rather than a
finished design — a first thing to ask the agent for is "wire C1 across the input and C2 across the
output". Correctness is judged by the engine and by KiCad, never by the example.

## Fixtures

Engine fixtures live with the tests that use them (`crates/*/tests`, `tests/`), not here; the
conformance oracle is KiCad itself.
