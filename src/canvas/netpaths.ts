// SPDX-License-Identifier: Apache-2.0
// Geometry of one net on a sheet for the hover / sticky highlight. Membership comes only from
// the engine's `net_map` (wire / label / sheet-pin / junction / no-connect uuid -> net, "REF.PIN" -> net);
// nothing here re-derives connectivity from wire endpoints (red line 6/9: the canvas never judges).

import type { Ref } from "../agent/api";
import type { NetMapResult } from "../ipc/types";
import type { Box, Mil, RenderSheet } from "./types";
import type { ViewState } from "./viewport";

export interface NetGeometry {
  net: string;
  /** Wire / bus segments on the net. */
  segments: { a: Mil; b: Mil; is_bus: boolean }[];
  /** Pin tips on the net (symbol pins and sheet pins alike). */
  pins: Mil[];
  /** Label flag boxes on the net. */
  labelBoxes: Box[];
}

/** Per (sheet identity, map identity): net name -> geometry. Keyed by object identity, never by counts —
 *  a `rename_net` keeps every count and would otherwise be served the previous map's geometry. */
type PerSheet = WeakMap<NetMapResult, Map<string, NetGeometry>>;
const cache = new WeakMap<RenderSheet, PerSheet>();

/** Net name of a hit (pin `REF.PIN`, wire / label / junction / no-connect uuid) per the engine map; null when unknown. */
export function netOfHit(map: NetMapResult | null, hit: { kind: string; uuid?: string; reference?: string; number?: string } | null): string | null {
  if (!map || !hit) return null;
  if (hit.kind === "pin" && hit.reference && hit.number) return map.pins[`${hit.reference}.${hit.number}`] ?? null;
  if ((hit.kind === "wire" || hit.kind === "label") && hit.uuid) return map.wires[hit.uuid] ?? map.labels[hit.uuid] ?? null;
  if (hit.kind === "sheet_pin" && hit.uuid) return map.sheet_pins?.[hit.uuid] ?? null;
  // A junction / no-connect flag is on a net like anything else; the engine says which one, the canvas never guesses.
  if (hit.kind === "junction" && hit.uuid) return map.junctions?.[hit.uuid] ?? null;
  if (hit.kind === "no_connect" && hit.uuid) return map.no_connects?.[hit.uuid] ?? null;
  return null;
}

/** Net named by the current selection (a wire / label / net row selects a `net` ref); null when there is none. */
export function selectionNet(refs: readonly Ref[]): string | null {
  for (const r of refs) if (r.kind === "net") return r.name;
  return null;
}

/** Everything on `net` for this sheet, memoised per (sheet identity, map identity, net). */
export function netGeometry(sheet: RenderSheet, map: NetMapResult, net: string): NetGeometry {
  let per = cache.get(sheet);
  if (!per) { per = new WeakMap(); cache.set(sheet, per); }
  let byNet = per.get(map);
  if (!byNet) { byNet = new Map(); per.set(map, byNet); }
  const hit = byNet.get(net);
  if (hit) return hit;
  const geo: NetGeometry = { net, segments: [], pins: [], labelBoxes: [] };
  for (const w of sheet.wires) if (map.wires[w.uuid] === net) geo.segments.push({ a: w.a, b: w.b, is_bus: w.is_bus });
  for (const s of sheet.symbols) {
    for (const p of s.pins) {
      if (p.hide) continue;
      if (map.pins[`${s.reference}.${p.number}`] === net) geo.pins.push(p.at);
    }
  }
  for (const l of sheet.labels) if (map.labels[l.uuid] === net) geo.labelBoxes.push(l.bbox);
  // Sheet pins are ringed like symbol pins: without them a hierarchical net looks like it stops at the border.
  for (const sh of sheet.sheets) for (const p of sh.pins) if (map.sheet_pins?.[p.uuid] === net) geo.pins.push(p.at);
  byNet.set(net, geo);
  return geo;
}

/** Overlay stroke for a net: segments widened, pins ringed, label boxes outlined. Canvas API only. */
export function drawNetHighlight(ctx: CanvasRenderingContext2D, v: ViewState, geo: NetGeometry, color: string, alpha = 0.9): void {
  const s = v.scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash([]);
  for (const seg of geo.segments) {
    ctx.lineWidth = Math.max(3, (seg.is_bus ? 12 : 6) * s + 3);
    ctx.beginPath();
    ctx.moveTo((seg.a[0] - v.x) * s, (seg.a[1] - v.y) * s);
    ctx.lineTo((seg.b[0] - v.x) * s, (seg.b[1] - v.y) * s);
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  for (const p of geo.pins) {
    ctx.beginPath();
    ctx.arc((p[0] - v.x) * s, (p[1] - v.y) * s, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const b of geo.labelBoxes) {
    const x0 = (b[0][0] - v.x) * s, y0 = (b[0][1] - v.y) * s;
    const x1 = (b[1][0] - v.x) * s, y1 = (b[1][1] - v.y) * s;
    ctx.beginPath();
    ctx.rect(Math.min(x0, x1) - 2, Math.min(y0, y1) - 2, Math.abs(x1 - x0) + 4, Math.abs(y1 - y0) + 4);
    ctx.stroke();
  }
  ctx.restore();
}
