// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { changeAlpha, highlightBoxes, withAlpha } from "./highlight";
import { defaultTokens, drawCommands, paint, textCmd, type Cmd } from "./renderer";
import type { RenderSheet } from "./types";

const fixture = resolve(__dirname, "../../crates/sch-geom/tests/fixtures/hier_root.render.json");

function load(): RenderSheet {
  return JSON.parse(readFileSync(fixture, "utf8")) as RenderSheet;
}

import { countingCtx } from "./testutil";

describe("renderer", () => {
  it("produces commands for every item of the Rust fixture", () => {
    const sheet = load();
    const cmds = drawCommands(sheet);
    expect(sheet.symbols.length).toBeGreaterThan(0);
    const texts = cmds.filter((c): c is Extract<Cmd, { op: "text" }> => c.op === "text");
    // every visible reference appears as text
    for (const s of sheet.symbols) {
      const ref = s.texts.find((t) => t.role === "reference");
      if (ref && !ref.hide) expect(texts.some((t) => t.text === s.reference)).toBe(true);
    }
    // wires: one path each
    const paths = cmds.filter((c) => c.op === "path");
    expect(paths.filter((p) => p.op === "path" && p.stroke === "wire").length).toBe(sheet.wires.filter((w) => !w.is_bus).length);
    // junction dots
    expect(cmds.filter((c) => c.op === "circle" && c.fill === "junction").length).toBe(sheet.junctions.length);
    // labels: global labels have a flag path + text
    const globals = sheet.labels.filter((l) => l.kind === "global");
    expect(paths.filter((p) => p.op === "path" && p.stroke === "global_label").length).toBe(globals.length);
    // sheet symbols
    expect(paths.filter((p) => p.op === "path" && p.stroke === "sheet").length).toBe(sheet.sheets.length);
    // frame draws the paper
    expect(paths.some((p) => p.op === "path" && p.fill === "paper")).toBe(true);
    expect(drawCommands(sheet, { frame: false }).some((p) => p.op === "path" && p.fill === "paper")).toBe(false);
  });

  it("text rules flip justification for 180/270", () => {
    const base = { text: "X", at: [0, 0] as [number, number], size_mil: 50, justify_h: "left" as const, justify_v: "bottom" as const, bold: false, italic: false, hide: false, role: "text" as const };
    expect(textCmd({ ...base, rotation: 0 }, "text")).toMatchObject({ rotation: 0, hAlign: "left", vAlign: "bottom" });
    expect(textCmd({ ...base, rotation: 180 }, "text")).toMatchObject({ rotation: 0, hAlign: "right", vAlign: "top" });
    expect(textCmd({ ...base, rotation: 90 }, "text")).toMatchObject({ rotation: 90, hAlign: "left" });
    expect(textCmd({ ...base, rotation: 270 }, "text")).toMatchObject({ rotation: 90, hAlign: "right" });
  });

  it("paints only through the Canvas API and strings only via fillText", () => {
    const sheet = load();
    const c = countingCtx();
    paint(c.ctx, drawCommands(sheet), { x: 0, y: 0, scale: 0.3 }, { grid: false, tokens: defaultTokens("light") });
    expect(c.calls).toContain("stroke");
    expect(c.calls).toContain("fillText");
    expect(c.texts).toContain("R1");
    // the only non-Canvas-API touch points are property sets on the context itself
    expect(c.calls.every((name) => typeof name === "string")).toBe(true);
    // tiny text is skipped at low zoom
    const c2 = countingCtx();
    paint(c2.ctx, drawCommands(sheet), { x: 0, y: 0, scale: 0.01 }, { grid: false, tokens: defaultTokens("dark") });
    expect(c2.texts.length).toBe(0);
    // skipText / skip / culling never add draw calls; a `skip` set removes an object's commands entirely
    const sym = sheet.symbols.find((s) => !s.is_power)!;
    const c3 = countingCtx();
    paint(c3.ctx, drawCommands(sheet), { x: 0, y: 0, scale: 0.3 }, { grid: false, tokens: defaultTokens("light"), skip: new Set([sym.uuid]) });
    expect(c3.texts).not.toContain(sym.reference);
    const c4 = countingCtx();
    paint(c4.ctx, drawCommands(sheet), { x: 0, y: 0, scale: 0.3 }, { grid: false, tokens: defaultTokens("light"), skipText: true });
    expect(c4.texts.length).toBe(0);
  });

  it("highlight helpers", () => {
    expect(withAlpha("#000", 0.5)).toBe("rgba(0,0,0,0.5)");
    expect(withAlpha("rgb(1, 2, 3)", 0.25)).toBe("rgba(1,2,3,0.25)");
    expect(changeAlpha(undefined, 0)).toBe(1);
    expect(changeAlpha(0, 10_000)).toBe(0);
    const sheet = load();
    const boxes = highlightBoxes(sheet, [{ refs: [{ kind: "component", ref: "R1" }], kind: "focus" }], [{ kind: "component", ref: "R2" }], defaultTokens("light"), 0);
    expect(boxes.length).toBe(2);
  });
});
