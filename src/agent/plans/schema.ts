// SPDX-License-Identifier: Apache-2.0
// DesignPlan schema + validation (workspace-format.md §6). Approval is
// never inside the plan; it lives in the app DB `approvals` table.

import type { Envelope } from "../../ipc/types";
import { MAX_COMPONENTS_PER_BLOCK, MAX_STEPS_PER_PLAN } from "../limits";
import { canonicalOpName, isKnownOp, structuralSatisfiedBy } from "../tools/ops";

/** Whole-name rail patterns (VIN_SENSE / GND_DETECT / VBUS_DET are signals, not rails). Shared by plan validation
 *  and by the interface derivation: a rail is never a sheet-pin interface, it joins sheets through power ports. */
export const RAIL_NAME = /^(GND[A-Z0-9]*|\+[A-Z0-9.]+|-\d[A-Z0-9.]*|(A|D)?V(CC|DD|BUS|BAT|SYS|IN|OUT|EE|SS|DC)(_?\d[A-Z0-9.]*)?)$/i;
export function isRailName(net: string): boolean { return RAIL_NAME.test(net.replace(/^\//, "")); }

/** `derived: true` marks a row `deriveAcceptance` restated from the plan's own declarations. */
export type Acceptance =
  | { type: "pin_on_net"; ref_prefix: string; pin: string; net: string; derived?: boolean }
  | { type: "net_has_pins"; net: string; min: number; derived?: boolean }
  | { type: "nets_disjoint"; nets: string[]; derived?: boolean }
  | { type: "component_count"; prefix: string; in_group?: string; min?: number; max?: number; derived?: boolean }
  | { type: "check_clean"; codes: string[]; derived?: boolean }
  | { type: "decoupling_near"; ref_prefix: string; pin: string; max_dist_mil: number; spec: string; derived?: boolean }
  | { type: "label_on_pin"; ref_prefix: string; pin: string; net: string; derived?: boolean }
  | { type: "no_connect"; ref_prefix: string; pins: string[]; derived?: boolean };

export interface PlanPart {
  ref_prefix: string; lib_id: string; footprint?: string; units_total?: number; lcsc?: string; basic_or_extended?: string; resolved: boolean; facts?: "audited" | "unaudited" | "none";
  /** Component value as it will be drawn (100n, 4k7, AMS1117-3.3); the card shows it so a reviewer can sign off values. */
  value?: string;
  mpn?: string;
}

export interface PlanBlock {
  id: string; sheet: string; summary: string; parts: PlanPart[]; nets_in: string[]; nets_out: string[]; acceptance: Acceptance[]; tags?: string[];
}

export interface PlanStep {
  id: string; block?: string; kind: "draft" | "wiring" | "scaffold" | "gate" | "intent_snapshot" | "source_bom"; nets?: string[]; depends_on?: string[]; structural?: boolean;
  /** Human text for the step when it is not a plain block draft (normalised from title/description). */
  summary?: string;
}

export interface PlanEnvelope {
  budgets: {
    components_added: number; components_deleted: number; components_moved: number;
    objects_deleted: Record<string, number>; wires_added: number; labels_added: number;
    properties_changed: Record<string, number>; transforms_changed: number; attributes_changed: number;
  };
  nets: { rails: string[]; renamable: string[]; may_create_named: boolean };
  structural: string[];
  allowed_ops: string[];
}

export interface DesignPlan {
  schema_version: 1;
  kind: "schematic";
  id: string;
  version: number;
  created: string;
  source: "architect" | "adopt-existing";
  goal: string;
  constraints: string[];
  /** What the Architect assumed because the human did not say (shown separately from the human's constraints). */
  assumptions: string[];
  /** Decisions the Architect left open; the card shows them so the human can answer before adopting. */
  open_questions: string[];
  /** `parent` is the plan sheet whose file carries this sheet symbol (nesting); the root sheet when absent. */
  sheets: { file: string; id?: string; title?: string; role?: string; create?: boolean; paper?: string; parent?: string; instances?: { name: string; at_mil: [number, number] }[] }[];
  interfaces: { net: string; mechanism: string; from?: string; to?: string }[];
  power_tree?: unknown;
  net_naming: { rails: string[]; rail_mechanism: string; prefix_rules?: string };
  conventions: { id: string; text: string; fact_ref?: { mpn: string; page: number; quote: string } }[];
  floorplan: Record<string, { group: string; origin_mil: [number, number]; extent_mil: [number, number] }[]>;
  blocks: PlanBlock[];
  steps: PlanStep[];
  envelope: PlanEnvelope;
  refdes_policy: { frozen_existing: boolean; reuse_freed: boolean };
  budget: { tokens: number | null; cost_usd: number | null; tool_calls: number | null; wall_active_min: number | null };
  display: { status: "draft" | "approved" | "in_progress" | "paused" | "done" | "done_with_skips" | "abandoned"; approved_at: string | null; /** Step progress persisted by the harness (never part of the approval identity). */ progress?: { done: string[]; skipped: string[]; notes?: Record<string, string> } };
}

export function validatePlan(p: unknown): string[] {
  const e: string[] = [];
  const o = p as Partial<DesignPlan>;
  if (!o || typeof o !== "object") return ["plan is not an object"];
  if (o.schema_version !== 1) e.push("schema_version must be 1");
  if (o.kind !== "schematic") e.push("kind must be schematic");
  if (!o.id) e.push("id required");
  if (typeof o.version !== "number") e.push("version required");
  if (!o.goal) e.push("goal required");
  if (!Array.isArray(o.sheets) || !o.sheets.length) e.push("sheets required");
  if (!Array.isArray(o.blocks)) e.push("blocks required");
  else if (o.blocks.length === 0) e.push("blocks must list at least one functional block: blocks:[{id, sheet, summary, parts:[{ref_prefix, lib_id|mpn|value}], nets_in, nets_out}] (the harness draws block by block; a plan without blocks draws nothing)");
  if (!Array.isArray(o.steps)) e.push("steps required");
  if (!o.envelope) e.push("envelope required");
  if (!o.net_naming) e.push("net_naming required");
  const blockIds = new Set<string>();
  for (const b of o.blocks ?? []) {
    // A scaffold-only block (a sheet to create, nothing to draw) may list no parts; every other block places parts.
    const scaffoldOnly = (o.steps ?? []).some((st) => st.block === b.id && st.kind === "scaffold") || (Array.isArray(b.tags) && b.tags.includes("scaffold"));
    if (b && typeof b === "object" && !scaffoldOnly && (!Array.isArray(b.parts) || b.parts.length === 0)) e.push(`block ${String((b as { id?: string }).id ?? "?")} lists no parts: give parts:[{ref_prefix, lib_id (KiCad) or mpn/value}] for every part the block places`);
    if (blockIds.has(b.id)) e.push(`duplicate block ${b.id}`);
    blockIds.add(b.id);
    const n = (b.parts ?? []).reduce((a, x) => a + (x.units_total ?? 1), 0);
    if (n > MAX_COMPONENTS_PER_BLOCK) e.push(`block ${b.id} has ${n} components (> ${MAX_COMPONENTS_PER_BLOCK})`);
    if (!Array.isArray(b.acceptance)) e.push(`block ${b.id} missing acceptance`);
    for (const a of b.acceptance ?? []) if (!ACCEPTANCE_TYPES.has((a as { type: string }).type)) e.push(`block ${b.id}: unknown acceptance type ${(a as { type: string }).type}`);
  }
  if ((o.steps?.length ?? 0) > MAX_STEPS_PER_PLAN) e.push(`more than ${MAX_STEPS_PER_PLAN} steps`);
  const stepIds = new Set((o.steps ?? []).map((s) => s.id));
  for (const s of o.steps ?? []) {
    if (s.block && !blockIds.has(s.block)) e.push(`step ${s.id} references unknown block ${s.block}`);
    for (const d of s.depends_on ?? []) if (!stepIds.has(d)) e.push(`step ${s.id} depends on unknown ${d}`);
  }
  if (o.envelope) {
    if (o.envelope.budgets?.components_deleted === undefined) e.push("envelope.budgets.components_deleted required");
    if (!Array.isArray(o.envelope.allowed_ops)) e.push("envelope.allowed_ops required");
  }
  // A block must sit on a sheet the plan names (a misspelled sheet is not silently re-homed).
  const sheetFiles = new Set((o.sheets ?? []).map((sh) => sh.file));
  for (const b of o.blocks ?? []) if (b?.sheet && sheetFiles.size && !sheetFiles.has(b.sheet)) e.push(`block ${b.id} names sheet ${b.sheet}, which is not in sheets[] (add it with create:true or fix the name)`);
  // A nested sheet hangs under another sheet of the same plan (the root when it says nothing), and
  // the nesting is a tree: a cycle has no file to place the first sheet symbol in.
  const parentOf = new Map<string, string>();
  for (const sh of o.sheets ?? []) {
    if (!sh?.parent) continue;
    if (sh.parent === sh.file) { e.push(`sheet ${sh.file} names itself as its parent`); continue; }
    if (!sheetFiles.has(sh.parent)) { e.push(`sheet ${sh.file} names parent ${sh.parent}, which is not in sheets[]`); continue; }
    parentOf.set(sh.file, sh.parent);
  }
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start]);
    let at = parentOf.get(start);
    while (at) {
      if (seen.has(at)) { e.push(`sheets form a parent cycle at ${at}`); break; }
      seen.add(at);
      at = parentOf.get(at);
    }
  }
  // Rails: any block net that reads as a supply must be declared as a rail, or P3 / P9 have nothing to protect.
  // Whole-name rail patterns: VIN_SENSE / GND_DETECT / VBUS_DET are signals, not rails.
  const railLike = RAIL_NAME;
  const blockNets = new Set<string>();
  for (const b of o.blocks ?? []) for (const n of [...(b.nets_in ?? []), ...(b.nets_out ?? [])]) blockNets.add(String(n));
  const railsDeclared = new Set(o.net_naming?.rails ?? []);
  const undeclared = [...blockNets].filter((n) => railLike.test(n) && !railsDeclared.has(n));
  if (undeclared.length) e.push(`net_naming.rails must list every supply net the blocks use: missing ${undeclared.join(", ")}`);
  // Multi-sheet plans: a net shared by blocks on different sheets is an interface.
  if ((o.sheets?.length ?? 0) > 1) {
    const sheetOfNet = new Map<string, Set<string>>();
    for (const b of o.blocks ?? []) for (const n of [...(b.nets_in ?? []), ...(b.nets_out ?? [])]) (sheetOfNet.get(String(n)) ?? sheetOfNet.set(String(n), new Set()).get(String(n))!).add(b.sheet);
    const declared = new Set((o.interfaces ?? []).map((i) => i.net));
    const missing = [...sheetOfNet.entries()].filter(([n, sh]) => sh.size > 1 && !railsDeclared.has(n) && !declared.has(n)).map(([n]) => n);
    if (missing.length) e.push(`interfaces must name every net that crosses sheets: missing ${missing.join(", ")}`);
  }
  // Acceptance entries need their fields, not only a known type.
  for (const b of o.blocks ?? []) for (const a of b.acceptance ?? []) {
    const x = a as unknown as Record<string, unknown>;
    const need: Record<string, string[]> = { text: ["text"], pin_on_net: ["ref_prefix", "pin", "net"], net_has_pins: ["net", "min"], nets_disjoint: ["nets"], component_count: ["prefix"], check_clean: ["codes"], decoupling_near: ["ref_prefix", "pin", "max_dist_mil"], label_on_pin: ["ref_prefix", "pin", "net"], no_connect: ["ref_prefix", "pins"] };
    const miss = (need[String(x.type)] ?? []).filter((k) => x[k] === undefined || x[k] === "");
    if (miss.length) e.push(`block ${b.id}: acceptance ${String(x.type)} is missing ${miss.join(", ")}`);
  }
  return e;
}

/**
 * Acceptance types the engine can answer: each one is decided by reading a `sch.net` / `gate.run` /
 * `sch.read` result (acceptance.ts). `text` is deliberately outside this set — it is a sentence the
 * architect wrote and evaluates `na` by construction — so a block whose acceptance is all `text` has
 * declared nothing the gate can pass or fail (`uncheckableAcceptanceBlocks`).
 */
export const CHECKABLE_ACCEPTANCE_TYPES: ReadonlySet<string> = new Set(["pin_on_net", "net_has_pins", "nets_disjoint", "component_count", "check_clean", "decoupling_near", "label_on_pin", "no_connect"]);
const ACCEPTANCE_TYPES = new Set<string>([...CHECKABLE_ACCEPTANCE_TYPES, "text"]);

/**
 * Ids of the blocks whose acceptance carries no engine-checkable row (all `text`, or none at all).
 * `plan.write` reports them: a real run finished a plan on eleven `text` rows over a schematic with
 * no symbols in it, and the gate had nothing to say either way.
 */
export function uncheckableAcceptanceBlocks(plan: Pick<DesignPlan, "blocks">): string[] {
  return plan.blocks
    .filter((b) => !(b.acceptance ?? []).some((a) => CHECKABLE_ACCEPTANCE_TYPES.has(String((a as { type?: unknown }).type))))
    .map((b) => b.id);
}

/** Derived rows per block, so a block with many parts cannot crowd the gate report (ACCEPTANCE_MAX). */
export const DERIVED_ACCEPTANCE_MAX = 12;

/**
 * Acceptance the harness restates from a block's own declarations, for a block that declared nothing
 * the engine can check (all `text`, or none at all — real runs keep writing prose there even after the
 * schema hint listed the typed rows first).
 *
 * A restatement is not a judgement. Every row here repeats something the plan already wrote down — a
 * part the block places, a net it names — in one of the typed shapes `acceptance.ts` decides from
 * engine results, and the verdict stays entirely the engine's (red line 6). Nothing electrical is
 * inferred: no value, no polarity, no topology, no ERC expectation, and no prose is parsed.
 *
 * Two sources:
 *   - `parts` -> `component_count {prefix, min}`, one row per reference prefix, `min` = how many parts
 *     the block declares with it. `min` only: the engine attributes no symbol to a block, so counts are
 *     project-wide and a maximum would fail on another block's parts. Power symbols (`#PWR`, `#FLG`)
 *     are skipped here — the evaluator can count them (from the engine's symbol list), but the drawing
 *     rules place them, not the block's bill of parts, so the harness restates no threshold for them.
 *   - nets -> `net_has_pins {net, min: 2}` for every net the block exports (`nets_out`) and every rail
 *     or declared interface it consumes (`nets_in`). A rail joins sheets on a power port of the same
 *     name, so its members are what the engine can report for "the rail reaches this block"; a net that
 *     joins fewer than two pins is not a connection at all.
 * Neither can pass vacuously: both need the netlist the engine built after the block was drawn.
 */
export function deriveAcceptance(
  block: Pick<PlanBlock, "parts" | "nets_in" | "nets_out">,
  ctx: { rails?: readonly string[]; interfaces?: readonly string[] } = {},
): Acceptance[] {
  const out: Acceptance[] = [];
  const counts = new Map<string, number>();
  for (const p of block.parts ?? []) {
    const prefix = String((p as { ref_prefix?: unknown })?.ref_prefix ?? "").trim().toUpperCase();
    if (!prefix || prefix.startsWith("#") || !/^[A-Z][A-Z0-9]*$/.test(prefix)) continue;
    // A part from the `power:` library is a net anchor (power port, PWR_FLAG), whatever prefix the plan
    // gave it: `sch-net` keeps such symbols out of every net's members, so a count read off the netlist
    // is 0 by construction and the derived row could only ever fail. A real plan listed
    // `{ref_prefix:"PWR", lib_id:"power:PWR_FLAG"}` and the gate reported `component_count PWR >= 1: 0`
    // over a sheet carrying two of them.
    if (/^power:/i.test(String((p as { lib_id?: unknown })?.lib_id ?? "").trim())) continue;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, min] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    out.push({ type: "component_count", prefix, min, derived: true });
  }
  const named = new Set<string>();
  for (const list of [ctx.rails ?? [], ctx.interfaces ?? []]) for (const n of list) named.add(String(n).trim().replace(/^\/+/, ""));
  const seen = new Set<string>();
  const nets: string[] = [];
  const push = (raw: unknown, consumed: boolean): void => {
    const net = String(raw ?? "").trim();
    if (!net) return;
    const key = net.replace(/^\/+/, "");
    // A consumed net is only restated when the plan itself says it comes from somewhere (a rail or a
    // declared interface); anything else may be internal to another block and is left to the Architect.
    if (consumed && !named.has(key) && !isRailName(key)) return;
    if (seen.has(key)) return;
    seen.add(key);
    nets.push(net);
  };
  for (const n of block.nets_out ?? []) push(n, false);
  for (const n of block.nets_in ?? []) push(n, true);
  for (const net of nets) out.push({ type: "net_has_pins", net, min: 2, derived: true });
  return out.slice(0, DERIVED_ACCEPTANCE_MAX);
}

/**
 * The plan with `deriveAcceptance` rows appended to every block that declared nothing checkable. The
 * Architect's own rows are kept in front of them, `text` sentences included: they are what the human
 * reads on the card, they are simply not what the gate reports on. Idempotent — a block that already
 * carries a checkable row (derived or written) gets nothing added.
 */
export function withDerivedAcceptance(plan: DesignPlan): DesignPlan {
  const ctx = { rails: plan.net_naming?.rails ?? [], interfaces: (plan.interfaces ?? []).map((i) => i.net) };
  const uncheckable = new Set(uncheckableAcceptanceBlocks(plan));
  if (!uncheckable.size) return plan;
  return {
    ...plan,
    blocks: plan.blocks.map((b) => (uncheckable.has(b.id) ? { ...b, acceptance: [...(b.acceptance ?? []), ...deriveAcceptance(b, ctx)] } : b)),
  };
}

/** How many acceptance rows of a plan the harness derived (`plan.write` reports it back to the model). */
export function derivedAcceptanceCount(plan: Pick<DesignPlan, "blocks">): number {
  return plan.blocks.reduce((n, b) => n + (b.acceptance ?? []).filter((a) => (a as { derived?: unknown }).derived === true).length, 0);
}

/**
 * The plan sheets whose sheet *symbol* is drawn on `parentFile`: the ones that name it as their parent,
 * plus (for the plan's root file) the ones that name no parent at all. Only files the plan declares are
 * ever returned — the approved plan is the upper bound of every scope derived from it.
 */
export function childSheetFiles(plan: DesignPlan, parentFile: string): string[] {
  const root = plan.sheets[0]?.file;
  return plan.sheets.filter((s) => s.file !== parentFile && (s.parent ? s.parent === parentFile : parentFile === root)).map((s) => s.file);
}

/** Envelope (ceiling) for one step: block scope ∩ plan envelope. */
export function stepEnvelope(plan: DesignPlan, step: PlanStep): Envelope {
  const block = step.block ? plan.blocks.find((b) => b.id === step.block) : undefined;
  // A scaffold step places sheet symbols in the parent (the root) and creates the child files: it needs every
  // plan sheet in scope, not only its block's sheet (Rust checks sheet.create against the parent file).
  // Every other step also reaches the child files whose sheet symbol sits on its own sheet: `add_sheet_pin`
  // seeds the matching hierarchical label inside the child, so a step that touches a sheet symbol writes two
  // files. Leaving the child out refused the whole apply with ENVELOPE_SHEET_UNDECLARED (real run 17, turn 3).
  const sheets = block && step.kind !== "scaffold" ? [block.sheet, ...childSheetFiles(plan, block.sheet)] : plan.sheets.map((s) => s.file);
  const structural = step.kind === "scaffold" || step.structural ? plan.envelope.structural : [];
  const partsCount = block ? block.parts.reduce((a, x) => a + (x.units_total ?? 1), 0) : 0;
  // The scaffold creates sheets and their pins whatever the plan's op list says (a real run's scaffold step was
  // refused with "add_sheet is not in allowed_ops").
  const allowedOps = step.kind === "scaffold" ? Array.from(new Set([...plan.envelope.allowed_ops, "add_sheet", "add_sheet_pin"])) : plan.envelope.allowed_ops;
  // A block step may re-pose and re-label the parts of its block; a step without a block (gate, wiring)
  // reaches every part the plan draws. Both are the plan's own numbers, not the model's.
  const editable = block ? partsCount : plan.blocks.reduce((a, b) => a + b.parts.reduce((x, p) => x + (p.units_total ?? 1), 0), 0);
  return {
    sheets,
    allowed_ops: allowedOps,
    components_added_max: block ? Math.min(plan.envelope.budgets.components_added, Math.max(partsCount + 4, 12)) : step.kind === "wiring" ? 4 : plan.envelope.budgets.components_added,
    components_deleted_max: plan.envelope.budgets.components_deleted,
    wires_max: plan.envelope.budgets.wires_added,
    structural,
    nets_renamable: plan.envelope.nets.renamable,
    properties_changed_max: editBudget([], editable),
    components_moved_max: editBudget([], editable),
    refs_editable: [],
    rails: plan.net_naming.rails,
    interfaces: plan.interfaces.map((i) => i.net),
    instance_designators: {},
    source: `plan:${plan.id}@${plan.version}/${step.id}`,
  };
}

/** Declaration ∩ ceiling: the declaration may only shrink. */
export function intersectEnvelope(ceiling: Envelope, decl: Partial<Envelope> | null): { env: Envelope; widened: string[] } {
  if (!decl) return { env: ceiling, widened: [] };
  const widened: string[] = [];
  const sub = (k: "sheets" | "allowed_ops" | "nets_renamable"): string[] => {
    const d = decl[k];
    if (!d) return ceiling[k];
    const extra = d.filter((x) => !ceiling[k].includes(x));
    if (extra.length && !(k === "allowed_ops" && ceiling.allowed_ops.length === 0)) widened.push(`${k}: ${extra.join(", ")}`);
    return d.filter((x) => ceiling[k].includes(x) || (k === "allowed_ops" && ceiling.allowed_ops.length === 0));
  };
  /**
   * Structural entries are verb[:file], so a bare `create_sheet` in the declaration is satisfied by the
   * ceiling's `create_sheet:power.kicad_sch` rather than being a widening (golden power_subsheet raised a
   * scope card for a sheet the human's own message had named). The kept entries are the *ceiling's*
   * spellings, so the effective envelope never carries a string the ceiling does not.
   */
  const structural = (): string[] => {
    const d = decl.structural;
    if (!d) return ceiling.structural;
    const kept: string[] = [];
    const extra: string[] = [];
    for (const x of d) {
      const hits = structuralSatisfiedBy(ceiling.structural, x);
      if (hits.length) kept.push(...hits); else extra.push(x);
    }
    if (extra.length) widened.push(`structural: ${extra.join(", ")}`);
    return [...new Set(kept)];
  };
  const num = (k: "components_added_max" | "components_deleted_max" | "properties_changed_max" | "components_moved_max"): number => {
    const d = decl[k];
    if (d === undefined) return ceiling[k];
    if (d > ceiling[k]) widened.push(`${k}: ${d} > ${ceiling[k]}`);
    return Math.min(d, ceiling[k]);
  };
  // `refs_editable` is the ceiling's: it comes from the human's message, never from the declaration.
  const env: Envelope = {
    ...ceiling,
    sheets: sub("sheets"), allowed_ops: sub("allowed_ops"), structural: structural(), nets_renamable: sub("nets_renamable"),
    components_added_max: num("components_added_max"), components_deleted_max: num("components_deleted_max"),
    properties_changed_max: num("properties_changed_max"), components_moved_max: num("components_moved_max"),
    wires_max: decl.wires_max === undefined || decl.wires_max === null ? ceiling.wires_max : ceiling.wires_max === null ? decl.wires_max : Math.min(decl.wires_max, ceiling.wires_max),
  };
  return { env, widened };
}

/**
 * The session ceiling. `sheets` and `rails` are *copied*: callers extend the returned envelope in place
 * (turn.begin adds the sheet files the human's own message named), and holding the caller's array meant
 * that push also landed in the project's sheet list — so the "does this file exist yet?" test one line
 * later answered yes and the `create_sheet:` entry that makes the new sheet legal was never added.
 */
export function sessionCeiling(componentsAdded: number, sheets: string[], rails: string[], named: string[] = []): Envelope {
  return { sheets: [...sheets], allowed_ops: [], components_added_max: componentsAdded, components_deleted_max: 0, wires_max: null, structural: [], nets_renamable: [], properties_changed_max: editBudget(named, componentsAdded), components_moved_max: editBudget(named, componentsAdded), refs_editable: [...named], rails: [...rails], interfaces: [], instance_designators: {}, source: "session_ceiling" };
}

/** An edit or move budget is never below this, so a turn that names one part can still touch its neighbour. */
export const EDIT_BUDGET_MIN = 4;

/**
 * How many property edits / moves a turn may make (red line 13: a bound the model did not produce).
 * Twice the parts the human named, never below `EDIT_BUDGET_MIN`, and never below the parts the turn
 * may add -- a turn that draws N parts may also re-pose and re-label those N (the stylist pass does).
 */
export function editBudget(named: string[], componentsAdded = 0): number {
  return Math.max(EDIT_BUDGET_MIN, 2 * named.length, componentsAdded);
}

/** Plan-card summary computed deterministically (no model). */
export function planSummary(p: DesignPlan): Record<string, unknown> {
  return {
    goal: p.goal,
    files: p.sheets.map((s) => s.file + (s.create ? " (new)" : "")),
    max_added: p.envelope.budgets.components_added,
    max_deleted: p.envelope.budgets.components_deleted,
    structural: p.envelope.structural,
    rails: p.net_naming.rails,
    blocks: p.blocks.map((b) => ({ id: b.id, parts: b.parts.length, unresolved: b.parts.filter((x) => !x.resolved).length, no_datasheet: b.parts.filter((x) => x.facts === "none").length })),
    steps: p.steps.length,
    budget: p.budget,
  };
}

/** Field-by-field diff between plan versions for the plan-change card. */
export function planDiff(a: DesignPlan, b: DesignPlan): { field: string; before: unknown; after: unknown }[] {
  const out: { field: string; before: unknown; after: unknown }[] = [];
  const cmp = (field: string, x: unknown, y: unknown) => { if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field, before: x, after: y }); };
  cmp("goal", a.goal, b.goal);
  cmp("sheets", a.sheets, b.sheets);
  cmp("envelope.budgets", a.envelope.budgets, b.envelope.budgets);
  cmp("envelope.structural", a.envelope.structural, b.envelope.structural);
  cmp("envelope.nets", a.envelope.nets, b.envelope.nets);
  cmp("net_naming.rails", a.net_naming.rails, b.net_naming.rails);
  cmp("blocks", a.blocks.map((x) => x.id), b.blocks.map((x) => x.id));
  cmp("steps", a.steps.map((x) => x.id), b.steps.map((x) => x.id));
  return out;
}

/** plan.propose_change may never widen deletions or rails (agent-runtime §6.1). */
export function changeAllowed(a: DesignPlan, changes: Partial<DesignPlan>): string[] {
  const p: string[] = [];
  const del = changes.envelope?.budgets?.components_deleted;
  if (del !== undefined && del > a.envelope.budgets.components_deleted) p.push("cannot widen components_deleted");
  const rails = changes.net_naming?.rails;
  if (rails && rails.some((r) => !a.net_naming.rails.includes(r))) p.push("cannot add rails");
  const objDel = changes.envelope?.budgets?.objects_deleted;
  if (objDel) for (const [k, v] of Object.entries(objDel)) if (v > (a.envelope.budgets.objects_deleted[k] ?? 0)) p.push(`cannot widen objects_deleted.${k}`);
  return p;
}

/** Plan snapshot text for cache breakpoint B (deterministic). */
export function planSnapshotText(p: DesignPlan): string {
  return JSON.stringify({
    id: p.id, version: p.version, goal: p.goal, constraints: p.constraints, sheets: p.sheets, interfaces: p.interfaces,
    rails: p.net_naming.rails, conventions: p.conventions, floorplan: p.floorplan,
    blocks: p.blocks.map((b) => ({ id: b.id, sheet: b.sheet, summary: b.summary, parts: b.parts, nets_in: b.nets_in, nets_out: b.nets_out, acceptance: b.acceptance })),
    steps: p.steps, envelope: p.envelope,
  });
}


/**
 * The package as an engineer says it, read off the KiCad footprint name: `C_0603_1608Metric` -> `0603`,
 * `SOT-223-3_TabPin2` -> `SOT-223`, `PinHeader_1x04_P2.54mm_Vertical` -> `1x04 2.54mm`. Purely textual
 * and deterministic — no library lookup, and no judgement about whether that package suits the part
 * (red line 6). A name none of the three rules recognise keeps its own text without the library prefix.
 */
export function footprintShortName(footprint: string): string {
  const name = String(footprint ?? "").trim().replace(/^.*:/, "");
  if (!name) return "";
  // Two-size chip packages carry the imperial code first: `C_0603_1608Metric`, `LED_0402_1005Metric`.
  const chip = /^[A-Za-z]+_(\d{4})_\d+Metric/.exec(name);
  if (chip) return chip[1];
  // Headers and sockets are read as grid plus pitch: `PinHeader_1x04_P2.54mm_Vertical`.
  const grid = /(?:^|_)(\d+x\d+)(?:_|$)/.exec(name);
  const pitch = /_P([\d.]+mm)/.exec(name);
  if (grid && pitch) return `${grid[1]} ${pitch[1]}`;
  // A family with a pin count and a variant (`SOT-223-3_TabPin2`): drop the variant, then the count.
  const head = name.split("_")[0];
  const dashed = head.split("-");
  if (dashed.length >= 3 && /^\d+$/.test(dashed[dashed.length - 1])) return dashed.slice(0, -1).join("-");
  return name;
}

/**
 * `R 4k7 Device:R 0603` — value first (what a reviewer signs off), then symbol and package. One label
 * for the plan everywhere it is read: the markdown body, the plan panel's steps and the authority
 * summary on the plan card, so the same part never reads two ways on one card.
 */
export function partLabel(x: PlanPart): string {
  const q = x as unknown as Record<string, unknown>;
  const value = [x.value, q.mpn, q.description].find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;
  const sym = typeof x.lib_id === "string" && x.lib_id.trim() ? x.lib_id : (typeof q.lcsc === "string" ? String(q.lcsc) : undefined);
  const fp = typeof x.footprint === "string" && x.footprint.trim() ? ` ${footprintShortName(x.footprint)}` : "";
  const what = [value, sym].filter(Boolean).join(" ");
  return `${x.ref_prefix ?? "?"} ${what || "?"}${fp}${x.units_total && x.units_total > 1 ? ` ×${x.units_total}` : ""}${x.resolved ? "" : " (unresolved)"}`;
}

/**
 * Generic passive symbols draw the same body whatever package the board uses (`Device:R`, `Device:C`,
 * `Device:L`, `Device:LED` and their `_Small` / `_Polarized` variants), so a plan that leaves their
 * `footprint` out has not said which package it means — the human asked for 0603 and the card showed
 * `C 10uF Device:C` (real runs 17 and 18). Reported as a warning, never an error: the plan stays
 * writable and the drafter can still place the symbol.
 */
const GENERIC_PASSIVE_LIB_ID = /^device:(r|c|l|led)(_.+)?$/i;
export function missingFootprintParts(plan: Pick<DesignPlan, "blocks">): string[] {
  const out: string[] = [];
  for (const b of plan.blocks ?? []) {
    for (const p of b.parts ?? []) {
      const libId = typeof p.lib_id === "string" ? p.lib_id.trim() : "";
      if (!GENERIC_PASSIVE_LIB_ID.test(libId)) continue;
      if (typeof p.footprint === "string" && p.footprint.trim()) continue;
      out.push(`${b.id}/${p.ref_prefix ?? "?"}${p.value ? ` ${p.value}` : ""}: ${libId}`);
    }
  }
  return out;
}

/**
 * One acceptance row as text, in the same shape `acceptance.ts` labels it with when the engine decides
 * it, so the plan card and the gate report read alike. A restatement of what the plan declared, never a
 * verdict of the harness's own (red line 6).
 */
export function acceptanceLabel(a: Acceptance): string {
  const x = a as unknown as Record<string, unknown>;
  const s = (k: string) => String(x[k] ?? "");
  const up = (k: string) => s(k).toUpperCase();
  const list = (k: string) => (Array.isArray(x[k]) ? (x[k] as unknown[]) : []).map(String).join(", ");
  switch (String(x.type ?? "")) {
    case "pin_on_net": return `pin_on_net ${up("ref_prefix")}.${s("pin")} = ${s("net")}`;
    case "net_has_pins": return `net_has_pins ${s("net")} >= ${Number(x.min ?? 0)}`;
    case "nets_disjoint": return `nets_disjoint ${list("nets")}`;
    case "component_count": {
      const min = x.min === undefined ? null : Number(x.min);
      const max = x.max === undefined ? null : Number(x.max);
      const bounds = min !== null && max !== null ? `${min}..${max}` : min !== null ? `>= ${min}` : max !== null ? `<= ${max}` : "any";
      return `component_count ${up("prefix")} ${bounds}`;
    }
    case "check_clean": return `check_clean ${list("codes")}`;
    case "decoupling_near": return `decoupling_near ${up("ref_prefix")}.${s("pin")} <= ${Number(x.max_dist_mil ?? 0)}mil${x.spec ? ` ${s("spec")}` : ""}`;
    case "label_on_pin": return `label_on_pin ${up("ref_prefix")}.${s("pin")} = ${s("net")}`;
    case "no_connect": return `no_connect ${up("ref_prefix")}.${list("pins")}`;
    case "text": return s("text");
    default: return String(x.type ?? "");
  }
}

/**
 * A block's acceptance for the plan card and the plan panel: label, type and whether the harness
 * derived the row, in plan order. `type: "text"` rows are informational (the gate can neither pass nor
 * fail them) and the card says so.
 */
export function acceptanceRows(block: Pick<PlanBlock, "acceptance">): { label: string; type: string; derived: boolean }[] {
  return (block.acceptance ?? []).map((a) => ({
    label: acceptanceLabel(a),
    type: String((a as { type?: unknown }).type ?? ""),
    derived: (a as { derived?: unknown }).derived === true,
  }));
}

/**
 * The sheets a plan step draws on, as sheet stems (`power.kicad_sch` -> `power`), for the step line of
 * the plan card: a block step names its block's sheet, a scaffold names the sheets it creates, and a
 * step that binds to no block (wiring, gate) names every sheet the plan's blocks sit on. A reviewer of
 * run 18 could not tell from the card that the connector and the LED were both going on `power`.
 */
export function stepSheets(p: DesignPlan, s: PlanStep): string[] {
  const stem = (file: string) => (file.split("/").pop() ?? file).replace(/\.kicad_sch$/, "");
  const block = s.block ? p.blocks.find((b) => b.id === s.block) : undefined;
  if (block?.sheet) return [stem(block.sheet)];
  const created = p.sheets.filter((sh) => sh.create).map((sh) => stem(sh.file));
  if (s.kind === "scaffold" && created.length) return created;
  const used = p.blocks.map((b) => b.sheet).filter(Boolean).map(stem);
  const all = used.length ? used : p.sheets.map((sh) => stem(sh.file));
  return [...new Set(all)];
}

/** Constraints / risks arrive as strings or as objects ({text}, {constraint}, {rule}, {id, description} ...). */
export function textList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") { if (x.trim()) out.push(x.trim()); continue; }
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const main = [o.text, o.constraint, o.rule, o.description, o.summary, o.title, o.statement, o.requirement].find((s) => typeof s === "string" && (s as string).trim()) as string | undefined;
    if (main) { out.push(main.trim()); continue; }
    const pairs = Object.entries(o).filter(([, val]) => typeof val === "string" || typeof val === "number").map(([k, val]) => `${k}: ${String(val)}`);
    if (pairs.length) out.push(pairs.join("; "));
  }
  return out;
}

/** Human-readable plan (user language comes from the model's own wording in goal/summaries). */
export function planMarkdown(p: DesignPlan, progress?: { done: Set<string>; skipped: Set<string>; current: string | null }): string {
  const blockOf = (id?: string) => p.blocks.find((b) => b.id === id);
  const lines: string[] = [];
  lines.push(`**${p.goal}**`);
  if (p.constraints.length) lines.push("", ...p.constraints.map((c) => `- ${c}`));
  if (p.net_naming.rails.length) lines.push("", `Rails: ${p.net_naming.rails.map((r) => `\`${r}\``).join(", ")}`);
  if (p.interfaces?.length) lines.push(`Interfaces: ${p.interfaces.map((i) => `\`${i.net}\`${i.from || i.to ? ` (${i.from ?? "?"} -> ${i.to ?? "?"})` : ""}`).join(", ")}`);
  if (p.assumptions?.length) lines.push("", "Assumed (not stated by you):", ...p.assumptions.map((a) => `- ${a}`));
  // `open_questions` is deliberately not in the body: the plan card renders it as answerable fields
  // and the plan panel as its own section, so a markdown copy would only duplicate them.
  lines.push("");
  p.steps.forEach((s, i) => {
    const b = blockOf(s.block);
    const mark = progress?.done.has(s.id) ? "[x]" : progress?.skipped.has(s.id) ? "[-]" : progress?.current === s.id ? "[>]" : "[ ]";
    const parts = b?.parts?.length ? ` — ${b.parts.map(partLabel).join(", ")}` : "";
    // Which sheet the step writes to, in one constant format: a multi-sheet plan whose steps do not say
    // it reads as if everything landed on the root.
    const sheets = stepSheets(p, s);
    const on = sheets.length ? ` — on ${sheets.join(", ")}` : "";
    lines.push(`${i + 1}. ${mark} ${s.summary ?? b?.summary ?? s.kind ?? s.id}${on}${parts}`);
  });
  const budget = p.budget;
  if (budget.cost_usd !== null || budget.tokens !== null) lines.push("", `Budget: ${budget.cost_usd !== null ? `$${budget.cost_usd}` : ""}${budget.tokens !== null ? ` / ${budget.tokens} tokens` : ""}`.trim());
  return lines.join("\n");
}

export function planView(p: DesignPlan, progress: { done: Set<string>; skipped: Set<string>; current: string | null; notes?: Map<string, string> }): import("../api").PlanView {
  const blockOf = (id?: string) => p.blocks.find((b) => b.id === id);
  return {
    id: p.id, version: p.version, status: p.display.status, goal: p.goal, constraints: p.constraints,
    // Both survive adoption: the panel keeps showing what was assumed and what is still open, which
    // the plan card's markdown body could not (it scrolls away with the turn that produced it).
    assumptions: p.assumptions ?? [], open_questions: p.open_questions ?? [],
    rails: p.net_naming.rails,
    steps: p.steps.map((s) => { const b = blockOf(s.block); const note = progress.notes?.get(s.id); return { id: s.id, kind: s.kind, block: s.block, summary: s.summary ?? b?.summary ?? s.kind ?? s.id, parts: (b?.parts ?? []).map(partLabel), status: progress.done.has(s.id) ? "done" : progress.skipped.has(s.id) ? "skipped" : progress.current === s.id ? "current" : "pending", ...(note ? { note } : {}) }; }),
    budget: { tokens: p.budget.tokens, cost_usd: p.budget.cost_usd },
    body_md: planMarkdown(p, progress),
    blocks: p.blocks.map((b) => {
      const fp = (p.floorplan[b.sheet] ?? []).find((g) => g.group === b.id);
      const region: [[number, number], [number, number]] | null = fp ? [[fp.origin_mil[0], fp.origin_mil[1]], [fp.origin_mil[0] + fp.extent_mil[0], fp.origin_mil[1] + fp.extent_mil[1]]] : null;
      const step = p.steps.find((s) => s.block === b.id && (s.kind === "draft" || !s.kind));
      // The acceptance travels with the block so the card and the panel can show what the step will be
      // measured by; the verdict still only ever comes from the engine at the gate step (red line 6).
      return { id: b.id, sheet: b.sheet, step_id: step?.id ?? null, region_mil: region, summary: b.summary, acceptance: acceptanceRows(b) };
    }),
  };
}

/**
 * Answers to `open_questions`, keyed by the question's index in the plan the card carries, as the
 * plan card's free text. Empty answers are dropped, so a card with nothing typed sends nothing.
 */
export function openQuestionPayload(answers: Record<string, string>): string {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) { const s = String(v ?? "").trim(); if (s) kept[k] = s; }
  return Object.keys(kept).length ? JSON.stringify({ open_question_answers: kept }) : "";
}

/** Reads `openQuestionPayload` back; anything that is not that shape is null (a waiver payload, prose). */
export function parseOpenQuestionAnswers(free_text: string | null | undefined): Record<string, string> | null {
  if (!free_text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(free_text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const a = (parsed as { open_question_answers?: unknown }).open_question_answers;
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) { const s = String(v ?? "").trim(); if (s) out[k] = s; }
  return Object.keys(out).length ? out : null;
}

/**
 * Fold the human's answers into the plan before it is frozen. The schema has no separate decisions
 * list, so an answered question becomes a constraint — inside the approved content the approval sha
 * covers and the drafter briefs read — and leaves `open_questions`. Blank answers keep their
 * question open: adopting with questions unanswered is allowed, it is only said out loud.
 */
export const OPEN_QUESTION_JOIN = " -> ";
export function applyOpenQuestionAnswers(plan: DesignPlan, answers: Record<string, string>): DesignPlan {
  const open = plan.open_questions ?? [];
  const kept: string[] = [];
  const decided: string[] = [];
  open.forEach((q, i) => {
    const a = String(answers[String(i)] ?? "").trim();
    if (a) decided.push(`${q}${OPEN_QUESTION_JOIN}${a}`); else kept.push(q);
  });
  if (!decided.length) return plan;
  return { ...plan, constraints: [...plan.constraints, ...decided], open_questions: kept };
}

/** Apply a plan-panel edit (goal / constraints / step summaries) to a plan copy. */
export function applyPlanPatch(p: DesignPlan, patch: { goal?: string; constraints?: string[]; steps?: { id: string; summary: string }[] }): DesignPlan {
  const next: DesignPlan = JSON.parse(JSON.stringify(p));
  if (typeof patch.goal === "string" && patch.goal.trim()) next.goal = patch.goal.trim();
  if (Array.isArray(patch.constraints)) next.constraints = patch.constraints.map((c) => String(c).trim()).filter(Boolean);
  if (Array.isArray(patch.steps)) for (const e of patch.steps) { const st = next.steps.find((s) => s.id === e.id); if (st && typeof e.summary === "string" && e.summary.trim()) st.summary = e.summary.trim(); }
  return next;
}


/** Compact schema text handed back on PLAN_INVALID so the model can self-correct in one retry. */
export const PLAN_SCHEMA_HINT = `DesignPlan = {schema_version:1, kind:"schematic", id, version:number, goal, assumptions:string[], open_questions:string[], sheets:[{file, create?, paper?, parent? (the plan sheet this one hangs under; the root sheet when absent), instances?:[{name, at_mil}] (a sheet file placed more than once: one entry per instance; parts on it then need instance_designators)}], net_naming:{rails:string[] (every supply net the blocks use), rail_mechanism:"power_port"}, interfaces:[{net, from, to}] (nets crossing sheets), blocks:[{id, sheet, summary, parts:[{ref_prefix, lib_id (verified against the libraries by the harness), value, footprint (the KiCad footprint name as the drafter will place it, e.g. "Resistor_SMD:R_0603_1608Metric"; generic passives - Device:R, Device:C, Device:L, Device:LED - need one, they draw the same symbol in every package, and the human reads the package off the plan card)}], nets_in:string[], nets_out:string[], acceptance:[{type:"pin_on_net",ref_prefix,pin,net}|{type:"net_has_pins",net,min}|{type:"nets_disjoint",nets}|{type:"component_count",prefix,min?,max?}|{type:"check_clean",codes}|{type:"decoupling_near",ref_prefix,pin,max_dist_mil,spec}|{type:"label_on_pin",ref_prefix,pin,net}|{type:"no_connect",ref_prefix,pins}|{type:"text",text}] (the typed rows are the ones the engine checks; give every block at least one of them. A "text" row is informational only: the gate can neither pass nor fail it, so a block with only text rows is never verified. A component_count prefix may be a power prefix ("#PWR", "#FLG"): power symbols carry no netlist reference, so component_count is how a plan asserts one exists, and pin_on_net with such a prefix asks whether one sits on that net)}], steps:[{id, block, kind:"draft"|"wiring"|"scaffold"|"gate"}], envelope:{allowed_ops:string[] (opspec v1 op names exactly, as your brief lists them; invented names are dropped and reported back), budgets:{components_added,components_deleted,wires_added,labels_added}, nets:{rails,renamable,may_create_named}, structural:string[]}}. Optional fields (constraints, interfaces, conventions, floorplan, budget, refdes_policy, display) are filled in for you.`;

/**
 * Plan sheets arrive as `{file}`, `{id,title}`, `{path}` or bare strings; every
 * entry becomes `{file: "<name>.kicad_sch", ...}` or is dropped. A sheet the
 * architect only named (no `file`) is assumed new (`create: true`) unless it
 * says otherwise; the Lead reconciles `create` against the project files.
 */
export function normalizeSheets(v: unknown): DesignPlan["sheets"] {
  if (!Array.isArray(v)) return [];
  const out: DesignPlan["sheets"] = [];
  for (const raw of v) {
    const s = (typeof raw === "string" ? { file: raw } : raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : null) as Record<string, unknown> | null;
    if (!s) continue;
    const name = [s.file, s.path, s.filename, s.name, s.id].find((x) => typeof x === "string" && (x as string).trim()) as string | undefined;
    if (!name) continue;
    let file = name.trim().replace(/^\/+/, "");
    if (!file.endsWith(".kicad_sch")) file = `${file}.kicad_sch`;
    const create = typeof s.create === "boolean" ? s.create : typeof s.file !== "string";
    const p = [s.parent, s.parent_sheet, s.under].find((x) => typeof x === "string" && (x as string).trim()) as string | undefined;
    let parent = p ? p.trim().replace(/^\/+/, "") : undefined;
    if (parent && !parent.endsWith(".kicad_sch")) parent = `${parent}.kicad_sch`;
    out.push({ ...(s as object), file, create, ...(parent ? { parent } : {}) } as DesignPlan["sheets"][number]);
  }
  return out;
}

/**
 * Interfaces are the nets that cross sheets as a sheet pin or a global label. A rail never is one: both
 * sides carry it on a power port (`net_naming.rail_mechanism`), so a rail listed here would become a
 * dangling sheet pin and would invite an `add_sheet_pin` no drafting step needs. Dropped here as well as
 * in `sheetInterfaces`, so the plan card, `stepEnvelope().interfaces` and the scaffold all agree.
 * Entries arrive as `{net}`, `{name}`, `{signal}` or a bare string.
 */
export function normalizeInterfaces(v: unknown, rails: string[]): DesignPlan["interfaces"] {
  if (!Array.isArray(v)) return [];
  const declared = new Set(rails.map((r) => String(r).replace(/^\//, "")));
  const out: DesignPlan["interfaces"] = [];
  for (const raw of v) {
    const o = (typeof raw === "string" ? { net: raw } : raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null);
    if (!o) continue;
    const net = String([o.net, o.name, o.signal].find((x) => typeof x === "string" && (x as string).trim()) ?? "").trim().replace(/^\//, "");
    if (!net || declared.has(net) || isRailName(net)) continue;
    out.push({ ...(o as object), net } as DesignPlan["interfaces"][number]);
  }
  return out;
}

/**
 * The sheets a scaffold step creates, parents before children: a nested sheet's symbol is drawn in
 * its parent's file, so that file has to exist first. Sheets whose parent is not created by this
 * scaffold (the root, or a file the project already has) keep the plan's own order. Cycle-safe:
 * validation refuses a parent cycle, and a plan that slipped through still creates every sheet once.
 */
export function scaffoldOrder(plan: DesignPlan): DesignPlan["sheets"] {
  const create = plan.sheets.filter((s) => s.create);
  const pending = new Map(create.map((s) => [s.file, s]));
  const out: DesignPlan["sheets"] = [];
  const done = new Set<string>();
  const emit = (sh: DesignPlan["sheets"][number], seen: Set<string>): void => {
    if (done.has(sh.file) || seen.has(sh.file)) return;
    seen.add(sh.file);
    const parent = sh.parent ? pending.get(sh.parent) : undefined;
    if (parent) emit(parent, seen);
    if (done.has(sh.file)) return;
    done.add(sh.file);
    out.push(sh);
  };
  for (const sh of create) emit(sh, new Set());
  return out;
}

/**
 * Bind the plan's sheet names to the project: `root` / `/` / `main` (or a name
 * that is not a project file when the project has a single sheet) mean the
 * root file; existing files are never "created"; the rest are new sheets.
 * Block `sheet` fields are remapped the same way.
 */
export function reconcileSheets(plan: DesignPlan, existing: string[]): DesignPlan {
  const root = existing[0];
  if (!root) return plan;
  const rootAliases = new Set(["root.kicad_sch", "main.kicad_sch", "/.kicad_sch", "sheet1.kicad_sch", "top.kicad_sch"]);
  const map = new Map<string, string>();
  // A plan that names its own top sheet (a new file with no parent that other plan sheets hang under, while
  // nothing in the plan uses the project's real root) is describing the root under another name: the
  // project has one root and a plan cannot create a second. A real run planned `sensor_board.kicad_sch` as
  // "the root sheet" beside the existing root, every draft then failed on the missing file.
  const usesRoot = plan.sheets.some((sh) => sh.file === root) || plan.blocks.some((b) => b.sheet === root);
  const topNew = plan.sheets.filter((sh) => !existing.includes(sh.file) && !sh.parent && !rootAliases.has(sh.file.toLowerCase()));
  const parentsNamed = new Set(plan.sheets.map((sh) => sh.parent).filter((x): x is string => !!x));
  const impliedRoot = !usesRoot && topNew.length === 1 && (parentsNamed.has(topNew[0].file) || plan.sheets.length === 1) ? topNew[0].file : null;
  for (const sh of plan.sheets) {
    const f = sh.file;
    const isRoot = rootAliases.has(f.toLowerCase()) || (plan.sheets.length === 1 && !existing.includes(f)) || f === impliedRoot;
    map.set(f, isRoot ? root : f);
  }
  const seen = new Set<string>();
  const sheets: DesignPlan["sheets"] = [];
  for (const sh of plan.sheets) {
    const file = map.get(sh.file) ?? sh.file;
    if (seen.has(file)) continue;
    seen.add(file);
    // The filesystem decides: a file that does not exist is created no matter what the plan said (a real run
    // wrote `create: false` for a missing power sheet and every draft step then failed on a missing file).
    sheets.push({ ...sh, file, create: !existing.includes(file) });
  }
  // Parents follow the same name mapping; one that no longer names another plan sheet means the
  // root (the default), never a sheet the plan does not have.
  for (let i = 0; i < sheets.length; i++) {
    const parent = sheets[i].parent ? map.get(sheets[i].parent!) ?? sheets[i].parent! : undefined;
    if (parent && parent !== sheets[i].file && sheets.some((x) => x.file === parent)) sheets[i] = { ...sheets[i], parent };
    else if (sheets[i].parent) { const { parent: _drop, ...rest } = sheets[i]; sheets[i] = rest; }
  }
  // The root is always in scope: sheet symbols for new child sheets are placed in it.
  if (!seen.has(root)) sheets.unshift({ file: root, create: false });
  const blocks = plan.blocks.map((b) => ({ ...b, sheet: map.get(b.sheet) ?? (existing.includes(b.sheet) || sheets.some((x) => x.file === b.sheet) ? b.sheet : sheets[0]?.file ?? root) }));
  const structural = plan.envelope.structural.filter((x) => !x.startsWith("create_sheet:")).concat(sheets.filter((x) => x.create).map((x) => `create_sheet:${x.file}`));
  const floorplan: DesignPlan["floorplan"] = {};
  for (const [k, v] of Object.entries(plan.floorplan)) { const key = map.get(k) ?? k; (floorplan[key] ??= []).push(...v); }
  return { ...plan, sheets, blocks, floorplan, envelope: { ...plan.envelope, structural: Array.from(new Set(structural)) } };
}

/**
 * The harness executes steps by block: one draft step per block, a wiring step
 * when several blocks exchange nets, then a gate. Architects sometimes write
 * process steps ("confirm parts", "review risks") that bind to no block; those
 * are replaced by the synthesized sequence.
 */
/**
 * Acceptance items arrive as typed objects, as objects keyed `kind`/`check` instead of `type`, or as plain
 * sentences ("J1 pin 1 is on +5V"). A sentence becomes an informational `text` item so the architect's intent
 * stays on the plan card instead of failing validation; typed items keep their shape.
 */
export function normalizeAcceptance(v: unknown): Acceptance[] {
  if (!Array.isArray(v)) return [];
  const out: Acceptance[] = [];
  for (const a of v) {
    if (typeof a === "string") { if (a.trim()) out.push({ type: "text", text: a.trim() } as unknown as Acceptance); continue; }
    if (!a || typeof a !== "object") continue;
    const o = { ...(a as Record<string, unknown>) };
    if (o.type === undefined) {
      const alias = o.kind ?? o.check ?? o.rule;
      if (typeof alias === "string" && ACCEPTANCE_TYPES.has(alias)) o.type = alias;
      else if (typeof o.text === "string" || typeof o.description === "string") { o.type = "text"; o.text = String(o.text ?? o.description); }
    }
    delete o.kind; delete o.check; delete o.rule; delete o.description;
    out.push(o as unknown as Acceptance);
  }
  return out;
}

export function ensureBlockSteps(plan: DesignPlan): DesignPlan {
  const ids = new Set(plan.blocks.map((b) => b.id));
  const drafted = new Set<string>();
  const bound = plan.steps.filter((s) => {
    if (s.block && ids.has(s.block)) {
      // One draft per block: a second step on the same block would draw it twice.
      if (s.kind === "draft" || !s.kind) { if (drafted.has(s.block)) return false; drafted.add(s.block); }
      return true;
    }
    return s.kind === "scaffold" || s.kind === "gate" || s.kind === "wiring" || s.kind === "intent_snapshot";
  });
  const hasDraft = bound.some((s) => s.block && ids.has(s.block));
  if (hasDraft || plan.blocks.length === 0) {
    // Architect-authored steps: make sure the scaffold (when a sheet must be created) comes first and the
    // reconcile (wiring) and gate steps exist at the end.
    const out = bound.length ? [...bound] : [...plan.steps];
    if (plan.sheets.some((sh) => sh.create) && !out.some((s) => s.kind === "scaffold")) {
      out.unshift({ id: "scaffold", kind: "scaffold", summary: "create the plan's sheets", structural: true } as PlanStep);
    }
    const last = () => out[out.length - 1]?.id;
    if (plan.blocks.length > 1 && !out.some((s) => s.kind === "wiring")) out.push({ id: "wiring", kind: "wiring", nets: Array.from(new Set(plan.blocks.flatMap((b) => [...b.nets_in, ...b.nets_out]))), summary: "connect the blocks", depends_on: last() ? [last()!] : [] } as PlanStep);
    if (!out.some((s) => s.kind === "gate")) out.push({ id: "gate", kind: "gate", summary: "run the engine checks", depends_on: last() ? [last()!] : [] } as PlanStep);
    return { ...plan, steps: out };
  }
  const steps: PlanStep[] = [];
  const needsScaffold = plan.sheets.some((s) => s.create);
  if (needsScaffold) steps.push({ id: "scaffold", kind: "scaffold", summary: "create the plan's sheets", structural: true } as PlanStep);
  let prev: string | null = needsScaffold ? "scaffold" : null;
  for (const b of plan.blocks) {
    const id = `draft_${b.id}`;
    steps.push({ id, kind: "draft", block: b.id, summary: b.summary, depends_on: prev ? [prev] : [] } as PlanStep);
    prev = id;
  }
  const nets = Array.from(new Set(plan.blocks.flatMap((b) => [...b.nets_in, ...b.nets_out])));
  if (plan.blocks.length > 1) {
    steps.push({ id: "wiring", kind: "wiring", nets, summary: "connect the blocks", depends_on: prev ? [prev] : [] } as PlanStep);
    prev = "wiring";
  }
  steps.push({ id: "gate", kind: "gate", summary: "run the engine checks", depends_on: prev ? [prev] : [] } as PlanStep);
  return { ...plan, steps };
}

/**
 * Floorplans arrive as `{<sheet>: [{group, origin_mil, extent_mil}]}` (canonical),
 * `{groups: [{id|group, region_mil|origin_mil+extent_mil, sheet?}]}` or a bare
 * array; everything becomes the canonical per-sheet map keyed by the block's sheet.
 */
export function normalizeFloorplan(v: unknown, blocks: PlanBlock[]): DesignPlan["floorplan"] {
  const out: DesignPlan["floorplan"] = {};
  const sheetOf = (group: string, hint: unknown): string | null => (typeof hint === "string" && hint ? hint : blocks.find((b) => b.id === group)?.sheet ?? null);
  const push = (g: Record<string, unknown>, sheetHint: unknown) => {
    const group = String(g.group ?? g.id ?? g.block ?? "");
    if (!group) return;
    let origin = Array.isArray(g.origin_mil) ? (g.origin_mil as number[]) : null;
    let extent = Array.isArray(g.extent_mil) ? (g.extent_mil as number[]) : Array.isArray(g.size_mil) ? (g.size_mil as number[]) : null;
    const region = Array.isArray(g.region_mil) ? (g.region_mil as number[][]) : null;
    if (region && Array.isArray(region[0]) && Array.isArray(region[1])) {
      origin = [region[0][0], region[0][1]];
      extent = [region[1][0] - region[0][0], region[1][1] - region[0][1]];
    }
    if (!origin || !extent || origin.length < 2 || extent.length < 2) return;
    const sheet = sheetOf(group, g.sheet ?? sheetHint);
    if (!sheet) return;
    (out[sheet] ??= []).push({ group, origin_mil: [Number(origin[0]), Number(origin[1])], extent_mil: [Math.max(200, Number(extent[0])), Math.max(200, Number(extent[1]))] });
  };
  if (Array.isArray(v)) { for (const g of v) if (g && typeof g === "object") push(g as Record<string, unknown>, undefined); return out; }
  if (!v || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.groups)) { for (const g of o.groups) if (g && typeof g === "object") push(g as Record<string, unknown>, undefined); return out; }
  for (const [sheet, list] of Object.entries(o)) {
    if (!Array.isArray(list)) continue;
    for (const g of list) if (g && typeof g === "object") push(g as Record<string, unknown>, sheet);
  }
  return out;
}

/**
 * Region for a block that has no floorplan entry: a deterministic grid over the
 * sheet (3 columns of 2800 x 2400 mil from [1000,1000]), indexed by the block's
 * position among the blocks of the same sheet, so blocks never stack.
 */
export function defaultRegion(plan: DesignPlan, blockId: string, sheet: string): { origin_mil: [number, number]; extent_mil: [number, number] } {
  const same = plan.blocks.filter((b) => b.sheet === sheet).map((b) => b.id);
  const i = Math.max(0, same.indexOf(blockId));
  // A4 landscape usable area is about 10700 x 7000 mil from [800,800]: pick the grid that fits
  // every block of the sheet (3 x 2 for up to 6 blocks, 4 x 3 for up to 12, else 5 x 4).
  const n = same.length;
  const [cols, rows] = n <= 6 ? [3, 2] : n <= 12 ? [4, 3] : [5, 4];
  const gap = 200;
  // Cell sizes are multiples of the 50 mil connection grid so every block origin lands on the grid: a
  // Drafter that places with `exact: true` keeps its geometry relative to the origin, and an off-grid
  // origin would put every pin of the block 16 mil off (seen in a real run: x = 5666 mil).
  const w = Math.floor((9900 - gap * (cols - 1)) / cols / 50) * 50;
  const h = Math.floor((6600 - gap * (rows - 1)) / rows / 50) * 50;
  return { origin_mil: [800 + (i % cols) * (w + gap), 800 + Math.floor(i / cols) * (h + gap)], extent_mil: [w, h] };
}

/** Structural actions the plan implies: creating every sheet that does not exist yet. */
export function planStructural(plan: DesignPlan, existing: string[]): string[] {
  // Both spellings: the TS hooks say `create_sheet:<file>`, the Rust session ceiling says `add_sheet:<file>`.
  const set = new Set(plan.envelope.structural);
  for (const x of [...set]) { const m = /^(create_sheet|add_sheet):(.+)$/.exec(x); if (m) { set.add(`create_sheet:${m[2]}`); set.add(`add_sheet:${m[2]}`); } }
  for (const s of plan.sheets) if (!existing.includes(s.file)) { set.add(`create_sheet:${s.file}`); set.add(`add_sheet:${s.file}`); }
  return Array.from(set);
}

/** Sheet pin types the engine accepts (`opspec v1` `add_sheet.pins[].type`). */
const PIN_TYPES = new Set(["input", "output", "bidirectional", "tri_state", "passive"]);

/** One plan interface as it lands on a single sheet. */
export interface SheetInterface {
  net: string;
  /** `sheet_pin`: a sheet pin in the parent plus the hierarchical label the engine seeds inside the child. */
  mechanism: "sheet_pin" | "global_label";
  direction: "input" | "output" | "bidirectional" | "tri_state" | "passive";
}

/**
 * The plan interfaces that cross `sheetFile`, with the mechanism each one travels by. An interface
 * endpoint may name a sheet (file, stem, id or title) or a block; when neither endpoint resolves, the
 * blocks that use the net decide which sheets it touches. Rails are excluded: they are power ports,
 * never sheet pins. Deterministic and order-stable (plan order), so the drafter brief built from it
 * is byte-identical across redrafts of the same step.
 */
export function sheetInterfaces(plan: DesignPlan, sheetFile: string): SheetInterface[] {
  const rails = new Set(plan.net_naming?.rails ?? []);
  const stem = (f: string) => (f.split("/").pop() ?? f).replace(/\.kicad_sch$/, "").toLowerCase();
  const sheetOf = (end: unknown): string | undefined => {
    const e = typeof end === "string" ? end.trim() : "";
    if (!e) return undefined;
    const s = plan.sheets.find((x) => x.file === e || stem(x.file) === stem(e) || x.id === e || x.title === e);
    return s ? s.file : plan.blocks.find((b) => b.id === e)?.sheet;
  };
  const out: SheetInterface[] = [];
  const seen = new Set<string>();
  for (const i of plan.interfaces ?? []) {
    const net = String(i.net ?? "").replace(/^\//, "");
    // Declared rails and rail-looking names never become sheet pins: both sides carry them as power ports
    // (a real run scaffolded VBUS_5V / GND / +3V3 pins that then dangled on both sides).
    if (!net || rails.has(net) || isRailName(net) || seen.has(net)) continue;
    const from = sheetOf(i.from);
    const to = sheetOf(i.to);
    let dir = String((i as { direction?: unknown }).direction ?? "").toLowerCase();
    if (from || to) {
      if (from !== sheetFile && to !== sheetFile) continue;
      if (!PIN_TYPES.has(dir)) dir = from === sheetFile && to !== sheetFile ? "output" : to === sheetFile && from !== sheetFile ? "input" : "bidirectional";
    } else {
      // No usable endpoints: the blocks that name the net say which sheets it reaches and which way.
      const here = plan.blocks.filter((b) => b.sheet === sheetFile);
      const isIn = here.some((b) => (b.nets_in ?? []).includes(net));
      const isOut = here.some((b) => (b.nets_out ?? []).includes(net));
      if (!isIn && !isOut) continue;
      if (!PIN_TYPES.has(dir)) dir = isIn && isOut ? "bidirectional" : isIn ? "input" : "output";
    }
    seen.add(net);
    out.push({ net, mechanism: /global/i.test(String(i.mechanism ?? "")) ? "global_label" : "sheet_pin", direction: dir as SheetInterface["direction"] });
  }
  return out;
}

/**
 * Sheet pins a scaffolded sheet is born with. The engine writes the matching hierarchical label
 * inside the child for every pin, so a sheet created with its interface pins is buildable at once
 * instead of being an instant `SHEET_PIN_UNMATCHED`. Outputs leave on the right edge, everything
 * else enters on the left.
 */
export function interfacePins(plan: DesignPlan, sheetFile: string): { name: string; type: string; side: string }[] {
  return sheetInterfaces(plan, sheetFile)
    .filter((i) => i.mechanism === "sheet_pin")
    .map((i) => ({ name: i.net, type: i.direction, side: i.direction === "output" ? "right" : "left" }));
}

/** Ops every drafting step may use regardless of what the plan listed. */
export const DRAFT_OPS = [
  "place_component", "set_component_parameters", "set_component_attributes", "set_component_transform", "add_wire", "route_net", "add_junction", "add_no_connect", "add_net_label", "place_power_port", "place_gnd", "place_vcc", "rename_net", "add_bus", "add_bus_entry", "add_text", "add_rectangle", "add_text_box", "set_title_block", "move_component",
  "place_divider", "place_decoupling", "place_pullup", "place_led_indicator", "place_rc_filter", "place_crystal", "place_array", "connect_and_label", "place_pwr_flag", "terminate_unused_unit", "arrange_group",
];

/**
 * An `allowed_ops` list as the engine's own vocabulary: every name through the alias map of
 * `tools/ops.ts` (`add_symbol` -> `place_component`, `add_label` -> `add_net_label`), then
 * intersected with opspec v1. A name that survives neither is dropped and reported, never passed
 * through — the plan envelope is quoted into the drafter's brief, so a run whose plan declared
 * `create_root_schematic` / `set_symbol_value` / `annotate` / `run_erc` had a drafter calling all
 * four of them. Order-stable (input order), duplicates removed.
 */
export function normalizeAllowedOps(v: unknown): { ops: string[]; dropped: string[] } {
  const ops: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(v) ? v : []) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const canon = canonicalOpName(name);
    if (!isKnownOp(canon)) { if (!dropped.includes(name)) dropped.push(name); continue; }
    if (!seen.has(canon)) { seen.add(canon); ops.push(canon); }
  }
  return { ops, dropped };
}

/**
 * The op names `normalizePlan` dropped from a raw plan — the envelope's `allowed_ops` and any a step
 * declared for itself. `plan.write` hands them back as `dropped_ops` so the model corrects the plan
 * in one retry instead of the invented names reaching a brief.
 */
export function droppedAllowedOps(input: unknown): string[] {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const env = (o.envelope ?? {}) as { allowed_ops?: unknown };
  const out = new Set(normalizeAllowedOps(env.allowed_ops).dropped);
  for (const st of Array.isArray(o.steps) ? o.steps : []) {
    if (!st || typeof st !== "object") continue;
    for (const d of normalizeAllowedOps((st as { allowed_ops?: unknown }).allowed_ops).dropped) out.add(d);
  }
  return [...out];
}

/** Reference prefix from a free-text part description ("5.1k resistor" -> R). */
export function guessPrefix(text: string): string {
  const t = text.toLowerCase();
  if (/resistor|pull-?up|pull-?down|\bohm|\d+(\.\d+)?\s*[kmr]?Ω/.test(t)) return "R";
  if (/capacitor|decoupl|bulk|\d+\s*[unp]f\b/.test(t)) return "C";
  if (/\bled\b|indicator/.test(t)) return "D";
  if (/diode|tvs|esd|schottky/.test(t)) return "D";
  if (/inductor|ferrite|bead/.test(t)) return "L";
  if (/crystal|resonator|oscillator/.test(t)) return "Y";
  if (/fuse|polyfuse|ptc/.test(t)) return "F";
  if (/button|switch|tact/.test(t)) return "SW";
  if (/test ?point/.test(t)) return "TP";
  if (/mosfet|transistor|bjt/.test(t)) return "Q";
  if (/receptacle|connector|header|usb|jack|socket|terminal/.test(t)) return "J";
  return "U";
}

/** Fill every optional field so downstream code can rely on the full shape. */
/**
 * The plan envelope's `structural` list, with every entry qualified by the file it acts on.
 *
 * A bare verb in a *ceiling* permits that verb on any file (`structuralSatisfiedBy` returns the
 * ceiling entry whatever file the declaration names), and `plan.envelope.structural` is copied into
 * the ceiling verbatim — so a model that wrote `"delete_sheet"` once would have had every file in
 * the project inside the approved envelope. A bare sheet-file verb is therefore spelled out over the
 * plan's own sheets, which is the only scope the human approved, and dropped when the plan lists
 * none. Already-qualified entries are kept as they are.
 *
 * Only the verbs whose envelope entry carries a file are qualified: `delete_sheet_pin` and
 * `resize_sheet` have no qualified form (`structural_key` in `session.rs` emits the bare op name for
 * them), so inventing one would leave the ceiling unable to match the op it approved.
 */
const SHEET_FILE_VERBS = new Set(["create_sheet", "add_sheet", "delete_sheet", "remove_sheet", "rename_sheet"]);

export function qualifyPlanStructural(entries: readonly string[], planSheets: readonly string[], createSheets: readonly string[]): string[] {
  const out: string[] = [];
  const push = (x: string) => { if (x && !out.includes(x)) out.push(x); };
  for (const raw of entries) {
    const e = String(raw ?? "").trim();
    if (!e) continue;
    const i = e.indexOf(":");
    const verb = (i < 0 ? e : e.slice(0, i)).trim();
    const file = i < 0 ? "" : e.slice(i + 1).trim();
    if (!verb) continue;
    if (file) { push(`${verb}:${file}`); continue; }
    if (!SHEET_FILE_VERBS.has(verb)) { push(verb); continue; }
    for (const f of planSheets) push(`${verb}:${f}`);
  }
  for (const f of createSheets) push(`create_sheet:${f}`);
  return out;
}

export function normalizePlan(input: unknown): DesignPlan {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const env = (o.envelope ?? {}) as Partial<PlanEnvelope>;
  const budgets = (env.budgets ?? {}) as Partial<PlanEnvelope["budgets"]>;
  const declaredOps = Array.isArray(env.allowed_ops) && env.allowed_ops.length;
  const allowedOps = normalizeAllowedOps(env.allowed_ops).ops;
  const sheets = normalizeSheets(o.sheets);
  const sheetFile = (v: unknown): string | undefined => {
    if (typeof v !== "string" || !v.trim()) return undefined;
    const hit = sheets.find((s) => s.file === v || s.file === `${v}.kicad_sch` || s.id === v || s.title === v);
    return hit ? hit.file : v.endsWith(".kicad_sch") ? v : `${v}.kicad_sch`;
  };
  // A plan-level BOM ("bom_candidates", "bom", "parts_list": [{ref, lib_id, lcsc, mpn, value}]) lets
  // blocks list bare designators ("U1", "C4"); resolve those through it.
  const bomList = [o.bom_candidates, o.bom, o.parts_list, o.parts, o.components].find((l) => Array.isArray(l) && (l as unknown[]).length) as Record<string, unknown>[] | undefined;
  const bom = new Map<string, Record<string, unknown>>();
  for (const x of bomList ?? []) if (x && typeof x === "object") { const r = [x.ref, x.refdes, x.designator, x.reference].find((v) => typeof v === "string") as string | undefined; if (r) bom.set(r.toUpperCase(), x); }
  const rawBlocks = [o.blocks, o.functional_blocks, o.modules, o.subsystems, o.sections].find((l) => Array.isArray(l) && (l as unknown[]).length) as Record<string, unknown>[] | undefined;
  const blocks: PlanBlock[] = (rawBlocks ?? []).map((b0, i) => {
    const b = { ...b0 } as Record<string, unknown>;
    const lists = [b.parts, b.components, b.bom, b.items, b.part_list].filter((l) => Array.isArray(l) && (l as unknown[]).length) as unknown[][];
    const rawParts = (lists[0] ?? []) as unknown[];
    const parts = rawParts.filter((x) => x && (typeof x === "object" || typeof x === "string")).map((x0) => {
      // Bare designators refer to the plan-level BOM; other strings ("2x 5.1k resistor") become loosely typed parts.
      const asRef = typeof x0 === "string" && /^[A-Z]{1,3}\d{1,3}$/i.test(x0.trim()) ? bom.get(x0.trim().toUpperCase()) : undefined;
      const x = (asRef ? { ...asRef, refdes: x0 } : typeof x0 === "string" ? { description: x0, ref_prefix: guessPrefix(x0), value: x0.replace(/^\d+\s*x\s*/i, "") } : x0) as Record<string, unknown>;
      const q = { ...x };
      if (typeof q.ref_prefix !== "string") {
        const rd = [q.refdes, q.ref, q.designator, q.reference].find((v) => typeof v === "string") as string | undefined;
        if (rd) q.ref_prefix = rd.replace(/\d+$/, "");
      }
      if (typeof q.resolved !== "boolean") q.resolved = false;
      return q;
    });
    const id = String(b.id ?? b.name ?? `b${i + 1}`);
    return { ...b, id, sheet: sheetFile(b.sheet) ?? sheets[0]?.file ?? "", summary: String(b.summary ?? b.purpose ?? b.intent ?? b.description ?? b.title ?? id), parts } as unknown as PlanBlock;
  });
  // Blocks that carry their own region become the floorplan when none was given.
  const blockRegions = (rawBlocks ?? []).filter((b) => b && Array.isArray((b as Record<string, unknown>).region_mil)).map((b) => ({ id: String((b as Record<string, unknown>).id ?? (b as Record<string, unknown>).name ?? ""), region_mil: (b as Record<string, unknown>).region_mil }));
  const floorplanSrc = o.floorplan ?? (blockRegions.length ? { groups: blockRegions } : undefined);
  // Rails may arrive as net_naming.rails, a top-level `rails` list of names or of {name} objects.
  const railsTop = Array.isArray(o.rails) ? (o.rails as unknown[]).map((r) => (typeof r === "string" ? r : r && typeof r === "object" ? String((r as { name?: unknown }).name ?? "") : "")).filter(Boolean) : [];
  const added = blocks.reduce((n, b) => n + (Array.isArray(b.parts) ? b.parts.reduce((m, p) => m + (p.units_total ?? 1), 0) : 0), 0);
  // Architects often write zero or token budgets; the plan is the ceiling, so give it modest headroom over the parts
  // it lists (power ports and flags are not counted): 1.5x + 4, never below 12.
  const addedCeiling = Math.max(Math.ceil(added * 1.5) + 4, 12);
  const nonZero = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? v : undefined);
  const nn0 = (o.net_naming ?? {}) as Partial<DesignPlan["net_naming"]>;
  // `net_naming.rails` also arrives as {name, scope, source} objects (real models annotate rails); keep the names.
  const railsNn = Array.isArray(nn0.rails) ? (nn0.rails as unknown[]).map((r) => (typeof r === "string" ? r : r && typeof r === "object" ? String((r as { name?: unknown }).name ?? "") : "")).filter(Boolean) : [];
  const nn: Partial<DesignPlan["net_naming"]> = { ...nn0, rails: railsNn.length ? railsNn : railsTop };
  const budget = (o.budget ?? {}) as Partial<DesignPlan["budget"]>;
  // `withDerivedAcceptance` runs on the finished shape: a block that declared nothing the engine can
  // check gets its own declarations restated as typed rows, so the gate has something to report on.
  return withDerivedAcceptance({
    schema_version: 1,
    kind: "schematic",
    id: String(o.id ?? "plan"),
    version: typeof o.version === "number" ? o.version : 1,
    created: typeof o.created === "string" ? o.created : new Date(0).toISOString(),
    source: o.source === "adopt-existing" ? "adopt-existing" : "architect",
    goal: String(o.goal ?? ""),
    constraints: textList(o.constraints).concat(textList(o.risks).map((r) => `risk: ${r}`)),
    assumptions: textList(o.assumptions),
    open_questions: textList(o.open_questions ?? o.questions),
    sheets,
    interfaces: normalizeInterfaces(o.interfaces, Array.isArray(nn.rails) ? nn.rails.map(String) : []),
    power_tree: o.power_tree,
    net_naming: { rails: Array.isArray(nn.rails) ? nn.rails.map(String) : [], rail_mechanism: nn.rail_mechanism ?? "power_port", prefix_rules: nn.prefix_rules },
    conventions: Array.isArray(o.conventions) ? (o.conventions as DesignPlan["conventions"]) : [],
    floorplan: normalizeFloorplan(floorplanSrc, blocks),
    blocks: blocks.map((b) => ({ ...b, parts: Array.isArray(b.parts) ? b.parts : [], nets_in: b.nets_in ?? [], nets_out: b.nets_out ?? [], acceptance: normalizeAcceptance(b.acceptance) })),
    steps: (Array.isArray(o.steps) ? (o.steps as Record<string, unknown>[]) : []).map((st, i) => {
      const block = (st.block ?? st.block_id ?? st.blockId) as string | undefined;
      const kind = (["draft", "wiring", "scaffold", "gate", "intent_snapshot", "source_bom"].includes(String(st.kind)) ? st.kind : "draft") as PlanStep["kind"];
      const summary = [st.summary, st.title, st.description, st.action, st.name, st.goal].find((x) => typeof x === "string" && x.trim()) as string | undefined;
      // A step that narrows the turn declaration with its own `allowed_ops` goes through the same
      // vocabulary check as the plan envelope: an invented name there would narrow to nothing.
      const stepOps = (st as { allowed_ops?: unknown }).allowed_ops === undefined ? undefined : normalizeAllowedOps((st as { allowed_ops?: unknown }).allowed_ops).ops;
      return { ...st, id: String(st.id ?? `s${i + 1}`), block, kind, summary, ...(stepOps ? { allowed_ops: stepOps } : {}) } as PlanStep;
    }),
    envelope: {
      budgets: {
        components_added: Math.max(nonZero(budgets.components_added) ?? 0, addedCeiling), components_deleted: budgets.components_deleted ?? 0, components_moved: budgets.components_moved ?? 0,
        objects_deleted: budgets.objects_deleted ?? {}, wires_added: Math.max(nonZero(budgets.wires_added) ?? 0, addedCeiling * 3), labels_added: Math.max(nonZero(budgets.labels_added) ?? 0, addedCeiling * 3),
        properties_changed: budgets.properties_changed ?? {}, transforms_changed: budgets.transforms_changed ?? 0, attributes_changed: budgets.attributes_changed ?? 0,
      },
      nets: { rails: env.nets?.rails ?? (Array.isArray(nn.rails) ? nn.rails.map(String) : []), renamable: env.nets?.renamable ?? [], may_create_named: env.nets?.may_create_named ?? true },
      structural: qualifyPlanStructural(Array.isArray(env.structural) ? env.structural.map(String) : [], sheets.map((sh) => sh.file), sheets.filter((sh) => sh.create).map((sh) => sh.file)),
      // A listed allowed_ops is a ceiling for the model, but the harness Drafter always needs the
      // drafting vocabulary (labels, power ports, route_net, macros); union it in. Names that are
      // not opspec v1 ops are already gone (`normalizeAllowedOps`), and a list that was entirely
      // invented still narrows to the drafting vocabulary rather than reopening to unrestricted.
      allowed_ops: declaredOps ? Array.from(new Set([...allowedOps, ...DRAFT_OPS])) : [],
    },
    refdes_policy: (o.refdes_policy as DesignPlan["refdes_policy"]) ?? { frozen_existing: true, reuse_freed: false },
    budget: { tokens: budget.tokens ?? null, cost_usd: budget.cost_usd ?? null, tool_calls: budget.tool_calls ?? null, wall_active_min: budget.wall_active_min ?? null },
    display: (o.display as DesignPlan["display"]) ?? { status: "draft", approved_at: null },
  });
}
