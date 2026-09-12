// SPDX-License-Identifier: Apache-2.0
// eeschema fidelity rules, pinned against kicad-cli 10.0.4 `sch export svg` of a calibration
// sheet (see docs/reviews/2026-09-03-canvas-fidelity.md). Coordinates in mil, +Y down.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultTokens, drawCommands, hierFlagPts, labelCmds, lodTier, paint, pinCmds, sheetSymbolCmds, TOKEN_NAMES, type Cmd } from "./renderer";
import { estimateWidthMil, KICAD_FONT_SCALE, makeMeasure } from "./textmetrics";
import { countingCtx } from "./testutil";
import type { RLabel, RPin, RSheetSymbol, RSymbol, RenderSheet } from "./types";

const fixture = resolve(__dirname, "../../crates/sch-geom/tests/fixtures/hier_root.render.json");
const load = (): RenderSheet => JSON.parse(readFileSync(fixture, "utf8")) as RenderSheet;
const texts = (cmds: Cmd[]) => cmds.filter((c): c is Extract<Cmd, { op: "text" }> => c.op === "text");
const paths = (cmds: Cmd[]) => cmds.filter((c): c is Extract<Cmd, { op: "path" }> => c.op === "path");

const sym: RSymbol = { reference: "U1", value: "X", uuid: "u", lib_id: "L:X", unit: 1, dnp: false, is_power: false, at: [3000, 2000], rotation: 0, mirror: "none", shapes: [], pins: [], texts: [], bbox: [[2700, 1700], [3300, 2300]], unresolved: false };
// AMS1117 VI: pin points +x from (2700,2000) to the body edge at (2800,2000); size 50 mil
const pin = (over: Partial<RPin>): RPin => ({ number: "3", name: "VI", electrical: "power_in", shape: "line", at: [2700, 2000], end: [2800, 2000], dir: [1, 0], length_mil: 100, hide: false, name_hidden: false, number_hidden: false, name_size_mil: 50, number_size_mil: 50, name_offset_mil: 20, ...over });

describe("pin text placement (kicad-cli 10.0.4)", () => {
  it("names inside: number above the stub centre, name past the stub end reading away from the pin", () => {
    const out: Cmd[] = [];
    pinCmds(pin({}), sym, out);
    const [num, name] = texts(out);
    expect(num.text).toBe("3");
    expect(num.at).toEqual([2750, 2000 - 0.2 * 50]);
    expect(num).toMatchObject({ hAlign: "center", vAlign: "alphabetic", rotation: 0 });
    // hidden text `VI` at stub end + offset, baseline 0.5 x size below the line, left aligned
    expect(name.at).toEqual([2820, 2025]);
    expect(name).toMatchObject({ hAlign: "left", vAlign: "alphabetic" });
  });
  it("names outside (offset 0): name above the stub, number below it", () => {
    const out: Cmd[] = [];
    pinCmds(pin({ name_offset_mil: 0 }), sym, out);
    const [name, num] = texts(out);
    expect(name.text).toBe("VI");
    expect(name.at).toEqual([2750, 2000 - 10]);
    expect(num.text).toBe("3");
    expect(num.at[1]).toBeGreaterThan(2000);
    expect(num.at).toEqual([2750, 2000 + 1.25 * 50]);
  });
  it("vertical pins keep the same 'above' side (-x) and read upward", () => {
    const out: Cmd[] = [];
    // GND pin pointing up from (3000,2330) to (3000,2230)
    pinCmds(pin({ number: "1", name: "GND", at: [3000, 2330], end: [3000, 2230], dir: [0, -1], name_offset_mil: 0 }), sym, out);
    const [name, num] = texts(out);
    expect(name).toMatchObject({ rotation: 90, hAlign: "center" });
    expect(name.at).toEqual([3000 - 10, 2280]);
    expect(num.at).toEqual([3000 + 62.5, 2280]);
  });
  it("hidden flags and `~` names produce no text; power pins with zero length none either", () => {
    const out: Cmd[] = [];
    pinCmds(pin({ name: "~", number_hidden: true }), sym, out);
    expect(texts(out)).toHaveLength(0);
    const out2: Cmd[] = [];
    pinCmds(pin({ length_mil: 0 }), { ...sym, is_power: true }, out2);
    expect(texts(out2)).toHaveLength(0);
  });
});

describe("label flags (kicad-cli 10.0.4)", () => {
  const label = (over: Partial<RLabel>): RLabel => ({ uuid: "l", text: "VIN", kind: "global", shape: "input", at: [1000, 1000], rotation: 0, size_mil: 50, justify_h: "left", justify_v: "bottom", bbox: [[0, 0], [0, 0]], ...over });
  it("global input: 2 x size tall, point at the anchor inset 0.875 x size, text after the point", () => {
    const out: Cmd[] = [];
    labelCmds(label({}), out, () => 200);
    const flag = paths(out)[0];
    const ys = flag.pts.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(100);
    expect(flag.pts[0]).toEqual([1000, 1000]);
    expect(flag.pts[1]).toEqual([1000 + 43.75, 950]);
    const t = texts(out)[0];
    expect(t.at[0]).toBeCloseTo(1000 + 43.75 + 12.5);
    // baseline 0.07 x size *below* the anchor line (kicad-cli hidden text y = anchor + 0.09 mm)
    expect(t.at[1]).toBeCloseTo(1000 + 3.5);
    expect(t).toMatchObject({ hAlign: "left", vAlign: "alphabetic" });
    // flat far end: text + margins
    const xs = flag.pts.map((p) => p[0]);
    expect(Math.max(...xs)).toBeCloseTo(43.75 + 200 + 12.5 + 25 + 1000);
  });
  it("global output has its point at the far end; passive is a box; bidirectional both", () => {
    const shapeOf = (shape: string) => { const out: Cmd[] = []; labelCmds(label({ shape }), out, () => 100); return paths(out)[0].pts; };
    expect(shapeOf("output")[0]).toEqual([1000, 950]);
    expect(shapeOf("output").some((p) => p[1] === 1000 && p[0] > 1100)).toBe(true);
    expect(shapeOf("passive")).toHaveLength(4);
    expect(shapeOf("bidirectional").filter((p) => p[1] === 1000)).toHaveLength(2);
  });
  it("rotation 180 reads toward the anchor; 90/270 keep the glyph side at -x", () => {
    const at = (rot: number, kind: RLabel["kind"] = "local") => { const out: Cmd[] = []; labelCmds(label({ rotation: rot, kind }), out, () => 100); return texts(out)[0]; };
    expect(at(0)).toMatchObject({ hAlign: "left", rotation: 0 });
    expect(at(0).at).toEqual([1010, 1000 - 13.75]);
    expect(at(180)).toMatchObject({ hAlign: "right", rotation: 0 });
    expect(at(180).at).toEqual([990, 1000 - 13.75]);
    expect(at(90).at).toEqual([1000 - 13.75, 990]);
    expect(at(270)).toMatchObject({ hAlign: "right", rotation: 90 });
    expect(at(270).at).toEqual([1000 - 13.75, 1010]);
  });
  it("hierarchical labels and sheet pins share the same 1 x size flag", () => {
    expect(hierFlagPts("input", 50)).toEqual([[0, 0], [25, -25], [50, -25], [50, 25], [25, 25]]);
    expect(hierFlagPts("bidirectional", 50)).toEqual([[0, 0], [25, -25], [50, 0], [25, 25]]);
    const out: Cmd[] = [];
    labelCmds(label({ kind: "hierarchical", rotation: 90 }), out, () => 100);
    expect(paths(out)[0].pts).toEqual([[1000, 1000], [975, 975], [975, 950], [1025, 950], [1025, 975]]);
    expect(texts(out)[0].at).toEqual([1000, 1000 - 57.5]);
    const sh: RSheetSymbol = { uuid: "s", name: "power", file: "power.kicad_sch", at: [2000, 2000], size: [1000, 500], stroke: { width_mil: 0, style: "default" }, fill: "none", pins: [{ uuid: "p", name: "VIN", shape: "input", at: [2000, 2100], rotation: 0, side: "left", size_mil: 50 }], texts: [], bbox: [[2000, 2000], [3000, 2500]] };
    const out2: Cmd[] = [];
    sheetSymbolCmds(sh, out2);
    expect(paths(out2)[1].pts).toEqual([[2000, 2100], [2025, 2075], [2050, 2075], [2050, 2125], [2025, 2125]]);
  });
  it("uses the injected measure for the flag length", () => {
    const a: Cmd[] = []; labelCmds(label({}), a, () => 100);
    const b: Cmd[] = []; labelCmds(label({}), b, () => 200);
    const len = (c: Cmd[]) => { const xs = paths(c)[0].pts.map((p) => p[0]); return Math.max(...xs) - Math.min(...xs); };
    expect(len(b) - len(a)).toBe(100);
  });
});

describe("text metrics", () => {
  it("estimates KiCad advance widths: capitals ~0.93 x size, CJK wider than the same grapheme count of ASCII", () => {
    expect(estimateWidthMil("VIN", 50)).toBeCloseTo((0.93 + 0.45 + 0.93) * 50);
    expect(estimateWidthMil("電源", 50)).toBeGreaterThanOrEqual(1.6 * estimateWidthMil("AB", 50) * 0.93 / 0.93 * 0.8);
    expect(estimateWidthMil("電源", 50) / estimateWidthMil("ab", 50)).toBeGreaterThan(1.5);
  });
  it("makeMeasure falls back to the estimate without a context and scales measured widths by size", () => {
    expect(makeMeasure(null, { sans: "s", mono: "m" })("ABC", 50, false, false)).toBe(estimateWidthMil("ABC", 50));
    const fake = { font: "", measureText: (t: string) => ({ width: t.length * 60 }) } as unknown as CanvasRenderingContext2D;
    const m = makeMeasure(fake, { sans: "s", mono: "m" }, 1);
    expect(m("AB", 50, false, false)).toBeCloseTo((120 / 100) * 50 * KICAD_FONT_SCALE);
    expect(m("AB", 100, false, false)).toBeCloseTo(2 * m("AB", 50, false, false));
  });
});

describe("widths, sizes, LOD, crisp strokes", () => {
  it("fixture: wires 6 mil, buses 12 mil, bus entries on the wire layer, no-connect 48 mil across", () => {
    const sheet = load();
    const cmds = drawCommands(sheet, { frame: false });
    for (const p of paths(cmds)) {
      if (p.stroke === "wire" && sheet.wires.some((w) => w.uuid === p.uuid && !w.is_bus)) expect(p.width).toBe(6);
      if (p.stroke === "bus") expect(p.width).toBe(12);
    }
    for (const e of sheet.bus_entries) expect(paths(cmds).find((p) => p.uuid === e.uuid)?.stroke).toBe("wire");
    for (const nc of sheet.no_connects) {
      const arms = paths(cmds).filter((p) => p.uuid === nc.uuid);
      expect(arms).toHaveLength(2);
      expect(arms[0].pts[1][0] - arms[0].pts[0][0]).toBe(48);
    }
  });
  it("LOD: boxes tier draws one filled box per symbol and no pins, labels or symbol text", () => {
    const sheet = load();
    expect(lodTier(1)).toBe("full");
    expect(lodTier(0.05)).toBe("text-off");
    expect(lodTier(0.02)).toBe("boxes");
    const cmds = drawCommands(sheet, { frame: false, lod: "boxes" });
    expect(paths(cmds).filter((p) => p.fill === "body" && p.stroke === null)).toHaveLength(sheet.symbols.filter((s) => !s.unresolved).length);
    expect(paths(cmds).some((p) => p.stroke === "pin")).toBe(false);
    expect(texts(cmds).some((t) => t.color === "reference")).toBe(false);
    expect(paths(cmds).filter((p) => p.stroke === "wire").length).toBeGreaterThan(0);
  });
  it("paint: font is 4/3 of the size, thin strokes round to device pixels, tiny dashes go solid", () => {
    const sheet = load();
    const c = countingCtx();
    const rec: { lw: number[]; dashes: number[][]; fonts: string[] } = { lw: [], dashes: [], fonts: [] };
    const target = c.ctx as unknown as Record<string, unknown>;
    const ctx = new Proxy(target, {
      get(t, prop) {
        if (prop === "setLineDash") return (d: number[]) => { rec.dashes.push(d); (t as Record<string, (...a: unknown[]) => void>)["setLineDash"](d); };
        return Reflect.get(t, prop);
      },
      set(t, prop, val) {
        if (prop === "lineWidth") rec.lw.push(val as number);
        if (prop === "font") rec.fonts.push(String(val));
        return Reflect.set(t, prop, val);
      },
    }) as unknown as CanvasRenderingContext2D;
    paint(ctx, drawCommands(sheet), { x: 0, y: 0, scale: 0.15 }, { grid: false, tokens: defaultTokens("light"), dpr: 2 });
    // 6 mil * 0.15 = 0.9 css px -> 1.8 device px -> rounded to 2 device px = 1 css px
    expect(rec.lw.every((w) => w > 2 || Number.isInteger(w * 2))).toBe(true);
    expect(rec.lw).toContain(1);
    // a 50 mil text at scale 0.15 = 7.5 css px * 4/3 = 10 px
    expect(rec.fonts.some((f) => f.includes("10.00px"))).toBe(true);
    const dashed: Cmd[] = [{ op: "path", pts: [[0, 0], [1000, 0]], close: false, stroke: "wire", fill: null, width: 6, dash: [72, 18] }];
    const c2 = countingCtx();
    paint(c2.ctx, dashed, { x: 0, y: 0, scale: 0.01 }, { grid: false, tokens: defaultTokens("light") });
    expect(c2.counts.setLineDash ?? 0).toBe(0);
    const c3 = countingCtx();
    paint(c3.ctx, dashed, { x: 0, y: 0, scale: 1 }, { grid: false, tokens: defaultTokens("light") });
    expect(c3.counts.setLineDash).toBe(2);
  });
});

describe("--fs-canvas-* tokens", () => {
  it("every token the renderer reads is defined in both theme blocks of tokens.css", () => {
    const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
    const darkAt = css.indexOf(':root[data-theme="dark"]');
    const light = css.slice(0, darkAt);
    const dark = css.slice(darkAt);
    for (const name of TOKEN_NAMES) {
      expect(light, `${name} (light)`).toMatch(new RegExp(`${name}:\\s*[^;]+;`));
      expect(dark, `${name} (dark)`).toMatch(new RegExp(`${name}:\\s*[^;]+;`));
    }
    // sheet content is KiCad's palette, state overlays stay semantic
    expect(light).toMatch(/--fs-canvas-wire:\s*#008000/i);
    expect(light).toMatch(/--fs-canvas-changed:\s*var\(--blue-500\)/);
  });
});
