// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOWS, GREENFIELD_DESIGN } from "../workflows/builtins";
import { needsWorkflowConsent, parseWorkflowYaml, permissionSummary, validateWorkflow, type WorkflowDef } from "../workflows/schema";
import { changeAllowed, intersectEnvelope, planSummary, sessionCeiling, stepEnvelope, validatePlan, type DesignPlan } from "../plans/schema";
import { adjudicate, AutoSkipTracker, dependentSkips } from "../auto-policy";

describe("workflow static rules", () => {
  it("built-ins pass", () => {
    for (const w of BUILTIN_WORKFLOWS) expect(validateWorkflow(w), w.id).toEqual([]);
    expect(needsWorkflowConsent(GREENFIELD_DESIGN)).toBe(true);
    const ps = permissionSummary(GREENFIELD_DESIGN);
    expect(ps.d_tools).toContain("sch.apply");
    expect(ps.structural).toBe(1);
  });
  const base = (phases: WorkflowDef["phases"], over: Partial<WorkflowDef> = {}): WorkflowDef => ({ id: "t", version: 1, mode: "build", limits: { max_applies: 1, max_sheets: 1, concurrency: 1 }, phases, ...over });
  it("rejects D tool outside mode: build", () => {
    const w = base([{ kind: "phase", id: "p", mode: "plan", steps: [{ kind: "tool", id: "a", tool: "sch.apply" }] }], { mode: "plan" });
    expect(validateWorkflow(w).some((e) => /requires mode: build|must declare mode: build/.test(e))).toBe(true);
  });
  it("rejects structural without approval, bad gate source, agent with D, missing limits, loop.max, foreach concurrency with D", () => {
    const noApproval = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "tool", id: "s", tool: "sheet.create", structural: true }] }]);
    expect(validateWorkflow(noApproval).some((e) => /preceded by an approval/.test(e))).toBe(true);
    const badGate = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "gate", id: "g", source: "model.says_ok", op: "==", value: true }] }]);
    expect(validateWorkflow(badGate).some((e) => /engine result field/.test(e))).toBe(true);
    const agentD = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "agent", id: "a", role: "drafter", tools: ["sch.apply"] }] }]);
    expect(validateWorkflow(agentD).some((e) => /may not carry D tool/.test(e))).toBe(true);
    const noLimits = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "tool", id: "a", tool: "sch.apply" }] }], { limits: undefined });
    expect(validateWorkflow(noLimits)).toContain("workflows with D tools must declare limits");
    const badLoop = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "loop", id: "l", max: 5, steps: [] }] }]);
    expect(validateWorkflow(badLoop).some((e) => /loop.max/.test(e))).toBe(true);
    const conc = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "foreach", id: "f", items: "plan.blocks", concurrency: 3, steps: [{ kind: "tool", id: "a", tool: "sch.apply" }] }] }]);
    expect(validateWorkflow(conc).some((e) => /concurrency/.test(e))).toBe(true);
    const unknownKey = base([{ kind: "phase", id: "b", mode: "build", requires_consent: true, steps: [{ kind: "note", id: "n", text: "x", shell: "rm -rf" } as unknown as WorkflowDef["phases"][number]] }]);
    expect(validateWorkflow(unknownKey).some((e) => /key shell not allowed/.test(e))).toBe(true);
  });
  it("yaml parse rejects unknown top-level keys and build phase without consent", () => {
    expect(parseWorkflowYaml("id: x\nhooks: []\n").errors[0]).toMatch(/unknown top-level key/);
    const y = parseWorkflowYaml("id: x\nversion: 1\nmode: build\nlimits: {max_applies: 1, max_sheets: 1, concurrency: 1}\nphases:\n  - kind: phase\n    id: b\n    mode: build\n    steps:\n      - kind: tool\n        id: a\n        tool: sch.apply\n");
    expect(y.def).toBeNull();
    expect(y.errors.some((e) => /requires_consent/.test(e))).toBe(true);
  });
});

const plan: DesignPlan = {
  schema_version: 1, kind: "schematic", id: "plan-1", version: 1, created: "", source: "architect", goal: "LDO", constraints: [], assumptions: [], open_questions: [],
  sheets: [{ file: "root.kicad_sch", role: "root", paper: "A4" }], interfaces: [{ net: "+3V3", mechanism: "power_port" }], net_naming: { rails: ["VBUS", "+3V3", "GND"], rail_mechanism: "power_port" },
  conventions: [], floorplan: { "root.kicad_sch": [{ group: "ldo", origin_mil: [1000, 1000], extent_mil: [2000, 1500] }] },
  blocks: [{ id: "ldo", sheet: "root.kicad_sch", summary: "ldo", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AP2112K-3.3", resolved: true }, { ref_prefix: "C", lib_id: "Device:C", resolved: true }, { ref_prefix: "C", lib_id: "Device:C", resolved: true }], nets_in: ["VBUS", "GND"], nets_out: ["+3V3"], acceptance: [{ type: "net_has_pins", net: "+3V3", min: 2 }] }],
  steps: [{ id: "s1", block: "ldo", kind: "draft" }, { id: "s2", kind: "wiring", nets: ["+3V3"], depends_on: ["s1"] }, { id: "s3", kind: "gate", depends_on: ["s1", "s2"] }],
  envelope: { budgets: { components_added: 20, components_deleted: 0, components_moved: 0, objects_deleted: {}, wires_added: 50, labels_added: 30, properties_changed: {}, transforms_changed: 0, attributes_changed: 0 }, nets: { rails: ["VBUS", "+3V3", "GND"], renamable: [], may_create_named: true }, structural: [], allowed_ops: ["place_component", "add_net_label", "place_power_port"] },
  refdes_policy: { frozen_existing: true, reuse_freed: false }, budget: { tokens: null, cost_usd: 5, tool_calls: 400, wall_active_min: 60 }, display: { status: "draft", approved_at: null },
};

describe("plans", () => {
  it("validates and derives step envelopes; declarations only shrink", () => {
    expect(validatePlan(plan)).toEqual([]);
    expect(validatePlan({ ...plan, blocks: [{ ...plan.blocks[0], parts: Array(13).fill(plan.blocks[0].parts[1]) }] }).some((e) => /> 12/.test(e))).toBe(true);
    const env = stepEnvelope(plan, plan.steps[0]);
    expect(env.sheets).toEqual(["root.kicad_sch"]);
    expect(env.components_added_max).toBe(12);
    expect(env.source).toBe("plan:plan-1@1/s1");
    const { env: e2, widened } = intersectEnvelope(env, { components_added_max: 50, sheets: ["root.kicad_sch", "other.kicad_sch"] });
    expect(widened.length).toBe(2);
    expect(e2.components_added_max).toBe(12);
    expect(e2.sheets).toEqual(["root.kicad_sch"]);
    const c = sessionCeiling(24, ["root.kicad_sch"], ["GND"]);
    expect(c.components_deleted_max).toBe(0);
    expect(intersectEnvelope(c, { allowed_ops: ["add_wire"] }).env.allowed_ops).toEqual(["add_wire"]);
    expect(planSummary(plan).steps).toBe(3);
    expect(changeAllowed(plan, { envelope: { ...plan.envelope, budgets: { ...plan.envelope.budgets, components_deleted: 2 } } })).toContain("cannot widen components_deleted");
    expect(changeAllowed(plan, { net_naming: { rails: ["VBUS", "+5V"], rail_mechanism: "power_port" } })).toContain("cannot add rails");
  });
});

describe("Auto adjudication table", () => {
  it("matches the frozen table", () => {
    const b = (c: Parameters<typeof adjudicate>[0]["condition"], extra: Partial<Parameters<typeof adjudicate>[0]> = {}) => adjudicate({ condition: c, step: "s1", mode: "build", ...extra })?.action;
    expect(b("net_risk_a")).toBe("allowed_expected_merge");
    expect(b("refdes_conflict")).toBe("retried_refdes");
    expect(b("refdes_conflict", { retried: true })).toBe("skipped");
    expect(b("provider_retryable", { providerRetries: 1 })).toBe("retried_provider");
    expect(b("provider_retryable", { providerRetries: 3 })).toBe("stop");
    expect(b("ask_user", { hasDefault: true })).toBe("default_answer");
    expect(b("ask_user", { hasDefault: false })).toBe("skipped");
    for (const c of ["scope_widen", "structural", "interface", "symbol_not_found", "net_risk_b", "unresolved"] as const) expect(b(c)).toBe("reverted_and_skipped");
    for (const c of ["budget", "environment", "provider_exhausted", "context_exhausted"] as const) expect(b(c)).toBe("stop");
    expect(adjudicate({ condition: "scope_widen", step: "s1", mode: "plan" })).toBeNull();
  });
  it("pauses after 3 consecutive skips or > 30% skipped; dependency skips propagate", () => {
    const t = new AutoSkipTracker(10);
    expect(t.record({ step: "a", condition: "unresolved", action: "reverted_and_skipped" })).toBe(false);
    expect(t.record({ step: "b", condition: "unresolved", action: "reverted_and_skipped" })).toBe(false);
    expect(t.record({ step: "c", condition: "unresolved", action: "reverted_and_skipped" })).toBe(true);
    const t2 = new AutoSkipTracker(3);
    t2.record({ step: "a", condition: "unresolved", action: "skipped" });
    expect(t2.shouldPause()).toBe(true);
    expect(dependentSkips(plan.steps, new Set(["s1"]))).toEqual(["s2", "s3"]);
  });
});

describe("scaffold step envelope", () => {
  it("covers the parent sheet as well as the block's own sheet", async () => {
    const { stepEnvelope } = await import("../plans/schema");
    const p = { ...plan, sheets: [{ file: "root.kicad_sch" }, { file: "power.kicad_sch", create: true }], blocks: plan.blocks.map((b) => ({ ...b, sheet: "power.kicad_sch" })) };
    const scaffold = stepEnvelope(p, { id: "s0", kind: "scaffold", block: p.blocks[0].id });
    expect(scaffold.sheets).toEqual(["root.kicad_sch", "power.kicad_sch"]);
    const draft = stepEnvelope(p, { id: "s1", kind: "draft", block: p.blocks[0].id });
    expect(draft.sheets).toEqual(["power.kicad_sch"]);
  });

  // Real run 17, turn 3: the root draft emitted add_sheet_pin on the `power` sheet symbol, which seeds a
  // hierarchical label inside power.kicad_sch; the step envelope named the root only, so the engine refused
  // the whole apply (ENVELOPE_SHEET_UNDECLARED) and the step drew nothing.
  it("a draft on a sheet that carries child sheet symbols may also write those children, and nothing else", async () => {
    const { stepEnvelope, childSheetFiles } = await import("../plans/schema");
    const p: DesignPlan = {
      ...plan,
      sheets: [{ file: "ldo_board.kicad_sch" }, { file: "power.kicad_sch", create: true }, { file: "analog.kicad_sch", create: true, parent: "power.kicad_sch" }],
      blocks: plan.blocks.map((b) => ({ ...b, sheet: "ldo_board.kicad_sch" })),
      floorplan: { "ldo_board.kicad_sch": plan.floorplan["root.kicad_sch"] },
    };
    // The implied root carries every parentless child; a nested child hangs under its own parent only.
    expect(childSheetFiles(p, "ldo_board.kicad_sch")).toEqual(["power.kicad_sch"]);
    expect(childSheetFiles(p, "power.kicad_sch")).toEqual(["analog.kicad_sch"]);
    expect(childSheetFiles(p, "analog.kicad_sch")).toEqual([]);
    const draft = stepEnvelope(p, { id: "s1", kind: "draft", block: p.blocks[0].id });
    expect(draft.sheets).toEqual(["ldo_board.kicad_sch", "power.kicad_sch"]);
    // The approved plan is the upper bound: a file it never named stays out of every step envelope.
    expect(draft.sheets).not.toContain("mcu.kicad_sch");
    const grandchild = stepEnvelope(p, { id: "s2", kind: "draft", block: p.blocks[0].id });
    expect(grandchild.sheets).not.toContain("analog.kicad_sch");
  });
});
