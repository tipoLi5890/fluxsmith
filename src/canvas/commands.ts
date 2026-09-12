// SPDX-License-Identifier: Apache-2.0
// Toolbar / shortcut commands for the canvas as pure view transitions.

import type { Ref } from "../agent/api";
import { refBoxes } from "./hittest";
import { MM_TO_MIL, type Box, type RenderSheet } from "./types";
import { boxUnion, expandBox, fitBox, zoomAt, type ViewState } from "./viewport";

export type CanvasCommandKind = "zoom_in" | "zoom_out" | "fit" | "focus_selection" | "focus_refs" | "search" | "resume_follow" | "cycle_next" | "cycle_prev";
export interface CanvasCommand {
  seq: number;
  kind: CanvasCommandKind;
  query?: string;
  /** `focus_refs`: what to frame, independent of the (possibly not yet committed) selection. */
  refs?: Ref[];
  /** `focus_refs`: an extra box to include (a finding marker's anchor, a region). */
  box?: Box;
}

/** Wrap `dir` steps around a list of `n` items from `cursor` (-1 = nothing current yet). */
export function nextCursor(cursor: number, dir: 1 | -1, n: number): number {
  if (n <= 0) return -1;
  if (cursor < 0) return dir > 0 ? 0 : n - 1;
  return ((cursor + dir) % n + n) % n;
}

export const ZOOM_STEP = 1.25;
export const FOCUS_MARGIN_MIL = 300;

/** What to fit: the drawn content, or the paper when the sheet is empty. */
/**
 * Union of the drawn bounds of every object command (those carrying a `uuid`; frame and
 * title block are left out), so a fit includes property texts and label flags that the
 * engine's symbol bbox does not cover. `null` when there is nothing drawn.
 */
export function objectBox(cmds: { uuid?: string }[], bounds: Float64Array): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < cmds.length; i++) {
    if (!cmds[i].uuid) continue;
    const o = i * 4;
    if (!Number.isFinite(bounds[o]) || !Number.isFinite(bounds[o + 2])) continue;
    if (bounds[o] < x0) x0 = bounds[o];
    if (bounds[o + 1] < y0) y0 = bounds[o + 1];
    if (bounds[o + 2] > x1) x1 = bounds[o + 2];
    if (bounds[o + 3] > y1) y1 = bounds[o + 3];
  }
  return x1 - x0 > 1 && y1 - y0 > 1 ? [[x0, y0], [x1, y1]] : null;
}

export function contentBox(sheet: RenderSheet, drawn?: Box | null): Box {
  if (drawn) return drawn;
  const b = sheet.bbox;
  const finite = b && b[0].every(Number.isFinite) && b[1].every(Number.isFinite);
  const nonDegenerate = finite && b[1][0] - b[0][0] > 1 && b[1][1] - b[0][1] > 1;
  if (nonDegenerate) return b;
  const [wmm, hmm] = sheet.paper_mm ?? [297, 210];
  return [[0, 0], [wmm * MM_TO_MIL, hmm * MM_TO_MIL]];
}

/** Case-insensitive search: exact reference, then value, then net/label text. */
export function findInSheet(sheet: RenderSheet, query: string): { box: Box; refs: Ref[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byRef = sheet.symbols.filter((s) => s.reference.toLowerCase() === q);
  if (byRef.length) return { box: boxUnion(byRef.map((s) => s.bbox))!, refs: byRef.map((s) => ({ kind: "component", ref: s.reference }) as Ref) };
  const byValue = sheet.symbols.filter((s) => !s.is_power && s.value.toLowerCase().includes(q));
  if (byValue.length) return { box: boxUnion(byValue.map((s) => s.bbox))!, refs: byValue.map((s) => ({ kind: "component", ref: s.reference }) as Ref) };
  const labels = sheet.labels.filter((l) => l.text.toLowerCase() === q || l.text.toLowerCase().includes(q));
  const power = sheet.symbols.filter((s) => s.is_power && s.value.toLowerCase() === q);
  const boxes = [...labels.map((l) => l.bbox), ...power.map((s) => s.bbox)];
  if (boxes.length) {
    const names = [...new Set([...labels.map((l) => l.text), ...power.map((s) => s.value)])];
    return { box: boxUnion(boxes)!, refs: names.map((n) => ({ kind: "net", name: n }) as Ref) };
  }
  const prefixRef = sheet.symbols.filter((s) => s.reference.toLowerCase().startsWith(q));
  if (prefixRef.length) return { box: boxUnion(prefixRef.map((s) => s.bbox))!, refs: prefixRef.map((s) => ({ kind: "component", ref: s.reference }) as Ref) };
  return null;
}

/** Every match of `query` as its own ref (reference exact, then value, then label / power net, then reference prefix). */
export function searchMatches(sheet: RenderSheet, query: string): Ref[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set<string>();
  const out: Ref[] = [];
  const push = (r: Ref) => { const k = JSON.stringify(r); if (!seen.has(k)) { seen.add(k); out.push(r); } };
  for (const s of sheet.symbols) if (s.reference.toLowerCase() === q) push({ kind: "component", ref: s.reference });
  for (const s of sheet.symbols) if (!s.is_power && s.value.toLowerCase().includes(q)) push({ kind: "component", ref: s.reference });
  for (const l of sheet.labels) if (l.text.toLowerCase().includes(q)) push({ kind: "net", name: l.text });
  for (const s of sheet.symbols) if (s.is_power && s.value.toLowerCase() === q) push({ kind: "net", name: s.value });
  for (const s of sheet.symbols) if (s.reference.toLowerCase().startsWith(q)) push({ kind: "component", ref: s.reference });
  return out;
}

export interface CommandContext {
  view: ViewState;
  w: number;
  h: number;
  sheet: RenderSheet | null;
  /** Drawn object bounds (see `objectBox`); preferred over the engine bbox for fits. */
  content?: Box | null;
  selection: Ref[];
}

export interface CommandResult {
  view: ViewState | null;
  animate: boolean;
  /** Box to flash briefly (search hit / focused selection). */
  flash: { box: Box; refs: Ref[] } | null;
}

export function runCommand(cmd: CanvasCommand, ctx: CommandContext): CommandResult {
  const centre: [number, number] = [ctx.w / 2, ctx.h / 2];
  switch (cmd.kind) {
    // Follow and candidate cycling are not view transitions: the view component answers them itself
    // (they need the follow clock and the stack of candidates under the last click).
    case "resume_follow":
    case "cycle_next":
    case "cycle_prev": return { view: null, animate: false, flash: null };
    case "zoom_in": return { view: zoomAt(ctx.view, centre, ZOOM_STEP), animate: false, flash: null };
    case "zoom_out": return { view: zoomAt(ctx.view, centre, 1 / ZOOM_STEP), animate: false, flash: null };
    case "fit": return ctx.sheet ? { view: fitBox(contentBox(ctx.sheet, ctx.content), ctx.w, ctx.h), animate: true, flash: null } : { view: null, animate: false, flash: null };
    case "focus_selection": {
      if (!ctx.sheet) return { view: null, animate: false, flash: null };
      const u = boxUnion(refBoxes(ctx.sheet, ctx.selection));
      // Nothing selected: fit the sheet. Something selected that has no box here (a marker-only finding, a net
      // with no label on this sheet): leave the view alone rather than zooming out to the whole sheet.
      if (!u) return ctx.selection.length ? { view: null, animate: false, flash: null } : { view: fitBox(contentBox(ctx.sheet, ctx.content), ctx.w, ctx.h), animate: true, flash: null };
      return { view: fitBox(expandBox(u, FOCUS_MARGIN_MIL), ctx.w, ctx.h, 48), animate: true, flash: { box: u, refs: ctx.selection } };
    }
    case "focus_refs": {
      if (!ctx.sheet) return { view: null, animate: false, flash: null };
      const refs = cmd.refs ?? [];
      const boxes = refBoxes(ctx.sheet, refs);
      if (cmd.box) boxes.push(cmd.box);
      const u = boxUnion(boxes);
      // Nothing resolvable on this sheet: leave the view alone rather than zooming out to the whole sheet.
      if (!u) return { view: null, animate: false, flash: null };
      return { view: fitBox(expandBox(u, FOCUS_MARGIN_MIL), ctx.w, ctx.h, 48), animate: true, flash: { box: u, refs } };
    }
    case "search": {
      if (!ctx.sheet || !cmd.query) return { view: null, animate: false, flash: null };
      const hit = findInSheet(ctx.sheet, cmd.query);
      if (!hit) return { view: null, animate: false, flash: null };
      // Never zoom in past a readable level for a single part; keep the user's zoom if it already fits.
      const target = fitBox(expandBox(hit.box, FOCUS_MARGIN_MIL), ctx.w, ctx.h, 48);
      if (target.scale > Math.max(ctx.view.scale, 0.15)) {
        target.scale = Math.max(ctx.view.scale, 0.15);
        const cx = (hit.box[0][0] + hit.box[1][0]) / 2;
        const cy = (hit.box[0][1] + hit.box[1][1]) / 2;
        target.x = cx - ctx.w / 2 / target.scale;
        target.y = cy - ctx.h / 2 / target.scale;
      }
      return { view: target, animate: true, flash: hit };
    }
  }
}
