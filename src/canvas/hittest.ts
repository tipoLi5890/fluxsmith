// SPDX-License-Identifier: Apache-2.0
// Hit-testing on `RenderSheet` geometry (world mil). Returns `Ref`s the chat
// can carry (`src/agent/api.ts`); the canvas never edits anything.

import type { Ref } from "../agent/api";
import type { Box, Mil, RenderSheet } from "./types";
import { boxesIntersect, boxUnion } from "./viewport";
import { candidates, pointBox, spatialIndex, PIN_STRIDE } from "./spatial";
import { sheetIndex } from "./sheet-index";

export type Hit =
  | { kind: "symbol"; reference: string; uuid: string; value: string; lib_id: string; bbox: Box }
  // `electrical` is the file's own pin type (`power_in`, `passive`, ...): read out as written, never inferred.
  | { kind: "pin"; reference: string; number: string; name: string; electrical: string; at: Mil }
  | { kind: "label"; uuid: string; text: string; label_kind: string; bbox: Box }
  | { kind: "wire"; uuid: string; is_bus: boolean; a: Mil; b: Mil }
  | { kind: "sheet"; uuid: string; name: string; file: string; bbox: Box }
  // `sheet_uuid` is the sheet symbol this pin sits on: the hierarchy is entered by instance path
  // (parent path + that uuid), never by the sheet's name or file.
  | { kind: "sheet_pin"; uuid: string; name: string; shape: string; side: string; sheet_uuid: string; sheet_name: string; sheet_file: string; at: Mil }
  | { kind: "junction"; uuid: string; at: Mil }
  | { kind: "no_connect"; uuid: string; at: Mil };

/** Hit for the `pi`-th pin of the `shi`-th sheet symbol. */
function sheetPinHit(sheet: RenderSheet, shi: number, pi: number): Hit {
  const sh = sheet.sheets[shi];
  const p = sh.pins[pi];
  return { kind: "sheet_pin", uuid: p.uuid, name: p.name, shape: p.shape, side: p.side, sheet_uuid: sh.uuid, sheet_name: sh.name, sheet_file: sh.file, at: p.at };
}

export function pointInBox(p: Mil, b: Box, slack = 0): boolean {
  return p[0] >= b[0][0] - slack && p[0] <= b[1][0] + slack && p[1] >= b[0][1] - slack && p[1] <= b[1][1] + slack;
}

export function segmentDistance(p: Mil, a: Mil, b: Mil): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * dx;
  const qy = a[1] + t * dy;
  return Math.hypot(p[0] - qx, p[1] - qy);
}

/**
 * Topmost hit at world point `p`. `tol` is the pick tolerance in mil (derive
 * from the view scale: ~6 px). Priority: pin > sheet pin > symbol > label >
 * junction > wire > sheet, which matches what a user expects to grab.
 */
export function hitTest(sheet: RenderSheet, p: Mil, tol: number): Hit | null {
  const idx = spatialIndex(sheet);
  const pinTol = tol * 1.2;
  // pins: first match in (symbol, pin) order, exactly like the linear scan
  for (const code of candidates(idx, idx.pins, pointBox(p, pinTol))) {
    const s = sheet.symbols[Math.floor(code / PIN_STRIDE)];
    const pin = s.pins[code % PIN_STRIDE];
    if (pin.hide) continue;
    if (Math.hypot(pin.at[0] - p[0], pin.at[1] - p[1]) <= pinTol) {
      return { kind: "pin", reference: s.reference, number: pin.number, name: pin.name, electrical: pin.electrical, at: pin.at };
    }
  }
  // Sheet pins sit on the sheet border and are the only way to see a hierarchical connection.
  for (const code of candidates(idx, idx.sheetPins, pointBox(p, pinTol))) {
    const shi = Math.floor(code / PIN_STRIDE);
    const pin = sheet.sheets[shi].pins[code % PIN_STRIDE];
    if (Math.hypot(pin.at[0] - p[0], pin.at[1] - p[1]) <= pinTol) return sheetPinHit(sheet, shi, code % PIN_STRIDE);
  }
  const q = pointBox(p, tol);
  let best: Hit | null = null;
  let bestArea = Infinity;
  for (const si of candidates(idx, idx.symbols, q)) {
    const s = sheet.symbols[si];
    if (pointInBox(p, s.bbox, tol)) {
      const area = (s.bbox[1][0] - s.bbox[0][0]) * (s.bbox[1][1] - s.bbox[0][1]);
      if (area < bestArea) {
        bestArea = area;
        best = { kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox };
      }
    }
  }
  if (best) return best;
  for (const li of candidates(idx, idx.labels, q)) {
    const l = sheet.labels[li];
    if (pointInBox(p, l.bbox, tol)) return { kind: "label", uuid: l.uuid, text: l.text, label_kind: l.kind, bbox: l.bbox };
  }
  for (const ji of candidates(idx, idx.junctions, q)) {
    const j = sheet.junctions[ji];
    if (Math.hypot(j.at[0] - p[0], j.at[1] - p[1]) <= tol) return { kind: "junction", uuid: j.uuid, at: j.at };
  }
  for (const nc of sheet.no_connects ?? []) if (Math.hypot(nc.at[0] - p[0], nc.at[1] - p[1]) <= Math.max(tol, 60)) return { kind: "no_connect", uuid: nc.uuid, at: nc.at };
  let bestWire: Hit | null = null;
  let bestD = tol;
  for (const wi of candidates(idx, idx.wires, q)) {
    const w = sheet.wires[wi];
    const d = segmentDistance(p, w.a, w.b);
    if (d <= bestD) {
      bestD = d;
      bestWire = { kind: "wire", uuid: w.uuid, is_bus: w.is_bus, a: w.a, b: w.b };
    }
  }
  if (bestWire) return bestWire;
  for (const shi of candidates(idx, idx.sheets, q)) {
    const sh = sheet.sheets[shi];
    if (pointInBox(p, sh.bbox, tol)) return { kind: "sheet", uuid: sh.uuid, name: sh.name, file: sh.file, bbox: sh.bbox };
  }
  return null;
}

/**
 * Every hit at `p` in ladder order (pins, sheet pins, symbols smallest-first, labels, junctions,
 * wires nearest-first, sheets): `[`/`]` cycle through these when objects overlap.
 * `hitTestAll(...)[0]` is `hitTest(...)`.
 */
export function hitTestAll(sheet: RenderSheet, p: Mil, tol: number): Hit[] {
  const idx = spatialIndex(sheet);
  const out: Hit[] = [];
  const pinTol = tol * 1.2;
  for (const code of candidates(idx, idx.pins, pointBox(p, pinTol))) {
    const s = sheet.symbols[Math.floor(code / PIN_STRIDE)];
    const pin = s.pins[code % PIN_STRIDE];
    if (pin.hide) continue;
    if (Math.hypot(pin.at[0] - p[0], pin.at[1] - p[1]) <= pinTol) out.push({ kind: "pin", reference: s.reference, number: pin.number, name: pin.name, electrical: pin.electrical, at: pin.at });
  }
  for (const code of candidates(idx, idx.sheetPins, pointBox(p, pinTol))) {
    const shi = Math.floor(code / PIN_STRIDE);
    const pin = sheet.sheets[shi].pins[code % PIN_STRIDE];
    if (Math.hypot(pin.at[0] - p[0], pin.at[1] - p[1]) <= pinTol) out.push(sheetPinHit(sheet, shi, code % PIN_STRIDE));
  }
  const q = pointBox(p, tol);
  const syms: { area: number; hit: Hit }[] = [];
  for (const si of candidates(idx, idx.symbols, q)) {
    const s = sheet.symbols[si];
    if (pointInBox(p, s.bbox, tol)) syms.push({ area: (s.bbox[1][0] - s.bbox[0][0]) * (s.bbox[1][1] - s.bbox[0][1]), hit: { kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox } });
  }
  syms.sort((a, b) => a.area - b.area);
  for (const x of syms) out.push(x.hit);
  for (const li of candidates(idx, idx.labels, q)) {
    const l = sheet.labels[li];
    if (pointInBox(p, l.bbox, tol)) out.push({ kind: "label", uuid: l.uuid, text: l.text, label_kind: l.kind, bbox: l.bbox });
  }
  for (const ji of candidates(idx, idx.junctions, q)) {
    const j = sheet.junctions[ji];
    if (Math.hypot(j.at[0] - p[0], j.at[1] - p[1]) <= tol) out.push({ kind: "junction", uuid: j.uuid, at: j.at });
  }
  // No-connect flags are few per sheet: a linear scan is cheaper than another index. An engineer checking
  // "did the agent NC every unused pin?" needs them hoverable.
  for (const nc of sheet.no_connects ?? []) if (Math.hypot(nc.at[0] - p[0], nc.at[1] - p[1]) <= Math.max(tol, 60)) out.push({ kind: "no_connect", uuid: nc.uuid, at: nc.at });
  const wires: { d: number; hit: Hit }[] = [];
  for (const wi of candidates(idx, idx.wires, q)) {
    const w = sheet.wires[wi];
    const d = segmentDistance(p, w.a, w.b);
    if (d <= tol) wires.push({ d, hit: { kind: "wire", uuid: w.uuid, is_bus: w.is_bus, a: w.a, b: w.b } });
  }
  wires.sort((a, b) => a.d - b.d);
  for (const x of wires) out.push(x.hit);
  for (const shi of candidates(idx, idx.sheets, q)) {
    const sh = sheet.sheets[shi];
    if (pointInBox(p, sh.bbox, tol)) out.push({ kind: "sheet", uuid: sh.uuid, name: sh.name, file: sh.file, bbox: sh.bbox });
  }
  return out;
}

/**
 * The symbol whose drawn property text (reference / value / footprint) contains `p`: the engine bbox excludes
 * those texts, so clicking "R1" or "10k" beside a body would otherwise hit nothing. `cmds` / `bounds` are the
 * renderer's command list and its per-command world boxes (4 floats each); only `text` commands owned by a
 * symbol uuid count.
 */
const symbolByUuidCache = new WeakMap<RenderSheet, Map<string, RenderSheet["symbols"][number]>>();
function symbolByUuid(sheet: RenderSheet, uuid: string): RenderSheet["symbols"][number] | undefined {
  let m = symbolByUuidCache.get(sheet);
  if (!m) { m = new Map(sheet.symbols.map((s) => [s.uuid, s])); symbolByUuidCache.set(sheet, m); }
  return m.get(uuid);
}

export function textOwnerHit(sheet: RenderSheet, cmds: readonly { op: string; uuid?: string }[], bounds: Float64Array, p: Mil, slack = 0, indices?: readonly number[]): Hit | null {
  let best: { area: number; hit: Hit } | null = null;
  const n = indices ? indices.length : cmds.length;
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k] : k;
    const c = cmds[i];
    if (c.op !== "text" || !c.uuid) continue;
    const o = i * 4;
    const x0 = bounds[o], y0 = bounds[o + 1], x1 = bounds[o + 2], y1 = bounds[o + 3];
    if (!Number.isFinite(x0) || p[0] < x0 - slack || p[0] > x1 + slack || p[1] < y0 - slack || p[1] > y1 + slack) continue;
    const s = symbolByUuid(sheet, c.uuid);
    if (!s) continue;
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { area, hit: { kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox } };
  }
  return best?.hit ?? null;
}

/**
 * Keyboard fallback for `[` / `]`: the objects stacked at the centre of the current selection, so a
 * selection made from the sidebar / search (never clicked) can still be cycled.
 */
export function selectionHits(sheet: RenderSheet, refs: readonly Ref[], tol: number): Hit[] {
  const u = boxUnion(refBoxes(sheet, refs as Ref[]));
  if (!u) return [];
  return hitTestAll(sheet, [(u[0][0] + u[1][0]) / 2, (u[0][1] + u[1][1]) / 2], tol);
}

/** The symbol hit for a reference (keyboard `Enter` opens the detail of the selected component). */
export function symbolHit(sheet: RenderSheet, reference: string): Hit | null {
  const s = sheet.symbols.find((x) => x.reference === reference);
  return s ? { kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox } : null;
}

/**
 * The sheet-symbol hit for a names path (`/Power/`), so keyboard `Enter` can enter the selected
 * sheet the way a double-click does. A `sheet` ref carries only the names path; the uuid the
 * hierarchy is addressed by comes back with the hit.
 */
export function sheetSymbolHit(sheet: RenderSheet, path: string): Hit | null {
  const sh = sheet.sheets.find((x) => joinSheetPath(sheet.sheet_path, x.name) === path);
  return sh ? { kind: "sheet", uuid: sh.uuid, name: sh.name, file: sh.file, bbox: sh.bbox } : null;
}

/** Identity of a hit (hover callbacks are skipped while this does not change). */
export function hitKey(h: Hit | null): string {
  if (!h) return "";
  switch (h.kind) {
    case "pin": return `pin:${h.reference}.${h.number}`;
    case "symbol": return `symbol:${h.uuid}`;
    case "label": return `label:${h.uuid}`;
    case "wire": return `wire:${h.uuid}`;
    case "sheet": return `sheet:${h.uuid}`;
    case "sheet_pin": return `sheet_pin:${h.uuid}`;
    case "junction": return `junction:${h.uuid}`;
    case "no_connect": return `nc:${h.uuid}`;
  }
}

/** Reference implementation (full scan); `hitTest` must return exactly this. */
export function hitTestLinear(sheet: RenderSheet, p: Mil, tol: number): Hit | null {
  for (const s of sheet.symbols) {
    for (const pin of s.pins) {
      if (pin.hide) continue;
      if (Math.hypot(pin.at[0] - p[0], pin.at[1] - p[1]) <= tol * 1.2) {
        return { kind: "pin", reference: s.reference, number: pin.number, name: pin.name, electrical: pin.electrical, at: pin.at };
      }
    }
  }
  for (let shi = 0; shi < sheet.sheets.length; shi++) {
    const pins = sheet.sheets[shi].pins;
    for (let pi = 0; pi < pins.length; pi++) {
      if (Math.hypot(pins[pi].at[0] - p[0], pins[pi].at[1] - p[1]) <= tol * 1.2) return sheetPinHit(sheet, shi, pi);
    }
  }
  // Smallest symbol bbox wins when nested.
  let best: Hit | null = null;
  let bestArea = Infinity;
  for (const s of sheet.symbols) {
    if (pointInBox(p, s.bbox, tol)) {
      const area = (s.bbox[1][0] - s.bbox[0][0]) * (s.bbox[1][1] - s.bbox[0][1]);
      if (area < bestArea) {
        bestArea = area;
        best = { kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox };
      }
    }
  }
  if (best) return best;
  for (const l of sheet.labels) {
    if (pointInBox(p, l.bbox, tol)) return { kind: "label", uuid: l.uuid, text: l.text, label_kind: l.kind, bbox: l.bbox };
  }
  for (const j of sheet.junctions) {
    if (Math.hypot(j.at[0] - p[0], j.at[1] - p[1]) <= tol) return { kind: "junction", uuid: j.uuid, at: j.at };
  }
  for (const nc of sheet.no_connects ?? []) if (Math.hypot(nc.at[0] - p[0], nc.at[1] - p[1]) <= Math.max(tol, 60)) return { kind: "no_connect", uuid: nc.uuid, at: nc.at };
  let bestWire: Hit | null = null;
  let bestD = tol;
  for (const w of sheet.wires) {
    const d = segmentDistance(p, w.a, w.b);
    if (d <= bestD) {
      bestD = d;
      bestWire = { kind: "wire", uuid: w.uuid, is_bus: w.is_bus, a: w.a, b: w.b };
    }
  }
  if (bestWire) return bestWire;
  for (const sh of sheet.sheets) {
    if (pointInBox(p, sh.bbox, tol)) return { kind: "sheet", uuid: sh.uuid, name: sh.name, file: sh.file, bbox: sh.bbox };
  }
  return null;
}

/**
 * eeschema parity: a left-to-right drag selects only what the band fully encloses, a right-to-left
 * drag selects anything it touches ("crossing"). Both modes list the same object kinds.
 */
export type RegionMode = "crossing" | "enclosed";

/** Drag direction of an un-normalized band (first corner = where the drag started). */
export function regionMode(band: Box): RegionMode {
  return band[1][0] >= band[0][0] ? "enclosed" : "crossing";
}

function boxInside(inner: Box, outer: Box): boolean {
  return inner[0][0] >= outer[0][0] && inner[0][1] >= outer[0][1] && inner[1][0] <= outer[1][0] && inner[1][1] <= outer[1][1];
}

function boxPicked(b: Box, box: Box, mode: RegionMode): boolean {
  return mode === "enclosed" ? boxInside(b, box) : boxesIntersect(b, box);
}

function wireBox(w: { a: Mil; b: Mil }): Box {
  return [[Math.min(w.a[0], w.b[0]), Math.min(w.a[1], w.b[1])], [Math.max(w.a[0], w.b[0]), Math.max(w.a[1], w.b[1])]];
}

/** Everything the rubber-band `box` picks up in `mode` (default: crossing). */
export function regionHits(sheet: RenderSheet, box: Box, mode: RegionMode = "crossing"): Hit[] {
  const idx = spatialIndex(sheet);
  const out: Hit[] = [];
  for (const si of candidates(idx, idx.symbols, box)) {
    const s = sheet.symbols[si];
    if (boxPicked(s.bbox, box, mode)) out.push({ kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox });
  }
  for (const li of candidates(idx, idx.labels, box)) {
    const l = sheet.labels[li];
    if (boxPicked(l.bbox, box, mode)) out.push({ kind: "label", uuid: l.uuid, text: l.text, label_kind: l.kind, bbox: l.bbox });
  }
  for (const shi of candidates(idx, idx.sheets, box)) {
    const sh = sheet.sheets[shi];
    if (boxPicked(sh.bbox, box, mode)) out.push({ kind: "sheet", uuid: sh.uuid, name: sh.name, file: sh.file, bbox: sh.bbox });
  }
  for (const wi of candidates(idx, idx.wires, box)) {
    const w = sheet.wires[wi];
    if (boxPicked(wireBox(w), box, mode)) out.push({ kind: "wire", uuid: w.uuid, is_bus: w.is_bus, a: w.a, b: w.b });
  }
  // Point objects: enclosed and crossing agree on a point, so the mode does not enter here.
  for (const ji of candidates(idx, idx.junctions, box)) {
    const j = sheet.junctions[ji];
    if (pointInBox(j.at, box)) out.push({ kind: "junction", uuid: j.uuid, at: j.at });
  }
  for (const nc of sheet.no_connects ?? []) if (pointInBox(nc.at, box)) out.push({ kind: "no_connect", uuid: nc.uuid, at: nc.at });
  for (const code of candidates(idx, idx.sheetPins, box)) {
    const shi = Math.floor(code / PIN_STRIDE);
    const pi = code % PIN_STRIDE;
    if (pointInBox(sheet.sheets[shi].pins[pi].at, box)) out.push(sheetPinHit(sheet, shi, pi));
  }
  return out;
}

/** Reference implementation (full scan) of `regionHits`. */
export function regionHitsLinear(sheet: RenderSheet, box: Box, mode: RegionMode = "crossing"): Hit[] {
  const out: Hit[] = [];
  for (const s of sheet.symbols) {
    if (boxPicked(s.bbox, box, mode)) out.push({ kind: "symbol", reference: s.reference, uuid: s.uuid, value: s.value, lib_id: s.lib_id, bbox: s.bbox });
  }
  for (const l of sheet.labels) {
    if (boxPicked(l.bbox, box, mode)) out.push({ kind: "label", uuid: l.uuid, text: l.text, label_kind: l.kind, bbox: l.bbox });
  }
  for (const sh of sheet.sheets) {
    if (boxPicked(sh.bbox, box, mode)) out.push({ kind: "sheet", uuid: sh.uuid, name: sh.name, file: sh.file, bbox: sh.bbox });
  }
  for (const w of sheet.wires) {
    if (boxPicked(wireBox(w), box, mode)) out.push({ kind: "wire", uuid: w.uuid, is_bus: w.is_bus, a: w.a, b: w.b });
  }
  for (const j of sheet.junctions) {
    if (pointInBox(j.at, box)) out.push({ kind: "junction", uuid: j.uuid, at: j.at });
  }
  for (const nc of sheet.no_connects ?? []) if (pointInBox(nc.at, box)) out.push({ kind: "no_connect", uuid: nc.uuid, at: nc.at });
  for (let shi = 0; shi < sheet.sheets.length; shi++) {
    const pins = sheet.sheets[shi].pins;
    for (let pi = 0; pi < pins.length; pi++) if (pointInBox(pins[pi].at, box)) out.push(sheetPinHit(sheet, shi, pi));
  }
  return out;
}

function normalizeBox(b: Box): Box {
  return [[Math.min(b[0][0], b[1][0]), Math.min(b[0][1], b[1][1])], [Math.max(b[0][0], b[1][0]), Math.max(b[0][1], b[1][1])]];
}

/** Convert hits to chat refs. Wires become their net only when the caller knows it (via `netOfWire`). */
export function hitsToRefs(sheet: RenderSheet, hits: Hit[], netOfWire?: (uuid: string) => string | null): Ref[] {
  const refs: Ref[] = [];
  const seen = new Set<string>();
  const push = (key: string, r: Ref) => {
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(r);
    }
  };
  for (const h of hits) {
    switch (h.kind) {
      case "symbol":
      case "pin":
        push(`c:${h.reference}`, { kind: "component", ref: h.reference, sheet: sheet.sheet_path });
        break;
      case "label":
        if (h.label_kind !== "netclass") push(`n:${h.text}`, { kind: "net", name: h.text });
        break;
      case "wire": {
        const net = netOfWire?.(h.uuid) ?? null;
        if (net) push(`n:${net}`, { kind: "net", name: net });
        break;
      }
      case "sheet":
        push(`s:${h.file}`, { kind: "sheet", path: joinSheetPath(sheet.sheet_path, h.name) });
        break;
      case "sheet_pin":
        push(`s:${h.sheet_file}`, { kind: "sheet", path: joinSheetPath(sheet.sheet_path, h.sheet_name) });
        break;
      case "junction":
      case "no_connect":
        break;
    }
  }
  return refs;
}

export function joinSheetPath(parent: string, name: string): string {
  const base = parent.endsWith("/") ? parent : parent + "/";
  return `${base}${name}/`;
}

/**
 * Region selection: hits the band picks up plus a `region` ref covering the band itself.
 * `band` is the drag as made (start corner first); its direction chooses enclosed vs crossing.
 */
export function regionToRefs(sheet: RenderSheet, band: Box, netOfWire?: (uuid: string) => string | null, mode: RegionMode = regionMode(band)): Ref[] {
  const box = normalizeBox(band);
  const hits = regionHits(sheet, box, mode);
  // A sheet pin sits on its sheet symbol's border, and on its own it stands for the pin, not for the
  // child sheet: a band drawn around one pin must not select the whole sheet the human never enclosed.
  // The sheet joins the selection only when its own box was picked (in crossing mode a band that
  // catches a pin already crosses that box, so this changes nothing there).
  const picked = new Set(hits.filter((h): h is Extract<Hit, { kind: "sheet" }> => h.kind === "sheet").map((h) => h.uuid));
  const refs = hitsToRefs(sheet, hits.filter((h) => h.kind !== "sheet_pin" || picked.has(h.sheet_uuid)), netOfWire);
  refs.push({ kind: "region", sheet: sheet.sheet_path, bbox_mil: [[round1(box[0][0]), round1(box[0][1])], [round1(box[1][0]), round1(box[1][1])]] });
  return refs;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Resolve refs back to world boxes (for highlight / zoom-to). */
export function refBoxes(sheet: RenderSheet, refs: Ref[]): Box[] {
  const out: Box[] = [];
  const idx = sheetIndex(sheet);
  for (const r of refs) {
    switch (r.kind) {
      case "component":
        for (const b of idx.byReference.get(r.ref) ?? []) out.push(b);
        break;
      case "net":
        for (const b of idx.byNet.get(r.name) ?? []) out.push(b);
        break;
      case "sheet":
        for (const b of idx.bySheetPath.get(r.path) ?? []) out.push(b);
        break;
      case "region":
        if (r.sheet === sheet.sheet_path) out.push(r.bbox_mil);
        break;
      case "block":
        // Blocks are groups of components; the harness resolves membership. Nothing to draw here.
        break;
      case "finding":
      case "turn":
      case "attachment":
        break;
    }
  }
  return out;
}
