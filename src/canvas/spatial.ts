// SPDX-License-Identifier: Apache-2.0
// Uniform-grid spatial index over a `RenderSheet`, built once per sheet identity (WeakMap).
// Items are bucketed by the cells their bbox spans; a query gathers the candidate indices of
// the cells covering the query box. Callers run the *same* priority ladder over the
// candidates as the linear scan, so results are identical (see `hittest.ts`).

import type { Box, Mil, RenderSheet } from "./types";

export interface SpatialIndex {
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  /** Per kind: cell id -> ascending item indices (pins are encoded as symbolIdx * 4096 + pinIdx). */
  pins: Map<number, number[]>;
  symbols: Map<number, number[]>;
  labels: Map<number, number[]>;
  junctions: Map<number, number[]>;
  wires: Map<number, number[]>;
  sheets: Map<number, number[]>;
  /** Sheet pins, encoded as sheetIdx * PIN_STRIDE + pinIdx (same stride as symbol pins). */
  sheetPins: Map<number, number[]>;
}

export const PIN_STRIDE = 4096;
const MIN_CELL = 500;
const TARGET_CELLS = 64;
/** Point items are treated as small boxes so any pick tolerance up to this many mil is covered. */
const POINT_RADIUS = 50;

const cache = new WeakMap<RenderSheet, SpatialIndex>();

function insert(m: Map<number, number[]>, idx: SpatialIndex, x0: number, y0: number, x1: number, y1: number, item: number): void {
  const cx0 = Math.floor((x0 - idx.minX) / idx.cell);
  const cy0 = Math.floor((y0 - idx.minY) / idx.cell);
  const cx1 = Math.floor((x1 - idx.minX) / idx.cell);
  const cy1 = Math.floor((y1 - idx.minY) / idx.cell);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const id = cy * idx.cols + cx;
      const arr = m.get(id);
      if (arr) arr.push(item);
      else m.set(id, [item]);
    }
  }
}

export function spatialIndex(sheet: RenderSheet): SpatialIndex {
  const hit = cache.get(sheet);
  if (hit) return hit;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    if (x0 < minX) minX = x0; if (y0 < minY) minY = y0; if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1;
  };
  for (const s of sheet.symbols) {
    grow(s.bbox[0][0], s.bbox[0][1], s.bbox[1][0], s.bbox[1][1]);
    for (const p of s.pins) grow(p.at[0] - POINT_RADIUS, p.at[1] - POINT_RADIUS, p.at[0] + POINT_RADIUS, p.at[1] + POINT_RADIUS);
  }
  for (const l of sheet.labels) grow(l.bbox[0][0], l.bbox[0][1], l.bbox[1][0], l.bbox[1][1]);
  for (const j of sheet.junctions) grow(j.at[0] - POINT_RADIUS, j.at[1] - POINT_RADIUS, j.at[0] + POINT_RADIUS, j.at[1] + POINT_RADIUS);
  for (const w of sheet.wires) grow(Math.min(w.a[0], w.b[0]), Math.min(w.a[1], w.b[1]), Math.max(w.a[0], w.b[0]), Math.max(w.a[1], w.b[1]));
  for (const sh of sheet.sheets) {
    grow(sh.bbox[0][0], sh.bbox[0][1], sh.bbox[1][0], sh.bbox[1][1]);
    for (const p of sh.pins) grow(p.at[0] - POINT_RADIUS, p.at[1] - POINT_RADIUS, p.at[0] + POINT_RADIUS, p.at[1] + POINT_RADIUS);
  }
  if (minX === Infinity) { minX = minY = 0; maxX = maxY = 1; }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const cell = Math.max(MIN_CELL, extent / TARGET_CELLS);
  const cols = Math.floor((maxX - minX) / cell) + 2;
  const idx: SpatialIndex = { cell, minX, minY, cols, pins: new Map(), symbols: new Map(), labels: new Map(), junctions: new Map(), wires: new Map(), sheets: new Map(), sheetPins: new Map() };
  sheet.symbols.forEach((s, si) => {
    insert(idx.symbols, idx, s.bbox[0][0], s.bbox[0][1], s.bbox[1][0], s.bbox[1][1], si);
    s.pins.forEach((p, pi) => {
      if (p.hide) return;
      insert(idx.pins, idx, p.at[0] - POINT_RADIUS, p.at[1] - POINT_RADIUS, p.at[0] + POINT_RADIUS, p.at[1] + POINT_RADIUS, si * PIN_STRIDE + pi);
    });
  });
  sheet.labels.forEach((l, i) => insert(idx.labels, idx, l.bbox[0][0], l.bbox[0][1], l.bbox[1][0], l.bbox[1][1], i));
  sheet.junctions.forEach((j, i) => insert(idx.junctions, idx, j.at[0] - POINT_RADIUS, j.at[1] - POINT_RADIUS, j.at[0] + POINT_RADIUS, j.at[1] + POINT_RADIUS, i));
  sheet.wires.forEach((w, i) => insert(idx.wires, idx, Math.min(w.a[0], w.b[0]), Math.min(w.a[1], w.b[1]), Math.max(w.a[0], w.b[0]), Math.max(w.a[1], w.b[1]), i));
  sheet.sheets.forEach((sh, i) => {
    insert(idx.sheets, idx, sh.bbox[0][0], sh.bbox[0][1], sh.bbox[1][0], sh.bbox[1][1], i);
    sh.pins.forEach((p, pi) => insert(idx.sheetPins, idx, p.at[0] - POINT_RADIUS, p.at[1] - POINT_RADIUS, p.at[0] + POINT_RADIUS, p.at[1] + POINT_RADIUS, i * PIN_STRIDE + pi));
  });
  cache.set(sheet, idx);
  return idx;
}

/** Ascending, de-duplicated item indices of `kind` whose cells cover the world box. */
export function candidates(idx: SpatialIndex, m: Map<number, number[]>, box: Box): number[] {
  const cx0 = Math.floor((box[0][0] - idx.minX) / idx.cell);
  const cy0 = Math.floor((box[0][1] - idx.minY) / idx.cell);
  const cx1 = Math.floor((box[1][0] - idx.minX) / idx.cell);
  const cy1 = Math.floor((box[1][1] - idx.minY) / idx.cell);
  if (cx0 === cx1 && cy0 === cy1) return m.get(cy0 * idx.cols + cx0) ?? [];
  const seen = new Set<number>();
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const arr = m.get(cy * idx.cols + cx);
      if (arr) for (const i of arr) seen.add(i);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function pointBox(p: Mil, r: number): Box {
  return [[p[0] - r, p[1] - r], [p[0] + r, p[1] + r]];
}
