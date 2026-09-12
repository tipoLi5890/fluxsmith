// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import en from "../../i18n/en";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "__tests__") walk(p, out); }
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

describe("harness i18n keys", () => {
  it("every card.* / system.* key literal emitted by src/agent exists in the catalogue", () => {
    const root = join(__dirname, "..", "..", "agent");
    const keys = new Set<string>();
    for (const f of walk(root)) {
      for (const m of readFileSync(f, "utf8").matchAll(/"((?:card|system)\.[a-z_]+)"/g)) keys.add(m[1]);
    }
    expect(keys.size).toBeGreaterThan(10);
    const missing = [...keys].filter((k) => !(k in en));
    expect(missing, `missing in en.ts: ${missing.join(", ")}`).toEqual([]);
  });
});

import { describe as d2, it as it2, expect as e2 } from "vitest";
import enCat from "../../i18n/en";
d2("hard-stop card titles", () => {
  it2("has a title for every hard-stop condition the harness can raise", () => {
    for (const c of ["scope_widen", "structural", "net_risk", "unresolved", "interface", "budget", "external", "context", "scope"]) e2(enCat[`hard_stop.${c}` as keyof typeof enCat], `hard_stop.${c}`).toBeTruthy();
  });
});
