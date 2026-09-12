// SPDX-License-Identifier: Apache-2.0
// The finding-code registry against the engine: every code the Rust sources can put in a
// `Finding` must have an entry (family + copy), and every entry must have copy in all four
// languages. A new code added to a gate without its copy fails here, not in front of a user.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FINDING_CODES, FINDING_FAMILY, findingCodeEntry, isFindingCode } from "../finding-codes";
import { isWaivable } from "../findings";
import { catalogues, findingCopy, findingTitleEn, UI_LANGS } from "../../i18n";

// `new URL(dynamic, import.meta.url)` is rewritten by Vite's asset handling; resolve by hand.
const HERE = dirname(fileURLToPath(import.meta.url));
const root = (rel: string) => resolve(HERE, "../../..", rel);

/**
 * Files that emit a `Finding`. `gates.rs` and `sch-check` are the engine's own checks; `parts.rs`
 * mints the one BOM row. Op errors (`handlers.rs`, `sch-ops`) are not findings: they travel back
 * inside a tool result and are covered by the error-code table instead.
 */
const FINDING_SOURCES = [
  "crates/sch-write/src/gates.rs",
  "crates/sch-check/src/lib.rs",
  "crates/sch-check/src/pin_matrix.rs",
];

/**
 * SCREAMING_SNAKE literals in those files that are not finding codes. Keeping this list short and
 * explicit is the point: a new literal that is neither a code nor listed here fails the test, so
 * the choice is made deliberately rather than by a regex that quietly stops matching.
 */
const NOT_A_CODE = new Set([
  "PWR_FLAG", // the KiCad symbol's value, matched by name in the gates
  "LCSC", // a symbol property name read by the BOM
]);

/** Every code the Rust sources can emit, read out of the string literals. */
function rustCodes(): string[] {
  const found = new Set<string>();
  for (const rel of FINDING_SOURCES) {
    const src = readFileSync(root(rel), "utf8");
    // Codes reach `Finding` in three shapes: `finding("X", ...)` / `f("X", ...)`, `code: "X"`, and a
    // `let code = if .. { "X" } else { "Y" }` or a match arm returning the code in a tuple. All of
    // them are a screaming-snake literal in one of these two files, so the literals are the net.
    for (const m of src.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) {
      if (!NOT_A_CODE.has(m[1])) found.add(m[1]);
    }
  }
  // The one finding minted outside the engine crates.
  const parts = readFileSync(root("src-tauri/src/parts.rs"), "utf8");
  for (const m of parts.matchAll(/"code":\s*"([A-Z][A-Z0-9_]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

describe("finding code registry", () => {
  it("covers every code the Rust sources emit", () => {
    const codes = rustCodes();
    // A sanity floor: if the extraction silently matched nothing, the rest of this test is vacuous.
    expect(codes.length).toBeGreaterThan(40);
    expect(codes.filter((c) => !isFindingCode(c))).toEqual([]);
  });

  it("names the codes an engineer reads most often", () => {
    // The panel's headline codes, spelled out so a rename in the engine is caught here as well.
    for (const code of ["TEXT_OVERLAP", "FIELD_OVER_OWN_BODY", "DECAP_FAR", "ERC_PIN_TO_PIN", "PINMAP_UNCONNECTED",
      "RAIL_SCOPE_SPLIT", "POWER_PORT_ORIENTATION", "LONG_WIRE", "TITLE_BLOCK_EMPTY", "OFF_GRID",
      "SYMBOL_CACHE_MISMATCH", "PART_UNVERIFIED", "PIN_PAD_MISMATCH"]) {
      expect(isFindingCode(code), code).toBe(true);
    }
  });

  it("gives every entry a title, a detail and a remedy in all four languages", () => {
    for (const code of FINDING_CODES) {
      const entry = findingCodeEntry(code)!;
      expect(entry.family).toBe(FINDING_FAMILY[code]);
      for (const lang of UI_LANGS) {
        const copy = findingCopy(code, lang);
        expect(copy, `${code} ${lang}`).not.toBeNull();
        for (const part of [copy!.title, copy!.detail, copy!.remedy]) {
          expect(part.trim().length, `${code} ${lang}`).toBeGreaterThan(0);
        }
        // Every key really is in that catalogue, not falling back to English through `t`.
        for (const key of [entry.titleKey, entry.detailKey, entry.remedyKey]) {
          expect(key in catalogues[lang], `${key} ${lang}`).toBe(true);
        }
      }
    }
  });

  it("keeps English titles short enough to read as a row's primary text", () => {
    for (const code of FINDING_CODES) {
      const title = findingTitleEn(code);
      expect(title.split(/\s+/).length, `${code}: ${title}`).toBeLessThanOrEqual(6);
    }
  });

  it("agrees with the triage rule about what a human can waive", () => {
    for (const code of FINDING_CODES) {
      const entry = findingCodeEntry(code)!;
      // Both sources in the table inspected the file, so both are waivable; a model advisory carries
      // no code from the table and is decided by `findings.ts` alone.
      const origin = entry.family === "kicad" ? "advisory" : "engine";
      expect(isWaivable({ code, severity: "Warning", origin }), code).toBe(entry.waivable);
    }
  });

  it("has no copy for a code the engine does not emit", () => {
    // A model advisory ("STYLE_HINT") and an op error ("PLACEMENT_BLOCKED") are not findings: the
    // row keeps the engine's own message, with no invented title.
    expect(findingCopy("STYLE_HINT")).toBeNull();
    expect(findingCopy("PLACEMENT_BLOCKED")).toBeNull();
    expect(findingTitleEn("STYLE_HINT")).toBe("");
  });
});
