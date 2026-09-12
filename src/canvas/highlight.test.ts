// SPDX-License-Identifier: Apache-2.0
// The persistent "changed this turn" highlight: a `changed` group without `since` never fades, and
// it addresses the objects an apply created by uuid (a wire has no designator). Uuids belonging to
// another sheet resolve to nothing, so the same group can travel with the human across sheets.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { anyFading, changeAlpha, highlightBoxes, CHANGE_FADE_MS, type Highlight } from "./highlight";
import { objectsByUuid } from "./presence";
import type { RenderSheet } from "./types";

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../crates/sch-geom/tests/fixtures/hier_root.render.json"), "utf8")) as RenderSheet;
const tokens = { "--fs-canvas-selection": "#111111", "--fs-canvas-focus": "#222222", "--fs-canvas-created": "#556655", "--fs-canvas-changed": "#333333", "--fs-canvas-finding": "#444444" };
const uuidBox = (u: string) => objectsByUuid(fixture).get(u)?.box ?? null;

describe("changed-this-turn highlight", () => {
  it("stays fully opaque without a `since` and fades only with one", () => {
    expect(changeAlpha(undefined, 1e9)).toBe(1);
    expect(changeAlpha(0, CHANGE_FADE_MS + 1)).toBe(0);
    const persistent: Highlight[] = [{ refs: [], kind: "changed", uuids: [fixture.wires[0].uuid] }];
    // A group that never fades must not keep the overlay animating either.
    expect(anyFading(persistent, 1e9)).toBe(false);
    expect(anyFading([{ refs: [], kind: "changed", since: 0 }], 1)).toBe(true);
  });

  it("resolves created objects by uuid and changed parts by designator", () => {
    const wire = fixture.wires[0];
    const sym = fixture.symbols.find((s) => !s.is_power)!;
    const h: Highlight[] = [{ refs: [{ kind: "component", ref: sym.reference }], kind: "changed", uuids: [wire.uuid] }];
    const boxes = highlightBoxes(fixture, h, [], tokens, 0, uuidBox);
    expect(boxes.length).toBe(2);
    // Both are drawn in the change tint, not in the focus one.
    expect(boxes.every((b) => b.style.stroke.startsWith("rgba(51,51,51"))).toBe(true);
  });

  it("draws nothing for uuids of another sheet and nothing at all without a resolver", () => {
    const h: Highlight[] = [{ refs: [], kind: "changed", uuids: ["not-on-this-sheet"] }];
    expect(highlightBoxes(fixture, h, [], tokens, 0, uuidBox)).toEqual([]);
    const known: Highlight[] = [{ refs: [], kind: "changed", uuids: [fixture.wires[0].uuid] }];
    expect(highlightBoxes(fixture, known, [], tokens, 0)).toEqual([]);
  });

  it("draws created and changed in two distinct styles", () => {
    const wire = fixture.wires[0];
    const sym = fixture.symbols.find((s) => !s.is_power)!;
    const boxes = highlightBoxes(fixture, [
      { refs: [], kind: "created", uuids: [wire.uuid] },
      { refs: [{ kind: "component", ref: sym.reference }], kind: "changed" },
    ], [], tokens, 0, uuidBox);
    expect(boxes.length).toBe(2);
    // Different token colour and a different outline: the difference survives a monochrome reading.
    expect(boxes[0].style.stroke).not.toBe(boxes[1].style.stroke);
    expect(boxes[0].style.stroke.startsWith("rgba(85,102,85")).toBe(true);
    expect(boxes[0].style.dash.length).toBeGreaterThan(0);
    expect(boxes[1].style.dash.length).toBe(0);
  });

  it("keeps the agent focus group and the change group apart", () => {
    const sym = fixture.symbols.find((s) => !s.is_power)!;
    const boxes = highlightBoxes(fixture, [
      { refs: [{ kind: "component", ref: sym.reference }], kind: "focus" },
      { refs: [], kind: "changed", uuids: [fixture.wires[0].uuid] },
    ], [], tokens, 0, uuidBox);
    expect(boxes.length).toBe(2);
    expect(boxes[0].style.dash.length).toBeGreaterThan(0); // focus is dashed
    expect(boxes[1].style.dash.length).toBe(0);
  });
});
