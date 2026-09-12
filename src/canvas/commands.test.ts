// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentBox, findInSheet, nextCursor, runCommand } from "./commands";
import { emptySheet, MM_TO_MIL, type RenderSheet } from "./types";
import { fitBox } from "./viewport";

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../crates/sch-geom/tests/fixtures/hier_root.render.json"), "utf8")) as RenderSheet;

describe("canvas commands", () => {
  it("fits the content when present and the paper when empty", () => {
    expect(contentBox(fixture)).toEqual(fixture.bbox);
    const empty = emptySheet("/");
    const b = contentBox(empty);
    expect(b[1][0]).toBeCloseTo(empty.paper_mm[0] * MM_TO_MIL, 3);
  });
  it("zooms around the centre and fits", () => {
    const view = { x: 0, y: 0, scale: 0.1 };
    const zi = runCommand({ seq: 1, kind: "zoom_in" }, { view, w: 800, h: 600, sheet: fixture, selection: [] });
    expect(zi.view!.scale).toBeCloseTo(0.125, 9);
    const fit = runCommand({ seq: 2, kind: "fit" }, { view, w: 800, h: 600, sheet: fixture, selection: [] });
    expect(fit.view).toEqual(fitBox(fixture.bbox, 800, 600));
    expect(fit.animate).toBe(true);
  });
  it("search finds a reference, a value and a net, and flashes it", () => {
    const ref = fixture.symbols.find((s) => !s.is_power)!;
    const hit = findInSheet(fixture, ref.reference.toLowerCase())!;
    expect(hit.refs).toEqual([{ kind: "component", ref: ref.reference }]);
    expect(findInSheet(fixture, ref.value)!.refs.length).toBeGreaterThan(0);
    const label = fixture.labels[0];
    if (label) expect(findInSheet(fixture, label.text)!.refs[0]).toEqual({ kind: "net", name: label.text });
    const r = runCommand({ seq: 3, kind: "search", query: ref.reference }, { view: { x: 0, y: 0, scale: 0.1 }, w: 800, h: 600, sheet: fixture, selection: [] });
    expect(r.flash?.refs[0]).toEqual({ kind: "component", ref: ref.reference });
    expect(r.view).not.toBeNull();
    expect(findInSheet(fixture, "no-such-thing-xyz")).toBeNull();
  });
});

describe("objectBox", () => {
  it("unions only object commands (uuid) and ignores frame/title block bounds", async () => {
    const { objectBox } = await import("./commands");
    const cmds = [{ uuid: "a" }, {}, { uuid: "b" }];
    const bounds = new Float64Array([100, 100, 200, 150, 0, 0, 10000, 8000, 50, 120, 300, 400]);
    expect(objectBox(cmds, bounds)).toEqual([[50, 100], [300, 400]]);
    expect(objectBox([{}], new Float64Array([0, 0, 10, 10]))).toBeNull();
  });
});

describe("finding walk and explicit focus", () => {
  it("wraps the cursor in both directions and starts at either end from -1", () => {
    expect(nextCursor(-1, 1, 3)).toBe(0);
    expect(nextCursor(-1, -1, 3)).toBe(2);
    expect(nextCursor(2, 1, 3)).toBe(0);
    expect(nextCursor(0, -1, 3)).toBe(2);
    expect(nextCursor(0, 1, 0)).toBe(-1);
  });
  it("focus_refs frames the given refs plus an anchor box and leaves the view alone when nothing resolves", () => {
    const view = { x: 0, y: 0, scale: 0.1 };
    const ref = fixture.symbols.find((s) => !s.is_power)!;
    const r = runCommand({ seq: 1, kind: "focus_refs", refs: [{ kind: "component", ref: ref.reference }] }, { view, w: 800, h: 600, sheet: fixture, selection: [] });
    expect(r.view).not.toBeNull();
    expect(r.flash?.refs).toEqual([{ kind: "component", ref: ref.reference }]);
    // A finding that names no component still frames its marker anchor.
    const anchor = runCommand({ seq: 2, kind: "focus_refs", refs: [{ kind: "finding", code: "X" }], box: [[1000, 1000], [1002, 1002]] }, { view, w: 800, h: 600, sheet: fixture, selection: [] });
    expect(anchor.view).not.toBeNull();
    const cx = anchor.view!.x + 800 / 2 / anchor.view!.scale;
    expect(cx).toBeCloseTo(1001, 0);
    // Unresolvable: no zoom-out to the whole sheet.
    const none = runCommand({ seq: 3, kind: "focus_refs", refs: [{ kind: "component", ref: "ZZ99" }] }, { view, w: 800, h: 600, sheet: fixture, selection: [] });
    expect(none.view).toBeNull();
  });
});
