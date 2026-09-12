#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Golden-set runner with the real model: for every task (x N runs) it creates a
// fresh KiCad project, drives the app through `--script=` autorun (Build + Auto),
// waits for the report, scores the result with `fluxsmith-cli golden match`
// (+ `fluxsmith-cli check`, kicad-cli ERC when installed) and collects tokens /
// cost from the `model_calls` table. Output: `tests/golden-set/runs/<date>.json`
// in the baseline shape of docs/operations-misc.md §5, plus a markdown summary.
//
//   pnpm golden:run --tasks rc_lowpass,ldo_3v3 --n 1 --budget-usd 5
//   pnpm golden:run --subset nightly --n 3        # per-task pass/N, cards median/p90, hard stops
//
// Needs a configured provider (secrets.json) and the debug app/CLI built.
// Never runs kicad-cli while the app still has the project open (locks).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KICAD_CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";
/** Task weights: tests/golden-set/weights.json (README G-weights; unlisted tasks weigh 1). */
const WEIGHTS = loadWeights();
/** `--subset nightly`: the cheap three-task smoke the CI nightly job runs. */
export const SUBSETS = { nightly: ["rc_lowpass", "decoupling_3v3", "ldo_3v3"] };

function loadWeights() {
  try { return JSON.parse(readFileSync(join(ROOT, "tests", "golden-set", "weights.json"), "utf8")).weights ?? {}; } catch { return {}; }
}

// ------------------------------------------------------------------ pure helpers (unit-tested)

/** Parse `--k v` / `--k=v` / `--flag` argv into an object. */
export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

/** Same derivation as src-tauri/src/project.rs `project_key`. */
/** task.md -> one message per block separated by a `---` line; headings are dropped, lines of a block are joined. */
export function splitTaskMessages(text) {
  return text.split(/^---\s*$/m).map((blk) => blk.split("\n").filter((l) => l.trim() && !l.startsWith("#")).join(" ").trim()).filter(Boolean);
}

/** Copy a fixture project (a .kicad_pro with its sheets) into `dir`; returns the same shape as `fluxsmith-cli new`. */
export function copyFixture(fixtureDir, dir) {
  const files = readdirSync(fixtureDir).filter((f) => !f.startsWith("."));
  const pro = files.find((f) => f.endsWith(".kicad_pro"));
  if (!pro) return null;
  // Every run gets a fresh root uuid (rewritten consistently in all sheets, including symbol instance paths):
  // the app identifies projects by root uuid, and a second copy of the same fixture would otherwise open as a
  // "moved or copied project" question instead of running the script.
  const rootName = pro.replace(/\.kicad_pro$/, ".kicad_sch");
  const oldUuid = /\(uuid "([0-9a-f-]+)"\)/.exec(readFileSync(join(fixtureDir, rootName), "utf8"))?.[1] ?? "";
  const uuid = randomUUID();
  for (const f of files) {
    const raw = readFileSync(join(fixtureDir, f));
    if (oldUuid && /\.kicad_(sch|pro)$/.test(f)) writeFileSync(join(dir, f), raw.toString("utf8").split(oldUuid).join(uuid));
    else writeFileSync(join(dir, f), raw);
  }
  const rootSch = join(dir, rootName);
  // Same shape as `fluxsmith-cli new`: `root` is the root schematic file (kicad-cli erc and the matcher take it).
  // `fixture_uuid` is the uuid the fixture carries, so the edit contract can undo the rewrite before diffing.
  return { root: rootSch, project: join(dir, pro), root_uuid: uuid, fixture_uuid: oldUuid };
}

// ------------------------------------------------------------------ edit contract (expected.changed / untouched_lines)

/** Every `applies[].changed` entry of every `turn.json` under `<project>/.fluxsmith/turns/<n>/`, in turn order. */
export function turnChanges(projectDir) {
  const dir = join(projectDir, ".fluxsmith", "turns");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const n of readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b))) {
    const p = join(dir, n, "turn.json");
    const t = existsSync(p) ? json(readFileSync(p, "utf8")) : null;
    for (const a of t?.applies ?? []) for (const c of a.changed ?? []) out.push({ ...c, turn: Number(n) });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `R*` matches any resistor: the golden set never pins refdes, the model picks them. */
function refMatches(pattern, reference) {
  return new RegExp(`^${String(pattern).split("*").map(escapeRe).join(".*")}$`, "i").test(String(reference ?? ""));
}

/**
 * `expected.changed`: `[{ref, field, before?, after?}]`, each of which the engine must have reported under
 * `turn.json.applies[].changed` (the only record of what an edit turn replaced). Returns the misses.
 */
export function changedProblems(expectedChanged, changed) {
  const problems = [];
  for (const e of expectedChanged ?? []) {
    const hit = (changed ?? []).some((c) => refMatches(e.ref, c.reference) && c.field === e.field && (e.before === undefined || c.before === e.before) && (e.after === undefined || c.after === e.after));
    if (!hit) problems.push(`changed ${e.ref} ${e.field} ${e.before ?? "*"} -> ${e.after ?? "*"}: not reported by the engine`);
  }
  return problems;
}

/** Lines only in `a` (removed) and only in `b` (added), by longest common subsequence; the files are small. */
export function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [], added = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { removed, added };
}

/**
 * `untouched_lines: true`: after undoing the root-uuid rewrite, the output may differ from the fixture only in
 * the lines the expected changes account for -- a fixture line carrying `"<field>" "<before>"` and an output
 * line carrying `"<field>" "<after>"`. Anything else that differs (a title block, a moved part, a re-serialised
 * node) is a problem: "do not move or redraw anything else" is part of the task.
 */
export function untouchedLinesProblems(fixtureText, outputText, expectedChanged, uuids = {}) {
  const normalised = uuids.output_uuid && uuids.fixture_uuid ? outputText.split(uuids.output_uuid).join(uuids.fixture_uuid) : outputText;
  const { removed, added } = lineDiff(fixtureText.split("\n"), normalised.split("\n"));
  const explains = (line, value) => (expectedChanged ?? []).some((e) => e[value] !== undefined && line.includes(`"${e.field}" "${e[value]}"`));
  const problems = [];
  for (const l of removed) if (!explains(l, "before")) problems.push(`untouched_lines: fixture line changed: ${l.trim()}`);
  for (const l of added) if (!explains(l, "after")) problems.push(`untouched_lines: line added or rewritten: ${l.trim()}`);
  return problems.slice(0, 12);
}

/** The edit contract of one run: `expected.changed` against the turn records, `untouched_lines` against the fixture. */
export function editContractProblems(expected, projectDir, created, fixtureDir) {
  const problems = [];
  if (Array.isArray(expected?.changed) && expected.changed.length) problems.push(...changedProblems(expected.changed, turnChanges(projectDir)));
  if (expected?.untouched_lines && fixtureDir && existsSync(fixtureDir)) {
    for (const f of readdirSync(fixtureDir).filter((x) => x.endsWith(".kicad_sch"))) {
      const out = join(projectDir, f);
      if (!existsSync(out)) { problems.push(`untouched_lines: ${f} missing from the output`); continue; }
      problems.push(...untouchedLinesProblems(readFileSync(join(fixtureDir, f), "utf8"), readFileSync(out, "utf8"), expected.changed ?? [], { output_uuid: created?.root_uuid, fixture_uuid: created?.fixture_uuid }));
    }
  }
  return problems;
}

export function projectKey(rootUuid, rootPath) {
  return createHash("sha256").update(`${rootUuid}|${rootPath}`).digest("hex").slice(0, 32);
}

/** Count ERC violations by severity from a kicad-cli `sch erc --format json` report. */
/**
 * Count ERC violations by severity. `allowedTypes` (policy.json `erc_allowed_types`) names KiCad violation
 * types a task accepts by construction, e.g. `power_pin_not_driven` on a standalone block whose supply rail is
 * fed from outside the drawing; they are counted under `allowed` instead of `errors` / `warnings`.
 */
export function ercCounts(report, allowedTypes = []) {
  const allowed = new Set(allowedTypes);
  const out = { errors: 0, warnings: 0, allowed: 0, by_type: {} };
  for (const s of report?.sheets ?? []) {
    for (const v of s.violations ?? []) {
      if (v.excluded) continue;
      out.by_type[v.type] = (out.by_type[v.type] ?? 0) + 1;
      if (allowed.has(v.type)) { out.allowed++; continue; }
      if (v.severity === "error") out.errors++;
      else if (v.severity === "warning") out.warnings++;
    }
  }
  return out;
}

/** One run's score: the matcher's `score` when present, else 1/0 from `ok`. */
export function runScore(match) {
  if (!match) return 0;
  if (typeof match.score === "number" && Number.isFinite(match.score)) return Math.max(0, Math.min(1, match.score));
  return match.ok ? 1 : 0;
}

/** Lower-nearest-rank quantile of a numeric list (median = 0.5, p90 = 0.9); 0 for an empty list. */
export function quantile(values, q) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))];
}

/**
 * Aggregate per-task run records into the baseline shape and the weighted set score.
 * With N > 1 the per-task record also carries `pass` (runs with ok), `pass_rate`,
 * `decision_cards_median` / `_p90`, `hard_stops` (total hard-stop cards) and `zero`
 * (0/N: the README's "no task at 0/N" abort-line clause).
 */
export function aggregate(runs, weights = WEIGHTS) {
  const perTask = {};
  for (const r of runs) {
    const t = (perTask[r.task] ??= { score: 0, ok: 0, runs: 0, decision_cards: 0, skipped_steps: 0, erc_errors: 0, erc_warnings: 0, tokens: 0, cost_usd: 0, cache_hit_ratio: 0, duration_s: 0, problems: [], hard_stops: 0, timeouts: 0, cards_per_run: [] });
    t.runs++;
    t.score += r.score;
    if (r.ok) t.ok++;
    t.decision_cards += r.decision_cards ?? 0;
    t.cards_per_run.push(r.decision_cards ?? 0);
    t.hard_stops += r.hard_stops ?? 0;
    if (r.timed_out) t.timeouts++;
    t.skipped_steps += r.skipped_steps ?? 0;
    t.erc_errors += r.erc_errors ?? 0;
    t.erc_warnings += r.erc_warnings ?? 0;
    t.tokens += r.tokens ?? 0;
    t.cost_usd += r.cost_usd ?? 0;
    t.cache_hit_ratio += r.cache_hit_ratio ?? 0;
    t.duration_s += r.duration_s ?? 0;
    for (const p of r.problems ?? []) if (!t.problems.includes(p)) t.problems.push(p);
  }
  let wsum = 0; let acc = 0; let passAcc = 0; let hardStops = 0; const zero = [];
  const allCards = [];
  for (const [id, t] of Object.entries(perTask)) {
    t.score = t.runs ? t.score / t.runs : 0;
    t.cache_hit_ratio = t.runs ? t.cache_hit_ratio / t.runs : 0;
    t.pass = t.ok;
    t.pass_rate = t.runs ? t.ok / t.runs : 0;
    t.decision_cards_median = quantile(t.cards_per_run, 0.5);
    t.decision_cards_p90 = quantile(t.cards_per_run, 0.9);
    t.zero = t.runs > 0 && t.ok === 0;
    if (t.zero) zero.push(id);
    allCards.push(...t.cards_per_run);
    delete t.cards_per_run;
    hardStops += t.hard_stops;
    const w = weights[id] ?? 1;
    t.weight = w;
    wsum += w; acc += w * t.score; passAcc += w * t.pass_rate;
  }
  return {
    per_task: perTask,
    weighted: wsum ? acc / wsum : 0,
    weighted_pass_rate: wsum ? passAcc / wsum : 0,
    decision_cards_median: quantile(allCards, 0.5),
    decision_cards_p90: quantile(allCards, 0.9),
    hard_stops: hardStops,
    zero_tasks: zero,
  };
}

/** Markdown table for the console / review notes. */
export function summaryMarkdown(result) {
  const rows = Object.entries(result.per_task).map(([id, t]) => `| ${id} | ${t.ok}/${t.runs} | ${t.score.toFixed(2)} | ${t.erc_errors}/${t.erc_warnings} | ${t.decision_cards_median ?? t.decision_cards}/${t.decision_cards_p90 ?? t.decision_cards} | ${t.hard_stops ?? 0} | ${t.skipped_steps} | ${Math.round(t.tokens / 1000)}k | ${t.cost_usd.toFixed(3)} | ${Math.round(t.duration_s)}s |`);
  const abort = result.weighted_pass_rate !== undefined
    ? `abort line: weighted pass ${result.weighted_pass_rate.toFixed(2)} (need >= 0.70), cards median/p90 ${result.decision_cards_median}/${result.decision_cards_p90}, hard stops ${result.hard_stops} (need <= 15), 0/N tasks: ${result.zero_tasks?.length ? result.zero_tasks.join(", ") : "none"}`
    : null;
  return [
    `# golden run ${result.recorded_at} (model ${result.model_id ?? "?"}, weighted ${result.weighted.toFixed(3)}, total USD ${result.cost_usd.toFixed(3)})`,
    "",
    ...(abort ? [abort, ""] : []),
    "| task | pass | score | erc err/warn | cards med/p90 | hard stops | skipped | tokens | usd | time |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...(result.timed_out?.length ? ["timed out (subagent transcripts under <project>/.fluxsmith/turns/<n>/subagents/):", ...result.timed_out.map((r) => `- ${r.task} #${r.run + 1}: ${r.project}/.fluxsmith/turns`), ""] : []),
    ...Object.entries(result.per_task).flatMap(([id, t]) => (t.problems.length ? [`- ${id}: ${t.problems.slice(0, 4).join("; ")}`] : [])),
  ].join("\n");
}

// ------------------------------------------------------------------ process helpers

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
function json(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDataDir() {
  return process.env.FLUXSMITH_APP_DATA || join(homedir(), "Library", "Application Support", "fluxsmith");
}

function readSettings() {
  return json(existsSync(join(appDataDir(), "settings.json")) ? readFileSync(join(appDataDir(), "settings.json"), "utf8") : "{}", {}) ?? {};
}

/** tokens / cost for one project from the app's SQLite (sqlite3 CLI; no npm deps). */
function modelCalls(key) {
  const db = join(appDataDir(), "fluxsmith.db");
  if (!existsSync(db)) return { tokens: 0, cost_usd: 0, cache_hit_ratio: 0, calls: 0 };
  const q = `select coalesce(sum(input),0), coalesce(sum(cache_creation),0), coalesce(sum(cache_read),0), coalesce(sum(output),0), coalesce(sum(cost_usd),0), count(*) from model_calls where project_key='${key}';`;
  const r = sh("sqlite3", [db, q]);
  const [input, cw, cr, output, cost, calls] = (r.out.trim().split("|").map(Number));
  const denom = input + cw + cr;
  return { tokens: input + cw + cr + output, input, cache_creation: cw, cache_read: cr, output, cost_usd: cost, cache_hit_ratio: denom ? cr / denom : 0, calls };
}

function gitSha(path) { const r = sh("git", ["log", "-1", "--format=%h", "--", path], { cwd: ROOT }); return r.out.trim() || null; }

/** `turn_end` entries in the project journal (Rust writes one when a turn finishes): newest timestamp and count. */
function journalTurnEnds(journalPath) {
  if (!existsSync(journalPath)) return { last: null, count: 0 };
  let last = null;
  let count = 0;
  for (const line of readFileSync(journalPath, "utf8").split("\n")) {
    if (!line.includes('"kind":"turn_end"')) continue;
    const j = json(line);
    if (j?.ts) { last = Date.parse(j.ts); count++; }
  }
  return { last, count };
}

/**
 * Wait for the autorun report. Completion is also accepted from the Rust side: when the journal holds a
 * `turn_end` for every scripted message and the newest one is a settle period old, the harness finished even
 * if the webview never saved its final report. A run whose later turn is still open is never cut short here;
 * it runs into the timeout instead, so a stalled webview shows up as `timed_out`, not as a finished run.
 */
async function waitForReport(reportPath, child, timeoutMs, journalPath, expectedTurns, settleMs = 15_000) {
  const t0 = Date.now();
  const read = () => (existsSync(reportPath) ? json(readFileSync(reportPath, "utf8")) : null);
  while (Date.now() - t0 < timeoutMs) {
    const rep = read();
    if (rep && rep.finished) return rep;
    if (child.exitCode !== null && rep) return rep;
    const ended = journalPath ? journalTurnEnds(journalPath) : { last: null, count: 0 };
    if (ended.last && ended.count >= expectedTurns && Date.now() - ended.last > settleMs && rep) {
      return { ...rep, finished: rep.finished ?? new Date(ended.last).toISOString(), finished_by: "journal" };
    }
    await sleep(2000);
  }
  return read();
}

async function killApp(child) {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  // The app watcher may linger a moment; give the lock/prl files time to vanish.
  await sleep(1000);
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2), { n: "1", "budget-usd": "5", "timeout-s": "1500", app: "target/debug/fluxsmith-app", cli: "target/debug/fluxsmith-cli" });
  const tasksDir = join(ROOT, "tests", "golden-set", "tasks");
  const all = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "task.md")));
  const subset = args.subset ? SUBSETS[String(args.subset)] : null;
  if (args.subset && !subset) { console.error(`unknown subset ${args.subset}; known: ${Object.keys(SUBSETS).join(", ")}`); process.exit(2); }
  const tasks = args.tasks ? String(args.tasks).split(",").map((s) => s.trim()).filter(Boolean) : (subset ?? all);
  const n = Math.max(1, Number(args.n) || 1);
  const budget = Number(args["budget-usd"]) || 5;
  const timeoutMs = (Number(args["timeout-s"]) || 1500) * 1000;
  const app = join(ROOT, String(args.app));
  const cli = join(ROOT, String(args.cli));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = args.out ? String(args.out) : join(ROOT, "tests", "golden-set", "runs", `${stamp}.json`);
  for (const t of tasks) if (!all.includes(t)) { console.error(`unknown task ${t}; known: ${all.join(", ")}`); process.exit(2); }
  if (!existsSync(app) || !existsSync(cli)) { console.error(`build first: ${app} / ${cli}`); process.exit(2); }
  if (sh("pgrep", ["-f", basename(app)]).out.trim()) { console.error("fluxsmith-app is already running; close it first"); process.exit(2); }

  const settings = readSettings();
  const modelId = settings?.models_by_role?.lead ?? null;
  const work = mkdtempSync(join(tmpdir(), "fluxsmith-golden-"));
  const runs = [];
  let spent = 0;
  let stopped = null;

  outer: for (const task of tasks) {
    // task.md: one message per paragraph block separated by a line `---` (a multi-turn task); headings are dropped.
    const messages = splitTaskMessages(readFileSync(join(tasksDir, task, "task.md"), "utf8"));
    const prompt = messages[0] ?? "";
    const policy0Path = join(tasksDir, task, "policy.json");
    const policy0 = existsSync(policy0Path) ? (json(readFileSync(policy0Path, "utf8")) ?? {}) : {};
    const fixtureDir = join(tasksDir, task, "fixture");
    for (let i = 0; i < n; i++) {
      if (spent > budget) { stopped = `budget exhausted (USD ${spent.toFixed(2)} > ${budget})`; break outer; }
      const dir = join(work, `${task}-${i}`);
      mkdirSync(dir, { recursive: true });
      // A task with a fixture/ folder edits an existing design: copy it in instead of creating an empty project.
      const created = existsSync(fixtureDir) ? copyFixture(fixtureDir, dir) : json(sh(cli, ["new", dir, task]).out);
      if (!created?.root) { runs.push({ task, run: i, ok: false, score: 0, problems: ["project creation failed"] }); continue; }
      // The app canonicalises the root (macOS tmp is a /private symlink): hash the real path.
      const key = projectKey(created.root_uuid, realpathSync(dir));
      const scriptPath = join(dir, "run.json");
      writeFileSync(scriptPath, JSON.stringify({ project: created.project, new_session: true, mode: policy0.mode ?? "build", policy: policy0.policy ?? "auto", turn_timeout_s: Math.floor(timeoutMs / 1000), settle_s: 4, messages, ...(policy0.answers ? { answers: policy0.answers } : {}), exit: true }, null, 2));
      const t0 = Date.now();
      process.stderr.write(`[golden] ${task} #${i + 1}/${n} ...\n`);
      const child = spawn(app, [`--script=${scriptPath}`], { stdio: "ignore", detached: false });
      const report = await waitForReport(join(dir, "run.report.json"), child, timeoutMs * messages.length + 60_000, join(dir, ".fluxsmith", "journal.jsonl"), messages.length);
      const timed_out = !report?.finished;
      if (timed_out) process.stderr.write(`[golden] ${task} #${i + 1}: timed out; subagent transcripts: ${dir}/.fluxsmith/turns/<n>/subagents/\n`);
      if (report?.finished_by === "journal") process.stderr.write(`[golden] ${task} #${i + 1}: finished per the Rust journal (the webview did not report back)\n`);
      await killApp(child);
      const duration_s = (Date.now() - t0) / 1000;
      const policyPath = join(tasksDir, task, "policy.json");
      const policy = existsSync(policyPath) ? (json(readFileSync(policyPath, "utf8")) ?? {}) : {};
      const ercAllowed = Number(policy.erc_errors_allowed ?? 0) || 0;
      const ercOk = () => erc.errors !== null && erc.errors !== undefined && erc.errors <= ercAllowed;
      const match = json(sh(cli, ["golden", "match", join(tasksDir, task, "expected.json"), created.root, "--score"]).out) ?? json(sh(cli, ["golden", "match", join(tasksDir, task, "expected.json"), created.root]).out);
      // The edit contract (expected.changed / untouched_lines) is asserted here, over the turn records and the
      // fixture; the Rust matcher only sees the resulting netlist.
      const contract = editContractProblems(json(readFileSync(join(tasksDir, task, "expected.json"), "utf8"), {}), dir, created, fixtureDir);
      const check = json(sh(cli, ["check", created.root, "--json"]).out) ?? json(sh(cli, ["check", created.root]).out);
      let erc = { errors: null, warnings: null, by_type: {} };
      if (existsSync(KICAD_CLI)) {
        const ercPath = join(dir, "erc.json");
        sh(KICAD_CLI, ["sch", "erc", "-o", ercPath, "--format", "json", created.root]);
        if (existsSync(ercPath)) erc = ercCounts(json(readFileSync(ercPath, "utf8")), Array.isArray(policy.erc_allowed_types) ? policy.erc_allowed_types : []);
      }
      const usage = modelCalls(key);
      // Providers without configured rates (e.g. Codex OAuth) record cost 0; tokens from the report
      // are the fallback when the DB rows are missing.
      if (!usage.tokens && report?.totals?.tokens) usage.tokens = report.totals.tokens;
      if (!usage.cost_usd && report?.totals?.cost_usd) usage.cost_usd = report.totals.cost_usd;
      spent += usage.cost_usd;
      const rec = {
        task, run: i, project: dir, project_key: key,
        // KiCad ERC errors fail the run regardless of the matcher (check_clean is a critical assertion), except the
        // number a scaffold task declares in its policy.json (an empty sub-sheet with pins is red by construction).
        ok: !!match?.ok && ercOk() && contract.length === 0, score: !ercOk() ? 0 : runScore(match), problems: [...(match?.problems ?? (match ? [] : ["matcher produced no output"])), ...contract, ...(!ercOk() ? [erc.errors === null ? "kicad-cli erc produced no report" : `kicad-cli erc: ${erc.errors} error(s) (allowed ${ercAllowed})`] : [])],
        gate_ok: check?.ok ?? null,
        erc_errors: erc.errors, erc_warnings: erc.warnings, erc_by_type: erc.by_type,
        decision_cards: report?.totals?.decision_cards ?? (report?.turns ?? []).reduce((a, t) => a + (t.cards?.length ?? 0), 0),
        skipped_steps: report?.totals?.skipped_steps?.length ?? 0,
        hard_stops: (report?.turns ?? []).reduce((a, t) => a + (t.cards ?? []).filter((c) => c.kind === "hard_stop").length, 0),
        timed_out,
        transcripts: timed_out ? join(dir, ".fluxsmith", "turns") : null,
        outcome: report?.turns?.[0]?.outcome ?? (report ? "no-turn" : "no-report"),
        errors: (report?.turns ?? []).flatMap((t) => t.errors ?? []).slice(0, 10),
        tokens: usage.tokens, cost_usd: usage.cost_usd, cache_hit_ratio: usage.cache_hit_ratio, calls: usage.calls,
        duration_s,
      };
      runs.push(rec);
      process.stderr.write(`[golden] ${task} #${i + 1}: ok=${rec.ok} score=${rec.score.toFixed(2)} erc=${rec.erc_errors}/${rec.erc_warnings} cards=${rec.decision_cards} skipped=${rec.skipped_steps} tokens=${rec.tokens} usd=${rec.cost_usd.toFixed(3)} ${Math.round(duration_s)}s\n`);
    }
  }

  const agg = aggregate(runs);
  const result = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    app_version: json(sh(cli, ["capabilities"]).out)?.version ?? null,
    model_id: modelId,
    thinking_level: settings?.agent?.thinking_level ?? null,
    skills_sha: gitSha("skills"),
    repo_sha: sh("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).out.trim() || null,
    kicad_cli: existsSync(KICAD_CLI) ? (sh(KICAD_CLI, ["version"]).out.trim() || "present") : null,
    n, budget_usd: budget, cost_usd: spent, stopped,
    per_task: agg.per_task, weighted: agg.weighted,
    weighted_pass_rate: agg.weighted_pass_rate, decision_cards_median: agg.decision_cards_median, decision_cards_p90: agg.decision_cards_p90,
    hard_stops: agg.hard_stops, zero_tasks: agg.zero_tasks,
    weights: WEIGHTS, subset: args.subset ?? null,
    timed_out: runs.filter((r) => r.timed_out).map((r) => ({ task: r.task, run: r.run, project: r.project })),
    runs,
    work_dir: work,
  };
  mkdirSync(join(ROOT, "tests", "golden-set", "runs"), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(summaryMarkdown(result));
  // Printed relative to the repo: these summaries get committed, and an absolute
  // path would carry whoever ran it into the log.
  console.log(`\nwritten ${relative(ROOT, outPath) || outPath}\nprojects kept under ${work} (delete when done)`);
  if (args.clean) rmSync(work, { recursive: true, force: true });
}

if (process.argv[1] && basename(process.argv[1]) === "golden-run.mjs") {
  main().catch((e) => { console.error(e); process.exit(1); });
}
