// SPDX-License-Identifier: Apache-2.0
// Skeleton generator for the three-part error copy: reads the `- \`CODE\` — what / why / next｜…`
// lines of docs/ui-states.md (local, not in git) and the code list of docs/error-codes.md, then
// prints (a) codes present in ui-states but missing from src/i18n/errors/codes.ts and (b) a
// zh-Hant table skeleton for those codes. It never writes catalogues: copy is authored by hand
// in src/i18n/errors/<lang>.ts and completeness is enforced by tsc + the i18n test.
//
//   node scripts/gen-error-copy.mjs            # report + skeleton to stdout
//   node scripts/gen-error-copy.mjs --json     # machine-readable {code: {title, why, next}}
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const uiStates = join(root, "docs/ui-states.md");
const codesTs = readFileSync(join(root, "src/i18n/errors/codes.ts"), "utf8");
const known = new Set([...codesTs.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]));

export function parseUiStates(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^- ((?:`[A-Z_0-9]+`(?:\s*\/\s*)?)+)(?:（[^）]*）)?\s*[—-]\s*(.+?)(?:｜|$)/.exec(line);
    if (!m) continue;
    const codes = [...m[1].matchAll(/`([A-Z_0-9]+)`/g)].map((x) => x[1]);
    const parts = m[2].split(" / ").map((s) => s.trim());
    const [title = "", why = "", next = ""] = parts;
    for (const c of codes) out[c] = { title: title.replace(/`/g, ""), why: why === "—" ? "" : why.replace(/`/g, ""), next: next === "—" ? "" : next.replace(/`/g, "") };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(uiStates)) { console.error("docs/ui-states.md not found (docs/ is local-only)"); process.exit(2); }
  const parsed = parseUiStates(readFileSync(uiStates, "utf8"));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(parsed, null, 2)); process.exit(0); }
  const missing = Object.keys(parsed).filter((c) => !known.has(c));
  console.log(`ui-states codes: ${Object.keys(parsed).length}; in codes.ts: ${known.size}; missing from codes.ts: ${missing.length}`);
  for (const c of missing) {
    const e = parsed[c];
    console.log(`  ${c}: [${JSON.stringify(e.title)}, ${JSON.stringify(e.why)}, ${JSON.stringify(e.next)}],`);
  }
}
