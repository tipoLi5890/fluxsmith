// SPDX-License-Identifier: Apache-2.0
// Global keydown dispatcher. Composer/canvas-scoped shortcuts are handled by those components; this covers `global` and `nonInput`.
import { useEffect } from "react";
import { useSettings } from "../../state/settings";
import { comboFromEvent, effectiveShortcuts, isComposing, normalizeCombo, type ShortcutAction } from "./keymap";

/** Is the event target a text-entry control (typing there must not trigger single-key shortcuts)? */
export function inInput(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  const tag = e.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.isContentEditable;
}

export function useShortcuts(handler: (action: ShortcutAction, e: KeyboardEvent) => boolean | void): void {
  const overrides = useSettings((s) => s.settings.shortcuts);
  useEffect(() => {
    const defs = effectiveShortcuts(overrides);
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e)) return;
      const combo = normalizeCombo(comboFromEvent(e));
      for (const d of defs) {
        if (!d.combo || normalizeCombo(d.combo) !== combo) continue;
        if (d.scope === "composer" || d.scope === "canvas") continue;
        if (d.scope === "nonInput" && inInput(e.target)) continue;
        if (handler(d.action, e) !== false) { e.preventDefault(); }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overrides, handler]);
}
