---
name: schematic-review
description: >-
  Read-only design review for KiCad schematics in fluxsmith: run the engine checks first, then apply
  design heuristics (decoupling, pull-ups, crystals, unused pins, rail scope, readability), classify each
  finding as engine vs advisory with confidence and evidence, and propose fixes as structured items.
roles: [reviewer]
modes: [review]
hard: [engine-first, no-apply]
---

# Schematic review (Reviewer) — read-only

## Engine first {#engine-first}
1. **Engine first**: `project.check`, `gate.run`, `check.intent`, `diff.nets(session_open → current)`. Everything the engine reports is `origin: engine`; do not restate it in prose.

## Datasheet-backed checks {#datasheet}
2. **Datasheet-backed checks**: for parts with facts (`datasheets/extracted/`), compare rails vs absolute max, recommended decoupling, crystal load caps, EN/BOOT strapping. Cite `{mpn, page, quote}`. Facts with `audited:false` → mark `datasheet_backed(unaudited)`.

## Advisory heuristics {#advisory}
3. **Advisory heuristics** (`origin: advisory`, with `confidence`): missing decoupling near power pins, floating inputs without `no_connect`, unterminated unused units, rails as local labels, signal flow readability, block frames/titles, label collisions.

## Output contract {#no-apply}
4. **Never** propose an op-list directly to apply. Emit `Finding[] { code, severity, confidence, evidence, remediation, refs, proposed_ops? }`; `proposed_ops` are suggestions the Fixer will re-author.
5. Metadata header is mandatory: passive-pin ratio, No-ERC suppressed count, `config-waived: N (M demoted)`, families skipped with reason.
6. Zero findings is not "clean" — say what was not checked.
