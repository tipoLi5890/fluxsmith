// SPDX-License-Identifier: Apache-2.0
// Harness entry point: `createHarness()` returns the `HarnessApi` the UI
// talks to. Wires settings, skills, persistence, the net shim and the Lead.

import { createCardWaiter } from "./card-wait";
import type { TurnKind } from "../ipc/types";
import { nowIso } from "./util";
import type { HMessage } from "./context/assembler";
import { detectReplyLanguage } from "./lang";
import { call as ipcCall } from "../ipc/client";
import { call, IpcFailure, onAppEvent } from "../ipc/client";
import type { AppEvent, IpcError, Mode, PendingCardFile, Policy, ProjectInfo, Settings } from "../ipc/types";
import type { Card, CardAction, HarnessApi, HarnessState, Ref, Role, TurnEvent, UserMessage, ReplayItem, ThinkingLevel } from "./api";
import { LeadLoop } from "./lead";
import { installNetShim } from "./net-shim";
import { Persistence, type TurnRoleUsage } from "./persistence";
import { applyOpenQuestionAnswers, parseOpenQuestionAnswers, type DesignPlan } from "./plans/schema";
import { SkillRegistry } from "./skills/registry";
import { MANIFEST_VERSION } from "./tools/manifest";
import { rollbackImpact, summaryOf, type TurnRecord } from "./turns/state";
import { canonicalJson, sha256Hex } from "./util";
import { rollbackDoneCard, systemCard } from "./cards";
import { applyPartsDecision } from "./tools/parts-decision";
import { normalizeExpiry, parseWaivePayload, waiveBatch, waiveConsentSha, waiverRefs, withWaivedIds } from "./review-waiver";

/** Approval identity of a plan: everything but `display` (status / progress change while the plan runs; the approved content does not). */
function planIdentitySha(p: DesignPlan): string {
  const { display: _display, ...rest } = p as DesignPlan & { display?: unknown };
  return sha256Hex(canonicalJson(rest));
}

export type { HarnessApi, TurnEvent, Card } from "./api";
export { MANIFEST_VERSION } from "./tools/manifest";

const BUILTIN_ORIGINS: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  google: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai",
  xai: "https://api.x.ai",
  groq: "https://api.groq.com",
  mistral: "https://api.mistral.ai",
  "openai-codex": "https://chatgpt.com",
};

function originFor(p: Settings["providers"][number]): string | null {
  try { return p.base_url ? new URL(p.base_url).origin : BUILTIN_ORIGINS[p.kind] ?? null; } catch { return BUILTIN_ORIGINS[p.kind] ?? null; }
}

/** Scans already turned into cards (keyed by project + scan time), so re-attaching a session does not repeat them. */
const recoveryShown = new Set<string>();
/** The card built for a scan, re-emitted on later attaches (session switch) until answered. */
const recoveryCardCache = new Map<string, Card>();

/** Cards for a Rust recovery report: one `system.recovered` listing what was cleaned / confirmed / needs review. */
export function recoveryCards(project: ProjectInfo, shown: Set<string> = new Set()): Card[] {
  const rep = project.recovery;
  if (!rep) return [];
  const key = `${project.key}@${rep.scanned_at}`;
  if (shown.has(key)) {
    const cached = recoveryCardCache.get(key);
    return cached && !cached.answered ? [cached] : [];
  }
  shown.add(key);
  const review = rep.steps.filter((s) => s.verdict === "needs_review");
  const confirmed = rep.steps.filter((s) => s.verdict === "done_confirmed");
  const orphans = rep.steps.filter((s) => s.verdict === "orphan_cleaned");
  if (!rep.cleaned.length && !review.length && !confirmed.length && !orphans.length && rep.turn === null) return [];
  const turn = rep.turn ?? project.last_turn;
  const lines: string[] = [];
  for (const c of rep.cleaned) lines.push(`- ${c.kind}: \`${c.path}\``);
  for (const s of confirmed) lines.push(`- turn ${s.turn} step ${s.step}: applied, files match`);
  for (const s of orphans) lines.push(`- turn ${s.turn} step ${s.step}: never committed, files unchanged`);
  for (const s of review) for (const f of s.files) lines.push(`- turn ${s.turn} step ${s.step}: \`${f.path}\` ${f.matches ? "matches" : "differs from the recorded sha"}`);
  const actions: CardAction[] = [];
  if (review.length && turn > 0) actions.push({ id: "rollback", label_key: "card.rollback_before_turn", style: "destructive", consent: { grant_kind: "rollback", payload_sha256: sha256Hex(canonicalJson({ turn })) } });
  // crash-recovery.md §3 "building-apply": the other way out of a sha mismatch is to keep the files as
  // they are and close the step in the ledger (`done {recovered, kept}`), so the next scan is clean.
  if (review.length) actions.push({ id: "keep", label_key: "card.keep_files", style: "secondary" });
  actions.push({ id: "dismiss", label_key: "card.dismiss", style: "secondary" });
  const card = systemCard(turn, "system.recovered", { turn, phase: rep.phase_at_interrupt ?? "", cleaned: rep.cleaned.length, confirmed: confirmed.length, review: review.length, report: rep }, actions);
  card.body_md = lines.join("\n");
  recoveryCardCache.set(key, card);
  return [card];
}

/** Re-issue of a persisted pending card after a restart: a fresh id, no grant; the human can re-run the turn or roll back. */
export function pendingResumeCard(pc: PendingCardFile): Card {
  const orig = (pc.card ?? {}) as Partial<Card>;
  const actions: CardAction[] = [
    { id: "resume_turn", label_key: "card.resume_turn", style: "primary" },
    { id: "rollback", label_key: "card.rollback_before_turn", style: "destructive", consent: { grant_kind: "rollback", payload_sha256: sha256Hex(canonicalJson({ turn: pc.turn })) } },
    { id: "dismiss", label_key: "card.dismiss", style: "secondary" },
  ];
  const card = systemCard(pc.turn, "system.recovered_pending_card", { turn: pc.turn, step: pc.step, kind: orig.kind ?? "card", title: orig.title ?? "", condition: pc.condition ?? "", pending: pc }, actions);
  card.body_md = "";
  return card;
}

const RESTORE_TURNS_MAX = 200;

/** Read the persisted turn records (newest RESTORE_TURNS_MAX), tolerating missing or malformed files. */
export async function restoreTurns(persistence: Persistence, lastTurn: number): Promise<TurnRecord[]> {
  const from = Math.max(1, lastTurn - RESTORE_TURNS_MAX + 1);
  const nums: number[] = [];
  for (let n = from; n <= lastTurn; n++) nums.push(n);
  const raw = await Promise.all(nums.map((n) => persistence.readTurn(n).catch(() => null)));
  const out: TurnRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const t = r as Partial<TurnRecord>;
    if (typeof t.turn !== "number" || typeof t.status !== "string") continue;
    out.push({
      ...t,
      turn: t.turn, status: t.status, task: t.task ?? 0, message: t.message ?? "", refs: Array.isArray(t.refs) ? t.refs : [], mode: t.mode ?? "plan",
      kind: t.kind ?? null, headline: t.headline ?? "", envelope: t.envelope ?? null, plan_ref: t.plan_ref ?? null, plan_step: t.plan_step ?? null,
      tools: Array.isArray(t.tools) ? t.tools : [], applies: Array.isArray(t.applies) ? t.applies : [], findings: Array.isArray(t.findings) ? t.findings : [],
      wall_active_ms: t.wall_active_ms ?? 0, wall_waiting_ms: t.wall_waiting_ms ?? 0,
      cost: t.cost ?? { tokens: 0, usd: 0, input: 0, cache_creation: 0, cache_read: 0, output: 0 },
      side_questions: Array.isArray(t.side_questions) ? t.side_questions : [], auto_decisions: Array.isArray(t.auto_decisions) ? t.auto_decisions : [],
      checkpoint: t.checkpoint ?? null, started_at: t.started_at ?? "",
      gen: undefined, // a restored record belongs to no live loop generation
    } as TurnRecord);
  }
  return out.sort((a, b) => a.turn - b.turn);
}

export function createHarness(): HarnessApi {
  let settings: Settings | null = null;
  let projectKey: string | null = null;
  let sessionId: string | null = null;
  let project: ProjectInfo | null = null;
  let lead: LeadLoop | null = null;
  let persistence: Persistence | null = null;
  /**
   * Per-role model usage of the turns that existed when this session was attached, read once from
   * `model_calls`. `replay()` turns each row into the `usage` event the live turn emitted, so a
   * restored turn footer shows the same split and cache ratio. Turns run after the attach are not
   * in this snapshot, so their live `usage` events are never counted twice.
   */
  let restoredUsage: TurnRoleUsage[] = [];
  const skills = new SkillRegistry({
    list: (pk) => call("skills_list", { project_key: pk }),
    read: (pack, path) => call("skills_read", { pack, path }),
  });
  const listeners = new Set<(e: TurnEvent) => void>();
  const cards = new Map<string, Card>();
  // Answers may arrive before the tool registers its waiter (an automated answerer reacts to the card event
  // within the same tick): the waiter keeps them, so a question card can never strand the turn.
  const waiter = createCardWaiter();
  const pending = { has: (id: string) => waiter.has(id), delete: (id: string) => waiter.dismiss(id) };
  let unlistenApp: (() => void) | null = null;

  const emit = (e: TurnEvent) => {
    if (e.kind === "error") void ipcCall("log_write", { level: "error", message: `harness error turn=${e.turn ?? "-"} ${e.error.code}: ${e.error.message}`, req_id: e.error.req_id || null }).catch(() => undefined);
    if (e.kind === "card") cards.set(e.card.id, e.card);
    if (e.kind === "card_answered") { const c = cards.get(e.card_id); if (c) c.answered = { action_id: e.action_id, at: new Date().toISOString(), ...(e.free_text ? { free_text: e.free_text } : {}) }; }
    for (const l of listeners) { try { l(e); } catch { /* listener errors never break the loop */ } }
  };

  const getSettings = (): Settings => {
    if (!settings) throw new Error("harness not attached");
    return settings;
  };

  installNetShim({
    origins: () => {
      const m = new Map<string, string>();
      for (const p of settings?.providers ?? []) { if (!p.enabled) continue; const o = originFor(p); if (o) m.set(o, p.id); }
      return m;
    },
  });

  const showCard = (card: Card) => waiter.show(card.id);
  const dismissCard = (cardId: string) => { waiter.dismiss(cardId); };

  const planStore = {
    read: async (id?: string, version?: number) => {
      const p = (await call("sidecar_read", { project_key: projectKey!, kind: "plan", key: id ? `${id}@${version ?? ""}` : undefined })) as DesignPlan | null;
      return p ?? lead?.plan ?? null;
    },
    writeDraft: async (plan: unknown) => {
      const p = plan as DesignPlan;
      p.display = { ...(p.display ?? { approved_at: null }), status: "draft" };
      await call("sidecar_write", { project_key: projectKey!, write: { kind: "plan", plan: p } });
      if (lead) lead.adoptPlan(p, false);
      // The detailed plan card is emitted by the plan.write tool (registry); nothing else shows one.
      return { id: p.id, version: p.version };
    },
    applyChange: async (changes: Record<string, unknown>) => {
      const { normalizePlan, normalizeSheets } = await import("./plans/schema");
      const cur = lead?.plan;
      if (!cur) throw new Error("PLAN_NOT_APPROVED");
      const next = normalizePlan(JSON.parse(JSON.stringify(cur))) as DesignPlan;
      next.version = cur.version + 1;
      const c = changes;
      const uniq = (a: string[]) => Array.from(new Set(a));
      if (Array.isArray(c.sheets)) for (const sh of normalizeSheets(c.sheets)) if (!next.sheets.some((x) => x.file === sh.file)) next.sheets.push(sh);
      const env = (c.envelope && typeof c.envelope === "object" ? c.envelope : {}) as Record<string, unknown>;
      if (Array.isArray(env.allowed_ops)) next.envelope.allowed_ops = next.envelope.allowed_ops.length ? uniq([...next.envelope.allowed_ops, ...env.allowed_ops.map(String)]) : [];
      // A plan change never widens destructive authority: deletion budgets and delete_* structural actions
      // stay exactly as approved (the tool description promises this; the human re-approves a new plan for those).
      if (Array.isArray(env.structural)) next.envelope.structural = uniq([...next.envelope.structural, ...env.structural.map(String).filter((x) => !/^delete_/.test(x))]);
      const b = (env.budgets && typeof env.budgets === "object" ? env.budgets : {}) as Record<string, unknown>;
      for (const k of ["components_added", "wires_added", "labels_added"] as const) if (typeof b[k] === "number") next.envelope.budgets[k] = Math.max(next.envelope.budgets[k], b[k] as number);
      if (Array.isArray(c.steps)) for (const st of normalizePlan({ steps: c.steps }).steps) if (!next.steps.some((x) => x.id === st.id)) next.steps.push(st);
      if (Array.isArray(c.constraints)) next.constraints = uniq([...next.constraints, ...c.constraints.map(String)]);
      if (typeof c.goal === "string" && c.goal.trim()) next.goal = c.goal;
      next.envelope.structural = uniq([...next.envelope.structural, ...next.sheets.filter((sh) => sh.create).map((sh) => `create_sheet:${sh.file}`)]);
      next.display = { ...(cur.display ?? { approved_at: null }), status: cur.display?.status ?? "approved" };
      await call("sidecar_write", { project_key: projectKey!, write: { kind: "plan", plan: next } });
      lead!.adoptPlan(next, lead!.planApproved, true);
      emit({ kind: "system", text_key: "system.plan_changed", params: { id: next.id, version: next.version }, severity: "info" });
      return { id: next.id, version: next.version };
    },
  };


  /**
   * Rust ended the BuildSession (timeout, external change, rollback): drop the dead token and go
   * back to Plan, once. Both the `session_expired` event and the command that caused it call this,
   * whichever lands first; the second call finds nothing to do and says nothing.
   */
  const endBuild = (reason: string) => {
    if (!lead) return;
    const wasBuild = lead.mode === "build" || !!lead.buildSession;
    lead.buildSession = null;
    // Copy says "back to Plan" (same as onBuildExpired): the code goes there too.
    if (lead.mode === "build") lead.setMode("plan", null);
    if (!wasBuild) return;
    const text_key = reason === "rollback" ? "system.session_expired_rollback" : reason === "external_change" ? "system.session_expired_external" : "system.session_expired";
    emit({ kind: "system", text_key, params: { reason }, severity: "warning" });
  };

  const onApp = (e: AppEvent) => {
    if (!lead || !projectKey) return;
    if (e.kind === "fs_changed" && e.project_key === projectKey && e.external) {
      // The card is filed under the last turn (a number no turn has yet would make a phantom block),
      // so it carries when the change happened: the rollback dialog compares that against the
      // checkpoint it would restore, which is what decides whether the change would be overwritten.
      // Its title is neutral; what happens next depends on whether a turn was running.
      const running = lead.running;
      emit({ kind: "card", card: systemCard(lead.turns[lead.turns.length - 1]?.turn ?? 0, "system.external_change", { files: e.files, at: new Date().toISOString() }) });
      emit({ kind: "system", text_key: running ? "system.external_change_ended" : "system.external_change_idle", severity: running ? "warning" : "info" });
      lead.externalEvent("changed", { files: e.files });
    }
    if (e.kind === "lock_detected" && e.project_key === projectKey) {
      emit({ kind: "card", card: systemCard(lead.turns[lead.turns.length - 1]?.turn ?? 0, "system.lock_detected", { file: e.file }) });
      lead.externalEvent("locked");
    }
    if (e.kind === "lock_released" && e.project_key === projectKey) {
      // KiCad closed the sheet: P7 stops refusing writes for the running turn.
      lead.externalEvent("unlocked");
      emit({ kind: "system", text_key: "system.lock_released", params: { file: e.file }, severity: "info" });
    }
    if (e.kind === "session_expired" && e.project_key === projectKey) endBuild(e.reason);
  };

  const api: HarnessApi = {
    async attach(pk, sid) {
      settings = await call("settings_get", {});
      projectKey = pk; sessionId = sid;
      project = await call("project_info", { project_key: pk });
      persistence = new Persistence(pk, sid);
      await skills.load(pk);
      lead = new LeadLoop({
        settings: getSettings, projectKey: pk, sessionId: sid, emit, skills, persistence, plans: planStore, showCard, dismissCard,
        selection: () => selection, sheets: () => project?.sheets.map((s) => s.file) ?? [],
        // Workflow `phase.requires_consent`: open the BuildSession without stopping the running turn.
        enterBuild: async (consent_event_id) => {
          if (!lead || !projectKey || lead.buildSession) return !!lead?.buildSession;
          try {
            const s = getSettings();
            const planRef = lead.plan && lead.planApproved ? `${lead.plan.id}@${lead.plan.version}` : "incremental";
            const bs = await call("build_session_open", { open: { project_key: projectKey, plan_ref: planRef, plan_sha256: lead.plan && lead.planApproved ? planIdentitySha(lead.plan) : null, policy: lead.policy, consent_event_id, lead_model: s.models_by_role.lead ?? "", tool_manifest_version: MANIFEST_VERSION } });
            lead.setMode("build", bs.token);
            return true;
          } catch (e) { emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "MODE_FAILED", message: String(e), req_id: "" } }); return false; }
        },
      });
      lead.history = await persistence.loadHistory().catch(() => []);
      // Turn records live in `.fluxsmith/turns/<n>/turn.json`: without them a restart loses every apply,
      // finding, cost and rollback status in the transcript (replay reads them from `lead.turns`).
      lead.turns = await restoreTurns(persistence, project.last_turn ?? 0);
      // Per-role token / cost / cache of those turns (`model_calls`): without it a restored turn
      // footer has totals but no split and no hit ratio. One read per attach, never during a turn.
      // The same window `restoreTurns` reads, so the two agree on which turns come back.
      const usageFrom = (project.last_turn ?? 0) > RESTORE_TURNS_MAX ? project.last_turn - RESTORE_TURNS_MAX + 1 : null;
      restoredUsage = await persistence.modelCallsByTurn(usageFrom, null).catch(() => []);
      // Build always needs fresh human consent (the Rust BuildSession died with the process).
      lead.mode = project.last_mode === "build" ? "plan" : ((project.last_mode as Mode) || "plan");
      if (project.last_mode === "build") queueMicrotask(() => emit({ kind: "system", text_key: "system.build_not_restored", severity: "info" }));
      lead.policy = (project.policy_override as Policy | null) ?? settings.agent.default_policy;
      // `sidecar_read plan` without a key returns every plan's latest.json (an
      // array); pick the newest well-formed one. A malformed plan must never
      // prevent attaching.
      const raw = (await call("sidecar_read", { project_key: pk, kind: "plan" }).catch(() => null)) as unknown;
      const candidates = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
        (p): p is DesignPlan => typeof p === "object" && p !== null && Array.isArray((p as DesignPlan).steps) && typeof (p as DesignPlan).id === "string",
      );
      const plan = candidates.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0] ?? null;
      if (plan) {
        try {
          const approved = (await call("db_query", { query: { kind: "approval_check", project_key: pk, kind_: "plan", ref: `${plan.id}@${plan.version}`, sha256: planIdentitySha(plan) } }).catch(() => false)) as boolean;
          lead.adoptPlan(plan, approved);
          lead.restoreProgress();
        } catch (e) {
          void call("log_write", { level: "warn", message: `ignoring malformed plan ${plan.id}: ${String(e)}`, req_id: null }).catch(() => undefined);
        }
      }
      unlistenApp = await onAppEvent(onApp);
      // Crash recovery (crash-recovery.md §3–§4): Rust already adjudicated the ledger and cleaned
      // orphans at project open; here the result becomes cards, once per scan.
      for (const card of recoveryCards(project, recoveryShown)) emit({ kind: "card", card });
      // A turn that died while waiting on a card: re-issue it from `pending_card.json` (grants are gone;
      // answering re-runs the turn's message as a new turn, never the dead one).
      if (project.last_turn > 0) {
        const pc = await persistence.readPendingCard(project.last_turn).catch(() => null);
        if (pc) emit({ kind: "card", card: pendingResumeCard(pc) });
      }
      emit({ kind: "context", usage: lead.contextUsage() });
    },
    async detach() {
      await lead?.stop();
      if (lead?.buildSession) await call("build_session_close", { token: lead.buildSession }).catch(() => undefined);
      unlistenApp?.(); unlistenApp = null;
      lead = null; projectKey = null; sessionId = null; project = null; persistence = null; restoredUsage = [];
    },
    state(): HarnessState {
      return {
        project_key: projectKey, session_id: sessionId, mode: lead?.mode ?? "plan", policy: lead?.policy ?? settings?.agent.default_policy ?? "review",
        running: lead?.running ?? false, current_turn: lead?.currentTurn?.turn ?? null, build_session: lead?.buildSession ?? null, plan_ref: lead?.planRef() ?? null,
        turns: lead ? lead.turns.map((t) => summaryOf(t, t.wall_active_ms + t.wall_waiting_ms)) : [],
        cards: [...cards.values()], context: lead?.contextUsage() ?? null,
      };
    },
    subscribe(h) { listeners.add(h); return () => listeners.delete(h); },
    async setMode(mode, consent_event_id) {
      if (!lead || !projectKey) throw new Error("not attached");
      if (lead.running) { await lead.stop(); await lead.waitIdle(20_000); }
      if (mode === lead.mode) return;
      if (lead.buildSession && mode !== "build") { await call("build_session_close", { token: lead.buildSession }).catch(() => undefined); lead.buildSession = null; }
      if (mode === "build") {
        if (!consent_event_id) throw new Error("CONSENT_REQUIRED: entering Build needs a consent event");
        const s = getSettings();
        const leadModel = s.models_by_role.lead ?? "";
        const planRef = lead.plan && lead.planApproved ? `${lead.plan.id}@${lead.plan.version}` : "incremental";
        try {
          const bs = await call("build_session_open", { open: { project_key: projectKey, plan_ref: planRef, plan_sha256: lead.plan && lead.planApproved ? planIdentitySha(lead.plan) : null, policy: lead.policy, consent_event_id, lead_model: leadModel, tool_manifest_version: MANIFEST_VERSION } });
          lead.setMode("build", bs.token);
        } catch (e) {
          if (e instanceof IpcFailure) emit({ kind: "error", turn: null, error: e.error });
          throw e;
        }
        return;
      }
      lead.setMode(mode, null);
      await call("db_query", { query: { kind: "project_state_set", project_key: projectKey, patch: { last_mode: mode } } }).catch(() => undefined);
    },
    async setPolicy(policy, consent_event_id) {
      if (!lead || !projectKey) throw new Error("not attached");
      if (policy === "auto" && !consent_event_id) throw new Error("CONSENT_REQUIRED: Auto needs a second confirmation");
      // Auto without an approved plan runs against the session ceiling (author's decision 2026-08-28);
      // hard stops are adjudicated by the Auto table either way.
      lead.setPolicy(policy);
      emit({ kind: "policy_changed", policy });
      await call("db_query", { query: { kind: "project_state_set", project_key: projectKey, patch: { policy_override: policy } } }).catch(() => undefined);
    },
    async send(message: UserMessage) {
      if (!lead) throw new Error("not attached");
      // Settings may have changed since attach (a provider was just authorised).
      try { settings = await call("settings_get", {}); } catch { /* keep the snapshot */ }
      // Keep the Rust BuildSession alive across a long chat: every send resets its idle timer.
      if (lead.buildSession) { try { await call("build_session_touch", { token: lead.buildSession }); } catch (e) { if (e instanceof IpcFailure && (e.error.code === "SESSION_EXPIRED" || e.error.code === "NO_BUILD_SESSION")) lead.onBuildExpired(lead.currentTurn?.turn ?? 0); } }
      if (lead.running) {
        emit({ kind: "system", text_key: "system.queued_next_turn", severity: "info" });
      }
      lead.enqueue({ message, task: null, steer: false });
    },
    async stop(force?: boolean) { await lead?.stop(force); },
    async answerCard(card_id, action_id, free_text, consent_event_id) {
      const card = cards.get(card_id);
      if (!card) throw new IpcFailure({ code: "CARD_UNKNOWN", message: card_id, req_id: "" });
      const action = card.actions.find((a) => a.id === action_id);
      // net_risk / structural approvals record the human's reason with the waiver (SPEC D-21): enforced here, not only in the UI.
      if (action_id === "approve" && (card.data as { needs_reason?: boolean } | undefined)?.needs_reason && !free_text?.trim()) throw new IpcFailure({ code: "REASON_REQUIRED", message: "", req_id: "" });
      // The rows a review card answer acts on, resolved before any grant is created: a waive is
      // consented over exactly these rows plus the reason and expiry typed on the form
      // (`waiveBatch`), and every grant of the answer repeats that batch so Rust can check it
      // against the recorded consent event (`commands.rs grant_create`, `engine.rs PolicyWaive`).
      const reviewRows = card.kind === "review" ? (((card.data as { findings?: { id: string; selected?: boolean; code: string; refs?: string[]; severity?: string; location?: string }[] })?.findings) ?? []) : [];
      // The card sends either the plain id array (older payload, still what `fix_selected` sends) or
      // `{ids, reason, expires}` once the human filled in the waiver fields.
      const answer = parseWaivePayload(free_text);
      const selected = reviewRows.filter((r) => (answer ? answer.ids.includes(r.id) : r.selected));
      const waive = card.kind === "review" && action_id === "waive_selected" ? waiveBatch(selected, answer?.reason ?? "", answer?.expires ?? null) : null;
      let grant: string | undefined;
      if (action?.consent) {
        if (!consent_event_id) throw new IpcFailure({ code: "CONSENT_REQUIRED", message: "", req_id: "" });
        // A net-risk approval is bound to the op-list the refused sch.plan reported (Rust refuses any other list).
        const opsSha = (card.data as { system?: { ops_sha256?: unknown } } | undefined)?.system?.ops_sha256;
        const g = await call("grant_create", { request: { project_key: projectKey!, kind: action.consent.grant_kind as "scope", payload_sha256: waive ? waiveConsentSha(waive) : action.consent.payload_sha256, consent_event_id, action: { card_id, action_id, ...(typeof opsSha === "string" ? { ops_sha256: opsSha } : {}), ...(waive ? { waive } : {}) } } });
        grant = g.id;
      }
      // Plan adoption is handled here (approval truth = DB), not by the model.
      if (card.kind === "plan_approval" && action_id === "discuss" && lead) {
        emit({ kind: "system", text_key: "system.plan_discuss", severity: "info" });
      }
      if (card.kind === "plan_approval" && (action_id === "adopt" || action_id === "adopt_auto") && lead && grant) {
        // Answers typed on the card become constraints of the plan that is about to be frozen, so the
        // approval sha, the sidecar copy and every drafter brief carry the human's decision. Questions
        // left blank stay open and are only reported.
        const answers = parseOpenQuestionAnswers(free_text);
        const p = answers ? applyOpenQuestionAnswers((card.data as { plan: DesignPlan }).plan, answers) : (card.data as { plan: DesignPlan }).plan;
        p.display = { status: "approved", approved_at: new Date().toISOString() };
        await call("db_query", { query: { kind: "approval_upsert", project_key: projectKey!, kind_: "plan", ref: `${p.id}@${p.version}`, sha256: planIdentitySha(p), consent_event_id: consent_event_id! } });
        await call("sidecar_write", { project_key: projectKey!, write: { kind: "plan", plan: p } });
        lead.adoptPlan(p, true);
        emit({ kind: "system", text_key: "system.plan_adopted", params: { id: p.id, version: p.version }, severity: "info" });
        // Adopting with questions still open is allowed; it is never silent (the agent decides them itself).
        if (p.open_questions?.length) emit({ kind: "system", text_key: "system.plan_open_questions", params: { n: p.open_questions.length }, severity: "info" });
        // Adopting a plan is the human's "go": enter Build (the adopt click carried the consent) and run the first step.
        const wantAuto = action_id === "adopt_auto";
        queueMicrotask(async () => {
          try {
            // Let the planning turn finish on its own (it is writing its summary); stopping it here
            // used to leave the harness in "stopping" and swallow the /run below.
            await lead!.waitIdle(180_000);
            if (wantAuto && lead!.policy !== "auto") await api.setPolicy("auto", consent_event_id!);
            if (!wantAuto && lead!.policy === "auto") await api.setPolicy("review");
            if (lead!.mode !== "build") await api.setMode("build", consent_event_id!);
            lead!.enqueue({ message: { text: "/run", refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
          } catch (e) { emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "PLAN_START_FAILED", message: String(e), req_id: "" } }); }
        });
      }
      // Recovery "keep the files and mark them": every step still under review gets a `done` ledger record
      // that says the files were kept, not verified (crash-recovery.md §3). Idempotent for the next scan.
      if (card.kind === "system" && card.title === "system.recovered" && action_id === "keep" && persistence) {
        const rep = (card.data as { report?: { steps?: { turn: number; step: string; verdict: string; files?: { path: string; actual_sha: string | null }[] }[] } }).report;
        const review = (rep?.steps ?? []).filter((s) => s.verdict === "needs_review");
        for (const s of review) await persistence.ledger(s.turn, s.step, "done", { recovered: true, kept: true, files: (s.files ?? []).map((f) => ({ path: f.path, sha: f.actual_sha })) });
        emit({ kind: "system", text_key: "system.recovery_kept", params: { n: review.length }, severity: "info" });
      }
      if (card.kind === "system" && card.title === "system.recovered_pending_card" && lead && persistence) {
        const pc = (card.data as { pending?: PendingCardFile }).pending;
        if (pc) await persistence.pendingCard(pc.turn, null).catch(() => undefined);
        if (action_id === "resume_turn" && pc) {
          const original = lead.history.filter((m) => m.role === "user" && m.meta.turn === pc.turn && m.meta.kind !== "injection").pop();
          const text = original ? original.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim() : "";
          if (text) lead.enqueue({ message: { text, refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
          else emit({ kind: "system", text_key: "system.resume_message_missing", params: { turn: pc.turn }, severity: "warning" });
        }
      }
      // D-34: the one-shot restore of what a rollback overwrote (KiCad edits included).
      if (card.kind === "system" && action_id === "restore_pre_rollback" && lead) {
        const data = (card.data ?? {}) as { pre_rollback?: number | null; turn?: number; before_turn?: number; files?: string[]; removed?: string[] };
        if (typeof data.pre_rollback === "number" && consent_event_id) {
          try { await api.restorePreRollback(data.pre_rollback, consent_event_id); }
          catch (e) {
            emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "ROLLBACK_FAILED", message: String(e), req_id: "" } });
            // The snapshot is still there (a locked file, say): re-issue the card so it can be tried again.
            emit({ kind: "card", card: rollbackDoneCard(card.turn, { turn: data.turn ?? 0, before_turn: data.before_turn ?? 0, files: data.files ?? [], removed: data.removed ?? [], pre_rollback: data.pre_rollback }) });
          }
        }
      }
      if (card.kind === "system" && action_id === "rollback" && lead) {
        const turn = (card.data as { summary?: { turn?: number }; turn?: number }).summary?.turn ?? (card.data as { turn?: number }).turn ?? card.turn;
        if (consent_event_id) {
          try { await api.rollbackBefore(turn, consent_event_id); }
          catch (e) { emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "ROLLBACK_FAILED", message: String(e), req_id: "" } }); }
        }
      }
      if (card.kind === "mode_suggestion" && action_id === "switch" && lead) {
        const target = ((card.data as { mode?: Mode })?.mode ?? "plan") as Mode;
        const original = lead.turns.find((x) => x.turn === card.turn);
        const cid = consent_event_id;
        // Resolve the card for the waiting tool first, then switch and re-run the request in the new mode.
        emit({ kind: "card_answered", card_id, action_id });
        queueMicrotask(async () => {
          try {
            if (lead!.running) await lead!.stop();
            await api.setMode(target, cid);
            if (original && target === "build") lead!.enqueue({ message: { text: original.message, refs: original.refs, attachments: [], session_id: sessionId! }, task: null, steer: false });
          } catch (e) { emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "MODE_SWITCH_FAILED", message: String(e), req_id: "" } }); }
        });
      }
      if (card.kind === "system" && action_id === "enter_build" && lead && consent_event_id) {
        try { await api.setMode("build", consent_event_id); } catch (e) { emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "MODE_FAILED", message: String(e), req_id: "" } }); }
      }
      if (card.kind === "system" && action_id === "do_it" && lead) {
        const t = lead.turns.find((x) => x.turn === card.turn);
        if (t) {
          const lang = detectReplyLanguage(t.message, settings?.language ?? "auto");
          const text = lang === "zh-Hant" ? `請執行你在第 ${t.turn} 輪提出的建議。` : lang === "zh-Hans" ? `请执行你在第 ${t.turn} 轮提出的建议。` : lang === "ja" ? `第 ${t.turn} ターンで提案した内容を実行してください。` : `Carry out what you proposed in turn ${t.turn}.`;
          lead.enqueue({ message: { text, refs: t.refs, attachments: [], session_id: sessionId! }, task: null, steer: false });
        }
      }
      if (card.kind === "system" && action_id === "continue" && lead) lead.enqueue({ message: { text: "/continue", refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
      if (card.kind === "system" && action_id === "redo_skipped" && lead) {
        const skipped = ((card.data as { skipped?: string[] })?.skipped ?? []);
        for (const id of skipped) lead.enqueue({ message: { text: `/redo ${id}`, refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
      }
      if (card.kind === "system" && lead && (action_id === "retry" || action_id === "skip" || action_id === "stop")) {
        const step = String((card.data as { step?: string })?.step ?? "");
        if (action_id === "retry" && step) lead.enqueue({ message: { text: `/redo ${step}`, refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
        if (action_id === "skip" && step) lead.enqueue({ message: { text: `/skip ${step}`, refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
        if (action_id === "stop") await lead.stop();
      }
      if (card.kind === "review" && lead) {
        if (action_id === "fix_selected") {
          try { await api.requestFix(selected, consent_event_id); } catch (e) { emit({ kind: "error", turn: null, error: e instanceof IpcFailure ? e.error : { code: "FIX_FAILED", message: String(e), req_id: "" } }); }
        }
        if (action_id === "waive_selected" && consent_event_id && waive) {
          // The values that went into the consent hash, so every call of this batch matches it.
          const { reason, expires } = waive;
          // Waivers already recorded stay recorded: a refusal is rethrown so the card can show it and
          // keep the selection, but the findings waived before it are not rolled back. The refusal
          // names the ids that went in, so the card drops them and a retry cannot record them twice.
          const failed: IpcError[] = [];
          const waived: string[] = [];
          for (const f of selected) {
            const finding = { code: f.code, refs: waiverRefs(f), severity: f.severity, location: f.location };
            try { await api.waiveFinding(finding, reason, consent_event_id, expires, waive); waived.push(f.id); }
            catch (e) { failed.push(e instanceof IpcFailure ? e.error : { code: "WAIVE_FAILED", message: String(e), req_id: "" }); }
          }
          if (failed.length) throw new IpcFailure(withWaivedIds(failed.find((x) => x.code === "WAIVER_SEVERITY" || x.code === "WAIVER_SCOPE") ?? failed[0], waived));
        }
      }
      // FR-611: the instance-scope question is answered after the turn it was raised in (no tool waits
      // on it); the answer is not a consent event and grants nothing.
      if (card.kind === "question" && (card.data as { code?: unknown } | undefined)?.code === "INSTANCE_REFS_REQUIRED" && lead && !pending.has(card_id)) {
        lead.answerInstanceRefs((card.data ?? {}) as { sheet?: unknown; paths?: unknown; refs?: unknown }, action_id === "all" ? "all" : "this");
      }
      // A parts_decision card answered with no tool waiting on it (e.g. re-issued after a restart): turn the decisions into a Lead instruction.
      if (card.kind === "parts_decision" && lead && !pending.has(card_id)) {
        const d = applyPartsDecision(card, action_id, free_text);
        if (d.instruction) lead.enqueue({ message: { text: d.instruction, refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
      }
      emit({ kind: "card_answered", card_id, action_id, ...(free_text ? { free_text } : {}) });
      waiter.answer(card_id, { action_id, free_text, consent_event_id, grant });
    },
    async rollbackBefore(turn, consent_event_id, opts) {
      if (!lead || !projectKey) throw new Error("not attached");
      // Wait for the stopped turn to really end: a late `turn_ended` from it would otherwise overwrite the rolled-back status.
      if (lead.running) { await lead.stop(); await lead.waitIdle(20_000); }
      if (lead.running) throw new IpcFailure({ code: "TURN_RUNNING", message: "the turn did not stop in time; try again", req_id: "" });
      const impact = rollbackImpact(lead.turns, turn);
      const g = await call("grant_create", { request: { project_key: projectKey, kind: "rollback", payload_sha256: sha256Hex(canonicalJson({ before_turn: turn, impact })), consent_event_id, action: { before_turn: turn } } });
      const r = await call("rollback", { request: { project_key: projectKey, before_turn: turn, grant: g.id, ...(opts?.state_sha256 ? { state_sha256: opts.state_sha256 } : {}) } });
      lead.afterRollback(turn);
      // Rust expired the BuildSession with the rollback (checkpoint.rs); do not wait for its event to
      // leave Build, or the next write would be the first to say the token is dead.
      endBuild("rollback");
      void lead.refreshFindings(turn).catch(() => undefined);
      await persistence?.journal({ kind: "rollback", before_turn: turn, restored: r.restored_files, removed: r.removed_files }).catch(() => undefined);
      await persistence?.metric("rollback", 1, { before_turn: turn }).catch(() => undefined);
      // File the card under the newest surviving turn (a not-yet-existing turn number would create a phantom block).
      const cardTurn = Math.max(0, ...lead.turns.filter((t) => t.turn < turn).map((t) => t.turn));
      emit({ kind: "card", card: rollbackDoneCard(cardTurn || r.now_turn, { turn, before_turn: turn, files: r.restored_files, removed: r.removed_files ?? [], pre_rollback: r.pre_rollback_checkpoint?.turn ?? null }) });
      for (const t of lead.turns) if (t.status === "rolled_back") emit({ kind: "turn_ended", summary: { turn: t.turn, kind: t.kind ?? "question", mode: t.mode, headline: t.headline, outcome: "rolled_back", applied: { components_added: 0, components_deleted: 0, wires_added: 0, sheets: [] }, cost_usd: t.cost.usd, tokens: t.cost.tokens, duration_ms: 0 } });
    },
    async restorePreRollback(turn, consent_event_id) {
      if (!lead || !projectKey) throw new Error("not attached");
      if (lead.running) { await lead.stop(); await lead.waitIdle(20_000); }
      if (lead.running) throw new IpcFailure({ code: "TURN_RUNNING", message: "the turn did not stop in time; try again", req_id: "" });
      const g = await call("grant_create", { request: { project_key: projectKey, kind: "rollback", payload_sha256: sha256Hex(canonicalJson({ pre_rollback: turn })), consent_event_id, action: { before_turn: turn, kind: "pre_rollback" } } });
      const r = await call("rollback", { request: { project_key: projectKey, before_turn: turn, grant: g.id, kind: "pre_rollback" } });
      // Not a redo: the reverted turns stay reverted, only the files come back.
      // The agent's picture of the design is stale, so mark it externally changed.
      lead.externalEvent("changed");
      void lead.refreshFindings(r.now_turn).catch(() => undefined);
      await persistence?.journal({ kind: "pre_rollback_restored", snapshot_turn: turn, restored: r.restored_files }).catch(() => undefined);
      await persistence?.metric("pre_rollback_restore", 1, { snapshot_turn: turn }).catch(() => undefined);
      emit({ kind: "system", text_key: "system.pre_rollback_restored", params: { files: r.restored_files.length }, severity: "info" });
    },
    async compact(level) { await lead?.compact(level ?? 2, true); },
    setSelection(refs: Ref[]) { selection = refs; lead?.setSelection(refs); },
    async setLeadModel(id: string) {
      if (!lead) throw new Error("not attached");
      if (lead.running) { emit({ kind: "system", text_key: "system.model_switch_busy", severity: "warning" }); return; }
      const next = await call("settings_set", { patch: { models_by_role: { ...(settings?.models_by_role ?? {}), lead: id } } });
      settings = next;
      lead.resetModel();
      emit({ kind: "system", text_key: "system.model_switched", params: { model: id }, severity: "info" });
    },
    plan() { return lead?.planView() ?? null; },
    async setThinkingLevel(level) {
      const next = await call("settings_set", { patch: { agent: { ...(settings?.agent ?? getSettings().agent), thinking_level: level } } });
      settings = next;
    },
    async editPlan(patch) {
      if (!lead || !projectKey) throw new Error("not attached");
      if (!lead.plan) throw new Error("PLAN_MISSING");
      const { applyPlanPatch, planMarkdown } = await import("./plans/schema");
      const { planCard } = await import("./cards");
      if (lead.planApproved) {
        // An approved plan changes through the same path the model uses (new version, approval kept).
        await planStore.applyChange({ ...(patch.goal ? { goal: patch.goal } : {}), ...(patch.constraints ? { constraints: patch.constraints } : {}), ...(patch.steps ? { step_summaries: patch.steps } : {}) });
        if (patch.steps && lead.plan) { for (const e of patch.steps) { const st = lead.plan.steps.find((x) => x.id === e.id); if (st && e.summary.trim()) st.summary = e.summary.trim(); } await call("sidecar_write", { project_key: projectKey, write: { kind: "plan", plan: lead.plan } }); }
        return;
      }
      const next = applyPlanPatch(lead.plan, patch);
      next.version = lead.plan.version + 1;
      await planStore.writeDraft(next);
      // Re-issue the plan card so the human approves the edited version (the old card is superseded).
      for (const c of cards.values()) if (c.kind === "plan_approval" && !c.answered && !c.auto) { c.answered = { action_id: "superseded", at: new Date().toISOString() }; emit({ kind: "card_answered", card_id: c.id, action_id: "superseded" }); }
      emit({ kind: "card", card: planCard(lead.currentTurn?.turn ?? lead.turns.length, next, { steps: next.steps.length, title: next.goal, id: next.id, version: next.version }, undefined, planMarkdown(next)) });
    },
    async requestFix(findings, consent_event_id) {
      if (!lead || !projectKey) throw new Error("not attached");
      if (lead.mode !== "build") {
        if (!consent_event_id) throw new Error("CONSENT_REQUIRED: fixing findings writes the schematic (Build)");
        await api.setMode("build", consent_event_id);
      }
      lead.pendingFix = findings as never;
      lead.enqueue({ message: { text: "/fix", refs: [], attachments: [], session_id: sessionId! }, task: null, steer: false });
    },
    async waiveFinding(finding, reason, consent_event_id, expires, batch) {
      if (!lead || !projectKey) throw new Error("not attached");
      // A picked date becomes the instant the waiver record stores; without one Rust applies its 90-day default.
      const exp = normalizeExpiry(expires);
      // The grant repeats the batch the consent event was recorded over (the ticked rows, the reason,
      // the expiry) so Rust can recompute its hash and refuse a waiver outside it. Without a batch —
      // a caller that waives one finding on its own — the grant hashes that finding, as before.
      const payload = batch ?? { code: finding.code, refs: finding.refs ?? [], severity: finding.severity ?? null, reason, expires: exp };
      const g = await call("grant_create", { request: { project_key: projectKey, kind: "waiver", payload_sha256: sha256Hex(canonicalJson(payload)), consent_event_id, action: { finding: finding.code, ...(batch ? { waive: batch } : {}) } } });
      const resp = await call("engine_request", { project_key: projectKey, request: { kind: "policy_waive", code: finding.code, refs: finding.refs ?? null, severity: finding.severity ?? null, reason, expires: exp }, auth: { build_session: lead.buildSession, role: "lead", grant: g.id } });
      // The gate codes (WAIVER_SEVERITY / WAIVER_SCOPE) travel as an IpcFailure so the card can answer them inline.
      if (!resp.ok) throw new IpcFailure(resp.error ?? { code: "WAIVE_FAILED", message: "", req_id: "" });
      emit({ kind: "system", text_key: "system.finding_waived", params: { code: finding.code }, severity: "info" });
    },
    thinkingLevel() {
      const v = settings?.agent.thinking_level ?? "medium";
      return (["off", "minimal", "low", "medium", "high"].includes(v) ? v : "medium") as ThinkingLevel;
    },
    replay() {
      if (!lead) return [];
      const out: ReplayItem[] = [];
      // `model_calls` of the attached-at turns, per turn: one `usage` event per role, the same shape
      // the live turn emitted (calls are already summed, so the footer adds up to the same numbers).
      const usageByTurn = new Map<number, TurnRoleUsage[]>();
      for (const u of restoredUsage) {
        const list = usageByTurn.get(u.turn);
        if (list) list.push(u); else usageByTurn.set(u.turn, [u]);
      }
      const byTurn = new Map<number, HMessage[]>();
      for (const m of lead.history) {
        if (!m.meta.turn || m.meta.kind === "compaction" || m.meta.kind === "marker" || m.meta.kind === "plan_snapshot") continue;
        if (!byTurn.has(m.meta.turn)) byTurn.set(m.meta.turn, []);
        byTurn.get(m.meta.turn)!.push(m);
      }
      const ts = nowIso();
      for (const [turn, msgs] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
        const rec = lead.turns.find((t) => t.turn === turn);
        let kind: TurnKind = "question"; let headline = rec?.headline ?? "";
        const begin = msgs.find((m) => m.role === "assistant" && m.toolCalls.some((c) => c.name === "turn.begin"));
        if (begin && begin.role === "assistant") {
          const a = begin.toolCalls.find((c) => c.name === "turn.begin")?.args as { kind?: TurnKind; headline?: string } | undefined;
          if (a?.kind) kind = a.kind; if (a?.headline) headline = a.headline;
        }
        for (const m of msgs) if (m.role === "user" && m.meta.kind === "user") out.push({ kind: "user_message", turn, text: userText(m), refs: [] });
        out.push({ kind: "turn_started", turn, turn_kind: kind, mode: rec?.mode ?? lead.mode, headline, envelope: rec?.envelope ?? null });
        const results = new Map<string, boolean>();
        for (const m of msgs) if (m.role === "toolResult") results.set(m.toolCallId, !m.isError);
        for (const m of msgs) {
          if (m.role !== "assistant") continue;
          for (const c of m.toolCalls) {
            if (c.name === "turn.begin" || c.name === "turn.status") continue;
            out.push({ kind: "activity", turn, line: { id: c.id, role: "lead", phase: "exploring", label: c.name, started_at: ts, ended_at: ts, ok: results.get(c.id) ?? true } });
          }
          const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
          if (text) out.push({ kind: "assistant_done", turn, message_id: `replay-${turn}-${out.length}`, text });
        }
        // Cost / cache per role of this turn, from the `model_calls` rows (the role column only ever
        // holds the `Role` ids the harness writes; an unknown one would render as its own id).
        for (const u of usageByTurn.get(turn) ?? []) out.push({ kind: "usage", turn, role: u.role as Role, input: u.input, cache_read: u.cache_read, cache_creation: u.cache_creation, output: u.output, cost_usd: u.cost_usd });
        // Applies and findings live on the TurnRecord, not in the history: replay them so the footer
        // (nets, show-on-canvas) and the findings panel come back after a restart / session switch.
        for (const a of rec?.applies ?? []) out.push({ kind: "applied", turn, run_id: a.run_id, target: a.target, counts: a.counts, net_diff: a.net_diff });
        if (rec?.findings.length) out.push({ kind: "findings", turn, findings: rec.findings, full: false });
        const summary = api.state().turns.find((t) => t.turn === turn);
        out.push({ kind: "turn_ended", summary: summary ?? { turn, kind, mode: rec?.mode ?? lead.mode, headline, outcome: "done", applied: { components_added: 0, components_deleted: 0, wires_added: 0, sheets: [] }, cost_usd: 0, tokens: 0, duration_ms: 0 } });
      }
      return out;
    },
    leadModel() {
      const lp = lead?.currentLead();
      return lp ? `${lp.provider.id}/${lp.model}` : null;
    },
  };
  let selection: Ref[] = [];
  return api;
}


/** The human's own words: strip the blocks the harness appends (reply language, summary, refs). */
function userText(m: HMessage): string {
  const raw = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const cut = raw.search(/\n\n<(reply_language|untrusted|refs|attachments)\b/);
  return (cut >= 0 ? raw.slice(0, cut) : raw).replace(/^\[instruction\]\s*/, "").trim();
}
