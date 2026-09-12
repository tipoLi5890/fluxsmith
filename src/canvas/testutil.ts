// SPDX-License-Identifier: Apache-2.0
// Test helpers for the canvas: a CanvasRenderingContext2D stand-in that counts every method
// call and records the strings handed to `fillText`. jsdom has no Canvas 2D, so `paint()` is
// exercised through this Proxy (any property read yields a callable; sets are recorded).

export interface CountingCtx {
  ctx: CanvasRenderingContext2D;
  /** Method name -> number of calls. */
  counts: Record<string, number>;
  /** Property name -> number of assignments (`ctx.font = ...`). */
  sets: Record<string, number>;
  /** Every method call in order (for ordering assertions). */
  calls: string[];
  /** Strings drawn through `fillText`, in order. */
  texts: string[];
}

export function countingCtx(): CountingCtx {
  const counts: Record<string, number> = {};
  const sets: Record<string, number> = {};
  const calls: string[] = [];
  const texts: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, prop) {
      const name = String(prop);
      if (name === "canvas") return undefined;
      return (...args: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + 1;
        calls.push(name);
        if (name === "fillText") texts.push(String(args[0]));
        // `createPattern` / `measureText` results are consumed by the renderer; return inert values.
        if (name === "measureText") return { width: 0 };
        return undefined;
      };
    },
    set(_t, prop) {
      const name = String(prop);
      sets[name] = (sets[name] ?? 0) + 1;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, counts, sets, calls, texts };
}

/** Sum of the given method counts (missing ones count as 0). */
export function sumCounts(counts: Record<string, number>, names: string[]): number {
  return names.reduce((n, k) => n + (counts[k] ?? 0), 0);
}
