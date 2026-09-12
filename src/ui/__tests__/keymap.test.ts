// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { findConflict, normalizeCombo, effectiveShortcuts } from "../shortcuts/keymap";

describe("keymap", () => {
  it("detects conflicts and reserved combos", () => {
    expect(findConflict("compact", "Mod+J", {})).toBe("jumpCard");
    expect(findConflict("compact", "Mod+W", {})).toBe("reserved");
    expect(findConflict("compact", "Mod+Shift+K", {})).toBeNull();
    expect(normalizeCombo("mod+k")).toBe("mod+K");
  });
  it("applies overrides only to customizable actions", () => {
    const eff = effectiveShortcuts({ send: "Enter", escape: "Mod+X" });
    expect(eff.find((d) => d.action === "send")?.combo).toBe("Enter");
    expect(eff.find((d) => d.action === "escape")?.combo).toBe("Escape");
  });
});

describe("canvas shortcuts", () => {
  it("adds finding walk / cycle / copy without conflicts", () => {
    const eff = effectiveShortcuts({});
    expect(eff.find((d) => d.action === "nextFinding")?.combo).toBe("N");
    expect(eff.find((d) => d.action === "prevFinding")?.combo).toBe("Shift+N");
    expect(eff.find((d) => d.action === "cycleNext")?.combo).toBe("]");
    expect(eff.find((d) => d.action === "cyclePrev")?.combo).toBe("[");
    expect(findConflict("compact", "N", {})).toBe("nextFinding");
    expect(findConflict("compact", "]", {})).toBe("cycleNext");
    // Mod+Shift+] (next tab) must not collide with ] (cycle)
    expect(findConflict("cycleNext", "Mod+Shift+]", {})).toBe("nextTab");
  });
});

