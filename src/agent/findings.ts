// SPDX-License-Identifier: Apache-2.0
// Finding triage shared by the review card, the findings panel and `/fix`.
//
// Nothing here judges a circuit (red line 6): every verdict already came from the engine gate,
// from `kicad-cli sch erc` (advisory, red line 8) or from the Reviewer model. This module only
// sorts those rows, so the two entry points into "fix selected" cannot disagree about what they
// select, and so a panel header can never read "0 errors" over red rows from another source.

import { ERCFIX_CODES } from "./ercfix";
import { FIXER_MAP } from "./fixer-map";
import { isWaived } from "./policy/types";
import { STYLIST_CODES } from "./stylist";

/** The fields triage reads; both `Finding` (harness) and `FindingRow` (UI) satisfy it. */
export interface FindingLike {
  code: string;
  severity: string;
  /** "engine" (the gate) or "advisory" (Reviewer model / kicad-cli). Absent means engine. */
  origin?: string;
  refs?: string[];
  sheet?: string;
  location?: string;
  waived?: boolean;
  waived_until?: string;
  resolved?: boolean;
}

/** Codes minted by `kicad-erc.ts` from `kicad-cli sch erc`. */
export const KICAD_CODE_PREFIX = "KICAD_";

/**
 * Where a row came from. The three sources carry different authority: only `engine` decides
 * pass/fail, `kicad` is the oracle's own second opinion, `model` is a suggestion.
 */
export type FindingBucket = "engine" | "kicad" | "model";

export function findingBucket(f: FindingLike): FindingBucket {
  if (f.code.startsWith(KICAD_CODE_PREFIX)) return "kicad";
  return f.origin === "advisory" ? "model" : "engine";
}

/**
 * Can a human waive this row? A waiver hides a finding something actually inspected the file for,
 * so it covers the engine gate and KiCad's own ERC alike (Rust `PolicyWaive` takes their codes
 * without distinction). A model advisory is a suggestion, not a verdict: there is nothing to waive.
 */
export function isWaivable(f: FindingLike): boolean {
  return findingBucket(f) !== "model";
}

export interface BucketCount { total: number; errors: number; warnings: number }
export interface FindingBuckets { engine: BucketCount; kicad: BucketCount; model: BucketCount }

/** Per-bucket counts of the rows handed in (the caller filters out resolved / waived rows first). */
export function bucketCounts(findings: readonly FindingLike[]): FindingBuckets {
  const out: FindingBuckets = {
    engine: { total: 0, errors: 0, warnings: 0 },
    kicad: { total: 0, errors: 0, warnings: 0 },
    model: { total: 0, errors: 0, warnings: 0 },
  };
  for (const f of findings) {
    const b = out[findingBucket(f)];
    b.total++;
    const s = String(f.severity).toLowerCase();
    if (s === "error") b.errors++;
    else if (s === "warning") b.warnings++;
  }
  return out;
}

/**
 * Which repair exists for a code, if any — the one predicate behind every "can `/fix` do this?"
 * question in the app. It reads the registries that hold the repairs themselves, so a code cannot be
 * ticked in one place and dropped in another: `ercfix.ts` (a deterministic op-list, no model),
 * `stylist.ts` (the deterministic tidy pass) and `fixer-map.ts` (what the Lead dispatches a Fixer
 * for). Order is deterministic passes first, the model last. Anything none of them claims is `none`:
 * a librarian's or a human's call (a footprint choice, a pin-to-pin conflict, a datasheet claim), or
 * a code nothing has a repair for. Codes minted from `kicad-cli` carry KiCad's wording rather than
 * an engine code, so they are `none` here and routed onto an engine row by `triageFixSelection`.
 *
 * Red line 6: this says who could edit the file, never whether the circuit is right.
 */
export type FixKind = "mechanical" | "stylist" | "fixer" | "none";

export function fixKind(code: string): FixKind {
  if (ERCFIX_CODES.has(code)) return "mechanical";
  if (STYLIST_CODES.has(code)) return "stylist";
  return FIXER_MAP[code]?.who === "fixer" ? "fixer" : "none";
}

/** Whether `/fix` has any repair for this row (an engine row whose code some pass claims). */
export function isFixable(f: FindingLike): boolean {
  return findingBucket(f) === "engine" && fixKind(f.code) !== "none";
}

/**
 * What acting on the row costs, which is what the human is told before clicking Fix. `/fix` runs the
 * `ercfix` op-list and then up to two Fixer rounds — it does not run the stylist, which belongs to a
 * build step — so a stylist-owned code costs a model round here just like a Fixer-owned one.
 */
export type FixCost = "mechanical" | "model" | "none";

export function fixCost(f: FindingLike): FixCost {
  if (!isFixable(f)) return "none";
  return fixKind(f.code) === "mechanical" ? "mechanical" : "model";
}

export type FixCostCounts = { mechanical: number; model: number; none: number };

/** The three numbers the panel and the review card put above their Fix button. */
export function fixCostCounts(findings: readonly FindingLike[]): FixCostCounts {
  const out: FixCostCounts = { mechanical: 0, model: 0, none: 0 };
  for (const f of findings) out[fixCost(f)]++;
  return out;
}

/**
 * One row the review card and the findings panel both start with ticked: an open engine defect the
 * fix path actually has a repair for. Nothing is pre-ticked that `triageFixSelection` would then
 * drop — the two read the same `fixKind`.
 */
export function isDefaultFixSelected(f: FindingLike): boolean {
  const sev = String(f.severity);
  return isFixable(f)
    && f.resolved !== true
    && !isWaived(f)
    && (sev === "Error" || sev === "Warning");
}

/** The default "fix selected" selection: one predicate, used by the review card and the panel. */
export function defaultFixSelection<T extends FindingLike>(findings: readonly T[]): T[] {
  return findings.filter(isDefaultFixSelected);
}

/** Designators a finding names (`U1.3` -> `U1`), lower-cased for comparison. */
function objectsOf(f: FindingLike): string[] {
  return (f.refs ?? []).map((r) => r.split(".")[0].trim().toLowerCase()).filter(Boolean);
}

export interface FixTriage<T> {
  /** Rows the fix path will work on, in selection order. */
  fixable: T[];
  /** KiCad rows covered by an engine row on the same object: `row` is folded into `into`. */
  routed: { row: T; into: T }[];
  /** Selected rows nothing in the fix path can act on; they stay listed, unfixed. */
  dropped: T[];
}

/**
 * Split a "fix selected" selection into what `/fix` can act on and what it cannot.
 *
 * `KICAD_*` rows carry KiCad's wording, not an engine code, so the Fixer has no repair for them.
 * When the selection also holds an engine finding on the same object (same designator, same sheet
 * when both know it), the KiCad row is folded into that engine row instead of vanishing; otherwise
 * it is reported as not auto-fixable. Model advisories are never routed: they are suggestions.
 */
export function triageFixSelection<T extends FindingLike>(selected: readonly T[]): FixTriage<T> {
  const fixable: T[] = [];
  const routed: { row: T; into: T }[] = [];
  const dropped: T[] = [];
  const engine = selected.filter(isFixable);
  for (const f of selected) {
    if (isFixable(f)) { fixable.push(f); continue; }
    if (findingBucket(f) === "kicad") {
      const objs = objectsOf(f);
      const into = objs.length
        ? engine.find((e) => objectsOf(e).some((o) => objs.includes(o)) && (!f.sheet || !e.sheet || f.sheet === e.sheet))
        : undefined;
      if (into) { routed.push({ row: f, into }); continue; }
    }
    dropped.push(f);
  }
  return { fixable, routed, dropped };
}

/** `CODE location` for at most `max` rows, then `+n`; what a system line names without dumping prose. */
export function findingLabels(findings: readonly FindingLike[], max = 6): string {
  const head = findings.slice(0, max).map((f) => `${f.code}${f.location ? ` ${f.location}` : ""}`);
  const rest = findings.length - head.length;
  return rest > 0 ? `${head.join(", ")} +${rest}` : head.join(", ");
}
