// SPDX-License-Identifier: Apache-2.0
// The components / nets lists can read one sheet or the whole project. Everything here is about
// addressing: which sheet instance a row belongs to, and which rows share a designator across
// instances. Nothing here judges the circuit -- a shared designator is reported as the engine's
// finding when there is one, and otherwise stated as plain fact (this row is also on that sheet).
import type { SheetInfo } from "../../ipc/types";
import { instanceByNames, instanceByPath, sheetLabel } from "../sheet-paths";

export type ListScope = "sheet" | "all";

export interface CompRow {
  reference: string;
  value: string;
  lib_id: string;
  footprint?: string;
  /** Sheet file the symbol lives in (`all_sheets` rows only). */
  sheet?: string;
  /** Instance path the row was read through (`all_sheets` rows only). */
  instance_path?: string;
}

export interface NetRow {
  name: string;
  scope: string;
  members: number;
  /** Names paths of the sheets the net has members on (`/`, `/Power/`). */
  sheets?: string[];
}

/**
 * References that appear on more than one sheet instance, mapped to the instance paths that carry
 * them. Power symbols (`#PWR…`) are excluded by the caller, which never lists them.
 */
export function duplicateInstances(rows: readonly CompRow[]): Map<string, string[]> {
  const byRef = new Map<string, string[]>();
  for (const r of rows) {
    const path = r.instance_path ?? "";
    const seen = byRef.get(r.reference);
    if (!seen) byRef.set(r.reference, [path]);
    else if (!seen.includes(path)) seen.push(path);
  }
  const out = new Map<string, string[]>();
  for (const [ref, paths] of byRef) if (paths.length > 1) out.set(ref, paths);
  return out;
}

/** The other sheets a duplicated reference sits on, named the way the sheet tree names them. */
export function otherSheets(sheets: readonly SheetInfo[], paths: readonly string[], own: string | undefined, fallback = ""): string[] {
  return paths.filter((p) => p !== (own ?? "")).map((p) => sheetLabel(instanceByPath(sheets, p), fallback));
}

/**
 * Instance a net row should switch the canvas to, or undefined to stay: a net with a member on the
 * current sheet is already visible here, and one that is not is framed on the first sheet it reaches.
 */
export function netInstance(sheets: readonly SheetInfo[], current: SheetInfo | null | undefined, rowSheets: readonly string[] | undefined): string | undefined {
  if (!rowSheets?.length) return undefined;
  const norm = (s: string) => s.split("/").filter(Boolean).join("/");
  const here = current ? current.names.join("/") : null;
  if (here !== null && rowSheets.some((s) => norm(s) === here)) return undefined;
  for (const s of rowSheets) {
    const hit = instanceByNames(sheets, s);
    if (hit) return hit.instance_path;
  }
  return undefined;
}

/** How a net row names the sheets it reaches (the sheet tree's names, root included). */
export function netSheetLabels(sheets: readonly SheetInfo[], rowSheets: readonly string[] | undefined): string {
  if (!rowSheets?.length) return "";
  return rowSheets.map((s) => sheetLabel(instanceByNames(sheets, s), s)).join(", ");
}
