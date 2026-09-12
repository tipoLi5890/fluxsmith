// SPDX-License-Identifier: Apache-2.0
// OQ-17: "don't ask again for this condition in this session". A remembered hard-stop
// condition lets the harness auto-approve the *same* condition later in the same
// conversation session; the record lives only in this webview (localStorage) and never
// widens the plan envelope or the Rust-side ceilings — it only skips the card.
//
// Harness hook (lead.ts, before showing a hard-stop card):
//   if (isRemembered(this.d.sessionId, condition)) { /* treat as approved */ }

const KEY = "fs.rememberedConditions";
/** Conditions that may be remembered; environment/budget class stops always ask. */
/** scope_widen / structural / net_risk need a grant (and a reason) every time: remembering them would let the call proceed without one. */
export const REMEMBERABLE = new Set(["interface", "unresolved"]);

function load(): Record<string, string[]> {
  try {
    if (typeof localStorage === "undefined") return {};
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as Record<string, string[]>) : {};
  } catch { return {}; }
}
function save(all: Record<string, string[]>): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

export function rememberCondition(sessionId: string, condition: string): void {
  if (!sessionId || !REMEMBERABLE.has(condition)) return;
  const all = load();
  const set = new Set(all[sessionId] ?? []);
  set.add(condition);
  all[sessionId] = [...set];
  save(all);
}

export function forgetCondition(sessionId: string, condition?: string): void {
  const all = load();
  if (!condition) delete all[sessionId];
  else all[sessionId] = (all[sessionId] ?? []).filter((c) => c !== condition);
  save(all);
}

export function isRemembered(sessionId: string | null | undefined, condition: string): boolean {
  if (!sessionId) return false;
  return (load()[sessionId] ?? []).includes(condition);
}

export function rememberedConditions(sessionId: string | null | undefined): string[] {
  return sessionId ? [...(load()[sessionId] ?? [])] : [];
}
