// SPDX-License-Identifier: Apache-2.0
// L5 replay (testing-strategy.md): record a turn through the streamFn + IPC seams, replay it with
// no provider, fail on a tampered context hash, and (under `pnpm replay`) re-drive every recording
// in tests/replay through the real harness.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall as piFauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";

vi.mock("../../ipc/client", async () => (await import("../replay/fake-ipc")).fakeIpcModule());

import { encodeToolName } from "../pi-adapter";
import * as adapter from "../pi-adapter";
import { fakeIpc } from "../replay/fake-ipc";
import { makeHarness } from "../replay/harness";
import { Recording, ReplayMismatch, contextHash, setActiveRecorder, startRecording, stopRecording, type ModelEntry } from "../replay/recorder";

const fauxToolCall: typeof piFauxToolCall = (name, args, o) => piFauxToolCall(encodeToolName(name), args, o);
const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, input: ["text"] }] });
const ROOT = process.cwd(); // vitest runs from the repo root (import.meta.url is /@fs-prefixed under jsdom)

function questionResponses() {
  return [
    fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "question", headline: "what is R1" }, { id: "t1" }), fauxToolCall("sch.component", { ref: "R1" }, { id: "t2" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("R1 is a resistor [[ref:component:R1]]"),
  ];
}

beforeEach(() => { fakeIpc.reset(); vi.spyOn(adapter, "buildModel").mockImplementation(() => faux.getModel()); });
afterEach(() => { setActiveRecorder(null); vi.restoreAllMocks(); });

async function recordQuestionTurn(): Promise<Recording> {
  const rec = startRecording({ session_id: "s", project: "pk", turns: [{ turn: 1, text: "what is R1?" }], source: "seam" });
  faux.setResponses(questionResponses());
  const h = makeHarness();
  await h.run("what is R1?");
  stopRecording();
  expect(h.events.some((e) => e.kind === "assistant_done" && e.text.includes("R1 is a resistor"))).toBe(true);
  return rec;
}

function loadRecording(path: string): Recording {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return Recording.fromJsonl(text);
}

describe("L5 replay: streamFn + IPC seams", () => {
  it("records every model call with a context hash and every IPC call with an args hash", async () => {
    const rec = await recordQuestionTurn();
    const models = rec.entries.filter((e): e is ModelEntry => e.kind === "model");
    expect(models.length).toBe(2);
    expect(models.every((m) => typeof m.context_hash === "string" && m.context_hash.length === 64)).toBe(true);
    expect(models.every((m) => m.role === "lead")).toBe(true);
    expect(models[0].assistant.content.some((c) => c.type === "toolCall")).toBe(true);
    const ipcs = rec.entries.filter((e) => e.kind === "ipc");
    expect(ipcs.length).toBeGreaterThan(3);
    expect(ipcs.some((e) => e.kind === "ipc" && e.name === "engine_request")).toBe(true);
    // The recording is what a recorded session looks like on disk: JSONL, secret-free.
    const text = rec.toJsonl();
    expect(text.split("\n").filter(Boolean).length).toBe(rec.entries.length);
    expect(text).not.toMatch(/rust-injected|sk-ant-|Authorization/);
    if (process.env.FLUXSMITH_REPLAY_WRITE_SAMPLE) writeFileSync(join(ROOT, "tests/replay/sample-question-turn.jsonl"), text);
  });

  it("replays the turn without touching the provider and consumes every recorded model call", async () => {
    const rec = await recordQuestionTurn();
    const replay = Recording.fromJsonl(rec.toJsonl());
    setActiveRecorder({ mode: "replay", recording: replay });
    fakeIpc.reset();
    faux.setResponses([]);
    const before = faux.state.callCount;
    const h = makeHarness();
    await h.run("what is R1?");
    expect(faux.state.callCount).toBe(before);
    expect(h.events.some((e) => e.kind === "assistant_done" && e.text.includes("R1 is a resistor"))).toBe(true);
    expect(h.events.filter((e) => e.kind === "error")).toEqual([]);
    expect(replay.remainingModels()).toBe(0);
    // Hooks and ledger ran for real: the read tool reached the (fake) engine again.
    expect(fakeIpc.calls.some((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "component")).toBe(true);
  });

  it("a tampered context hash fails the replay with REPLAY_MISMATCH and produces no answer", async () => {
    const rec = await recordQuestionTurn();
    const replay = Recording.fromJsonl(rec.toJsonl());
    const first = replay.entries.find((e): e is ModelEntry => e.kind === "model")!;
    first.context_hash = "0".repeat(64);
    setActiveRecorder({ mode: "replay", recording: replay });
    fakeIpc.reset();
    faux.setResponses([]);
    const h = makeHarness();
    await h.run("what is R1?");
    const err = h.events.find((e) => e.kind === "error");
    expect(err && err.kind === "error" && err.error.code).toBe("REPLAY_MISMATCH");
    expect(h.events.some((e) => e.kind === "assistant_done" && e.text.includes("R1 is a resistor"))).toBe(false);
    expect(() => new Recording(replay.entries).nextModel("x".repeat(64), "lead")).toThrow(ReplayMismatch);
  });

  it("history recordings (null hashes) replay by role order", async () => {
    const rec = await recordQuestionTurn();
    const replay = Recording.fromJsonl(rec.toJsonl());
    for (const e of replay.entries) if (e.kind === "model") e.context_hash = null;
    replay.setMeta({ ...replay.meta()!, source: "history" });
    const lenient = Recording.fromJsonl(replay.toJsonl());
    expect(lenient.strict).toBe(false);
    setActiveRecorder({ mode: "replay", recording: lenient });
    fakeIpc.reset();
    faux.setResponses([]);
    const h = makeHarness();
    await h.run("what is R1? (reworded, so the prefix differs)");
    expect(h.events.some((e) => e.kind === "assistant_done" && e.text.includes("R1 is a resistor"))).toBe(true);
    expect(h.events.filter((e) => e.kind === "error")).toEqual([]);
  });

  it("context hash ignores timestamps and usage but not content or tools", () => {
    const base = { systemPrompt: "s", tools: [{ name: "a", description: "d", parameters: {} }], messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 1 }] };
    const sameLater = { ...base, messages: [{ ...base.messages[0], timestamp: 999 }] };
    expect(contextHash(base)).toBe(contextHash(sameLater));
    expect(contextHash({ ...base, systemPrompt: "s2" })).not.toBe(contextHash(base));
    expect(contextHash({ ...base, tools: [{ name: "a", description: "d2", parameters: {} }] })).not.toBe(contextHash(base));
    expect(contextHash({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "bye" }], timestamp: 1 }] })).not.toBe(contextHash(base));
  });

  it("gzip JSONL round-trips", async () => {
    const rec = await recordQuestionTurn();
    const gz = gzipSync(Buffer.from(rec.toJsonl(), "utf8"));
    expect(gz.length).toBeLessThan(rec.toJsonl().length);
    const back = Recording.fromJsonl(gunzipSync(gz).toString("utf8"));
    expect(back.entries).toEqual(rec.entries);
  });
});

// `pnpm replay` — every recording listed in FLUXSMITH_REPLAY_FILES is driven through the harness.
const FILES = (process.env.FLUXSMITH_REPLAY_FILES ?? "").split(",").map((s) => s.trim()).filter(Boolean).filter((f) => existsSync(f));
describe.skipIf(FILES.length === 0)("L5 replay: recorded sessions (pnpm replay)", () => {
  for (const file of FILES) {
    it(`replays ${file.split("/").pop()} without mismatches or harness errors`, async () => {
      const rec = loadRecording(file);
      const meta = rec.meta();
      expect(meta, "recording needs a meta entry").toBeTruthy();
      setActiveRecorder({ mode: "replay", recording: rec });
      fakeIpc.reset();
      faux.setResponses([]);
      const h = makeHarness();
      for (const t of meta!.turns) await h.run(t.text);
      const errors = h.events.filter((e) => e.kind === "error").map((e) => (e.kind === "error" ? e.error.code : ""));
      expect(errors.filter((c) => c === "REPLAY_MISMATCH" || c === "LOOP_FAILED")).toEqual([]);
      expect(h.events.some((e) => e.kind === "turn_ended")).toBe(true);
      if (rec.strict) expect(rec.remainingModels()).toBe(0);
    }, 120_000);
  }
});
