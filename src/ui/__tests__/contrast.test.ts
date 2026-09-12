// SPDX-License-Identifier: Apache-2.0
// Design-system contrast matrix: semantic *-900 text colours and gray-900 must reach WCAG AA
// (4.5:1) against bg-1 and bg-2 in both themes; gray-700 (disabled) at least 3:1.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function parseTokens(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const grab = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const lightEnd = css.indexOf(':root[data-theme="dark"]');
  return { light: grab(css.slice(0, lightEnd)), dark: grab(css.slice(lightEnd)) };
}
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("design tokens contrast", () => {
  const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
  const { light, dark } = parseTokens(css);
  const TEXT = ["--fg", "--gray-1000", "--gray-900", "--red-900", "--amber-900", "--green-900", "--blue-900"];
  for (const [name, tk] of [["light", light], ["dark", dark]] as const) {
    it(`${name}: text tokens reach 4.5:1 on bg-1 and bg-2`, () => {
      for (const t of TEXT) for (const bg of ["--bg-1", "--bg-2"]) {
        expect(tk[t], `${name} ${t}`).toBeDefined();
        expect(contrast(tk[t], tk[bg]), `${name} ${t} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: disabled gray-700 reaches 3:1`, () => {
      expect(contrast(tk["--gray-700"], tk["--bg-1"])).toBeGreaterThanOrEqual(3);
    });
    it(`${name}: status backgrounds (*-100) are distinguishable from bg-1`, () => {
      for (const c of ["--red-100", "--amber-100", "--green-100", "--blue-100"]) expect(tk[c]).not.toBe(tk["--bg-1"]);
    });
  }
});
