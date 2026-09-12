#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// L5 replay — build a recording from a real session (testing-strategy.md L5).
//
//   pnpm replay:record <session_id> [--project <root>] [--out tests/replay/<name>.jsonl.gz] [--app-data <dir>]
//
// Sources: the app's SQLite `messages` table (Lead assistant messages + tool results, via the
// sqlite3 CLI, no npm deps) and `<project>/.fluxsmith/turns/<n>/subagents/*.json` (subagent
// transcripts). The result is a `source: "history"` recording: model entries carry
// `context_hash: null` and replay by role order (lenient); IPC results are not reconstructed
// (the replay runner serves them from its default fake). A strict, hash-checked recording
// can only come from the in-app seam (`startRecording()` in src/agent/replay/recorder.ts).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname;

export function parseArgs(argv) {
  const out = { session: null, project: null, out: null, appData: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") out.project = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--app-data") out.appData = argv[++i];
    else rest.push(a);
  }
  out.session = rest[0] ?? null;
  return out;
}

function appDataDir(override) {
  return override || process.env.FLUXSMITH_APP_DATA || join(homedir(), "Library", "Application Support", "fluxsmith");
}

function sqliteJson(db, sql) {
  const r = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr || r.stdout}`);
  const text = r.stdout.trim();
  return text ? JSON.parse(text) : [];
}

const encode = (name) => String(name).replace(/\./g, "__");

/** HMessage (assistant) → pi AssistantMessage as the loop would have received it. */
export function historyAssistant(h) {
  const content = [
    ...h.content.filter((c) => c.type === "text").map((c) => ({ type: "text", text: c.text })),
    ...(h.toolCalls ?? []).map((tc) => ({ type: "toolCall", id: tc.id, name: encode(tc.name), arguments: tc.args ?? {} })),
  ];
  return {
    role: "assistant", content, api: "history", provider: "history", model: "history",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: (h.toolCalls ?? []).length ? "toolUse" : "stop", timestamp: 0,
  };
}

/** Entries for one session from DB rows `{turn, role, content}` (content = HMessage JSON). */
export function entriesFromRows(rows) {
  const entries = [];
  const turns = [];
  let callIndex = 0;
  for (const r of rows) {
    const h = typeof r.content === "string" ? JSON.parse(r.content) : r.content;
    if (!h || typeof h !== "object") continue;
    if (h.role === "user" && h.meta?.kind === "user") {
      const text = h.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      // the user text is the first block before the harness' <attachments>/<refs>/<reply_language> tail
      turns.push({ turn: Number(r.turn ?? h.meta.turn ?? 0), text: text.split("\n\n<")[0] });
    } else if (h.role === "assistant") {
      entries.push({ kind: "model", call_index: callIndex++, role: "lead", model: "history", context_hash: null, assistant: historyAssistant(h) });
    } else if (h.role === "toolResult") {
      entries.push({ kind: "tool_result", turn: Number(r.turn ?? h.meta?.turn ?? 0), toolCallId: h.toolCallId, toolName: h.toolName, text: h.content.filter((c) => c.type === "text").map((c) => c.text).join("").slice(0, 4000) });
    }
  }
  return { entries, turns, nextIndex: callIndex };
}

/** Subagent transcripts (`turns/<n>/subagents/<role>-<id>.json`) → model entries keyed by role. */
export function entriesFromSubagents(projectRoot, startIndex) {
  const entries = [];
  const dir = join(projectRoot, ".fluxsmith", "turns");
  if (!existsSync(dir)) return entries;
  let callIndex = startIndex;
  const turnDirs = readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b));
  for (const t of turnDirs) {
    const sub = join(dir, t, "subagents");
    if (!existsSync(sub)) continue;
    for (const f of readdirSync(sub).filter((x) => x.endsWith(".json")).sort()) {
      let j;
      try { j = JSON.parse(readFileSync(join(sub, f), "utf8")); } catch { continue; }
      const role = String(j.role ?? basename(f).split("-")[0]);
      const msgs = Array.isArray(j.transcript?.messages) ? j.transcript.messages : Array.isArray(j.messages) ? j.messages : [];
      for (const m of msgs) {
        if (m && m.role === "assistant" && Array.isArray(m.content)) {
          entries.push({ kind: "model", call_index: callIndex++, role, model: String(m.model ?? "history"), context_hash: null, assistant: { ...m, timestamp: 0 } });
        }
      }
    }
  }
  return entries;
}

export function buildRecording({ rows, projectRoot, sessionId }) {
  const { entries, turns, nextIndex } = entriesFromRows(rows);
  const subs = projectRoot ? entriesFromSubagents(projectRoot, nextIndex) : [];
  const meta = { kind: "meta", version: 1, session_id: sessionId, project: projectRoot ? basename(projectRoot) : null, turns, source: "history" };
  return [meta, ...entries, ...subs];
}

export function toJsonlGz(entries) {
  return gzipSync(Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"));
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.session) { console.error("usage: pnpm replay:record <session_id> [--project <root>] [--out <file.jsonl.gz>] [--app-data <dir>]"); process.exit(2); }
  const db = join(appDataDir(args.appData), "fluxsmith.db");
  if (!existsSync(db)) { console.error(`no database at ${db}`); process.exit(2); }
  const rows = sqliteJson(db, `select id, turn, role, content from messages where session_id='${args.session.replace(/'/g, "''")}' order by id`);
  if (!rows.length) { console.error(`session ${args.session} has no messages`); process.exit(2); }
  const entries = buildRecording({ rows, projectRoot: args.project, sessionId: args.session });
  const out = args.out || join(ROOT, "tests", "replay", `${args.session.slice(0, 16)}.jsonl.gz`);
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, toJsonlGz(entries));
  const models = entries.filter((e) => e.kind === "model").length;
  console.log(`replay:record ${out} — ${entries.length} entries (${models} model calls, ${entries[0].turns.length} user turns); source=history (lenient replay)`);
}
