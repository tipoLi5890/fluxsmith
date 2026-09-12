// SPDX-License-Identifier: Apache-2.0
// Who repairs which finding code (agent-runtime.md 4.4b). Moved out of `lead.ts` so the findings
// triage (`findings.ts`, which the UI imports) can read the same registry the Lead dispatches from
// without pulling in the loop: one answer to "is there a repair for this code", not two.

/** Fixer dispatch map (agent-runtime.md §4.4b): code → skill section, or null when not dispatched. */
export const FIXER_MAP: Record<string, { phases: ("pre_apply" | "post_apply")[]; section: string | null; who: "fixer" | "lead" | "librarian" | "none" }> = {
  DANGLING_ENDPOINT: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  DANGLING_BUS_ENTRY: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  DANGLING_BUS: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  GROUP_OVERLAP: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  OUT_OF_FRAME: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  LABEL_OVER_BODY: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  SYMBOL_OVERLAP: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  LABEL_OVERLAP: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  TEXT_OVERLAP: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  FIELD_OVER_OWN_BODY: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  FIELD_OVER_FIELD: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  LABEL_OVER_WIRE: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  POWER_PORT_ORIENTATION: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  OFF_GRID: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  ROW_MISALIGNED: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  // The finding names the cap, its rail and the distance but not the pin it is far from; the Fixer
  // reads that pin off the net itself (sch.net / sch.component) and moves the cap to it. Nothing was
  // registered here before, so a far decoupling cap was reported and then left alone by every pass.
  DECAP_FAR: { phases: ["post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  NO_CONNECT_CONFLICT: { phases: ["pre_apply", "post_apply"], section: "schematic-authoring#layout", who: "fixer" },
  POWER_PORT_STACKED: { phases: ["post_apply"], section: "net-naming#rails", who: "fixer" },
  RAIL_SCOPE_SPLIT: { phases: ["post_apply"], section: "net-naming#rails", who: "fixer" },
  // Not a rail: the fix is a naming decision (global / hierarchical label, or a per-sheet rename),
  // never a power port, so it reads the scope section rather than the rails one.
  LABEL_SCOPE_SPLIT: { phases: ["post_apply"], section: "net-naming#scope", who: "fixer" },
  ERC_POWER_IN_UNDRIVEN: { phases: ["post_apply"], section: "net-naming#rails", who: "fixer" },
  ERC_SINGLE_PIN_NET: { phases: ["post_apply"], section: "net-naming#rails", who: "fixer" },
  ERC_INPUT_FLOATING: { phases: ["post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  ERC_NC_ON_CONNECTED: { phases: ["post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  PINMAP_UNCONNECTED: { phases: ["post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  LONG_WIRE: { phases: ["post_apply"], section: "schematic-authoring#ladder", who: "fixer" },
  DUPLICATE_DESIGNATOR: { phases: ["pre_apply"], section: null, who: "lead" },
  DUPLICATE_DESIGNATOR_PROJECT: { phases: ["pre_apply"], section: null, who: "lead" },
  UNRESOLVED_LIB_ID: { phases: ["pre_apply"], section: null, who: "librarian" },
  SYMBOL_NOT_FOUND: { phases: ["pre_apply"], section: null, who: "librarian" },
  FOOTPRINT_MISSING: { phases: ["pre_apply"], section: null, who: "librarian" },
  UNITS_INCOMPLETE: { phases: ["pre_apply"], section: null, who: "librarian" },
  DUPLICATE_UUID: { phases: [], section: null, who: "none" },
  INVALID_INSTANCES_PATH: { phases: [], section: null, who: "none" },
  // FR-611: no op adds a missing instance-path entry to a placed symbol, so the reused sheet has
  // to be annotated in KiCad or the parts re-placed; the human decides the instance scope.
  INSTANCE_REFS_REQUIRED: { phases: [], section: null, who: "none" },
  // eeschema's pin conflict matrix and its neighbours: which pin moves off the net, which name
  // the rail keeps, and what a symbol's pin type should be are design decisions, not edits a
  // fixer can make blind. Registered so the review card knows the codes; never auto-dispatched.
  ERC_PIN_TO_PIN: { phases: [], section: null, who: "none" },
  ERC_UNSPECIFIED_PIN: { phases: [], section: null, who: "none" },
  ERC_MULTIPLE_NET_NAMES: { phases: [], section: null, who: "none" },
  SHEET_FILE_MISSING: { phases: [], section: null, who: "none" },
  DUPLICATE_SEED: { phases: [], section: null, who: "none" },
};

export function fixerDispatchable(code: string): boolean {
  const m = FIXER_MAP[code];
  return !!m && m.who === "fixer";
}
