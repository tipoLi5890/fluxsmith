// SPDX-License-Identifier: Apache-2.0
// Phase I: net highlight geometry, finding markers, follow policy, hit ladder, hover keys.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FindingRow } from "../agent/api";
import type { NetMapResult } from "../ipc/types";
import { followDecision, pauseUntil, FOLLOW_PAUSE_MS } from "./follow";
import { hitKey, hitTest, hitTestAll } from "./hittest";
import { drawMarkers, findingMarkers, markerAnchor, markerAt, markerScreen, onSheet, sheetIdMatches } from "./markers";
import { textOwnerHit } from "./hittest";
import { ghostDiff } from "./presence";
import { drawNetHighlight, netGeometry, netOfHit } from "./netpaths";
import { countingCtx } from "./testutil";
import type { RenderSheet } from "./types";
import { fitBox, type ViewState } from "./viewport";

const sheet: RenderSheet = JSON.parse(readFileSync(join(__dirname, "../../crates/sch-geom/tests/fixtures/hier_root.render.json"), "utf8"));
const tokens: Record<string, string> = { "--fs-canvas-hover": "#3b82f6", "--fs-canvas-finding": "#f5a623", "--fs-canvas-finding-error": "#e5484d", "--fs-canvas-finding-warning": "#f5a623", "--fs-canvas-finding-info": "#666666", "--fs-canvas-paper": "#ffffff" };
const view: ViewState = { x: 0, y: 0, scale: 0.1 };

function fakeMap(): NetMapResult {
  // Every wire on net A, every label on its own text, every pin on net A: membership is the engine's word.
  const wires: Record<string, string> = {};
  for (const w of sheet.wires) wires[w.uuid] = "A";
  const labels: Record<string, string> = {};
  for (const l of sheet.labels) labels[l.uuid] = l.text;
  const pins: Record<string, string> = {};
  for (const s of sheet.symbols) for (const p of s.pins) pins[`${s.reference}.${p.number}`] = "A";
  const sheet_pins: Record<string, string> = {};
  for (const sh of sheet.sheets) for (const p of sh.pins) sheet_pins[p.uuid] = "A";
  return { sheet: sheet.sheet_path, wires, labels, pins, sheet_pins };
}

/** Sheet pins of the fixture (a hierarchical sheet symbol with pins). */
const sheetPinCount = sheet.sheets.reduce((n, sh) => n + sh.pins.length, 0);

describe("netpaths", () => {
  it("collects wires, pins and label boxes of a net from the engine map only", () => {
    const map = fakeMap();
    const geo = netGeometry(sheet, map, "A");
    expect(sheetPinCount).toBeGreaterThan(0); // the fixture must exercise sheet pins
    expect(geo.segments.length).toBe(sheet.wires.length);
    expect(geo.pins.length).toBe(sheet.symbols.reduce((n, s) => n + s.pins.filter((p) => !p.hide).length, 0) + sheetPinCount);
    expect(geo.labelBoxes.length).toBe(0);
    const lbl = netGeometry(sheet, map, sheet.labels[0].text);
    expect(lbl.labelBoxes.length).toBeGreaterThan(0);
    expect(lbl.segments.length).toBe(0);
    expect(netGeometry(sheet, map, "A")).toBe(geo); // memoised
    expect(netGeometry(sheet, map, "NOPE").segments).toEqual([]);
  });
  it("does not serve one map's geometry for another map with identical counts (rename_net)", () => {
    const a = fakeMap();
    const b: typeof a = { ...a, wires: Object.fromEntries(Object.keys(a.wires).map((k) => [k, "RENAMED"])) };
    const geoA = netGeometry(sheet, a, "A");
    const geoB = netGeometry(sheet, b, "A");
    expect(geoA.segments.length).toBe(sheet.wires.length);
    expect(geoB.segments.length).toBe(0);
    expect(netGeometry(sheet, b, "RENAMED").segments.length).toBe(sheet.wires.length);
  });
  it("resolves the net of a hit through the map (pin, wire, label) and nothing else", () => {
    const map = fakeMap();
    const w = sheet.wires[0];
    expect(netOfHit(map, { kind: "wire", uuid: w.uuid })).toBe("A");
    const s = sheet.symbols[0];
    expect(netOfHit(map, { kind: "pin", reference: s.reference, number: s.pins[0].number })).toBe("A");
    expect(netOfHit(map, { kind: "label", uuid: sheet.labels[0].uuid })).toBe(sheet.labels[0].text);
    expect(netOfHit(map, { kind: "symbol", uuid: s.uuid })).toBeNull();
    expect(netOfHit(null, { kind: "wire", uuid: w.uuid })).toBeNull();
    // sheet pins come from their own channel; an older map without it resolves to no net
    const sp = sheet.sheets[0].pins[0];
    expect(netOfHit(map, { kind: "sheet_pin", uuid: sp.uuid })).toBe("A");
    expect(netOfHit({ ...map, sheet_pins: undefined }, { kind: "sheet_pin", uuid: sp.uuid })).toBeNull();
  });
  it("draws the highlight through the Canvas API only", () => {
    const c = countingCtx();
    drawNetHighlight(c.ctx, view, netGeometry(sheet, fakeMap(), "A"), tokens["--fs-canvas-hover"]);
    expect(c.calls).toContain("stroke");
    expect(c.calls).not.toContain("fillText");
  });
});

describe("markers", () => {
  const s0 = sheet.symbols[0];
  const rows: FindingRow[] = [
    { code: "ERC_A", severity: "Error", message: "pin", refs: [`${s0.reference}.${s0.pins[0].number}`], origin: "engine", turn: 1, resolved: false },
    { code: "LAYOUT_B", severity: "Warning", message: "sym", refs: [s0.reference], origin: "engine", turn: 1, resolved: false },
    { code: "OLD", severity: "Error", message: "gone", refs: [s0.reference], origin: "engine", turn: 1, resolved: true },
    { code: "ELSEWHERE", severity: "Error", message: "other sheet", refs: [s0.reference], sheet: "other.kicad_sch", origin: "engine", turn: 1, resolved: false },
    { code: "NOREF", severity: "Info", message: "sheet level", origin: "advisory", turn: 1, resolved: false },
  ];
  it("anchors at the pin tip for REF.PIN and the symbol's top-right for REF", () => {
    expect(markerAnchor(sheet, rows[0])).toEqual(s0.pins[0].at);
    expect(markerAnchor(sheet, rows[1])).toEqual([s0.bbox[1][0], s0.bbox[0][1]]);
    expect(markerAnchor(sheet, rows[4])).toBeNull();
  });
  it("filters by sheet, drops resolved, clusters near anchors at low zoom, worst severity wins", () => {
    expect(onSheet(rows[3], [sheet.file, sheet.sheet_path])).toBe(false);
    expect(onSheet(rows[0], [sheet.file])).toBe(true);
    const far = findingMarkers(sheet, rows, 1);
    expect(far.map((m) => m.findings.map((f) => f.code))).toEqual([["ERC_A"], ["LAYOUT_B"]]);
    const near = findingMarkers(sheet, rows, 0.001); // 10 px ~ 10,000 mil: everything clusters
    expect(near).toHaveLength(1);
    expect(near[0].findings.map((f) => f.code).sort()).toEqual(["ERC_A", "LAYOUT_B"]);
    expect(near[0].severity).toBe("error");
  });
  it("hit-tests the glyph on screen and paints only through the Canvas API", () => {
    const ms = findingMarkers(sheet, rows, 1);
    const v = fitBox(sheet.bbox, 800, 600);
    const at = markerScreen(ms[0], v);
    expect(markerAt(ms, v, at)?.findings[0].code).toBe("ERC_A");
    expect(markerAt(ms, v, [at[0] + 40, at[1] + 40])).toBeNull();
    const c = countingCtx();
    drawMarkers(c.ctx, v, findingMarkers(sheet, rows, 0.001), tokens, "sans-serif", "#fff");
    expect(c.calls).toContain("stroke");
    expect(c.texts).toEqual(["2"]); // only the cluster count is text
  });
});

describe("follow policy", () => {
  const size: [number, number] = [800, 600];
  const v: ViewState = { x: 0, y: 0, scale: 0.1 };
  it("does nothing while paused, when visible, or when the running animation already shows the box", () => {
    expect(followDecision({ view: v, size, target: [[1000, 1000], [2000, 2000]], pausedUntil: 0, now: 1000 })).toEqual({ kind: "none", reason: "visible" });
    const off: [[number, number], [number, number]] = [[50_000, 50_000], [50_100, 50_100]];
    expect(followDecision({ view: v, size, target: off, pausedUntil: 5000, now: 1000 })).toEqual({ kind: "none", reason: "paused" });
    const first = followDecision({ view: v, size, target: off, pausedUntil: 0, now: 1000 });
    expect(first.kind).toBe("animate");
    if (first.kind !== "animate") return;
    expect(first.ms).toBeGreaterThanOrEqual(200);
    expect(first.ms).toBeLessThanOrEqual(600);
    expect(first.target.scale).toBe(v.scale); // keeps the zoom when it fits
    expect(followDecision({ view: v, size, target: off, pausedUntil: 0, now: 1000, animTo: first.target })).toEqual({ kind: "none", reason: "already_animating" });
  });
  it("pauses for 20 s and zooms out only when the box does not fit", () => {
    expect(pauseUntil(1000)).toBe(1000 + FOLLOW_PAUSE_MS);
    const huge: [[number, number], [number, number]] = [[0, 0], [100_000, 100_000]];
    const d = followDecision({ view: v, size, target: huge, pausedUntil: 0, now: 0, reducedMotion: true });
    expect(d.kind).toBe("animate");
    if (d.kind === "animate") { expect(d.ms).toBe(0); expect(d.target.scale).toBeLessThan(v.scale); }
  });
});

describe("hit ladder", () => {
  it("hitTestAll starts with hitTest and keeps the priority order", () => {
    const s0 = sheet.symbols[0];
    const p = s0.pins[0].at;
    const all = hitTestAll(sheet, p, 20);
    expect(all[0]).toEqual(hitTest(sheet, p, 20));
    const order = ["pin", "sheet_pin", "symbol", "label", "junction", "no_connect", "wire", "sheet"];
    const kinds = all.map((h) => order.indexOf(h.kind));
    expect([...kinds].sort((a, b) => a - b)).toEqual(kinds);
    expect(all.some((h) => h.kind === "symbol" && h.reference === s0.reference)).toBe(true);
  });
  it("hitKey is stable per object and empty for null", () => {
    const s0 = sheet.symbols[0];
    const h = hitTest(sheet, s0.pins[0].at, 20);
    expect(hitKey(h)).toBe(`pin:${s0.reference}.${s0.pins[0].number}`);
    expect(hitKey(null)).toBe("");
  });
});

describe("sheet identifiers", () => {
  it("matches plan file names, instance uuid paths and names paths against the panel's id list", () => {
    const ids = ["power.kicad_sch", "/root-uuid/sheet-uuid/", "Power", "root/Power"];
    expect(sheetIdMatches("power.kicad_sch", ids)).toBe(true);
    expect(sheetIdMatches("/root-uuid/sheet-uuid/", ids)).toBe(true);
    expect(sheetIdMatches("/root/Power/", ids)).toBe(true);
    expect(sheetIdMatches("mcu.kicad_sch", ids)).toBe(false);
    expect(sheetIdMatches(null, ids)).toBe(false);
    // root sheet: "/" against the root file
    expect(sheetIdMatches("/", ["x.kicad_sch", "/"])).toBe(true);
  });
});

describe("property text hits and ghost diff", () => {
  it("maps a click on a symbol's drawn property text to that symbol", () => {
    const s0 = sheet.symbols[0];
    const cmds = [{ op: "path", uuid: s0.uuid }, { op: "text", uuid: s0.uuid }, { op: "text" }];
    const bounds = new Float64Array([0, 0, 10, 10, 5000, 5000, 5400, 5100, 9000, 9000, 9100, 9100]);
    const hit = textOwnerHit(sheet, cmds, bounds, [5200, 5050]);
    expect(hit && hit.kind === "symbol" && hit.reference).toBe(s0.reference);
    expect(textOwnerHit(sheet, cmds, bounds, [9050, 9050])).toBeNull(); // unowned text (title block)
    expect(textOwnerHit(sheet, cmds, bounds, [5, 5])).toBeNull(); // path, not text
  });
  it("ghost diff skips unchanged objects, draws moved ones and lists removed ones", () => {
    const disk = sheet;
    const moved = JSON.parse(JSON.stringify(sheet)) as typeof sheet;
    const s0 = moved.symbols[0];
    s0.bbox = [[s0.bbox[0][0] + 500, s0.bbox[0][1]], [s0.bbox[1][0] + 500, s0.bbox[1][1]]];
    const removedUuid = moved.wires[0].uuid;
    moved.wires = moved.wires.slice(1);
    const d = ghostDiff(disk, moved);
    expect(d.skip.has(s0.uuid)).toBe(false);
    expect(d.skip.has(moved.symbols[1].uuid)).toBe(true);
    expect(d.removed.length).toBe(1);
    expect(d.skip.has(removedUuid)).toBe(false);
  });
});
