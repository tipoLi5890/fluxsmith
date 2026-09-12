// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { boxVisible, fitBox, gridPitch, lerpView, pan, screenToWorld, worldToScreen, zoomAt, MAX_SCALE, MIN_SCALE } from "./viewport";

describe("viewport", () => {
  it("round-trips world <-> screen", () => {
    const v = { x: 100, y: -50, scale: 0.25 };
    const p: [number, number] = [1234.5, 678.9];
    const s = worldToScreen(v, p);
    const w = screenToWorld(v, s);
    expect(w[0]).toBeCloseTo(p[0], 9);
    expect(w[1]).toBeCloseTo(p[1], 9);
  });

  it("zoomAt keeps the anchor fixed and clamps", () => {
    const v = { x: 0, y: 0, scale: 0.1 };
    const anchor: [number, number] = [300, 200];
    const before = screenToWorld(v, anchor);
    const z = zoomAt(v, anchor, 2);
    const after = screenToWorld(z, anchor);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(z.scale).toBeCloseTo(0.2);
    expect(zoomAt(v, anchor, 1e9).scale).toBe(MAX_SCALE);
    expect(zoomAt(v, anchor, 1e-9).scale).toBe(MIN_SCALE);
  });

  it("pan moves the origin by screen px / scale", () => {
    const v = pan({ x: 0, y: 0, scale: 0.5 }, 10, -20);
    expect(v.x).toBe(-20);
    expect(v.y).toBe(40);
  });

  it("fitBox centres the box", () => {
    const box: [[number, number], [number, number]] = [[1000, 1000], [3000, 2000]];
    const v = fitBox(box, 800, 600, 0);
    expect(v.scale).toBeCloseTo(0.4);
    const c = worldToScreen(v, [2000, 1500]);
    expect(c[0]).toBeCloseTo(400);
    expect(c[1]).toBeCloseTo(300);
    expect(boxVisible(v, 800, 600, box, 0)).toBe(true);
    expect(boxVisible(v, 800, 600, [[0, 0], [100, 100]], 0)).toBe(false);
  });

  it("lerpView ends at the target", () => {
    const a = { x: 0, y: 0, scale: 0.1 };
    const b = { x: 500, y: 200, scale: 0.4 };
    expect(lerpView(a, b, 0)).toEqual(a);
    const end = lerpView(a, b, 1);
    expect(end.x).toBeCloseTo(b.x);
    expect(end.scale).toBeCloseTo(b.scale);
  });

  it("gridPitch doubles until lines are spaced enough", () => {
    expect(gridPitch(1)).toBe(50);
    expect(gridPitch(0.1)).toBe(200);
    expect(gridPitch(0.01, 12)).toBe(1600);
  });
});
