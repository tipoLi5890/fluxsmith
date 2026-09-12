// SPDX-License-Identifier: Apache-2.0
// Workflow interpreter (Phase D): node semantics with a fake host, and the
// "single truth" invariant between the harness path (`executeStep`) and the
// static permission summary of `greenfield-design`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isDTier, toolDef } from "../tools/manifest";
import { BUILTIN_WORKFLOWS, DESIGN_REVIEW, GREENFIELD_DESIGN, SOURCE_BOM } from "../workflows/builtins";
import { permissionSummary, validateWorkflow, type WorkflowDef } from "../workflows/schema";
import { compare, gateValue, pathGet, resolveArgs, WorkflowRunner, type RunnerHost } from "../workflows/runner";
import type { ToolResult } from "../tools/registry";
import type { Finding } from "../policy/types";

const ok = (data: unknown): ToolResult => ({ ok: true, data, meta: { bytes: 0 }, trust: "untrusted" });
const extract = (data: unknown): Finding[] => { const d = data as { findings?: Finding[] } | null; return Array.isArray(d?.findings) ? d!.findings : []; };

function fakeHost(over: Partial<RunnerHost> & { log?: string[] } = {}): RunnerHost & { log: string[] } {
  const log: string[] = over.log ?? [];
  return {
    turn: 3,
    mode: () => "review",
    policy: () => "review",
    tool: async (name, args) => { log.push(`tool:${name}:${JSON.stringify(args)}`); return ok({}); },
    agent: async (role, args) => { log.push(`agent:${role}:${String(args.brief).slice(0, 30)}`); return ok({ role, output: { findings: [] } }); },
    askCard: async (card) => { log.push(`card:${card.kind}:${card.title}`); return { action_id: "approve", consent_event_id: "ev-1" }; },
    checkpoint: async () => { log.push("checkpoint"); return true; },
    items: async (sel) => { log.push(`items:${sel}`); return [{ ref: "R1", sheet: "root.kicad_sch" }, { ref: "C1", sheet: "root.kicad_sch" }]; },
    enterBuild: async () => { log.push("enterBuild"); return true; },
    proposePlan: async () => { log.push("proposePlan"); return true; },
    status: (t) => log.push(`status:${t}`),
    addApply: () => log.push("addApply"),
    extractFindings: extract,
    ...over,
    log,
  };
}

describe("workflow runner helpers", () => {
  it("resolves paths with equality filters and templates", () => {
    const scope = { plan: { sheets: [{ file: "a", create: true }, { file: "b", create: false }] }, resolve: { output: { items: [1] } }, item: { ref: "R1" } };
    expect(pathGet(scope, "plan.sheets[create=true]")).toEqual([{ file: "a", create: true }]);
    expect(resolveArgs({ items: "{{ resolve.output.items }}", ref: "{{ item.ref }}", literal: "x", n: 2 }, scope)).toEqual({ items: [1], ref: "R1", literal: "x", n: 2 });
  });
  it("evaluates whitelisted gate sources from the last tool result only", () => {
    const last = ok({ ok: true, findings: [{ code: "A", severity: "Error" }, { code: "B", severity: "Warning" }] });
    expect(gateValue("integrity.errors", last, extract)).toBe(1);
    expect(gateValue("gate.ok", last, extract)).toBe(false);
    expect(gateValue("integrity.count", last, extract)).toBe(2);
    expect(gateValue("nope", last, extract)).toBeUndefined();
    expect(compare(1, "==", 0)).toBe(false);
    expect(compare(0, "<=", 0)).toBe(true);
  });
});

describe("workflow runner nodes", () => {
  it("runs design-review: tools in order, findings deduped, reviewer with narrowed tools", async () => {
    const host = fakeHost({
      tool: async (name) => { host.log.push(`tool:${name}`); return name === "gate.run" ? ok({ findings: [{ code: "ERC_X", severity: "Error", location: "R1" }, { code: "ERC_X", severity: "Error", location: "R1" }] }) : ok({}); },
    });
    const r = await new WorkflowRunner(host, DESIGN_REVIEW).run();
    expect(r.ok).toBe(true);
    expect(host.log.filter((l) => l.startsWith("tool:")).map((l) => l.split(":")[1])).toEqual(["project.check", "gate.run", "check.style", "check.intent", "diff.nets"]);
    expect(r.findings).toHaveLength(1);
    expect(host.log.some((l) => l.startsWith("agent:reviewer"))).toBe(true);
    expect(r.results.review).toBeTruthy();
  });

  it("loop stops at the first passing gate and `when: gate_failed` tools only run after a failure", async () => {
    let planCalls = 0;
    const def: WorkflowDef = { id: "t", version: 1, mode: "review", phases: [{ kind: "phase", id: "p", mode: "review", steps: [
      { kind: "loop", id: "fix", max: 3, steps: [
        { kind: "tool", id: "dry", tool: "sch.plan" },
        { kind: "gate", id: "g", source: "integrity.errors", op: "==", value: 0 },
        { kind: "tool", id: "after", tool: "check.integrity", when: "gate_failed" },
      ] },
    ] }] };
    const host = fakeHost({ tool: async (name) => { host.log.push(`tool:${name}`); if (name === "sch.plan") { planCalls++; return ok({ findings: planCalls < 2 ? [{ code: "E", severity: "Error" }] : [] }); } return ok({}); } });
    const r = await new WorkflowRunner(host, def).run();
    expect(r.ok).toBe(true);
    expect(planCalls).toBe(2);
    expect(host.log.filter((l) => l === "tool:check.integrity")).toHaveLength(1);
    expect(r.notes).toEqual([]);
  });

  it("foreach with concurrency 1 keeps items in order and exposes {{ item.* }} to tool args", async () => {
    const def: WorkflowDef = { id: "t", version: 1, mode: "review", phases: [{ kind: "foreach", id: "each", items: "components[fitted=true]", concurrency: 1, steps: [
      { kind: "tool", id: "look", tool: "sch.component", args: { ref: "{{ item.ref }}" } },
    ] }] };
    const host = fakeHost();
    const r = await new WorkflowRunner(host, def).run();
    expect(r.ok).toBe(true);
    expect(host.log.filter((l) => l.startsWith("tool:"))).toEqual(['tool:sch.component:{"ref":"R1"}', 'tool:sch.component:{"ref":"C1"}']);
  });

  it("ask_user maps option clicks and free text; approval abandon stops the run", async () => {
    const def: WorkflowDef = { id: "t", version: 1, mode: "review", phases: [
      { kind: "ask_user", id: "q", question: "now or later?", options: ["now", "later"], default: "later" },
      { kind: "approval", id: "ok", approves: "intent" },
      { kind: "note", id: "n", text: "unreachable" },
    ] };
    const host = fakeHost({ askCard: async (card) => (card.kind === "question" ? { action_id: "opt:1" } : { action_id: "abandon" }) });
    const r = await new WorkflowRunner(host, def).run();
    expect(r.results.q).toEqual({ answer: "later", action_id: "opt:1" });
    expect(r.ok).toBe(false);
    expect(r.stopped).toBe("ok: abandon");
    expect(r.notes).toEqual([]);
  });

  it("build phase asks for consent, opens Build, counts applies and honours limits.max_applies", async () => {
    const def: WorkflowDef = { id: "t", version: 1, mode: "build", limits: { max_applies: 1, max_sheets: 1, concurrency: 1 }, phases: [{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [
      { kind: "checkpoint", id: "cp" },
      { kind: "tool", id: "a1", tool: "sch.apply", args: { oplist: {} } },
      { kind: "tool", id: "a2", tool: "sch.apply", args: { oplist: {} } },
    ] }] };
    let mode: "review" | "build" = "review";
    const host = fakeHost({ mode: () => mode, enterBuild: async () => { mode = "build"; host.log.push("enterBuild"); return true; }, tool: async (name) => { host.log.push(`tool:${name}`); return ok({ applied: true }); } });
    const r = await new WorkflowRunner(host, def).run();
    expect(host.log.slice(0, 3)).toEqual(["card:mode_suggestion:card.mode_suggestion", "enterBuild", "checkpoint"]);
    expect(r.applies).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.stopped).toMatch(/max_applies/);
  });

  it("refused Build consent never reaches a D tool", async () => {
    const host = fakeHost({ askCard: async () => ({ action_id: "abandon" }) });
    const r = await new WorkflowRunner(host, SOURCE_BOM).run();
    expect(r.ok).toBe(false);
    expect(host.log.some((l) => l.startsWith("tool:"))).toBe(false);
  });

  it("source-bom feeds the sourcer output into parts.decision and the decision op-list into sch.apply", async () => {
    let mode: "review" | "build" = "build";
    const host = fakeHost({
      mode: () => mode,
      agent: async (role) => ok({ role, output: { candidates: [], items: [{ ref: "R1", expected: { mpn: "X" }, candidates: [], confidence: "low" }] }, narrative: "why" }),
      tool: async (name, args) => { host.log.push(`tool:${name}:${JSON.stringify(args)}`); if (name === "parts.decision") return ok({ oplist: { ops: [{ op: "set_component_parameters" }] } }); return ok({ applied: true }); },
    });
    const r = await new WorkflowRunner(host, SOURCE_BOM).run();
    expect(r.ok).toBe(true);
    const decision = host.log.find((l) => l.startsWith("tool:parts.decision"))!;
    expect(decision).toContain('"items":[{"ref":"R1"');
    expect(decision).toContain('"rationale":"why"');
    const bind = host.log.find((l) => l.startsWith("tool:sch.apply"))!;
    expect(bind).toContain('"oplist":{"ops":[{"op":"set_component_parameters"}]}');
    expect(bind).toContain('"target":"root.kicad_sch"');
    expect(host.log.filter((l) => l.startsWith("tool:parts.bom"))).toHaveLength(1);
    expect(r.applies).toBe(2);
  });

  it("approval approves: plan shows the plan card and ends the run", async () => {
    const def: WorkflowDef = { id: "t", version: 1, mode: "plan", phases: [{ kind: "phase", id: "p", mode: "plan", steps: [
      { kind: "approval", id: "adopt", approves: "plan" },
      { kind: "note", id: "n", text: "after" },
    ] }] };
    const host = fakeHost();
    const r = await new WorkflowRunner(host, def).run();
    expect(r.ok).toBe(true);
    expect(host.log).toEqual(["proposePlan"]);
  });
});

describe("harness / workflow single truth", () => {
  it("every built-in passes the static rules", () => {
    for (const w of BUILTIN_WORKFLOWS) expect({ id: w.id, errors: validateWorkflow(w) }).toEqual({ id: w.id, errors: [] });
  });

  it("permissionSummary(greenfield-design) D tools equal the D tools executeStep actually calls", () => {
    const src = readFileSync(resolve(process.cwd(), "src/agent/lead.ts"), "utf8");
    // executeStep plus the helpers it delegates writes to (same file, harness path only).
    const region = (name: string, until: string) => { const a = src.indexOf(`private async ${name}(`); const b = src.indexOf(until, a + 1); expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); return src.slice(a, b); };
    const text = [
      region("executeStep", "private async retryAfterLease("),
      // The plan `gate` step's fix rounds live in their own helper (it runs the KiCad advisory after them).
      region("gateStepRounds", "private async postTurnGate("),
      region("retryAfterLease", "private async runReviewTurn("),
      region("runErcFix", "private async resolveBlockParts("),
      region("resolveBlockParts", "private async guarded("),
    ].join("\n");
    const called = new Set<string>();
    for (const m of text.matchAll(/guarded\((?:"([a-z_.]+)"|applyTool)/g)) { if (m[1]) called.add(m[1]); else { called.add("sch.apply"); called.add("sch.apply_waived"); } }
    for (const name of called) expect(toolDef(name), name).toBeTruthy();
    const dCalled = [...called].filter(isDTier).sort();
    expect(dCalled.length).toBeGreaterThan(0);
    expect(permissionSummary(GREENFIELD_DESIGN).d_tools).toEqual(dCalled);
    // and every non-D tool the workflow names is one the harness path calls too
    const wfTools = new Set<string>();
    const walk = (steps: WorkflowDef["phases"]) => { for (const s of steps) { if (s.kind === "tool") wfTools.add(s.tool); if (s.kind === "loop" || s.kind === "foreach" || s.kind === "phase") walk(s.steps); } };
    walk(GREENFIELD_DESIGN.phases);
    for (const t of wfTools) if (!isDTier(t) && t !== "ops.expand") expect(called.has(t), `${t} named by greenfield-design but not called by executeStep`).toBe(true);
  });
});
