#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Cache-prefix lint (caching-strategy.md §7): the system prompt and the tool descriptions
// must be byte-deterministic — no timestamps, uuids, absolute paths, random ids, mode /
// policy strings. Static scan of the sources that feed the prefix; the runtime invariant
// (two assemblies byte-identical) lives in src/agent/__tests__/cache-invariants.test.ts.
// Exit 1 on any hit.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Rules: [label, regex]. Applied to every scanned line. */
export const VOLATILE_RULES = [
  ["iso-timestamp", /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["absolute-path", /(^|["'`\s(=])(\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders\/|[A-Za-z]:\\\\)/],
  ["date-now", /\bDate\.now\s*\(/],
  ["new-date", /\bnew Date\s*\(/],
  ["math-random", /\bMath\.random\s*\(/],
  ["now-iso", /\bnowIso\s*\(/],
  ["local-id", /\blocalId\s*\(/],
  ["mode-marker", /<<mode /],
  ["policy-string", /\bpolicy=(ask|review|auto)\b/],
];

/** Scan a text; returns hits `{rule, line, excerpt}`. */
export function findVolatile(text, opts = {}) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [rule, re] of VOLATILE_RULES) {
      if (opts.skipRules?.includes(rule)) continue;
      if (re.test(line)) hits.push({ rule, line: i + 1, excerpt: line.trim().slice(0, 120) });
    }
  }
  return hits;
}

/** Only the `description:` / description string lines of the tool manifest feed the prefix. */
export function manifestDescriptionLines(text) {
  return text.split("\n").map((l, i) => ({ l, i })).filter(({ l }) => /\bdescription\s*:/.test(l)).map(({ l, i }) => `${i + 1}:${l}`).join("\n");
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name === "SKILL.md") out.push(p);
  }
  return out;
}

/** Front matter of a SKILL.md (name + description form the L0 index line). */
export function frontMatter(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return m ? m[1] : "";
}

export function lintRepo(root = ROOT) {
  const problems = [];
  const report = (file, hits) => { for (const h of hits) problems.push(`${relative(root, file)}:${h.line}: ${h.rule}: ${h.excerpt}`); };
  const system = join(root, "src/agent/prompts/system.ts");
  if (existsSync(system)) report(system, findVolatile(readFileSync(system, "utf8")));
  const manifest = join(root, "src/agent/tools/manifest.ts");
  if (existsSync(manifest)) {
    const text = manifestDescriptionLines(readFileSync(manifest, "utf8"));
    for (const h of findVolatile(text)) problems.push(`${relative(root, manifest)}:${h.excerpt.split(":")[0]}: ${h.rule}: ${h.excerpt}`);
  }
  for (const f of walk(join(root, "skills"))) report(f, findVolatile(frontMatter(readFileSync(f, "utf8"))));
  return problems;
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const problems = lintRepo();
  if (problems.length) {
    console.error(`cache-lint: ${problems.length} volatile token(s) in the cache prefix sources`);
    for (const p of problems) console.error("  " + p);
    process.exit(1);
  }
  console.log("cache-lint: ok (system prompt, tool descriptions, skill front matter)");
}
