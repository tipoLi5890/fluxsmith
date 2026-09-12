// SPDX-License-Identifier: Apache-2.0
// Per-sheet lookup tables (reference -> boxes, net name -> boxes, sheet path -> boxes), built
// once per `RenderSheet` identity and memoised in a WeakMap. Used by `refBoxes` so highlight
// resolution is O(refs) instead of O(refs x sheet) on every animation frame.

import type { Box, RenderSheet } from "./types";

export interface SheetIndex {
  byReference: Map<string, Box[]>;
  /** Label texts and power-symbol values (what a `net` ref resolves to on this sheet). */
  byNet: Map<string, Box[]>;
  /** Sheet symbols by their child path (`/parent/name/`) and by file name. */
  bySheetPath: Map<string, Box[]>;
}

const cache = new WeakMap<RenderSheet, SheetIndex>();

function push(m: Map<string, Box[]>, k: string, b: Box): void {
  const arr = m.get(k);
  if (arr) arr.push(b);
  else m.set(k, [b]);
}

function joinSheetPath(parent: string, name: string): string {
  const base = parent.endsWith("/") ? parent : parent + "/";
  return `${base}${name}/`;
}

export function sheetIndex(sheet: RenderSheet): SheetIndex {
  const hit = cache.get(sheet);
  if (hit) return hit;
  const idx: SheetIndex = { byReference: new Map(), byNet: new Map(), bySheetPath: new Map() };
  for (const s of sheet.symbols) {
    push(idx.byReference, s.reference, s.bbox);
    if (s.is_power) push(idx.byNet, s.value, s.bbox);
  }
  // Labels are listed before power symbols in `refBoxes`' historical order; keep that order
  // by inserting labels first into a separate pass merged below.
  const labelBoxes = new Map<string, Box[]>();
  for (const l of sheet.labels) push(labelBoxes, l.text, l.bbox);
  for (const [k, boxes] of labelBoxes) {
    const existing = idx.byNet.get(k);
    idx.byNet.set(k, existing ? [...boxes, ...existing] : boxes);
  }
  for (const sh of sheet.sheets) {
    push(idx.bySheetPath, joinSheetPath(sheet.sheet_path, sh.name), sh.bbox);
    if (sh.file !== joinSheetPath(sheet.sheet_path, sh.name)) push(idx.bySheetPath, sh.file, sh.bbox);
  }
  cache.set(sheet, idx);
  return idx;
}
