// SPDX-License-Identifier: Apache-2.0
// Deterministic designator renumbering for the P5 (lease) retry on the harness path:
// the Drafter used numbers outside its lease; instead of asking a model again, move
// the conflicting designators to the next free numbers everywhere in the op-list.

const REF_RE = /^([A-Za-z]+)(\d+)(\.\S+)?$/;

/** Designators named in a P5 message ("Designators U2, D2 are outside your lease..."). */
export function conflictsFromMessage(msg: string): string[] {
  const m = /Designators?\s+(.+?)\s+(?:are|is)\s+outside/i.exec(msg) ?? /designator conflict:\s*(.+)$/i.exec(msg);
  if (!m) return [];
  return m[1].split(/[,\s]+/).map((s) => s.trim()).filter((s) => REF_RE.test(s));
}

/** Map each conflicting designator to the next free number of its prefix (occupied ∪ already assigned). */
export function planRenumber(conflicts: string[], occupied: Record<string, number[]>, taken: Record<string, number[]> = {}): Record<string, string> {
  const used: Record<string, Set<number>> = {};
  const bump = (p: string, n: number) => { (used[p] ??= new Set()).add(n); };
  for (const [p, ns] of Object.entries(occupied)) for (const n of ns) bump(p, n);
  for (const [p, ns] of Object.entries(taken)) for (const n of ns) bump(p, n);
  const map: Record<string, string> = {};
  for (const c of conflicts) {
    const m = REF_RE.exec(c);
    if (!m) continue;
    const prefix = m[1];
    let n = Math.max(0, ...(used[prefix] ?? [])) + 1;
    while ((used[prefix] ?? new Set()).has(n)) n++;
    bump(prefix, n);
    map[`${prefix}${m[2]}`] = `${prefix}${n}`;
  }
  return map;
}

/** Rewrite every designator-looking string in the op-list per `map` (incl. `U2.3` pins and refdes_used). */
export function renumberOplist<T>(oplist: T, map: Record<string, string>): { oplist: T; changed: number } {
  let changed = 0;
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = REF_RE.exec(v);
      if (m) { const to = map[`${m[1]}${m[2]}`]; if (to) { changed++; return `${to}${m[3] ?? ""}`; } }
      return v;
    }
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object") { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = rewrite(x); return o; }
    return v;
  };
  return { oplist: rewrite(oplist) as T, changed };
}
