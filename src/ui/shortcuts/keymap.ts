// SPDX-License-Identifier: Apache-2.0
// Shortcut table (docs/operations-misc.md §9). `Mod` = Cmd on macOS, Ctrl elsewhere. IME composition never triggers.
import type { MessageKey } from "../../i18n";

export type ShortcutAction =
  | "send" | "stop" | "modePlan" | "modeBuild" | "modeReview" | "jumpCard" | "searchCanvas" | "focusSelection" | "escape"
  | "cyclePanes" | "cyclePanesBack" | "prevTab" | "nextTab" | "closeTab" | "newSession" | "compact" | "settings" | "help" | "attach" | "themeToggle"
  | "nextFinding" | "prevFinding" | "cycleNext" | "cyclePrev" | "copyName" | "highlightNet" | "parentSheet" | "fitAll" | "openDetail";

export interface ShortcutDef { action: ShortcutAction; combo: string | null; scope: "global" | "composer" | "canvas" | "nonInput"; labelKey: MessageKey; customizable: boolean }

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  { action: "send", combo: "Mod+Enter", scope: "composer", labelKey: "shortcut.send", customizable: true },
  { action: "stop", combo: "Mod+.", scope: "global", labelKey: "shortcut.stop", customizable: true },
  { action: "modePlan", combo: "Mod+1", scope: "global", labelKey: "shortcut.modePlan", customizable: true },
  { action: "modeBuild", combo: "Mod+2", scope: "global", labelKey: "shortcut.modeBuild", customizable: true },
  { action: "modeReview", combo: "Mod+3", scope: "global", labelKey: "shortcut.modeReview", customizable: true },
  { action: "jumpCard", combo: "Mod+J", scope: "global", labelKey: "shortcut.jumpCard", customizable: true },
  { action: "searchCanvas", combo: "Mod+F", scope: "global", labelKey: "shortcut.searchCanvas", customizable: true },
  { action: "focusSelection", combo: "F", scope: "canvas", labelKey: "shortcut.focusSelection", customizable: true },
  { action: "nextFinding", combo: "N", scope: "canvas", labelKey: "shortcut.nextFinding", customizable: true },
  { action: "prevFinding", combo: "Shift+N", scope: "canvas", labelKey: "shortcut.prevFinding", customizable: true },
  { action: "cycleNext", combo: "]", scope: "canvas", labelKey: "shortcut.cycleNext", customizable: true },
  { action: "cyclePrev", combo: "[", scope: "canvas", labelKey: "shortcut.cyclePrev", customizable: true },
  // Handled by the canvas element itself (like `[` / `]`): the keyboard equivalent of a double-click.
  { action: "openDetail", combo: "Enter", scope: "canvas", labelKey: "shortcut.openDetail", customizable: false },
  // `Mod+C` is OS-reserved in general; on the canvas (no text selection) it copies the selected names.
  { action: "copyName", combo: "Mod+C", scope: "canvas", labelKey: "shortcut.copyName", customizable: false },
  // eeschema parity: ` highlights the hovered net, Alt+Backspace leaves the sheet, Ctrl+Home zooms to the drawn objects.
  { action: "highlightNet", combo: "`", scope: "canvas", labelKey: "shortcut.highlightNet", customizable: true },
  { action: "parentSheet", combo: "Alt+Backspace", scope: "canvas", labelKey: "shortcut.parentSheet", customizable: true },
  { action: "fitAll", combo: "Mod+Home", scope: "canvas", labelKey: "shortcut.fitAll", customizable: true },
  { action: "escape", combo: "Escape", scope: "global", labelKey: "shortcut.escape", customizable: false },
  { action: "cyclePanes", combo: "F6", scope: "global", labelKey: "shortcut.cyclePanes", customizable: true },
  { action: "cyclePanesBack", combo: "Shift+F6", scope: "global", labelKey: "shortcut.cyclePanesBack", customizable: true },
  { action: "prevTab", combo: "Mod+Shift+[", scope: "global", labelKey: "shortcut.prevTab", customizable: true },
  { action: "nextTab", combo: "Mod+Shift+]", scope: "global", labelKey: "shortcut.nextTab", customizable: true },
  { action: "closeTab", combo: "Mod+Shift+W", scope: "global", labelKey: "shortcut.closeTab", customizable: true },
  { action: "newSession", combo: "Mod+Shift+N", scope: "global", labelKey: "shortcut.newSession", customizable: true },
  { action: "compact", combo: null, scope: "global", labelKey: "shortcut.compact", customizable: true },
  { action: "settings", combo: "Mod+,", scope: "global", labelKey: "shortcut.settings", customizable: true },
  { action: "help", combo: "?", scope: "nonInput", labelKey: "shortcut.help", customizable: false },
  { action: "attach", combo: "Mod+Shift+A", scope: "composer", labelKey: "shortcut.attach", customizable: true },
  { action: "themeToggle", combo: null, scope: "global", labelKey: "shortcut.themeToggle", customizable: true },
];

/** OS-reserved combos that may never be assigned. */
const RESERVED = new Set(["Mod+W", "Mod+Q", "Mod+H", "Mod+M", "Mod+Tab", "Alt+F4", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+A"]);

export function isMac(): boolean { return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform); }

export function normalizeCombo(c: string): string {
  return c.split("+").map((p) => p.trim()).map((p) => (p.length === 1 ? p.toUpperCase() : p)).join("+");
}

/** The fields of a keyboard event a combo is built from (native and React synthetic events both fit). */
export interface ComboEvent { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/**
 * Combo of a keystroke over the canvas. Either platform modifier counts as `Mod`, so a remap behaves
 * the same on macOS and on Windows, and so the drawing and the panel agree on who owns a key.
 */
export function canvasCombo(e: ComboEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  let key = e.key;
  if (key === " ") key = "Space";
  if (e.shiftKey && (key.length > 1 || /[a-z]/i.test(key))) parts.push("Shift");
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return normalizeCombo(parts.join("+"));
}

export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && e.key.length > 1) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  if (key.length === 1) {
    if (e.shiftKey && /[a-z]/i.test(key)) parts.push("Shift");
    key = key.toUpperCase();
  }
  parts.push(key);
  return parts.join("+");
}

export function effectiveShortcuts(overrides: Record<string, string>): ShortcutDef[] {
  return DEFAULT_SHORTCUTS.map((d) => (d.customizable && d.action in overrides ? { ...d, combo: overrides[d.action] || null } : d));
}

/** Returns the conflicting action, "reserved", or null when the combo is free. */
export function findConflict(action: ShortcutAction, combo: string, overrides: Record<string, string>): ShortcutAction | "reserved" | null {
  const n = normalizeCombo(combo);
  if (RESERVED.has(n)) return "reserved";
  for (const d of effectiveShortcuts(overrides)) {
    if (d.action !== action && d.combo && normalizeCombo(d.combo) === n) return d.action;
  }
  return null;
}

export function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
