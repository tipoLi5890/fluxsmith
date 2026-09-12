// SPDX-License-Identifier: Apache-2.0
// Per-role token / cost / cache accounting of a turn (message-stream-ux.md §1: the turn header and
// summary carry cost and hit ratio; operations-misc.md §7: the cost report aggregates per turn / role).
//
// Fed by the harness `usage` event (one per model call, emitted next to the `model_calls` row it
// records), so what the stream shows and what the cost report computes come from the same numbers.
// The hit ratio is the single formula of caching-strategy.md §6, also used by `model_call_summary`
// in Rust and by `scripts/golden-run.mjs`: cache_read / (input + cache_creation + cache_read).
//
// Pure: no React, no store. The bridge accumulates, StreamView renders.

import type { Role } from "../../agent/api";
import { fmtNumber, fmtUsd, type MessageKey, type Params, type UiLang } from "../../i18n";

export interface UsageTotals {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
  /** Billed cost of the calls that had a rate; `cost_known` says whether that covers every call. */
  cost_usd: number;
  /** Every call so far had a rate (built-in table or provider override): false = tokens only. */
  cost_known: boolean;
  calls: number;
}

/** The fields of the harness `usage` event this module needs (`cost_usd: null` = no rate for that call). */
export interface UsageEventLike {
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
  cost_usd: number | null;
}

export interface RoleUsage { role: Role; usage: UsageTotals }

export function emptyUsage(): UsageTotals {
  return { input: 0, cache_read: 0, cache_creation: 0, output: 0, cost_usd: 0, cost_known: true, calls: 0 };
}

/** Fold one model call into a running total (immutable: returns a new object). */
export function addUsage(u: UsageTotals | undefined, e: UsageEventLike): UsageTotals {
  const base = u ?? emptyUsage();
  return {
    input: base.input + e.input,
    cache_read: base.cache_read + e.cache_read,
    cache_creation: base.cache_creation + e.cache_creation,
    output: base.output + e.output,
    cost_usd: base.cost_usd + (e.cost_usd ?? 0),
    cost_known: base.cost_known && e.cost_usd !== null,
    calls: base.calls + 1,
  };
}

export function sumUsage(list: UsageTotals[]): UsageTotals {
  return list.reduce<UsageTotals>((a, u) => ({
    input: a.input + u.input,
    cache_read: a.cache_read + u.cache_read,
    cache_creation: a.cache_creation + u.cache_creation,
    output: a.output + u.output,
    cost_usd: a.cost_usd + u.cost_usd,
    cost_known: a.cost_known && u.cost_known,
    calls: a.calls + u.calls,
  }), emptyUsage());
}

/** Billed tokens: uncached input + cache write + cache read + output (budget.ts `billedTokens`). */
export function usageTokens(u: UsageTotals): number {
  return u.input + u.cache_read + u.cache_creation + u.output;
}

/** caching-strategy.md §6; 0 when nothing was sent (never NaN). */
export function cacheHitRatio(u: UsageTotals): number {
  const denom = u.input + u.cache_creation + u.cache_read;
  return denom > 0 ? u.cache_read / denom : 0;
}

/** Roles of a turn, busiest first; ties break on the role id so the order never flickers. */
export function byRoleList(byRole: Partial<Record<Role, UsageTotals>>): RoleUsage[] {
  return (Object.entries(byRole) as [Role, UsageTotals][])
    .filter(([, u]) => u.calls > 0)
    .sort((a, b) => usageTokens(b[1]) - usageTokens(a[1]) || a[0].localeCompare(b[0]))
    .map(([role, usage]) => ({ role, usage }));
}

/** Locale-formatted token count; `compact` gives the "12.3k" form the stream lines use. */
export function fmtTokens(n: number, lang: UiLang, compact = false): string {
  if (compact && n >= 1000) return `${fmtNumber(n / 1000, lang, { maximumFractionDigits: 1 })}k`;
  return fmtNumber(Math.round(n), lang);
}

export interface UsageLineOpts {
  t: (key: MessageKey, params?: Params) => string;
  lang: UiLang;
  /** Budgets/cost display turned off in settings: tokens stay, the price goes. */
  showCost: boolean;
  /** Short "12.3k" tokens (phase lines) instead of the full number (turn footer). */
  compact?: boolean;
  /** Cache share; off for the fallback line of a restored turn, where only totals are known. */
  showCache?: boolean;
  /** Append "no price for this model" when a call had no rate (turn footer only). */
  note?: boolean;
}

/** One line: "12.3k tokens · $0.42 · cache 78%" — the parts the caller asked for, in that order. */
export function usageLine(u: UsageTotals, o: UsageLineOpts): string {
  const parts: string[] = [o.t("chat.usageTokens", { tokens: fmtTokens(usageTokens(u), o.lang, o.compact) })];
  if (o.showCost && u.cost_usd > 0) parts.push(fmtUsd(u.cost_usd, o.lang));
  if (o.showCache !== false) parts.push(o.t("chat.cacheHitShort", { pct: fmtNumber(Math.round(cacheHitRatio(u) * 100), o.lang) }));
  if (o.showCost && o.note && !u.cost_known) parts.push(o.t("chat.usageNoRates"));
  return parts.join(" · ");
}
