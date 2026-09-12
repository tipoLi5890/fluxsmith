// SPDX-License-Identifier: Apache-2.0
// ContextAssembler — renders `tools → system → messages` with a byte-stable
// prefix (caching-strategy.md §1–§2). Mode, policy, plan snapshot and
// sch.summary are injected as tail messages, never into system.

import type { Mode, Policy } from "../../ipc/types";
import { renderToolTable, type ToolDef } from "../tools/manifest";
import { canonicalJson, sha256Hex } from "../util";

/** `textSignature` is the OpenAI Responses message id pi keeps on the block; absent everywhere else. */
export type TextBlock = { type: "text"; text: string; textSignature?: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
/**
 * A reasoning block exactly as pi-ai carries it (`ThinkingContent`, pinned in pi-adapter.ts): the provider's
 * text or summary, the opaque signature (Anthropic `signature`; for OpenAI Responses / Codex the whole
 * reasoning item with its id and encrypted content, JSON-encoded) and the redacted flag. Held verbatim so
 * the next call replays the assistant message the provider produced (caching-strategy.md: history is
 * append-only); only a compaction boundary or a provider rejection may drop it, never a call inside a turn.
 */
export type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean };
export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock;

/**
 * Provenance pi stamps on an assistant message. pi replays signed thinking (and OpenAI item ids) only when
 * it matches the model of the next call; anything else is downgraded to plain text, which the provider then
 * sees as a different prefix. Absent on rows written before thinking was kept and on harness-made messages:
 * those replay under `HISTORY_ORIGIN` (pi-adapter.ts), the neutral stamp they always had.
 */
export interface MessageOrigin { api: string; provider: string; model: string }

export interface ToolCallRef {
  id: string;
  name: string;
  args: unknown;
  /** Google-style thought signature riding on the call; replayed as pi received it. */
  thoughtSignature?: string;
  /** Index of the call in the produced content array, so interleaved thinking / text / calls replay in order. */
  at?: number;
}

export type HMessage =
  | { role: "user"; content: ContentBlock[]; meta: MsgMeta }
  | { role: "assistant"; content: ContentBlock[]; toolCalls: ToolCallRef[]; origin?: MessageOrigin; meta: MsgMeta }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; isError: boolean; meta: MsgMeta };

export type AssistantHMessage = Extract<HMessage, { role: "assistant" }>;

export interface MsgMeta {
  turn: number;
  /** Task index (continuous-run turns share a task). */
  task: number;
  kind: "user" | "turn_begin" | "envelope" | "sch_summary" | "tool" | "prose" | "marker" | "plan_snapshot" | "compaction" | "refs" | "injection" | "hard_stop_context";
  /** L1 pruned header replaced the original body. */
  pruned?: boolean;
  /** Original bytes before pruning (for ring breakdown). */
  bytes?: number;
  /** Unpaired tool_use protection. */
  paired?: boolean;
  /** The assistant message's thinking blocks were dropped (compaction boundary or provider rejection). */
  thinking_dropped?: boolean;
}

export interface AssembledRequest {
  tools: { name: string; description: string; parameters: unknown }[];
  system: string;
  messages: HMessage[];
  /** Indexes of messages that carry cache breakpoints (B, C, D). */
  breakpoints: { plan?: number; lastTurn?: number; rolling?: number };
  prefixSha: string;
}

export interface AssemblerInput {
  toolTable: ToolDef[];
  coreRules: string;
  skillsL0: string;
  planSnapshot: { id: string; version: number; text: string } | null;
  mode: Mode;
  policy: Policy;
  history: HMessage[];
  /** Whether the model accepts mid-conversation role:"system" markers. */
  systemMarkers: boolean;
}

export function markerText(mode: Mode, policy: Policy, planRef: string | null): string {
  return `<<mode ${mode} policy ${policy}${planRef ? ` plan ${planRef}` : ""}>>`;
}

export function assemble(i: AssemblerInput): AssembledRequest {
  const tools = renderToolTable(i.toolTable);
  const system = `${i.coreRules.trim()}\n\n${i.skillsL0.trim()}`.trim();
  const messages: HMessage[] = [];
  const breakpoints: AssembledRequest["breakpoints"] = {};
  if (i.planSnapshot) {
    messages.push({ role: "user", content: [{ type: "text", text: `<plan_snapshot id="${i.planSnapshot.id}" version="${i.planSnapshot.version}">\n${i.planSnapshot.text}\n</plan_snapshot>` }], meta: { turn: 0, task: 0, kind: "plan_snapshot" } });
    breakpoints.plan = messages.length - 1;
  }
  const planRef = i.planSnapshot ? `${i.planSnapshot.id}@${i.planSnapshot.version}` : null;
  messages.push({ role: "user", content: [{ type: "text", text: markerText(i.mode, i.policy, planRef) }], meta: { turn: 0, task: 0, kind: "marker" } });
  const start = messages.length;
  messages.push(...i.history);
  // Breakpoint C: end of the previous turn; D: rolling on the latest tool result every ~15 blocks.
  const lastTurn = i.history.length ? i.history[i.history.length - 1].meta.turn : 0;
  let prevTurnEnd = -1;
  for (let k = i.history.length - 1; k >= 0; k--) if (i.history[k].meta.turn < lastTurn) { prevTurnEnd = k; break; }
  if (prevTurnEnd >= 0) breakpoints.lastTurn = start + prevTurnEnd;
  let blocks = 0;
  for (let k = i.history.length - 1; k >= 0; k--) {
    blocks += i.history[k].content.length;
    if (i.history[k].role === "toolResult" && blocks >= 15) { breakpoints.rolling = start + k; break; }
  }
  if (breakpoints.rolling === undefined) {
    for (let k = i.history.length - 1; k >= 0; k--) if (i.history[k].role === "toolResult") { breakpoints.rolling = start + k; break; }
  }
  const prefixSha = sha256Hex(canonicalJson({ tools, system }));
  return { tools, system, messages, breakpoints, prefixSha };
}

/** Lint for the cache prefix: forbidden volatile tokens (caching-strategy.md §7). */
const FORBIDDEN = [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, /\bDate\.now\b/, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /<<mode /, /\bpolicy=(ask|review|auto)\b/];

export function lintPrefix(system: string, tools: { description: string }[]): string[] {
  const problems: string[] = [];
  for (const re of FORBIDDEN) {
    if (re.test(system)) problems.push(`system contains volatile content matching ${re}`);
    for (const t of tools) if (re.test(t.description)) problems.push(`tool description contains ${re}`);
  }
  return problems;
}
