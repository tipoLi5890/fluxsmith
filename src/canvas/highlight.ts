// SPDX-License-Identifier: Apache-2.0
// Highlight layers: selection outline, agent focus (soft), created / changed (created is what the
// turn drew, changed is what it edited — two styles, never one), finding (persistent until
// cleared). Pure data + a draw helper.

import type { Ref } from "../agent/api";
import type { Box, RenderSheet } from "./types";
import { refBoxes } from "./hittest";
import { expandBox, worldToScreen, type ViewState } from "./viewport";

export type HighlightKind = "focus" | "created" | "changed" | "finding";
export interface Highlight {
  refs: Ref[];
  kind: HighlightKind;
  /** Set only on a `changed` highlight that fades (the search flash); without it the group stays until it is removed. */
  since?: number;
  /**
   * Objects addressed by uuid rather than by ref — what an apply created, which has no designator
   * of its own (a wire, a junction, a label). Resolved by the `uuidBox` the caller passes.
   */
  uuids?: string[];
}

/** Resolves an object uuid of the drawn sheet to its box; objects of other sheets resolve to null. */
export type UuidBox = (uuid: string) => Box | null;

export const CHANGE_FADE_MS = 4000;

export interface HighlightStyle {
  stroke: string;
  fill: string;
  lineWidth: number;
  dash: number[];
}

/** Colours are semantic tokens read by the renderer from CSS variables. */
export function highlightStyle(kind: HighlightKind | "selection", tokens: Record<string, string>, alpha = 1): HighlightStyle {
  switch (kind) {
    case "selection":
      return { stroke: tokens["--fs-canvas-selection"], fill: withAlpha(tokens["--fs-canvas-selection"], 0.08 * alpha), lineWidth: 1.5, dash: [] };
    case "focus":
      return { stroke: withAlpha(tokens["--fs-canvas-focus"], 0.9 * alpha), fill: withAlpha(tokens["--fs-canvas-focus"], 0.10 * alpha), lineWidth: 1, dash: [4, 3] };
    // Created and changed must be told apart at a glance: different token and a dashed outline,
    // so the difference survives a monochrome / colour-blind reading too.
    case "created":
      return { stroke: withAlpha(tokens["--fs-canvas-created"], alpha), fill: withAlpha(tokens["--fs-canvas-created"], 0.14 * alpha), lineWidth: 2, dash: [6, 3] };
    case "changed":
      return { stroke: withAlpha(tokens["--fs-canvas-changed"], alpha), fill: withAlpha(tokens["--fs-canvas-changed"], 0.14 * alpha), lineWidth: 2, dash: [] };
    case "finding":
      return { stroke: withAlpha(tokens["--fs-canvas-finding"], alpha), fill: withAlpha(tokens["--fs-canvas-finding"], 0.12 * alpha), lineWidth: 1.5, dash: [2, 2] };
  }
}

/** Opacity of a fading `changed` highlight at time `now`. */
export function changeAlpha(since: number | undefined, now: number): number {
  if (since === undefined) return 1;
  const t = (now - since) / CHANGE_FADE_MS;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t;
}

export function withAlpha(color: string, alpha: number): string {
  // Accept `#rgb`, `#rrggbb`, `rgb(...)`; anything else is returned as-is.
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color?.trim() ?? "");
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color?.trim() ?? "");
  if (rgb) {
    const parts = rgb[1].split(",").map((s) => s.trim()).slice(0, 3);
    return `rgba(${parts.join(",")},${alpha})`;
  }
  return color;
}

export interface HighlightBox { box: Box; style: HighlightStyle }

/** Resolve highlight refs to screen-space boxes to draw (expired ones dropped). */
export function highlightBoxes(sheet: RenderSheet, highlights: Highlight[], selection: Ref[], tokens: Record<string, string>, now: number, uuidBox?: UuidBox): HighlightBox[] {
  const out: HighlightBox[] = [];
  for (const h of highlights) {
    const alpha = h.kind === "changed" || h.kind === "created" ? changeAlpha(h.since, now) : 1;
    if (alpha <= 0) continue;
    const style = highlightStyle(h.kind, tokens, alpha);
    for (const box of refBoxes(sheet, h.refs)) out.push({ box: expandBox(box, 15), style });
    // Uuids of objects this sheet does not carry (another sheet of the same turn) resolve to null.
    if (h.uuids && uuidBox) for (const u of h.uuids) { const box = uuidBox(u); if (box) out.push({ box: expandBox(box, 15), style }); }
  }
  const sel = highlightStyle("selection", tokens);
  for (const box of refBoxes(sheet, selection)) out.push({ box: expandBox(box, 10), style: sel });
  return out;
}

export function drawHighlightBoxes(ctx: CanvasRenderingContext2D, v: ViewState, boxes: HighlightBox[]): void {
  for (const { box, style } of boxes) {
    const a = worldToScreen(v, box[0]);
    const b = worldToScreen(v, box[1]);
    ctx.save();
    ctx.setLineDash(style.dash);
    ctx.lineWidth = style.lineWidth;
    ctx.strokeStyle = style.stroke;
    ctx.fillStyle = style.fill;
    ctx.beginPath();
    ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/** True while any `changed` highlight is still fading (caller keeps animating). */
export function anyFading(highlights: Highlight[], now: number): boolean {
  return highlights.some((h) => h.kind === "changed" && changeAlpha(h.since, now) > 0 && h.since !== undefined);
}
