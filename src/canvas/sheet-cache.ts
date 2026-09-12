// SPDX-License-Identifier: Apache-2.0
// One shared fetch path for `RenderSheet` geometry: the canvas and the sidebar thumbnails ask
// here, so the active sheet is fetched and parsed once, in-flight requests are de-duplicated and
// a small LRU keeps recently shown sheets. Entries are dropped by `invalidateSheetCache`, which
// the canvas calls whenever the shell bumps its revision (fs change / apply / rollback).

import { call } from "../ipc/client";
import type { RenderSheet } from "./types";

export const SHEET_CACHE_MAX = 8;

interface Entry { promise: Promise<RenderSheet>; revision: number }

const entries = new Map<string, Entry>();

function key(projectKey: string, sheet: string): string {
  return `${projectKey}|${sheet}`;
}

function touch(k: string, e: Entry): void {
  entries.delete(k);
  entries.set(k, e);
  while (entries.size > SHEET_CACHE_MAX) {
    const first = entries.keys().next().value;
    if (first === undefined) break;
    entries.delete(first);
  }
}

/**
 * Geometry for `sheet`, fetched at most once per (project, sheet, revision). A higher
 * `revision` than the cached one refetches; a lower or equal one reuses the entry.
 */
export function fetchRenderSheet(projectKey: string, sheet: string, revision = 0): Promise<RenderSheet> {
  const k = key(projectKey, sheet);
  const hit = entries.get(k);
  if (hit && hit.revision >= revision) {
    touch(k, hit);
    return hit.promise;
  }
  const promise = (async () => {
    const res = await call("engine_request", { project_key: projectKey, request: { kind: "render", sheet }, auth: {} });
    if (!res.ok) throw new Error(res.error ? `${res.error.code}: ${res.error.message}` : "render failed");
    return res.data as RenderSheet;
  })();
  const e: Entry = { promise, revision };
  touch(k, e);
  // A failed fetch must not poison the cache.
  promise.catch(() => { if (entries.get(k) === e) entries.delete(k); });
  return promise;
}

/** Drop cached geometry (all projects, or one). */
export function invalidateSheetCache(projectKey?: string): void {
  if (projectKey === undefined) { entries.clear(); return; }
  for (const k of [...entries.keys()]) if (k.startsWith(`${projectKey}|`)) entries.delete(k);
}

export function sheetCacheSize(): number {
  return entries.size;
}
