// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { catalogues, UI_LANGS, errorCopy } from "../../i18n";
import { ERROR_CODES } from "../../i18n/errors/codes";
import { errorToastText } from "../../state/toasts";
import { IpcFailure } from "../../ipc/client";

describe("three-part error copy", () => {
  it("every code has title/why/next in all four languages (title non-empty)", () => {
    for (const code of ERROR_CODES) for (const l of UI_LANGS) {
      const cat = catalogues[l] as Record<string, string>;
      for (const part of ["title", "why", "next"]) expect(typeof cat[`error.${code}.${part}`], `${l}:${code}.${part}`).toBe("string");
      expect(cat[`error.${code}.title`].length, `${l}:${code}.title`).toBeGreaterThan(0);
    }
  });
  it("no legacy single-string error keys remain", () => {
    const keys = Object.keys(catalogues.en);
    expect(keys.filter((k) => /^error\.[A-Z_]+$/.test(k))).toEqual([]);
  });
  it("errorCopy resolves per language and falls back to null for unknown codes", () => {
    expect(errorCopy("TARGET_LOCKED", "zh-Hant")?.title).toBe("KiCad 正在編輯此檔");
    expect(errorCopy("TARGET_LOCKED", "en")?.next).toContain("KiCad");
    expect(errorCopy("NOT_A_CODE")).toBeNull();
  });
  it("toast text uses the copy for known codes and the raw message otherwise", () => {
    expect(errorToastText(new IpcFailure({ code: "DISK_FULL", message: "ENOSPC", req_id: "r1" }))).toMatch(/^Not enough disk space — /);
    expect(errorToastText(new IpcFailure({ code: "WEIRD", message: "boom", req_id: "r1", remediation: "retry" }))).toBe("WEIRD: boom — retry");
    expect(errorToastText(new Error("plain"))).toBe("Error: plain");
  });
});
