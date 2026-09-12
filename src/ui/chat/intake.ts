// SPDX-License-Identifier: Apache-2.0
// Intake card model: classify dropped/pasted files by extension, expand folders
// (recursively; a `.pretty/` folder is one footprint library), and pick the suggested
// action from `settings.agent.intake_defaults`. Pure helpers — the dialog and the IPC
// calls live in IntakeDialog.tsx / Composer.tsx.
import { call } from "../../ipc/client";
import type { AttachKind } from "../../ipc/types";
import { sha256Hex } from "../../agent/util";

/** `library` = add to the project symbol library (a human write: consent + `lib_register`). */
export type IntakeAction = "attach" | "keep" | "reference" | "ignore" | "library";
export interface IntakeItem {
  id: string;
  name: string;
  /** Absolute path (Tauri drop / dialog) or null for in-memory files (paste / browser drop). */
  path: string | null;
  file: File | null;
  kind: AttachKind;
  size: number;
  action: IntakeAction;
  /** Folder this item came from (`.pretty` libraries show as one row). */
  group?: string;
}

const EXT_KIND: Record<string, AttachKind> = {
  kicad_sym: "lib", lib: "lib", kicad_mod: "lib", pretty: "lib",
  pdf: "pdf", md: "doc", txt: "doc", csv: "bom", xlsx: "bom", xls: "bom",
  kicad_sch: "sch", sch: "sch", net: "netlist", xml: "netlist",
  png: "image", jpg: "image", jpeg: "image", webp: "image", zip: "project_zip",
};

export function kindOf(name: string): AttachKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXT_KIND[ext] ?? "unknown";
}

/** `intake_defaults[kind]` → action; `ask` and unknown kinds default to attach (the safe, read-only choice). */
export function suggestedAction(kind: AttachKind, defaults: Record<string, string>): IntakeAction {
  const d = defaults[kind] ?? "ask";
  if (d === "keep" || d === "attach" || d === "reference") return d;
  if (kind === "unknown") return "ignore";
  return "attach";
}

/** `mode` sent to `attach_intake` for an action (`ignore` / `library` items are never sent). */
export function intakeMode(action: IntakeAction): string | null {
  return action === "attach" ? null : action === "library" ? "keep" : action;
}

/** Actions offered for a row: only a symbol / footprint library can join the project library. */
export function actionsFor(item: IntakeItem): IntakeAction[] {
  const base: IntakeAction[] = ["attach", "keep", "reference", "ignore"];
  return canRegisterLibrary(item) ? [...base, "library"] : base;
}

/** `.kicad_sym` (single file) or a `.pretty` group of footprints, with a path or in-memory bytes. */
export function canRegisterLibrary(item: IntakeItem): boolean {
  if (item.kind !== "lib") return false;
  if (item.group) return item.group.toLowerCase().endsWith(".pretty") && !!item.path;
  return item.name.toLowerCase().endsWith(".kicad_sym");
}

/** Library nickname derived from the file / folder name (KiCad allows no `:` `/` or spaces). */
export function libNickname(name: string): string {
  const stem = (name.split(/[\\/]/).pop() ?? name).replace(/\.(kicad_sym|pretty)$/i, "");
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 64);
  return safe || "mylib";
}

/** Directory of a `.pretty` group (its files all sit in it); null for in-memory drops. */
function prettyDir(rows: IntakeItem[]): string | null {
  const p = rows.find((r) => r.path)?.path;
  if (!p) return null;
  const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return cut > 0 ? p.slice(0, cut) : null;
}

/**
 * "Add to project symbol library" for one intake row (or one `.pretty` group): record the human's
 * consent, mint the `lib_import` grant it unlocks, then let Rust copy and register the library.
 * Rust is the enforcement point — this only carries the consent there. In-memory drops (a browser
 * paste with no path) land as an attachment first so Rust reads bytes it has verified itself.
 */
export async function registerLibrary(projectKey: string, rows: IntakeItem[]): Promise<{ nickname: string; symbols: number }> {
  const first = rows[0];
  const group = first.group;
  const nickname = libNickname(group ?? first.name);
  let request: { nickname: string; path?: string | null; sha256?: string | null; pretty_path?: string | null };
  if (group) {
    const dir = prettyDir(rows);
    if (!dir) throw new Error("LIB_IMPORT_NEEDS_PATH");
    request = { nickname, pretty_path: dir };
  } else if (first.path) {
    request = { nickname, path: first.path };
  } else if (first.file) {
    const buf = new Uint8Array(await first.file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const info = await call("attach_intake", { request: { project_key: projectKey, path: null, bytes_base64: btoa(bin), filename: first.name, mode: "keep" } });
    request = { nickname, sha256: info.sha256 };
  } else {
    throw new Error("LIB_IMPORT_NEEDS_PATH");
  }
  const payload_sha256 = sha256Hex(`lib_register:${nickname}:${request.path ?? request.sha256 ?? request.pretty_path ?? ""}`);
  const ev = await call("consent_record", { event: { project_key: projectKey, card_kind: "lib_import", payload_sha256, input_kind: "click" } });
  const grant = await call("grant_create", { request: { project_key: projectKey, kind: "lib_import", payload_sha256, consent_event_id: ev.id, action: { nickname } } });
  const out = await call("lib_register", { project_key: projectKey, request, auth: { grant: grant.id } });
  return { nickname: out.nickname, symbols: out.symbols.length };
}

let seq = 0;
export function makeItem(init: { name: string; path?: string | null; file?: File | null; size?: number; group?: string }, defaults: Record<string, string>): IntakeItem {
  const kind = kindOf(init.name);
  return { id: `in${++seq}`, name: init.name, path: init.path ?? null, file: init.file ?? null, kind, size: init.size ?? init.file?.size ?? 0, action: suggestedAction(kind, defaults), group: init.group };
}

/** Whether a multi-file drop should go through the intake card (single ordinary files attach directly). */
export function needsIntakeCard(items: IntakeItem[]): boolean {
  return items.length > 1 || items.some((i) => i.kind === "lib" || i.kind === "project_zip" || i.kind === "unknown" || !!i.group);
}

/** Recursively expand browser drag entries (folders included); `.pretty/` folders collapse into one lib item. */
export async function expandDataTransfer(dt: DataTransfer, defaults: Record<string, string>): Promise<IntakeItem[]> {
  const items: IntakeItem[] = [];
  const entries = Array.from(dt.items ?? []).map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null));
  if (!entries.some(Boolean)) {
    for (const f of Array.from(dt.files ?? [])) items.push(makeItem({ name: f.name, file: f }, defaults));
    return items;
  }
  const walk = async (entry: FileSystemEntry, group: string | undefined): Promise<void> => {
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      items.push(makeItem({ name: f.name, file: f, group }, defaults));
    } else if (entry.isDirectory) {
      const dir = entry as FileSystemDirectoryEntry;
      const g = entry.name.toLowerCase().endsWith(".pretty") ? entry.name : group;
      const reader = dir.createReader();
      const all: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        all.push(...batch);
      }
      for (const e of all) await walk(e, g);
    }
  };
  for (const e of entries) if (e) await walk(e, undefined);
  return items;
}
