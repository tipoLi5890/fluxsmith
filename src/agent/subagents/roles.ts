// SPDX-License-Identifier: Apache-2.0
// Role definitions: tool whitelist, output schema validation and brief
// builders (agent-runtime.md §5). Briefs are English and deterministic in
// structure so each role's prefix stays cacheable.

import type { Envelope } from "../../ipc/types";
import type { Role } from "../api";
import { normalizePlan, validatePlan, type DesignPlan, type PlanBlock, type SheetInterface } from "../plans/schema";
import type { Finding } from "../policy/types";

export interface RoleSpec<T> {
  role: Role;
  tools: string[];
  validate: (v: unknown) => string[];
  outputName: string;
  _t?: T;
}

export interface OpListOut {
  groups: Record<string, { origin_mil: [number, number] }>;
  ops: Record<string, unknown>[];
  refdes_used: string[];
  region_used: [[number, number], [number, number]] | null;
  sheets?: string[];
}

export function validateOpList(v: unknown): string[] {
  const o = v as Partial<OpListOut>;
  const e: string[] = [];
  if (!o || typeof o !== "object") return ["not an object"];
  if (!Array.isArray(o.ops)) e.push("ops[] required");
  const usesGroups = (o.ops ?? []).some((op) => typeof (op as { group?: unknown }).group === "string");
  if (usesGroups && (!o.groups || typeof o.groups !== "object" || !Object.keys(o.groups).length)) e.push("groups required (ops reference a group)");
  if (!o.groups || typeof o.groups !== "object") (o as { groups: Record<string, unknown> }).groups = {};
  if (!Array.isArray(o.refdes_used)) (o as { refdes_used: string[] }).refdes_used = [];
  for (const op of o.ops ?? []) if (typeof (op as { op?: unknown }).op !== "string") e.push("every op needs op name");
  return e;
}

export interface PartBinding { ref_prefix: string; lib_id: string; footprint?: string; pin_map?: Record<string, string>; units_total: number; resolved: boolean; note?: string }

export function validateBindings(v: unknown): string[] {
  const arr = (v as { bindings?: unknown }).bindings ?? v;
  if (!Array.isArray(arr)) return ["bindings[] required"];
  return arr.flatMap((b, i) => (typeof (b as PartBinding).lib_id !== "string" || typeof (b as PartBinding).resolved !== "boolean" ? [`binding ${i} invalid`] : []));
}

export interface ReviewFinding extends Finding { origin: "engine" | "advisory"; confidence?: number; proposed_ops?: unknown }

export function validateFindings(v: unknown): string[] {
  const arr = (v as { findings?: unknown }).findings ?? v;
  if (!Array.isArray(arr)) return ["findings[] required"];
  return arr.flatMap((f, i) => (typeof (f as ReviewFinding).code !== "string" || !["engine", "advisory"].includes((f as ReviewFinding).origin) ? [`finding ${i} needs code and origin`] : []));
}

export const ARCHITECT: RoleSpec<DesignPlan> = { role: "architect", outputName: "DesignPlan", validate: (v) => validatePlan(normalizePlan(v)), tools: ["sch.summary", "sch.read", "sch.nets", "lib.search", "lib.resolve", "lib.symbol", "skill.open", "skill.list", "ask_user", "plan.write", "plan.read", "attach.list", "attach.read", "attach.sch", "attach.netlist", "attach.bom", "attach.image", "docs.pdf_text", "parts.datasheet", "web.search", "web.fetch"] };
export const LIBRARIAN: RoleSpec<{ bindings: PartBinding[] }> = { role: "librarian", outputName: "PartBinding[]", tools: ["lib.search", "lib.resolve", "lib.symbol", "sch.pins", "attach.list", "attach.read", "lib.import_request", "parts.search", "parts.show", "web.search", "web.fetch", "skill.open"], validate: validateBindings };
export const DRAFTER: RoleSpec<OpListOut> = { role: "drafter", outputName: "OpList", tools: ["sch.summary", "sch.read", "sch.nets", "sch.net", "sch.component", "sch.pins", "sch.bbox", "lib.search", "lib.resolve", "lib.symbol", "ops.list", "ops.template", "ops.validate", "ops.expand", "sch.dryrun_scratch", "skill.open", "skill.list", "attach.read", "attach.sch", "attach.fragment"], validate: validateOpList };
// `sch.component` and `sch.net` are what a post-apply repair needs and had no way to ask for: where a
// part sits right now, and which pins share the rail a far decoupling capacitor belongs on.
export const FIXER: RoleSpec<OpListOut> = { role: "fixer", outputName: "OpList", tools: ["sch.summary", "sch.component", "sch.net", "sch.pins", "sch.bbox", "lib.resolve", "lib.symbol", "ops.template", "ops.validate", "ops.expand", "sch.dryrun_scratch", "skill.open", "check.integrity"], validate: validateOpList };
export const REVIEWER: RoleSpec<{ findings: ReviewFinding[] }> = { role: "reviewer", outputName: "Finding[]", tools: ["sch.summary", "sch.read", "sch.nets", "sch.net", "sch.component", "sch.bbox", "project.check", "check.integrity", "check.erc", "check.nets", "check.pinmap", "check.power", "check.intent", "gate.run", "diff.nets", "plan.read", "policy.read", "skill.open", "skill.list", "attach.read", "attach.netlist", "docs.pdf_text"], validate: validateFindings };
export const EXPLAINER: RoleSpec<{ answer: string }> = { role: "explainer", outputName: "Answer", tools: ["sch.summary", "sch.read", "sch.nets", "sch.net", "sch.component", "sch.bbox", "project.info", "policy.read", "plan.read", "skill.open", "attach.list", "attach.read"], validate: () => [] };
export const SOURCER: RoleSpec<unknown> = { role: "sourcer", outputName: "SourcingResult", tools: ["parts.search", "parts.show", "parts.datasheet", "parts.convert", "parts.bom", "lib.resolve", "skill.open", "sch.summary", "sch.component"], validate: (v) => (v && typeof v === "object" && Array.isArray((v as { candidates?: unknown }).candidates) ? [] : ["candidates[] required"]) };
export const FACTS: RoleSpec<unknown> = { role: "facts", outputName: "DatasheetFacts", tools: ["parts.datasheet", "docs.pdf_text", "facts.write", "web.fetch", "skill.open", "attach.list", "attach.read"], validate: (v) => (v && typeof v === "object" && Array.isArray((v as { facts?: unknown }).facts) ? [] : ["facts[] required"]) };

// ---------------------------------------------------------------------------
// Brief builders (English, deterministic ordering)
// ---------------------------------------------------------------------------

export interface DraftBrief {
  block: PlanBlock | { id: string; sheet: string; summary: string; parts: unknown[]; nets_in: string[]; nets_out: string[]; acceptance: unknown[] };
  target: string;
  envelope: Envelope;
  lease: { prefix: string; ranges: [number, number][] }[];
  region_mil: [[number, number], [number, number]];
  group: string;
  origin_mil: [number, number];
  rails: string[];
  conventions: { id: string; text: string }[];
  facts?: string;
  summary: string;
  instruction?: string;
  /** FR-611: instance paths of `target` when its sheet file is instantiated more than once (sorted). */
  instance_paths?: string[];
  /** Plan interfaces that cross `target` (`sheetInterfaces`), in plan order. */
  interfaces?: SheetInterface[];
}

/**
 * FR-611: on a sheet file that is instantiated more than once every symbol needs one reference per
 * instance path, so the drafting ops carry an `instance_designators` map instead of a scalar
 * designator. The paths are concrete (from `sch.summary`), sorted, so the line is deterministic.
 */
export function instanceRefsRule(target: string, paths: string[]): string {
  if (paths.length < 2) return "";
  const example = Object.fromEntries(paths.map((p, i) => [p, `R${i + 1}01`]));
  return `Reused sheet: ${target} is instantiated ${paths.length} times. Every place_component / set_component_parameters must carry instance_designators mapping each of these paths to that instance's own designator (example shape: ${JSON.stringify(example)}); a scalar designator alone is refused. Instance paths: ${paths.join(", ")}.`;
}

/**
 * FR-611 repair brief: no op adds an instance-path entry to a symbol that is already placed
 * (`set_component_parameters.instance_designators` only rewrites entries that exist, and a second
 * `add_sheet` of an existing file does not backfill them), so the affected parts are deleted and
 * placed again with the full map.
 */
export function instanceRefsBrief(req: { sheet: string; paths: string[]; refs: string[] }): string {
  return [
    `Task: give every listed part on ${req.sheet} its own reference for each of the ${req.paths.length} instance paths of that sheet file. Return a complete replacement OpList in a \`\`\`json fence.`,
    `Parts without a reference for every path: ${req.refs.join(", ")}.`,
    `Instance paths (in this order): ${req.paths.join(", ")}.`,
    "No op adds an instance-path entry to a placed symbol. For each listed part emit delete_component {designator} and then place_component with the same lib_id, value, footprint and unit at the same x_mil / y_mil / rotation / mirror with exact: true, plus instance_designators mapping every path above to that instance's designator (one distinct designator per path; keep the current designator for the first path and use free numbers for the others).",
    "Read sch.component and sch.read for the current lib_id, value, footprint and coordinates before you answer. Do not move, add or remove anything else.",
  ].join("\n");
}

/**
 * The cross-sheet nets of this sheet and how they cross it. Without this line the Drafter has no way
 * to know that a net leaves the sheet: it labels it locally, the label matches nothing on the other
 * sheet and the interface never connects. Deterministic (plan order, one line), so it does not move
 * between redrafts of the same step.
 */
export function interfacesRule(target: string, interfaces: SheetInterface[]): string {
  if (!interfaces.length) return "";
  const pins = interfaces.filter((i) => i.mechanism === "sheet_pin");
  const globals = interfaces.filter((i) => i.mechanism === "global_label");
  const parts: string[] = [];
  if (pins.length) parts.push(`by sheet pin: ${pins.map((i) => `${i.net} (${i.direction})`).join(", ")} - each crosses through a pin of that name on the sheet symbol in the parent plus a hierarchical label of the same name inside ${target} (the scaffold step writes both), so label the pin of the part that drives or receives the net with add_net_label scope "hierarchical" and exactly this name (there is no add_hier_label op), and never rename these nets`);
  if (globals.length) parts.push(`by global label: ${globals.map((i) => i.net).join(", ")} - use add_net_label with scope "global" and exactly this name`);
  return `Interfaces leaving ${target}: ${parts.join("; ")}.`;
}

export function drafterBrief(b: DraftBrief): { brief: string; untrusted: string } {
  const lines = [
    `Task: draft the block "${b.block.id}" on sheet ${b.target}.`,
    `Summary: ${b.block.summary}`,
    b.instruction ? `User instruction: ${b.instruction}` : "",
    `Group: ${b.group} origin_mil ${JSON.stringify(b.origin_mil)}; region_mil ${JSON.stringify(b.region_mil)} (stay inside; sch.bbox is limited to region + 200 mil).`,
    instanceRefsRule(b.target, b.instance_paths ?? []),
    interfacesRule(b.target, b.interfaces ?? []),
    b.block.parts.length ? `Parts: ${JSON.stringify(b.block.parts)} (a part without lib_id: pick the matching KiCad symbol with lib.search / lib.resolve; generic passives are Device:R / Device:C / Device:LED. A part that carries a footprint is placed with exactly that footprint string - it is the package the human signed off on the plan card, so never substitute another one)` : `Parts: none listed - choose the KiCad symbols this block needs yourself (lib.search / lib.resolve) and place every one of them.`,
    `Nets in: ${b.block.nets_in.join(", ") || "-"}; nets out: ${b.block.nets_out.join(", ") || "-"}; rails: ${b.rails.join(", ") || "-"} (power ports only).`,
    `Refdes lease (exclusive): ${JSON.stringify(b.lease)}. Report refdes_used. Never write a Reference property or new_designator: designators come only from the lease (a rename is refused).`,
    // "no deletions" used to be unconditional while `delete_object` sat in allowed_ops, which reads as a
    // contradiction: a wiring step whose only repair is removing one stale no-connect was told both that
    // the op is allowed and that it must not delete. The two are different budgets — components are never
    // deleted here, loose objects (wire, label, junction, no_connect, text) are, when the op is allowed.
    `Envelope: allowed_ops ${JSON.stringify(b.envelope.allowed_ops)}; components_added_max ${b.envelope.components_added_max}; no component deletions${!b.envelope.allowed_ops.length || b.envelope.allowed_ops.includes("delete_object") ? " (delete_object may still remove a loose wire, label, junction, no_connect or text: give it match {kind, at} - it can never reach a symbol)" : ""}.`,
    `Acceptance: ${JSON.stringify(b.block.acceptance)}`,
    b.conventions.length ? `Conventions: ${b.conventions.map((c) => `${c.id}: ${c.text}`).join(" | ")}` : "",
    "Output exactly one JSON object in a ```json fence: {\"groups\":{...},\"ops\":[...],\"refdes_used\":[...],\"region_used\":[[x,y],[x,y]]}. Use sch.dryrun_scratch (max 6) before answering; every op uses group-local coordinates.",
  ].filter(Boolean);
  // Datasheet facts are evidence extracted from PDFs: they ride in the untrusted block (P10 envelope), never in the brief proper.
  const untrusted = [`sch.summary:\n${b.summary}`, b.facts ? `datasheet facts (pinned to PDF pages; unaudited unless marked):\n${b.facts}` : ""].filter(Boolean).join("\n\n");
  return { brief: lines.join("\n"), untrusted };
}

/** Facts brief lines: at most `cap` entries of `MPN key=value (p.N, unaudited)` for the parts of a block. */
export const FACTS_BRIEF_CAP = 20;
export function factsBriefLines(docs: unknown[], parts: { mpn?: string; lcsc?: string; lib_id?: string }[], cap = FACTS_BRIEF_CAP): string[] {
  const wanted = new Set(parts.flatMap((p) => [p.mpn, p.lcsc].filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.toLowerCase())));
  const out: string[] = [];
  for (const d of docs) {
    const doc = d as { mpn?: unknown; facts?: unknown } | null;
    if (!doc || typeof doc.mpn !== "string" || !Array.isArray(doc.facts)) continue;
    if (wanted.size && !wanted.has(doc.mpn.toLowerCase())) continue;
    for (const f of doc.facts as { key?: unknown; value?: unknown; page?: unknown; audited?: unknown }[]) {
      if (out.length >= cap) return out;
      if (typeof f?.key !== "string") continue;
      const value = typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? "");
      out.push(`${doc.mpn} ${f.key}=${value.replace(/\s+/g, " ").trim()} (p.${typeof f.page === "number" ? f.page : "?"}, ${f.audited === true ? "audited" : "unaudited"})`);
    }
  }
  return out;
}

/**
 * Load `datasheets/extracted/*.json` for the parts of a block (those with an
 * mpn / lcsc) and format them for `drafterBrief.facts`. `read` is the
 * `sidecar_read {kind:"facts"}` call; failures yield no facts.
 */
export async function loadFactsForParts(parts: { mpn?: string; lcsc?: string; lib_id?: string }[], read: () => Promise<unknown>): Promise<string> {
  if (!parts.some((p) => p.mpn || p.lcsc)) return "";
  let docs: unknown[] = [];
  try { const v = await read(); docs = Array.isArray(v) ? v : []; } catch { docs = []; }
  return factsBriefLines(docs, parts).join("\n");
}

/** Post-apply repairs may only move / rotate / arrange — plus the connectivity ops the findings actually call for. */
export function postApplyRule(findings: Finding[]): string {
  const codes = new Set(findings.map((f) => f.code));
  const extra: string[] = [];
  if (codes.has("ERC_POWER_IN_UNDRIVEN")) extra.push("place_pwr_flag (on the rail's pin)");
  if (codes.has("ERC_POWER_OUT_CONFLICT")) extra.push("delete_object on the PWR_FLAG that sits on a net a power output already drives");
  if (codes.has("POLARITY_REVERSED")) extra.push("set_component_transform rotation +180 on the polarised part (address it by uuid)");
  if (codes.has("SHEET_PIN_UNMATCHED") || codes.has("HIER_LABEL_UNMATCHED")) extra.push("add_net_label with scope \"hierarchical\" and the child file in `sheet` (there is no add_hier_label op), or add_sheet_pin / delete_sheet_pin on the sheet symbol, so pins and hierarchical labels match one to one");
  if (codes.has("POWER_PORT_DANGLING")) extra.push("delete_object on the power symbol that touches no pin, or move_component so its pin lands on the part pin it was meant for");
  if (codes.has("LABEL_DANGLING")) extra.push("delete_object on the label attached to nothing, or move it onto the pin it names");
  if (codes.has("RAIL_SCOPE_SPLIT") || codes.has("RAIL_AS_LABEL")) extra.push("delete_object on the rail's local label and place_power_port for that rail on the pin (a flag does not fix a scope split)");
  if (codes.has("LABEL_SCOPE_SPLIT")) extra.push("if the sheets share the signal, replace the local labels with a global label (add_net_label scope \"global\") or a hierarchical label plus sheet pin; if they are different signals, rename_net one side with `sheet` set to that sheet (a local label is one net per sheet, so the op must say which)");
  if (codes.has("PINMAP_UNCONNECTED") || codes.has("ERC_PIN_NOT_CONNECTED") || codes.has("ERC_UNCONNECTED")) extra.push("add_no_connect (unused pins) or add_net_label (pins that belong to a net)");
  if (codes.has("ERC_SINGLE_PIN_NET") || codes.has("NET_SINGLE_PIN") || codes.has("ERC_LABEL_DANGLING")) extra.push("rename_net (unify a mis-typed label with its counterpart) or add a matching label where the net continues; never add_no_connect on a pin that carries a label (KiCad flags that as an error)");
  const base = "Post-apply: move_component deltas, set_component_transform (rotation/mirror; address power ports by uuid) and arrange_group are allowed; never re-place or delete parts.";
  return extra.length ? `${base} For the connectivity findings listed you may additionally use: ${extra.join("; ")}.` : base;
}

/**
 * The Fixer's brief. Two shapes, one per phase, because the two repairs are not the same job:
 *
 * * `pre_apply` hands over an op-list that has not been written yet, and the answer is that list
 *   rewritten. It is dispatched only with a non-empty list — a rewrite of `{"ops":[]}` is nothing.
 * * `post_apply` is about a sheet that already exists: the parts are placed, the findings name them
 *   by designator and uuid, and the answer is a small op-list of moves / transforms / labels that
 *   addresses exactly those findings. It carries the sheet's own state (`summary`) instead of an
 *   op-list, because the op-list that drew the sheet is not the thing being repaired.
 */
export function fixerBrief(oplist: unknown, findings: Finding[], target: string, phase: "pre_apply" | "post_apply", sections: string[], summary = ""): { brief: string; untrusted: string } {
  const ops = Array.isArray((oplist as { ops?: unknown[] } | null)?.ops) ? (oplist as { ops: unknown[] }).ops : [];
  const safe = findings.map((f) => ({ code: f.code, severity: f.severity, refs: f.refs ?? [], location: f.location ?? "", sheet: f.sheet ?? "", file: f.file ?? "", remediation: f.remediation ?? "" }));
  const quotes = findings.map((f) => `${f.code}: ${f.message ?? ""} ${f.remediation ? `(remediation: ${f.remediation})` : ""}`).join("\n");
  const brief = [
    `Task: repair ${findings.length} findings on ${target} (${phase}). Return a complete OpList in a \`\`\`json fence.`,
    phase === "post_apply" ? postApplyRule(findings) : "Pre-apply: rewrite the op-list; keep group-local coordinates and the same refdes.",
    phase === "post_apply"
      ? "The parts are already on the sheet, so this is not a redraw: address exactly the findings listed, each by the designator or uuid it names, and place, delete or re-wire nothing else. Read the current geometry before you choose a coordinate (sch.summary for the sheet, sch.component for one part's position and pin-to-net map, sch.net for the pins of a rail, sch.bbox for bodies, sch.pins for pin tips); move_component x_mil / y_mil is the part's new absolute position, not a delta, and move_component {designator, anchor:\"U1.4\", offset_mil:[dx,dy]} places it relative to a pin. Then run sch.dryrun_scratch on the list and answer with the list that passed."
      : "",
    `Findings (structured): ${JSON.stringify(safe)}`,
    sections.length ? `Read these skill sections first: ${sections.join(", ")}` : "",
    ops.length ? `${phase === "post_apply" ? "OpList already applied (context only; do not repeat it)" : "Original OpList"}: ${JSON.stringify(oplist)}` : "",
  ].filter(Boolean).join("\n");
  return { brief, untrusted: [quotes, summary ? `sch.summary:\n${summary}` : ""].filter(Boolean).join("\n\n") };
}

export function architectBrief(goal: string, constraints: string[], summary: string, refsBlock: string, ceiling: { components_added: number }): { brief: string; untrusted: string } {
  return {
    brief: [
      `Task: produce a DesignPlan (schema_version 1) for: ${goal}`,
      constraints.length ? `Constraints: ${constraints.join("; ")}` : "",
      `Session ceiling without an approved plan: components_added ${ceiling.components_added}. Blocks ≤ 12 components; declare interfaces for every cross-sheet net; rails as power ports; typed acceptance per block; steps with depends_on.`,
      "Use lib.search / lib.resolve to make parts resolved:true where possible. For critical parts without a datasheet mark facts:\"none\".",
      "Write the plan with plan.write and also output it as a ```json fence.",
    ].filter(Boolean).join("\n"),
    untrusted: [summary ? `sch.summary:\n${summary}` : "", refsBlock].filter(Boolean).join("\n\n"),
  };
}

export function reviewerBrief(scope: string, summary: string, planText: string | null): { brief: string; untrusted: string } {
  return {
    brief: [
      `Task: review ${scope}. Run project.check, gate.run, check.intent and diff.nets; then judge readability, rail usage, decoupling and interface declarations.`,
      "Output {\"findings\":[{origin, code, severity, confidence, evidence, remediation, refs, location?, proposed_ops?}]} in a ```json fence. Engine findings keep their code; advisory findings use ADVISORY_* codes.",
    ].join("\n"),
    untrusted: [`sch.summary:\n${summary}`, planText ? `plan:\n${planText}` : ""].filter(Boolean).join("\n\n"),
  };
}

export function librarianBrief(parts: { ref_prefix: string; lib_id?: string; description?: string }[]): { brief: string; untrusted: string } {
  return { brief: `Task: resolve these parts to library symbols and report {"bindings":[{ref_prefix, lib_id, footprint, pin_map, units_total, resolved, note}]} in a \`\`\`json fence. Parts: ${JSON.stringify(parts)}. Never invent lib_ids; resolved:false with a note when nothing fits.`, untrusted: "" };
}
