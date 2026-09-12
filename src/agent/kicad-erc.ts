// SPDX-License-Identifier: Apache-2.0
// KiCad's own ERC as advisory findings (red line 7: KiCad is the oracle; red line 8: `kicad-cli`
// is optional at runtime and its absence is never fatal). The Rust `kicad_advisory` command runs
// `kicad-cli sch erc --format json`; this module turns its violations into `Finding` rows with the
// same shape the engine produces, so they get canvas markers (`refs` / `sheet`) and can be waived
// (`code` + `location`). The engine gate stays the authority for pass/fail; these rows are shown
// with the severity KiCad gave them, and nothing here decides whether a write was allowed.

import type { Finding } from "./policy/types";

/** One `kicad_advisory { kind: "erc" }` run, mapped for the harness. */
export interface KicadErcResult {
  /** kicad-cli ran and produced a report. */
  available: boolean;
  /** Why it did not run (`KICAD_CLI_MISSING`, `sandbox disabled`, `timeout`, an IPC code). */
  note?: string;
  errors: number;
  warnings: number;
  rows: (Finding & { origin: "advisory" })[];
  /** Violations KiCad reported, which can exceed `rows.length` (the Rust side caps the list). */
  total: number;
}

/** Rows past this are dropped: the report is a second opinion, not a data dump. */
const MAX_ROWS = 200;
const MAX_REFS = 12;

export function emptyKicadErc(note: string): KicadErcResult {
  return { available: false, note, errors: 0, warnings: 0, rows: [], total: 0 };
}

interface RawItem { description?: unknown; uuid?: unknown }
interface RawViolation { type?: unknown; severity?: unknown; description?: unknown; items?: unknown; sheet?: unknown; file?: unknown; at_mil?: unknown; excluded?: unknown }

/**
 * The `REF.PIN` (or bare `REF`) an ERC item names, from KiCad's item description
 * ("Symbol U1 Pin 3 [VCC, Power input, Line]", "Symbol U1 接腳 3 [無源, 線]", "シンボル U1 ピン 3
 * [...]"). KiCad translates these strings in the user's own language and the environment cannot
 * always force English (macOS wxWidgets reads the system preferences), so no translated word is
 * matched: everything from the first `[` is pin detail and is cut off first (so a pin name is
 * never read as a designator), the designator is the first whole token shaped like one, and the
 * pin number is the trailing ASCII run of whatever the locale puts between them.
 */
export function refOfItem(description: string): string | null {
  const head = description.split("[")[0];
  const ref = head.split(/\s+/).map((t) => t.replace(/^[(]+|[,;:.()]+$/g, "")).find(isDesignator);
  if (!ref) return null;
  // Only a symbol pin carries the bracketed `[type, shape]` detail; a label or wire never does.
  if (!description.includes("[")) return ref;
  const pin = /([A-Za-z0-9_+-]{1,8})$/.exec(head.slice(head.indexOf(ref) + ref.length).trim());
  return pin ? `${ref}.${pin[1]}` : ref;
}

/** `#?[A-Z][A-Za-z_]{0,3}[0-9]{1,4}` over the whole token, so `Label 'R1'` is not a designator. */
function isDesignator(token: string): boolean {
  return /^#?[A-Z][A-Za-z_]{0,3}\d{1,4}$/.test(token);
}

function severityOf(v: RawViolation): "Error" | "Warning" | "Info" {
  const s = String(v.severity ?? "").toLowerCase();
  return s === "error" ? "Error" : s === "warning" ? "Warning" : "Info";
}

/**
 * Map a `kicad_advisory` result. Anything unexpected (a null, a missing `violations`) is reported
 * as "not available" rather than as a clean report: a footer must never imply KiCad approved a
 * design it never saw.
 */
export function kicadErcResult(adv: unknown): KicadErcResult {
  const a = (adv ?? null) as { available?: unknown; code?: unknown; reason?: unknown; violations?: unknown; total?: unknown } | null;
  if (!a || typeof a !== "object") return emptyKicadErc("unavailable");
  if (a.available === false) return emptyKicadErc(String(a.code ?? a.reason ?? "unavailable"));
  if (!Array.isArray(a.violations)) return emptyKicadErc("no report");
  const rows: (Finding & { origin: "advisory" })[] = [];
  const raw = (a.violations as RawViolation[]).filter((v) => !!v && typeof v === "object" && v.excluded !== true);
  raw.slice(0, MAX_ROWS).forEach((v, i) => {
    const items = (Array.isArray(v.items) ? (v.items as RawItem[]) : []).filter((x) => !!x && typeof x === "object");
    const descriptions = items.map((x) => (typeof x.description === "string" ? x.description : "")).filter(Boolean);
    const refs: string[] = [];
    for (const d of descriptions) { const r = refOfItem(d); if (r && !refs.includes(r) && refs.length < MAX_REFS) refs.push(r); }
    const type = String(v.type ?? "erc").replace(/[^A-Za-z0-9_]/g, "_");
    const uuid = items.map((x) => (typeof x.uuid === "string" ? x.uuid : "")).find(Boolean);
    const row: Finding & { origin: "advisory" } = {
      code: `KICAD_${type.toUpperCase()}`,
      severity: severityOf(v),
      message: [typeof v.description === "string" ? v.description : "", ...descriptions].filter(Boolean).join(" · ").slice(0, 300),
      // Distinct per violation: findings are keyed by code + location in the panel and in waivers.
      location: `kicad:${type}:${uuid || refs.join(",") || i}`,
      origin: "advisory",
    };
    if (refs.length) row.refs = refs;
    // `sheet` / `file` / `at_mil` are the Rust side's, resolved against the parsed tree: KiCad's
    // own `sheets[].path` files child-sheet objects under the root, and its item positions carry
    // a unit-scale bug (`src-tauri/src/advisory.rs`).
    if (typeof v.sheet === "string" && v.sheet) row.sheet = v.sheet;
    if (typeof v.file === "string" && v.file) row.file = v.file;
    if (Array.isArray(v.at_mil) && v.at_mil.length === 2 && v.at_mil.every((n) => typeof n === "number" && Number.isFinite(n))) {
      row.at_mil = [v.at_mil[0] as number, v.at_mil[1] as number];
    }
    rows.push(row);
  });
  return {
    available: true,
    errors: rows.filter((r) => r.severity === "Error").length,
    warnings: rows.filter((r) => r.severity === "Warning").length,
    rows,
    total: typeof a.total === "number" ? a.total : raw.length,
  };
}
