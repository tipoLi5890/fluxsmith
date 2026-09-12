// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { ercFixOps, anchorOf, pwrFlagSource } from "../ercfix";
import { conflictsFromMessage, planRenumber, renumberOplist } from "../refdes";
import { p4, recordFixAttempt } from "../policy/hooks";
import { newTurnPolicyState } from "../policy/types";
import { bumpThinking } from "../lead";

const CONNECTOR = { J1: { lib_id: "Connector:Barrel_Jack", pins: [{ number: "1", type: "passive" }] } };

describe("ercfix", () => {
  it("places a PWR_FLAG on the anchored pin and no-connects unused IC pins, once each", () => {
    const ops = ercFixOps([
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Warning", refs: ["J1.1"], remediation: "place_pwr_flag at J1.1" },
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Warning", refs: ["J1.1"], remediation: "place_pwr_flag at J1.1" },
      { code: "PINMAP_UNCONNECTED", severity: "Warning", refs: ["U1.7"], location: "pin:U1:7" },
      { code: "PINMAP_UNCONNECTED", severity: "Warning", refs: ["J2.3"], location: "pin:J2:3" },
    ], [{ uuid: "a", name: "X", x_mil: 100, y_mil: 100 }, { uuid: "b", name: "X", x_mil: 100, y_mil: 100 }], CONNECTOR);
    expect(ops?.note).toBe("ercfix");
    // connectors count as parts whose open pins are legitimately unused (J2.3 gets a no-connect); passives do not
    expect(ops?.ops).toEqual([{ op: "place_pwr_flag", at: "J1.1" }, { op: "add_no_connect", pin: "U1.7" }, { op: "add_no_connect", pin: "J2.3" }, { op: "delete_object", uuid: "b", kind: "label" }]);
    expect(ercFixOps([{ code: "PINMAP_UNCONNECTED", severity: "Warning", refs: ["R3.2"], location: "pin:R3:2" }])).toBeNull();
    // a power symbol touching nothing is deleted by uuid (kind power_port: not a component deletion)
    expect(ercFixOps([{ code: "POWER_PORT_DANGLING", severity: "Error", refs: ["#PWR05"], location: "erc:port_dangling:abcd-1" }])?.ops).toEqual([{ op: "delete_object", uuid: "abcd-1", kind: "power_port" }]);
    expect(anchorOf({ code: "X", severity: "Warning", refs: ["R1"] })).toBeNull();
    expect(ercFixOps([{ code: "ERC_SINGLE_PIN_NET", severity: "Warning" }])).toBeNull();
  });

  it("only flags a rail the schematic says has a source: connector pin or regulator output", () => {
    const f = (refs: string[], net = "+3V3") => ({ code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", refs, location: `erc:pwr:${net}`, remediation: `place_pwr_flag at ${refs[0]}` });
    // No facts at all (the engine could not be asked): no flag, the finding goes to the Fixer.
    expect(ercFixOps([f(["U1.8", "R1.1"])])).toBeNull();
    // Nothing on the net can be a source: an MCU supply pin plus a decoupling cap is a wiring error.
    const passives = { U1: { lib_id: "MCU_ST_STM32F0:STM32F031K6Tx", pins: [{ number: "8", type: "power_in" }] }, C1: { lib_id: "Device:C", pins: [{ number: "1", type: "passive" }] } };
    expect(ercFixOps([f(["U1.8", "C1.1"])], [], passives)).toBeNull();
    // A connector pin on the net: the supply comes from outside the board, so the flag is the truth.
    expect(ercFixOps([f(["U1.8", "J1.1"])], [], { ...passives, ...CONNECTOR })?.ops).toEqual([{ op: "place_pwr_flag", at: "U1.8" }]);
    // A regulator output the symbol typed `output` (which is why ERC counted no driver).
    const reg = { ...passives, U2: { lib_id: "Regulator_Linear:AMS1117-3.3", pins: [{ number: "2", type: "output" }, { number: "3", type: "power_in" }] } };
    expect(ercFixOps([f(["U1.8", "U2.2"])], [], reg)?.ops).toEqual([{ op: "place_pwr_flag", at: "U1.8" }]);
    // The regulator's *input* pin is not a source, but a rail that only feeds it (plus passives) is the block's
    // input, fed from outside the drawing: flagged. With an MCU supply pin on the same net it stays open.
    expect(ercFixOps([f(["U1.8", "U2.3"])], [], reg)).toBeNull();
    const ldoIn = { ...reg, C1: { lib_id: "Device:C", pins: [{ number: "1", type: "passive" }] } };
    expect(pwrFlagSource(f(["C1.1", "U2.3"], "VDC"), ldoIn)).toBe("C1.1");
    expect(pwrFlagSource(f(["U1.8", "J1.1"]), { ...passives, ...CONNECTOR })).toBe("J1.1");
    expect(pwrFlagSource(f(["U1.8"]), passives)).toBeNull();
    // A ground rail whose members are all sinks (a resistor array returning to GND) is fed from outside any
    // block the agent draws: flagged, so KiCad's power_pin_not_driven does not fail a complete block.
    const sinks = { R1: { lib_id: "Device:R", pins: [{ number: "2", type: "passive" }] }, R2: { lib_id: "Device:R", pins: [{ number: "2", type: "passive" }] } };
    expect(pwrFlagSource(f(["R1.2", "R2.2"], "GND"), sinks)).toBe("R1.2");
    expect(pwrFlagSource(f(["R1.2", "R2.2"], "/AGND"), sinks)).toBe("R1.2");
    // The same members on a supply rail: no flag (the source is missing, not invisible).
    expect(pwrFlagSource(f(["R1.2", "R2.2"], "+3V3"), sinks)).toBeNull();
    // An unknown member on GND: no flag (facts incomplete).
    expect(pwrFlagSource(f(["R1.2", "R9.1"], "GND"), sinks)).toBeNull();
  });
});

describe("refdes renumbering (P5)", () => {
  it("parses the conflict list and moves designators to free numbers everywhere", () => {
    const bad = conflictsFromMessage('Designators U2, D2, R3 are outside your lease or already occupied. Leases: []');
    expect(bad).toEqual(["U2", "D2", "R3"]);
    const map = planRenumber(bad, { U: [1, 2], D: [2], R: [1, 2, 3] }, { R: [4] });
    expect(map).toEqual({ U2: "U3", D2: "D3", R3: "R5" });
    const { oplist, changed } = renumberOplist({ ops: [{ op: "place_component", designator: "U2" }, { op: "add_net_label", at: "U2.3", name: "X" }, { op: "place_component", designator: "R4" }], refdes_used: ["U2", "R4"] }, map);
    expect(changed).toBe(3);
    expect(oplist).toEqual({ ops: [{ op: "place_component", designator: "U3" }, { op: "add_net_label", at: "U3.3", name: "X" }, { op: "place_component", designator: "R4" }], refdes_used: ["U3", "R4"] });
  });
});

describe("p4 per-phase state", () => {
  it("does not let a pre_apply history stall a post_apply round", () => {
    const st = newTurnPolicyState(1, "build", "auto", "lead", null); st.step = "s1";
    const f = [{ code: "GROUP_OVERLAP", severity: "Error", location: "a", remediation: "move" }];
    recordFixAttempt(st, "pre_apply", f);
    recordFixAttempt(st, "pre_apply", f);
    expect(p4(st, f, "post_apply", () => true).kind).toBe("fix");
    expect(p4(st, f, "pre_apply", () => true).kind).toBe("hard_stop");
  });
});

describe("bumpThinking", () => {
  it("escalates one level and saturates", () => {
    expect(bumpThinking("off")).toBe("low"); expect(bumpThinking("low")).toBe("medium"); expect(bumpThinking("medium")).toBe("high"); expect(bumpThinking("high")).toBe("high");
  });
});

import { LeadLoop } from "../lead";
import { SkillRegistry } from "../skills/registry";
import { Persistence } from "../persistence";
import { normalizePlan } from "../plans/schema";

describe("/redo rules", () => {
  it("re-opens skipped steps (and their dependency-skipped dependants) but refuses applied ones", () => {
    const skills = new SkillRegistry({ list: async () => [], read: async () => "" });
    const lead = new LeadLoop({
      settings: () => ({ agent: { thinking_level: "low", continuous_run: true, budget_enabled: false, budget_defaults: {} }, models_by_role: {}, providers: [], advanced: {} }) as never, projectKey: "pk", sessionId: "s", emit: () => undefined, skills, persistence: new Persistence("pk", "s"),
      plans: { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) },
      showCard: async () => ({ action_id: "dismiss" }), selection: () => [], sheets: () => ["root.kicad_sch"],
    });
    const plan = normalizePlan({ id: "p", version: 1, goal: "g", sheets: ["root"], blocks: [{ id: "a", sheet: "root", parts: ["r"] }, { id: "b", sheet: "root", parts: ["r"] }], steps: [{ id: "s1", block: "a", kind: "draft" }, { id: "s2", block: "b", kind: "draft", depends_on: ["s1"] }] });
    lead.adoptPlan(plan, true);
    lead.planStepsSkipped.add("s1"); lead.stepNotes.set("s1", "drafter failed");
    lead.planStepsSkipped.add("s2"); lead.stepNotes.set("s2", "skipped_dependency: s1");
    const r = (lead as unknown as { reopenStep(id: string): { ok: boolean; reason?: string; step?: { id: string } } }).reopenStep("s1");
    expect(r.ok).toBe(true);
    expect(lead.planStepsSkipped.has("s1")).toBe(false);
    expect(lead.planStepsSkipped.has("s2")).toBe(false);
    lead.planStepsDone.add("s1");
    lead.turns.push({ turn: 3, plan_step: "s1", status: "summarized", applies: [{ run_id: "r" }] } as never);
    const r2 = (lead as unknown as { reopenStep(id: string): { ok: boolean; reason?: string } }).reopenStep("s1");
    expect(r2.ok).toBe(false); expect(r2.reason).toMatch(/roll back first/);
    const r3 = (lead as unknown as { reopenStep(id: string): { ok: boolean; reason?: string } }).reopenStep("nope");
    expect(r3.ok).toBe(false);
  });
});
