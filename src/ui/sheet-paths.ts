// SPDX-License-Identifier: Apache-2.0
// Addressing sheet instances. A hierarchy is walked by KiCad instance path
// (`/root-uuid/sheet-symbol-uuid/...`, `SheetInfo.instance_path`), never by sheet name: the same
// file instantiated twice has two instances that share every name but have different paths, and a
// name lookup would always land in the first of them.
import type { SheetInfo } from "../ipc/types";

/** One canonical spelling of an instance path (`/a/b`); the root of the list is `""`. */
export function normInstancePath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? `/${segs.join("/")}` : "";
}

/** The instance with this path, whatever spelling either side uses. */
export function instanceByPath(sheets: readonly SheetInfo[], path: string): SheetInfo | null {
  const want = normInstancePath(path);
  return sheets.find((s) => normInstancePath(s.instance_path) === want) ?? null;
}

/** The instance one level up from `path`: null at the root, and null when the project has no such instance. */
export function parentInstance(sheets: readonly SheetInfo[], path: string): SheetInfo | null {
  const segs = normInstancePath(path).split("/").filter(Boolean);
  if (segs.length < 2) return null;
  return instanceByPath(sheets, `/${segs.slice(0, -1).join("/")}`);
}

/**
 * The instance a sheet symbol drawn on `path` stands for. KiCad builds a child instance path by
 * appending the sheet symbol's own uuid, so two symbols pointing at one file resolve to two
 * instances (eeschema enters the one that was double-clicked, not the first of the file).
 */
export function childInstance(sheets: readonly SheetInfo[], path: string, symbolUuid: string | undefined | null): SheetInfo | null {
  if (!symbolUuid) return null;
  return instanceByPath(sheets, `${normInstancePath(path)}/${symbolUuid}`);
}

/** The instance whose human names path is `names` (`/`, `/Power/`, `Power/Amp`); the root answers to `/`. */
export function instanceByNames(sheets: readonly SheetInfo[], names: string): SheetInfo | null {
  const want = names.split("/").filter(Boolean).join("/");
  return sheets.find((s) => s.names.join("/") === want) ?? null;
}

/** How a sheet instance is named in a list: its names path, else its file (the root has no names). */
export function sheetLabel(s: SheetInfo | null | undefined, fallback = ""): string {
  if (!s) return fallback;
  return s.names.length ? s.names.join(" / ") : s.file || fallback;
}
