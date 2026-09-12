// SPDX-License-Identifier: Apache-2.0
// Which findings the app is currently showing.
//
// The filter used to live inside the findings panel, so the canvas drew a marker for every
// unresolved row -- Info rows included -- and `N` / `Shift+N` walked them: a sheet littered with
// glyphs for `PAGE_UNDERUSED` while the panel showed the two Errors the human had filtered to. The
// state lives in the bridge instead, so the panel, the markers and the finding walk are one view.
//
// Severity is three independent toggles, not one choice: eeschema's ERC dialog opens with Errors
// and Warnings on and exclusions off, and an engineer reading a review wants both at once.

import type { FindingRow } from "../agent/api";
import { findingBucket, type FindingLike } from "../agent/findings";

export interface SeverityFilter { error: boolean; warning: boolean; info: boolean }
export type SeverityKey = keyof SeverityFilter;
export const SEVERITY_KEYS: readonly SeverityKey[] = ["error", "warning", "info"];

export interface FindingFilter {
  severities: SeverityFilter;
  /** A `FindingBucket` (`engine` / `kicad` / `model`) or `"all"`. */
  origin: string;
  /** A row's `sheet` string, or `"all"`. */
  sheet: string;
}

/** eeschema parity: Error and Warning on, Info off, nothing else narrowed. */
export const DEFAULT_FINDING_FILTER: FindingFilter = { severities: { error: true, warning: true, info: false }, origin: "all", sheet: "all" };

/** Which toggle a row answers to. Anything the engine did not call Error or Warning is Info. */
export function severityKey(f: Pick<FindingRow, "severity">): SeverityKey {
  const s = String(f.severity ?? "").toLowerCase();
  return s === "error" ? "error" : s === "warning" ? "warning" : "info";
}

/** The rows the current filter shows, in the order they came in. */
export function filterFindings(rows: readonly FindingRow[], filter: FindingFilter): FindingRow[] {
  return rows.filter((f) => filter.severities[severityKey(f)]
    && (filter.origin === "all" || findingBucket(f as FindingLike) === filter.origin)
    && (filter.sheet === "all" || (f.sheet ?? "") === filter.sheet));
}

/** How many of `rows` sit on each sheet (the sheet selector counts what choosing it would show). */
export function countsBySheet(rows: readonly FindingRow[], filter: FindingFilter): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of filterFindings(rows, { ...filter, sheet: "all" })) {
    const s = f.sheet ?? "";
    if (s) out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}

/** A stored filter (localStorage, another version of the app) read back defensively. */
export function normalizeFindingFilter(v: unknown): FindingFilter {
  const o = (v ?? {}) as { severities?: Partial<Record<SeverityKey, unknown>>; origin?: unknown; sheet?: unknown };
  const sev = { ...DEFAULT_FINDING_FILTER.severities };
  for (const k of SEVERITY_KEYS) if (typeof o.severities?.[k] === "boolean") sev[k] = o.severities[k] as boolean;
  return {
    severities: sev,
    origin: typeof o.origin === "string" && o.origin ? o.origin : DEFAULT_FINDING_FILTER.origin,
    sheet: typeof o.sheet === "string" && o.sheet ? o.sheet : DEFAULT_FINDING_FILTER.sheet,
  };
}
