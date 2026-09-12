// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogues, UI_LANGS, format, resolveAutoLang, t } from "../../i18n";
import { detectLang } from "../../i18n/lang-detect";
import en from "../../i18n/en";

describe("i18n catalogues", () => {
  it("all four catalogues have identical key sets", () => {
    const keys = Object.keys(en).sort();
    for (const l of UI_LANGS) {
      expect(Object.keys(catalogues[l]).sort(), l).toEqual(keys);
      for (const k of keys) expect(typeof (catalogues[l] as Record<string, string>)[k], `${l}:${k}`).toBe("string");
    }
  });
  it("placeholders are preserved across languages", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const l of UI_LANGS) for (const [k, v] of Object.entries(en)) expect(ph((catalogues[l] as Record<string, string>)[k]), `${l}:${k}`).toEqual(ph(v));
  });
  it("formats params and resolves auto language", () => {
    expect(format("a {x} b {y}", { x: 1, y: "z" })).toBe("a 1 b z");
    expect(t("chat.turn", { n: 3 }, "zh-Hant")).toBe("第 3 輪");
    expect(resolveAutoLang("zh-TW")).toBe("zh-Hant");
    expect(resolveAutoLang("zh-CN")).toBe("zh-Hans");
    expect(resolveAutoLang("ja-JP")).toBe("ja");
    expect(resolveAutoLang("fr")).toBe("en");
  });
  it("detects message language per tests/i18n/lang-detect.jsonl", () => {
    const lines = readFileSync(join(process.cwd(), "tests/i18n/lang-detect.jsonl"), "utf8").split("\n").filter(Boolean);
    let ok = 0;
    for (const raw of lines) {
      const c = JSON.parse(raw) as { text: string; ui: "en" | "zh-Hant" | "zh-Hans" | "ja"; prev: "en" | "zh-Hant" | "zh-Hans" | "ja" | null; expect: string; locale?: string };
      const got = detectLang(c.text, c.ui, c.prev, c.locale);
      if (got === c.expect) ok++; else console.log("lang-detect miss", raw, "->", got);
    }
    expect(ok / lines.length).toBe(1);
  });
});
