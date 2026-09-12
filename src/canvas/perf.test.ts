// SPDX-License-Identifier: Apache-2.0
// Perf harness over the synthetic S-E7 sheet (1,000 symbols / 5,000 wires). Call counts are
// asserted (they are deterministic); wall times are only logged, unless FLUXSMITH_PERF=1.
//
// Baseline (2026-09-03, before the renderer rework; MacBook, jsdom):
//   drawCommands: 14,313 commands in ~9 ms
//   paint @fit:  stroke 13,300 · fill 2,200 · fillText 0 (text below 3 px) · setLineDash 26,600
//   paint @5%:   identical to @fit (no culling)
//   hitTest x1000: ~190 ms (linear)   highlightBoxes x50: ~1.1 ms   objectsByUuid: ~1.2 ms
// After (this commit): see the numbers printed by the test; asserted bounds below.

import { describe, expect, it } from "vitest";
import { synthSheet } from "./perf/synth";
import { cmdBounds, defaultTokens, drawCommands, paint, paintGrid } from "./renderer";
import { countingCtx, sumCounts } from "./testutil";
import { fitBox, visibleWorld, zoomAt } from "./viewport";
import { hitTest, hitTestLinear, regionHits, regionHitsLinear } from "./hittest";
import { highlightBoxes } from "./highlight";
import { objectsByUuid } from "./presence";
import { lcg } from "./perf/synth";

const PERF = process.env.FLUXSMITH_PERF === "1";
const W = 1600, H = 1000;

function ms(f: () => void): number {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
}

describe("canvas perf (synthetic 1,000 / 5,000 sheet)", () => {
  const sheet = synthSheet();
  const tokens = defaultTokens("light");
  let cmds = drawCommands(sheet, { frame: true });
  const tBuild = ms(() => { cmds = drawCommands(sheet, { frame: true }); });
  const bounds = cmdBounds(cmds);
  const fit = fitBox(sheet.bbox, W, H);
  // 5% view: zoom into the middle so roughly a twentieth of the sheet is on screen
  const zoomed = zoomAt(fit, [W / 2, H / 2], 4.5);

  it("generates a deterministic sheet of the S-E7 size", () => {
    expect(sheet.symbols.length).toBe(1000);
    expect(sheet.wires.length).toBe(5000);
    expect(synthSheet().symbols[3].value).toBe(sheet.symbols[3].value);
    expect(bounds.length).toBe(cmds.length * 4);
    console.log(`[perf] drawCommands: ${cmds.length} commands in ${tBuild.toFixed(1)} ms`);
  });

  it("paint at the fit view batches state and draws every command exactly once", () => {
    const c = countingCtx();
    const t = ms(() => paint(c.ctx, cmds, fit, { grid: false, tokens }));
    const draws = sumCounts(c.counts, ["stroke", "fill", "fillText"]);
    console.log(`[perf] paint@fit: ${t.toFixed(1)} ms · stroke ${c.counts.stroke ?? 0} · fill ${c.counts.fill ?? 0} · fillText ${c.counts.fillText ?? 0} · setLineDash ${c.counts.setLineDash ?? 0} · beginPath ${c.counts.beginPath ?? 0}`);
    expect(c.counts.beginPath).toBeGreaterThan(9_000);
    // state batching: dash changes only when the dash pattern changes (solid <-> bus dash), far fewer than strokes
    expect(c.counts.setLineDash ?? 0).toBeLessThan((c.counts.stroke ?? 0) / 4);
    expect(c.sets.strokeStyle ?? 0).toBeLessThan((c.counts.stroke ?? 0) / 4);
    expect(draws).toBeGreaterThan(9_000);
    if (PERF) expect(t).toBeLessThan(200);
  });

  it("culls off-screen commands at a 5% view and never drops a visible text at fit", () => {
    const full = countingCtx();
    paint(full.ctx, cmds, zoomed, { grid: false, tokens });
    const culled = countingCtx();
    const stats = { drawn: 0, culled: 0 };
    const t = ms(() => paint(culled.ctx, cmds, zoomed, { grid: false, tokens, visible: visibleWorld(zoomed, W, H), bounds, stats }));
    const fullDraws = sumCounts(full.counts, ["stroke", "fill", "fillText"]);
    const culledDraws = sumCounts(culled.counts, ["stroke", "fill", "fillText"]);
    console.log(`[perf] paint@5%: ${t.toFixed(1)} ms · draws ${culledDraws} of ${fullDraws} · culled ${stats.culled}`);
    expect(culledDraws).toBeLessThanOrEqual(fullDraws * 0.15);
    // every text anchored inside the visible box is still drawn with culling (the uncullled pass
    // also "draws" off-screen texts, so compare against the command list, not `full.texts`)
    const vis = visibleWorld(zoomed, W, H);
    const onScreen = cmds.filter((c) => c.op === "text" && c.at[0] >= vis[0][0] && c.at[0] <= vis[1][0] && c.at[1] >= vis[0][1] && c.at[1] <= vis[1][1] && c.size * zoomed.scale >= 3).map((c) => (c as { text: string }).text);
    expect(onScreen.length).toBeGreaterThan(0);
    for (const s of new Set(onScreen)) expect(culled.texts).toContain(s);
    // at the fit view culling is a no-op for the visible set
    const a = countingCtx(), b = countingCtx();
    paint(a.ctx, cmds, fit, { grid: false, tokens });
    paint(b.ctx, cmds, fit, { grid: false, tokens, visible: visibleWorld(fit, W, H), bounds });
    expect(new Set(b.texts)).toEqual(new Set(a.texts));
    expect(sumCounts(b.counts, ["stroke", "fill", "fillText"])).toBe(sumCounts(a.counts, ["stroke", "fill", "fillText"]));
  });

  it("grid costs one fill per frame (pattern path or a single batched path)", () => {
    const c = countingCtx();
    paintGrid(c.ctx, fit, W, H, "#ccc", 2);
    expect(sumCounts(c.counts, ["fill", "fillRect"])).toBeLessThanOrEqual(2);
  });

  it("hit-test through the spatial index equals the linear scan and is fast", { timeout: 60_000 }, () => {
    const rng = lcg(7);
    const pts: [number, number][] = [];
    for (let i = 0; i < 2000; i++) pts.push([sheet.bbox[0][0] + rng() * (sheet.bbox[1][0] - sheet.bbox[0][0]), sheet.bbox[0][1] + rng() * (sheet.bbox[1][1] - sheet.bbox[0][1])]);
    const tol = 6 / fit.scale;
    let hits = 0;
    let mismatches = 0;
    for (const p of pts) {
      const a = hitTest(sheet, p, tol);
      const b = hitTestLinear(sheet, p, tol);
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches++;
      if (a) hits++;
    }
    expect(mismatches).toBe(0);
    expect(hits).toBeGreaterThan(50);
    const boxes: [[number, number], [number, number]][] = [];
    for (let i = 0; i < 200; i++) {
      const x = sheet.bbox[0][0] + rng() * 30_000, y = sheet.bbox[0][1] + rng() * 20_000;
      boxes.push([[x, y], [x + rng() * 3000, y + rng() * 3000]]);
    }
    let regionMismatches = 0;
    for (const bx of boxes) if (JSON.stringify(regionHits(sheet, bx)) !== JSON.stringify(regionHitsLinear(sheet, bx))) regionMismatches++;
    expect(regionMismatches).toBe(0);
    const tIdx = ms(() => { for (let i = 0; i < 1000; i++) hitTest(sheet, pts[i], tol); });
    const tLin = ms(() => { for (let i = 0; i < 1000; i++) hitTestLinear(sheet, pts[i], tol); });
    console.log(`[perf] hitTest x1000: indexed ${tIdx.toFixed(1)} ms · linear ${tLin.toFixed(1)} ms`);
    if (PERF) expect(tIdx).toBeLessThan(5);
  });

  it("highlightBoxes and objectsByUuid are memoised per sheet", () => {
    const refs = sheet.symbols.slice(0, 50).map((s) => ({ kind: "component" as const, ref: s.reference }));
    highlightBoxes(sheet, [{ refs, kind: "focus" }], [], tokens, 0);
    const t = ms(() => { for (let i = 0; i < 20; i++) highlightBoxes(sheet, [{ refs, kind: "focus" }], [], tokens, 0); });
    console.log(`[perf] highlightBoxes x50 refs: ${(t / 20).toFixed(3)} ms/call`);
    expect(highlightBoxes(sheet, [{ refs, kind: "focus" }], [], tokens, 0).length).toBe(50);
    const first = objectsByUuid(sheet);
    const t2 = ms(() => { for (let i = 0; i < 100; i++) objectsByUuid(sheet); });
    expect(objectsByUuid(sheet)).toBe(first);
    console.log(`[perf] objectsByUuid (memoised) x100: ${t2.toFixed(2)} ms`);
    if (PERF) expect(t / 20).toBeLessThan(0.2);
  });
});
