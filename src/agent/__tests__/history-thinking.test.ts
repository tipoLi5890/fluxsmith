// SPDX-License-Identifier: Apache-2.0
// The Lead's history round-trips a reasoning model's assistant message without loss: produced pi message ->
// HMessage (`fromAssistant`) -> DB row (JSON) -> `coerceStoredMessage` -> `toPiMessages` is the produced
// message on the wire, thinking blocks, signatures, redacted payloads, OpenAI item ids and block order
// included (caching-strategy.md: the next call must extend the previous array byte for byte). Rows written
// before thinking was kept (fixture captured from the 2026-09-05 format) still load and replay as they did.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { HISTORY_ORIGIN, PI_TYPE_PINS, fromAssistant, toPiMessages, wireForm } from "../pi-adapter";
import { Persistence, coerceStoredMessage } from "../persistence";
import type { HMessage } from "../context/assembler";

const rows: { kind: string; content?: unknown }[] = [];
let listed: unknown[] = [];
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name !== "db_query") return null;
    const q = args.query as { kind: string; content?: unknown };
    rows.push(q);
    return q.kind === "message_list" ? listed : null;
  }),
  netFetch: vi.fn(),
  onAppEvent: vi.fn(async () => () => undefined),
  IpcFailure: class extends Error { constructor(public error: { code: string; message: string; req_id: string }) { super(error.message); } },
}));

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"], origin = { api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5" }): AssistantMessage =>
  ({ role: "assistant", content, ...origin, usage, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", timestamp: 1_700_000_000_000 } as AssistantMessage);

/** The message a provider produced, in the shapes the three provider families use. */
const produced: Record<string, AssistantMessage> = {
  // Anthropic extended thinking: signed thinking, then text, then the tool call.
  anthropic: assistant([
    { type: "thinking", thinking: "Check R1 first.", thinkingSignature: "EqQBCkYIBRgCIkD" },
    { type: "text", text: "Looking at R1." },
    { type: "toolCall", id: "toolu_01", name: "sch__component", arguments: { ref: "R1" } },
  ]),
  // Anthropic redacted thinking: no text, the encrypted payload rides in the signature.
  redacted: assistant([
    { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "EroBCkYIBRgCKkB", redacted: true },
    { type: "text", text: "R1 is a resistor." },
  ]),
  // OpenAI Responses / Codex: the reasoning item (with id and encrypted content) JSON-encoded in the
  // signature, empty summary text, the message id on the text block, `call_id|item_id` on the call.
  codex: assistant([
    { type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_abc", summary: [], encrypted_content: "gAAAAB" }) },
    { type: "text", text: "Reading the sheet.", textSignature: JSON.stringify({ v: 1, id: "msg_xyz", phase: "commentary" }) },
    { type: "toolCall", id: "call_1|fc_1", name: "sch__read", arguments: { sheet: "root.kicad_sch" } },
  ], { api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.3-codex" }),
  // Interleaved: reasoning between two calls in one message, and a Google-style thought signature on a call.
  interleaved: assistant([
    { type: "thinking", thinking: "first", thinkingSignature: "s1" },
    { type: "toolCall", id: "a", name: "sch__read", arguments: {}, thoughtSignature: "ts-a" },
    { type: "thinking", thinking: "second", thinkingSignature: "s2" },
    { type: "toolCall", id: "b", name: "sch__component", arguments: { ref: "R2" } },
    { type: "text", text: "both" },
  ]),
};

/** What the DB hands back: the row content after a JSON round trip through SQLite (`content TEXT`). */
const stored = (m: HMessage): unknown => JSON.parse(JSON.stringify(m));

describe("thinking blocks survive the history", () => {
  it("pins the harness block types to pi's wire types", () => {
    expect(PI_TYPE_PINS).toEqual({ thinking: true, text: true, toolCallSignature: true });
  });

  it.each(Object.keys(produced))("%s: produced -> HMessage -> stored row -> pi message is the produced message on the wire", (key) => {
    const m = produced[key];
    const h = fromAssistant(m, 4, 2);
    expect(h.role).toBe("assistant");
    expect(h.role === "assistant" && h.origin).toEqual({ api: m.api, provider: m.provider, model: m.model });
    // In memory (the turn in progress) and after the DB round trip (a restored session): both are the produced message.
    expect(wireForm(toPiMessages([h]))).toEqual(wireForm([m]));
    const loaded = coerceStoredMessage(stored(h));
    expect(loaded).not.toBeNull();
    expect(wireForm(toPiMessages([loaded!]))).toEqual(wireForm([m]));
    // Block order is the produced order (interleaved calls go back where they were), not text-then-calls.
    expect(toPiMessages([loaded!])[0].content).toEqual(m.content);
  });

  it("wireForm sees every field the provider gets back: a changed signature or provenance is a different message", () => {
    const h = fromAssistant(produced.anthropic, 1, 1);
    const base = wireForm(toPiMessages([h]))[0];
    const sig = { ...h, content: h.content.map((c) => (c.type === "thinking" ? { ...c, thinkingSignature: "other" } : c)) } as HMessage;
    expect(wireForm(toPiMessages([sig]))[0]).not.toBe(base);
    const origin = { ...h, origin: { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5" } } as HMessage;
    expect(wireForm(toPiMessages([origin]))[0]).not.toBe(base);
    const redacted = fromAssistant(produced.redacted, 1, 1);
    expect(wireForm(toPiMessages([redacted]))[0]).toContain('"redacted":true');
  });

  it("a thinking-only message (no answer, no call) is not replayed", () => {
    const h = fromAssistant(assistant([{ type: "thinking", thinking: "cut off", thinkingSignature: "s" }]), 1, 1);
    expect(toPiMessages([h])).toEqual([]);
  });
});

describe("stored rows: migration and tolerance", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/history-rows-2026-09-05.json"), "utf8")) as { id: number; turn: number; role: string; content: unknown; compacted_by: null }[];

  it("rows captured before thinking blocks existed load and replay exactly as before", async () => {
    listed = fixture;
    const history = await new Persistence("pk", "s-old").loadHistory();
    expect(history.length).toBe(fixture.length);
    expect(history.map((m) => m.role)).toEqual(fixture.map((r) => r.role));
    // No provenance was stored: the neutral stamp every replayed message used to carry, text then calls.
    const pi = toPiMessages(history);
    for (const m of pi) if (m.role === "assistant") {
      expect([m.api, m.provider, m.model]).toEqual([HISTORY_ORIGIN.api, HISTORY_ORIGIN.provider, HISTORY_ORIGIN.model]);
      expect(m.content.some((c) => c.type === "thinking")).toBe(false);
    }
    // The old format is replayed byte for byte as the old adapter did (row 4: one tool call, no text).
    const c2 = pi.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall" && c.id === "c2"));
    expect(c2 && wireForm([c2])[0]).toBe(JSON.stringify({ role: "assistant", api: "anthropic-messages", provider: "fluxsmith", model: "history", content: [{ type: "toolCall", id: "c2", name: "sch__component", arguments: { ref: "R1" } }] }));
    expect(pi.filter((m) => m.role === "toolResult").length).toBe(fixture.filter((r) => r.role === "toolResult").length);
  });

  it("skips rows Rust could not parse or that are not messages, drops unknown blocks, defaults missing meta", async () => {
    listed = [
      { id: 1, content: null, compacted_by: null },
      { id: 2, content: { role: "system", content: [{ type: "text", text: "x" }], meta: { turn: 1, task: 1, kind: "user" } }, compacted_by: null },
      { id: 3, content: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "audio", data: "..." }], toolCalls: [{ id: "c", name: "sch.read", args: {} }, { name: "broken" }], meta: { turn: 2 } }, compacted_by: null },
      { id: 4, content: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "r" }], meta: { turn: 2, task: 2, kind: "tool" } }, compacted_by: null },
      { id: 5, content: { role: "user", content: "not an array", meta: { turn: 3, task: 3, kind: "user" } }, compacted_by: "7" },
      { id: 6, content: { role: "toolResult", content: [], meta: { turn: 3, task: 3, kind: "tool" } }, compacted_by: null },
    ];
    const history = await new Persistence("pk", "s-mixed").loadHistory();
    expect(history.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    const a = history[0];
    expect(a.role === "assistant" && a.toolCalls).toEqual([{ id: "c", name: "sch.read", args: {} }]);
    expect(a.content).toEqual([{ type: "text", text: "ok" }]);
    expect(a.meta).toEqual({ turn: 2, task: 0, kind: "prose" });
    expect(history[1].role === "toolResult" && history[1].toolName).toBe("");
    expect(coerceStoredMessage("string")).toBeNull();
    expect(coerceStoredMessage({ role: "user", content: [] })).toBeNull(); // no meta at all: not one of ours
  });

  it("a new-format row survives the same reader with every optional field intact", () => {
    const h = fromAssistant(produced.codex, 9, 3);
    const back = coerceStoredMessage(stored(h));
    expect(back).toEqual(h);
    expect(back && back.role === "assistant" && back.toolCalls[0].at).toBe(2);
  });

  it("appendMessage stores the HMessage as is (the Rust side keeps the JSON opaque)", async () => {
    rows.length = 0;
    const h = fromAssistant(produced.anthropic, 2, 1);
    await new Persistence("pk", "s-new").appendMessage(h);
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe(h);
  });
});
