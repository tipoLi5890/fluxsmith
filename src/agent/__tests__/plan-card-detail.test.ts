// SPDX-License-Identifier: Apache-2.0
// What a KiCad engineer must be able to read off the plan before adopting it: which sheet each step
// draws on, what the block will be measured by, and which package every generic passive is.
// Grounded in real runs 17 and 18, whose plan card showed none of the three: every block landed on
// `power` without saying so, the acceptance rows were only in the JSON, and `C 10uF Device:C` never
// named the 0603 the human asked for.
import { describe, it, expect } from "vitest";
import {
  acceptanceLabel, acceptanceRows, ensureBlockSteps, footprintShortName, missingFootprintParts,
  normalizePlan, planMarkdown, planView, reconcileSheets, stepSheets, type DesignPlan,
} from "../plans/schema";

/** Run 18 cut down to the fields these tests turn on: three blocks, all of them on the power sheet. */
const RUN18 = {
  schema_version: 1, kind: "schematic", id: "p", version: 1,
  goal: "USB-powered 3.3 V supply, supply circuitry on a dedicated power sheet.",
  net_naming: { rail_mechanism: "power_port", rails: ["VBUS", "+3V3", "GND"] },
  sheets: [{ file: "ldo_board.kicad_sch" }, { file: "power.kicad_sch", create: true }],
  blocks: [
    {
      id: "usb_in", sheet: "power.kicad_sch", summary: "USB power input",
      parts: [{ ref_prefix: "J", lib_id: "Connector_Generic:Conn_01x04", value: "USB POWER", footprint: "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical" }],
      nets_in: [], nets_out: ["VBUS", "GND"],
      acceptance: [{ type: "pin_on_net", ref_prefix: "J", pin: "1", net: "VBUS" }, { type: "text", text: "J1 pins 2 and 3 are no-connect." }],
    },
    {
      id: "ldo", sheet: "power.kicad_sch", summary: "3.3 V linear regulator",
      parts: [
        { ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3", value: "AMS1117-3.3", footprint: "Package_TO_SOT_SMD:SOT-223-3_TabPin2" },
        { ref_prefix: "C", lib_id: "Device:C", value: "10uF", footprint: "Capacitor_SMD:C_0603_1608Metric" },
        { ref_prefix: "C", lib_id: "Device:C", value: "100nF" },
      ],
      nets_in: ["VBUS", "GND"], nets_out: ["+3V3"], acceptance: [],
    },
  ],
  steps: [],
  envelope: { budgets: { components_added: 8, components_deleted: 0 }, allowed_ops: ["place_component"], structural: [] },
};

const plan18 = (): DesignPlan => ensureBlockSteps(reconcileSheets(normalizePlan(RUN18), ["ldo_board.kicad_sch"]));

describe("plan card: the sheet each step draws on", () => {
  it("names the block's sheet on every step line, and the created sheets on the scaffold", () => {
    const p = plan18();
    const md = planMarkdown(p);
    const lines = md.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines.some((l) => /create the plan's sheets — on power/.test(l))).toBe(true);
    expect(lines.filter((l) => / — on power/.test(l)).length).toBeGreaterThanOrEqual(3);
    // The wiring / gate steps bind to no block: they name every sheet the blocks sit on.
    expect(lines.at(-1)).toMatch(/ — on power$/);
  });
  it("stepSheets is the block's sheet stem, the scaffold's created sheets, else every block sheet", () => {
    const p = plan18();
    const draft = p.steps.find((s) => s.block === "ldo")!;
    expect(stepSheets(p, draft)).toEqual(["power"]);
    expect(stepSheets(p, p.steps.find((s) => s.kind === "scaffold")!)).toEqual(["power"]);
    expect(stepSheets(p, p.steps.find((s) => s.kind === "gate")!)).toEqual(["power"]);
    // A plan whose blocks are split across sheets says both on the steps that bind to no block.
    const split: DesignPlan = { ...p, blocks: [{ ...p.blocks[0], sheet: "ldo_board.kicad_sch" }, p.blocks[1]] };
    expect(stepSheets(split, split.steps.find((s) => s.kind === "gate")!)).toEqual(["ldo_board", "power"]);
  });
  it("keeps the parts on the line after the sheet", () => {
    const p = plan18();
    const line = planMarkdown(p).split("\n").find((l) => /linear regulator/.test(l))!;
    expect(line).toContain(" — on power — U AMS1117-3.3");
  });
});

describe("plan card: acceptance rows", () => {
  it("planView carries every block's rows with their type and derived flag", () => {
    const p = plan18();
    const view = planView(p, { done: new Set(), skipped: new Set(), current: null });
    const usb = view.blocks.find((b) => b.id === "usb_in")!;
    expect(usb.acceptance).toEqual([
      { label: "pin_on_net J.1 = VBUS", type: "pin_on_net", derived: false },
      { label: "J1 pins 2 and 3 are no-connect.", type: "text", derived: false },
    ]);
    // The regulator declared nothing checkable, so `withDerivedAcceptance` restated its own parts and
    // nets; those rows are marked, so the card can say they are not the Architect's own assertions.
    const ldo = view.blocks.find((b) => b.id === "ldo")!;
    expect(ldo.acceptance.length).toBeGreaterThan(0);
    expect(ldo.acceptance.every((r) => r.derived)).toBe(true);
    expect(ldo.acceptance.map((r) => r.label)).toContain("component_count C >= 2");
    expect(ldo.acceptance.map((r) => r.label)).toContain("net_has_pins +3V3 >= 2");
  });
  it("labels every acceptance type the schema allows", () => {
    expect(acceptanceLabel({ type: "net_has_pins", net: "GND", min: 3 })).toBe("net_has_pins GND >= 3");
    expect(acceptanceLabel({ type: "nets_disjoint", nets: ["+3V3", "GND"] })).toBe("nets_disjoint +3V3, GND");
    expect(acceptanceLabel({ type: "component_count", prefix: "c", min: 1, max: 3 })).toBe("component_count C 1..3");
    expect(acceptanceLabel({ type: "component_count", prefix: "R" })).toBe("component_count R any");
    expect(acceptanceLabel({ type: "check_clean", codes: ["ERC_*"] })).toBe("check_clean ERC_*");
    expect(acceptanceLabel({ type: "decoupling_near", ref_prefix: "U", pin: "VDD", max_dist_mil: 300, spec: "100n" })).toBe("decoupling_near U.VDD <= 300mil 100n");
    expect(acceptanceLabel({ type: "label_on_pin", ref_prefix: "U", pin: "2", net: "+3V3" })).toBe("label_on_pin U.2 = +3V3");
    expect(acceptanceLabel({ type: "no_connect", ref_prefix: "J", pins: ["2", "3"] })).toBe("no_connect J.2, 3");
    expect(acceptanceRows({ acceptance: [] })).toEqual([]);
  });
});

describe("plan card: packages", () => {
  it("reads the short package name off the KiCad footprint name", () => {
    expect(footprintShortName("Capacitor_SMD:C_0603_1608Metric")).toBe("0603");
    expect(footprintShortName("Resistor_SMD:R_0402_1005Metric")).toBe("0402");
    expect(footprintShortName("LED_SMD:LED_0603_1608Metric")).toBe("0603");
    expect(footprintShortName("Package_TO_SOT_SMD:SOT-223-3_TabPin2")).toBe("SOT-223");
    expect(footprintShortName("Package_TO_SOT_SMD:SOT-23-3")).toBe("SOT-23");
    expect(footprintShortName("Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical")).toBe("1x04 2.54mm");
    // Unknown shapes keep the footprint name without its library, never an invented package.
    expect(footprintShortName("Capacitor_THT:CP_Radial_D5.0mm_P2.50mm")).toBe("CP_Radial_D5.0mm_P2.50mm");
    expect(footprintShortName("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")).toBe("SOIC-8_3.9x4.9mm_P1.27mm");
    expect(footprintShortName("")).toBe("");
  });
  it("shows the package on the plan's own part label", () => {
    const md = planMarkdown(plan18());
    expect(md).toContain("C 10uF Device:C 0603");
    expect(md).toContain("U AMS1117-3.3 Regulator_Linear:AMS1117-3.3 SOT-223");
  });
  it("warns about generic passives with no footprint, and about nothing else", () => {
    const p = plan18();
    expect(missingFootprintParts(p)).toEqual(["ldo/C 100nF: Device:C"]);
    // The plan stays writable: a warning names the parts, it is not a validation error.
    const withFp: DesignPlan = { ...p, blocks: p.blocks.map((b) => ({ ...b, parts: b.parts.map((x) => ({ ...x, footprint: x.footprint ?? "Capacitor_SMD:C_0603_1608Metric" })) })) };
    expect(missingFootprintParts(withFp)).toEqual([]);
    // Symbols that carry their own package (a regulator, a connector) are never asked for one.
    expect(missingFootprintParts({ blocks: [{ id: "b", sheet: "s", summary: "", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3", resolved: true }], nets_in: [], nets_out: [], acceptance: [] }] })).toEqual([]);
    // The `_Small` / `_Polarized` variants are the same generic bodies.
    expect(missingFootprintParts({ blocks: [{ id: "b", sheet: "s", summary: "", parts: [{ ref_prefix: "C", lib_id: "Device:C_Polarized", resolved: true }, { ref_prefix: "L", lib_id: "Device:L_Small", resolved: true }], nets_in: [], nets_out: [], acceptance: [] }] }))
      .toEqual(["b/C: Device:C_Polarized", "b/L: Device:L_Small"]);
  });
});

describe("interfaces that are rails", () => {
  // Run 17 declared USB_5V / GND / +3V3 as interfaces as well as rails: each one would have become a
  // dangling sheet pin on both sides. A declared rail goes by name, an undeclared one by `isRailName`.
  it("normalises a plan whose interfaces are all rails to none at all", () => {
    const p = normalizePlan({
      ...RUN18,
      net_naming: { rail_mechanism: "power_port", rails: ["USB_5V", "+3V3", "GND"] },
      interfaces: [
        { from: "root", name: "USB_5V", to: "power", direction: "input" },
        { from: "root", name: "GND", to: "power", direction: "bidirectional" },
        { from: "power", name: "+3V3", to: "root", direction: "output" },
        "VBUS",
      ],
    });
    expect(p.interfaces).toEqual([]);
  });
  it("keeps a signal that only looks like one", () => {
    const p = normalizePlan({ ...RUN18, interfaces: [{ net: "VBUS_DET", from: "power", to: "root" }, { net: "GND", from: "power", to: "root" }] });
    expect(p.interfaces.map((i) => i.net)).toEqual(["VBUS_DET"]);
  });
});
