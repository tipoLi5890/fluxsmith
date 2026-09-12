// SPDX-License-Identifier: Apache-2.0
// Developer autorun (`fluxsmith-app --script=<file.json>`): drives one project
// through a scripted conversation so the harness can be dogfooded without a
// human at the keyboard. Cards are answered by fixed rules (approve / adopt /
// default answer); everything that happened lands in `<file>.report.json`.
// This is a developer convenience, not a product feature: it only runs when the
// flag is present on the command line and only touches the script file itself.

import { call, isTauri } from "../ipc/client";
import { bridgeFor } from "./harness-bridge";
import { useProjects } from "../state/projects";
import { resolveSession, newSession, switchSession } from "./sessions";
import type { Card, TurnEvent } from "../agent/api";
import { waiveBatch, waiveConsentSha } from "../agent/review-waiver";
import type { Mode, Policy } from "../ipc/types";

interface Script {
  project: string;
  /** Start a fresh conversation (default true). */
  new_session?: boolean;
  mode?: Mode;
  policy?: Policy;
  /** Seconds to wait for each turn before giving up (default 900). */
  turn_timeout_s?: number;
  /** Seconds of harness silence after a turn before the next message (default 2). */
  settle_s?: number;
  messages: string[];
  /** Card answers by kind: action id, or "first" (first non-destructive action). */
  answers?: Record<string, string>;
  /** Quit the app once the report is written (golden-set runner). */
  exit?: boolean;
}

interface Report {
  started: string;
  finished?: string;
  session_id?: string;
  /** Cards already present right after attach (crash-recovery cards are emitted before any turn). */
  attach_cards?: { kind: string; title: string; text_key?: string }[];
  turns: { message: string; turn: number | null; outcome: string; headline?: string; duration_ms: number; cards: { kind: string; title: string; answered: string }[]; errors: string[]; applied: { added: number; deleted: number; wires: number }[]; trace: string[]; tokens: number; cost_usd: number; turns_seen: number; skipped_steps: string[] }[];
  events: number;
  /** Totals over every message (tokens/cost from `turn_ended` summaries; cards = ones a human would have answered). */
  totals: { tokens: number; cost_usd: number; decision_cards: number; skipped_steps: string[]; applied: { added: number; deleted: number; wires: number } };
  error?: string;
}

const DEFAULT_ANSWERS: Record<string, string> = {
  plan_approval: "adopt_auto", hard_stop: "approve", change: "approve", question: "default", mode_suggestion: "switch",
  waiver: "approve", intent: "accept", lib_import: "approve", cost: "approve", env: "dismiss", parts_decision: "first", compaction: "first", provider_consent: "approve",
  system: "none", rollback: "none",
};

export async function maybeAutorun(): Promise<boolean> {
  if (!isTauri()) return false;
  let text: string | null = null;
  try { text = await call("dev_script_read", {}); } catch { return false; }
  if (!text) return false;
  const script = JSON.parse(text) as Script;
  const report: Report = { started: new Date().toISOString(), turns: [], events: 0, totals: { tokens: 0, cost_usd: 0, decision_cards: 0, skipped_steps: [], applied: { added: 0, deleted: 0, wires: 0 } } };
  const save = () => call("dev_script_report", { text: JSON.stringify(report, null, 2) }).catch(() => undefined);
  // Breadcrumbs in the Rust log: a stuck run can be located to the last step that completed.
  const crumb = (msg: string) => call("log_write", { level: "info", message: `autorun: ${msg}`, req_id: null }).catch(() => undefined);
  // Keep the web process from being suspended. In script runs the window is never visible (occluded or the
  // display asleep); WebKit then parks the page after a few seconds of idleness: JS timers, IPC callbacks and
  // network callbacks all stop until the view becomes visible again (observed as the wait loop freezing while
  // the Rust side sits idle). A page with active audio output is exempt from that suspension, so a silent
  // oscillator runs for the whole script. Dev-only: this function is only reached with `--script=`.
  keepWebProcessAwake(crumb);
  // Watchdog: whatever hangs inside `run`, the report is written and the app exits at the deadline.
  const deadlineMs = ((script.turn_timeout_s ?? 900) * script.messages.length + 60) * 1000;
  const watchdog = setTimeout(() => { void (async () => { report.error = report.error ?? "autorun watchdog: run() did not return"; void crumb("watchdog fired"); await save(); if (script.exit) await call("dev_exit", {}).catch(() => undefined); })(); }, deadlineMs);
  try {
    await run(script, report, save, crumb);
  } catch (e) {
    report.error = String(e);
  }
  clearTimeout(watchdog);
  report.finished = new Date().toISOString();
  void crumb("run() returned; saving final report");
  await save();
  void crumb("final report saved");
  if (script.exit) { try { await call("dev_exit", {}); } catch { /* the window stays open; the runner kills the process */ } }
  return true;
}

async function run(script: Script, report: Report, save: () => Promise<unknown>, crumb?: (msg: string) => Promise<unknown>): Promise<void> {
  const projects = useProjects.getState();
  const tab = await projects.open(script.project);
  if (!tab) {
    const st = useProjects.getState();
    const why = st.identityPrompt ? `PROJECT_MOVED_OR_COPIED (last opened at ${st.identityPrompt.old_path || "?"})` : st.error ?? "unknown";
    throw new Error(`cannot open ${script.project}: ${why}`);
  }
  const key = tab.key;
  const sessionId = script.new_session === false ? await resolveSession(key) : await newSession(key);
  if (!sessionId) throw new Error("no session");
  report.session_id = sessionId;
  await switchSession(key, sessionId);
  const bridge = bridgeFor(key);
  // Wait for the harness to attach.
  await waitFor(() => bridge.getState().ready && !!bridge.getState().harness, 30_000, "harness attach");
  const h = bridge.getState().harness!;
  report.attach_cards = h.state().cards.map((c) => ({ kind: c.kind, title: c.title, text_key: (c.data as { text_key?: string } | undefined)?.text_key }));
  const consent = async (card_kind: string, sha: string) => (await call("consent_record", { event: { project_key: key, card_kind, payload_sha256: sha, input_kind: "auto" } })).id;
  const rootUuid = useProjects.getState().tabs.find((t) => t.key === key)?.info.root_uuid ?? "";
  if (script.policy && h.state().policy !== script.policy) await h.setPolicy(script.policy, script.policy === "auto" ? await consent("policy_auto", rootUuid) : undefined);
  if (script.mode && h.state().mode !== script.mode) await h.setMode(script.mode, script.mode === "build" ? await consent("enter_build", rootUuid) : undefined);

  const answered = new Set<string>();
  const answerCard = async (card: Card, rec: Report["turns"][number]) => {
    if (answered.has(card.id) || card.answered || card.auto || card.actions.length === 0) return;
    answered.add(card.id);
    const rule = script.answers?.[card.kind] ?? DEFAULT_ANSWERS[card.kind] ?? "first";
    if (rule === "none") return;
    let action = card.actions.find((a) => a.id === rule) ?? null;
    if (!action && rule === "default") action = card.actions.find((a) => a.id === "default") ?? card.actions.find((a) => a.style === "primary") ?? null;
    if (!action) action = card.actions.find((a) => a.style !== "destructive") ?? card.actions[0];
    let cid: string | undefined;
    // A waive answer is consented over the rows it waives, the reason and the expiry (`waiveBatch`):
    // the same hash the harness repeats in the grant and Rust checks against (`grant_create`). The
    // card's own declared sha was computed before any row was ticked.
    const waive = card.kind === "review" && action.id === "waive_selected"
      ? waiveBatch((((card.data as { findings?: { code: string; refs?: string[]; location?: string; selected?: boolean }[] })?.findings) ?? []).filter((r) => r.selected), "", null)
      : null;
    if (action.consent) cid = await consent(card.kind, waive ? waiveConsentSha(waive) : action.consent.payload_sha256);
    rec.cards.push({ kind: card.kind, title: card.title, answered: action.id });
    report.totals.decision_cards++;
    await save();
    try { await h.answerCard(card.id, action.id, undefined, cid); } catch (e) { rec.errors.push(`answerCard ${card.kind}: ${String(e)}`); }
  };

  for (const message of script.messages) {
    const rec: Report["turns"][number] = { message, turn: null, outcome: "pending", duration_ms: 0, cards: [], errors: [], applied: [], trace: [], tokens: 0, cost_usd: 0, turns_seen: 0, skipped_steps: [] };
    report.turns.push(rec);
    const t0 = Date.now();
    let ended = false;
    let lastEvent = Date.now();
    let lastTurnStart = Date.now();
    let lastSave = Date.now();
    const unsub = h.subscribe((e: TurnEvent) => {
      report.events++;
      lastEvent = Date.now();
      const tr = (line: string) => { if (rec.trace.length < 2000) rec.trace.push(line.slice(0, 600)); };
      if (e.kind === "budget") tr(`T${e.turn} BUDGET tokens=${e.used.tokens} usd=${e.used.usd.toFixed(4)}`);
      if (e.kind === "turn_started") { rec.turn = e.turn; rec.headline = e.headline; lastTurnStart = Date.now(); tr(`T${e.turn} START ${e.turn_kind} ${e.headline}`); }
      if (e.kind === "activity" && e.line.ended_at) tr(`T${e.turn} ${e.line.role} ${e.line.label} ${e.line.ok === false ? "FAIL" : "ok"} ${e.line.detail ?? ""}`);
      if (e.kind === "status") tr(`T${e.turn} STATUS ${e.text}`);
      if (e.kind === "system") tr(`SYSTEM ${e.text_key} ${JSON.stringify(e.params ?? {})}`);
      if (e.kind === "assistant_done") tr(`T${e.turn} TEXT ${e.text.replace(/\s+/g, " ")}`);
      if (e.kind === "card") tr(`T${e.card.turn} CARD ${e.card.kind} ${e.card.title} ${String(e.card.body_md ?? "").replace(/\s+/g, " ").slice(0, 300)} auto=${e.card.auto?.decision ?? ""}`);
      if (e.kind === "turn_ended") tr(`T${e.summary.turn} END ${e.summary.outcome} ${e.summary.headline}`);
      if (e.kind === "error") rec.errors.push(`${e.error.code}: ${e.error.message}`);
      if (e.kind === "system" && e.severity === "error") rec.errors.push(e.text_key);
      if (e.kind === "applied") { rec.applied.push(e.counts); report.totals.applied.added += e.counts.added; report.totals.applied.deleted += e.counts.deleted; report.totals.applied.wires += e.counts.wires; }
      if (e.kind === "system" && e.text_key === "system.auto_step_skipped") { const step = String(e.params?.step ?? "?"); rec.skipped_steps.push(step); report.totals.skipped_steps.push(step); }
      if (e.kind === "card") void answerCard(e.card, rec);
      if (e.kind === "turn_ended") {
        void crumb?.(`turn ${e.summary.turn} ended ${e.summary.outcome}`);
        rec.outcome = e.summary.outcome; ended = true;
        rec.turns_seen++; rec.tokens += e.summary.tokens ?? 0; rec.cost_usd += e.summary.cost_usd ?? 0;
        report.totals.tokens += e.summary.tokens ?? 0; report.totals.cost_usd += e.summary.cost_usd ?? 0;
      }
    });
    try {
      await h.send({ text: message, refs: [], attachments: [], session_id: sessionId });
      const timeout = (script.turn_timeout_s ?? 900) * 1000;
      // A turn is over when the harness said so and then stayed quiet for a moment
      // (plan adoption enqueues `/run` right after `turn_ended`).
      let ticks = 0;
      while (Date.now() - t0 < timeout) {
        await sleep(500);
        if (++ticks % 4 === 0) void crumb?.(`waiting: tick=${ticks} ended=${ended} running=${h.state().running} quiet_ms=${Date.now() - lastEvent} visibility=${document.visibilityState}`);
        const st = h.state();
        // An adopted plan keeps running by itself (Auto chains the steps): wait until it is done.
        const plan = h.plan();
        const planBusy = !!plan && (plan.status === "approved" || plan.status === "in_progress") && plan.steps.some((x) => x.status === "pending" || x.status === "current");
        if (ended && !st.running && !planBusy && Date.now() - lastEvent > (script.settle_s ?? 2) * 1000) { void crumb?.("turn settled; leaving the wait loop"); break; }
        if (ended && !st.running && planBusy && Date.now() - lastTurnStart > 300_000) { rec.errors.push("plan stalled: no new step for 5 minutes"); break; }
        if (Date.now() - lastSave > 30_000) { lastSave = Date.now(); void crumb?.("periodic save: begin"); await save(); void crumb?.("periodic save: done"); }
        if (ended && st.running) ended = false;
      }
      if (!ended && rec.outcome === "pending") rec.outcome = "timeout";
      if (ended && rec.outcome !== "timeout" && Date.now() - t0 >= timeout) { rec.errors.push("wait loop never settled (events kept arriving or the harness stayed running)"); void crumb?.("wait loop hit the timeout while ended=true"); }
    } catch (e) {
      rec.outcome = "send_failed"; rec.errors.push(String(e));
    } finally {
      unsub();
      rec.duration_ms = Date.now() - t0;
      void crumb?.(`message done: outcome=${rec.outcome} running=${h.state().running}`);
      await save();
    }
    if (rec.outcome === "timeout") { try { await h.stop(); } catch { /* ignore */ } }
  }
}

function keepWebProcessAwake(crumb: (msg: string) => Promise<unknown>): void {
  try {
    const Ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) { void crumb("keep-awake: no AudioContext"); return; }
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    const report = () => void crumb(`keep-awake: audio ${ctx.state}`);
    report();
    ctx.onstatechange = report;
    if (ctx.state !== "running") void ctx.resume().then(report, () => report());
  } catch (e) {
    void crumb(`keep-awake: failed ${String(e).slice(0, 120)}`);
  }
}

/** Waits on the Rust side: WebKit parks this page's DOM timers once the window is occluded for a while (the
 *  wait loop froze mid-run in golden runs), but IPC round-trips keep working. Falls back to a DOM timer only
 *  if the command is unavailable. */
async function sleep(ms: number): Promise<void> {
  try { await call("dev_sleep", { ms }); } catch { await new Promise((r) => setTimeout(r, ms)); }
}
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(100); }
}
