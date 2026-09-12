// SPDX-License-Identifier: Apache-2.0
// Tool executors: map manifest tools onto typed IPC commands. Applies byte
// caps, the untrusted envelope (P10 happens in the bus), H-tier cards and the
// idempotency cache (tool-manifest.md §1, §6).

import { planCard } from "../cards";
import { canonicalOpName, withProtocol } from "./ops";
import { oplistShapeRemediation, reshapeOplist } from "./oplist-shape";
import { call } from "../../ipc/client";
import type { Auth, EngineRequest, EngineResponse, SidecarWrite } from "../../ipc/types";
import type { Card, Ref } from "../api";
import { RESULT_CAP_DEFAULT, RESULT_CAP_SCH_READ, RESULT_CAP_SCH_SUMMARY } from "../limits";
import { canonicalJson, sha256Hex, truncateBytes, looksLikeInstruction } from "../util";
import type { SkillRegistry } from "../skills/registry";
import { toolDef, type ToolDef } from "./manifest";

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; remediation?: string; evidence?: unknown };
  /** Image blocks to attach to this tool result (attach.image). */
  images?: { data: string; mimeType: string }[];
  meta: { bytes: number; truncated?: boolean; hint?: string; request?: unknown; run_id?: string; ops_sha256?: string };
  trust: "untrusted";
}

export interface PlanStore {
  read(id?: string, version?: number): Promise<unknown>;
  writeDraft(plan: unknown): Promise<{ id: string; version: number }>;
  /** Merge a `plan.propose_change` payload into the approved plan as a new version (approval kept). */
  applyChange(changes: Record<string, unknown>): Promise<{ id: string; version: number }>;
}

/** Last successful plan.write per plan store: `{turn, role}`, so a second write in the same turn by another role is refused. */
const lastPlanWrite = new WeakMap<object, { turn: number; role: string }>();

export interface ToolContext {
  projectKey: string;
  auth: () => Auth;
  turn: number;
  step: string;
  role: string;
  skills: SkillRegistry;
  plans: PlanStore;
  selection: () => Ref[];
  /** H tier: show a card and wait for the answer. */
  askCard: (make: (turn: number) => Card) => Promise<{ action_id: string; free_text?: string; grant?: string; consent_event_id?: string }>;
  /** Project sheet files (root first), project-relative. */
  sheets: () => string[];
  /** Whether a DesignPlan exists for this session. */
  planState: () => "none" | "draft" | "approved";
  /** Effective approval policy of the running turn. */
  policy: () => "ask" | "review" | "auto";
  /** Show a card without waiting for the answer (the harness handles the click). */
  emitCard: (make: (turn: number) => Card) => void;
  emitFocus: (refs: Ref[]) => void;
  onStatus: (text: string) => void;
  /** Called by turn.begin with the declaration; returns the effective envelope. */
  turnBegin: (args: Record<string, unknown>) => Promise<unknown>;
  ledger: (step: string, phase: string, payload: unknown) => Promise<void>;
  /** Extra P3 expected merges computed after sch.plan. */
  expectedMerges: () => { into: string; sources_unnamed_only: boolean }[];
  /** Takes the grant unlocked by an approved hard stop (single-use, like the Rust grant it names). */
  unlockedGrant: (payloadSha: string) => string | undefined;
  /** Reason the human typed when approving `grant`, if any. */
  grantReason?: (grant: string) => string | undefined;
  /** @deprecated ignored (per-tool capability checks replaced the M3 switch). */
  m3?: boolean;
  vision: boolean;
}

export function resultText(r: ToolResult, capOverride?: number): string {
  const body = r.ok ? canonicalJson(r.data ?? null) : canonicalJson({ error: r.error });
  const cap = capOverride ?? RESULT_CAP_DEFAULT;
  const t = truncateBytes(body, cap);
  r.meta.bytes = t.text.length;
  if (t.truncated) { r.meta.truncated = true; r.meta.hint = r.meta.hint ?? "result truncated; use match/limit to narrow"; return `${t.text}\n[truncated; ${r.meta.hint}]`; }
  return t.text;
}

export function capFor(name: string): number {
  if (name === "sch.read") return RESULT_CAP_SCH_READ;
  if (name === "sch.summary") return RESULT_CAP_SCH_SUMMARY;
  return RESULT_CAP_DEFAULT;
}

function ok(data: unknown, meta: Partial<ToolResult["meta"]> = {}): ToolResult {
  return { ok: true, data, meta: { bytes: 0, ...meta }, trust: "untrusted" };
}
function fail(code: string, message: string, remediation?: string, evidence?: unknown): ToolResult {
  return { ok: false, error: { code, message, remediation, evidence }, meta: { bytes: 0 }, trust: "untrusted" };
}

function fromEngine(resp: EngineResponse): ToolResult {
  if (resp.ok) return ok(resp.data, { request: undefined, run_id: resp.meta.run_id, ops_sha256: resp.meta.ops_sha256, hint: resp.meta.hint, truncated: resp.meta.truncated });
  return fail(resp.error?.code ?? "ENGINE_ERROR", resp.error?.message ?? "engine error", resp.error?.remediation, resp.error?.evidence);
}

/** Run a Rust command and map its IpcError into a tool failure (untrusted result). */
async function rust(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (e) {
    const err = e as { error?: { code: string; message: string; remediation?: string; evidence?: unknown } };
    return fail(err.error?.code ?? "IPC_TRANSPORT", err.error?.message ?? String(e), err.error?.remediation, err.error?.evidence);
  }
}

async function engine(ctx: ToolContext, request: EngineRequest, grant?: string): Promise<ToolResult> {
  const auth: Auth = { ...ctx.auth(), role: ctx.role };
  if (grant) auth.grant = grant;
  try {
    const resp = await call("engine_request", { project_key: ctx.projectKey, request, auth });
    return fromEngine(resp);
  } catch (e) {
    const err = e as { error?: { code: string; message: string; remediation?: string; evidence?: unknown } };
    return fail(err.error?.code ?? "IPC_TRANSPORT", err.error?.message ?? String(e), err.error?.remediation, err.error?.evidence);
  }
}

/**
 * The op-list argument of every op-list tool, shape-repaired (`reshapeOplist`: wrapper, bare array,
 * ops buried in the group entries) and then canonicalised (`normalizeOplist` through `withProtocol`).
 * One helper so the five call sites cannot drift apart.
 */
function oplistArg(ctx: ToolContext, raw: unknown): unknown {
  return withProtocol(reshapeOplist(raw), ctx.sheets());
}

/** Engine codes that mean the op-list envelope itself did not parse (the shape, not an op). */
const SHAPE_CODES: ReadonlySet<string> = new Set(["OPLIST_SCHEMA"]);

/**
 * A shape refusal answered with the shape, not with "fix the field named in the message": the model
 * that wrote `{"groups":[{"ops":[…]}]}` cannot see from `missing field 'ops'` that its ops were in
 * the wrong place. `raw` is what the model actually sent, so the keys quoted back are its own.
 */
function withShapeHint(r: ToolResult, raw: unknown): ToolResult {
  if (r.ok || !r.error || !SHAPE_CODES.has(r.error.code)) return r;
  return { ...r, error: { ...r.error, remediation: oplistShapeRemediation(raw) } };
}

/**
 * Models regularly mangle `lib_id`s they resolved a moment ago (dropping the
 * `nickname:` separator, e.g. `MCU_Microchip_ATtiny1616-S`). The engine then
 * refuses with SYMBOL_NOT_FOUND and the model invents a "project cache" story.
 * Before validate/plan/apply, resolve every `lib_id`; for the unresolvable ones
 * look up the symbol index with progressively shorter suffixes and rewrite the
 * id when exactly one symbol carries that name. Corrections are recorded on the
 * op (`lib_id_corrected_from`) so the model sees what happened.
 */
const libIdCache = new Map<string, string | null>();
/** Unresolvable ids, remembered for one turn: validate -> plan -> apply must not pay the search three times. */
const libIdNegatives = new Map<string, number>();
export async function fixLibIds(ctx: ToolContext, oplist: unknown): Promise<unknown> {
  if (!oplist || typeof oplist !== "object" || !Array.isArray((oplist as { ops?: unknown }).ops)) return oplist;
  const ops = (oplist as { ops: Record<string, unknown>[] }).ops;
  let changed = false;
  const out = [];
  for (const op of ops) {
    const id = op.lib_id;
    if (typeof id !== "string" || id.length === 0) { out.push(op); continue; }
    const fixed = await resolveLibId(ctx, id);
    if (fixed && fixed !== id) { changed = true; out.push({ ...op, lib_id: fixed, lib_id_corrected_from: id }); } else out.push(op);
  }
  return changed ? { ...(oplist as object), ops: out } : oplist;
}
async function resolveLibId(ctx: ToolContext, id: string): Promise<string | null> {
  const key = `${ctx.projectKey}|${id}`;
  const hit = libIdCache.get(key);
  if (hit !== undefined) return hit;
  if (libIdNegatives.get(key) === ctx.turn) return null;
  let result: string | null = null;
  try {
    const r = await call("engine_request", { project_key: ctx.projectKey, request: { kind: "lib_resolve", lib_id: id }, auth: { ...ctx.auth(), role: ctx.role } });
    const state = r.ok ? (r.data as { state?: string }).state : "none";
    if (state && state !== "none") result = id;
    else {
      // Candidate symbol names: after the last ':' if present, else drop leading '_'-separated tokens one at a time.
      const tail = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
      const parts = tail.split("_");
      const cands = new Set<string>();
      for (let i = 0; i < parts.length; i++) cands.add(parts.slice(i).join("_"));
      for (const cand of cands) {
        if (cand.length < 3) continue;
        const s = await call("engine_request", { project_key: ctx.projectKey, request: { kind: "lib_search", query: cand, limit: 8 }, auth: { ...ctx.auth(), role: ctx.role } });
        if (!s.ok) {
          // The index is still building (first launch): not a "no such symbol" answer, so do not remember a negative.
          if (String(s.error?.code ?? "").startsWith("SYMBOL_INDEX")) return null;
          break;
        }
        const rows = ((s.data as { results?: { lib_id: string; name: string }[] }).results ?? []).filter((x) => x.name.toLowerCase() === cand.toLowerCase());
        if (rows.length === 1) { result = rows[0].lib_id; break; }
        if (rows.length > 1) break;
      }
    }
  } catch { result = null; }
  if (result) libIdCache.set(key, result); else libIdNegatives.set(key, ctx.turn); // negatives live for this turn only
  return result;
}

async function sidecar(ctx: ToolContext, write: SidecarWrite): Promise<ToolResult> {
  try { await call("sidecar_write", { project_key: ctx.projectKey, write }); return ok({}); } catch (e) {
    const err = e as { error?: { code: string; message: string; remediation?: string; evidence?: unknown } };
    return fail(err.error?.code ?? "SIDECAR_WRITE", err.error?.message ?? String(e), err.error?.remediation, err.error?.evidence);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const arr = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

/** Idempotency cache for S/H tools (semantic key, memory only). */
export class IdempotencyCache {
  private map = new Map<string, ToolResult>();
  key(name: string, args: unknown, turn: number, step: string): string {
    return sha256Hex(`${name}|${canonicalJson(args)}|${turn}|${step}`);
  }
  get(k: string): ToolResult | undefined { return this.map.get(k); }
  set(k: string, r: ToolResult): void { this.map.set(k, r); }
  clear(): void { this.map.clear(); }
}

export async function executeTool(def: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const a = args;
  switch (def.name) {
    // ---- turn / plan
    case "turn.begin": return ok(await ctx.turnBegin(a));
    case "turn.status": ctx.onStatus(String(a.text ?? "")); return ok({});
    case "turn.ledger": await ctx.ledger(String(a.step), String(a.phase), a.payload); return ok({});
    case "plan.read": return ok(await ctx.plans.read(str(a.id) ?? undefined, num(a.version) ?? undefined));
    case "plan.write": {
      // One plan card per turn: when the Architect already wrote the plan this turn, the Lead's own rewrite would
      // put a second card in front of the human (seen in real runs: two adoptions of version 1 in one turn).
      const prev = lastPlanWrite.get(ctx.plans);
      if (prev && prev.turn === ctx.turn && prev.role !== ctx.role && ctx.role === "lead") {
        return fail("PLAN_ALREADY_WRITTEN", `the ${prev.role} wrote the plan in this turn and its card is shown to the human`, "do not rewrite it; end the turn with a short summary and wait for the human's decision (use plan.propose_change after adoption)");
      }
      const { validatePlan, normalizePlan, reconcileSheets, ensureBlockSteps, droppedAllowedOps, uncheckableAcceptanceBlocks, derivedAcceptanceCount, missingFootprintParts, PLAN_SCHEMA_HINT } = await import("../plans/schema");
      // Read off the raw plan, before normalisation drops them: op names that are not opspec v1.
      const dropped_ops = droppedAllowedOps(a.plan);
      const plan0 = ensureBlockSteps(reconcileSheets(normalizePlan(a.plan), ctx.sheets()));
      const uncheckable = uncheckableAcceptanceBlocks(plan0);
      // Rows normalisation restated from the plan's own parts and nets, for blocks that declared
      // nothing the engine can check (`deriveAcceptance`); reported so the model knows they are there.
      const derived_acceptance = derivedAcceptanceCount(plan0);
      // Generic passives with no footprint: the plan does not say which package it means, and the human
      // reads the package off the plan card. A warning, never an error — the plan stays writable.
      const missing_footprints = missingFootprintParts(plan0);
      const errors = validatePlan(plan0);
      // `resolved` is decided here, against the symbol libraries, never taken from the model.
      const unresolved: string[] = [];
      for (const b of plan0.blocks) for (const part of b.parts) {
        const id = typeof part.lib_id === "string" ? part.lib_id.trim() : "";
        const hit = id ? await resolveLibId(ctx, id) : null;
        if (hit) { part.lib_id = hit; part.resolved = true; continue; }
        part.resolved = false;
        if (!part.mpn && !part.lcsc) unresolved.push(`${b.id}/${part.ref_prefix}: ${id || "(no lib_id)"}`);
      }
      if (unresolved.length) errors.push(`parts not found in the symbol libraries (use lib.search and give the exact lib_id, or an mpn/lcsc for the Sourcer): ${unresolved.join(", ")}`);
      if (errors.length) return fail("PLAN_INVALID", errors.join("; "), `fix and call plan.write again. ${PLAN_SCHEMA_HINT}`, errors);
      a.plan = plan0;
      const written = await ctx.plans.writeDraft(plan0);
      lastPlanWrite.set(ctx.plans, { turn: ctx.turn, role: ctx.role });
      // The plan card is how the human says "go": adopting it enters Build and runs step 1.
      const plan = a.plan as { steps?: unknown[]; title?: string; budget?: unknown };
      const { planMarkdown } = await import("../plans/schema");
      ctx.emitCard((turn) => planCard(turn, a.plan, { steps: plan.steps?.length ?? 0, title: plan.title ?? "", ...written }, undefined, planMarkdown(a.plan as import("../plans/schema").DesignPlan)));
      // Two soft reports, so the plan stays writable and the model can still fix it in one retry:
      // op names that are not in the vocabulary were dropped from the envelope, and a block with no
      // engine-checkable acceptance is one the gate can neither pass nor fail (red line 6: the
      // harness reports what the engine can answer, it never judges the circuit itself).
      return ok({
        ...written,
        ...(derived_acceptance ? { derived_acceptance, derived_acceptance_note: "the harness restated your blocks' own parts and nets as that many typed acceptance rows (component_count / net_has_pins), because those blocks declared none the engine could check; write your own typed rows if you want the gate to report something more precise" } : {}),
        ...(dropped_ops.length ? { dropped_ops, dropped_ops_note: "these allowed_ops names are not opspec v1 ops and were dropped from the plan; call plan.write again with the op names your brief lists if the plan needs them" } : {}),
        ...(uncheckable.length || missing_footprints.length ? {
          warnings: [
            ...(uncheckable.length ? [{ code: "PLAN_ACCEPTANCE_UNCHECKABLE", blocks: uncheckable, message: "these blocks declare no acceptance the engine can check (text rows are informational): add pin_on_net / net_has_pins / component_count / check_clean rows so the gate can report on them" }] : []),
            ...(missing_footprints.length ? [{ code: "PLAN_PART_FOOTPRINT_MISSING", parts: missing_footprints, message: "these generic passives (Device:R / Device:C / Device:L / Device:LED) carry no footprint, so the plan does not say which package it means and the human cannot sign off on one: call plan.write again with a footprint on every one of them (e.g. \"Resistor_SMD:R_0603_1608Metric\")" }] : []),
          ],
        } : {}),
        note: "plan draft saved; a plan card was shown to the human — end the turn with a short summary and wait for their decision (do not ask them to switch modes yourself)",
      });
    }
    case "plan.propose_change": {
      if (ctx.planState() !== "approved") return fail("PLAN_NOT_APPROVED", "there is no approved plan to change", "write the whole plan with plan.write instead");
      const changes = (a.changes && typeof a.changes === "object" ? a.changes : {}) as Record<string, unknown>;
      // Auto adjudicates only changes that do not widen authority (goal, constraints, step summaries).
      // Envelope, sheets, structural actions and new steps need the human (red line 13: the ceiling is
      // never model-produced), so under Auto they are declined and the Lead continues within the plan.
      if (ctx.policy() === "auto") {
        const widening = ["envelope", "sheets", "steps", "structural", "rails", "budgets"].filter((k) => k in changes);
        if (widening.length) return fail("PLAN_CHANGE_NEEDS_HUMAN", `Auto cannot accept a plan change to ${widening.join(", ")}`, "continue within the approved plan, or end the turn and ask the human to switch to Review and accept the change");
        const w = await ctx.plans.applyChange(changes);
        ctx.emitCard((turn) => ({ id: "", kind: "plan_approval", turn, title: "card.plan_change", body_md: String(a.rationale ?? ""), actions: [], data: { changes }, auto: { decision: "accept", reason: "auto policy" } }));
        return ok({ card_id: "plan_change", answer: "accept", ...w, note: "the change is now part of the approved plan; call turn.begin again if your envelope needs the new sheets/ops" });
      }
      const r = await ctx.askCard((turn) => ({ id: "", kind: "plan_approval", turn, title: "card.plan_change", body_md: String(a.rationale ?? ""), actions: [{ id: "accept", label_key: "card.accept_as_new_version", style: "primary" }, { id: "reject", label_key: "card.reject", style: "secondary" }], data: { changes } }));
      if (r.action_id !== "accept") return ok({ card_id: "plan_change", answer: r.action_id, note: "the human declined; continue within the current plan" });
      const w = await ctx.plans.applyChange(changes);
      return ok({ card_id: "plan_change", answer: "accept", ...w, note: "the change is now part of the approved plan; call turn.begin again if your envelope needs the new sheets/ops" });
    }
    case "notes.append": {
      const text = String(a.text ?? "");
      if (looksLikeInstruction(text)) return fail("NOTE_INSTRUCTION_LIKE", "notes must be why-records, not instructions");
      return sidecar(ctx, { kind: "notes", text, anchor: a.anchor ?? { turn: ctx.turn } });
    }
    case "suggest_mode": {
      if (a.mode === "build") {
        return ctx.planState() === "none"
          ? fail("PLAN_REQUIRED", "In Plan mode a request that needs changes must first become a DesignPlan.", "Call plan.write with the full plan (blocks, parts, steps, acceptance); the plan card offers the human review / auto / discuss. Do not suggest switching modes.")
          : fail("PLAN_CARD_PENDING", "The plan card already offers the human to start Build.", "End the turn with a two-line summary; the human starts Build from the plan card.");
      }
      const r = await ctx.askCard((turn) => ({ id: "", kind: "mode_suggestion", turn, title: "card.mode_suggestion", body_md: String(a.reason ?? ""), actions: [{ id: "switch", label_key: `card.switch_to_${String(a.mode)}`, style: "primary", ...(a.mode === "build" ? { consent: { grant_kind: "user_action", payload_sha256: sha256Hex(`enter_build:${ctx.projectKey}`) } } : {}) }, { id: "dismiss", label_key: "card.dismiss", style: "secondary" }], data: { mode: a.mode } }));
      // The harness switches the mode itself when the human accepts (index.ts answerCard) and
      // re-runs the request as a fresh turn in the new mode; tell the model to stop here.
      return ok({ card_id: "suggest_mode", answer: r.action_id, note: r.action_id === "switch" ? "the human accepted: the harness switches the mode and re-runs this request as a new turn; finish this turn with a one-line acknowledgement and no further tool calls" : "the human declined; continue within the current mode" });
    }
    // ---- project / policy
    case "project.info": {
      const info = await call("project_info", { project_key: ctx.projectKey });
      return ok({ root: info.root, sheets: info.sheets, version: info.version, config_effective: info.config, git: info.git });
    }
    case "project.check": return engine(ctx, { kind: "project_check" });
    case "project.new": return fail("NOT_SUPPORTED_IN_TURN", "project.new is performed from the UI new-project flow");
    case "sheet.create": return engine(ctx, { kind: "sheet_create", file: String(a.file), name: String(a.name), at_mil: a.at_mil as [number, number], size_mil: a.size_mil as [number, number], pins: Array.isArray(a.pins) ? a.pins : [], paper: str(a.paper), parent: str(a.parent) });
    case "policy.read": return engine(ctx, { kind: "policy_read" });
    case "policy.waive": {
      const payload = { code: a.code, refs: a.refs, severity: a.severity, reason: a.reason, expires: a.expires };
      const sha = sha256Hex(canonicalJson(payload));
      const r = await ctx.askCard((turn) => ({ id: "", kind: "waiver", turn, title: "card.waiver", body_md: String(a.reason ?? ""), actions: [{ id: "approve", label_key: "card.approve", style: "primary", consent: { grant_kind: "waiver", payload_sha256: sha } }, { id: "reject", label_key: "card.reject", style: "secondary" }], data: payload }));
      if (r.action_id !== "approve" || !r.grant) return ok({ card_id: "waiver", answer: r.action_id });
      return engine(ctx, { kind: "policy_waive", code: String(a.code), refs: arr(a.refs), severity: str(a.severity), reason: String(a.reason), expires: str(a.expires) }, r.grant);
    }
    // ---- read
    case "sch.summary": return engine(ctx, { kind: "summary", sheet: str(a.sheet) });
    case "sch.read": return engine(ctx, { kind: "read", sheet: str(a.sheet), match: str(a.match), limit: num(a.limit) });
    case "sch.nets": return engine(ctx, { kind: "nets", sheet: str(a.sheet), match: str(a.match), limit: num(a.limit) });
    case "sch.net": return engine(ctx, { kind: "net", name: String(a.name) });
    case "sch.component": return engine(ctx, { kind: "component", reference: String(a.ref), unit: num(a.unit) });
    case "sch.pins": return engine(ctx, { kind: "pins", lib_id: String(a.lib_id), at_mil: a.at_mil as [number, number], rotation: Number(a.rotation ?? 0), mirror: str(a.mirror), unit: num(a.unit) });
    case "sch.bbox": {
      // Accept both `[[x0,y0],[x1,y1]]` and the flat `[x0,y0,x1,y1]` the model often writes.
      const r = a.region as unknown;
      const region = Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number") ? ([[r[0], r[1]], [r[2], r[3]]] as [[number, number], [number, number]]) : ((r as [[number, number], [number, number]] | undefined) ?? null);
      return engine(ctx, { kind: "bbox", refs: arr(a.refs), region_mil: region });
    }
    case "canvas.selection": return ok({ refs: ctx.selection() });
    case "canvas.focus": {
      const refs: Ref[] = [...(arr(a.refs) ?? []).map((r) => ({ kind: "component", ref: r }) as Ref), ...(arr(a.nets) ?? []).map((n) => ({ kind: "net", name: n }) as Ref)];
      ctx.emitFocus(refs);
      return ok({});
    }
    // ---- lib
    case "lib.search": return engine(ctx, { kind: "lib_search", query: str(a.query), lib_id: str(a.lib_id), category: str(a.category), pins: num(a.pins), limit: num(a.limit) });
    case "lib.resolve": return engine(ctx, { kind: "lib_resolve", lib_id: String(a.lib_id) });
    case "lib.symbol": return engine(ctx, { kind: "lib_symbol", lib_id: String(a.lib_id) });
    // ---- ops
    case "ops.list": return engine(ctx, { kind: "ops_list" });
    // Canonicalise here too: an op-list is normalised on the way in (normalizeOplist), but a bare
    // `ops.template("add_symbol")` used to reach the engine raw and come back OP_UNKNOWN, which is the
    // one call whose whole purpose is to recover from not knowing the vocabulary.
    case "ops.template": return engine(ctx, { kind: "ops_template", op: canonicalOpName(String(a.op)), required_only: typeof a.required_only === "boolean" ? a.required_only : null });
    case "ops.validate": return withShapeHint(await engine(ctx, { kind: "ops_validate", oplist: await fixLibIds(ctx, oplistArg(ctx, a.oplist)) }), a.oplist);
    case "ops.expand": return withShapeHint(await engine(ctx, { kind: "ops_expand", oplist: oplistArg(ctx, a.oplist) }), a.oplist);
    // ---- write / dry-run
    case "sch.dryrun_scratch": return withShapeHint(await engine(ctx, { kind: "dryrun_scratch", oplist: oplistArg(ctx, a.oplist), target: String(a.target) }), a.oplist);
    case "sch.plan": return withShapeHint(await engine(ctx, { kind: "plan", oplist: await fixLibIds(ctx, oplistArg(ctx, a.oplist)), target: targetOf(ctx, a), flat: typeof a.flat === "boolean" ? a.flat : null }), a.oplist);
    case "sch.apply": {
      const merges = [...ctx.expectedMerges(), ...((a.expected_merges as { into: string; sources_unnamed_only: boolean }[] | undefined) ?? [])];
      // A net-risk approval unlocks this exact apply: run it waived right here instead of asking the model to re-issue it.
      const nr = ctx.unlockedGrant("net_risk");
      // The grant travels in `waived` (Rust consumes it there with kind net_risk); it must not be `auth.grant`,
      // which Rust would check against kind "apply" and refuse.
      return withShapeHint(await engine(ctx, { kind: "apply", oplist: await fixLibIds(ctx, oplistArg(ctx, a.oplist)), target: targetOf(ctx, a), expected_merges: merges, note: String(a.note ?? ""), waived: nr ? { grant_id: nr, reason: ctx.grantReason?.(nr) ?? "approved by the user on the net-risk card" } : null, strict_layout: a.strict_layout === false ? false : null }), a.oplist);
    }
    case "sch.apply_waived": {
      const sha = sha256Hex(canonicalJson({ oplist: a.oplist, target: a.target }));
      const grant = ctx.unlockedGrant(sha) ?? ctx.unlockedGrant("net_risk");
      if (!grant) return fail("GRANT_REQUIRED", "sch.apply_waived requires an approved net_risk hard stop", "wait for the user's approval card");
      // Same pipeline as sch.apply (lib_id repair, protocol_version, target resolution, expected merges): the
      // op-list the human approved on the card must be written in the form that was verified.
      const merges = [...ctx.expectedMerges(), ...((a.expected_merges as { into: string; sources_unnamed_only: boolean }[] | undefined) ?? [])];
      return withShapeHint(await engine(ctx, { kind: "apply", oplist: await fixLibIds(ctx, oplistArg(ctx, a.oplist)), target: targetOf(ctx, a), expected_merges: merges, note: String(a.note ?? ""), waived: { grant_id: grant, reason: ctx.grantReason?.(grant) ?? String(a.reason ?? "") }, strict_layout: a.strict_layout === false ? false : null }), a.oplist);
    }
    case "intent.snapshot": {
      const sha = sha256Hex(canonicalJson({ note: a.note, turn: ctx.turn }));
      const r = await ctx.askCard((turn) => ({ id: "", kind: "intent", turn, title: "card.intent", body_md: String(a.note ?? ""), actions: [{ id: "approve", label_key: "card.mark_known_good", style: "primary", consent: { grant_kind: "intent", payload_sha256: sha } }, { id: "reject", label_key: "card.reject", style: "secondary" }] }));
      if (r.action_id !== "approve" || !r.grant) return ok({ card_id: "intent", answer: r.action_id });
      return engine(ctx, { kind: "intent_snapshot", note: String(a.note ?? "") }, r.grant);
    }
    // ---- verify
    case "check.integrity": case "check.erc": case "check.nets": case "check.pinmap": case "check.power": case "check.intent": case "check.layout": case "check.style": {
      const family = def.name.split(".")[1] as "integrity" | "erc" | "nets" | "pinmap" | "power" | "intent" | "layout" | "style";
      return engine(ctx, { kind: "check", family, sheet: str(a.sheet) });
    }
    case "gate.run": return engine(ctx, { kind: "gate_run" });
    case "diff.nets": return engine(ctx, { kind: "diff_nets", before: String(a.before), after: str(a.after) });
    // ---- parts / facts / docs (M3)
    // ---- parts sourcing (jlcsearch + EasyEDA via Rust `parts` whitelist; every result is a claim)
    case "parts.search": return rust(() => call("parts_search", { query: str(a.query), mpn: str(a.mpn), lcsc: str(a.lcsc), value: str(a.value), package: str(a.package), category: str(a.category), limit: num(a.limit), in_stock: typeof a.in_stock === "boolean" ? a.in_stock : null, basic_only: typeof a.basic_only === "boolean" ? a.basic_only : null }));
    case "parts.show": return rust(() => call("parts_show", { lcsc: String(a.lcsc ?? "") }));
    case "parts.datasheet": return rust(() => call("parts_datasheet", { project_key: ctx.projectKey, lcsc: str(a.lcsc), mpn: str(a.mpn) }));
    case "parts.convert": {
      try {
        const res = await call("parts_convert", { project_key: ctx.projectKey, lcsc: String(a.lcsc ?? ""), lib_nickname: str(a.lib_nickname), with_3d: typeof a.with_3d === "boolean" ? a.with_3d : null, auth: { ...ctx.auth(), role: ctx.role } });
        return fromEngine(res);
      } catch (e) {
        const err = e as { error?: { code: string; message: string; remediation?: string; evidence?: unknown } };
        return fail(err.error?.code ?? "IPC_TRANSPORT", err.error?.message ?? String(e), err.error?.remediation, err.error?.evidence);
      }
    }
    // ---- shared parts library (db-backed, no network)
    case "parts.library": {
      try {
        const rows = (await call("db_query", { query: { kind: "parts_cache_list", query: str(a.query) } })) as unknown[];
        return ok({ results: Array.isArray(rows) ? rows.slice(0, 50) : [], total: Array.isArray(rows) ? rows.length : 0, claim: true, note: "shared parts library snapshot; parts.convert {lcsc} reuses these assets without a network call" });
      } catch (e) { return fail("IPC_TRANSPORT", String(e)); }
    }
    case "parts.bom": return rust(() => call("parts_bom", { project_key: ctx.projectKey, lock: a.lock === true, against_lock: a.against_lock === true ? "bom.lock.json" : str(a.against_lock) }));
    case "parts.decision": {
      const { partsDecisionCard, applyPartsDecision, normalizeDecisionItems, factsConfirm } = await import("./parts-decision");
      const items = normalizeDecisionItems(a.items);
      if (!items.length) return fail("PARTS_DECISION_EMPTY", "items[] needs at least one {ref, expected, actual?, candidates?} entry");
      // `expected` and `actual` are both the model's reading of the catalogue. The only evidence on
      // this card that is not a claim is a `facts.write` document, whose quotes Rust verified
      // against the datasheet PDF: a value it confirms is what lets the card preselect `accept`.
      for (const it of items) {
        const mpn = String(it.actual?.mpn ?? "").trim();
        if (!mpn) continue;
        try {
          const doc = await call("sidecar_read", { project_key: ctx.projectKey, kind: "facts", key: mpn });
          const fields = factsConfirm(doc, it.actual);
          if (fields.length) { it.verified = true; it.verified_fields = fields; }
        } catch { /* no facts for this MPN: the item stays a claim */ }
      }
      const r = await ctx.askCard((turn) => partsDecisionCard(turn, items, str(a.rationale) ?? ""));
      if (r.action_id !== "apply") return ok({ card_id: "parts_decision", answer: r.action_id, note: "the human dismissed the card; leave these parts unresolved and say so in the summary" });
      const d = applyPartsDecision({ items }, r.action_id, r.free_text);
      return ok({ card_id: "parts_decision", answer: "apply", decisions: d.decisions, oplist: d.oplist, note: d.oplist.ops.length ? "apply this oplist with sch.apply (Build; envelope needs set_component_parameters / set_component_attributes), then parts.bom {lock:true}" : "nothing to write; record the outcome in the summary" });
    }
    case "docs.pdf_text": return rust(() => call("pdf_text", { sha256: String(a.sha256 ?? ""), pages: Array.isArray(a.pages) ? a.pages.map(Number).filter((n) => Number.isInteger(n) && n > 0) : null }));
    case "facts.write": {
      const facts = Array.isArray(a.facts) ? (a.facts as Record<string, unknown>[]) : [];
      if (!facts.length) return fail("FACT_PROVENANCE", "facts[] is empty");
      const bad = facts.filter((f) => !(typeof f.page === "number" && f.page >= 1) || typeof f.quote !== "string" || !(f.quote as string).trim().length || typeof f.key !== "string");
      if (bad.length) return fail("FACT_PROVENANCE", "every fact needs key, page (1-based) and a verbatim quote from docs.pdf_text", "re-read the page with docs.pdf_text and copy the sentence exactly", bad);
      const source = (a.source && typeof a.source === "object" ? a.source : { sha256: a.sha256 }) as Record<string, unknown>;
      if (typeof source.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(source.sha256)) return fail("FACT_PROVENANCE", "source.sha256 must be the PDF handle returned by parts.datasheet (64 hex)", "call parts.datasheet first and cite its sha256");
      return sidecar(ctx, { kind: "facts", mpn: String(a.mpn ?? "").trim(), facts: { source, facts, pins: Array.isArray(a.pins) ? a.pins : [] } });
    }
    case "web.search": return fail("TOOL_NOT_AVAILABLE", "web.search needs a provider with native web search", "use web.fetch on a known URL (vendor page, datasheet link) or parts.search for components");
    case "web.fetch": {
      const url = String(a.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return fail("BAD_URL", "web.fetch needs an absolute http(s) URL");
      const first = await rust(() => call("web_fetch_text", { url }));
      if (first.ok || first.error?.code !== "CONSENT_REQUIRED") return first;
      // First fetch from this origin: the human approves it once (DB `approvals`, kind fetch_origin), then we retry.
      const origin = String((first.error.evidence as { origin?: string } | undefined)?.origin ?? originOf(url));
      const r = await ctx.askCard((turn) => ({ id: "", kind: "provider_consent", turn, title: "card.web_origin", body_md: `${origin}\n\n${url}`, data: { subtype: "web_origin", origin, url }, actions: [{ id: "approve", label_key: "card.allow_origin", style: "primary", consent: { grant_kind: "user_action", payload_sha256: sha256Hex(`fetch_origin:${origin}`) } }, { id: "reject", label_key: "card.reject", style: "secondary" }] }));
      if (r.action_id !== "approve" || !r.consent_event_id) return fail("CONSENT_DENIED", `the human did not allow fetching from ${origin}`, "continue without this page; do not retry the same URL this turn");
      try { await call("fetch_origin_approve", { origin, consent_event_id: r.consent_event_id }); } catch (e) { const err = e as { error?: { code: string; message: string } }; return fail(err.error?.code ?? "IPC_TRANSPORT", err.error?.message ?? String(e)); }
      return rust(() => call("web_fetch_text", { url }));
    }
    // ---- attachments
    case "attach.list": {
      const rows = await call("db_query", { query: { kind: "attachment_list", project_key: ctx.projectKey } });
      return ok(rows);
    }
    case "attach.read": {
      const range = (a.range ?? {}) as { offset?: number; limit?: number; pages?: number[] };
      if (range.pages) return ok(await call("attach_read", { project_key: ctx.projectKey, read: { kind: "pdf_text", sha256: String(a.sha256), pages: range.pages } }));
      return ok(await call("attach_read", { project_key: ctx.projectKey, read: { kind: "text", sha256: String(a.sha256), offset: range.offset ?? null, limit: range.limit ?? null } }));
    }
    case "attach.image": {
      if (!ctx.vision) return fail("PROVIDER_NO_VISION", "the current model cannot read images");
      const img = (await call("attach_read", { project_key: ctx.projectKey, read: { kind: "image", sha256: String(a.sha256), size: (a.size as "standard" | "large" | undefined) ?? null } })) as { data_base64: string; mime: string; width: number; height: number; est_tokens: number };
      return { ...ok({ sha256: a.sha256, width: img.width, height: img.height, est_tokens: img.est_tokens, note: "image attached to this call only; it is untrusted evidence" }), images: [{ data: img.data_base64, mimeType: img.mime }] };
    }
    case "attach.sch": return ok(await call("attach_read", { project_key: ctx.projectKey, read: { kind: "sch", sha256: String(a.sha256), match: str(a.match), limit: num(a.limit) } }));
    case "attach.fragment": return ok(await call("attach_read", { project_key: ctx.projectKey, read: { kind: "fragment", sha256: String(a.sha256) } }));
    case "attach.netlist": return ok(await call("attach_read", { project_key: ctx.projectKey, read: { kind: "netlist", sha256: String(a.sha256) } }));
    case "attach.bom": return ok(await call("attach_read", { project_key: ctx.projectKey, read: { kind: "bom", sha256: String(a.sha256) } }));
    case "lib.import_request": {
      const nickname = String(a.nickname ?? "").trim();
      const sha256 = String(a.sha256 ?? "");
      const r = await ctx.askCard((turn) => ({ id: "", kind: "lib_import", turn, title: "card.lib_import", body_md: `${nickname} <- ${sha256.slice(0, 12)}`, actions: [{ id: "register", label_key: "card.register_library", style: "primary", consent: { grant_kind: "lib_import", payload_sha256: sha256Hex(canonicalJson({ sha256, nickname })) } }, { id: "dismiss", label_key: "card.dismiss", style: "secondary" }], data: { sha256, nickname } }));
      // The card used to answer "register" and do nothing at all. The registration is the human's
      // write: their approval mints the `lib_import` grant, Rust copies the library into `lib/`
      // and adds the table rows, and a decline is an error the model must not retry.
      if (r.action_id !== "register" || !r.grant) return fail("CONSENT_DENIED", `the human did not register ${nickname || "the library"}`, "continue without this library; do not ask again this turn");
      try {
        const out = await call("lib_register", { project_key: ctx.projectKey, request: { nickname, sha256 }, auth: { grant: r.grant } });
        return ok({ card_id: "lib_import", answer: "register", nickname: out.nickname, symbols: out.symbols, registered: out.registered, note: "the library is registered; lib.resolve <nickname>:<symbol> confirms a lib_id before you place it" });
      } catch (e) {
        const err = e as { error?: { code: string; message: string; remediation?: string } };
        return fail(err.error?.code ?? "IPC_TRANSPORT", err.error?.message ?? String(e), err.error?.remediation);
      }
    }
    // ---- human
    case "ask_user": {
      const options = arr(a.options) ?? undefined;
      const multi = a.multi === true;
      const r = await ctx.askCard((turn) => ({ id: "", kind: "question", turn, title: "card.question", body_md: String(a.question ?? ""), actions: [...(options ?? []).map((o, i) => ({ id: `opt:${i}`, label_key: "card.option", label: o, style: i === 0 ? ("primary" as const) : ("secondary" as const) })), ...(a.allow_free_text !== false || multi ? [{ id: "free", label_key: "card.answer_free", style: "secondary" as const }] : [])], data: { options, default: a.default, multi } }));
      const answer = r.action_id.startsWith("opt:") ? options?.[Number(r.action_id.slice(4))] ?? r.action_id : r.free_text ?? r.action_id;
      return ok({ answer, source: r.action_id === "default" ? "default" : "user" });
    }
    case "request_approval": return fail("INTERNAL", "request_approval is raised by hooks, not callable");
    // ---- skills
    case "skill.list": return ok(ctx.skills.list());
    case "skill.open": {
      const sec = str(a.section)?.replace(/^#/, "").trim() || undefined;
      try { return ok(ctx.skills.open(String(a.name), sec)); } catch (e) {
        // Unknown section: hand back the whole skill plus its section ids instead of failing.
        if ((e as Error).message === "SKILL_SECTION_NOT_FOUND") { try { const whole = ctx.skills.open(String(a.name)); return ok({ ...whole, note: `section "${sec}" not found; sections: ${whole.sections.map((x) => x.id).join(", ")}` }); } catch { /* fall through */ } }
        return fail((e as Error).message, `cannot open skill ${String(a.name)}`);
      }
    }
    case "skill.reference": {
      try { return ok({ text: await ctx.skills.reference(String(a.name), String(a.path)) }); } catch (e) { return fail((e as Error).message, `cannot read reference ${String(a.path)}`); }
    }
    case "skill.draft": {
      if (looksLikeInstruction(String(a.section_text ?? ""))) return fail("SKILL_INSTRUCTION_LIKE", "skill text must describe how to draw, not issue instructions");
      const payload = { pack: a.pack, name: a.name, section_text: a.section_text, activation: a.activation, scope: a.scope };
      const sha = sha256Hex(canonicalJson(payload));
      const r = await ctx.askCard((turn) => ({ id: "", kind: "skill_draft", turn, title: "card.skill_draft", body_md: String(a.section_text ?? ""), actions: [{ id: "save", label_key: "card.save_skill", style: "primary", consent: { grant_kind: "skill_draft", payload_sha256: sha } }, { id: "dismiss", label_key: "card.dismiss", style: "secondary" }], data: payload }));
      if (r.action_id !== "save" || !r.grant) return ok({ card_id: "skill_draft", answer: r.action_id });
      const info = await call("skills_write_draft", { pack: String(a.pack), name: String(a.name), section_text: String(a.section_text), activation: str(a.activation), scope: a.scope as "project" | "user", project_key: ctx.projectKey, grant: r.grant });
      return ok({ card_id: "skill_draft", answer: "saved", pack: info.pack });
    }
    case "export.svg": case "export.netlist": case "export.findings": case "export.plan": case "export.bom": {
      return fail("EXPORT_VIA_UI", "exports open an OS file dialog; ask the user to export from the sidebar");
    }
    default:
      return fail("TOOL_UNKNOWN", `unknown tool ${def.name}`);
  }
}

export function lookup(name: string): ToolDef | undefined {
  return toolDef(name);
}


function originOf(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return url; }
}

/** `target` defaults to the project's root sheet when the model omits it (single-sheet projects). */
function targetOf(ctx: ToolContext, a: Record<string, unknown>): string {
  const t = typeof a.target === "string" && a.target.trim() ? a.target.trim() : "";
  if (t && t !== "/" && t !== "root") return t;
  return ctx.sheets()[0] ?? t;
}
