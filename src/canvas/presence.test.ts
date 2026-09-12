// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attentionTarget, hiddenAt, latestRevealed, objectsByUuid, orbPosition, orbSettled, revealAlpha, revealDone, revealSchedule, revealSheet } from "./presence";
import type { RenderSheet } from "./types";

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../crates/sch-geom/tests/fixtures/hier_root.render.json"), "utf8")) as RenderSheet;

describe("attentionTarget", () => {
  it("resolves a component to its bbox centre and a net to its label", () => {
    const sym = fixture.symbols.find((s) => !s.is_power)!;
    const t = attentionTarget(fixture, { label: "read", refs: [{ kind: "component", ref: sym.reference }] })!;
    expect(t.at[0]).toBeCloseTo((sym.bbox[0][0] + sym.bbox[1][0]) / 2);
    expect(t.at[1]).toBeCloseTo((sym.bbox[0][1] + sym.bbox[1][1]) / 2);
    const lab = fixture.labels[0];
    const n = attentionTarget(fixture, { label: "net", refs: [{ kind: "net", name: lab.text }] })!;
    expect(n.at).toEqual(lab.at);
  });
  it("uses the region centre when a region is given, and null when nothing resolves", () => {
    const t = attentionTarget(null, { label: "block", region_mil: [[100, 200], [300, 400]] })!;
    expect(t.at).toEqual([200, 300]);
    expect(t.region).toEqual([[100, 200], [300, 400]]);
    expect(attentionTarget(fixture, { label: "x", refs: [{ kind: "component", ref: "ZZ99" }] })).toBeNull();
  });
});

describe("orb glide", () => {
  it("eases from start to target and settles after the duration", () => {
    const anim = { from: [0, 0] as [number, number], to: [100, 0] as [number, number], start: 1000 };
    expect(orbPosition(anim, 1000)[0]).toBe(0);
    const mid = orbPosition(anim, 1175)[0];
    expect(mid).toBeGreaterThan(50); // ease-out front-loads the motion
    expect(orbPosition(anim, 1400)[0]).toBe(100);
    expect(orbSettled(anim, 1200)).toBe(false);
    expect(orbSettled(anim, 1350)).toBe(true);
    expect(orbPosition(anim, 1000, 0)[0]).toBe(100); // reduced motion: instant
  });
});

describe("reveal scheduler", () => {
  const created = Array.from({ length: 5 }, (_, i) => ({ uuid: `u${i}`, kind: "symbol" }));
  it("spaces objects 70 ms apart in op order", () => {
    const s = revealSchedule(created);
    expect([...s.values()]).toEqual([0, 70, 140, 210, 280]);
  });
  it("compresses long lists so the reveal never exceeds the cap", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ uuid: `m${i}`, kind: "wire" }));
    const s = revealSchedule(many);
    expect(Math.max(...s.values())).toBeLessThanOrEqual(3000);
  });
  it("tracks hidden / latest / done over time", () => {
    const s = revealSchedule(created);
    expect(hiddenAt(s, 0, 100).size).toBe(3);
    expect(latestRevealed(s, 0, 100)).toBe("u1");
    expect(revealAlpha(70, 0, 70)).toBe(0);
    expect(revealAlpha(70, 0, 70 + 260)).toBe(1);
    expect(revealDone(s, 0, 500)).toBe(false);
    expect(revealDone(s, 0, 280 + 260)).toBe(true);
  });
  it("filters unrevealed objects out of the sheet and indexes every kind by uuid", () => {
    const idx = objectsByUuid(fixture);
    expect(idx.size).toBeGreaterThan(0);
    const first = fixture.symbols[0].uuid;
    const partial = revealSheet(fixture, new Set([first]));
    expect(partial.symbols.some((s) => s.uuid === first)).toBe(false);
    expect(partial.symbols.length).toBe(fixture.symbols.length - 1);
    expect(revealSheet(fixture, new Set())).toBe(fixture);
  });
});
