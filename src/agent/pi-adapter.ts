// SPDX-License-Identifier: Apache-2.0
// pi-adapter — the ONLY module importing pi-ai / pi-agent-core.
// Responsibilities: model construction per provider, streaming with cache
// breakpoints, usage extraction, retry/backoff + stall detection
// (provider-resilience.md), image/web-tool passthrough, and running the
// pi-agent-core loop with OUR tool scheduler (parallel R/C capped, serial
// otherwise, one D per message enforced by the hook bus).

import { effectiveRates } from "./models/rates";
import {
  agentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type AgentToolResult,
  type BeforeToolCallContext,
  type AfterToolCallContext,
  type StreamFn,
} from "@mariozechner/pi-agent-core";
import {
  streamSimple,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ThinkingLevel,
  type ToolCall,
  type TSchema,
  type Usage,
  getModels,
} from "@mariozechner/pi-ai";
import type { ProviderConfig } from "../ipc/types";
import { knownBaseUrl } from "./models/catalog";
import type { HMessage, AssistantHMessage, ContentBlock, MessageOrigin, TextBlock, ThinkingBlock, ToolCallRef } from "./context/assembler";
import { RETRY_AFTER_CAP_S, RETRY_BACKOFF_MS, RETRY_JITTER, RETRY_MAX, STREAM_STALL_MS, REQUEST_TOTAL_TIMEOUT_MS, MODEL_MAX_OUTPUT_TOKENS, TOOL_ARGS_STREAM_MAX_BYTES } from "./limits";
import type { UsageSample } from "./budget";
import type { JsonSchema } from "./tools/manifest";
import { activeRecorder, contextHash } from "./replay/recorder";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelSpec {
  provider: ProviderConfig;
  modelId: string;
}

function apiFor(kind: ProviderConfig["kind"]): Api {
  switch (kind) {
    case "anthropic": return "anthropic-messages";
    case "google": return "google-generative-ai";
    case "openai": return "openai-responses";
    case "openai-codex": return "openai-codex-responses";
    case "mistral": return "mistral-conversations";
    default: return "openai-completions";
  }
}

function providerNameFor(kind: ProviderConfig["kind"]): string {
  return kind === "custom" ? "openai" : kind;
}

/** Build a pi Model from our provider config. Cost fields feed pi's cost calc; ours is authoritative. */
/** Model ids pi-ai knows for a provider kind (empty for custom endpoints). */
export function knownModels(kind: string): string[] {
  const piKind = kind === "custom" ? null : kind;
  if (!piKind) return [];
  try {
    return getModels(piKind as Parameters<typeof getModels>[0]).map((m) => m.id);
  } catch {
    return [];
  }
}

export function buildModel(spec: ModelSpec): Model<Api> {
  const p = spec.provider;
  const [input, cacheWrite, cacheRead, output] = effectiveRates(p, spec.modelId)?.rates ?? [0, 0, 0, 0];
  return {
    id: spec.modelId,
    name: spec.modelId,
    api: apiFor(p.kind),
    provider: providerNameFor(p.kind),
    // Built-in kinds use the path pi-ai expects; settings only store the origin for the whitelist.
    baseUrl: p.kind === "custom" ? p.base_url : (knownBaseUrl(p.kind) ?? p.base_url),
    reasoning: true,
    input: p.vision ? ["text", "image"] : ["text"],
    cost: { input, output, cacheRead, cacheWrite },
    contextWindow: p.context_window,
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
    compat: p.kind === "custom" ? ({ supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: true, cacheControlFormat: undefined } as unknown as Model<Api>["compat"]) : undefined,
  } as Model<Api>;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

// The harness block types are pi's wire types, field for field (red line 11: pi types are pinned here and
// nowhere else). A pi upgrade that changes `ThinkingContent` or `TextContent` fails to compile on these lines
// instead of silently dropping a field the provider needs back.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const PI_TYPE_PINS: { thinking: Same<ThinkingBlock, ThinkingContent>; text: Same<TextBlock, TextContent>; toolCallSignature: Same<ToolCallRef["thoughtSignature"], ToolCall["thoughtSignature"]> } = { thinking: true, text: true, toolCallSignature: true };

/**
 * The stamp assistant messages replay under when they carry no provenance of their own: rows written before
 * thinking blocks were kept, and the harness-made messages that pair a harness-path tool result. pi treats
 * them as cross-model (no thinking to keep, ids normalised), exactly as every replayed message was before.
 */
export const HISTORY_ORIGIN: MessageOrigin = { api: "anthropic-messages", provider: "fluxsmith", model: "history" };

function toPiContent(blocks: ContentBlock[]): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push(textBlock(b));
    else if (b.type === "image") out.push({ type: "image", data: b.data, mimeType: b.mimeType });
    // a thinking block can only belong to an assistant message
  }
  return out;
}

function textBlock(b: TextBlock): TextContent {
  return b.textSignature === undefined ? { type: "text", text: b.text } : { type: "text", text: b.text, textSignature: b.textSignature };
}

function thinkingBlock(b: ThinkingBlock): ThinkingContent {
  const out: ThinkingContent = { type: "thinking", thinking: b.thinking };
  if (b.thinkingSignature !== undefined) out.thinkingSignature = b.thinkingSignature;
  if (b.redacted !== undefined) out.redacted = b.redacted;
  return out;
}

/**
 * The content array of a replayed assistant message, in the order the provider produced it: thinking and
 * text blocks as stored, each tool call back at its recorded index (`at`). Calls without an index (older
 * rows, harness-made messages, a message whose thinking was dropped) follow the text, the shape every
 * provider produced for the harness so far.
 */
function assistantContent(m: AssistantHMessage): AssistantMessage["content"] {
  const blocks: AssistantMessage["content"] = [];
  for (const c of m.content) {
    if (c.type === "text") blocks.push(textBlock(c));
    else if (c.type === "thinking") blocks.push(thinkingBlock(c));
  }
  const calls = m.toolCalls.map((tc) => {
    const block: ToolCall = { type: "toolCall", id: tc.id, name: encodeToolName(tc.name), arguments: (tc.args ?? {}) as Record<string, unknown> };
    if (tc.thoughtSignature !== undefined) block.thoughtSignature = tc.thoughtSignature;
    return { block, at: tc.at };
  });
  const total = blocks.length + calls.length;
  const byIndex = new Map<number, ToolCall>();
  for (const c of calls) if (typeof c.at === "number" && Number.isInteger(c.at) && c.at >= 0 && c.at < total) byIndex.set(c.at, c.block);
  if (byIndex.size !== calls.length) return [...blocks, ...calls.map((c) => c.block)];
  const out: AssistantMessage["content"] = [];
  let next = 0;
  for (let i = 0; i < total; i++) {
    const call = byIndex.get(i);
    if (call) out.push(call);
    else if (next < blocks.length) out.push(blocks[next++]);
  }
  while (next < blocks.length) out.push(blocks[next++]);
  return out;
}

const FIXED_TS = 0; // timestamps must not leak into the cache prefix; providers ignore them anyway

export function toPiMessages(history: HMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of history) {
    if (m.role === "user") out.push({ role: "user", content: toPiContent(m.content), timestamp: FIXED_TS });
    else if (m.role === "assistant") {
      // Nothing to say and nothing called (an aborted/error message that slipped into history, or reasoning
      // with no answer): skip it, strict providers reject an assistant message with no visible content.
      if (!m.toolCalls.length && !m.content.some((c) => (c.type === "text" ? c.text.trim().length > 0 : c.type === "image"))) continue;
      const origin = m.origin ?? HISTORY_ORIGIN;
      out.push({
        role: "assistant",
        content: assistantContent(m),
        api: origin.api as Api, provider: origin.provider, model: origin.model, usage: emptyUsage(), stopReason: m.toolCalls.length ? "toolUse" : "stop", timestamp: FIXED_TS,
      });
    } else out.push({ role: "toolResult", toolCallId: m.toolCallId, toolName: encodeToolName(m.toolName), content: toPiContent(m.content), isError: m.isError, timestamp: FIXED_TS });
  }
  return out;
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/**
 * The harness copy of a produced assistant message: thinking and text blocks verbatim (signatures, redacted
 * payloads, OpenAI item ids included) in the produced order, tool calls with their positions, and the
 * provenance pi needs to replay the thinking. `toPiMessages(fromAssistant(m))` is `m` on the wire.
 */
export function fromAssistant(m: AssistantMessage, turn: number, task: number): HMessage {
  const content: ContentBlock[] = [];
  const toolCalls: ToolCallRef[] = [];
  m.content.forEach((c, at) => {
    if (c.type === "text") content.push(textBlock(c));
    else if (c.type === "thinking") content.push(thinkingBlock(c));
    else if (c.type === "toolCall") {
      const ref: ToolCallRef = { id: c.id, name: decodeToolName(c.name), args: c.arguments, at };
      if (c.thoughtSignature !== undefined) ref.thoughtSignature = c.thoughtSignature;
      toolCalls.push(ref);
    }
  });
  return { role: "assistant", content, toolCalls, origin: { api: m.api, provider: m.provider, model: m.model }, meta: { turn, task, kind: toolCalls.length ? "tool" : "prose", paired: toolCalls.length === 0 ? undefined : false } };
}

/**
 * The content blocks a tool result actually put on the wire. pi hands `tool_execution_end` the
 * finalized `AgentToolResult` (`{content, details, terminate}`) and then sends a toolResult message
 * carrying only `content`; storing `JSON.stringify(result)` in history would replay a different
 * string than the provider saw and break the cache prefix from that message on (caching-strategy.md
 * §3 "history is append-only"). Non-conforming values fall back to a single text block.
 */
export function toolResultBlocks(result: unknown): ContentBlock[] {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(content)) {
    const out: ContentBlock[] = [];
    for (const c of content as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown }[]) {
      if (c?.type === "text") out.push({ type: "text", text: String(c.text ?? "") });
      else if (c?.type === "image") out.push({ type: "image", data: String(c.data ?? ""), mimeType: String(c.mimeType ?? "image/png") });
    }
    if (out.length) return out;
  }
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? null) }];
}

/**
 * The parts of a pi message that decide what the provider receives: role, content blocks with every
 * signature (thinking signatures and redacted payloads, OpenAI text / reasoning item ids, Google thought
 * signatures), the tool wiring, and for an assistant message its provenance (pi keeps signed thinking and
 * item ids only for the model that produced them). Local bookkeeping (usage, timestamps, tool `details`)
 * is left out. Two calls whose wire forms share a prefix share a cache prefix, so the invariant test
 * compares these strings element by element.
 */
export function wireForm(messages: Message[]): string[] {
  const opt = (k: string, v: unknown): Record<string, unknown> => (v === undefined ? {} : { [k]: v });
  const block = (c: unknown): unknown => {
    const b = c as { type?: string; text?: unknown; textSignature?: unknown; thinking?: unknown; thinkingSignature?: unknown; redacted?: unknown; data?: unknown; mimeType?: unknown; id?: unknown; name?: unknown; arguments?: unknown; thoughtSignature?: unknown };
    switch (b?.type) {
      case "text": return { type: "text", text: String(b.text ?? ""), ...opt("textSignature", b.textSignature) };
      case "thinking": return { type: "thinking", thinking: String(b.thinking ?? ""), ...opt("thinkingSignature", b.thinkingSignature), ...opt("redacted", b.redacted) };
      case "image": return { type: "image", mimeType: String(b.mimeType ?? ""), data: String(b.data ?? "") };
      case "toolCall": return { type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: b.arguments ?? {}, ...opt("thoughtSignature", b.thoughtSignature) };
      default: return { type: String(b?.type ?? "?") };
    }
  };
  return messages.map((m) => {
    const content = Array.isArray(m.content) ? m.content.map(block) : [{ type: "text", text: String(m.content ?? "") }];
    if (m.role === "toolResult") return JSON.stringify({ role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError === true, content });
    if (m.role === "assistant") return JSON.stringify({ role: m.role, api: m.api, provider: m.provider, model: m.model, content });
    return JSON.stringify({ role: m.role, content });
  });
}

export function usageSample(u: Usage): UsageSample {
  return { input: u.input, cacheWrite: u.cacheWrite, cacheRead: u.cacheRead, output: u.output };
}

// ---------------------------------------------------------------------------
// Error classification (provider-resilience.md §1)
// ---------------------------------------------------------------------------

export type ErrorClass = "retryable" | "rate_limit" | "auth" | "quota" | "context_overflow" | "bad_request" | "refusal" | "unsupported_tools" | "aborted" | "client_outdated";

/** Placeholder credential for pi-ai; the real one is injected by Rust. */
export function placeholderApiKey(provider: string): string {
  if (provider === "openai-codex") {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${b64({ alg: "none", typ: "JWT" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "rust-injected" } })}.x`;
  }
  return "rust-injected";
}

export function classifyError(status: number | null, message: string): ErrorClass {
  if (/abort/i.test(message) && status === null) return "aborted";
  // Errors Rust raised before any response head (expired Codex refresh, a denied origin, a rejected request)
  // arrive with no status: classify them by their code so they are neither retried nor shown as "offline".
  if (/\bPROVIDER_AUTH\b/.test(message)) return "auth";
  if (/\bPROVIDER_QUOTA\b/.test(message)) return "quota";
  if (/\b(NET_ORIGIN_DENIED|PROVIDER_BAD_REQUEST|PROVIDER_DEGENERATE_OUTPUT)\b/.test(message)) return "bad_request";
  // A transport failure after the 200 head (Rust cut or lost the body stream) is not a bad request:
  // status is 200 here, so it must be recognised by the message before the status ladder.
  if (/PROVIDER_STREAM_BROKEN|NET_TIMEOUT|NET_OFFLINE|error decoding response body|connection (reset|closed)|unexpected (eof|end)/i.test(message)) return "retryable";
  // Codex reports server-side trouble as an in-stream error event after a 200 head.
  if (/server_is_overloaded|service_unavailable|overloaded_error|server_error|internal_error|temporarily unavailable/i.test(message)) return "retryable";
  // Codex gates models on the client `version` header: not a malformed request, not retryable.
  if (/requires a newer version of codex|upgrade to the latest (app|cli)/i.test(message)) return "client_outdated";
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || /quota|insufficient_quota|billing/i.test(message)) return "quota";
  if (status === 413 || /context (length|window)|too many tokens|maximum context|prompt is too long/i.test(message)) return "context_overflow";
  if (status !== null && (status === 408 || status === 502 || status === 503 || status === 504 || status >= 500)) return "retryable";
  if (status === 400 || status === 422) {
    if (/tool|function/i.test(message) && /unsupported|not supported/i.test(message)) return "unsupported_tools";
    return "bad_request";
  }
  if (/refus/i.test(message)) return "refusal";
  if (status === null) return "retryable"; // network layer
  return "bad_request";
}

export function errorCode(c: ErrorClass): string {
  switch (c) {
    case "retryable": return "NET_TIMEOUT";
    case "rate_limit": return "PROVIDER_RATE_LIMIT";
    case "auth": return "PROVIDER_AUTH";
    case "quota": return "PROVIDER_QUOTA";
    case "context_overflow": return "PROVIDER_CONTEXT_OVERFLOW";
    case "bad_request": return "PROVIDER_BAD_REQUEST";
    case "refusal": return "PROVIDER_REFUSAL";
    case "unsupported_tools": return "PROVIDER_UNSUPPORTED_TOOLS";
    case "aborted": return "USER_STOPPED";
    case "client_outdated": return "PROVIDER_CLIENT_OUTDATED";
  }
}

export function parseRetryAfter(h: string | undefined): number | null {
  if (!h) return null;
  const s = Number(h);
  if (!Number.isNaN(s)) return Math.min(s, RETRY_AFTER_CAP_S) * 1000;
  const t = Date.parse(h);
  if (Number.isNaN(t)) return null;
  return Math.min(Math.max(0, t - Date.now()) / 1000, RETRY_AFTER_CAP_S) * 1000;
}

export function backoffMs(attempt: number, rand = Math.random): number {
  const base = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
  const jitter = 1 + (rand() * 2 - 1) * RETRY_JITTER;
  return Math.round(base * jitter);
}

// ---------------------------------------------------------------------------
// Cache breakpoints (Anthropic explicit; others rely on prefix order)
// ---------------------------------------------------------------------------

export interface Breakpoints {
  /** index into messages[] (pi order) for the plan snapshot (B), last turn end (C), rolling (D) */
  plan?: number;
  lastTurn?: number;
  rolling?: number;
}

type CacheCtl = { type: "ephemeral"; ttl?: "1h" };
interface AnthropicPayload {
  system?: { type: string; text: string; cache_control?: CacheCtl }[];
  tools?: { cache_control?: CacheCtl }[];
  messages?: { role: string; content: string | { type: string; cache_control?: CacheCtl }[] }[];
}

/** Rewrite pi's default cache markers into the A/B/C/D layout (caching-strategy.md §2). */
export function applyAnthropicBreakpoints(payload: unknown, bp: Breakpoints): unknown {
  const p = payload as AnthropicPayload;
  if (!p || !Array.isArray(p.messages)) return payload;
  const long: CacheCtl = { type: "ephemeral", ttl: "1h" };
  const short: CacheCtl = { type: "ephemeral" };
  // Anthropic allows four cache_control blocks per request and the doc's layout is exactly four:
  // A (tools + system) B (plan snapshot) C (last turn end) D (tail). A breakpoint caches everything
  // before it, so ONE marker at the end of the system blocks covers the tool table too; marking the
  // tools as well would be a fifth block and the request would be refused outright.
  if (p.system?.length) {
    for (const s of p.system) delete s.cache_control;
    p.system[p.system.length - 1].cache_control = long;
    if (p.tools?.length) for (const t of p.tools) delete t.cache_control;
  } else if (p.tools?.length) { for (const t of p.tools) delete t.cache_control; p.tools[p.tools.length - 1].cache_control = long; }
  // clear everything pi placed, then place B/C/D
  for (const m of p.messages) if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
  const mark = (idx: number | undefined, ctl: CacheCtl) => {
    if (idx === undefined) return;
    const m = p.messages![idx];
    if (!m) return;
    if (typeof m.content === "string") m.content = [{ type: "text", text: m.content, cache_control: ctl } as { type: string; cache_control?: CacheCtl }];
    else if (m.content.length) m.content[m.content.length - 1].cache_control = ctl;
  };
  mark(bp.plan, long);
  // B is the only 1h block among the messages: a later short mark on the same index would replace its
  // cache_control and silently drop the plan snapshot's TTL to 5 minutes. That happens whenever the plan
  // snapshot IS the last message (a fresh session: system, plan, nothing else yet) or the last turn end.
  const keepLong = (idx: number | undefined): boolean => idx !== undefined && idx === bp.plan;
  if (!keepLong(bp.lastTurn)) mark(bp.lastTurn, short);
  // D (rolling): the LAST message of THIS payload, not the index frozen when the turn was assembled.
  // Inside a turn pi appends the assistant message and every tool result; a stale index leaves all of
  // them uncached on each following call of the same turn (the growing-context miss pattern in the
  // drafter traces). The tail is always at or after `bp.rolling`, so it never caches less.
  if (!keepLong(p.messages.length - 1)) mark(p.messages.length - 1, short);
  return p;
}

// ---------------------------------------------------------------------------
// Stream function with retry / backoff / stall detection
// ---------------------------------------------------------------------------

export interface StreamHooks {
  onRetry?: (attempt: number, cls: ErrorClass, waitMs: number) => void;
  onStatus?: (status: number, headers: Record<string, string>) => void;
  /** Per successful model call; `latencyMs` is wall time of the attempt that produced the message (0 on replay). */
  onUsage?: (u: UsageSample, model: string, latencyMs?: number) => void;
  onFirstToken?: () => void;
  breakpoints?: () => Breakpoints;
  stallMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Who is calling (lead / drafter / …); keys the L5 replay recording. Defaults to "lead". */
  role?: string;
  /**
   * Stable per-role, per-session prompt cache key for the OpenAI-compatible / Codex APIs (they have no
   * explicit breakpoints and route an implicit cache by this key). Must be deterministic for the whole
   * session — a value that changes between calls sends every call to a different cache shard.
   */
  cacheKey?: string;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

/** Runs one attempt; resolves with the final message; rejects on stall (so the caller retries). */
async function attemptOnce(model: Model<Api>, context: Context, options: SimpleStreamOptions, hooks: StreamHooks, out: AssistantMessageEventStream, signal: AbortSignal): Promise<AssistantMessage> {
  const stallMs = hooks.stallMs ?? STREAM_STALL_MS;
  const inner = streamSimple(model, context, { ...options, signal });
  const it = inner[Symbol.asyncIterator]();
  let first = true;
  const started = Date.now();
  const buffered: AssistantMessageEvent[] = [];
  // Tool-call argument bytes seen in this attempt: a model stuck repeating invented fields would otherwise
  // stream for minutes without ever tripping the stall detector.
  let toolArgBytes = 0;
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("STREAM_STALLED")), stallMs); });
    let step: IteratorResult<AssistantMessageEvent>;
    try { step = await Promise.race([it.next(), stall]); } finally { clearTimeout(timer); }
    if (Date.now() - started > REQUEST_TOTAL_TIMEOUT_MS) throw new Error("STREAM_STALLED");
    if (step.done) break;
    const ev = step.value;
    if (first && (ev.type === "text_delta" || ev.type === "toolcall_start" || ev.type === "thinking_delta")) { first = false; hooks.onFirstToken?.(); }
    if (ev.type === "done") { for (const b of buffered) out.push(b); out.push(ev); return ev.message; }
    if (ev.type === "error") { return ev.error; }
    if (ev.type === "toolcall_delta") {
      toolArgBytes += ((ev as { delta?: string }).delta ?? "").length;
      if (toolArgBytes > TOOL_ARGS_STREAM_MAX_BYTES) {
        try { await it.return?.(); } catch { /* the request is abandoned either way */ }
        return errorMessage(model, `PROVIDER_DEGENERATE_OUTPUT: tool call arguments exceeded ${TOOL_ARGS_STREAM_MAX_BYTES} bytes (repetition loop)`, "error");
      }
    }
    buffered.push(ev);
    // stream partial output live once we are past the retry window (first token seen)
    if (!first) { for (const b of buffered) out.push(b); buffered.length = 0; }
  }
  throw new Error("STREAM_ENDED_WITHOUT_DONE");
}

/** StreamFn contract: never throws; failures encoded as a final assistant message. */
export function makeStreamFn(hooks: StreamHooks): StreamFn {
  const sleep = hooks.sleep ?? defaultSleep;
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    let lastStatus: number | null = null;
    let retryAfter: number | null = null;
    const opts: SimpleStreamOptions = {
      ...options,
      // Secrets never enter the webview: Rust injects the real credentials in
      // `net_fetch`. pi-ai still insists on a non-empty key (and, for Codex,
      // parses an account id out of a JWT), so hand it an inert placeholder.
      apiKey: options?.apiKey || placeholderApiKey(model.provider),
      maxRetries: 0,
      cacheRetention: "long",
      // pi-ai maps `sessionId` to `prompt_cache_key` (openai-responses / openai-codex-responses /
      // openai-completions); Anthropic ignores it and uses the explicit breakpoints above.
      ...(hooks.cacheKey ? { sessionId: hooks.cacheKey } : {}),
      onResponse: (r) => { lastStatus = r.status; retryAfter = parseRetryAfter(r.headers["retry-after"]); hooks.onStatus?.(r.status, r.headers); },
      onPayload: (payload, m) => (m.api === "anthropic-messages" && hooks.breakpoints ? applyAnthropicBreakpoints(payload, hooks.breakpoints()) : payload),
    };
    (async () => {
      const outerSignal = options?.signal;
      // L5 replay seam: in replay mode the recorded assistant message is served without any network;
      // in record mode the final message of this call is appended to the active recording.
      const recorder = activeRecorder();
      const role = hooks.role ?? "lead";
      const ctxHash = recorder ? contextHash(context) : null;
      if (recorder?.mode === "replay" && ctxHash) {
        try {
          const entry = recorder.recording.nextModel(ctxHash, role);
          const msg: AssistantMessage = { ...entry.assistant, model: model.id };
          out.push({ type: "start", partial: { ...msg, content: [] } });
          if (msg.stopReason === "error" || msg.stopReason === "aborted") { out.push({ type: "error", reason: msg.stopReason, error: msg }); out.end(msg); return; }
          out.push({ type: "done", reason: msg.stopReason, message: msg });
          hooks.onUsage?.(usageSample(msg.usage), model.id, 0);
          out.end(msg);
        } catch (e) {
          const err = errorMessage(model, `REPLAY_MISMATCH: ${(e as Error).message}`, "error");
          out.push({ type: "error", reason: "error", error: err }); out.end(err);
        }
        return;
      }
      const record = (msg: AssistantMessage) => { if (recorder?.mode === "record" && ctxHash) recorder.recording.recordModel({ role, model: model.id, context_hash: ctxHash, assistant: msg }); };
      for (let attempt = 0; ; attempt++) {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        outerSignal?.addEventListener("abort", onAbort, { once: true });
        lastStatus = null;
        const attemptStarted = Date.now();
        try {
          const msg = await attemptOnce(model, context, opts, hooks, out, ctrl.signal);
          outerSignal?.removeEventListener("abort", onAbort);
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            const cls = outerSignal?.aborted ? "aborted" : classifyError(lastStatus, msg.errorMessage ?? "");
            const canRetry = (cls === "retryable" || cls === "rate_limit") && attempt < RETRY_MAX;
            if (canRetry) {
              const wait = cls === "rate_limit" && retryAfter !== null ? retryAfter : backoffMs(attempt);
              hooks.onRetry?.(attempt + 1, cls, wait);
              await sleep(wait, outerSignal);
              continue;
            }
            ctrl.abort(); // the attempt is over: a cut-off degenerate stream must not keep streaming (and billing) in the background
            const err: AssistantMessage = { ...msg, errorMessage: `${errorCode(cls)}: ${msg.errorMessage ?? ""}` };
            record(err);
            out.push({ type: "error", reason: msg.stopReason === "aborted" ? "aborted" : "error", error: err });
            out.end(err);
            return;
          }
          hooks.onUsage?.(usageSample(msg.usage), model.id, Date.now() - attemptStarted);
          record(msg);
          out.end(msg);
          return;
        } catch (e) {
          outerSignal?.removeEventListener("abort", onAbort);
          ctrl.abort();
          const stalled = (e as Error).message === "STREAM_STALLED";
          if (outerSignal?.aborted) {
            const err = errorMessage(model, "USER_STOPPED: aborted", "aborted");
            out.push({ type: "error", reason: "aborted", error: err }); out.end(err); return;
          }
          if ((stalled || classifyError(null, String(e)) === "retryable") && attempt < RETRY_MAX) {
            const wait = backoffMs(attempt);
            hooks.onRetry?.(attempt + 1, "retryable", wait);
            try { await sleep(wait, outerSignal); } catch { /* aborted during wait */ }
            continue;
          }
          const err = errorMessage(model, `${stalled ? "PROVIDER_STREAM_BROKEN" : "NET_TIMEOUT"}: ${String(e)}`, "error");
          out.push({ type: "error", reason: "error", error: err }); out.end(err); return;
        }
      }
    })();
    return out;
  };
}

function errorMessage(model: Model<Api>, message: string, stop: "error" | "aborted"): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: stop, errorMessage: message, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Tool scheduling
// ---------------------------------------------------------------------------

export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(public limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) { this.active++; return () => this.release(); }
    await new Promise<void>((res) => this.queue.push(res));
    this.active++;
    return () => this.release();
  }
  private release(): void { this.active--; const next = this.queue.shift(); if (next) next(); }
}

export interface ToolBinding {
  name: string;
  description: string;
  parameters: JsonSchema;
  parallel: boolean;
  execute: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string; images?: ImageContent[]; isError: boolean; details?: unknown }>;
}

/**
 * Providers only accept `^[a-zA-Z0-9_-]+$` tool names; our catalogue uses
 * `sch.summary` style. Encode at the wire (`.` → `__`), decode on the way back
 * so hooks, ledger and history always see the canonical names.
 */
export function encodeToolName(name: string): string {
  return name.replace(/\./g, "__");
}
export function decodeToolName(name: string): string {
  return name.replace(/__/g, ".");
}

export function bindTools(bindings: ToolBinding[], sem: Semaphore): AgentTool[] {
  return bindings.map((b) => ({
    name: encodeToolName(b.name),
    label: b.name,
    description: b.description,
    parameters: b.parameters as unknown as TSchema,
    executionMode: b.parallel ? "parallel" : "sequential",
    execute: async (id, params, signal): Promise<AgentToolResult<unknown>> => {
      const release = b.parallel ? await sem.acquire() : () => undefined;
      try {
        const r = await b.execute(id, (params ?? {}) as Record<string, unknown>, signal);
        if (r.isError) throw new ToolError(r.text, r.details);
        return { content: [{ type: "text", text: r.text }, ...(r.images ?? [])], details: r.details };
      } finally { release(); }
    },
  }));
}

export class ToolError extends Error {
  constructor(message: string, public details?: unknown) { super(message); }
}

// ---------------------------------------------------------------------------
// Loop runner
// ---------------------------------------------------------------------------

export interface LoopHooks {
  before?: (ctx: BeforeToolCallContext) => Promise<{ block: boolean; reason?: string } | undefined>;
  after?: (ctx: AfterToolCallContext) => Promise<{ content?: (TextContent | ImageContent)[]; isError?: boolean; terminate?: boolean } | undefined>;
  shouldStop?: () => boolean;
  steering?: () => Promise<AgentMessage[]>;
}

export interface LoopRun {
  system: string;
  tools: AgentTool[];
  history: Message[];
  prompt: Message[];
  model: Model<Api>;
  streamFn: StreamFn;
  reasoning?: ThinkingLevel;
  signal: AbortSignal;
  hooks: LoopHooks;
  onEvent: (e: AgentEvent) => void;
}

/** Runs pi-agent-core's loop over our context; returns the new messages. */
export async function runLoop(run: LoopRun): Promise<Message[]> {
  const context: AgentContext = { systemPrompt: run.system, messages: run.history, tools: run.tools };
  const config: AgentLoopConfig = {
    model: run.model,
    reasoning: run.reasoning,
    signal: run.signal,
    toolExecution: "parallel",
    convertToLlm: (msgs) => msgs.filter((m): m is Message => "role" in m && (m.role === "user" || m.role === "assistant" || m.role === "toolResult")),
    beforeToolCall: async (ctx) => run.hooks.before?.({ ...ctx, toolCall: { ...ctx.toolCall, name: decodeToolName(ctx.toolCall.name) } } as typeof ctx),
    afterToolCall: async (ctx) => run.hooks.after?.({ ...ctx, toolCall: { ...ctx.toolCall, name: decodeToolName(ctx.toolCall.name) } } as typeof ctx),
    shouldStopAfterTurn: async () => run.hooks.shouldStop?.() ?? false,
    getSteeringMessages: async () => (await run.hooks.steering?.()) ?? [],
  };
  const stream = agentLoop(run.prompt, context, config, run.signal, run.streamFn);
  for await (const ev of stream) run.onEvent(ev);
  const result = await stream.result();
  return result.filter((m): m is Message => "role" in m);
}

// ---------------------------------------------------------------------------
// Cache prewarm (caching-strategy.md): send the frozen prefix once with a
// minimal answer so the provider writes the cache before the first real call.
// ---------------------------------------------------------------------------

export interface PrewarmRequest {
  model: Model<Api>;
  system: string;
  tools: { name: string; description: string; parameters: unknown }[];
  /** Prefix messages (plan snapshot, mode marker, history) exactly as the next real call will send them. */
  history: Message[];
  breakpoints?: () => Breakpoints;
  /** Same `prompt_cache_key` the real calls of this role will use, so the prewarm writes the right shard. */
  cacheKey?: string;
  signal?: AbortSignal;
}

export const PREWARM_PROMPT = "Cache prewarm: reply with a single period.";

/**
 * Sends `tools + system + history + one tiny user message` with `maxTokens: 1`.
 * Returns the usage sample (cacheWrite > 0 on Anthropic when the write succeeded) or null on any failure;
 * never throws, never retries — a prewarm is best effort and costs at most the prefix once.
 */
export async function prewarmCache(req: PrewarmRequest): Promise<UsageSample | null> {
  try {
    const context: Context = {
      systemPrompt: req.system,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters as TSchema })),
      messages: [...req.history, { role: "user", content: [{ type: "text", text: PREWARM_PROMPT }], timestamp: FIXED_TS }],
    };
    const opts: SimpleStreamOptions = {
      apiKey: placeholderApiKey(req.model.provider),
      maxRetries: 0,
      maxTokens: 1,
      cacheRetention: "long",
      ...(req.cacheKey ? { sessionId: req.cacheKey } : {}),
      signal: req.signal,
      onPayload: (payload, m) => (m.api === "anthropic-messages" && req.breakpoints ? applyAnthropicBreakpoints(payload, req.breakpoints()) : payload),
    };
    const stream = streamSimple(req.model, context, opts);
    const msg = await stream.result();
    if (msg.stopReason === "error" || msg.stopReason === "aborted") return null;
    return usageSample(msg.usage);
  } catch {
    return null;
  }
}

/** Capability probe helpers (D-52): tool use + structured output + vision. */
export function modelSupportsImages(m: Model<Api>): boolean {
  return m.input.includes("image");
}

export type { AgentEvent, AgentMessage, Message, AssistantMessage, ImageContent, ThinkingLevel, Model, Api, AgentTool, StreamFn, BeforeToolCallContext, AfterToolCallContext, TextContent };
