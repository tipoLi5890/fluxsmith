// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hitTest, hitTestAll, hitTestLinear, hitsToRefs, regionHits, regionHitsLinear, regionMode, regionToRefs, refBoxes, segmentDistance, selectionHits, sheetSymbolHit, symbolHit } from "./hittest";
import { spatialIndex } from "./spatial";
import { emptySheet, type RenderSheet } from "./types";

function sheet(): RenderSheet {
  const s = emptySheet("/");
  s.symbols.push({
    reference: "R1", value: "1k", uuid: "u1", lib_id: "Device:R", unit: 1, dnp: false, is_power: false, at: [2000, 2000], rotation: 0, mirror: "none",
    shapes: [], texts: [],
    pins: [
      { number: "1", name: "~", electrical: "passive", shape: "line", at: [2000, 1850], end: [2000, 1900], dir: [0, 1], length_mil: 50, hide: false, name_hidden: false, number_hidden: true, name_size_mil: 50, number_size_mil: 50, name_offset_mil: 0 },
      { number: "2", name: "~", electrical: "passive", shape: "line", at: [2000, 2150], end: [2000, 2100], dir: [0, -1], length_mil: 50, hide: false, name_hidden: false, number_hidden: true, name_size_mil: 50, number_size_mil: 50, name_offset_mil: 0 },
    ],
    bbox: [[1960, 1850], [2040, 2150]], unresolved: false,
  });
  s.wires.push({ uuid: "w1", a: [2000, 2150], b: [2500, 2150], is_bus: false, stroke: { width_mil: 0, style: "default" } });
  s.labels.push({ uuid: "l1", text: "VOUT", kind: "local", shape: "passive", at: [2500, 2150], rotation: 0, size_mil: 50, justify_h: "left", justify_v: "bottom", bbox: [[2500, 2080], [2700, 2150]] });
  s.sheets.push({
    uuid: "s1", name: "child", file: "child.kicad_sch", at: [3000, 1000], size: [500, 400], stroke: { width_mil: 0, style: "default" }, fill: "none", texts: [],
    pins: [{ uuid: "sp1", name: "VIN", shape: "input", at: [3000, 1100], rotation: 180, side: "left", size_mil: 50 }],
    bbox: [[3000, 1000], [3500, 1400]],
  });
  return s;
}

describe("hittest", () => {
  it("segmentDistance", () => {
    expect(segmentDistance([5, 3], [0, 0], [10, 0])).toBe(3);
    expect(segmentDistance([-4, 0], [0, 0], [10, 0])).toBe(4);
    expect(segmentDistance([1, 1], [1, 1], [1, 1])).toBe(0);
  });

  it("prefers pins, then symbols, then labels, wires and sheets", () => {
    const s = sheet();
    expect(hitTest(s, [2000, 1852], 5)?.kind).toBe("pin");
    expect(hitTest(s, [2000, 2000], 5)?.kind).toBe("symbol");
    expect(hitTest(s, [2600, 2100], 5)?.kind).toBe("label");
    expect(hitTest(s, [2300, 2152], 5)?.kind).toBe("wire");
    expect(hitTest(s, [3200, 1200], 5)?.kind).toBe("sheet");
    expect(hitTest(s, [9000, 9000], 5)).toBeNull();
  });

  it("hits a sheet pin before the sheet box and agrees with the linear scan", () => {
    const s = sheet();
    const idx = spatialIndex(s);
    expect([...idx.sheetPins.values()].flat().length).toBe(1);
    const hit = hitTest(s, [3002, 1102], 5);
    expect(hit?.kind).toBe("sheet_pin");
    expect(hit && hit.kind === "sheet_pin" && hit.name).toBe("VIN");
    expect(hit && hit.kind === "sheet_pin" && hit.shape).toBe("input");
    expect(hitTestLinear(s, [3002, 1102], 5)).toEqual(hit);
    // inside the sheet body but away from the pin: still the sheet itself
    expect(hitTest(s, [3200, 1200], 5)?.kind).toBe("sheet");
    // the pin is offered before the sheet box when both are under the point
    const all = hitTestAll(s, [3002, 1102], 5).map((h) => h.kind);
    expect(all[0]).toBe("sheet_pin");
    expect(all).toContain("sheet");
    // a sheet pin refers to the child sheet, exactly like the sheet symbol
    expect(hitsToRefs(s, [hit!])).toEqual([{ kind: "sheet", path: "/child/" }]);
    // and it carries the sheet symbol's own uuid: the hierarchy is entered by instance path
    expect(hit && hit.kind === "sheet_pin" && hit.sheet_uuid).toBe("s1");
  });
  it("finds the sheet symbol behind a sheet ref, so Enter can enter it", () => {
    const s = sheet();
    const hit = sheetSymbolHit(s, "/child/");
    expect(hit && hit.kind === "sheet" && hit.uuid).toBe("s1");
    expect(sheetSymbolHit(s, "/other/")).toBeNull();
  });

  it("finds the objects stacked at the selection and the symbol of a reference (keyboard fallbacks)", () => {
    const s = sheet();
    const kinds = selectionHits(s, [{ kind: "component", ref: "R1" }], 5).map((h) => h.kind);
    expect(kinds).toContain("symbol");
    expect(selectionHits(s, [], 5)).toEqual([]);
    expect(selectionHits(s, [{ kind: "component", ref: "NOPE" }], 5)).toEqual([]);
    const sym = symbolHit(s, "R1");
    expect(sym && sym.kind === "symbol" && sym.uuid).toBe("u1");
    expect(symbolHit(s, "R9")).toBeNull();
  });

  it("converts hits to refs and dedups", () => {
    const s = sheet();
    const hits = [hitTest(s, [2000, 2000], 5)!, hitTest(s, [2000, 1852], 5)!, hitTest(s, [2600, 2100], 5)!, hitTest(s, [2300, 2152], 5)!];
    const refs = hitsToRefs(s, hits, (uuid) => (uuid === "w1" ? "VOUT" : null));
    expect(refs).toEqual([
      { kind: "component", ref: "R1", sheet: "/" },
      { kind: "net", name: "VOUT" },
    ]);
  });

  it("region selection includes a region ref and everything inside", () => {
    const s = sheet();
    const refs = regionToRefs(s, [[2800, 2200], [1900, 1800]]);
    expect(refs.some((r) => r.kind === "component" && r.ref === "R1")).toBe(true);
    expect(refs.some((r) => r.kind === "net" && r.name === "VOUT")).toBe(true);
    const region = refs.find((r) => r.kind === "region");
    expect(region).toEqual({ kind: "region", sheet: "/", bbox_mil: [[1900, 1800], [2800, 2200]] });
  });

  it("selects enclosed items left-to-right and crossing items right-to-left (eeschema)", () => {
    const s = sheet();
    // A band that only clips the left end of w1 ([2000,2150] -> [2500,2150]).
    const touching: [[number, number], [number, number]] = [[1800, 2100], [2100, 2200]];
    const reversed: [[number, number], [number, number]] = [[2100, 2200], [1800, 2100]];
    expect(regionMode(touching)).toBe("enclosed");
    expect(regionMode(reversed)).toBe("crossing");
    const enclosed = regionHits(s, [[1800, 2100], [2100, 2200]], "enclosed").map((h) => h.kind);
    const crossing = regionHits(s, [[1800, 2100], [2100, 2200]], "crossing").map((h) => h.kind);
    expect(enclosed).not.toContain("wire");
    expect(crossing).toContain("wire");
    // The drag direction alone decides it, through `regionToRefs`.
    const netOf = (u: string) => (u === "w1" ? "VOUT" : null);
    expect(regionToRefs(s, touching, netOf).some((r) => r.kind === "net")).toBe(false);
    expect(regionToRefs(s, reversed, netOf).some((r) => r.kind === "net" && r.name === "VOUT")).toBe(true);
  });

  it("does not take a whole child sheet from a band that only encloses one of its pins", () => {
    const s = sheet();
    const isChild = (r: { kind: string }) => r.kind === "sheet";
    // Left-to-right around the pin at [3000, 1100] only: the sheet box [[3000,1000],[3500,1400]] is
    // nowhere near enclosed, so the selection must not quietly become the whole child sheet.
    const onPin: [[number, number], [number, number]] = [[2950, 1050], [3100, 1150]];
    expect(regionHits(s, onPin, "enclosed").map((h) => h.kind)).toContain("sheet_pin");
    expect(regionToRefs(s, onPin).some(isChild)).toBe(false);
    // Enclose the symbol itself and it is selected, pin and all.
    expect(regionToRefs(s, [[2900, 900], [3600, 1500]]).some(isChild)).toBe(true);
    // Right-to-left (crossing) over the same pin touches the sheet box, so the sheet comes with it.
    expect(regionToRefs(s, [[3100, 1150], [2950, 1050]]).some(isChild)).toBe(true);
  });

  it("region selection covers junctions, no-connects and sheet pins, and matches the linear scan", () => {
    const s = sheet();
    s.junctions.push({ uuid: "j1", at: [2500, 2150], diameter_mil: 0 });
    s.no_connects.push({ uuid: "nc1", at: [2000, 1850] });
    const box: [[number, number], [number, number]] = [[1500, 1000], [4000, 2500]];
    for (const mode of ["crossing", "enclosed"] as const) {
      const kinds = regionHits(s, box, mode).map((h) => h.kind);
      expect(kinds, mode).toContain("junction");
      expect(kinds, mode).toContain("no_connect");
      expect(kinds, mode).toContain("sheet_pin");
      expect(regionHits(s, box, mode), mode).toEqual(regionHitsLinear(s, box, mode));
    }
  });

  it("resolves refs back to boxes", () => {
    const s = sheet();
    expect(refBoxes(s, [{ kind: "component", ref: "R1" }])).toEqual([[[1960, 1850], [2040, 2150]]]);
    expect(refBoxes(s, [{ kind: "net", name: "VOUT" }]).length).toBe(1);
    expect(refBoxes(s, [{ kind: "sheet", path: "/child/" }]).length).toBe(1);
    expect(refBoxes(s, [{ kind: "turn", turn: 1 }])).toEqual([]);
  });
});
