// SPDX-License-Identifier: Apache-2.0
// Agent presence on the canvas: where the agent is looking (an orb that glides
// to `attention` targets, a dashed working region) and staged reveal of the
// objects an apply created. Pure helpers here; drawing in `drawOrb`.

import type { Ref } from "../agent/api";
import { refBoxes } from "./hittest";
import type { Box, Mil, RenderSheet } from "./types";
import { withAlpha } from "./highlight";
import { worldToScreen, type ViewState } from "./viewport";

export const ORB_GLIDE_MS = 350;
export const ORB_LINGER_MS = 1500;
export const REVEAL_STEP_MS = 70;
export const REVEAL_MAX_MS = 3000;
export const REVEAL_POP_MS = 260;

export interface AttentionInput {
  label: string;
  refs?: Ref[];
  region_mil?: Box;
  sheet?: string;
}

export interface AttentionTarget {
  at: Mil;
  /** Region rectangle (drafter's working area) when the attention carries one. */
  region?: Box;
  label: string;
}

export function boxCentre(b: Box): Mil {
  return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
}

/** Resolve what the agent is looking at to a world-space point (+ region). */
export function attentionTarget(sheet: RenderSheet | null, a: AttentionInput): AttentionTarget | null {
  if (a.region_mil) {
    const b = a.region_mil;
    return { at: boxCentre(b), region: b, label: a.label };
  }
  if (!sheet || !a.refs?.length) return null;
  for (const r of a.refs) {
    if (r.kind === "net") {
      const label = sheet.labels.find((l) => l.text === r.name);
      if (label) return { at: label.at, label: a.label };
      for (const s of sheet.symbols) {
        if (s.is_power && s.value === r.name) return { at: boxCentre(s.bbox), label: a.label };
        const pin = s.pins.find((p) => p.name === r.name);
        if (pin) return { at: pin.at, label: a.label };
      }
      continue;
    }
    const boxes = refBoxes(sheet, [r]);
    if (boxes.length) return { at: boxCentre(boxes[0]), label: a.label };
  }
  return null;
}

export function easeOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - (1 - x) * (1 - x) * (1 - x);
}

export interface OrbAnim { from: Mil; to: Mil; start: number }

/** Position of the orb at `now` along its glide. */
export function orbPosition(anim: OrbAnim, now: number, durationMs = ORB_GLIDE_MS): Mil {
  const t = durationMs <= 0 ? 1 : easeOut((now - anim.start) / durationMs);
  return [anim.from[0] + (anim.to[0] - anim.from[0]) * t, anim.from[1] + (anim.to[1] - anim.from[1]) * t];
}

export function orbSettled(anim: OrbAnim, now: number, durationMs = ORB_GLIDE_MS): boolean {
  return durationMs <= 0 || now - anim.start >= durationMs;
}

// ---------------------------------------------------------------- reveal

export interface CreatedObject { uuid: string; kind: string }

/**
 * Delay (ms) at which each created object appears: `step` apart in op order,
 * compressed so the whole reveal never exceeds `maxMs`.
 */
export function revealSchedule(created: CreatedObject[], stepMs = REVEAL_STEP_MS, maxMs = REVEAL_MAX_MS): Map<string, number> {
  const out = new Map<string, number>();
  const n = created.length;
  if (!n) return out;
  const step = Math.min(stepMs, n > 1 ? maxMs / (n - 1) : stepMs);
  created.forEach((c, i) => { if (!out.has(c.uuid)) out.set(c.uuid, Math.round(i * step)); });
  return out;
}

/** 0 → not yet, (0,1) → popping in, 1 → fully drawn. */
export function revealAlpha(delayMs: number, start: number, now: number, popMs = REVEAL_POP_MS): number {
  const t = now - start - delayMs;
  if (t < 0) return 0;
  if (popMs <= 0 || t >= popMs) return 1;
  return easeOut(t / popMs);
}

export function revealDone(schedule: Map<string, number>, start: number, now: number, popMs = REVEAL_POP_MS): boolean {
  let last = 0;
  for (const d of schedule.values()) last = Math.max(last, d);
  return now - start >= last + popMs;
}

export interface SheetObject { box: Box; kind: string }

/** Every addressable object of a sheet by uuid (for reveal matching and orb hops). */
const objectsCache = new WeakMap<RenderSheet, Map<string, SheetObject>>();

/**
 * What a ghost preview should draw: every preview object that is new or whose box moved (moves, rotations,
 * re-wires keep the uuid, so "already on disk" is not enough), plus the on-disk objects the preview removes
 * (drawn as outlines). `skip` = uuids unchanged between the two sheets.
 */
export function ghostDiff(onDisk: RenderSheet, preview: RenderSheet, tolMil = 1): { skip: Set<string>; removed: SheetObject[] } {
  const a = objectsByUuid(onDisk);
  const b = objectsByUuid(preview);
  const same = (x: Box, y: Box) => Math.abs(x[0][0] - y[0][0]) <= tolMil && Math.abs(x[0][1] - y[0][1]) <= tolMil && Math.abs(x[1][0] - y[1][0]) <= tolMil && Math.abs(x[1][1] - y[1][1]) <= tolMil;
  const skip = new Set<string>();
  for (const [uuid, o] of a) { const p = b.get(uuid); if (p && p.kind === o.kind && same(p.box, o.box)) skip.add(uuid); }
  const removed: SheetObject[] = [];
  for (const [uuid, o] of a) if (!b.has(uuid)) removed.push(o);
  return { skip, removed };
}

export function objectsByUuid(sheet: RenderSheet): Map<string, SheetObject> {
  const hit = objectsCache.get(sheet);
  if (hit) return hit;
  const m = new Map<string, SheetObject>();
  objectsCache.set(sheet, m);
  const seg = (a: Mil, b: Mil): Box => [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
  const pt = (p: Mil, r = 25): Box => [[p[0] - r, p[1] - r], [p[0] + r, p[1] + r]];
  for (const s of sheet.symbols) m.set(s.uuid, { box: s.bbox, kind: s.is_power ? "power_port" : "symbol" });
  for (const w of sheet.wires) m.set(w.uuid, { box: seg(w.a, w.b), kind: w.is_bus ? "bus" : "wire" });
  for (const e of sheet.bus_entries) m.set(e.uuid, { box: seg(e.a, e.b), kind: "bus_entry" });
  for (const l of sheet.labels) m.set(l.uuid, { box: l.bbox, kind: "label" });
  for (const j of sheet.junctions) m.set(j.uuid, { box: pt(j.at, j.diameter_mil), kind: "junction" });
  for (const n of sheet.no_connects) m.set(n.uuid, { box: pt(n.at), kind: "no_connect" });
  for (const sh of sheet.sheets) m.set(sh.uuid, { box: sh.bbox, kind: "sheet" });
  for (const tb of sheet.text_boxes) m.set(tb.uuid, { box: seg(tb.a, tb.b), kind: "text_box" });
  return m;
}

/** Copy of the sheet without the objects whose uuid is in `hidden` (not yet revealed). */
export function revealSheet(sheet: RenderSheet, hidden: Set<string>): RenderSheet {
  if (!hidden.size) return sheet;
  const keep = <T extends { uuid: string }>(xs: T[]) => xs.filter((x) => !hidden.has(x.uuid));
  return {
    ...sheet,
    symbols: keep(sheet.symbols),
    wires: keep(sheet.wires),
    bus_entries: keep(sheet.bus_entries),
    labels: keep(sheet.labels),
    junctions: keep(sheet.junctions),
    no_connects: keep(sheet.no_connects),
    sheets: keep(sheet.sheets),
    text_boxes: keep(sheet.text_boxes),
  };
}

/** Uuids whose reveal has not started at `now`. */
export function hiddenAt(schedule: Map<string, number>, start: number, now: number): Set<string> {
  const out = new Set<string>();
  for (const [uuid, delay] of schedule) if (now - start < delay) out.add(uuid);
  return out;
}

/** The most recently revealed object (for the orb to hop to), or null. */
export function latestRevealed(schedule: Map<string, number>, start: number, now: number): string | null {
  let best: string | null = null;
  let bestDelay = -1;
  for (const [uuid, delay] of schedule) if (now - start >= delay && delay > bestDelay) { best = uuid; bestDelay = delay; }
  return best;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---------------------------------------------------------------- drawing

export interface OrbDraw {
  at: Mil;
  /** 0..1 pulse phase (idle breathing). */
  pulse: number;
  /** 0..1 overall opacity (linger fade). */
  alpha: number;
  label?: string;
  region?: Box;
  regionAlpha?: number;
}

/** Monochrome presence marker: soft ring + dot, caption below; fillText only. */
export function drawOrb(ctx: CanvasRenderingContext2D, v: ViewState, o: OrbDraw, tokens: Record<string, string>, font: string): void {
  if (o.alpha <= 0) return;
  const ink = tokens["--fs-canvas-changed"];
  const soft = tokens["--fs-canvas-focus"];
  if (o.region) {
    const a = worldToScreen(v, o.region[0]);
    const b = worldToScreen(v, o.region[1]);
    const ra = (o.regionAlpha ?? 1) * o.alpha;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(soft, 0.9 * ra);
    ctx.fillStyle = withAlpha(soft, 0.05 * ra);
    ctx.beginPath();
    ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    ctx.fill();
    ctx.stroke();
    if (o.label) {
      ctx.setLineDash([]);
      ctx.font = `11px ${font}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = withAlpha(ink, 0.85 * ra);
      ctx.fillText(o.label, Math.min(a[0], b[0]) + 4, Math.min(a[1], b[1]) - 4);
    }
    ctx.restore();
  }
  const p = worldToScreen(v, o.at);
  const r = 7 + 2 * Math.sin(o.pulse * Math.PI * 2);
  ctx.save();
  ctx.beginPath();
  ctx.arc(p[0], p[1], r + 6, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(soft, 0.16 * o.alpha);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = withAlpha(ink, 0.9 * o.alpha);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(ink, o.alpha);
  ctx.fill();
  if (o.label && !o.region) {
    ctx.font = `11px ${font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = withAlpha(ink, 0.85 * o.alpha);
    ctx.fillText(o.label, p[0], p[1] + r + 8);
  }
  ctx.restore();
}
