// SPDX-License-Identifier: Apache-2.0
// Workflow interpreter (agent-runtime.md §9, M4). It runs the *non-verify*
// flows only: skill-pack YAML, design-review, adopt-existing, datasheet-first
// and source-bom. greenfield-design / incremental-edit / fix-findings stay on
// the harness path (`LeadLoop.executeStep`) whose p4 / lease / stylist / ercfix
// retries have no node vocabulary; a vitest invariant keeps the two in sync.
//
// The runner never touches the engine, the hooks or the ledger itself: every
// node maps onto a host function the Lead already owns (`guarded`, `dispatch`,
// `askCard`, `checkpoint_create`), so the policy chain P0–P12 and the Rust
// side checks apply exactly as on the model-driven path.

import type { Card, Role } from "../api";
import type { Mode } from "../../ipc/types";
import { hardStopCard, questionCard } from "../cards";
import { isWaived, type Finding } from "../policy/types";
import type { ToolResult } from "../tools/registry";
import { ENGINE_RESULT_FIELDS, type StepDef, type WorkflowDef } from "./schema";

export interface CardAnswer { action_id: string; free_text?: string; consent_event_id?: string; grant?: string }

/** What the runner needs from the Lead. Every function is one existing Lead facility. */
export interface RunnerHost {
  turn: number;
  mode: () => Mode;
  policy: () => "ask" | "review" | "auto";
  /** `guarded(...)`: hook chain + ledger + checkpoint-before-D. */
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** `dispatch(...)`: one subagent run with the role's frozen tool set (workflow `tools` narrow it further). */
  agent: (role: Role, args: Record<string, unknown>, tools: string[] | undefined) => Promise<ToolResult>;
  askCard: (card: Card) => Promise<CardAnswer>;
  /** `checkpoint_create` if the turn has none yet. */
  checkpoint: () => Promise<boolean>;
  /** Resolve a `foreach.items` selector (`plan.blocks`, `findings[selected=true]`, `components[fitted=true]` ...). */
  items: (selector: string) => Promise<unknown[]>;
  /** `phase.requires_consent` into Build: the host opens the BuildSession with the consent event. */
  enterBuild: (consent_event_id: string) => Promise<boolean>;
  /** `approval approves: plan` — show the plan card; adoption is handled by the app, the run stops here. */
  proposePlan: () => Promise<boolean>;
  status: (text: string) => void;
  /** `limits.max_applies` accounting (BudgetLedger.addApply). */
  addApply: () => void;
  /** Findings extracted from an engine result (Lead's extractFindings). */
  extractFindings: (data: unknown) => Finding[];
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  /** Why the run ended early (user abandon, gate/limit, consent refused, abort). */
  stopped?: string;
  /** Last result per step id (tool data / agent output / answer). foreach steps hold the last item's value. */
  results: Record<string, unknown>;
  /** Every finding seen in tool results, deduped by code|location. */
  findings: Finding[];
  applies: number;
  notes: string[];
}

const TEMPLATE = /^\{\{\s*([a-z_.\[\]0-9=" ]+)\s*\}\}$/i;

/** Resolve `{{ step.path }}` template strings from the scope (results + current item). Non-template values pass through. */
export function resolveArgs(args: Record<string, unknown> | undefined, scope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (typeof v === "string") { const m = TEMPLATE.exec(v); out[k] = m ? pathGet(scope, m[1].trim()) : v; }
    else out[k] = v;
  }
  return out;
}

export function pathGet(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (!seg) continue;
    if (cur === null || cur === undefined) return undefined;
    const m = /^([a-z_0-9]+)(?:\[([a-z_0-9]+)="?([a-z0-9_.-]+)"?\])?$/i.exec(seg);
    if (!m) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]];
    if (m[2] !== undefined && Array.isArray(cur)) cur = cur.filter((x) => x && typeof x === "object" && String((x as Record<string, unknown>)[m[2]]) === m[3]);
  }
  return cur;
}

/** Evaluate a whitelisted `gate.source` against the last tool result. */
export function gateValue(source: string, last: ToolResult | null, extract: (data: unknown) => Finding[]): unknown {
  if (!last) return undefined;
  const d = (last.data ?? {}) as Record<string, unknown>;
  // A finding a live project waiver covers is reported but never counted: the gate's verdict has
  // already excluded it in the engine, so the workflow's own arithmetic must too.
  const open = () => extract(d).filter((f) => !isWaived(f));
  const errors = () => open().filter((f) => f.severity === "Error").length;
  switch (source) {
    case "gate.ok": return last.ok && d.ok !== false && errors() === 0;
    case "integrity.count": return open().length;
    case "integrity.errors": case "erc.errors": case "findings.errors": case "check.errors": case "layout.errors": case "project.errors": return errors();
    case "net_diff.has_risk": { const nd = d.net_diff as { has_risk?: boolean; changes?: unknown[] } | undefined; return nd?.has_risk ?? ((nd?.changes?.length ?? 0) > 0); }
    case "acceptance.failed": { const a = d.acceptance as { failed?: number | unknown[] } | undefined; return Array.isArray(a?.failed) ? a!.failed.length : (a?.failed ?? 0); }
    default: return undefined;
  }
}

export function compare(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case "==": return a === b;
    case "!=": return a !== b;
    case "<": return Number(a) < Number(b);
    case "<=": return Number(a) <= Number(b);
    case ">": return Number(a) > Number(b);
    case ">=": return Number(a) >= Number(b);
    default: return false;
  }
}

class Stop extends Error { constructor(public reason: string) { super(reason); } }

/** Bounded concurrency without a shared semaphore (foreach.concurrency on agent-only bodies). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

export class WorkflowRunner {
  private results: Record<string, unknown> = {};
  private findings: Finding[] = [];
  private seen = new Set<string>();
  private applies = 0;
  private notes: string[] = [];
  private lastTool: ToolResult | null = null;

  constructor(private host: RunnerHost, private def: WorkflowDef) {}

  async run(): Promise<RunResult> {
    try {
      await this.steps(this.def.phases, { item: undefined, lastGate: null });
      return this.done(true);
    } catch (e) {
      if (e instanceof Stop) return this.done(false, e.reason);
      return this.done(false, `error: ${String(e)}`);
    }
  }

  private done(ok: boolean, stopped?: string): RunResult {
    return { ok, stopped, results: this.results, findings: this.findings, applies: this.applies, notes: this.notes };
  }

  private scope(item: unknown): Record<string, unknown> { return { ...this.results, item }; }

  private addFindings(data: unknown): void {
    for (const f of this.host.extractFindings(data)) {
      const k = `${f.code}|${f.location ?? f.message ?? ""}`;
      if (!this.seen.has(k)) { this.seen.add(k); this.findings.push(f); }
    }
  }

  private check(): void { if (this.host.signal?.aborted) throw new Stop("aborted"); }

  private async steps(steps: StepDef[], ctx: { item: unknown; lastGate: boolean | null }): Promise<void> {
    for (const s of steps) {
      this.check();
      switch (s.kind) {
        case "note": this.notes.push(s.text); this.host.status(s.text); break;
        case "checkpoint": { const ok = await this.host.checkpoint(); if (!ok) throw new Stop("checkpoint failed"); break; }
        case "tool": {
          if (s.when && s.when !== "always") {
            if (ctx.lastGate === null) break;
            if (s.when === "gate_failed" && ctx.lastGate) break;
            if (s.when === "gate_passed" && !ctx.lastGate) break;
          }
          if (s.tool === "sch.apply" || s.tool === "sch.apply_waived" || s.tool === "sheet.create") {
            const max = this.def.limits?.max_applies ?? null;
            if (max !== null && this.applies >= max) throw new Stop(`limits.max_applies (${max}) reached`);
          }
          const args = resolveArgs(s.args, this.scope(ctx.item));
          const r = await this.host.tool(s.tool, args);
          this.lastTool = r;
          this.results[s.id] = r.data;
          if (r.ok) this.addFindings(r.data);
          if (r.ok && (s.tool === "sch.apply" || s.tool === "sch.apply_waived" || s.tool === "sheet.create") && (r.data as { applied?: boolean })?.applied !== false) { this.applies++; this.host.addApply(); }
          if (!r.ok && r.error?.code === "USER_SKIPPED") throw new Stop("user skipped");
          if (!r.ok && /^(P[0-9]+|BUILD_SESSION_REQUIRED|CHECKPOINT_FAILED|MODE)/.test(r.error?.code ?? "")) throw new Stop(`${s.id}: ${r.error?.code} ${r.error?.message ?? ""}`.trim());
          break;
        }
        case "gate": {
          if (!ENGINE_RESULT_FIELDS.has(s.source)) throw new Stop(`${s.id}: gate source not allowed`);
          const v = gateValue(s.source, this.lastTool, this.host.extractFindings);
          const passed = compare(v, s.op, s.value);
          ctx.lastGate = passed;
          this.results[s.id] = { source: s.source, value: v, passed };
          if (!passed) this.host.status(`gate ${s.id}: ${s.source} = ${JSON.stringify(v)} (want ${s.op} ${JSON.stringify(s.value)})`);
          break;
        }
        case "agent": {
          const args: Record<string, unknown> = { role: s.role, brief: s.brief ?? `workflow ${this.def.id} step ${s.id}${s.output ? ` (return ${s.output})` : ""}`, item: ctx.item };
          const r = await this.host.agent(s.role, args, s.tools);
          this.results[s.id] = r.ok ? r.data : { error: r.error };
          if (!r.ok) this.host.status(`${s.id}: ${r.error?.code ?? "failed"} ${r.error?.message ?? ""}`.trim());
          if (!r.ok && r.error?.code === "PROVIDER_MISSING") throw new Stop(r.error.message);
          break;
        }
        case "ask_user": {
          const card = questionCard(this.host.turn, s.question, s.options, true, s.default);
          const a = await this.host.askCard(card);
          const opt = /^opt:(\d+)$/.exec(a.action_id);
          const answer = opt ? (s.options ?? [])[Number(opt[1])] : a.action_id === "default" ? s.default : a.free_text ?? (a.action_id === "skip" ? s.default : a.action_id);
          this.results[s.id] = { answer, action_id: a.action_id };
          break;
        }
        case "approval": {
          if (s.approves === "plan") {
            const shown = await this.host.proposePlan();
            if (!shown) throw new Stop("no plan to approve");
            this.notes.push("plan card shown; the run resumes when the plan is adopted");
            return;
          }
          if (this.host.policy() === "auto" && s.approves !== "structural") { this.results[s.id] = { auto: true }; this.notes.push(`${s.id}: auto-approved (${s.approves})`); break; }
          const card = hardStopCard(this.host.turn, s.approves === "structural" ? "structural" : "scope", { workflow: this.def.id, step: s.id, approves: s.approves }, undefined, s.approves);
          const a = await this.host.askCard(card);
          this.results[s.id] = { action_id: a.action_id, grant: a.grant };
          if (a.action_id !== "approve") throw new Stop(`${s.id}: ${a.action_id}`);
          break;
        }
        case "loop": {
          let inner: { item: unknown; lastGate: boolean | null } = { item: ctx.item, lastGate: null };
          for (let i = 0; i < s.max; i++) {
            inner = { item: ctx.item, lastGate: null };
            await this.stepsUntilGatePass(s.steps, inner);
            if (inner.lastGate === true) break;
          }
          if (inner.lastGate === false) this.notes.push(`${s.id}: gate still failing after ${s.max} rounds`);
          break;
        }
        case "foreach": {
          const items = await this.host.items(s.items);
          const conc = Math.max(1, s.concurrency ?? 1);
          await mapLimit(items, conc, async (item) => { await this.steps(s.steps, { item, lastGate: null }); });
          break;
        }
        case "phase": {
          if (s.mode !== this.host.mode()) {
            if (s.mode === "build") {
              if (!s.requires_consent) throw new Stop(`${s.id}: build phase without consent`);
              const card = hardStopCard(this.host.turn, "scope", { workflow: this.def.id, phase: s.id, enter: "build" }, undefined, "user_action");
              card.kind = "mode_suggestion"; card.title = "card.mode_suggestion"; card.data = { mode: "build", workflow: this.def.id };
              card.actions = [{ id: "approve", label_key: "card.switch_to_build", style: "primary", consent: card.actions.find((a) => a.id === "approve")?.consent }, { id: "abandon", label_key: "card.dismiss", style: "secondary" }];
              const a = await this.host.askCard(card);
              if (a.action_id !== "approve" || !a.consent_event_id) throw new Stop(`${s.id}: build consent refused`);
              if (!(await this.host.enterBuild(a.consent_event_id))) throw new Stop(`${s.id}: build session not opened`);
            }
            // plan / review phases only narrow what the tools may do; the host keeps its mode.
          }
          await this.steps(s.steps, { item: ctx.item, lastGate: null });
          break;
        }
        default: break;
      }
    }
  }

  /** Loop body: stop at the first gate that passes (the fix agent after it only runs on failure). */
  private async stepsUntilGatePass(steps: StepDef[], ctx: { item: unknown; lastGate: boolean | null }): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      await this.steps([s], ctx);
      if (s.kind === "gate" && ctx.lastGate === true) return;
    }
  }
}
