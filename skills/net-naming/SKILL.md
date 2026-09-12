---
name: net-naming
description: >-
  Net naming rules for fluxsmith schematics: rail vocabulary, local vs global vs hierarchical scope, eeschema
  driver-priority naming, when a merge is expected vs a hard stop, and interface declaration across sheets.
roles: [drafter, fixer, architect, reviewer]
hard: [rails, scope, merges]
---

# Net naming

## Rails {#rails}
- **Rails** come from `fluxsmith.toml [rails]` and the plan (`net_naming.rails`). Use exactly those strings. Rails are `power_port`, never local labels.
- `PWR_FLAG` names nothing; use `place_pwr_flag` on externally driven rails to satisfy ERC.

## Scope and interfaces {#scope}
- **Scope**: `local` merges only within one sheet (and with a same-named global/power on that sheet even without a wire); `global` merges across sheets; `hierarchical` pairs with a parent sheet pin of the same name.
- **Cross-sheet signals** must be declared in the plan `interfaces` (default `global_label`). An undeclared named net spanning ≥ 2 sheets is a hard stop (`INTERFACE_UNDECLARED`).
- **Rails never cross on a sheet pin**: a rail is carried by a power port of the same name on each sheet, so it needs no `add_sheet_pin` and is never a plan `interface`. Sheet pins are for signals. `add_sheet_pin` also writes the child file (the engine seeds the matching hierarchical label inside it), so it only works where the step's envelope covers that file — the scaffold step already gave each sheet symbol the interface pins its plan declares.

## Naming ladder {#ladder}
- **Naming ladder** (eeschema): global > power > local > hierarchical/port > sheet_entry. If two named labels touch, the higher-priority name wins and the other becomes an alias — avoid touching two named nets unless the plan lists the merge.

## Expected merges vs hard stops {#merges}
- **Expected merges**: connecting a floating pin (unnamed net) to a rail or a block's declared `nets_in/nets_out` is fine and auto-allowed. Merging two *named* nets (e.g. `VBUS` ↔ `+3V3`) is a hard stop — if you need it, say so in your notes instead of doing it.

## Renaming and prefixes {#rename}
- **rename_net** reaches exactly as far as the name's own scope: a local label is renamed on the op's own sheet only (a same-named local label on another sheet is a different net), a global label and a power port value are renamed project-wide, and a hierarchical label is renamed together with the parent's sheet pin. Omit `scope` and the engine reads it off the labels that carry the name; a name spelled as two kinds is refused (`RENAME_SCOPE_AMBIGUOUS`) until you pass `scope`, and so is a local name that is on several sheets but not on the op's own sheet until you set `sheet` (one op per sheet you mean). Only nets listed in `envelope.nets.renamable` may be renamed, and the write still has to stay inside the envelope's sheets.
- Prefix conventions from `fluxsmith.toml [naming].net_prefix_rules` apply to new signal nets; keep names ≤ 24 chars, ASCII, no spaces.
