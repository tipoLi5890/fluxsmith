// SPDX-License-Identifier: Apache-2.0
// Follow-the-agent camera policy (FR-205): pure decisions so the rules are testable without a
// DOM. The human always wins: any manual pan / zoom pauses following for `FOLLOW_PAUSE_MS`.

import type { Box } from "./types";
import { boxVisible, expandBox, fitBox, type ViewState } from "./viewport";

/** How long a manual interaction keeps the camera from following (FR-205: 20 s). */
export const FOLLOW_PAUSE_MS = 20_000;
export const FOLLOW_MIN_MS = 200;
export const FOLLOW_MAX_MS = 600;
const MARGIN_MIL = 300;
const MARGIN_PX = 48;

export type FollowDecision =
  | { kind: "none"; reason: "paused" | "visible" | "already_animating" }
  | { kind: "animate"; target: ViewState; ms: number };

export interface FollowInput {
  view: ViewState;
  size: [number, number];
  /** World box the agent is pointing at. */
  target: Box;
  /** Timestamp until which following is paused (0 when not paused). */
  pausedUntil: number;
  now: number;
  /** Target of the animation currently running, if any. */
  animTo?: ViewState | null;
  reducedMotion?: boolean;
}

/** Does `box` fit on screen under `v`? (with the same slack the canvas uses) */
function fitsUnder(v: ViewState, w: number, h: number, box: Box): boolean {
  return boxVisible(v, w, h, box);
}

/**
 * Decide whether to move the camera towards `target`. No move while the user's pause is in
 * effect, while the box is already on screen, or while a running animation will already show it.
 * The zoom is kept when it already fits; otherwise the box is fitted with a margin.
 */
export function followDecision(i: FollowInput): FollowDecision {
  const [w, h] = i.size;
  if (i.pausedUntil > i.now) return { kind: "none", reason: "paused" };
  if (fitsUnder(i.view, w, h, i.target)) return { kind: "none", reason: "visible" };
  if (i.animTo && fitsUnder(i.animTo, w, h, i.target)) return { kind: "none", reason: "already_animating" };
  const target = fitBox(expandBox(i.target, MARGIN_MIL), w, h, MARGIN_PX);
  if (target.scale > i.view.scale) {
    const cx = (i.target[0][0] + i.target[1][0]) / 2;
    const cy = (i.target[0][1] + i.target[1][1]) / 2;
    target.scale = i.view.scale;
    target.x = cx - w / 2 / target.scale;
    target.y = cy - h / 2 / target.scale;
  }
  if (i.reducedMotion) return { kind: "animate", target, ms: 0 };
  // Duration grows with the on-screen distance the camera travels (200-600 ms).
  const dx = (target.x - i.view.x) * i.view.scale;
  const dy = (target.y - i.view.y) * i.view.scale;
  const dist = Math.hypot(dx, dy);
  const ms = Math.max(FOLLOW_MIN_MS, Math.min(FOLLOW_MAX_MS, FOLLOW_MIN_MS + dist * 0.5));
  return { kind: "animate", target, ms };
}

/** New pause deadline after a manual interaction at `now`. */
export function pauseUntil(now: number, ms = FOLLOW_PAUSE_MS): number {
  return now + ms;
}
