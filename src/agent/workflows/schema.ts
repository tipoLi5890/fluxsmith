// SPDX-License-Identifier: Apache-2.0
// Workflow definitions + load-time static rules (agent-runtime.md §9.1,
// skill-packs.md §6). YAML from packs must deep-equal these shapes after parse.

import { parse as parseYaml } from "yaml";
import { isDTier, toolDef } from "../tools/manifest";
import type { Mode } from "../../ipc/types";
import type { Role } from "../api";

export type StepDef =
  | { kind: "agent"; id: string; role: Role; tools?: string[]; skills?: string[]; output?: string; brief?: string }
  | { kind: "tool"; id: string; tool: string; args?: Record<string, unknown>; structural?: boolean; when?: WhenCond }
  | { kind: "gate"; id: string; source: string; op: "==" | "!=" | "<" | "<=" | ">" | ">="; value: unknown }
  | { kind: "loop"; id: string; max: number; steps: StepDef[] }
  | { kind: "foreach"; id: string; items: string; concurrency?: number; steps: StepDef[] }
  | { kind: "ask_user"; id: string; question: string; options?: string[]; default?: string }
  | { kind: "approval"; id: string; approves: string }
  | { kind: "checkpoint"; id: string }
  | { kind: "note"; id: string; text: string }
  | { kind: "phase"; id: string; mode: Mode; requires_consent?: boolean; steps: StepDef[] };

export type WhenCond = "gate_failed" | "gate_passed" | "always";

export interface WorkflowDef {
  id: string;
  version: number;
  mode: Mode;
  limits?: { max_applies: number; max_sheets: number; concurrency: number };
  phases: StepDef[];
}

const ALLOWED_KEYS: Record<string, Set<string>> = {
  agent: new Set(["kind", "id", "role", "tools", "skills", "output", "brief"]),
  tool: new Set(["kind", "id", "tool", "args", "structural", "when"]),
  gate: new Set(["kind", "id", "source", "op", "value"]),
  loop: new Set(["kind", "id", "max", "steps"]),
  foreach: new Set(["kind", "id", "items", "concurrency", "steps"]),
  ask_user: new Set(["kind", "id", "question", "options", "default"]),
  approval: new Set(["kind", "id", "approves"]),
  checkpoint: new Set(["kind", "id"]),
  note: new Set(["kind", "id", "text"]),
  phase: new Set(["kind", "id", "mode", "requires_consent", "steps"]),
};

/** Engine result fields a gate may read (whitelist). */
export const ENGINE_RESULT_FIELDS = new Set([
  "gate.ok", "integrity.errors", "integrity.count", "erc.errors", "net_diff.has_risk", "acceptance.failed", "findings.errors", "check.errors", "layout.errors", "project.errors",
]);

const FIX_ATTEMPTS_MAX = 2;

export function validateWorkflow(w: WorkflowDef): string[] {
  const e: string[] = [];
  if (!w.id) e.push("id required");
  if (!["plan", "build", "review"].includes(w.mode)) e.push("mode invalid");
  const dTools: string[] = [];
  const walk = (steps: StepDef[], ctx: { phaseMode: Mode; lastGate: string | null; approvals: string[]; inForeach: boolean; inLoop: boolean; path: string }) => {
    let localCtx = { ...ctx };
    for (const s of steps) {
      const keys = Object.keys(s);
      const allowed = ALLOWED_KEYS[s.kind];
      if (!allowed) { e.push(`${ctx.path}: unknown step kind ${(s as { kind: string }).kind}`); continue; }
      for (const k of keys) if (!allowed.has(k)) e.push(`${s.id}: key ${k} not allowed on ${s.kind}`);
      switch (s.kind) {
        case "tool": {
          if (!toolDef(s.tool)) e.push(`${s.id}: unknown tool ${s.tool}`);
          if (isDTier(s.tool)) {
            dTools.push(s.tool);
            if (localCtx.phaseMode !== "build") e.push(`${s.id}: D tool ${s.tool} requires mode: build`);
            if (localCtx.inForeach) { /* allowed only with concurrency 1 — checked at foreach */ }
          }
          if (s.structural && !localCtx.approvals.length) e.push(`${s.id}: structural step must be preceded by an approval in the same phase`);
          if (s.when && s.when !== "always" && !localCtx.lastGate) e.push(`${s.id}: when: refers to no preceding gate in this loop`);
          if (s.args) for (const v of Object.values(s.args)) if (typeof v === "string" && /\{\{.*\}\}/.test(v) && !/^\{\{\s*[a-z_.\[\]0-9=" ]+\s*\}\}$/i.test(v)) e.push(`${s.id}: template expression not allowed: ${v}`);
          break;
        }
        case "agent": {
          for (const t of s.tools ?? []) if (isDTier(t)) e.push(`${s.id}: agent steps may not carry D tool ${t}`);
          if (s.role === "lead") e.push(`${s.id}: workflow agent steps cannot impersonate lead`);
          break;
        }
        case "gate": {
          if (!ENGINE_RESULT_FIELDS.has(s.source)) e.push(`${s.id}: gate.source must be an engine result field`);
          localCtx = { ...localCtx, lastGate: s.id };
          break;
        }
        case "approval": localCtx = { ...localCtx, approvals: [...localCtx.approvals, s.approves] }; break;
        case "loop": {
          if (s.max !== FIX_ATTEMPTS_MAX + 1) e.push(`${s.id}: loop.max must equal fix_attempts_max + 1`);
          walk(s.steps, { ...localCtx, lastGate: null, inLoop: true, path: s.id });
          break;
        }
        case "foreach": {
          if (!/^[a-z_.]+(\[[a-z_]+="?[a-z0-9_.-]+"?\])?$/i.test(s.items)) e.push(`${s.id}: items must be a path with optional equality filter`);
          const hasD = s.steps.some((x) => x.kind === "tool" && isDTier(x.tool)) || s.steps.some((x) => x.kind === "loop" && x.steps.some((y) => y.kind === "tool" && isDTier(y.tool)));
          const agentChild = s.steps.some((x) => x.kind === "agent");
          if (s.concurrency !== undefined && s.concurrency > 1 && (hasD || !agentChild)) e.push(`${s.id}: concurrency only on agent-only foreach`);
          if (hasD && (s.concurrency ?? 1) !== 1) e.push(`${s.id}: foreach with D tools must have concurrency 1`);
          walk(s.steps, { ...localCtx, inForeach: true, path: s.id });
          break;
        }
        case "phase": {
          if (s.mode !== w.mode && !s.requires_consent) e.push(`${s.id}: mode switch at phase boundary requires requires_consent`);
          if (s.mode === "build" && !s.requires_consent) e.push(`${s.id}: build phase requires requires_consent`);
          walk(s.steps, { phaseMode: s.mode, lastGate: null, approvals: [], inForeach: false, inLoop: false, path: s.id });
          break;
        }
        default: break;
      }
    }
  };
  walk(w.phases, { phaseMode: w.mode, lastGate: null, approvals: [], inForeach: false, inLoop: false, path: w.id });
  if (dTools.length && w.mode !== "build") e.push("workflows with D tools must declare mode: build");
  if (dTools.length && !w.limits) e.push("workflows with D tools must declare limits");
  return e;
}

/** Static permission summary shown on the trust screen. */
export function permissionSummary(w: WorkflowDef): { mode: Mode; d_tools: string[]; structural: number; concurrency: number; max_applies: number | null; sheet_selectors: string[] } {
  const d = new Set<string>();
  let structural = 0;
  let concurrency = 1;
  const selectors: string[] = [];
  const walk = (steps: StepDef[]) => {
    for (const s of steps) {
      if (s.kind === "tool") { if (isDTier(s.tool)) d.add(s.tool); if (s.structural) structural++; }
      if (s.kind === "foreach") { concurrency = Math.max(concurrency, s.concurrency ?? 1); selectors.push(s.items); walk(s.steps); }
      if (s.kind === "loop" || s.kind === "phase") walk(s.steps);
    }
  };
  walk(w.phases);
  return { mode: w.mode, d_tools: [...d].sort(), structural, concurrency, max_applies: w.limits?.max_applies ?? null, sheet_selectors: selectors };
}

export function parseWorkflowYaml(text: string): { def: WorkflowDef | null; errors: string[] } {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) { return { def: null, errors: [`yaml: ${String(e)}`] }; }
  if (!raw || typeof raw !== "object") return { def: null, errors: ["workflow must be a mapping"] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["id", "version", "mode", "limits", "phases"].includes(k)) return { def: null, errors: [`unknown top-level key ${k}`] };
  const def = o as unknown as WorkflowDef;
  const errors = validateWorkflow(def);
  return { def: errors.length ? null : def, errors };
}

/** Workflows that need a second consent (mode: build) — trust_workflows. */
export function needsWorkflowConsent(w: WorkflowDef): boolean {
  return w.mode === "build" || permissionSummary(w).d_tools.length > 0;
}
