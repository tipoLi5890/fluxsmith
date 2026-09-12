// SPDX-License-Identifier: Apache-2.0
// Public surface of the agent harness as seen by the UI. The harness
// (`src/agent/**`) implements `HarnessApi`; the UI (`src/ui/**`) only ever
// talks to this interface and renders `TurnEvent`s. Keep this file free of
// React and of pi types (those stay behind `pi-adapter.ts`).

import type { Envelope, Mode, Policy, TurnKind, IpcError, AttachInfo } from "../ipc/types";
import type { AcceptanceResult } from "./plans/acceptance";
import type { WaiveBatch } from "./review-waiver";

export type { AcceptanceResult, AcceptanceStatus } from "./plans/acceptance";

export type Phase = "thinking" | "exploring" | "designing" | "building" | "reviewing" | "waiting" | "done" | "stopped" | "failed";
export type Role = "lead" | "architect" | "librarian" | "drafter" | "fixer" | "reviewer" | "explainer" | "sourcer" | "facts" | "compaction" | "probe";

/** A chat reference chip (`docs/chat-references-and-attachments.md` §1.2). */
export type Ref =
  | { kind: "component"; ref: string; sheet?: string }
  // `sheet` on a net says which sheet instance to look at it on (a net can reach several); it is a
  // view hint for the canvas, never part of the net's identity.
  | { kind: "net"; name: string; sheet?: string }
  | { kind: "sheet"; path: string }
  | { kind: "block"; group: string; sheet?: string }
  | { kind: "region"; sheet: string; bbox_mil: [[number, number], [number, number]] }
  | { kind: "turn"; turn: number }
  | { kind: "finding"; code: string; location?: string; sheet?: string }
  | { kind: "attachment"; sha256: string; label: string };

export interface UserMessage {
  text: string;
  refs: Ref[];
  attachments: AttachInfo[];
  /** `/compact` etc. are parsed by the harness, not the UI. */
  session_id: string;
}

/** Cards are the only way the agent asks the human for anything. */
export type CardKind =
  | "plan_approval" | "change" | "hard_stop" | "question" | "mode_suggestion" | "cost" | "waiver" | "intent"
  | "lib_import" | "skill_draft" | "rollback" | "system" | "compaction" | "env" | "provider_consent" | "parts_decision" | "review" | "intake";

export interface CardAction {
  id: string;
  /** i18n key rendered by the UI */
  label_key: string;
  /** Raw text (e.g. an ask_user option) rendered as-is instead of `label_key`. */
  label?: string;
  style: "primary" | "secondary" | "destructive";
  /** Consent-bearing actions produce a consent event + grant on click. */
  consent?: { grant_kind: string; payload_sha256: string };
}

export interface Card {
  id: string;
  kind: CardKind;
  turn: number;
  title: string;
  /** Sanitised markdown (no raw HTML). */
  body_md: string;
  data?: unknown;
  actions: CardAction[];
  answered?: { action_id: string; at: string; free_text?: string };
  /** Auto policy adjudicated this card without a human. */
  auto?: { decision: string; reason: string };
}

export interface ActivityLine {
  id: string;
  role: Role;
  phase: Phase;
  /** Tool name or short label; rendered as text only. */
  label: string;
  detail?: string;
  started_at: string;
  ended_at?: string;
  ok?: boolean;
  bytes?: number;
  /** Nested under another line (a subagent's own tool calls). */
  parent_id?: string;
  kind?: "tool" | "thinking" | "subagent";
  /** Estimated tokens received so far (thinking / streaming lines). */
  tokens?: number;
}

/**
 * What KiCad's own ERC (`kicad-cli sch erc`, advisory) said after the turn's last write. `available:
 * false` means kicad-cli did not run (absent, sandbox off, timed out): the UI says so rather than
 * showing zero errors, which would read as KiCad approving a design it never saw.
 */
export interface KicadTurnResult { available: boolean; errors: number; warnings: number; note?: string }

/**
 * One object an apply created, exactly as the engine reported it (`per_op[].created`). Everything
 * past `uuid` is optional because only some kinds carry it: a symbol has a designator and a value,
 * a label or power port a net name, a wire neither.
 */
export interface CreatedObject { uuid: string; kind: string; reference?: string; value?: string; name?: string; sheet?: string }

/** One field an apply replaced on an object that already existed (`per_op[].changed`). */
export interface ChangedField { reference: string; field: string; before: string; after: string; sheet?: string }

/**
 * One line of `per_op[].warnings`: what the engine did differently from what the op-list authored
 * (a nudged placement, a route drawn across a pin). `code` is the engine's own prefix and `message`
 * its English sentence -- untrusted text, rendered as a text node and never judged by the harness.
 */
export interface ApplyWarning { code: string; message: string; sheet?: string; at_mil?: [number, number] }

export interface TurnSummary {
  turn: number;
  kind: TurnKind;
  mode: Mode;
  headline: string;
  /** `done_with_findings`: the work finished, and unwaived engine Errors are still open (a report). */
  outcome: "done" | "done_with_findings" | "stopped" | "failed" | "running" | "rolled_back";
  applied: { components_added: number; components_deleted: number; wires_added: number; /** Power ports and PWR_FLAGs, counted apart from BOM components (they are net anchors, not parts). Absent in turns restored from an older session. */ power_ports_added?: number; /** Parts whose pose the turn changed (moves and rotations of existing parts). */ components_moved?: number; sheets: string[]; /** Named-net changes across the turn's applies (engine net_diff, never computed by the UI). */ nets?: NetSummary;
    /** What the turn drew, over every apply of the turn, in op order (bounded). Absent in turns restored from an older session. */ created?: CreatedObject[];
    /** Fields the turn replaced on objects that already existed, in op order (bounded). */ changed?: ChangedField[];
    /** What the engine warned about while applying this turn's op-lists (bounded); a report, never a verdict. */ warnings?: ApplyWarning[] };
  /** KiCad's own ERC after this turn's writes, when it ran (advisory; the engine gate is the authority). */
  kicad?: KicadTurnResult;
  /** How the plan's typed acceptance stood at this turn's gate step (engine results only, red line 6). */
  acceptance?: AcceptanceResult[];
  cost_usd: number;
  tokens: number;
  duration_ms: number;
  checkpoint?: number;
}

export interface NetSummary { created: string[]; merged: string[]; split: string[]; renamed: string[] }

export interface ContextUsage {
  used_tokens: number;
  ceiling_tokens: number;
  pct: number;
  level: "ok" | "hint" | "auto" | "emergency";
  last_compaction?: { level: 1 | 2 | 3; reclaimed: number; at: string };
}

export type TurnEvent =
  | { kind: "turn_started"; turn: number; turn_kind: TurnKind; mode: Mode; headline: string; envelope: Envelope | null }
  | { kind: "phase"; turn: number; role: Role; phase: Phase; detail?: string }
  /** A verified-but-unapplied op-list preview the canvas may draw as a ghost layer; cleared by `applied`. */
  | { kind: "preview"; turn: number; preview_id: string; sheet: string }
  | { kind: "status"; turn: number; text: string }
  | { kind: "assistant_delta"; turn: number; message_id: string; delta: string }
  | { kind: "assistant_done"; turn: number; message_id: string; text: string }
  | { kind: "activity"; turn: number; line: ActivityLine }
  | { kind: "card"; card: Card }
  | { kind: "card_answered"; card_id: string; action_id: string; free_text?: string }
  | { kind: "applied"; turn: number; run_id: string; target: string; counts: { added: number; deleted: number; wires: number; /** Power ports / PWR_FLAGs, not counted in `added` (they are net anchors, not parts). */ power_ports?: number; /** Existing parts this apply moved or re-posed. */ moved?: number }; net_diff: unknown; focus?: Ref[]; /** Objects created by this apply in op order (canvas reveals them one by one, the footer names them). */ created?: CreatedObject[]; /** Fields this apply replaced on objects that already existed. */ changed?: ChangedField[] }
  /** What the agent is looking at right now (a read tool, a drafter's region, a fixer's finding); the canvas moves its presence marker there. */
  | { kind: "attention"; turn: number; role: Role; label: string; refs?: Ref[]; region_mil?: [[number, number], [number, number]]; sheet?: string }
  | { kind: "findings"; turn: number; findings: unknown[]; /** A complete gate run: findings absent from it are resolved. */ full?: boolean }
  | { kind: "focus"; refs: Ref[] }
  | { kind: "context"; usage: ContextUsage }
  /** One model call, as recorded in `model_calls` (persistence.ts): lets the UI show cost and cache hit per role.
   *  `cost_usd` is null when no rate applies to that provider/model (unbilled or missing from the rate table). */
  | { kind: "usage"; turn: number; role: Role; input: number; cache_read: number; cache_creation: number; output: number; cost_usd: number | null }
  | { kind: "budget"; turn: number; used: { tokens: number; usd: number; tool_calls: number; wall_ms: number }; limits: { tokens: number | null; usd: number | null; tool_calls: number | null; wall_ms: number | null }; warn: boolean }
  | { kind: "turn_ended"; summary: TurnSummary }
  | { kind: "mode_changed"; mode: Mode; by: "user" | "suggestion" }
  | { kind: "policy_changed"; policy: Policy }
  | { kind: "system"; text_key: string; params?: Record<string, string | number>; severity: "info" | "warning" | "error" }
  | { kind: "error"; turn: number | null; error: IpcError };

export interface PlanView {
  id: string;
  version: number;
  status: "draft" | "approved" | "in_progress" | "paused" | "done" | "done_with_skips" | "abandoned";
  goal: string;
  constraints: string[];
  /** What the Architect assumed because the human did not say it (kept apart from the human's constraints). */
  assumptions: string[];
  /** Decisions the Architect left open. An answered question leaves this list and becomes a constraint. */
  open_questions: string[];
  rails: string[];
  steps: { id: string; kind: string; block?: string; summary: string; parts: string[]; status: "pending" | "current" | "done" | "skipped"; /** Why the step was skipped (Auto) or failed. */ note?: string }[];
  budget: { tokens: number | null; cost_usd: number | null };
  /** Markdown rendering of the plan (same text as the plan card body). */
  body_md: string;
  /** Blocks with their sheet, floorplan region and the draft step that draws them (canvas context menu).
   *  `acceptance` is what the block declared the gate should measure (`derived` rows were restated by the
   *  harness from the plan's own parts and nets); it is a statement of intent, never a verdict. */
  blocks: { id: string; sheet: string; step_id: string | null; region_mil: [[number, number], [number, number]] | null; summary: string; acceptance: { label: string; type: string; derived: boolean }[] }[];
}

/** Editable parts of a plan from the plan panel. */
export interface PlanPatch { goal?: string; constraints?: string[]; steps?: { id: string; summary: string }[] }

/** A finding as the UI tracks it across turns. */
export interface FindingRow {
  /** Engine anchor in mil when the finding has no refs (labels, wires, text). */
  at_mil?: [number, number];
  code: string; severity: string; message: string; sheet?: string; refs?: string[]; location?: string; remediation?: string;
  origin: "engine" | "advisory"; confidence?: number | string; turn: number; resolved: boolean;
  /** Sheet file the finding sits in, relative to the project root, when the engine knows it. */
  file?: string;
  /** A live project waiver covers this finding: it is listed, greyed, and never counted. */
  waived?: boolean;
  /** Expiry of the waiver that hides this finding (`YYYY-MM-DD` or an ISO instant), when it was waived. */
  waived_until?: string;
  /** Reason written when the waiver was granted (engine-provided). */
  waived_reason?: string;
  /** What the check measured, as the engine reported it (`gates.rs` `evidence`): untrusted key/value data. */
  evidence?: Record<string, unknown>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

export type ReplayItem = TurnEvent | { kind: "user_message"; turn: number; text: string; refs: Ref[] };

export interface HarnessState {
  project_key: string | null;
  session_id: string | null;
  mode: Mode;
  policy: Policy;
  running: boolean;
  current_turn: number | null;
  build_session: string | null;
  plan_ref: string | null;
  turns: TurnSummary[];
  cards: Card[];
  context: ContextUsage | null;
}

export interface HarnessApi {
  /** Bind to a project + conversation session (loads history, sidecar state). */
  attach(project_key: string, session_id: string): Promise<void>;
  detach(): Promise<void>;
  state(): HarnessState;
  subscribe(handler: (e: TurnEvent) => void): () => void;
  /** Human sets the mode. Entering Build requires consent (consent_event_id from the UI click). */
  setMode(mode: Mode, consent_event_id?: string): Promise<void>;
  setPolicy(policy: Policy, consent_event_id?: string): Promise<void>;
  send(message: UserMessage): Promise<void>;
  /** Stop the current turn (graceful: pending tool_use get `user_stopped`). */
  stop(force?: boolean): Promise<void>;
  answerCard(card_id: string, action_id: string, free_text?: string, consent_event_id?: string): Promise<void>;
  /**
   * Only human rollback; consent already recorded by the UI. `state_sha256`
   * comes from `rollback_preview`: Rust refuses (`ROLLBACK_STALE`) when the
   * project changed after the human was shown what would happen.
   */
  rollbackBefore(turn: number, consent_event_id: string, opts?: { state_sha256?: string }): Promise<void>;
  /**
   * Restore the one-shot snapshot a rollback took of the files it overwrote
   * (D-34). Single use, and not a redo: the reverted turns stay reverted.
   */
  restorePreRollback(turn: number, consent_event_id: string): Promise<void>;
  compact(level?: 1 | 2 | 3): Promise<void>;
  /** Canvas selection pushed by the UI (for `canvas.selection` tool). */
  setSelection(refs: Ref[]): void;
  /**
   * Switch the lead model between turns (`"<provider_id>/<model>"`). Persists
   * `models_by_role.lead`, rebuilds the model and discards the provider-side
   * prompt cache expectation; refused while a turn is running.
   */
  setLeadModel(id: string): Promise<void>;
  /** Current lead model id (`"<provider_id>/<model>"`) or null. */
  leadModel(): string | null;
  /**
   * Event sequence rebuilt from the persisted transcript, so the UI can restore
   * bubbles, activity lines and turn dividers after a restart. `user_message`
   * items precede their turn's `turn_started`.
   */
  replay(): ReplayItem[];
  /** The current DesignPlan (draft or approved) with step progress, for the plan panel. */
  plan(): PlanView | null;
  /** Reasoning effort requested from the provider (persisted in settings.agent.thinking_level). */
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  thinkingLevel(): ThinkingLevel;
  /** Edit goal / constraints / step summaries from the plan panel (draft: new draft version; approved: plan change). */
  editPlan(patch: PlanPatch): Promise<void>;
  /** Fix the given findings (ercfix + stylist + Fixer rounds, then a gate run). Entering Build needs the consent event. */
  requestFix(findings: unknown[], consent_event_id?: string): Promise<void>;
  /**
   * Record a waiver for one finding ("known good"); the consent event is the click on the panel.
   * `expires` (`YYYY-MM-DD` or an ISO instant) is what the human chose on the card; without it Rust
   * applies its own 90-day default. An Error-severity finding is refused (WAIVER_SEVERITY) unless
   * both an expiry and a reason of at least 12 characters travel with it.
   */
  /**
   * `batch` is what the consent event was recorded over (`waiveBatch` / `waiveConsentSha`): every
   * grant of this action repeats it, so Rust can check that the finding being waived is one the
   * human ticked. Without it the grant falls back to hashing this single finding.
   */
  waiveFinding(finding: { code: string; refs?: string[]; severity?: string; location?: string }, reason: string, consent_event_id: string, expires?: string | null, batch?: WaiveBatch): Promise<void>;
}
