// SPDX-License-Identifier: Apache-2.0
// Budget accounting (agent-runtime.md §10, hook P6). Tokens are billed
// tokens: uncached input + cache write + cache read + output, all roles.

import type { BudgetDefaults, ProviderConfig } from "../ipc/types";

export interface UsageSample {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface BudgetLimits {
  tokens: number | null;
  usd: number | null;
  tool_calls: number | null;
  wall_ms: number | null;
}

export interface BudgetUsed {
  tokens: number;
  usd: number;
  tool_calls: number;
  wall_ms: number;
  apply_count: number;
}

export function emptyUsed(): BudgetUsed {
  return { tokens: 0, usd: 0, tool_calls: 0, wall_ms: 0, apply_count: 0 };
}

/** USD cost from a provider rate table (USD per 1M tokens: input, cache_write, cache_read, output). */
export function costUsd(rates: [number, number, number, number], u: UsageSample): number {
  return (u.input * rates[0] + u.cacheWrite * rates[1] + u.cacheRead * rates[2] + u.output * rates[3]) / 1_000_000;
}

export function billedTokens(u: UsageSample): number {
  return u.input + u.cacheWrite + u.cacheRead + u.output;
}

export function planLimits(d: BudgetDefaults): BudgetLimits {
  return { tokens: d.plan_tokens, usd: d.plan_usd, tool_calls: d.plan_tool_calls, wall_ms: d.plan_wall_min === null ? null : d.plan_wall_min * 60_000 };
}

export function turnLimits(d: BudgetDefaults): BudgetLimits {
  return { tokens: null, usd: null, tool_calls: d.turn_tool_calls, wall_ms: d.turn_wall_min === null ? null : d.turn_wall_min * 60_000 };
}

export class BudgetLedger {
  used: BudgetUsed = emptyUsed();
  private activeSince: number | null = null;

  constructor(public limits: BudgetLimits, public warnPct = 80) {}

  addUsage(u: UsageSample, rates: [number, number, number, number] | null): void {
    this.used.tokens += billedTokens(u);
    if (rates) this.used.usd += costUsd(rates, u);
  }
  addToolCall(): void { this.used.tool_calls += 1; }
  addApply(): void { this.used.apply_count += 1; }
  startActive(now: number): void { if (this.activeSince === null) this.activeSince = now; }
  stopActive(now: number): void {
    if (this.activeSince !== null) { this.used.wall_ms += now - this.activeSince; this.activeSince = null; }
  }

  /** Which limit is exhausted (checked at step boundaries only). */
  exhausted(): keyof BudgetLimits | null {
    const l = this.limits;
    if (l.tokens !== null && this.used.tokens >= l.tokens) return "tokens";
    if (l.usd !== null && this.used.usd >= l.usd) return "usd";
    if (l.tool_calls !== null && this.used.tool_calls >= l.tool_calls) return "tool_calls";
    if (l.wall_ms !== null && this.used.wall_ms >= l.wall_ms) return "wall_ms";
    return null;
  }

  /** Estimated need exceeds remaining → do not start the step. */
  canStart(estimate: Partial<BudgetUsed>): boolean {
    const l = this.limits;
    if (l.tokens !== null && this.used.tokens + (estimate.tokens ?? 0) > l.tokens) return false;
    if (l.usd !== null && this.used.usd + (estimate.usd ?? 0) > l.usd) return false;
    if (l.tool_calls !== null && this.used.tool_calls + (estimate.tool_calls ?? 0) > l.tool_calls) return false;
    return true;
  }

  warn(): boolean {
    const l = this.limits;
    const pct = this.warnPct / 100;
    return (l.tokens !== null && this.used.tokens >= l.tokens * pct) ||
      (l.usd !== null && this.used.usd >= l.usd * pct) ||
      (l.tool_calls !== null && this.used.tool_calls >= l.tool_calls * pct) ||
      (l.wall_ms !== null && this.used.wall_ms >= l.wall_ms * pct);
  }
}

/** Providers without rates cannot be used in Build (D-52). */
export function providerUsableForBuild(p: ProviderConfig): boolean {
  return p.enabled && (p.build_capable === "full" || p.build_capable === "degraded" || p.build_capable === "manual") && p.context_window >= 128_000;
}
