// SPDX-License-Identifier: Apache-2.0
// Pointer gesture state machine for the read-only canvas (pure, testable).
// Left-drag pans, Shift+drag rubber-bands, middle button / Alt / Space pan
// immediately; a drag that starts on a symbol shows the read-only hint once
// and then pans so the canvas never feels stuck. With `canvas.drag_selects`
// (eeschema reflex) a left drag on empty space rubber-bands instead.

import type { Mil } from "./types";

export type GestureMode = "pending" | "pan" | "band";

export interface GestureMods {
  shift?: boolean;
  alt?: boolean;
  space?: boolean;
  /**
   * `canvas.drag_selects`: a left drag that starts on empty space rubber-bands instead of
   * panning (the eeschema reflex). Panning then needs the middle button, Alt or Space.
   */
  dragSelects?: boolean;
}

export interface GestureState {
  mode: GestureMode;
  start: Mil;
  last: Mil;
  button: number;
  onSymbol: boolean;
  hinted: boolean;
}

export type MoveAction =
  | { kind: "none" }
  | { kind: "pan"; dx: number; dy: number; hint: boolean }
  | { kind: "band"; from: Mil; to: Mil };

export type UpAction = { kind: "click"; at: Mil } | { kind: "band"; from: Mil; to: Mil } | { kind: "none" };

export const DRAG_THRESHOLD_PX = 4;

/** Returns null for buttons the canvas does not handle (right button → context menu suppressed elsewhere). */
export function gestureDown(p: Mil, button: number, mods: GestureMods, onSymbol: boolean): GestureState | null {
  if (button !== 0 && button !== 1) return null;
  const immediatePan = button === 1 || !!mods.alt || !!mods.space;
  return { mode: immediatePan ? "pan" : "pending", start: p, last: p, button, onSymbol, hinted: false };
}

export function gestureMove(s: GestureState, p: Mil, mods: GestureMods): { state: GestureState; action: MoveAction } {
  let state = s;
  if (state.mode === "pending") {
    if (Math.hypot(p[0] - state.start[0], p[1] - state.start[1]) < DRAG_THRESHOLD_PX) return { state, action: { kind: "none" } };
    // Rubber-band a drag that started on empty space when Shift is held or when
    // `canvas.drag_selects` made selection the default; Shift still bands either way.
    // Middle button / Alt / Space never reach here (they start out as `pan`).
    const band = !state.onSymbol && (!!mods.shift || !!mods.dragSelects);
    state = { ...state, mode: band ? "band" : "pan" };
  }
  if (state.mode === "pan") {
    const hint = state.onSymbol && !state.hinted;
    const next = { ...state, last: p, hinted: true };
    return { state: next, action: { kind: "pan", dx: p[0] - state.last[0], dy: p[1] - state.last[1], hint } };
  }
  return { state: { ...state, last: p }, action: { kind: "band", from: state.start, to: p } };
}

export function gestureUp(s: GestureState, p: Mil): UpAction {
  if (s.mode === "pending") return { kind: "click", at: p };
  if (s.mode === "band") return { kind: "band", from: s.start, to: p };
  return { kind: "none" };
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type WheelAction = { kind: "zoom"; factor: number } | { kind: "pan"; dx: number; dy: number };

/** Zoom applied by one wheel detent (a mouse notch), with or without Ctrl held. */
export const WHEEL_STEP = 1.15;
/** |deltaY| in pixel mode at or above which the event is a mouse notch, not a trackpad gesture. */
export const DETENT_PX = 40;
/** Largest zoom one fine (trackpad pinch) event may apply, in either direction. */
export const PINCH_MAX = 1.3;

const stepZoom = (up: boolean): WheelAction => ({ kind: "zoom", factor: up ? WHEEL_STEP : 1 / WHEEL_STEP });

/**
 * Wheel classification: pinch (ctrl/meta) → zoom; any horizontal component or
 * small fractional deltas (trackpad two-finger scroll) → pan; a detented mouse
 * wheel (large integer steps) → zoom at the cursor.
 */
export function classifyWheel(w: WheelInput): WheelAction {
  if (w.ctrl || w.meta) {
    // Ctrl+wheel is both the trackpad pinch (fine fractional deltas) and a plain mouse wheel with
    // Ctrl held, which reports one notch as 100-120 px in pixel mode or as a line/page delta. The
    // exponential curve is calibrated for the pinch; a notch through it would zoom ~3x at once, so
    // a detent takes the same fixed step as an unmodified wheel and the curve keeps only the fine
    // deltas, clamped so no single pinch event can jump.
    if (w.deltaMode !== 0 || Math.abs(w.deltaY) >= DETENT_PX) return stepZoom(w.deltaY < 0);
    return { kind: "zoom", factor: Math.min(PINCH_MAX, Math.max(1 / PINCH_MAX, Math.exp(-w.deltaY * 0.01))) };
  }
  if (w.shift && w.deltaX === 0) return { kind: "pan", dx: -w.deltaY, dy: 0 };
  if (w.deltaMode !== 0) return stepZoom(w.deltaY < 0);
  const detented = w.deltaX === 0 && Math.abs(w.deltaY) >= DETENT_PX && Number.isInteger(w.deltaY);
  if (detented) return stepZoom(w.deltaY < 0);
  return { kind: "pan", dx: -w.deltaX, dy: -w.deltaY };
}
