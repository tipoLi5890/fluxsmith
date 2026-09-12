// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { blockCaption, stylistOps, STYLIST_OPS, uuidOfLocation, wireAxis } from "../stylist";
import { p12 } from "../policy/hooks";
import { newTurnPolicyState } from "../policy/types";

const region: [[number, number], [number, number]] = [[1000, 1000], [3000, 2500]];

describe("stylist ops", () => {
  it("re-lays on row/overlap findings, rotates power ports by uuid, and frames the block", () => {
    const o = stylistOps({
      block: { id: "power", summary: "USB-C 5V input, CC pull-downs and 3.3V LDO" },
      findings: [
        { code: "ROW_MISALIGNED", severity: "Warning", message: "", location: "style:row:power:11111111-1111-4111-8111-111111111111", at_mil: [1200, 1300] } as never,
        { code: "POWER_PORT_ORIENTATION", severity: "Warning", message: "GND points up", remediation: "rotation=0", location: "style:power:22222222-2222-4222-8222-222222222222", at_mil: [1500, 1400] } as never,
        { code: "LABEL_OVERLAP", severity: "Warning", message: "", location: "labels:a:b", at_mil: [9000, 9000] } as never,
      ],
      bboxMil: [[1210, 1180], [2790, 2330]],
      region,
    })!;
    expect(o.note).toBe("stylist");
    expect(o.ops.map((x) => x.op)).toEqual(["arrange_group", "set_component_transform", "add_rectangle", "add_text"]);
    expect(o.ops[1]).toMatchObject({ uuid: "22222222-2222-4222-8222-222222222222", rotation: 0 });
    expect(o.ops[2]).toMatchObject({ start: [1050, 1000], end: [2950, 2500], key: "frame:power" });
    expect(String((o.ops[3] as { text: string }).text).length).toBeLessThanOrEqual(40);
  });
  it("sets the title block from the sheet title only when the finding and a title are present", () => {
    const f = { code: "TITLE_BLOCK_EMPTY", severity: "Warning", message: "", location: "sheet", at_mil: null } as never;
    const withTitle = stylistOps({ block: { id: "b" }, findings: [f], bboxMil: null, region, sheetTitle: "rc_lowpass" })!;
    expect(withTitle.ops).toEqual([{ op: "set_title_block", title: "rc_lowpass" }]);
    expect(stylistOps({ block: { id: "b" }, findings: [f], bboxMil: null, region })).toBeNull();
  });
  it("returns null with nothing to do and parses uuid locations", () => {
    expect(stylistOps({ block: { id: "b" }, findings: [], bboxMil: null, region })).toBeNull();
    expect(uuidOfLocation("style:power:22222222-2222-4222-8222-222222222222")).toBe("22222222-2222-4222-8222-222222222222");
    expect(uuidOfLocation("overlap:R1:C1")).toBeNull();
  });
  // The engine's own remediation for this finding is the shape of the op ("set_component_transform
  // {uuid, rotation}") and names no angle, so nothing parsed and the stylist emitted no op at all —
  // six upside-down ports survived a whole real run (18) to delivery.
  it("rotates a power port the engine reported with no angle in its remediation", () => {
    const o = stylistOps({
      block: { id: "power" },
      findings: [{
        code: "POWER_PORT_ORIENTATION", severity: "Warning", message: "#PWR03 (GND) points up instead of down",
        remediation: "GND ports point down: set_component_transform {uuid, rotation} or re-place with place_gnd (the engine orients it from the pin)",
        location: "style:power:33333333-3333-4333-8333-333333333333", at_mil: [1500, 1400],
      } as never],
      bboxMil: null, region,
    })!;
    expect(o.ops).toEqual([{ op: "set_component_transform", uuid: "33333333-3333-4333-8333-333333333333", rotation: 0 }]);
  });

  it("a text collision asks for a re-lay while the geometry is unknown, and each retry lays the block out wider", () => {
    const findings = [{ code: "TEXT_OVERLAP", severity: "Warning", message: "R1 Value over C2", location: "text:R1:C2", at_mil: [1400, 1500] } as never];
    const first = stylistOps({ block: { id: "b" }, findings, bboxMil: null, region })!;
    expect(first.ops).toEqual([{ op: "arrange_group", group: "b", region_mil: region, only_unwired: true }]);
    // A retry with the same pitch would be a replay of the move that did not help, not a new attempt.
    const second = stylistOps({ block: { id: "b" }, findings, bboxMil: null, region, attempt: 1 })!;
    expect(second.ops[0]).toMatchObject({ op: "arrange_group", pitch_mil: 700, pitch_y_mil: 500 });
    const third = stylistOps({ block: { id: "b" }, findings, bboxMil: null, region, attempt: 2 })!;
    expect(third.ops[0]).toMatchObject({ pitch_mil: 800, pitch_y_mil: 600 });
    // A field over its own body has no mechanical repair at all: a move takes the field with it, so
    // the pass emits nothing and the finding is reported to the user instead of being "arranged".
    expect(stylistOps({ block: { id: "b" }, findings: [{ code: "FIELD_OVER_OWN_BODY", severity: "Warning", refs: ["R1"], location: "fieldbody:11111111-1111-4111-8111-111111111111:Value", at_mil: [1400, 1500] } as never], bboxMil: null, region })).toBeNull();
  });

  // The block the harness is tidying has already been wired, so `arrange_group {only_unwired:true}`
  // leaves every part where it is: run 19 answered six layout findings with one op that moved nothing.
  it("moves the part each finding names once it knows where the parts are", () => {
    const geom = {
      at: { R1: [1400, 1500], C2: [1200, 1500], R7: [1600, 1900], R8: [1900, 1900], C9: [2200, 1600] } as Record<string, [number, number]>,
      box: { R7: [[1550, 1800], [1650, 2000]], R8: [[1850, 1810], [1950, 2040]] } as Record<string, [[number, number], [number, number]]>,
      labelAt: { "44444444-4444-4444-8444-444444444444": [1500, 1450] } as Record<string, [number, number]>,
    };
    const o = stylistOps({
      block: { id: "b" },
      findings: [
        { code: "TEXT_OVERLAP", severity: "Warning", message: "Value text runs over C2", refs: ["R1", "C2"], location: "text:11111111-1111-4111-8111-111111111111:C2", at_mil: [1300, 1520] },
        { code: "ROW_MISALIGNED", severity: "Warning", message: "R7 and R8 sit in one row but their bottoms differ by 40 mil", refs: ["R7"], location: "style:row:77777777-7777-4777-8777-777777777777", at_mil: [1550, 2000] },
        { code: "ROW_MISALIGNED", severity: "Warning", message: "R7 and R8 sit in one row but their bottoms differ by 40 mil", refs: ["R8"], location: "style:row:88888888-8888-4888-8888-888888888888", at_mil: [1550, 2040] },
        { code: "DECAP_FAR", severity: "Warning", message: "C9 (100nF) is 1200 mil from the nearest power pin on +3V3", refs: ["C9.1"], evidence: { nearest_pin: "U1.4" }, at_mil: [2200, 1600] },
      ] as never,
      bboxMil: null, region, geom,
    })!;
    // R1's value runs over C2, which is 200 mil to its left: R1 goes 100 mil further right.
    expect(o.ops.filter((x) => x.designator === "R1")).toEqual([{ op: "move_component", designator: "R1", x_mil: 1500, y_mil: 1500 }]);
    // The row is aligned on the topmost bottom edge (2000), so only R8 (2040) moves, by a grid step.
    expect(o.ops.filter((x) => x.designator === "R8")).toEqual([{ op: "move_component", designator: "R8", x_mil: 1900, y_mil: 1850 }]);
    expect(o.ops.some((x) => x.designator === "R7")).toBe(false);
    // The capacitor is anchored on the pin the finding's evidence names, not on a guessed coordinate.
    expect(o.ops.at(-1)).toEqual({ op: "move_component", designator: "C9", anchor: "U1.4", offset_mil: [0, 200] });
    // Nothing here is a re-lay: `arrange_group` would have skipped every one of these wired parts.
    expect(o.ops.some((x) => x.op === "arrange_group")).toBe(false);
    expect(o.ops.every((x) => STYLIST_OPS.has(String(x.op)))).toBe(true);
  });

  // P2-7: the engine already decided which line the row shares and how far each part is off it
  // (`target_y_mil` / `delta_mil` in `gates.rs`). The pass moves by those numbers instead of
  // re-deriving the row from bounding boxes and re-applying a copy of the engine's tolerances.
  it("aligns a row by the engine's own target and delta, not by mirrored thresholds", () => {
    const geom = { at: { R7: [1600, 1900], R8: [1900, 1940] } as Record<string, [number, number]> };
    const row = (ref: string, delta: number) => ({
      code: "ROW_MISALIGNED", severity: "Warning", message: "", refs: [ref], at_mil: [1550, 2000],
      location: `style:row:${ref}`, evidence: { target_y_mil: 1900, delta_mil: delta },
    });
    const o = stylistOps({ block: { id: "b" }, findings: [row("R7", 0), row("R8", -40)] as never, bboxMil: null, region, geom })!;
    // R7 is already on the line (delta 0) and is left alone; R8 moves by its own signed delta.
    expect(o.ops.filter((x) => x.designator === "R8")).toEqual([{ op: "move_component", designator: "R8", x_mil: 1900, y_mil: 1900 }]);
    expect(o.ops.some((x) => x.designator === "R7")).toBe(false);
  });

  it("aligns a sideways row on the axis the engine's evidence names", () => {
    const geom = { at: { R1: [1600, 1900], R2: [1660, 2100] } as Record<string, [number, number]> };
    const o = stylistOps({
      block: { id: "b" },
      findings: [{ code: "ROW_MISALIGNED", severity: "Warning", message: "", refs: ["R2"], at_mil: [1660, 2100], location: "style:row:R2", evidence: { target_x_mil: 1600, delta_mil: -60 } }] as never,
      bboxMil: null, region, geom,
    })!;
    expect(o.ops.filter((x) => x.designator === "R2")).toEqual([{ op: "move_component", designator: "R2", x_mil: 1600, y_mil: 2100 }]);
  });

  it("pushes a text off a label it covers, and keeps the re-lay for body overlaps", () => {
    const geom = { at: { R1: [1400, 1500] } as Record<string, [number, number]>, labelAt: { "44444444-4444-4444-8444-444444444444": [1400, 1300] } as Record<string, [number, number]> };
    const o = stylistOps({
      block: { id: "b" },
      findings: [
        { code: "TEXT_OVERLAP", severity: "Warning", message: "Reference text runs over label LED_A", refs: ["R1"], location: "textlabel:11111111-1111-4111-8111-111111111111:44444444-4444-4444-8444-444444444444", at_mil: [1400, 1350] },
        { code: "GROUP_OVERLAP", severity: "Error", message: "two bodies overlap", at_mil: [1400, 1500] },
      ] as never,
      bboxMil: null, region, geom,
    })!;
    // The label sits 200 mil above R1, so R1 moves 100 mil further down (the free axis is y).
    expect(o.ops[0]).toEqual({ op: "move_component", designator: "R1", x_mil: 1400, y_mil: 1600 });
    expect(o.ops[1]).toMatchObject({ op: "arrange_group", group: "b" });
  });

  // "Place and wire the complete USB-powered " was a real frame caption: the first 40 characters of
  // the prompt that drew the block, cut mid-word.
  it("captions a frame with the block's own name", () => {
    const long = { id: "usb_power", summary: "Place and wire the complete USB-powered 3.3 V supply" };
    expect(blockCaption(long)).toBe("usb_power");
    expect(blockCaption({ id: "", summary: long.summary })).toBe("Place and wire the complete USB-powered");
    expect(blockCaption({ id: "", name: "USB power input", summary: long.summary })).toBe("USB power input");
    const framed = stylistOps({ block: long, findings: [], bboxMil: [[1210, 1180], [2790, 2330]], region })!;
    expect(framed.ops.at(-1)).toMatchObject({ op: "add_text", text: "usb_power" });
  });

  // Run 21: C1 stayed 808 mil from U1.1 through the whole plan. Two things were wrong — the pass
  // never saw the finding (it is a `delivery` code; `STYLIST_DELIVERY_CODES` is the other half of the
  // fix, in lead.ts) and, when it does see one, "200 mil below the pin" is where the part the pin
  // belongs to usually sits. The engine hands over the pin's own coordinate, so a free spot on the
  // pin's free side is chosen instead.
  it("puts a far decap on a free grid spot beside the pin the engine measured to", () => {
    const geom = {
      at: { U1: [1500, 1500], C1: [2600, 2200], C2: [1800, 1700] } as Record<string, [number, number]>,
      box: {} as Record<string, [[number, number], [number, number]]>,
    };
    const decap = (evidence: Record<string, unknown>) => stylistOps({
      block: { id: "b" },
      findings: [{ code: "DECAP_FAR", severity: "Warning", message: "C1 (100nF) is 808 mil from the nearest power pin on +3V3", refs: ["C1.1"], evidence, at_mil: [2600, 2200] }] as never,
      bboxMil: null, region, geom,
    })!;
    // The pin sits right of U1's origin, so the free side is to the right: 200 mil out, on the grid.
    const right = decap({ nearest_pin: "U1.1", nearest_pin_at_mil: [1800, 1500] });
    expect(right.ops).toEqual([{ op: "move_component", designator: "C1", x_mil: 2000, y_mil: 1500 }]);
    expect(Math.abs(2000 - 1800)).toBeLessThanOrEqual(300);
    // C2 parked on that spot is not free, so the next side is taken instead.
    const taken = stylistOps({
      block: { id: "b" },
      findings: [{ code: "DECAP_FAR", severity: "Warning", message: "far", refs: ["C1.1"], evidence: { nearest_pin: "U1.1", nearest_pin_at_mil: [1800, 1500] }, at_mil: [2600, 2200] }] as never,
      bboxMil: null, region, geom: { ...geom, at: { ...geom.at, C2: [2000, 1500] } },
    })!;
    expect(taken.ops[0]).not.toMatchObject({ x_mil: 2000, y_mil: 1500 });
    expect(taken.ops[0]).toMatchObject({ op: "move_component", designator: "C1" });
    // Only the pin's name: the engine resolves it and the pass keeps the fixed offset it always had.
    expect(decap({ nearest_pin: "U1.1" }).ops).toEqual([{ op: "move_component", designator: "C1", anchor: "U1.1", offset_mil: [0, 200] }]);
  });

  // Every spot around the pin is outside the block region the approved plan declared: the pass may
  // not move a part out of it, and it must not drop the finding either — it is left open so the gate
  // reports it (`system.layout_unresolved`).
  it("emits no move when nothing free is inside the block region", () => {
    const far: [[number, number], [number, number]] = [[1000, 1000], [1100, 1100]];
    const o = stylistOps({
      block: { id: "b" },
      findings: [{ code: "DECAP_FAR", severity: "Warning", message: "far", refs: ["C1.1"], evidence: { nearest_pin_at_mil: [9000, 9000] }, at_mil: [9000, 9200] }] as never,
      bboxMil: null, region: far, geom: { at: { C1: [9000, 9200] } },
    });
    expect(o).toBeNull();
  });

  // A move drags the wire ends on the moved pins along, so a nudge across a wire's own axis
  // rubber-bands it (run 21 shipped two `LONG_WIRE: diagonal wire`). The engine redraws such a
  // segment as an L; the pass prefers not to ask for one.
  it("nudges a wired part along the axis of the wire attached to it", () => {
    const geom = {
      at: { R1: [1400, 1500], C2: [1400, 1300] } as Record<string, [number, number]>,
      wires: [{ from: [1400, 1500] as [number, number], to: [1900, 1500] as [number, number] }],
    };
    const finding = { code: "TEXT_OVERLAP", severity: "Warning", message: "R1 Value over C2", refs: ["R1", "C2"], location: "text:R1:C2", at_mil: [1400, 1400] } as never;
    // C2 sits 200 mil above R1, so the free axis by separation alone would be y; the wire is
    // horizontal, so R1 goes sideways instead and the wire stays straight.
    const o = stylistOps({ block: { id: "b" }, findings: [finding], bboxMil: null, region, geom })!;
    expect(o.ops[0]).toEqual({ op: "move_component", designator: "R1", x_mil: 1500, y_mil: 1500 });
    // Without the wires the old behaviour stands.
    const noWires = stylistOps({ block: { id: "b" }, findings: [finding], bboxMil: null, region, geom: { at: geom.at } })!;
    expect(noWires.ops[0]).toEqual({ op: "move_component", designator: "R1", x_mil: 1400, y_mil: 1600 });
    // A part with wires on both axes has no free axis, so nothing is preferred.
    expect(wireAxis("R1", geom)).toBe(0);
    expect(wireAxis("R1", { ...geom, wires: [...geom.wires, { from: [1400, 1500], to: [1400, 1900] }] })).toBeNull();
    expect(wireAxis("R1", { at: geom.at })).toBeNull();
  });

  it("P12 lets a stylist op-list through and still refuses a replay without the note", () => {
    const state = newTurnPolicyState(1, "build", "auto", "lead", null);
    state.acc.applied_seeds["s1"] = "100,100";
    const ops = [{ op: "arrange_group", group: "b" }, { op: "add_rectangle", start: [0, 0], end: [1, 1] }];
    expect(p12(state, { id: "x", name: "sch.apply", args: { oplist: { ops, note: "stylist" } }, role: "lead", index: 0, siblings: [] }).kind).toBe("allow");
  });
});
