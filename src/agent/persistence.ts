// SPDX-License-Identifier: Apache-2.0
// Persistence: conversation messages, model calls and metrics via `db_query`;
// journal / turn / ledger via `sidecar_write` (workspace-format.md §2–§4, §13).

import { call } from "../ipc/client";
import type { PendingCardFile, SidecarWrite } from "../ipc/types";
import type { ContentBlock, HMessage, MessageOrigin, MsgMeta, ToolCallRef } from "./context/assembler";
import type { UsageSample } from "./budget";

const MSG_KINDS: readonly MsgMeta["kind"][] = ["user", "turn_begin", "envelope", "sch_summary", "tool", "prose", "marker", "plan_snapshot", "compaction", "refs", "injection", "hard_stop_context"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Known block shapes pass through as stored (optional signature fields included); anything else is dropped. */
function isContentBlock(b: unknown): b is ContentBlock {
  if (!isRecord(b)) return false;
  switch (b.type) {
    case "text": return typeof b.text === "string" && (b.textSignature === undefined || typeof b.textSignature === "string");
    case "image": return typeof b.data === "string" && typeof b.mimeType === "string";
    case "thinking": return typeof b.thinking === "string" && (b.thinkingSignature === undefined || typeof b.thinkingSignature === "string") && (b.redacted === undefined || typeof b.redacted === "boolean");
    default: return false;
  }
}

function isToolCallRef(tc: unknown): tc is ToolCallRef {
  return isRecord(tc) && typeof tc.id === "string" && typeof tc.name === "string" && (tc.at === undefined || typeof tc.at === "number") && (tc.thoughtSignature === undefined || typeof tc.thoughtSignature === "string");
}

function isOrigin(o: unknown): o is MessageOrigin {
  return isRecord(o) && typeof o.api === "string" && typeof o.provider === "string" && typeof o.model === "string";
}

/**
 * A stored `messages.content` value as an `HMessage`, or null when the row cannot be one (a row Rust could
 * not parse comes back as null; a foreign role is skipped). Rows written before thinking blocks and
 * provenance were kept (no `origin`, text-only content, calls without `at`) load unchanged and replay as
 * they always did; unknown block types are dropped rather than sent to a provider that would reject them.
 */
export function coerceStoredMessage(raw: unknown): HMessage | null {
  if (!isRecord(raw) || !isRecord(raw.meta)) return null;
  const m = raw.meta;
  const fallbackKind: MsgMeta["kind"] = raw.role === "assistant" ? "prose" : raw.role === "toolResult" ? "tool" : "user";
  const meta: MsgMeta = { ...(m as Partial<MsgMeta>), turn: typeof m.turn === "number" ? m.turn : 0, task: typeof m.task === "number" ? m.task : 0, kind: MSG_KINDS.includes(m.kind as MsgMeta["kind"]) ? (m.kind as MsgMeta["kind"]) : fallbackKind };
  const content = Array.isArray(raw.content) ? raw.content.filter(isContentBlock) : [];
  switch (raw.role) {
    case "user": return { role: "user", content, meta };
    case "assistant": {
      const toolCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls.filter(isToolCallRef) : [];
      return isOrigin(raw.origin) ? { role: "assistant", content, toolCalls, origin: raw.origin, meta } : { role: "assistant", content, toolCalls, meta };
    }
    case "toolResult":
      if (typeof raw.toolCallId !== "string") return null;
      return { role: "toolResult", toolCallId: raw.toolCallId, toolName: typeof raw.toolName === "string" ? raw.toolName : "", content, isError: raw.isError === true, meta };
    default: return null;
  }
}

export interface ModelCallRecord {
  plan_id: string | null;
  plan_version: number | null;
  turn: number;
  step: string;
  role: string;
  model: string;
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
  cost_usd: number;
  latency_ms: number;
  retry_of: string | null;
}

/**
 * `model_calls` summed per (turn, role) for the project (turn numbers are per project, so the
 * project key plus a turn range identifies the calls of the turns a session restores).
 * `cost_usd` is the recorded cost: a call whose model had no rate stored 0, so a restored turn
 * never claims a price it does not have.
 */
export interface TurnRoleUsage {
  turn: number;
  role: string;
  input: number;
  cache_creation: number;
  cache_read: number;
  output: number;
  cost_usd: number;
  calls: number;
}

export class Persistence {
  constructor(public projectKey: string, public sessionId: string) {}

  async appendMessage(m: HMessage): Promise<void> {
    await call("db_query", { query: { kind: "message_append", session_id: this.sessionId, turn: m.meta.turn, role: m.role, content: m } });
  }

  async loadHistory(): Promise<HMessage[]> {
    const rows = (await call("db_query", { query: { kind: "message_list", session_id: this.sessionId, after_id: null, limit: null } })) as { id: number; content: unknown; compacted_by: string | null }[] | null;
    // A compaction block is appended after the turns it summarises: order by turn (stable) so it sits where
    // the summarised messages were, ahead of everything that came later.
    const out: HMessage[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if (r.compacted_by) continue;
      const m = coerceStoredMessage(r.content);
      if (m) out.push(m);
    }
    return out.sort((a, b) => a.meta.turn - b.meta.turn);
  }

  async recordModelCall(r: ModelCallRecord): Promise<void> {
    await call("db_query", { query: { kind: "model_call_append", project_key: this.projectKey, call: r } });
  }

  /** Per-role usage of the turns in `[from_turn, to_turn]` (both inclusive, `null` = unbounded). */
  async modelCallsByTurn(from_turn: number | null = null, to_turn: number | null = null): Promise<TurnRoleUsage[]> {
    const rows = (await call("db_query", { query: { kind: "model_call_by_turn", project_key: this.projectKey, from_turn, to_turn } })) as TurnRoleUsage[] | null;
    return Array.isArray(rows) ? rows : [];
  }

  async metric(kind: string, value: number, dims: Record<string, unknown> = {}): Promise<void> {
    await call("db_query", { query: { kind: "metric_append", project_key: this.projectKey, kind_: kind, value, dims } });
  }

  async sidecar(w: SidecarWrite): Promise<void> {
    await call("sidecar_write", { project_key: this.projectKey, write: w });
  }

  journal(entry: Record<string, unknown>): Promise<void> {
    return this.sidecar({ kind: "journal", entry });
  }

  ledger(turn: number, step: string, phase: "intended" | "applied" | "done" | "failed" | "injected" | "denied", payload: unknown): Promise<void> {
    return this.sidecar({ kind: "ledger", turn, step, phase, payload });
  }

  /** Write (or clear with `null`) the card a turn is waiting on (crash-recovery.md §3 "waiting"). */
  pendingCard(turn: number, card: PendingCardFile | null): Promise<void> {
    return this.sidecar({ kind: "pending_card", turn, card });
  }

  async readPendingCard(turn: number): Promise<PendingCardFile | null> {
    const r = (await call("sidecar_read", { project_key: this.projectKey, kind: "pending_card", turn })) as PendingCardFile | null;
    return r && typeof r === "object" && r.card ? r : null;
  }

  turn(turn: number, turn_json: unknown): Promise<void> {
    return this.sidecar({ kind: "turn", turn, turn_json });
  }

  async readTurn(turn: number): Promise<unknown> {
    return call("sidecar_read", { project_key: this.projectKey, kind: "turn", turn });
  }

  async readLedger(turn: number): Promise<{ step: string; phase: string; payload: unknown }[]> {
    const r = (await call("sidecar_read", { project_key: this.projectKey, kind: "ledger", turn })) as { step: string; phase: string; payload: unknown }[] | null;
    return r ?? [];
  }

  /**
   * Record a compaction. For L2 the summarised messages are marked in the DB by turn range so `loadHistory`
   * skips them, with the same exclusions `isProtected` applied in memory (`keep.turns`: current / hard-stop
   * turn; `keep.min_task`: recent tasks kept whole; markers and plan snapshots are never marked), and the
   * block messages that replaced them are appended so a restored session sees the same history.
   */
  async compaction(level: 1 | 2 | 3, from_turn: number, to_turn: number, reclaimed: number, block_sha256: string, keep: { turns: number[]; min_task: number }, blocks: HMessage[]): Promise<void> {
    from_turn = Math.max(0, from_turn);
    to_turn = Math.max(from_turn, to_turn);
    await call("db_query", { query: { kind: "compaction_append", project_key: this.projectKey, session_id: this.sessionId, level, from_turn, to_turn, reclaimed, block_sha256 } });
    if (level >= 2) {
      await call("db_query", { query: { kind: "messages_compact", session_id: this.sessionId, from_turn, to_turn, keep_turns: keep.turns, min_task: keep.min_task, compaction: { level, block_sha256, from_turn, to_turn, reclaimed } } });
      for (const b of blocks) await this.appendMessage(b);
    }
  }
}

export function usageToRecord(u: UsageSample, base: Omit<ModelCallRecord, "input" | "cache_creation" | "cache_read" | "output">): ModelCallRecord {
  return { ...base, input: u.input, cache_creation: u.cacheWrite, cache_read: u.cacheRead, output: u.output };
}
