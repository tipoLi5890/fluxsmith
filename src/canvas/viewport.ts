// SPDX-License-Identifier: Apache-2.0
// Pure viewport math: world mil <-> screen CSS px, pan/zoom, fit, animation.

import type { Box, Mil } from "./types";

export interface ViewState {
  /** World mil at the screen origin (top-left of the canvas). */
  x: number;
  y: number;
  /** CSS px per mil. */
  scale: number;
}

export const MIN_SCALE = 0.002;
export const MAX_SCALE = 4;

export function worldToScreen(v: ViewState, p: Mil): Mil {
  return [(p[0] - v.x) * v.scale, (p[1] - v.y) * v.scale];
}

export function screenToWorld(v: ViewState, p: Mil): Mil {
  return [p[0] / v.scale + v.x, p[1] / v.scale + v.y];
}

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Zoom by `factor` keeping the world point under `anchor` (screen px) fixed. */
export function zoomAt(v: ViewState, anchor: Mil, factor: number): ViewState {
  const scale = clampScale(v.scale * factor);
  const before = screenToWorld(v, anchor);
  const nv = { ...v, scale };
  const after = screenToWorld(nv, anchor);
  return { x: nv.x + (before[0] - after[0]), y: nv.y + (before[1] - after[1]), scale };
}

export function pan(v: ViewState, dxPx: number, dyPx: number): ViewState {
  return { ...v, x: v.x - dxPx / v.scale, y: v.y - dyPx / v.scale };
}

/** View that shows `box` centred with `marginPx` around it in a `w`x`h` px canvas. */
export function fitBox(box: Box, w: number, h: number, marginPx = 24): ViewState {
  const bw = Math.max(1, box[1][0] - box[0][0]);
  const bh = Math.max(1, box[1][1] - box[0][1]);
  const scale = clampScale(Math.min((w - 2 * marginPx) / bw, (h - 2 * marginPx) / bh));
  const cx = (box[0][0] + box[1][0]) / 2;
  const cy = (box[0][1] + box[1][1]) / 2;
  return { x: cx - w / 2 / scale, y: cy - h / 2 / scale, scale };
}

export function visibleWorld(v: ViewState, w: number, h: number): Box {
  return [screenToWorld(v, [0, 0]), screenToWorld(v, [w, h])];
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a[0][0] <= b[1][0] && b[0][0] <= a[1][0] && a[0][1] <= b[1][1] && b[0][1] <= a[1][1];
}

export function boxUnion(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const out: Box = [[Infinity, Infinity], [-Infinity, -Infinity]];
  for (const b of boxes) {
    out[0][0] = Math.min(out[0][0], b[0][0]);
    out[0][1] = Math.min(out[0][1], b[0][1]);
    out[1][0] = Math.max(out[1][0], b[1][0]);
    out[1][1] = Math.max(out[1][1], b[1][1]);
  }
  return out;
}

export function expandBox(b: Box, by: number): Box {
  return [[b[0][0] - by, b[0][1] - by], [b[1][0] + by, b[1][1] + by]];
}

/** Ease-out interpolation between two views (t in [0,1]). */
export function lerpView(a: ViewState, b: ViewState, t: number): ViewState {
  const k = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  // Interpolate scale geometrically so zoom feels linear.
  const scale = a.scale * Math.pow(b.scale / a.scale, k);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, scale };
}

/** Is `box` fully visible with some slack? Used by `follow` to avoid needless moves. */
export function boxVisible(v: ViewState, w: number, h: number, box: Box, slackPx = 16): boolean {
  const [a, b] = [worldToScreen(v, box[0]), worldToScreen(v, box[1])];
  return a[0] >= slackPx && a[1] >= slackPx && b[0] <= w - slackPx && b[1] <= h - slackPx;
}

/** Grid pitch in mil that gives >= `minPx` between lines at this scale. */
export function gridPitch(scale: number, minPx = 12): number {
  const base = 50; // eeschema default grid
  let pitch = base;
  while (pitch * scale < minPx) pitch *= 2;
  return pitch;
}
