#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Emoji lint (CLAUDE.md red line 23): scans src/** (and docs/** when present, excluding docs/reviews) for
// Emoji_Presentation ∪ Extended_Pictographic ∪ explicit denylist blocks, minus the allowlist (© ® ™).
// Also validates tests/i18n/emoji-lint.jsonl cases. Exit 1 on any hit.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
// Allowlist: legal marks + keyboard glyphs used in shortcut tables + plain arrows (not pictographs in our UI).
const ALLOW = new Set(["©", "®", "™", "⌘", "⌃", "⌥", "⇧", "⌫", "⏎", "↔", "→", "←", "↑", "↓"]);
const DENY_RANGES = [[0x2700, 0x27bf], [0x2600, 0x26ff], [0x25a0, 0x25ff], [0x2300, 0x23ff]];
const PICTO = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

export function isForbidden(ch) {
  if (ALLOW.has(ch)) return false;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp < 0x2000) return false; // ASCII / Latin never forbidden
  for (const [a, b] of DENY_RANGES) if (cp >= a && cp <= b) return true;
  return PICTO.test(ch);
}

export function findForbidden(text) {
  const hits = [];
  let line = 1;
  let col = 0;
  for (const ch of text) {
    if (ch === "\n") { line++; col = 0; continue; }
    col++;
    if (isForbidden(ch)) hits.push({ ch, line, col, cp: "U+" + ch.codePointAt(0).toString(16).toUpperCase() });
  }
  return hits;
}

function walk(dir, out, skip) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p);
    if (skip.some((s) => rel.startsWith(s))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out, skip);
    else if (/\.(tsx?|jsx?|mjs|css|json|md|yaml|yml)$/.test(name)) out.push(p);
  }
  return out;
}

function main() {
  const files = [];
  walk(join(ROOT, "src"), files, []);
  // docs/ is local-only (gitignored) but CLAUDE.md wants it linted too: scan it whenever it exists, unless --no-docs.
  if (!process.argv.includes("--no-docs") && existsSync(join(ROOT, "docs"))) walk(join(ROOT, "docs"), files, ["docs/reviews"]);
  let bad = 0;
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (rel === "scripts/emoji-lint.mjs") continue;
    const hits = findForbidden(readFileSync(f, "utf8"));
    for (const h of hits) { bad++; console.error(`${rel}:${h.line}:${h.col} forbidden ${h.cp} ${JSON.stringify(h.ch)}`); }
  }
  const casesPath = join(ROOT, "tests/i18n/emoji-lint.jsonl");
  if (existsSync(casesPath)) {
    for (const raw of readFileSync(casesPath, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      const c = JSON.parse(raw);
      const forbidden = c.char != null ? isForbidden(c.char) : findForbidden(c.text ?? "").length > 0;
      if (forbidden === !!c.allowed) { bad++; console.error(`emoji-lint case mismatch: ${raw}`); }
    }
  }
  if (bad) { console.error(`emoji-lint: ${bad} problem(s)`); process.exit(1); }
  console.log(`emoji-lint: ok (${files.length} files)`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, "/"))) main();
else if (process.argv[1]?.endsWith("emoji-lint.mjs")) main();
