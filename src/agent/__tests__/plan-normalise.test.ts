// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { normalizePlan, reconcileSheets, ensureBlockSteps, planStructural, validatePlan, planView } from "../plans/schema";

describe("plan normalisation against the project", () => {
  const raw = {
    schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", net_naming: { rails: ["GND"] },
    sheets: [{ id: "root", title: "Root" }],
    blocks: [{ id: "a", sheet: "root", summary: "A", components: [{ refdes: "R1", lib_id: "Device:R" }], nets_out: ["N1"] }, { id: "b", sheet: "root", summary: "B", parts: [{ ref_prefix: "C", lib_id: "Device:C" }], nets_in: ["N1"] }],
    steps: [{ id: "confirm_parts", kind: "draft" }, { id: "review", kind: "draft", depends_on: ["confirm_parts"] }],
    envelope: { budgets: { components_added: 0 }, allowed_ops: [], structural: [] },
  };
  it("maps sheet names to files, root aliases to the project root, and never creates existing files", () => {
    const p = reconcileSheets(normalizePlan(raw), ["run3.kicad_sch"]);
    expect(p.sheets.map((s) => s.file)).toEqual(["run3.kicad_sch"]);
    expect(p.sheets[0].create).toBe(false);
    expect(p.blocks.every((b) => b.sheet === "run3.kicad_sch")).toBe(true);
    expect(planStructural(p, ["run3.kicad_sch"])).toEqual([]);
  });
  it("gives zero budgets headroom and aliases components/refdes", () => {
    const p = normalizePlan(raw);
    expect(p.envelope.budgets.components_added).toBeGreaterThanOrEqual(12);
    expect(p.blocks[0].parts[0].ref_prefix).toBe("R");
  });
  it("replaces process steps with one draft step per block plus wiring and gate", () => {
    const p = ensureBlockSteps(reconcileSheets(normalizePlan(raw), ["run3.kicad_sch"]));
    expect(p.steps.map((s) => s.id)).toEqual(["draft_a", "draft_b", "wiring", "gate"]);
    expect(p.steps[1].depends_on).toEqual(["draft_a"]);
  });
  it("keeps steps that already bind to blocks", () => {
    // Reconciled against an existing root (the registry always reconciles before ensureBlockSteps), so no sheet
    // needs creating and no scaffold step is added.
    const p = ensureBlockSteps(reconcileSheets(normalizePlan({ ...raw, steps: [{ id: "s1", block: "a", kind: "draft" }] }), ["root.kicad_sch"]));
    expect(p.steps.map((s) => s.id)).toEqual(["s1", "wiring", "gate"]);
  });
});

import { scaffoldOrder } from "../plans/schema";
describe("nested plan sheets", () => {
  const nested = {
    schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", net_naming: { rails: ["GND"] },
    sheets: [{ file: "root.kicad_sch" }, { file: "analog", create: true, parent: "power" }, { file: "power.kicad_sch", create: true }],
    blocks: [{ id: "a", sheet: "root.kicad_sch", summary: "A", parts: [{ ref_prefix: "R", lib_id: "Device:R" }], nets_out: ["N1"], acceptance: [] }],
    steps: [{ id: "s", kind: "scaffold" }],
    envelope: { budgets: { components_added: 4, components_deleted: 0 }, allowed_ops: [], structural: [] },
  };
  it("normalises the parent to a sheet file and keeps it through reconcile", () => {
    const p = reconcileSheets(normalizePlan(nested), ["root.kicad_sch"]);
    expect(p.sheets.find((s) => s.file === "analog.kicad_sch")?.parent).toBe("power.kicad_sch");
    expect(validatePlan(p)).toEqual([]);
  });
  it("creates parents before their children", () => {
    const p = reconcileSheets(normalizePlan(nested), ["root.kicad_sch"]);
    expect(scaffoldOrder(p).map((s) => s.file)).toEqual(["power.kicad_sch", "analog.kicad_sch"]);
  });
  it("refuses a parent that is not another plan sheet, and a cycle", () => {
    const p = normalizePlan(nested);
    const unknown = { ...p, sheets: [{ file: "a.kicad_sch" }, { file: "b.kicad_sch", parent: "zz.kicad_sch" }] };
    expect(validatePlan(unknown).some((e) => /parent zz\.kicad_sch/.test(e))).toBe(true);
    const self = { ...p, sheets: [{ file: "a.kicad_sch", parent: "a.kicad_sch" }] };
    expect(validatePlan(self).some((e) => /names itself/.test(e))).toBe(true);
    const cycle = { ...p, sheets: [{ file: "a.kicad_sch", parent: "b.kicad_sch" }, { file: "b.kicad_sch", parent: "a.kicad_sch" }] };
    expect(validatePlan(cycle).some((e) => /parent cycle/.test(e))).toBe(true);
  });
});

import { normalizeFloorplan, defaultRegion } from "../plans/schema";
describe("floorplan shapes", () => {
  const blocks = [{ id: "power", sheet: "a.kicad_sch" }, { id: "mcu", sheet: "a.kicad_sch" }] as never;
  it("accepts {groups:[{id, region_mil}]}", () => {
    const fp = normalizeFloorplan({ grid_mil: 100, groups: [{ id: "power", region_mil: [[800, 1200], [3200, 3600]] }] }, blocks);
    expect(fp["a.kicad_sch"][0]).toEqual({ group: "power", origin_mil: [800, 1200], extent_mil: [2400, 2400] });
  });
  it("keeps the canonical per-sheet map", () => {
    const fp = normalizeFloorplan({ "a.kicad_sch": [{ group: "mcu", origin_mil: [1, 2], extent_mil: [300, 400] }] }, blocks);
    expect(fp["a.kicad_sch"][0].group).toBe("mcu");
  });
  it("lays unplanned blocks out on a grid", () => {
    const plan = normalizePlan({ sheets: ["s"], blocks: [{ id: "a", sheet: "s" }, { id: "b", sheet: "s" }, { id: "c", sheet: "s" }, { id: "d", sheet: "s" }] });
    expect(defaultRegion(plan, "a", "s.kicad_sch").origin_mil).toEqual([800, 800]);
    const d = defaultRegion(plan, "d", "s.kicad_sch");
    expect(d.origin_mil[0]).toBe(800);
    expect(d.origin_mil[1]).toBeGreaterThan(800);
    expect(d.origin_mil[1] + d.extent_mil[1]).toBeLessThan(8200);
  });
});

describe("duplicate block steps", () => {
  it("keeps only the first draft step per block", () => {
    const p = ensureBlockSteps(normalizePlan({ sheets: ["s"], blocks: [{ id: "mcu", sheet: "s" }], steps: [{ id: "mcu", block: "mcu", kind: "draft" }, { id: "mcu_wiring", block: "mcu", kind: "draft" }, { id: "gate", kind: "gate" }] }));
    expect(p.steps.map((s) => s.id)).toEqual(["mcu", "gate"]);
  });
});

describe("string part lists", () => {
  it("turns component strings into typed parts", () => {
    const p = normalizePlan({ sheets: ["s"], blocks: [{ id: "pwr", sheet: "s", parts: [], components: ["USB-C receptacle", "2x 5.1kΩ resistors", "input bulk capacitor"] }] });
    expect(p.blocks[0].parts.map((x) => x.ref_prefix)).toEqual(["J", "R", "C"]);
    expect(p.envelope.budgets.components_added).toBeGreaterThanOrEqual(12);
  });
});

describe("functional_blocks + bom_candidates shape", () => {
  it("binds refdes strings to the plan BOM, takes block regions as the floorplan and rails objects", () => {
    const p = reconcileSheets(normalizePlan({
      schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g",
      sheets: [{ name: "main", single_sheet: true }],
      rails: [{ name: "VBUS" }, { name: "+3V3" }, { name: "GND" }],
      bom_candidates: [{ ref: "U1", lib_id: "MCU_Microchip_ATtiny:ATtiny1616-S", lcsc: "C145558" }, { ref: "C4", mpn: "CL10B104KB8NNNC", description: "100nF 0603" }],
      functional_blocks: [{ name: "mcu_core", intent: "MCU", components: ["U1", "C4"], region_mil: [[1500, 1100], [2700, 2300]] }],
      steps: [{ id: "schematic", action: "draw it" }],
    }), ["qqq.kicad_sch"]);
    expect(p.blocks.length).toBe(1);
    expect(p.blocks[0].parts.map((x) => [x.ref_prefix, x.lib_id, (x as { lcsc?: string }).lcsc])).toEqual([["U", "MCU_Microchip_ATtiny:ATtiny1616-S", "C145558"], ["C", undefined, undefined]]);
    expect(p.net_naming.rails).toEqual(["VBUS", "+3V3", "GND"]);
    expect(p.floorplan["qqq.kicad_sch"][0].group).toBe("mcu_core");
    expect(p.blocks[0].summary).toBe("MCU");
    expect(validatePlan({ ...p, blocks: [] }).some((e) => /at least one functional block/.test(e))).toBe(true);
  });
});

describe("plan text fields", () => {
  it("renders object constraints and risks as text, and parts without lib_id by mpn/value", () => {
    const p = normalizePlan({ sheets: ["s"], constraints: ["a", { text: "b" }, { id: "c1", constraint: "c" }, { limit: 12, unit: "parts" }], risks: [{ description: "r" }], blocks: [{ id: "x", sheet: "s", parts: [{ ref_prefix: "U", mpn: "CH340C" }, { ref_prefix: "R", value: "5.1k" }] }] });
    expect(p.constraints).toEqual(["a", "b", "c", "limit: 12; unit: parts", "risk: r"]);
    const view = planView(ensureBlockSteps(p), { done: new Set(), skipped: new Set(), current: null });
    expect(view.steps[0].parts).toEqual(["U CH340C (unresolved)", "R 5.1k (unresolved)"]);
  });
});

describe("plan validation a reviewer relies on", () => {
  it("demands declared rails, cross-sheet interfaces, known block sheets and complete acceptance fields", async () => {
    const { validatePlan, normalizePlan } = await import("../plans/schema");
    const base = {
      schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g",
      sheets: [{ file: "root.kicad_sch" }, { file: "power.kicad_sch", create: true }],
      net_naming: { rails: [] },
      blocks: [
        { id: "ldo", sheet: "power.kicad_sch", summary: "LDO", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3", resolved: true }], nets_in: ["VBUS"], nets_out: ["+3V3"], acceptance: [{ type: "pin_on_net", ref_prefix: "U", pin: "2" }] },
        { id: "mcu", sheet: "root.kicad_sch", summary: "MCU", parts: [{ ref_prefix: "U", lib_id: "MCU_ST_STM32F1:STM32F103C8Tx", resolved: true }], nets_in: ["+3V3", "SWDIO"], nets_out: [], acceptance: [] },
        { id: "led", sheet: "pwr.kicad_sch", summary: "LED", parts: [{ ref_prefix: "D", lib_id: "Device:LED", resolved: true }], nets_in: ["LED_CTRL"], nets_out: [], acceptance: [] },
      ],
      steps: [{ id: "s1", block: "ldo", kind: "draft" }],
      envelope: { allowed_ops: [], budgets: { components_added: 4, components_deleted: 0, wires_added: 10, labels_added: 10 }, nets: { rails: [], renamable: [] }, structural: [] },
    };
    const errs = validatePlan(normalizePlan(base));
    expect(errs.some((e) => /rails must list every supply net/.test(e) && /VBUS/.test(e) && /\+3V3/.test(e))).toBe(true);
    expect(errs.some((e) => /names sheet pwr\.kicad_sch/.test(e))).toBe(true);
    expect(errs.some((e) => /acceptance pin_on_net is missing net/.test(e))).toBe(true);
    // rails declared, sheet fixed, acceptance complete: only the cross-sheet interface is left
    const fixed = { ...base, net_naming: { rails: ["VBUS", "+3V3"] }, blocks: base.blocks.map((b) => (b.id === "led" ? { ...b, sheet: "root.kicad_sch" } : b.id === "ldo" ? { ...b, acceptance: [{ type: "pin_on_net", ref_prefix: "U", pin: "2", net: "+3V3" }] } : b)) };
    const errs2 = validatePlan(normalizePlan(fixed));
    expect(errs2.filter((e) => /rails|names sheet|acceptance/.test(e))).toEqual([]);
    // +3V3 crosses sheets but is a rail (power ports), so no interface is required for it
    expect(errs2.some((e) => /interfaces must name/.test(e))).toBe(false);
  });
});

import { normalizeAcceptance } from "../plans/schema";
describe("plan shapes real models produce", () => {
  const sheets = ["root.kicad_sch"];
  const base = {
    schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g",
    sheets: [{ file: "root.kicad_sch" }, { file: "power.kicad_sch", create: true }],
    envelope: { budgets: { components_added: 4 }, allowed_ops: [], structural: [] },
  };
  it("keeps rail names given as {name, scope, source} objects", () => {
    const p = normalizePlan({ ...base, net_naming: { rails: [{ name: "+5V", scope: "global", source: "J1" }, { name: "GND" }] }, blocks: [{ id: "a", sheet: "root", summary: "A", parts: [{ ref_prefix: "J", lib_id: "Connector:Conn_01x04_Pin" }], nets_out: ["+5V", "GND"], acceptance: [] }], steps: [] });
    expect(p.net_naming.rails).toEqual(["+5V", "GND"]);
    expect(validatePlan(reconcileSheets(p, sheets)).filter((e) => /rails/.test(e))).toEqual([]);
  });
  it("turns prose acceptance into informational text items and maps kind/check aliases", () => {
    expect(normalizeAcceptance(["J1 pin 1 is on +5V.", { kind: "net_has_pins", net: "GND", min: 2 }, { check: "component_count", prefix: "R", min: 1 }, { description: "looks right" }])).toEqual([
      { type: "text", text: "J1 pin 1 is on +5V." },
      { type: "net_has_pins", net: "GND", min: 2 },
      { type: "component_count", prefix: "R", min: 1 },
      { type: "text", text: "looks right" },
    ]);
    const p = normalizePlan({ ...base, net_naming: { rails: ["GND"] }, blocks: [{ id: "a", sheet: "root", summary: "A", parts: [{ ref_prefix: "R", lib_id: "Device:R" }], nets_out: ["GND"], acceptance: ["one resistor"] }], steps: [] });
    expect(validatePlan(reconcileSheets(p, sheets)).filter((e) => /acceptance/.test(e))).toEqual([]);
  });
  it("lets a scaffold-only block list no parts", () => {
    const p = normalizePlan({ ...base, net_naming: { rails: [] }, blocks: [{ id: "hierarchy_scaffold", sheet: "root", summary: "create the power sheet", parts: [], acceptance: [] }, { id: "b", sheet: "power", summary: "B", parts: [{ ref_prefix: "C", lib_id: "Device:C" }], acceptance: [] }], steps: [{ id: "s1", kind: "scaffold", block: "hierarchy_scaffold" }, { id: "s2", kind: "draft", block: "b" }] });
    const errs = validatePlan(reconcileSheets(p, sheets));
    expect(errs.filter((e) => /lists no parts/.test(e))).toEqual([]);
    const q = normalizePlan({ ...base, net_naming: { rails: [] }, blocks: [{ id: "empty", sheet: "root", summary: "nothing", parts: [], acceptance: [] }], steps: [{ id: "s2", kind: "draft", block: "empty" }] });
    expect(validatePlan(reconcileSheets(q, sheets)).some((e) => /lists no parts/.test(e))).toBe(true);
  });
});

describe("default regions", () => {
  it("origins land on the 50 mil grid for every block count", () => {
    const mk = (n: number) => ({ blocks: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, sheet: "s" })) }) as unknown as Parameters<typeof defaultRegion>[0];
    for (const n of [1, 3, 6, 7, 12, 13, 20]) {
      const plan = mk(n);
      for (let i = 0; i < n; i++) {
        const r = defaultRegion(plan, `b${i}`, "s");
        expect(r.origin_mil[0] % 50, `n=${n} i=${i} x`).toBe(0);
        expect(r.origin_mil[1] % 50, `n=${n} i=${i} y`).toBe(0);
      }
    }
  });
});

import { sheetInterfaces, isRailName } from "../plans/schema";
describe("interfaces", () => {
  it("rails never become sheet pins even when the plan lists them as interfaces", () => {
    const plan = normalizePlan({
      schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", net_naming: { rails: ["GND"] },
      sheets: [{ file: "root.kicad_sch" }, { file: "power.kicad_sch", create: true }],
      interfaces: [{ net: "VBUS_5V", from: "root", to: "power" }, { net: "GND", from: "root", to: "power" }, { net: "+3V3", from: "power", to: "root" }, { net: "LED_CTRL", from: "root", to: "power" }],
      blocks: [{ id: "a", sheet: "root", summary: "A", parts: [{ ref_prefix: "J", lib_id: "Connector:Conn_01x04_Pin" }], nets_out: ["VBUS_5V", "GND", "LED_CTRL"], acceptance: [] }, { id: "b", sheet: "power", summary: "B", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3" }], nets_in: ["VBUS_5V", "GND", "LED_CTRL"], nets_out: ["+3V3"], acceptance: [] }],
      steps: [], envelope: { budgets: { components_added: 4 }, allowed_ops: [], structural: [] },
    });
    const p2 = reconcileSheets(plan, ["root.kicad_sch"]);
    // The normaliser already drops them, so nothing downstream (the plan card, stepEnvelope.interfaces,
    // the scaffold pins) can turn a rail into a sheet pin.
    expect(plan.interfaces.map((i) => i.net)).toEqual(["LED_CTRL"]);
    expect(sheetInterfaces(p2, "power.kicad_sch").map((i) => i.net)).toEqual(["LED_CTRL"]);
    for (const n of ["GND", "+3V3", "VBUS_5V", "VBUS", "/+5V", "VIN", "GNDA"]) expect(isRailName(n), n).toBe(true);
    for (const n of ["LED_CTRL", "VIN_SENSE", "SDA", "VBUS_DET"]) expect(isRailName(n), n).toBe(false);
  });
});

describe("missing sheets", () => {
  it("a missing sheet is scaffolded even when the plan says create:false, and architect steps gain the scaffold first", () => {
    const raw = {
      schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", net_naming: { rails: ["GND"] },
      sheets: [{ file: "root.kicad_sch", create: false }, { file: "power.kicad_sch", create: false }],
      blocks: [{ id: "reg", sheet: "power.kicad_sch", summary: "R", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3" }], nets_in: [], nets_out: [], acceptance: [] }],
      steps: [{ id: "draft_reg", kind: "draft", block: "reg" }, { id: "gate", kind: "gate" }],
      envelope: { budgets: { components_added: 1 }, allowed_ops: [], structural: [] },
    };
    const p = ensureBlockSteps(reconcileSheets(normalizePlan(raw), ["root.kicad_sch"]));
    expect(p.sheets.find((s) => s.file === "power.kicad_sch")?.create).toBe(true);
    expect(p.sheets.find((s) => s.file === "root.kicad_sch")?.create).toBe(false);
    expect(p.steps[0].kind).toBe("scaffold");
    expect(p.steps.map((s) => s.kind)).toEqual(["scaffold", "draft", "gate"]);
  });
});

import { droppedAllowedOps, normalizeAllowedOps, uncheckableAcceptanceBlocks } from "../plans/schema";
import { ALL_OPS } from "../tools/ops";

/**
 * The plan a real Architect wrote (run 15), copied down to the fields these tests turn on: an
 * `allowed_ops` list of ten names that are not ops, a `sensor_board.kicad_sch` declared as the plan's
 * own root beside the project's real `ldo_board.kicad_sch`, and blocks hanging off both.
 */
const RUN15 = {
  schema_version: 1, kind: "schematic", id: "sensor_board_power_supply", version: 1,
  goal: "Two-sheet KiCad schematic for a small sensor-board power supply.",
  net_naming: { rail_mechanism: "power_port", rails: ["+5V_USB", "+3V3", "GND"] },
  sheets: [
    { file: "sensor_board.kicad_sch", create: true, paper: "A4" },
    { file: "power.kicad_sch", create: true, paper: "A4", parent: "sensor_board.kicad_sch" },
  ],
  interfaces: [
    { from: "sensor_board.kicad_sch", net: "+5V_USB", to: "power.kicad_sch" },
    { from: "sensor_board.kicad_sch", net: "GND", to: "power.kicad_sch" },
    { from: "power.kicad_sch", net: "+3V3", to: "sensor_board.kicad_sch" },
  ],
  blocks: [
    { id: "usb_power_entry", sheet: "sensor_board.kicad_sch", summary: "Four-pin header for the USB-derived 5 V input.", parts: [{ ref_prefix: "J", lib_id: "Connector_Generic:Conn_01x04", value: "USB_5V_INPUT" }], nets_in: ["+5V_USB", "GND"], nets_out: ["+5V_USB", "GND"], acceptance: [{ type: "pin_on_net", ref_prefix: "J", pin: "1", net: "+5V_USB" }, { type: "text", text: "Header pins 3 and 4 are marked no-connect." }] },
    { id: "ldo_regulation", sheet: "power.kicad_sch", summary: "AMS1117-3.3 and its capacitors.", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3", value: "AMS1117-3.3" }, { ref_prefix: "C", lib_id: "Device:C", value: "10 uF" }], nets_in: ["+5V_USB", "GND"], nets_out: ["+3V3", "GND"], acceptance: [{ type: "net_has_pins", net: "+3V3", min: 3 }] },
    { id: "power_indicator", sheet: "power.kicad_sch", summary: "Green power LED.", parts: [{ ref_prefix: "R", lib_id: "Device:R", value: "1k" }, { ref_prefix: "D", lib_id: "Device:LED", value: "green" }], nets_in: ["+3V3", "GND"], nets_out: [], acceptance: [{ type: "text", text: "The series path is +3V3 -> R -> D -> GND." }] },
  ],
  steps: [
    { id: "step_01_hierarchy", block: "usb_power_entry", kind: "scaffold", depends_on: [] },
    { id: "step_02_input_header", block: "usb_power_entry", kind: "draft", depends_on: ["step_01_hierarchy"] },
    { id: "step_04_ldo_parts", block: "ldo_regulation", kind: "draft", depends_on: ["step_01_hierarchy"] },
    { id: "step_06_indicator_parts", block: "power_indicator", kind: "draft", depends_on: ["step_04_ldo_parts"] },
    { id: "step_08_final_gate", block: "ldo_regulation", kind: "gate", depends_on: ["step_06_indicator_parts"] },
  ],
  envelope: {
    allowed_ops: ["create_root_schematic", "create_hierarchical_sheet", "add_symbol", "set_symbol_value", "set_symbol_footprint", "add_wire", "add_junction", "add_label", "add_power_port", "add_hierarchical_pin", "add_no_connect", "annotate", "run_erc"],
    budgets: { components_added: 15, components_deleted: 0, wires_added: 45, labels_added: 45 },
    nets: { rails: ["+5V_USB", "+3V3", "GND"], renamable: ["LED_A"] },
    structural: ["create_sheet:sensor_board.kicad_sch", "create_sheet:power.kicad_sch"],
  },
};

describe("plan op vocabulary", () => {
  it("normalise drops unknown ops and reports them; add_symbol becomes place_component", () => {
    const { ops, dropped } = normalizeAllowedOps(RUN15.envelope.allowed_ops);
    // The alias table now folds the sheet / field spellings the models keep writing onto real ops; only the
    // names with no equivalent (a root that already exists, annotation, ERC) are dropped.
    expect(ops).toEqual(["add_sheet", "place_component", "set_component_parameters", "add_wire", "add_junction", "add_net_label", "place_power_port", "add_sheet_pin", "add_no_connect"]);
    expect(dropped).toEqual(["create_root_schematic", "annotate", "run_erc"]);
    expect(ops.every((o) => ALL_OPS.includes(o))).toBe(true);
    // Aliases and spellings the models keep writing all land on real ops; a name that is neither goes.
    expect(normalizeAllowedOps(["Add Label", "add_gnd", "add_gnd", "place_widget"])).toEqual({ ops: ["add_net_label", "place_gnd"], dropped: ["place_widget"] });
    expect(normalizeAllowedOps(undefined)).toEqual({ ops: [], dropped: [] });
  });
  it("the plan envelope and the per-step allowed_ops keep only real ops, and plan.write can report the rest", () => {
    const p = normalizePlan({ ...RUN15, steps: [{ id: "s1", kind: "draft", block: "usb_power_entry", allowed_ops: ["add_symbol", "run_erc"] }] });
    for (const bad of ["create_root_schematic", "add_symbol", "annotate", "run_erc"]) expect(p.envelope.allowed_ops).not.toContain(bad);
    expect(p.envelope.allowed_ops).toContain("place_component");
    expect(p.envelope.allowed_ops).toContain("place_power_port");
    expect((p.steps[0] as unknown as { allowed_ops: string[] }).allowed_ops).toEqual(["place_component"]);
    expect(droppedAllowedOps({ ...RUN15, steps: [{ id: "s1", allowed_ops: ["make_magic"] }] })).toContain("make_magic");
    expect(droppedAllowedOps(RUN15)).toContain("create_root_schematic");
    // An envelope that listed only invented names still narrows to the drafting vocabulary.
    const q = normalizePlan({ ...RUN15, envelope: { ...RUN15.envelope, allowed_ops: ["run_erc", "annotate"] } });
    expect(q.envelope.allowed_ops.length).toBeGreaterThan(0);
    expect(q.envelope.allowed_ops).not.toContain("run_erc");
  });
});

describe("acceptance the engine can check", () => {
  it("names the blocks whose acceptance is only text (or empty), and no others", () => {
    // Before derivation: `power_indicator` is the one block whose acceptance the Architect left as prose.
    expect(uncheckableAcceptanceBlocks({ blocks: RUN15.blocks } as unknown as DesignPlan)).toEqual(["power_indicator"]);
    expect(uncheckableAcceptanceBlocks({ blocks: [] })).toEqual([]);
    // After normalisation nothing is left uncheckable: the block's own parts and nets were restated.
    expect(uncheckableAcceptanceBlocks(normalizePlan(RUN15))).toEqual([]);
    // Every block of a real run's plan was `text`-only; that plan is the one the gate closed on nothing.
    const allText = normalizePlan({ ...RUN15, blocks: RUN15.blocks.map((b) => ({ ...b, acceptance: [{ type: "text", text: "looks right" }] })) });
    expect(uncheckableAcceptanceBlocks(allText)).toEqual([]);
    expect(derivedAcceptanceCount(allText)).toBeGreaterThan(0);
    // A block with nothing to restate (no parts, no nets) still has nothing the gate can report on.
    const bare = normalizePlan({ ...RUN15, blocks: [{ id: "scaffold_only", sheet: "power.kicad_sch", summary: "S", parts: [], nets_in: [], nets_out: [], acceptance: [{ type: "text", text: "the sheet exists" }] }] });
    expect(uncheckableAcceptanceBlocks(bare)).toEqual(["scaffold_only"]);
    expect(derivedAcceptanceCount(bare)).toBe(0);
  });
});

import { deriveAcceptance, derivedAcceptanceCount, withDerivedAcceptance, DERIVED_ACCEPTANCE_MAX, type DesignPlan } from "../plans/schema";
describe("acceptance derived from the plan's own declarations", () => {
  // Run 18's plan, shortened: every block declared parts, nets and rails, and every acceptance row was prose.
  const RUN18 = {
    schema_version: 1, kind: "schematic", id: "ldo_board", version: 1, goal: "USB-powered 3.3 V board.",
    net_naming: { rail_mechanism: "power_port", rails: ["VBUS", "+3V3", "GND"] },
    sheets: [{ file: "ldo_board.kicad_sch" }, { file: "power.kicad_sch", create: true }],
    blocks: [
      { id: "usb_in", sheet: "power.kicad_sch", summary: "USB power input", nets_in: [], nets_out: ["VBUS", "GND"], parts: [{ ref_prefix: "J", lib_id: "Connector_Generic:Conn_01x04" }, { ref_prefix: "#FLG", lib_id: "power:PWR_FLAG" }], acceptance: [{ type: "text", text: "J1 pin 1 connects to VBUS and pin 4 connects to GND." }] },
      { id: "ldo", sheet: "power.kicad_sch", summary: "3.3 V linear regulator", nets_in: ["VBUS", "GND"], nets_out: ["+3V3"], parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3" }, { ref_prefix: "C", lib_id: "Device:C", value: "10uF" }, { ref_prefix: "C", lib_id: "Device:C", value: "22uF" }, { ref_prefix: "C", lib_id: "Device:C", value: "100nF" }], acceptance: [{ type: "text", text: "U1 input connects to VBUS." }] },
      { id: "led", sheet: "power.kicad_sch", summary: "3.3 V power indicator", nets_in: ["+3V3", "GND"], nets_out: [], parts: [{ ref_prefix: "R", lib_id: "Device:R" }, { ref_prefix: "D", lib_id: "Device:LED" }], acceptance: [{ type: "text", text: "LED polarity places the anode toward +3V3." }] },
    ],
    steps: [], envelope: { budgets: { components_added: 8 }, allowed_ops: ["place_component"], structural: [] },
  };

  it("restates every text-only block's parts and nets as typed rows, and keeps the prose", () => {
    const p = normalizePlan(RUN18);
    const rows = (id: string) => p.blocks.find((b) => b.id === id)!.acceptance;
    // The Architect's sentence stays in front of the derived rows, informational as before.
    expect(rows("usb_in")[0]).toEqual({ type: "text", text: "J1 pin 1 connects to VBUS and pin 4 connects to GND." });
    // `#FLG` is skipped: a PWR_FLAG carries no reference in the netlist, so such a row could never pass.
    expect(rows("usb_in").slice(1)).toEqual([
      { type: "component_count", prefix: "J", min: 1, derived: true },
      { type: "net_has_pins", net: "VBUS", min: 2, derived: true },
      { type: "net_has_pins", net: "GND", min: 2, derived: true },
    ]);
    // Three capacitors are three references; rails the block consumes are restated too.
    expect(rows("ldo").slice(1)).toEqual([
      { type: "component_count", prefix: "C", min: 3, derived: true },
      { type: "component_count", prefix: "U", min: 1, derived: true },
      { type: "net_has_pins", net: "+3V3", min: 2, derived: true },
      { type: "net_has_pins", net: "VBUS", min: 2, derived: true },
      { type: "net_has_pins", net: "GND", min: 2, derived: true },
    ]);
    expect(rows("led").slice(1)).toEqual([
      { type: "component_count", prefix: "D", min: 1, derived: true },
      { type: "component_count", prefix: "R", min: 1, derived: true },
      { type: "net_has_pins", net: "+3V3", min: 2, derived: true },
      { type: "net_has_pins", net: "GND", min: 2, derived: true },
    ]);
    expect(uncheckableAcceptanceBlocks(p)).toEqual([]);
    expect(derivedAcceptanceCount(p)).toBe(12);
    expect(validatePlan(p).filter((e) => /acceptance/.test(e))).toEqual([]);
  });

  it("leaves a block that already declared a typed row alone, and never duplicates one", () => {
    const typed = { ...RUN18, blocks: RUN18.blocks.map((b) => (b.id === "ldo" ? { ...b, acceptance: [{ type: "net_has_pins", net: "+3V3", min: 2 }, { type: "text", text: "keep the loop small" }] } : b)) };
    const p = normalizePlan(typed);
    const ldo = p.blocks.find((b) => b.id === "ldo")!;
    expect(ldo.acceptance).toEqual([{ type: "net_has_pins", net: "+3V3", min: 2 }, { type: "text", text: "keep the loop small" }]);
    expect(ldo.acceptance.some((a) => (a as { derived?: boolean }).derived)).toBe(false);
    // Re-normalising (a plan read back from disk) adds nothing: the derived rows are checkable themselves.
    const twice = normalizePlan(p);
    expect(derivedAcceptanceCount(twice)).toBe(derivedAcceptanceCount(p));
    expect(twice.blocks.map((b) => b.acceptance.length)).toEqual(p.blocks.map((b) => b.acceptance.length));
    expect(withDerivedAcceptance(p)).toBe(p);
  });

  it("consumes only rails and declared interfaces, and never more rows than the cap", () => {
    // A consumed signal that the plan never declares as an interface is another block's business.
    expect(deriveAcceptance({ parts: [], nets_in: ["UART_TX", "GND"], nets_out: [] }, { rails: ["GND"] })).toEqual([
      { type: "net_has_pins", net: "GND", min: 2, derived: true },
    ]);
    expect(deriveAcceptance({ parts: [], nets_in: ["UART_TX"], nets_out: [] }, { rails: [], interfaces: ["UART_TX"] })).toEqual([
      { type: "net_has_pins", net: "UART_TX", min: 2, derived: true },
    ]);
    const many = deriveAcceptance({ parts: Array.from({ length: 20 }, (_, i) => ({ ref_prefix: `X${i}`, lib_id: "Device:R", resolved: false })), nets_in: [], nets_out: [] });
    expect(many.length).toBe(DERIVED_ACCEPTANCE_MAX);
  });

  it("skips a power-library part whatever prefix the plan gave it", () => {
    // Run 20: the block listed `{ref_prefix:"PWR", lib_id:"power:PWR_FLAG"}`, so the prefix filter (which
    // only knew `#`) derived `component_count PWR >= 1`. `sch-net` keeps power symbols out of every net's
    // members, so the gate answered 0 over a sheet carrying PWR1 and PWR2 — a row that could only fail.
    expect(deriveAcceptance({
      parts: [
        { ref_prefix: "J", lib_id: "Connector_Generic:Conn_01x04", resolved: true },
        { ref_prefix: "PWR", lib_id: "power:PWR_FLAG", resolved: true },
        { ref_prefix: "#PWR", lib_id: "power:GND", resolved: true },
      ],
      nets_in: [], nets_out: ["VBUS_5V"],
    }, { rails: ["VBUS_5V"] })).toEqual([
      { type: "component_count", prefix: "J", min: 1, derived: true },
      { type: "net_has_pins", net: "VBUS_5V", min: 2, derived: true },
    ]);
  });
});

import { stepEnvelope } from "../plans/schema";
describe("root under another name", () => {
  it("run15's own plan: sensor_board maps onto the project root and no second root is created", () => {
    const p = ensureBlockSteps(reconcileSheets(normalizePlan(RUN15), ["ldo_board.kicad_sch"]));
    expect(p.sheets.map((s) => [s.file, s.create])).toEqual([["ldo_board.kicad_sch", false], ["power.kicad_sch", true]]);
    expect(p.sheets.some((s) => s.file === "sensor_board.kicad_sch")).toBe(false);
    expect(p.sheets.filter((s) => s.create).map((s) => s.file)).toEqual(["power.kicad_sch"]);
    expect(p.envelope.structural).not.toContain("create_sheet:sensor_board.kicad_sch");
    expect(p.envelope.structural).toContain("create_sheet:power.kicad_sch");
    expect(p.blocks.find((b) => b.id === "usb_power_entry")?.sheet).toBe("ldo_board.kicad_sch");
    expect(p.blocks.filter((b) => b.sheet === "power.kicad_sch").map((b) => b.id)).toEqual(["ldo_regulation", "power_indicator"]);
    expect(planStructural(p, ["ldo_board.kicad_sch"])).toEqual(["create_sheet:power.kicad_sch", "add_sheet:power.kicad_sch"]);
    expect(validatePlan(p)).toEqual([]);
  });
  it("a plan's own top sheet that other sheets hang under is the project root, and the scaffold may add sheets", () => {
    const raw = {
      schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", net_naming: { rails: ["GND"] },
      sheets: [{ file: "sensor_board.kicad_sch", create: true }, { file: "power.kicad_sch", create: true, parent: "sensor_board.kicad_sch" }],
      blocks: [{ id: "hdr", sheet: "sensor_board.kicad_sch", summary: "H", parts: [{ ref_prefix: "J", lib_id: "Connector:Conn_01x04_Pin" }], nets_in: [], nets_out: [], acceptance: [] }, { id: "ldo", sheet: "power.kicad_sch", summary: "L", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3" }], nets_in: [], nets_out: [], acceptance: [] }],
      steps: [{ id: "s0", kind: "scaffold" }, { id: "s1", kind: "draft", block: "hdr" }, { id: "s2", kind: "draft", block: "ldo" }],
      envelope: { budgets: { components_added: 4 }, allowed_ops: ["place_component"], structural: [] },
    };
    const p = ensureBlockSteps(reconcileSheets(normalizePlan(raw), ["ldo_board.kicad_sch"]));
    expect(p.sheets.map((s) => [s.file, s.create])).toEqual([["ldo_board.kicad_sch", false], ["power.kicad_sch", true]]);
    expect([undefined, "ldo_board.kicad_sch"]).toContain(p.sheets[1].parent);
    expect(p.blocks.find((b) => b.id === "hdr")?.sheet).toBe("ldo_board.kicad_sch");
    const env = stepEnvelope(p, p.steps.find((s) => s.kind === "scaffold")!);
    expect(env.allowed_ops).toContain("add_sheet");
    expect(env.allowed_ops).toContain("add_sheet_pin");
    expect(stepEnvelope(p, p.steps.find((s) => s.kind === "draft")!).allowed_ops).not.toContain("add_sheet");
  });
});
