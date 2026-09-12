// SPDX-License-Identifier: Apache-2.0
// The finding-code registry: every code that can appear in `findings[].code`, the family that emits
// it, and the catalogue keys carrying its human copy (`finding.<CODE>.{title,detail,remedy}`, four
// languages). Engine codes come from `crates/sch-write/src/gates.rs` and `crates/sch-check/src`
// (plus `SUBSTITUTED_PART` from `src-tauri/src/parts.rs`); `KICAD_*` codes are minted by
// `kicad-erc.ts` from the settings key of a `kicad-cli sch erc` violation.
//
// Red line 6: nothing here judges a circuit. The title names what the check looked at, the detail
// says what it measured, the remedy states the usual engineering fix; the verdict stays the
// engine's, and the engine's own English `message` is shown verbatim beside this copy as untrusted
// text. A code with no entry (a model advisory, a KiCad rule not listed here) simply has no copy:
// the row then reads exactly as it did before, with the code and the engine's message.

/**
 * Where a code comes from. The first eight are the `gate.run` families
 * (`sch_check::gate_run`), `bom` is the parts report, `kicad` is `kicad-cli sch erc`.
 */
export type FindingFamily =
  | "integrity"
  | "layout"
  | "style"
  | "erc"
  | "pinmap"
  | "delivery"
  | "intent"
  | "project"
  | "bom"
  | "kicad";

/**
 * Code -> emitting family. This object is the code list of record: `finding-codes.test.ts` checks
 * it against the string literals in the Rust sources, and `scripts/i18n-lint.mjs` checks it against
 * the four copy tables in `src/i18n/findings/`.
 */
export const FINDING_FAMILY = {
  // integrity — the write gate's nine checks (`gates::integrity`). A waiver does not unblock a
  // refused write: the write gate never reads waivers, only the check families do.
  DANGLING_ENDPOINT: "integrity",
  DANGLING_BUS: "integrity",
  DANGLING_BUS_ENTRY: "integrity",
  DUPLICATE_UUID: "integrity",
  DUPLICATE_DESIGNATOR: "integrity",
  DUPLICATE_DESIGNATOR_PROJECT: "integrity",
  UNRESOLVED_LIB_ID: "integrity",
  INVALID_INSTANCES_PATH: "integrity",
  POWER_PORT_STACKED: "integrity",
  SHEET_FILE_MISSING: "integrity",
  NO_CONNECT_CONFLICT: "integrity",
  // layout — frame and geometry (`gates::layout`, `gates::overlap`)
  OUT_OF_FRAME: "layout",
  GROUP_OVERLAP: "layout",
  SYMBOL_OVERLAP: "layout",
  LABEL_OVERLAP: "layout",
  LABEL_OVER_BODY: "layout",
  LABEL_OVER_WIRE: "layout",
  TEXT_OVERLAP: "layout",
  FIELD_OVER_OWN_BODY: "layout",
  FIELD_OVER_FIELD: "layout",
  PAGE_UNDERUSED: "layout",
  LABEL_PAIR_SHOULD_BE_WIRE: "layout",
  // style — drawing conventions (`gates::style`)
  OFF_GRID: "style",
  LONG_WIRE: "style",
  POWER_PORT_ORIENTATION: "style",
  ROW_MISALIGNED: "style",
  // erc — connectivity (`sch_check::erc`, `pin_to_pin`, `instance_refs`)
  ERC_POWER_IN_UNDRIVEN: "erc",
  ERC_POWER_OUT_CONFLICT: "erc",
  ERC_OUTPUT_CONFLICT: "erc",
  ERC_INPUT_FLOATING: "erc",
  ERC_NC_ON_CONNECTED: "erc",
  ERC_SINGLE_PIN_NET: "erc",
  ERC_PIN_TO_PIN: "erc",
  ERC_UNSPECIFIED_PIN: "erc",
  ERC_MULTIPLE_NET_NAMES: "erc",
  LABEL_DANGLING: "erc",
  POWER_PORT_DANGLING: "erc",
  POLARITY_REVERSED: "erc",
  RAIL_ALIAS: "erc",
  SHEET_PIN_UNMATCHED: "erc",
  HIER_LABEL_UNMATCHED: "erc",
  INSTANCE_REFS_REQUIRED: "erc",
  SHEET_PIN_UNWIRED: "erc",
  // pinmap — `sch_check::pinmap_findings`
  PINMAP_UNCONNECTED: "pinmap",
  // delivery — what a fabricator needs (`gates::delivery`, `gates::decoupling_distance`)
  FOOTPRINT_MISSING: "delivery",
  UNITS_INCOMPLETE: "delivery",
  RAIL_AS_LABEL: "delivery",
  RAIL_SCOPE_SPLIT: "delivery",
  LABEL_SCOPE_SPLIT: "delivery",
  DECAP_FAR: "delivery",
  PART_UNVERIFIED: "delivery",
  SHEET_NO_PINS: "delivery",
  SHEET_CHILD_EMPTY: "delivery",
  // intent — the known-good snapshot (`sch_check::check_intent`)
  INTENT_MISMATCH: "intent",
  // project — the library audit (`sch_check::project`)
  UNANNOTATED: "project",
  SYMBOL_CACHE_MISMATCH: "project",
  SYMBOL_NOT_IN_TABLE: "project",
  TITLE_BLOCK_EMPTY: "project",
  PIN_PAD_MISMATCH: "project",
  // bom — the parts report (`src-tauri/src/parts.rs`)
  SUBSTITUTED_PART: "bom",
  // kicad — `kicad-cli sch erc` settings keys, upper-cased by `kicad-erc.ts`. Advisory: KiCad's own
  // second opinion, never the pass/fail verdict. Rules not listed here fall back to no copy.
  KICAD_POWER_PIN_NOT_DRIVEN: "kicad",
  KICAD_PIN_NOT_DRIVEN: "kicad",
  KICAD_PIN_NOT_CONNECTED: "kicad",
  KICAD_PIN_TO_PIN: "kicad",
  KICAD_LABEL_DANGLING: "kicad",
  KICAD_GLOBAL_LABEL_DANGLING: "kicad",
  KICAD_WIRE_DANGLING: "kicad",
  KICAD_UNCONNECTED_WIRE_ENDPOINT: "kicad",
  KICAD_NO_CONNECT_CONNECTED: "kicad",
  KICAD_NO_CONNECT_DANGLING: "kicad",
  KICAD_DUPLICATE_REFERENCE: "kicad",
  KICAD_UNANNOTATED: "kicad",
  KICAD_MULTIPLE_NET_NAMES: "kicad",
  KICAD_SIMILAR_LABELS: "kicad",
  KICAD_SINGLE_GLOBAL_LABEL: "kicad",
  KICAD_HIER_LABEL_MISMATCH: "kicad",
  KICAD_ENDPOINT_OFF_GRID: "kicad",
  KICAD_LIBRARY_SYMBOL_ISSUE: "kicad",
  KICAD_UNRESOLVED_VARIABLE: "kicad",
} as const satisfies Record<string, FindingFamily>;

export type FindingCode = keyof typeof FINDING_FAMILY;

/** The codes, in table order (families grouped as `gate.run` reports them). */
export const FINDING_CODES = Object.keys(FINDING_FAMILY) as FindingCode[];

export function isFindingCode(code: string): code is FindingCode {
  return Object.prototype.hasOwnProperty.call(FINDING_FAMILY, code);
}

/** The three catalogue keys a code carries. Typed so `MessageKey` stays a closed union. */
export type FindingCopyKey =
  | `finding.${FindingCode}.title`
  | `finding.${FindingCode}.detail`
  | `finding.${FindingCode}.remedy`;

/**
 * Codes a human cannot waive. A waiver hides a row that something actually inspected the file for,
 * which covers both sources in this table (the engine gate and KiCad's own ERC), so the set is
 * empty today; it exists so a future code whose row is not a check result has a home, and so
 * `waivable` is a fact of the table rather than a guess at the call site. Model advisories carry no
 * code from this table and are handled by `findings.ts isWaivable`.
 */
const NOT_WAIVABLE: ReadonlySet<string> = new Set<string>();

/** One row of the registry: what the code is, and where its copy lives. */
export interface FindingCodeEntry {
  code: FindingCode;
  family: FindingFamily;
  titleKey: `finding.${FindingCode}.title`;
  detailKey: `finding.${FindingCode}.detail`;
  remedyKey: `finding.${FindingCode}.remedy`;
  /** Whether a human can waive a row carrying this code (`policy_waive`). */
  waivable: boolean;
}

/** The registry row for a code, or null when the code has no entry (a model advisory, say). */
export function findingCodeEntry(code: string): FindingCodeEntry | null {
  if (!isFindingCode(code)) return null;
  return {
    code,
    family: FINDING_FAMILY[code],
    titleKey: `finding.${code}.title`,
    detailKey: `finding.${code}.detail`,
    remedyKey: `finding.${code}.remedy`,
    waivable: !NOT_WAIVABLE.has(code),
  };
}
