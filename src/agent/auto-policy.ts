// SPDX-License-Identifier: Apache-2.0
// Auto policy adjudication table (agent-runtime.md §1b.1, D-55). Only active
// in Build; in Plan/Review, Auto behaves like Review. Budget, environment and
// exhausted provider retries always stop.

import { AUTO_MAX_CONSECUTIVE_SKIPS, AUTO_MAX_SKIP_RATIO } from "./limits";

export type HardStopCondition =
  | "scope_widen" | "net_risk_a" | "net_risk_b" | "structural" | "refdes_conflict" | "unresolved" | "budget"
  | "environment" | "symbol_not_found" | "interface" | "provider_retryable" | "provider_exhausted" | "ask_user" | "context_exhausted";

export type AutoAction =
  | "allowed_expected_merge" | "retried_refdes" | "retried_provider" | "default_answer" | "skipped"
  | "reverted_and_skipped" | "skipped_dependency" | "paused_auto" | "stop"
  /** Auto re-applied a block with layout checks relaxed instead of stopping the plan. */
  | "layout_relaxed"
  /** The human ticked "do not ask again for this condition" earlier in the session (OQ-17). */
  | "remembered";

export interface AutoDecision {
  step: string;
  condition: HardStopCondition;
  action: AutoAction;
  detail?: string;
}

export interface AutoInput {
  condition: HardStopCondition;
  step: string;
  mode: "plan" | "build" | "review";
  /** For ask_user: whether a default exists. */
  hasDefault?: boolean;
  /** For refdes_conflict: whether the injected-table retry already happened. */
  retried?: boolean;
  /** For provider_retryable: retries so far. */
  providerRetries?: number;
}

/** Pure decision: what Auto does for a hard-stop condition. `null` = not adjudicated (show a card). */
export function adjudicate(i: AutoInput): AutoDecision | null {
  if (i.mode !== "build") return null;
  const d = (action: AutoAction, detail?: string): AutoDecision => ({ step: i.step, condition: i.condition, action, detail });
  switch (i.condition) {
    case "net_risk_a": return d("allowed_expected_merge");
    case "refdes_conflict": return i.retried ? d("skipped", "refdes retry failed") : d("retried_refdes");
    case "provider_retryable": return (i.providerRetries ?? 0) < 3 ? d("retried_provider") : d("stop", "provider retries exhausted");
    case "ask_user": return i.hasDefault ? d("default_answer") : d("skipped", "no default");
    case "scope_widen":
    case "structural":
    case "interface":
    case "symbol_not_found":
    case "net_risk_b":
    case "unresolved":
      return d("reverted_and_skipped");
    case "budget":
    case "environment":
    case "provider_exhausted":
    case "context_exhausted":
      return d("stop");
  }
}

/** Tracks skips to decide when Auto must pause and degrade to Review. */
export class AutoSkipTracker {
  consecutive = 0;
  skipped = 0;
  constructor(public totalSteps: number) {}
  record(dec: AutoDecision): boolean {
    const isSkip = dec.action === "skipped" || dec.action === "reverted_and_skipped" || dec.action === "skipped_dependency";
    if (isSkip) { this.consecutive += 1; this.skipped += 1; } else if (dec.action !== "stop") this.consecutive = 0;
    return this.shouldPause();
  }
  shouldPause(): boolean {
    if (this.consecutive >= AUTO_MAX_CONSECUTIVE_SKIPS) return true;
    return this.totalSteps > 0 && this.skipped / this.totalSteps > AUTO_MAX_SKIP_RATIO;
  }
}

/** Transitive downstream steps of skipped steps get `skipped_dependency`. */
export function dependentSkips(steps: { id: string; depends_on?: string[] }[], skipped: Set<string>): string[] {
  const out = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of steps) {
      if (skipped.has(s.id) || out.has(s.id)) continue;
      if ((s.depends_on ?? []).some((d) => skipped.has(d) || out.has(d))) { out.add(s.id); changed = true; }
    }
  }
  return [...out];
}
