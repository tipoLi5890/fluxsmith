// SPDX-License-Identifier: Apache-2.0
// Wraps a `HarnessApi` (src/agent/api.ts) in a zustand store per project tab, fed by `subscribe`.
// The harness implementation is loaded lazily via import.meta.glob so the UI type-checks and runs
// even when `src/agent/index.ts` is absent (a no-op harness is used then).
import { IpcFailure } from "../ipc/client";
import type { WaiveBatch } from "../agent/review-waiver";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { ActivityLine, Card, ChangedField, ContextUsage, CreatedObject, HarnessApi, HarnessState, Phase, PlanView, Ref, Role, TurnEvent, TurnSummary, UserMessage, FindingRow, PlanPatch } from "../agent/api";
import { addUsage, type UsageTotals } from "./chat/usage";
import { isWaived } from "../agent/policy/types";
import { DEFAULT_FINDING_FILTER, type FindingFilter } from "./finding-filter";
import { usePrefs } from "../state/prefs";

/** Reasoning effort of the lead model (structurally the harness's `ThinkingLevelSetting`). */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
import type { Mode, Policy, TurnKind, Envelope, IpcError } from "../ipc/types";

export interface PhaseSection {
  id: string;
  phase: Phase | "fixing";
  role: Role;
  started_at: string;
  ended_at?: string;
  activities: ActivityLine[];
  cards: string[];
  status?: string;
  /** What the phase is about (block name for a drafter). */
  detail?: string;
  /** Model usage attributed to this phase (`usage` events, matched on role); absent until a call lands. */
  usage?: UsageTotals;
}

export interface ChatMessage {
  id: string;
  kind: "user" | "assistant" | "system";
  turn: number;
  text: string;
  refs?: Ref[];
  streaming?: boolean;
  text_key?: string;
  params?: Record<string, string | number>;
  severity?: "info" | "warning" | "error";
  lang?: string;
}

/** One entry of a turn's body in arrival order (user bubbles are kept apart, at the top). */
export interface TurnItem {
  seq: number;
  kind: "message" | "activity" | "card" | "error";
  id: string;
}

export interface TurnBlock {
  turn: number;
  kind: TurnKind;
  mode: Mode;
  headline: string;
  envelope: Envelope | null;
  started_at: string;
  phases: PhaseSection[];
  messages: ChatMessage[];
  applied: { run_id: string; target: string; counts: { added: number; deleted: number; wires: number }; focus?: Ref[]; net_diff?: unknown }[];
  /** What this turn drew and changed so far, accumulated over every apply (not only the last one). */
  changes?: TurnChanges;
  findings: unknown[];
  summary?: TurnSummary;
  error?: IpcError;
  cost_usd: number;
  tokens: number;
  /** Model usage of the turn split per role (Lead vs Drafter vs Fixer…); empty for restored turns. */
  usageByRole: Partial<Record<Role, UsageTotals>>;
  budget?: Extract<TurnEvent, { kind: "budget" }>;
  rolled_back?: boolean;
  collapsed: boolean;
  /** Chronological order of messages / activities / cards / the error inside the turn. */
  items: TurnItem[];
  /** `plan_approval` cards held back while the turn is still streaming; released on turn end. */
  heldCards?: string[];
}

/**
 * Everything one turn drew and changed, accumulated over all of its applies. The canvas keeps it
 * highlighted until the next turn starts, so the human can still see what the last turn did after
 * the one-shot reveal has finished and after switching sheets.
 */
export interface TurnChanges {
  turn: number;
  /** Uuids of the objects the turn created (op order, deduplicated). */
  uuids: string[];
  /** Designators of the parts whose fields the turn changed (they keep their uuid, so a ref is what we have). */
  refs: string[];
  created: CreatedObject[];
  changed: ChangedField[];
}

/** Cap on what one turn's change set carries; a whole-sheet redraw is reported by counts, not per object. */
export const TURN_CHANGES_MAX = 2000;

/** Fold one apply into the turn's accumulated change set (a new turn number starts a new set). */
export function accumulateChanges(prev: TurnChanges | null, turn: number, created: CreatedObject[], changed: ChangedField[]): TurnChanges {
  const base: TurnChanges = prev && prev.turn === turn ? prev : { turn, uuids: [], refs: [], created: [], changed: [] };
  const uuids = base.uuids.slice();
  const createdOut = base.created.slice();
  const seen = new Set(base.uuids);
  for (const c of created) {
    if (seen.has(c.uuid) || uuids.length >= TURN_CHANGES_MAX) continue;
    seen.add(c.uuid);
    uuids.push(c.uuid);
    createdOut.push(c);
  }
  const refs = base.refs.slice();
  const changedOut = base.changed.slice();
  for (const c of changed) {
    if (changedOut.length >= TURN_CHANGES_MAX) break;
    if (!refs.includes(c.reference)) refs.push(c.reference);
    const i = changedOut.findIndex((x) => x.reference === c.reference && x.field === c.field && (x.sheet ?? "") === (c.sheet ?? ""));
    // A field written twice in one turn changed once: from the first before to the last after.
    if (i >= 0) changedOut[i] = { ...changedOut[i], after: c.after };
    else changedOut.push(c);
  }
  return { turn, uuids, refs, created: createdOut, changed: changedOut };
}

export interface AgentAttention {
  seq: number;
  turn: number;
  role: Role;
  label: string;
  refs?: Ref[];
  region_mil?: [[number, number], [number, number]];
  sheet?: string;
}

export interface BridgeState {
  ready: boolean;
  harness: HarnessApi | null;
  state: HarnessState;
  turns: TurnBlock[];
  cards: Record<string, Card>;
  pendingCardId: string | null;
  context: ContextUsage | null;
  focus: Ref[];
  /** What the human selected on the canvas (mirrors what `setSelection` sent to the harness; the sidebar syncs to it). */
  selection: Ref[];
  /**
   * The human dismissed the "selection attached" pill: the harness holds no selection, so the next
   * message goes without it. The canvas keeps its highlight, and the turn that consumed the skip
   * hands the selection back (`turn_ended`), which is what makes it a skip and not a toggle.
   */
  selectionSkipped: boolean;
  /** Where the agent is looking right now (last `attention` event); `seq` lets the canvas react to repeats. */
  attention: AgentAttention | null;
  /** Objects created by the last apply (canvas reveals them progressively). */
  lastApplied: { run_id: string; created: CreatedObject[] } | null;
  /** What the current (or last finished) turn drew and changed; the canvas keeps it highlighted until the next turn starts. */
  turnChanges: TurnChanges | null;
  currentPhase: { phase: Phase | "fixing"; role: Role; detail?: string } | null;
  /** Verified-but-unapplied preview the canvas draws as a ghost layer; cleared when the apply lands. */
  ghost: { preview_id: string; sheet: string; turn: number } | null;
  /** Findings accumulated across turns, keyed by (code, location); a full gate run resolves the ones it no longer reports. */
  findings: FindingRow[];
  /** A full check (gate run) has reported at least once this session: an empty list then means "clean", not "not checked". */
  checked: boolean;
  /**
   * What the findings panel is showing. It lives here and not in the panel because the canvas draws
   * its markers and walks `N` / `Shift+N` over the same rows: one filter, one view.
   */
  findingFilter: FindingFilter;
  events: TurnEvent[];
  retrying: { i: number; n: number } | null;
  /** `"<provider_id>/<model>"` the next turn would use (mirrors `HarnessApi.leadModel()`). */
  leadModel: string | null;
  /** User messages sent but not yet claimed by a `turn_started` event (the harness numbers turns, never the UI). */
  pending: ChatMessage[];
  /** Reasoning effort of the lead model (mirrors `HarnessApi.thinkingLevel()`). */
  thinkingLevel: ThinkingLevel;
  /** Current DesignPlan with progress (mirrors `HarnessApi.plan()`). */
  plan: PlanView | null;
  attach(project_key: string, session_id: string): Promise<void>;
  detach(): Promise<void>;
  send(m: UserMessage): Promise<void>;
  stop(force?: boolean): Promise<void>;
  setMode(mode: Mode, consent_event_id?: string): Promise<void>;
  setPolicy(policy: Policy, consent_event_id?: string): Promise<void>;
  answerCard(card_id: string, action_id: string, free_text?: string, consent_event_id?: string): Promise<void>;
  /**
   * Roll back to before `turn`. Returns the error code when the write was
   * refused (`ROLLBACK_STALE` when the project changed after the human was
   * shown the impact) so the dialog can re-read and offer a retry; `null` on success.
   */
  rollbackBefore(turn: number, consent_event_id: string, opts?: { state_sha256?: string }): Promise<string | null>;
  compact(level?: 1 | 2 | 3): Promise<void>;
  setSelection(refs: Ref[]): void;
  /** Skip the canvas selection for the next message only (`chat-references-and-attachments.md` §4). */
  skipSelectionOnce(): void;
  editPlan(patch: PlanPatch): Promise<void>;
  requestFix(findings: unknown[], consent_event_id?: string): Promise<void>;
  waiveFinding(finding: { code: string; refs?: string[]; severity?: string; location?: string }, reason: string, consent_event_id: string, expires?: string | null, batch?: WaiveBatch): Promise<void>;
  setLeadModel(id: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** Re-read the effective lead model after settings changed (catalogue refresh, provider edits). */
  refreshLeadModel(): void;
  /** Narrow the findings view (panel, canvas markers, finding walk); persisted per project. */
  setFindingFilter(patch: Partial<FindingFilter>): void;
  toggleTurn(turn: number): void;
  /** Highlight `refs` on the canvas (the follow camera frames them) — the "show on canvas" button of a turn footer. */
  focusRefs(refs: Ref[]): void;
}

const EMPTY_STATE: HarnessState = { project_key: null, session_id: null, mode: "plan", policy: "review", running: false, current_turn: null, build_session: null, plan_ref: null, turns: [], cards: [], context: null };

type HarnessFactory = () => HarnessApi;
let factoryPromise: Promise<HarnessFactory | null> | null = null;

async function loadFactory(): Promise<HarnessFactory | null> {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    const mods = import.meta.glob("../agent/index.ts");
    const loader = mods["../agent/index.ts"];
    if (!loader) return null;
    try {
      const m = (await loader()) as { createHarness?: HarnessFactory };
      return m.createHarness ?? null;
    } catch {
      return null;
    }
  })();
  return factoryPromise;
}

/** Test/dev hook: inject a harness factory (used by vitest and when no agent module exists). */
export function setHarnessFactory(f: HarnessFactory | null): void {
  factoryPromise = Promise.resolve(f);
}

function noopHarness(): HarnessApi {
  let st: HarnessState = { ...EMPTY_STATE };
  const subs = new Set<(e: TurnEvent) => void>();
  const emit = (e: TurnEvent) => subs.forEach((s) => s(e));
  return {
    async attach(project_key, session_id) { st = { ...st, project_key, session_id }; },
    async detach() { st = { ...EMPTY_STATE }; },
    state() { return st; },
    subscribe(h) { subs.add(h); return () => subs.delete(h); },
    async setMode(mode) { st = { ...st, mode }; emit({ kind: "mode_changed", mode, by: "user" }); },
    async setPolicy(policy) { st = { ...st, policy }; emit({ kind: "policy_changed", policy }); },
    async send() { emit({ kind: "system", text_key: "empty.aiUnconfigured", severity: "warning" }); },
    async stop() { /* nothing running */ },
    async answerCard(card_id, action_id) { emit({ kind: "card_answered", card_id, action_id }); },
    async rollbackBefore() { /* no-op */ },
    async restorePreRollback() { /* no-op */ },
    async compact() { /* no-op */ },
    setSelection() { /* no-op */ },
    async setLeadModel() { /* no-op */ },
    leadModel() { return null; },
    async setThinkingLevel() { /* no-op */ },
    thinkingLevel() { return "medium"; },
    plan() { return null; },
    async editPlan() { /* no-op */ },
    async requestFix() { /* no-op */ },
    async waiveFinding() { /* no-op */ },
    replay() { return []; },
  };
}

let msgSeq = 0;
let phaseSeq = 0;
let itemSeq = 0;

function emptyBlock(turn: number, mode: Mode, now: string): TurnBlock {
  return { turn, kind: "instruction", mode, headline: "", envelope: null, started_at: now, phases: [], messages: [], applied: [], findings: [], cost_usd: 0, tokens: 0, usageByRole: {}, collapsed: false, items: [] };
}

/** Move held plan cards into the turn's items (the stream is no longer moving). */
function releaseHeld(t: TurnBlock): TurnBlock {
  if (!t.heldCards?.length) return t;
  let out: TurnBlock = { ...t, heldCards: [] };
  for (const id of t.heldCards) out = withItem(out, "card", id);
  return out;
}

export function findingKey(f: { code: string; location?: string; message?: string }): string { return `${f.code}|${f.location ?? f.message ?? ""}`; }

/**
 * Merge a findings batch into the accumulated list: same (code, location) updates in place; a
 * full gate run marks entries it no longer reports as resolved (they stay listed, greyed).
 *
 * Waivers: the engine reports a waived finding instead of dropping it, decorated with the expiry of
 * the `[[waiver]]` that covers it — that expiry wins, so a waiver granted in an earlier session is
 * shown too. A batch that says nothing about waivers (`sch.plan`, an apply's integrity report) knows
 * nothing about them and keeps whatever expiry the row already had; only a full gate run, which is
 * waiver-aware, clears it. A waived row counts as resolved: listed and greyed, never in the counts.
 */
export function mergeFindings(prev: FindingRow[], batch: unknown[], turn: number, full: boolean): FindingRow[] {
  const rows = batch.filter((f): f is Record<string, unknown> => !!f && typeof f === "object" && typeof (f as { code?: unknown }).code === "string");
  const keys = new Set(rows.map((r) => findingKey(r as unknown as FindingRow)));
  const out: FindingRow[] = prev.map((p) => (full && !keys.has(findingKey(p)) ? { ...p, resolved: true } : p));
  for (const r of rows) {
    // `evidence` is what the check measured (`gates.rs`): untrusted key/value data, carried onto the
    // row so the expanded panel row and the export can show it.
    const row: FindingRow = { code: String(r.code), severity: String(r.severity ?? "Warning"), message: String(r.message ?? ""), sheet: typeof r.sheet === "string" ? r.sheet : undefined, file: typeof r.file === "string" ? r.file : undefined, at_mil: Array.isArray(r.at_mil) && r.at_mil.length === 2 ? [Number(r.at_mil[0]), Number(r.at_mil[1])] : undefined, refs: Array.isArray(r.refs) ? (r.refs as string[]) : undefined, location: typeof r.location === "string" ? r.location : undefined, remediation: typeof r.remediation === "string" ? r.remediation : undefined, origin: r.origin === "advisory" ? "advisory" : "engine", confidence: r.confidence as FindingRow["confidence"], turn, resolved: false, ...(r.waived === true ? { waived: true } : {}), ...(typeof r.waived_until === "string" && r.waived_until ? { waived_until: r.waived_until } : {}), ...(typeof r.waived_reason === "string" && r.waived_reason ? { waived_reason: r.waived_reason } : {}),
      ...(r.evidence && typeof r.evidence === "object" && !Array.isArray(r.evidence) ? { evidence: r.evidence as Record<string, unknown> } : {}) };
    const k = findingKey(row);
    const i = out.findIndex((x) => findingKey(x) === k);
    if (i >= 0) {
      // Engine expiry wins; a batch that is not a full gate run keeps the one already on the row.
      const keep = !full && !isWaived(row) ? out[i] : row;
      out[i] = { ...out[i], ...row, waived: keep.waived, waived_until: keep.waived_until, waived_reason: keep.waived_reason, resolved: isWaived(keep) };
    } else out.push(isWaived(row) ? { ...row, resolved: true } : row);
  }
  return out;
}

/** Append an item to the turn's chronological list unless that id is already listed. */
function withItem(t: TurnBlock, kind: TurnItem["kind"], id: string): TurnBlock {
  if (t.items.some((i) => i.kind === kind && i.id === id)) return t;
  return { ...t, items: [...t.items, { seq: ++itemSeq, kind, id }] };
}

/**
 * Which phase section a model call belongs to: the role's own live phase, else its last one, else
 * whatever phase is running (a compaction call inside a lead phase). -1 = no section yet.
 */
export function usagePhaseIndex(phases: PhaseSection[], role: Role): number {
  for (let i = phases.length - 1; i >= 0; i--) if (phases[i].role === role && !phases[i].ended_at) return i;
  for (let i = phases.length - 1; i >= 0; i--) if (phases[i].role === role) return i;
  for (let i = phases.length - 1; i >= 0; i--) if (!phases[i].ended_at) return i;
  return -1;
}

export function reduceEvent(s: BridgeState, e: TurnEvent): Partial<BridgeState> {
  const turns = s.turns.slice();
  const cards = { ...s.cards };
  const now = new Date().toISOString();
  const findTurn = (n: number) => turns.findIndex((t) => t.turn === n);
  // Every turn number maps to exactly one group; events may arrive before `turn_started`.
  let pending = s.pending;
  const ensure = (n: number): number => {
    let i = findTurn(n);
    if (i < 0) {
      const block = emptyBlock(n, s.state.mode, now);
      // The first event of a new turn (phase/activity/turn_started…) owns whatever the human just sent:
      // never leave a bubble in "sending" once the harness is visibly working on it.
      if (pending.length && n >= Math.max(0, ...turns.map((t) => t.turn))) { block.messages = pending.map((m) => ({ ...m, turn: n })); pending = []; }
      turns.push(block); turns.sort((a, b) => a.turn - b.turn); i = findTurn(n);
    }
    return i;
  };
  const withTurn = (n: number, f: (t: TurnBlock) => TurnBlock) => {
    const i = ensure(n);
    turns[i] = f({ ...turns[i] });
  };
  let patch: Partial<BridgeState> = {};
  switch (e.kind) {
    case "turn_started": {
      withTurn(e.turn, (t) => ({
        ...t,
        kind: e.turn_kind, mode: e.mode, headline: e.headline, envelope: e.envelope,
        started_at: t.messages.length ? t.started_at : now,
        // A reused turn number (e.g. after an empty turn) keeps its earlier messages; the new ones follow
        // (unless `ensure` already attached them when the group was created a moment ago).
        messages: [...t.messages, ...pending.filter((m) => !t.messages.some((x) => x.id === m.id)).map((m) => ({ ...m, turn: e.turn }))],
        summary: undefined, error: undefined, rolled_back: false, collapsed: false,
      }));
      pending = [];
      // The change highlight belongs to one turn: a new turn drops the previous turn's set.
      patch = { turns, pending, currentPhase: null, retrying: null, turnChanges: s.turnChanges?.turn === e.turn ? s.turnChanges : null };
      break;
    }
    case "phase": {
      withTurn(e.turn, (t) => {
        const phases = t.phases.slice();
        const last = phases[phases.length - 1];
        const settled = e.phase === "done" || e.phase === "stopped" || e.phase === "failed";
        if (last && last.phase === e.phase && last.role === e.role && !last.ended_at) { if (e.detail && last.detail !== e.detail) phases[phases.length - 1] = { ...last, detail: e.detail }; const same = { ...t, phases }; return settled ? releaseHeld(same) : same; }
        if (last && !last.ended_at) phases[phases.length - 1] = { ...last, ended_at: now };
        phases.push({ id: `p${++phaseSeq}`, phase: e.phase, role: e.role, started_at: now, activities: [], cards: [], detail: e.detail });
        const next = { ...t, phases };
        return settled ? releaseHeld(next) : next;
      });
      patch = { turns, currentPhase: { phase: e.phase, role: e.role, detail: e.detail } };
      break;
    }
    case "status": {
      withTurn(e.turn, (t) => {
        const phases = t.phases.slice();
        const last = phases[phases.length - 1];
        if (last) phases[phases.length - 1] = { ...last, status: e.text };
        return { ...t, phases };
      });
      patch = { turns };
      break;
    }
    case "assistant_delta": {
      withTurn(e.turn, (t) => {
        const messages = t.messages.slice();
        const i = messages.findIndex((m) => m.id === e.message_id);
        if (i >= 0) messages[i] = { ...messages[i], text: messages[i].text + e.delta, streaming: true };
        else messages.push({ id: e.message_id, kind: "assistant", turn: e.turn, text: e.delta, streaming: true });
        return withItem({ ...t, messages }, "message", e.message_id);
      });
      patch = { turns };
      break;
    }
    case "assistant_done": {
      withTurn(e.turn, (t) => {
        const messages = t.messages.slice();
        const i = messages.findIndex((m) => m.id === e.message_id);
        if (i >= 0) messages[i] = { ...messages[i], text: e.text, streaming: false };
        else messages.push({ id: e.message_id, kind: "assistant", turn: e.turn, text: e.text, streaming: false });
        return withItem({ ...t, messages }, "message", e.message_id);
      });
      patch = { turns };
      break;
    }
    case "activity": {
      withTurn(e.turn, (t) => {
        const phases = t.phases.slice();
        if (!phases.length) phases.push({ id: `p${++phaseSeq}`, phase: e.line.phase, role: e.line.role, started_at: now, activities: [], cards: [] });
        const last = { ...phases[phases.length - 1] };
        const acts = last.activities.slice();
        const i = acts.findIndex((a) => a.id === e.line.id);
        // Completion keeps the start line's fields (started_at, detail) unless the event carries them.
        if (i >= 0) acts[i] = { ...acts[i], ...e.line, started_at: acts[i].started_at || e.line.started_at, detail: e.line.detail ?? acts[i].detail }; else acts.push(e.line);
        last.activities = acts;
        phases[phases.length - 1] = last;
        // Child lines ride under their parent in the chronology (they are never separate items).
        return e.line.parent_id ? { ...t, phases } : withItem({ ...t, phases }, "activity", e.line.id);
      });
      // Provider retries surface as `provider.retry` lines ("<class> <i>/<n> in <s>s"); any other line clears the badge.
      const m = e.line.label === "provider.retry" ? /(\d+)\/(\d+)/.exec(e.line.detail ?? "") : null;
      patch = { turns, retrying: m ? { i: Number(m[1]), n: Number(m[2]) } : e.line.label === "provider.retry" ? s.retrying : null };
      break;
    }
    case "card": {
      cards[e.card.id] = e.card;
      withTurn(e.card.turn, (t) => {
        // A plan card that arrives mid-stream would make the stream jump: hold it until the turn ends.
        if (e.card.kind === "plan_approval" && !t.summary && e.card.data && typeof e.card.data === "object" && "plan" in (e.card.data as object)) {
          const held = t.heldCards ?? [];
          return held.includes(e.card.id) ? t : { ...t, heldCards: [...held, e.card.id] };
        }
        const phases = t.phases.slice();
        if (!phases.length) phases.push({ id: `p${++phaseSeq}`, phase: "waiting", role: "lead", started_at: now, activities: [], cards: [] });
        const last = { ...phases[phases.length - 1] };
        if (!last.cards.includes(e.card.id)) last.cards = [...last.cards, e.card.id];
        phases[phases.length - 1] = last;
        return withItem({ ...t, phases }, "card", e.card.id);
      });
      // Only cards the agent is waiting on get pinned; summary/system cards live in the stream only.
      const blocking = e.card.kind !== "system" && e.card.kind !== "compaction" && e.card.kind !== "cost";
      const heldNow = turns.some((t) => t.heldCards?.includes(e.card.id));
      // A held plan card is invisible until the turn ends: "jump to card" / the needs-you badge must not point at it yet.
      const pendingCard = blocking && !heldNow && !e.card.answered && !e.card.auto && e.card.actions.length > 0 ? e.card.id : s.pendingCardId;
      patch = { turns, cards, pendingCardId: pendingCard };
      break;
    }
    case "card_answered": {
      const c = cards[e.card_id];
      // Two emitters answer a card (index resolves it, the lead's askCard reports it): keep an already-recorded free text.
      if (c) cards[e.card_id] = { ...c, answered: { action_id: e.action_id, at: now, ...((e.free_text ?? c.answered?.free_text) ? { free_text: e.free_text ?? c.answered?.free_text } : {}) } };
      patch = { cards, pendingCardId: s.pendingCardId === e.card_id ? null : s.pendingCardId };
      break;
    }
    case "applied": {
      // A turn writes several op-lists: what it drew is the union of all of them, kept until the
      // next turn starts. `lastApplied` stays per run — it drives the one-shot reveal.
      const changes = accumulateChanges(s.turnChanges, e.turn, e.created ?? [], e.changed ?? []);
      withTurn(e.turn, (t) => ({ ...t, applied: [...t.applied, { run_id: e.run_id, target: e.target, counts: e.counts, focus: e.focus, net_diff: e.net_diff }], changes }));
      patch = { turns, focus: e.focus ?? s.focus, lastApplied: e.created?.length ? { run_id: e.run_id, created: e.created } : s.lastApplied, turnChanges: changes, ghost: null };
      break;
    }
    case "preview": {
      patch = { ghost: { preview_id: e.preview_id, sheet: e.sheet, turn: e.turn } };
      break;
    }
    case "attention": {
      patch = { attention: { seq: (s.attention?.seq ?? 0) + 1, turn: e.turn, role: e.role, label: e.label, refs: e.refs, region_mil: e.region_mil, sheet: e.sheet } };
      break;
    }
    case "findings": {
      withTurn(e.turn, (t) => ({ ...t, findings: [...t.findings, ...e.findings] }));
      patch = { turns, findings: mergeFindings(s.findings, e.findings, e.turn, !!e.full), ...(e.full ? { checked: true } : {}) };
      break;
    }
    case "focus": patch = { focus: e.refs }; break;
    case "usage": {
      withTurn(e.turn, (t) => {
        const usageByRole = { ...t.usageByRole, [e.role]: addUsage(t.usageByRole[e.role], e) };
        const phases = t.phases.slice();
        const i = usagePhaseIndex(phases, e.role);
        if (i >= 0) phases[i] = { ...phases[i], usage: addUsage(phases[i].usage, e) };
        return { ...t, usageByRole, phases };
      });
      patch = { turns };
      break;
    }
    case "context": patch = { context: e.usage }; break;
    case "budget": {
      withTurn(e.turn, (t) => ({ ...t, budget: e, cost_usd: e.used.usd, tokens: e.used.tokens }));
      patch = { turns };
      break;
    }
    case "turn_ended": {
      withTurn(e.summary.turn, (t) => {
        const phases = t.phases.slice();
        const last = phases[phases.length - 1];
        if (last && !last.ended_at) phases[phases.length - 1] = { ...last, ended_at: now };
        return releaseHeld({ ...t, phases, kind: e.summary.kind, mode: e.summary.mode, headline: t.headline || e.summary.headline, summary: e.summary, cost_usd: e.summary.cost_usd, tokens: e.summary.tokens, rolled_back: e.summary.outcome === "rolled_back" });
      });
      // Released plan cards become the pending card now that they are visible.
      const released = (s.turns.find((t) => t.turn === e.summary.turn)?.heldCards ?? []).map((id) => cards[id]).find((c) => c && !c.answered && !c.auto && c.actions.length > 0);
      // The canvas keeps the presence marker for a short linger before hiding it.
      patch = { turns, currentPhase: null, attention: null, ghost: null, ...(released ? { pendingCardId: released.id } : {}) };
      break;
    }
    case "system": {
      const target = s.state.current_turn ?? turns[turns.length - 1]?.turn ?? 0;
      const msg: ChatMessage = { id: `m${++msgSeq}`, kind: "system", turn: target, text: "", text_key: e.text_key, params: e.params, severity: e.severity };
      withTurn(target, (t) => withItem({ ...t, messages: [...t.messages, msg] }, "message", msg.id));
      patch = { turns };
      break;
    }
    case "error": {
      // Every error of a turn stays in the transcript (a rate limit followed by LOOP_FAILED shows both); `t.error` is the latest.
      const errId = (t: TurnBlock) => `error-${t.items.filter((i) => i.kind === "error").length}`;
      if (e.turn != null) withTurn(e.turn, (t) => withItem({ ...t, error: e.error }, "error", errId(t)));
      else {
        const target = s.state.current_turn ?? turns[turns.length - 1]?.turn ?? 0;
        withTurn(target, (t) => withItem({ ...t, error: e.error }, "error", errId(t)));
      }
      patch = { turns };
      break;
    }
    case "mode_changed": case "policy_changed": break;
  }
  if (s.harness) { patch.state = s.harness.state(); patch.leadModel = s.harness.leadModel(); patch.thinkingLevel = s.harness.thinkingLevel(); patch.plan = s.harness.plan(); }
  patch.events = s.events.length > 500 ? [...s.events.slice(-400), e] : [...s.events, e];
  // `ensure` may have consumed pending bubbles on any event: always publish the current list.
  return { ...patch, pending };
}

export type BridgeStore = UseBoundStore<StoreApi<BridgeState>>;

export function createBridge(projectKey?: string): BridgeStore {
  let unsub: (() => void) | null = null;
  // The filter the human left this project on last time; the default is eeschema's (Error + Warning).
  const storedFilter = (projectKey ? usePrefs.getState().findingFilter[projectKey] : null) ?? DEFAULT_FINDING_FILTER;
  return create<BridgeState>((set, get) => ({
    ready: false,
    harness: null,
    state: EMPTY_STATE,
    turns: [],
    cards: {},
    pendingCardId: null,
    context: null,
    focus: [],
    selection: [],
    selectionSkipped: false,
    attention: null,
    lastApplied: null,
    turnChanges: null,
    ghost: null,
    findings: [],
  checked: false,
    findingFilter: storedFilter,
    currentPhase: null,
    events: [],
    retrying: null,
    leadModel: null,
    pending: [],
    thinkingLevel: "medium",
    plan: null,
    async attach(project_key, session_id) {
      const factory = (await loadFactory()) ?? noopHarness;
      const harness = factory();
      unsub?.();
      unsub = harness.subscribe((e) => {
        set((s) => reduceEvent(s, e));
        // The turn that went without the canvas selection is over: give the selection back, so the
        // pill returns for the next message. Waiting for the end of the turn (not the send) keeps
        // the skip honest -- the harness reads its selection while the turn is already running.
        if (e.kind === "turn_ended") {
          const st = get();
          if (st.selectionSkipped && st.pending.length === 0) { harness.setSelection(st.selection); set({ selectionSkipped: false }); }
        }
      });
      try {
        await harness.attach(project_key, session_id);
      } catch (e) {
        // Surface attach failures in the stream instead of leaving a dead composer.
        const err = e instanceof Error ? e.message : String(e);
        set((s) => reduceEvent(s, { kind: "error", turn: null, error: { code: "HARNESS_ATTACH_FAILED", message: err, req_id: "" } }));
        set({ harness, ready: false });
        throw e;
      }
      const st = harness.state();
      // Rebuild the visible stream from the persisted transcript.
      let restored = { ...get(), turns: [] as TurnBlock[], pending: [] as ChatMessage[], findings: [] as FindingRow[], events: [] as TurnEvent[] };
      try {
        for (const item of harness.replay()) {
          if (item.kind === "user_message") restored = { ...restored, pending: [...restored.pending, { id: `r${++msgSeq}`, kind: "user", turn: item.turn, text: item.text, refs: item.refs }] };
          else restored = { ...restored, ...reduceEvent(restored, item) };
        }
      } catch { /* a broken transcript must not block the project */ }
      // Cards emitted during attach (recovery, re-issued pending card) or persisted without a transcript item
      // would otherwise light the badge with nothing to jump to: give each one its turn item.
      for (const c of st.cards) {
        if (restored.turns.some((tb) => tb.items.some((i) => i.kind === "card" && i.id === c.id))) continue;
        restored = { ...restored, ...reduceEvent(restored, { kind: "card", card: c }) };
      }
      set({ harness, ready: true, state: st, leadModel: harness.leadModel(), thinkingLevel: harness.thinkingLevel(), plan: harness.plan(), turns: mergeSummaries(restored.turns, st.turns), pending: [], cards: Object.fromEntries(st.cards.map((c) => [c.id, c])), context: st.context, pendingCardId: st.cards.find((c) => !c.answered && !c.auto && c.actions.length)?.id ?? null, findings: restored.findings, events: restored.events, attention: null, ghost: null, currentPhase: null, retrying: null });
    },
    async detach() {
      unsub?.(); unsub = null;
      await get().harness?.detach();
      // Everything per session goes back to its initial value: findings, presence, ghost, focus and the developer
      // event tail must not leak into the next session opened in this tab.
      set({ harness: null, ready: false, state: EMPTY_STATE, turns: [], cards: {}, pendingCardId: null, pending: [], context: null, focus: [], selection: [], selectionSkipped: false, attention: null, lastApplied: null, turnChanges: null, currentPhase: null, ghost: null, findings: [], checked: false, events: [], retrying: null, plan: null });
    },
    async send(m) {
      const h = get().harness;
      if (!h || !get().ready) {
        set((s) => reduceEvent(s, { kind: "system", text_key: "chat.notReady", severity: "error" }));
        throw new Error("NOT_READY"); // the composer keeps the typed text
      }
      // The harness assigns the turn number; until `turn_started` arrives the message is pending.
      const msg: ChatMessage = { id: `m${++msgSeq}`, kind: "user", turn: 0, text: m.text, refs: m.refs };
      set((s) => ({ pending: [...s.pending, msg] }));
      try {
        await h.send(m);
      } catch (e) {
        // The message never became a turn: drop its pending bubble, show the error and let the composer
        // put the text back (typed content is never lost).
        const err = e instanceof IpcFailure ? e.error : { code: "SEND_FAILED", message: String(e), req_id: "" };
        set((s) => ({ ...reduceEvent({ ...s, pending: s.pending.filter((p) => p.id !== msg.id) }, { kind: "error", turn: null, error: err }), pending: s.pending.filter((p) => p.id !== msg.id), state: h.state() }));
        throw e;
      }
      set({ state: h.state() });
    },
    async stop(force) { await get().harness?.stop(force); },
    async setMode(mode, cid) { const h = get().harness; if (!h) return; await h.setMode(mode, cid); set({ state: h.state() }); },
    async setPolicy(policy, cid) { const h = get().harness; if (!h) return; await h.setPolicy(policy, cid); set({ state: h.state() }); },
    async answerCard(card_id, action_id, free_text, cid) {
      const h = get().harness; if (!h) return;
      try {
        await h.answerCard(card_id, action_id, free_text, cid);
      } catch (e) {
        // CONSENT_REQUIRED / CARD_UNKNOWN / grant failures: show them in the stream and rethrow so the card can react.
        const err = e instanceof IpcFailure ? e.error : { code: "CARD_ANSWER_FAILED", message: String(e), req_id: "" };
        const card = get().cards[card_id];
        set((s) => reduceEvent(s, { kind: "error", turn: card?.turn ?? null, error: err }));
        throw e;
      }
      set({ state: h.state(), plan: h.plan() });
    },
    async rollbackBefore(turn, cid, opts) {
      const h = get().harness; if (!h) return "NOT_ATTACHED";
      try {
        await h.rollbackBefore(turn, cid, opts);
      } catch (e) {
        // e.g. ROLLBACK_STALE when the project changed since the preview: show it, don't throw.
        const err = e instanceof IpcFailure ? e.error : { code: "ROLLBACK_FAILED", message: String(e), req_id: "" };
        set((s) => reduceEvent(s, { kind: "error", turn: null, error: err }));
        return err.code;
      }
      // Everything the reverted turns produced is gone from disk: their findings close, the canvas overlays reset.
      set((s) => ({ state: h.state(), turns: s.turns.map((t) => (t.turn >= turn && t.turn > 0 ? { ...t, rolled_back: true } : t)), findings: s.findings.map((f) => (f.turn >= turn ? { ...f, resolved: true } : f)), lastApplied: null, turnChanges: null, ghost: null, focus: [], attention: null }));
      return null;
    },
    async compact(level) { await get().harness?.compact(level); },
    setSelection(refs) { get().harness?.setSelection(refs); set({ selection: refs, selectionSkipped: false }); },
    skipSelectionOnce() { get().harness?.setSelection([]); set({ selectionSkipped: true }); },
    async editPlan(patch) { const h = get().harness; if (!h) return; await h.editPlan(patch); set({ plan: h.plan() }); },
    async requestFix(findings, cid) { const h = get().harness; if (!h) return; await h.requestFix(findings, cid); },
    async waiveFinding(f, reason, cid, expires, batch) {
      const h = get().harness; if (!h) return;
      await h.waiveFinding(f, reason, cid, expires, batch);
      // The waived finding closes; the expiry and the reason the human gave are kept, so the row says
      // until when and why without waiting for the next gate run to decorate it again.
      set((st) => ({ findings: st.findings.map((x) => (x.code === f.code && (x.location ?? "") === (f.location ?? "") ? { ...x, resolved: true, waived: true, ...(expires ? { waived_until: expires } : {}), ...(reason ? { waived_reason: reason } : {}) } : x)) }));
    },
    refreshLeadModel() { const h = get().harness; if (h) set({ leadModel: h.leadModel() }); },
    async setThinkingLevel(level) {
      const h = get().harness; if (!h) return;
      try { await h.setThinkingLevel(level); }
      catch (e) {
        const err = e instanceof IpcFailure ? e.error : { code: "THINKING_LEVEL_FAILED", message: String(e), req_id: "" };
        set((s) => reduceEvent(s, { kind: "error", turn: null, error: err }));
      }
      set({ thinkingLevel: h.thinkingLevel() });
    },
    async setLeadModel(id) {
      const h = get().harness; if (!h) return;
      try {
        await h.setLeadModel(id);
      } catch (e) {
        const err = e instanceof IpcFailure ? e.error : { code: "MODEL_SWITCH_FAILED", message: String(e), req_id: "" };
        set((s) => reduceEvent(s, { kind: "error", turn: null, error: err }));
      }
      set({ state: h.state(), leadModel: h.leadModel() });
    },
    setFindingFilter(patch) {
      const next = { ...get().findingFilter, ...patch, severities: { ...get().findingFilter.severities, ...(patch.severities ?? {}) } };
      set({ findingFilter: next });
      const key = projectKey ?? get().state.project_key;
      if (key) usePrefs.getState().setFindingFilter(key, next);
    },
    toggleTurn(turn) { set((s) => ({ turns: s.turns.map((t) => (t.turn === turn ? { ...t, collapsed: !t.collapsed } : t)) })); },
    focusRefs(refs) { set({ focus: refs }); },
  }));
}

function summaryToBlock(s: TurnSummary): TurnBlock {
  return { turn: s.turn, kind: s.kind, mode: s.mode, headline: s.headline, envelope: null, started_at: "", phases: [], messages: [], applied: [], findings: [], summary: s, cost_usd: s.cost_usd, tokens: s.tokens, usageByRole: {}, rolled_back: s.outcome === "rolled_back", collapsed: false, items: [] };
}

/** Merge persisted turn summaries into existing groups by turn number (never a second group per turn). */
export function mergeSummaries(existing: TurnBlock[], summaries: TurnSummary[]): TurnBlock[] {
  const out = existing.slice();
  for (const s of summaries) {
    const i = out.findIndex((t) => t.turn === s.turn);
    if (i >= 0) out[i] = { ...out[i], kind: s.kind, mode: s.mode, headline: out[i].headline || s.headline, summary: s, cost_usd: s.cost_usd, tokens: s.tokens, rolled_back: s.outcome === "rolled_back" };
    else out.push(summaryToBlock(s));
  }
  return out.sort((a, b) => a.turn - b.turn);
}

const bridges = new Map<string, BridgeStore>();
export function bridgeFor(projectKey: string): BridgeStore {
  let b = bridges.get(projectKey);
  if (!b) { b = createBridge(projectKey); bridges.set(projectKey, b); }
  return b;
}
export function dropBridge(projectKey: string): void {
  const b = bridges.get(projectKey);
  if (b) { void b.getState().detach(); bridges.delete(projectKey); }
}
