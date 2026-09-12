// SPDX-License-Identifier: Apache-2.0
// Shared state seen by policy hooks. Hooks are pure functions over this state
// plus the call under evaluation; they never perform IO.

import type { Envelope, Mode, Policy, TurnKind } from "../../ipc/types";
import type { Role } from "../api";

export interface ToolCallView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  role: Role;
  /** Position inside the assistant message (for one-D-per-message). */
  index: number;
  siblings: { name: string }[];
}

export interface ToolResultView {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  data: unknown;
}

export interface Finding {
  code: string;
  severity: "Error" | "Warning" | "Info" | string;
  message?: string;
  location?: string;
  evidence?: unknown;
  remediation?: string;
  refs?: string[];
  /** Instance names path (`/`, `/Power/`) the finding sits on. */
  sheet?: string;
  /** Sheet file the finding sits in, relative to the project root, when the engine knows it. */
  file?: string;
  /** Canvas anchor for the finding's marker, when the engine or the advisory resolved one. */
  at_mil?: [number, number];
  /** An unexpired project waiver covers this finding: it is reported, but it never counts. */
  waived?: boolean;
  /** Expiry of that waiver (ISO instant), when the record carries one. */
  waived_until?: string;
  /** Reason written when the waiver was granted. */
  waived_reason?: string;
}

/**
 * Is this finding hidden by a live project waiver? Waived rows stay visible (with their expiry) but
 * are excluded from every count, verdict and Fixer dispatch — the engine already excludes them from
 * the gate verdict, and this keeps the harness's own arithmetic in step with it.
 */
export function isWaived(f: Pick<Finding, "waived" | "waived_until">): boolean {
  return f.waived === true || !!f.waived_until;
}

export interface NetChange {
  kind: "Split" | "Merged" | "Renamed" | "Created" | "Removed" | "MembersChanged";
  name?: string;
  names?: string[];
  into?: string;
  sources?: { name: string; named: boolean }[];
  named?: boolean;
}

/** Turn-level accumulators relative to the turn checkpoint (P2). */
export interface Accumulators {
  components_added: number;
  components_deleted: number;
  wires_added: number;
  labels_added: number;
  /** Moves and re-poses applied this turn (`components_moved_max`). */
  components_moved: number;
  /** Property / attribute edits applied this turn (`properties_changed_max`). */
  properties_changed: number;
  /** Designators this turn placed: editable and movable whatever `refs_editable` says. */
  refs_created: string[];
  apply_count: number;
  sheets_touched: string[];
  /** seed → coordinates applied in this group (P12). */
  applied_seeds: Record<string, string>;
}

export function emptyAccumulators(): Accumulators {
  return { components_added: 0, components_deleted: 0, wires_added: 0, labels_added: 0, components_moved: 0, properties_changed: 0, refs_created: [], apply_count: 0, sheets_touched: [], applied_seeds: {} };
}

export interface FixerState {
  /** key `${step}:${phase}` → attempts */
  attempts: Record<string, number>;
  /** key `${step}:${phase}` → fingerprints seen (stall / oscillation detection is per phase) */
  fingerprints: Record<string, string[]>;
  /** key `${step}:${phase}` → error counts per attempt */
  errorCounts: Record<string, number[]>;
}

export interface RefdesLease {
  prefix: string;
  ranges: [number, number][];
}

export interface TurnPolicyState {
  /** The post-apply stylist Fixer round already ran for this step. */
  styleFixed?: boolean;
  turn: number;
  kind: TurnKind | null;
  began: boolean;
  mode: Mode;
  policy: Policy;
  role: Role;
  buildSession: string | null;
  envelope: Envelope | null;
  /**
   * The non-model upper bound this turn's declaration was intersected with: the approved plan step (or
   * the whole approved plan) when there is one, otherwise the Rust session ceiling (red line 13). The
   * effective `envelope` above is that bound narrowed by the model's own `turn.begin`, so a refusal that
   * the ceiling would not have raised is the model narrowing itself, not a human decision — see
   * `selfNarrowedDeny` in hooks.ts. `null` until `turn.begin` succeeds.
   */
  ceiling: Envelope | null;
  checkpointed: boolean;
  acc: Accumulators;
  fixer: FixerState;
  leases: RefdesLease[];
  /** Refdes currently occupied in the project (from sch.summary). */
  occupied: Record<string, number[]>;
  statusCount: Record<string, number>;
  /** (step, section) injections already done (P9). */
  injections: Set<string>;
  step: string;
  /** Unlocked single-use actions from approved hard stops: payload sha → grant kind. */
  unlocked: Map<string, string>;
  /** Names of nets that exist and are named (for P3/P11). */
  namedNets: Set<string>;
  external: { locked: boolean; changed: boolean; outOfScope: boolean; verifyFailed: boolean };
  budgetExhausted: string | null;
  rulesUnconfirmed: boolean;
  /** turn.begin succeeded at least once this turn: a later declaration re-declares the same Rust turn. */
  beganOnce?: boolean;
  /** sha256 of the op-list the harness itself is about to apply (ercfix / stylist / title block), see `isHarnessList`. */
  harnessOplistSha?: string | null;
  /**
   * The current user message, verbatim. Read by `pNoAsk` only, to honour "make reasonable assumptions
   * and do not ask me questions". It is the human's own words, so it is the one string a hook may take
   * an instruction from; tool results and file content stay untrusted evidence (red line 21).
   */
  userText?: string;
}

export function emptyFixerState(): FixerState {
  return { attempts: {}, fingerprints: {}, errorCounts: {} };
}

export function newTurnPolicyState(turn: number, mode: Mode, policy: Policy, role: Role, buildSession: string | null): TurnPolicyState {
  return {
    turn, kind: null, began: false, mode, policy, role, buildSession, envelope: null, ceiling: null, checkpointed: false,
    acc: emptyAccumulators(), fixer: emptyFixerState(), leases: [], occupied: {}, statusCount: {}, injections: new Set(),
    step: "s0", unlocked: new Map(), namedNets: new Set(),
    external: { locked: false, changed: false, outOfScope: false, verifyFailed: false }, budgetExhausted: null, rulesUnconfirmed: false,
  };
}

/**
 * The part of the envelope a denied call has to satisfy, small enough to travel in the tool
 * result. Without it the model was told "op X not allowed" / "components_added 9 > 6" and had no
 * way to see what *is* allowed, so it retried the same op-list (see the P2 denies in hooks.ts).
 */
export interface DenyEnvelope {
  sheets: string[];
  allowed_ops: string[];
  /** components still addable in this turn: `components_added_max` minus what the turn already added. */
  components_remaining: number;
}

export type HookVerdict =
  | { kind: "allow" }
  | { kind: "deny"; policy_id: string; reason: string; remediation?: string; allowed_alternative?: string; hard_stop?: string; card_payload?: Record<string, unknown>; envelope?: DenyEnvelope }
  | { kind: "inject"; policy_id: string; text: string; section?: string }
  | { kind: "retry_with"; policy_id: string; text: string };

export function deny(policy_id: string, reason: string, extra: Partial<Extract<HookVerdict, { kind: "deny" }>> = {}): HookVerdict {
  return { kind: "deny", policy_id, reason, ...extra };
}
export const ALLOW: HookVerdict = { kind: "allow" };

/** Encoding of a deny as a tool_result (agent-runtime.md §8.1 ③). */
export function denyResult(v: Extract<HookVerdict, { kind: "deny" }>): { is_error: true; policy_id: string; reason: string; remediation?: string; allowed_alternative?: string; envelope?: DenyEnvelope } {
  const out: { is_error: true; policy_id: string; reason: string; remediation?: string; allowed_alternative?: string; envelope?: DenyEnvelope } = { is_error: true, policy_id: v.policy_id, reason: v.reason };
  if (v.remediation) out.remediation = v.remediation;
  if (v.allowed_alternative) out.allowed_alternative = v.allowed_alternative;
  // The envelope is the only part of the card payload the model can act on; the rest of
  // `card_payload` is for the human card and stays out of the tool result.
  if (v.envelope) out.envelope = v.envelope;
  return out;
}
