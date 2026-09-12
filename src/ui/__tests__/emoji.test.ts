// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findForbidden, isForbidden } from "../../../scripts/emoji-lint.mjs";

function walk(dir: string, out: string[]) {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(tsx?|css|mjs|json)$/.test(n)) out.push(p); }
  return out;
}

describe("emoji lint (red line 23)", () => {
  it("src/** contains no emoji or dingbat marks", () => {
    const root = join(process.cwd(), "src");
    const bad = walk(root, []).flatMap((f) => findForbidden(readFileSync(f, "utf8")).map((h) => `${f}:${h.line} ${h.cp}`));
    expect(bad).toEqual([]);
  });
  it("matches the fixture cases", () => {
    const lines = readFileSync(join(process.cwd(), "tests/i18n/emoji-lint.jsonl"), "utf8").split("\n").filter(Boolean);
    for (const raw of lines) { const c = JSON.parse(raw) as { char: string; allowed: boolean }; expect(isForbidden(c.char), raw).toBe(!c.allowed); }
  });
});
