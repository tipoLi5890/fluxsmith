---
name: parts-sourcing
description: >-
  Sourcing real, orderable parts (JLCPCB/LCSC) for a fluxsmith schematic: structured search, high/low
  confidence matching, Basic vs Extended, converting EasyEDA CAD to KiCad libraries as unverified claims,
  BOM lock, and the DNP / substitute / no-part decision card. Use in Plan (candidates) and Build (source-bom).
roles: [sourcer, librarian]
hard: [search, decisions, claims]
---

# Parts sourcing (Sourcer)

## Search {#search}
- Search with `parts.search { mpn | lcsc | value+package(+category) | query }` (jlcsearch catalogue of JLCPCB assembly parts). Keep queries short and specific ("ATtiny1616 SOIC-20", "100nF 0603 X7R 50V"); value+package queries mix NTCs with resistors, so add the category word. Use `in_stock` / `basic_only` to trim.
- Resolution order per component: existing `LCSC` property → MPN exact → value+package+category.

## Decisions belong to the user {#decisions}
- **High confidence** = package matches AND value/dielectric/rating match. Only high-confidence results bind automatically (write `LCSC` property). Everything else goes to the **decision card**: accept / substitute / check the datasheet first / DNP / no-part. You never decide DNP or substitution yourself.
- The card says out loud that both columns are your reading of the catalogue, not a datasheet comparison, and it preselects `accept` only where a `facts.write` document (quote-verified against the datasheet PDF) confirms one of the compared values — your own `confidence: "high"` does not. So when a part matters, read the datasheet and write the facts before you raise the card; otherwise expect `review`, which writes nothing.
- Substitutes must show expected vs actual per field (value, package, rating, Basic/Extended, price) and are written with `Substitute=yes`, `Substitute_Of=<expected>`; Review flags them forever (`SUBSTITUTED_PART`).
- Prefer Basic parts, then Preferred; stock below the configured threshold goes to `alternates`.

## Converted libraries are claims {#claims}
- `parts.convert { lcsc }` fetches the EasyEDA CAD and writes `fluxsmith-libs/jlc.kicad_sym`, `jlc.pretty/<package>.kicad_mod` and the STEP model into the project, registers `sym-lib-table` / `fp-lib-table`, and returns `lib_id` (`jlc:<MPN>`) plus the pin table. Use the returned `lib_id` verbatim (`lib.resolve` confirms it). The nickname `jlc` needs no structural envelope entry; any other nickname does. Never ask the user to download or upload CAD files.
- The result is a **claim, not a fact**: produce `verification_notes` (pin count/names vs datasheet via `parts.datasheet` + `docs.pdf_text`, package dimensions). The converted symbol carries `fluxsmith_claim = unverified` (plus `fluxsmith_pin_pad_mismatch` when the pins and pads disagree), so once it is placed `check.run project` reports `PIN_PAD_MISMATCH` and the delivery family reports `PART_UNVERIFIED`. Both are **Warnings and block nothing**: clearing them means comparing the part with its datasheet, recording the values with `facts.write`, and saying in the summary what is still unverified.
- `parts.convert` also returns `warnings[]`. Read them: a `PIN_PAD_MISMATCH` there means the symbol and the footprint name different pads, which no amount of placing will fix.

## BOM lock and network {#bom}
- Record the outcome as a BOM lock; `parts.bom --against-lock` detects drift.
- Every network call is visible and counted; this is the second outbound channel — respect the per-session consent.
