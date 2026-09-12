// SPDX-License-Identifier: Apache-2.0
// Finding markers on the canvas: anchored at a pin (`R1.3`), at a symbol's top-right corner
// (`R1`), or nowhere (sheet-level findings are listed in the sidebar only). Nearby markers
// cluster into one with a count. Glyphs are drawn paths (Lucide-like circle-x / triangle-alert
// / info), the count is the only text and goes through `fillText`.

import type { FindingRow } from "../agent/api";
import type { Mil, RenderSheet } from "./types";
import type { ViewState } from "./viewport";
import { sheetIndex } from "./sheet-index";

export type MarkerSeverity = "error" | "warning" | "info";

export interface Marker {
  at: Mil;
  severity: MarkerSeverity;
  /** Findings clustered into this marker (worst severity wins the glyph). */
  findings: FindingRow[];
}

/** Screen-constant glyph size in CSS px. */
export const MARKER_PX = 14;
/** Markers closer than this many CSS px collapse into one. */
const CLUSTER_PX = 10;

export function severityOf(f: FindingRow): MarkerSeverity {
  const s = f.severity.toLowerCase();
  return s === "error" ? "error" : s === "warning" ? "warning" : "info";
}

const RANK: Record<MarkerSeverity, number> = { error: 3, warning: 2, info: 1 };

/** Anchor for one finding on this sheet: the first ref that resolves (pin tip, else symbol corner). */
const symbolByRefCache = new WeakMap<RenderSheet, Map<string, RenderSheet["symbols"][number]>>();
function symbolByRef(sheet: RenderSheet, ref: string): RenderSheet["symbols"][number] | undefined {
  let m = symbolByRefCache.get(sheet);
  if (!m) { m = new Map(); for (const s of sheet.symbols) if (!m.has(s.reference)) m.set(s.reference, s); symbolByRefCache.set(sheet, m); }
  return m.get(ref);
}

export function markerAnchor(sheet: RenderSheet, f: FindingRow): Mil | null {
  const idx = sheetIndex(sheet);
  for (const r of f.refs ?? []) {
    const dot = r.indexOf(".");
    const ref = dot > 0 ? r.slice(0, dot) : r;
    const pinNo = dot > 0 ? r.slice(dot + 1) : null;
    if (pinNo) {
      // Multi-unit parts: the pin lives on one of several symbols sharing the reference (U1A / U1B).
      let pin = symbolByRef(sheet, ref)?.pins.find((p) => p.number === pinNo);
      if (!pin) for (const sym of sheet.symbols) { if (sym.reference !== ref) continue; pin = sym.pins.find((p) => p.number === pinNo); if (pin) break; }
      if (pin) return pin.at;
    }
    const boxes = idx.byReference.get(ref);
    if (boxes && boxes.length) return [boxes[0][1][0], boxes[0][0][1]];
  }
  // No ref resolved (a label, wire or text finding): the engine's own anchor.
  const at = (f as { at_mil?: unknown }).at_mil;
  if (Array.isArray(at) && at.length === 2 && at.every((v) => typeof v === "number")) return [at[0] as number, at[1] as number];
  return null;
}

/**
 * Does a sheet identifier written by the harness (`plan.sheets[].file`, an instance uuid path, or a
 * names path) name the sheet identified by any of `sheetIds` (file, instance path, names)?
 */
export function sheetIdMatches(id: string | null | undefined, sheetIds: readonly string[]): boolean {
  if (!id) return false;
  const trim = (x: string) => x.replace(/^\/+|\/+$/g, "");
  const a = trim(id);
  if (!a) return sheetIds.some((s) => trim(s) === "");
  return sheetIds.some((s) => { const b = trim(s); return b === a || b.endsWith(`/${a}`) || a.endsWith(`/${b}`); });
}

/** Does `f` belong to the sheet identified by any of `sheetIds` (file, instance path, names)? */
export function onSheet(f: FindingRow, sheetIds: readonly string[]): boolean {
  const fs = f.sheet;
  if (!fs) return true;
  return sheetIdMatches(fs, sheetIds);
}

/** Markers for the unresolved findings of this sheet, clustered at the current zoom. */
export function findingMarkers(sheet: RenderSheet, findings: readonly FindingRow[], scale: number, sheetIds: readonly string[] = [sheet.file, sheet.sheet_path]): Marker[] {
  const out: Marker[] = [];
  const clusterMil = CLUSTER_PX / Math.max(scale, 1e-6);
  for (const f of findings) {
    if (f.resolved || !onSheet(f, sheetIds)) continue;
    const at = markerAnchor(sheet, f);
    if (!at) continue;
    const near = out.find((m) => Math.abs(m.at[0] - at[0]) <= clusterMil && Math.abs(m.at[1] - at[1]) <= clusterMil);
    const sev = severityOf(f);
    if (near) {
      near.findings.push(f);
      if (RANK[sev] > RANK[near.severity]) near.severity = sev;
    } else out.push({ at, severity: sev, findings: [f] });
  }
  return out;
}

/** The marker under a screen point (glyph hit radius), or null. */
export function markerAt(markers: readonly Marker[], v: ViewState, screen: Mil): Marker | null {
  const r = MARKER_PX * 0.75;
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i];
    const [sx, sy] = markerScreen(m, v);
    if (Math.abs(sx - screen[0]) <= r && Math.abs(sy - screen[1]) <= r) return m;
  }
  return null;
}

/** Glyph centre: offset up-right from the anchor so the pin / corner stays visible. */
export function markerScreen(m: Marker, v: ViewState): Mil {
  return [(m.at[0] - v.x) * v.scale + MARKER_PX * 0.6, (m.at[1] - v.y) * v.scale - MARKER_PX * 0.6];
}

function tokenFor(sev: MarkerSeverity, tokens: Record<string, string>): string {
  return tokens[`--fs-canvas-finding-${sev}`] ?? tokens["--fs-canvas-finding"];
}

/** Draw every marker; `font` is used for cluster counts only. */
export function drawMarkers(ctx: CanvasRenderingContext2D, v: ViewState, markers: readonly Marker[], tokens: Record<string, string>, font: string, paper: string, current?: (f: FindingRow) => boolean): void {
  const half = MARKER_PX / 2;
  for (const m of markers) {
    const [cx, cy] = markerScreen(m, v);
    const color = tokenFor(m.severity, tokens);
    ctx.save();
    if (current && m.findings.some(current)) {
      // Ring around the marker the user is on (`N` / `Shift+N`, sidebar row) so it stands out of a cluster.
      ctx.beginPath();
      ctx.arc(cx, cy, half + 4, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = tokens["--fs-canvas-selection"] ?? color;
      ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.lineWidth = 1.75;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;
    ctx.fillStyle = paper;
    ctx.setLineDash([]);
    if (m.severity === "warning") {
      // triangle-alert: triangle, bar, dot
      ctx.beginPath();
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + half, cy + half * 0.85);
      ctx.lineTo(cx - half, cy + half * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - half * 0.35);
      ctx.lineTo(cx, cy + half * 0.2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy + half * 0.55, 0.9, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (m.severity === "error") {
        // circle-x
        const d = half * 0.45;
        ctx.beginPath();
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
        ctx.stroke();
      } else {
        // info: i-bar + dot
        ctx.beginPath();
        ctx.moveTo(cx, cy - half * 0.05);
        ctx.lineTo(cx, cy + half * 0.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy - half * 0.45, 0.9, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    if (m.findings.length > 1) {
      ctx.font = `bold 9px ${font}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = color;
      ctx.fillText(String(m.findings.length), cx + half + 1, cy - half * 0.4);
    }
    ctx.restore();
  }
}
