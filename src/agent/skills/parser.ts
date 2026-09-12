// SPDX-License-Identifier: Apache-2.0
// SKILL.md parsing: YAML front matter + `## Title {#id}` sections
// (skill-packs.md §1, §6). Pure functions; lint is static.

import { parse as parseYaml } from "yaml";

export interface SkillFrontMatter {
  name: string;
  description: string;
  roles?: string[];
  modes?: string[];
  activation?: { finding_codes?: string[]; lib_prefixes?: string[]; plan_tags?: string[]; always?: boolean };
  inject_section?: string;
  overrides?: string[];
  hard?: string[];
  language?: string;
}

export interface SkillSection {
  id: string;
  title: string;
  text: string;
  origin_agent?: boolean;
}

export interface ParsedSkill {
  front: SkillFrontMatter;
  sections: SkillSection[];
  body: string;
  lint: string[];
}

export function parseSkill(md: string, layer: "builtin" | "user" | "project"): ParsedSkill {
  const lint: string[] = [];
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  let front: SkillFrontMatter = { name: "", description: "" };
  let body = md;
  if (fm) {
    try { front = { ...front, ...(parseYaml(fm[1]) as Partial<SkillFrontMatter>) }; } catch (e) { lint.push(`front matter: ${String(e)}`); }
    body = md.slice(fm[0].length);
  } else lint.push("missing front matter");
  if (!front.name) lint.push("front matter: name required");
  if (!front.description) lint.push("front matter: description required");
  if (front.description && front.description.length > 200) lint.push("description longer than 200 chars");
  if (front.description && nonAsciiRatio(front.description) > 0.3) lint.push("description must be English (L0)");
  if (front.hard && front.hard.length && layer !== "builtin") lint.push("hard: only allowed in builtin skills");
  const sections: SkillSection[] = [];
  const ids = new Set<string>();
  const re = /^#{2,3}\s+(.+?)\s*(?:\{#([A-Za-z0-9_-]+)\})?\s*$/gm;
  let m: RegExpExecArray | null;
  const heads: { id: string | undefined; title: string; start: number; end: number }[] = [];
  while ((m = re.exec(body))) heads.push({ id: m[2], title: m[1], start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const text = body.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : body.length).trim();
    if (!h.id) { lint.push(`section "${h.title}" has no {#id} anchor`); continue; }
    if (ids.has(h.id)) lint.push(`duplicate section id ${h.id}`);
    ids.add(h.id);
    sections.push({ id: h.id, title: h.title, text, origin_agent: /<!--\s*origin:\s*agent/.test(text) });
  }
  for (const s of sections) {
    if (/\$\(|`\s*(bash|sh|rm|curl)\b|^\s*bash:/m.test(s.text)) lint.push(`section ${s.id} contains shell syntax`);
    if (/"name"\s*:\s*"[a-z]+\.[a-z_]+"\s*,\s*"parameters"/.test(s.text)) lint.push(`section ${s.id} looks like a tool definition`);
  }
  return { front, sections, body, lint };
}

export function nonAsciiRatio(s: string): number {
  if (!s.length) return 0;
  let n = 0;
  for (const ch of s) if ((ch.codePointAt(0) ?? 0) > 0x7f) n++;
  return n / s.length;
}

/** Digest line for the L0 index (English description, ≤ 200 chars). */
export function l0Line(name: string, description: string, layer: string): string {
  return `- ${name} (${layer}): ${description.replace(/\s+/g, " ").trim()}`;
}
