// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { classifyWheel, gestureDown, gestureMove, gestureUp, PINCH_MAX } from "./gesture";

describe("gesture state machine", () => {
  it("left drag on empty canvas pans after the threshold; click without movement selects", () => {
    const s = gestureDown([10, 10], 0, {}, false)!;
    expect(s.mode).toBe("pending");
    expect(gestureMove(s, [11, 11], {}).action.kind).toBe("none");
    const m = gestureMove(s, [20, 12], {});
    expect(m.action).toEqual({ kind: "pan", dx: 10, dy: 2, hint: false });
    expect(gestureUp(s, [10, 10])).toEqual({ kind: "click", at: [10, 10] });
  });
  it("shift-drag rubber-bands, middle/alt/space pan immediately", () => {
    const s = gestureDown([0, 0], 0, { shift: true }, false)!;
    const m = gestureMove(s, [30, 40], { shift: true });
    expect(m.action.kind).toBe("band");
    expect(gestureUp(m.state, [30, 40])).toEqual({ kind: "band", from: [0, 0], to: [30, 40] });
    expect(gestureDown([0, 0], 1, {}, false)!.mode).toBe("pan");
    expect(gestureDown([0, 0], 0, { alt: true }, false)!.mode).toBe("pan");
    expect(gestureDown([0, 0], 0, { space: true }, true)!.mode).toBe("pan");
    expect(gestureDown([0, 0], 2, {}, false)).toBeNull();
  });
  it("a drag that starts on a symbol hints once, then pans", () => {
    const s = gestureDown([0, 0], 0, {}, true)!;
    const m1 = gestureMove(s, [10, 0], {});
    expect(m1.action).toEqual({ kind: "pan", dx: 10, dy: 0, hint: true });
    const m2 = gestureMove(m1.state, [20, 0], {});
    expect(m2.action).toEqual({ kind: "pan", dx: 10, dy: 0, hint: false });
  });
  it("classifies wheel input", () => {
    expect(classifyWheel({ deltaX: 0, deltaY: -100, deltaMode: 0 })).toEqual({ kind: "zoom", factor: 1.15 });
    expect(classifyWheel({ deltaX: 0, deltaY: 3.5, deltaMode: 0 })).toEqual({ kind: "pan", dx: -0, dy: -3.5 });
    expect(classifyWheel({ deltaX: 12, deltaY: 4, deltaMode: 0 })).toEqual({ kind: "pan", dx: -12, dy: -4 });
    expect(classifyWheel({ deltaX: 0, deltaY: 10, deltaMode: 0, ctrl: true }).kind).toBe("zoom");
    expect(classifyWheel({ deltaX: 0, deltaY: -1, deltaMode: 1 })).toEqual({ kind: "zoom", factor: 1.15 });
  });
  it("ctrl+wheel takes one fixed step per mouse detent and stays smooth for a trackpad pinch", () => {
    // A notch in pixel mode is 100-120 px; through the pinch curve that would be ~3x per notch.
    for (const deltaY of [40, 100, 120, 240]) {
      const a = classifyWheel({ deltaX: 0, deltaY, deltaMode: 0, ctrl: true });
      expect(a).toEqual({ kind: "zoom", factor: 1 / 1.15 });
      expect(a.kind === "zoom" && a.factor).toBeGreaterThanOrEqual(1 / PINCH_MAX);
      expect(a.kind === "zoom" && a.factor).toBeLessThanOrEqual(PINCH_MAX);
    }
    expect(classifyWheel({ deltaX: 0, deltaY: -120, deltaMode: 0, ctrl: true })).toEqual({ kind: "zoom", factor: 1.15 });
    // Line / page mode is a detent too, whichever the modifier.
    expect(classifyWheel({ deltaX: 0, deltaY: -1, deltaMode: 1, ctrl: true })).toEqual({ kind: "zoom", factor: 1.15 });
    expect(classifyWheel({ deltaX: 0, deltaY: 3, deltaMode: 2, meta: true })).toEqual({ kind: "zoom", factor: 1 / 1.15 });
    // Fine pinch deltas keep the exponential curve, clamped so no single event jumps.
    const pinch = classifyWheel({ deltaX: 0, deltaY: 4, deltaMode: 0, ctrl: true });
    expect(pinch).toEqual({ kind: "zoom", factor: Math.exp(-0.04) });
    expect(pinch.kind === "zoom" && pinch.factor).toBeGreaterThan(0.9);
    for (const deltaY of [-39, -12, 0, 12, 39]) {
      const a = classifyWheel({ deltaX: 0, deltaY, deltaMode: 0, ctrl: true });
      expect(a.kind === "zoom" && a.factor).toBeGreaterThanOrEqual(1 / PINCH_MAX);
      expect(a.kind === "zoom" && a.factor).toBeLessThanOrEqual(PINCH_MAX);
    }
  });
});

describe("canvas.drag_selects", () => {
  it("swaps the empty-space drag to a rubber band; Shift still bands and symbols still pan", () => {
    const drag = (mods: { shift?: boolean; dragSelects?: boolean }, onSymbol = false) => {
      const s = gestureDown([0, 0], 0, mods, onSymbol)!;
      return gestureMove(s, [30, 40], mods);
    };
    expect(drag({}).action.kind).toBe("pan"); // default: the setting is off
    expect(drag({ dragSelects: true }).action.kind).toBe("band");
    expect(drag({ dragSelects: true, shift: true }).action.kind).toBe("band");
    expect(drag({ shift: true }).action.kind).toBe("band");
    // A drag that starts on a symbol keeps the read-only hint + pan either way.
    expect(drag({ dragSelects: true }, true).action).toEqual({ kind: "pan", dx: 30, dy: 40, hint: true });
    // Middle button / Alt / Space still pan immediately with the setting on.
    expect(gestureDown([0, 0], 1, { dragSelects: true }, false)!.mode).toBe("pan");
    expect(gestureDown([0, 0], 0, { dragSelects: true, alt: true }, false)!.mode).toBe("pan");
    const m = drag({ dragSelects: true });
    expect(gestureUp(m.state, [30, 40])).toEqual({ kind: "band", from: [0, 0], to: [30, 40] });
  });
});
