// SPDX-License-Identifier: Apache-2.0
// Sheet thumbnails for the sidebar: rendered from engine geometry (`render` request) with
// the same draw commands as the canvas, cached as data URLs in a small LRU keyed by
// (project, sheet, revision). Bounded so many tabs / many sheets never pin memory.
import { drawCommands, paint, readTokens } from "../canvas/renderer";
import { contentBox } from "../canvas/commands";
import { fitBox } from "../canvas/viewport";
import type { RenderSheet } from "../canvas/types";
import { isTauri } from "../ipc/client";
import { fetchRenderSheet } from "../canvas/sheet-cache";

export const THUMB_LRU_MAX = 24;
export const THUMB_W = 96;
export const THUMB_H = 64;

/** Minimal insertion-ordered LRU (Map keeps insertion order; re-set moves to the end). */
export class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
    return v;
  }
  set(k: string, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) { const first = this.m.keys().next().value; if (first === undefined) break; this.m.delete(first); }
  }
  has(k: string): boolean { return this.m.has(k); }
  get size(): number { return this.m.size; }
  clear(): void { this.m.clear(); }
}

const cache = new Lru<string>(THUMB_LRU_MAX);
const inflight = new Map<string, Promise<string | null>>();

export function thumbKey(projectKey: string, sheet: string, revision: number): string { return `${projectKey}|${sheet}|${revision}`; }

/** Draws a RenderSheet into a small canvas and returns a PNG data URL (null when nothing to draw). */
export function renderThumb(rs: RenderSheet, theme: "light" | "dark", w = THUMB_W, h = THUMB_H): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const dpr = Math.min(2, (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) || 1);
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const tokens = readTokens(document.documentElement, theme);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = tokens["--fs-canvas-paper"] ?? "";
  ctx.fillRect(0, 0, w, h);
  const cmds = drawCommands(rs, { showHidden: false, frame: false });
  if (!cmds.length) return null;
  const view = fitBox(contentBox(rs), w, h, 4);
  paint(ctx, cmds, view, { grid: false, tokens, skipText: true });
  try { return canvas.toDataURL("image/png"); } catch { return null; }
}

/** Cached thumbnail for a sheet; fetches geometry through the engine once per revision. */
export async function sheetThumb(projectKey: string, sheet: string, revision: number, theme: "light" | "dark"): Promise<string | null> {
  const key = thumbKey(projectKey, sheet, revision);
  const hit = cache.get(key);
  if (hit) return hit;
  if (!isTauri()) return null;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        // Shared with the canvas: the active sheet is fetched once, the rest hit the engine's cache.
        const rs = await fetchRenderSheet(projectKey, sheet, revision);
        const url = renderThumb(rs, theme);
        if (url) cache.set(key, url);
        return url;
      } catch { return null; } finally { inflight.delete(key); }
    })();
    inflight.set(key, p);
  }
  return p;
}

export function thumbCacheSize(): number { return cache.size; }
export function clearThumbs(): void { cache.clear(); }
