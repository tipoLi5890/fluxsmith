// SPDX-License-Identifier: Apache-2.0
// Waiver values the review card collects (reason + expiry) and the harness sends to `policy_waive`.
// The gate itself is Rust (`src-tauri/src/engine.rs`, `PolicyWaive`): an Error-severity finding is
// waived only with an expiry and a reason of at least 12 characters (WAIVER_SEVERITY), and a waiver
// must name what it hides (WAIVER_SCOPE). These helpers keep the card in step with that rule; the
// verdict stays the engine's — the UI never decides that a finding is acceptable on its own.

import { canonicalJson, sha256Hex } from "./util";

/** Minimum reason length the Rust waiver gate accepts for an Error-severity finding. */
export const WAIVER_REASON_MIN = 12;
/** Expiry shortcuts offered on the card, in days. */
export const WAIVER_DAY_CHOICES = [30, 90, 180] as const;
/** Default expiry (the same 90 days Rust falls back to when a waiver carries none). */
export const WAIVER_DEFAULT_DAYS = 90;

/** The selection a review card answer carries, with the waiver values when the human filled them in. */
export interface WaiveSelection { ids: string[]; reason: string; expires: string | null }

/** `YYYY-MM-DD`, `days` ahead of `from` (UTC, like the instants the waiver record stores). */
export function expiryDate(days: number, from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A picked date (`YYYY-MM-DD`) as the ISO instant `fluxsmith.toml` stores; anything else passes through. */
export function normalizeExpiry(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
}

/** Whether the reason is long enough: required for an Error selection, optional for the rest. */
export function reasonOk(reason: string, hasError: boolean): boolean {
  return !hasError || reason.trim().length >= WAIVER_REASON_MIN;
}

/**
 * The free text a review card answer carries. Without a reason and an expiry it stays the plain id
 * array the card has always sent, so older transcripts and `fix_selected` keep working unchanged.
 */
export function waivePayload(ids: string[], reason?: string, expires?: string | null): string {
  const r = (reason ?? "").trim();
  const e = (expires ?? "").trim() || null;
  if (!r && !e) return JSON.stringify(ids);
  return JSON.stringify({ ids, ...(r ? { reason: r } : {}), ...(e ? { expires: e } : {}) });
}

/** Reads both payload shapes (bare id array, or `{ids, reason, expires}`); anything else is null. */
export function parseWaivePayload(free_text: string | null | undefined): WaiveSelection | null {
  if (!free_text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(free_text); } catch { return null; }
  if (Array.isArray(parsed)) return { ids: parsed.map(String), reason: "", expires: null };
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { ids?: unknown; reason?: unknown; expires?: unknown };
  if (!Array.isArray(o.ids)) return null;
  return {
    ids: o.ids.map(String),
    reason: typeof o.reason === "string" ? o.reason : "",
    expires: typeof o.expires === "string" && o.expires.trim() ? o.expires.trim() : null,
  };
}

/**
 * What one waive action covers: the rows the human actually ticked (each by code and by the refs the
 * waiver will name), the reason typed with them and the expiry. This object is what the consent event
 * is recorded over and what every grant of that action repeats, so Rust can recompute the hash and
 * refuse a waiver the human never saw: `commands.rs grant_create` requires the grant's payload sha to
 * be the recorded consent's, and `engine.rs PolicyWaive` requires the finding it is asked to waive to
 * be one of `findings`. Before this, one consent recorded before the picking (`waive:<project>:<turn>`)
 * unlocked N unrelated `policy_waive` calls.
 */
export interface WaiveBatch { findings: { code: string; refs: string[] }[]; reason: string; expires: string | null }

/** The batch for `rows`, in a canonical order so both sides hash the same bytes. */
export function waiveBatch(rows: readonly { code: string; refs?: string[]; location?: string }[], reason: string, expires: string | null | undefined): WaiveBatch {
  const findings = rows
    .map((f) => ({ code: f.code, refs: [...waiverRefs(f)].sort() }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.refs.join(",").localeCompare(b.refs.join(",")));
  return { findings, reason: waiveReasonOrDefault(reason), expires: normalizeExpiry(expires) };
}

/** The payload hash of a waive action: the consent event, every grant of it and Rust all use this one. */
export function waiveConsentSha(batch: WaiveBatch): string {
  return sha256Hex(canonicalJson(batch));
}

/** What a waiver hides: the finding's refs, else its location (Rust refuses a blanket waiver). */
export function waiverRefs(f: { refs?: string[]; location?: string }): string[] {
  return f.refs?.length ? f.refs : f.location ? [f.location] : [];
}

/**
 * What the record says when the human waived a Warning or an info finding without typing a reason.
 * Rust refuses an empty reason (`BAD_CONFIG`), so every path that records a waiver — the review card
 * and the findings panel — puts this English sentence in `fluxsmith.toml`. It is a project-file
 * record, not UI copy, so it does not follow the interface language.
 */
export const WAIVE_REASON_DEFAULT = "reviewed: known good";

/** The reason to record: what the human typed, else `WAIVE_REASON_DEFAULT`. */
export function waiveReasonOrDefault(reason: string | null | undefined): string {
  return (reason ?? "").trim() || WAIVE_REASON_DEFAULT;
}

/** Evidence field naming the findings a partially failed waive already recorded. */
const WAIVED_IDS = "waived_ids";

/**
 * The refusal to rethrow after a partial waive, carrying the ids already written. Waivers already
 * recorded stay recorded: naming them lets the card drop them from the selection, so a retry does
 * not send a row that is already in `fluxsmith.toml`.
 */
export function withWaivedIds<T extends { evidence?: unknown }>(error: T, ids: string[]): T {
  if (!ids.length) return error;
  const ev = error.evidence && typeof error.evidence === "object" ? (error.evidence as Record<string, unknown>) : {};
  return { ...error, evidence: { ...ev, [WAIVED_IDS]: ids } };
}

/** The ids `withWaivedIds` put on a refusal (an `IpcFailure` or the `IpcError` inside it); else `[]`. */
export function waivedIds(e: unknown): string[] {
  const holder = e as { error?: { evidence?: unknown }; evidence?: unknown } | null | undefined;
  const evidence = holder?.error?.evidence ?? holder?.evidence;
  const v = evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>)[WAIVED_IDS] : undefined;
  return Array.isArray(v) ? v.map(String) : [];
}
