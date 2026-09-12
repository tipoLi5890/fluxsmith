// SPDX-License-Identifier: Apache-2.0
// What `sch.apply` warned about, on its way to the human.
//
// The engine reports per-op warnings as English sentences prefixed with its own code
// (`per_op[].warnings`, `crates/sch-write/src/handlers.rs`): a placement it nudged, a port stub it
// could not clear, a route it drew across a foreign pin. Nothing in the UI used to read them, so a
// wire that silently joined two nets (`ROUTE_THROUGH_PIN`) never reached the engineer.
//
// This module only reads those strings: it splits the code off the front, and for the two codes
// that mean "this apply may have connected something nobody asked for" it lifts the first
// coordinate pair out of the sentence so the finding can carry a canvas anchor. It never judges the
// circuit (red line 6) and never treats the text as anything but untrusted data (red line 21).
//
// The engine should carry these as structured records (code, message, sheet, at_mil, refs) instead;
// until it does, the prefix and the coordinate pair are the only things parsed, and a sentence that
// matches neither simply yields no code and no anchor.

import type { ApplyWarning } from "./api";
import type { Finding } from "./policy/types";

/** Fallback code for a warning line the engine wrote without its own prefix. */
export const UNCODED_WARNING = "APPLY_WARNING";

/** How many warning lines one apply contributes to the stream line and the turn summary. */
export const APPLY_WARNINGS_MAX = 200;

/** Codes that mean the apply may have connected something the op-list never asked to connect. */
export const UNINTENDED_CONNECTION_CODES: readonly string[] = ["ROUTE_THROUGH_PIN", "WIRE_ON_NO_CONNECT"];

/** How many distinct codes the one-line stream summary names before it counts the rest. */
const TALLY_CODES = 4;

const CODED = /^([A-Z][A-Z0-9_]{2,63}):\s*([\s\S]*)$/;
/** The first `(x,y)` pair of a warning sentence; the engine writes those in mil. */
const FIRST_POINT = /\((-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)/;

/** One warning line as the engine wrote it: its code (when it carries one) and the sentence. */
export function parseApplyWarning(line: string, sheet?: string): ApplyWarning | null {
  const text = String(line ?? "").trim();
  if (!text) return null;
  const m = CODED.exec(text);
  const code = m ? m[1] : UNCODED_WARNING;
  const message = (m ? m[2] : text).trim().slice(0, 400);
  const out: ApplyWarning = { code, message };
  if (sheet) out.sheet = sheet;
  const p = FIRST_POINT.exec(text);
  if (p) {
    const x = Number(p[1]);
    const y = Number(p[2]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.at_mil = [x, y];
  }
  return out;
}

/** Every warning of an apply result's `per_op[]`, in op order, bounded. */
export function applyWarnings(perOp: readonly { warnings?: unknown }[], sheet?: string, max = APPLY_WARNINGS_MAX): ApplyWarning[] {
  const out: ApplyWarning[] = [];
  for (const op of perOp) {
    if (!Array.isArray(op?.warnings)) continue;
    for (const w of op.warnings as unknown[]) {
      if (out.length >= max) return out;
      if (typeof w !== "string") continue;
      const parsed = parseApplyWarning(w, sheet);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** `CODE x2, OTHER_CODE x1` for the one-line stream notice; the codes are engine identifiers, not copy. */
export function warningTally(warnings: readonly ApplyWarning[], max = TALLY_CODES): string {
  const counts = new Map<string, number>();
  for (const w of warnings) counts.set(w.code, (counts.get(w.code) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.slice(0, max).map(([code, n]) => `${code} ×${n}`);
  const rest = sorted.slice(max).reduce((a, [, n]) => a + n, 0);
  return rest > 0 ? `${head.join(", ")} +${rest}` : head.join(", ");
}

/**
 * The warnings that say a wire may have joined something the op-list did not name, as findings rows
 * for the panel. They are suggestions, not verdicts: `origin: "advisory"` puts them in the
 * "suggested" bucket, apart from the engine gate's own rows (`src/agent/findings.ts`).
 */
export function connectionFindings(warnings: readonly ApplyWarning[], runId: string): (Finding & { origin: "advisory" })[] {
  const out: (Finding & { origin: "advisory" })[] = [];
  warnings.forEach((w, i) => {
    if (!UNINTENDED_CONNECTION_CODES.includes(w.code)) return;
    const row: Finding & { origin: "advisory" } = {
      code: w.code,
      severity: "Warning",
      message: w.message,
      // Distinct per warning: the panel and the waiver key rows by code + location.
      location: `apply:${runId}:${i}`,
      origin: "advisory",
    };
    if (w.sheet) { row.sheet = w.sheet; row.file = w.sheet; }
    if (w.at_mil) row.at_mil = w.at_mil;
    out.push(row);
  });
  return out;
}
