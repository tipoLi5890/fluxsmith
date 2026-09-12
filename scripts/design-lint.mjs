// SPDX-License-Identifier: Apache-2.0
// Design-system lint (docs/design-system.md, D-65): no raw colour literals outside
// src/styles/tokens.css. Scans src/**/*.css and src/**/*.tsx for hex colours, rgb()/rgba()/
// hsl()/hsla() and CSS named colours in style contexts. Exit 1 on any hit.
//
//   node scripts/design-lint.mjs            # lint
//   node scripts/design-lint.mjs --list     # print scanned files
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
// renderer.ts carries the documented fallback values for the canvas tokens (used only when CSS variables are unreadable).
const ALLOW_FILES = new Set(["src/styles/tokens.css", "src/canvas/renderer.ts"]);
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
const FUNC = /\b(?:rgba?|hsla?)\(/g;
// Named colours only count inside a CSS declaration value / inline style (`: red`, `"red"` in style props).
const NAMED = /(?:^|[:\s"'(])(?:red|blue|green|black|white|gray|grey|orange|yellow|purple|pink|silver|maroon|navy|teal|olive|lime|aqua|fuchsia)\b\s*(?:;|,|\)|"|'|$)/gm;
const STYLE_CTX = /(?:style=\{\{[^}]*\}\}|\b(?:color|background|border(?:-color)?|fill|stroke|outline|box-shadow)\s*:)/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name !== "node_modules" && name !== "fonts") walk(p, out); }
    else if (/\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export function lintText(rel, text) {
  const hits = [];
  if (ALLOW_FILES.has(rel)) return hits;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("design-lint: allow")) return;
    // `#` in a tsx string that is an id selector / anchor (`#turn-3`, `#card-x`) is not a colour: require hex digits only followed by a non-word.
    for (const m of line.matchAll(HEX)) {
      const before = line[m.index - 1] ?? "";
      if (/[\w-]/.test(before)) continue; // e.g. `a#ff` inside an identifier — not a literal
      // Skip anchors/ids: `#` followed by hex-looking words like `#dead` are rare; treat as colour when in CSS or a style context.
      if (/\.tsx?$/.test(rel) && !STYLE_CTX.test(line)) continue;
      hits.push({ line: i + 1, what: m[0] });
    }
    for (const m of line.matchAll(FUNC)) {
      if (/\.tsx?$/.test(rel) && !STYLE_CTX.test(line)) continue;
      hits.push({ line: i + 1, what: m[0] });
    }
    if (rel.endsWith(".css") || STYLE_CTX.test(line)) {
      for (const m of line.matchAll(NAMED)) {
        // `currentColor`, `transparent`, `inherit` are fine; only the listed names match.
        hits.push({ line: i + 1, what: m[0].trim() });
      }
    }
  });
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = walk(join(ROOT, "src"), []);
  if (process.argv.includes("--list")) { files.forEach((f) => console.log(relative(ROOT, f))); process.exit(0); }
  let bad = 0;
  for (const f of files) {
    const rel = relative(ROOT, f);
    const hits = lintText(rel, readFileSync(f, "utf8"));
    for (const h of hits) { bad++; console.log(`${rel}:${h.line}: hard-coded colour ${h.what}`); }
  }
  if (bad) { console.error(`design-lint: ${bad} hard-coded colour(s); use tokens from src/styles/tokens.css`); process.exit(1); }
  console.log(`design-lint: ok (${files.length} files)`);
}
