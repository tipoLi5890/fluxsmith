// SPDX-License-Identifier: Apache-2.0
// L5 replay (testing-strategy.md): a Recording holds the model calls and IPC
// calls of a session so a turn can be re-driven through the real harness
// (hooks, ledger, cards) without a provider. Two seams feed it:
//   (a) `pi-adapter.makeStreamFn` — one entry per model call, keyed by the
//       sha256 of (system, tools, messages) the loop was about to send;
//   (b) the IPC `call(name, args) → result` boundary (fake IPC in tests, the
//       `setIpcTap` in `ipc/client.ts` when recording inside the app).
// Browser-safe: no Node APIs here (gzip lives in scripts/ and tests).

import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import { canonicalJson, sha256Hex } from "../util";

export interface MetaEntry {
  kind: "meta";
  version: 1;
  session_id: string | null;
  project: string | null;
  /** User messages that drove the recorded turns, in order. */
  turns: { turn: number; text: string }[];
  /** `strict` when every model entry carries a context hash (seam recording); `history` when rebuilt from DB rows. */
  source: "seam" | "history";
}

export interface ModelEntry {
  kind: "model";
  call_index: number;
  role: string;
  model: string;
  /** sha256 over (system, tools, messages); null for history-derived recordings (matched by role order only). */
  context_hash: string | null;
  assistant: AssistantMessage;
}

export interface IpcEntry {
  kind: "ipc";
  call_index: number;
  name: string;
  args_hash: string;
  result: unknown;
  error: { code: string; message: string; req_id: string } | null;
}

/** Informational only (history recordings): the tool result the model saw. Replay ignores it. */
export interface ToolResultEntry {
  kind: "tool_result";
  turn: number;
  toolCallId: string;
  toolName: string;
  text: string;
}

export type ReplayEntry = MetaEntry | ModelEntry | IpcEntry | ToolResultEntry;

export class ReplayMismatch extends Error {
  constructor(message: string, public readonly expected: string | null, public readonly actual: string | null) { super(message); }
}

function normaliseMessage(m: Message): unknown {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") {
    return {
      role: "assistant",
      content: m.content.map((c) => {
        if (c.type === "toolCall") return { type: "toolCall", id: c.id, name: c.name, arguments: c.arguments };
        if (c.type === "text") return { type: "text", text: c.text };
        if (c.type === "thinking") return { type: "thinking", thinking: c.thinking };
        return c;
      }),
    };
  }
  return { role: "toolResult", toolCallId: m.toolCallId, toolName: m.toolName, content: m.content, isError: m.isError };
}

/** Deterministic hash of what a model call is about to send: timestamps, usage and provider labels are excluded. */
export function contextHash(ctx: { systemPrompt?: string; tools?: { name: string; description: string; parameters: unknown }[]; messages: Message[] }): string {
  const tools = (ctx.tools ?? []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return sha256Hex(canonicalJson({ system: ctx.systemPrompt ?? "", tools, messages: ctx.messages.map(normaliseMessage) }));
}

export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args ?? null));
}

export class Recording {
  readonly entries: ReplayEntry[] = [];
  private cursors = new Map<string, number>();
  private ipcCursor = 0;
  private callIndex = 0;
  /** Mismatches are fatal in strict mode; lenient mode (history recordings) matches by role order. */
  strict: boolean;

  constructor(entries: ReplayEntry[] = [], strict?: boolean) {
    this.entries.push(...entries);
    const meta = this.meta();
    this.strict = strict ?? (meta ? meta.source === "seam" : true);
    this.callIndex = this.entries.filter((e) => e.kind === "model" || e.kind === "ipc").length;
  }

  meta(): MetaEntry | null {
    const m = this.entries.find((e): e is MetaEntry => e.kind === "meta");
    return m ?? null;
  }

  setMeta(m: Omit<MetaEntry, "kind" | "version">): void {
    const idx = this.entries.findIndex((e) => e.kind === "meta");
    const entry: MetaEntry = { kind: "meta", version: 1, ...m };
    if (idx >= 0) this.entries[idx] = entry; else this.entries.unshift(entry);
  }

  // ----- record -----------------------------------------------------------

  recordModel(e: Omit<ModelEntry, "kind" | "call_index">): ModelEntry {
    const entry: ModelEntry = { kind: "model", call_index: this.callIndex++, ...e };
    this.entries.push(entry);
    return entry;
  }

  recordIpc(e: Omit<IpcEntry, "kind" | "call_index">): IpcEntry {
    const entry: IpcEntry = { kind: "ipc", call_index: this.callIndex++, ...e };
    this.entries.push(entry);
    return entry;
  }

  // ----- replay -----------------------------------------------------------

  /** Next recorded model call for `role`; throws ReplayMismatch when the context hash differs (strict) or nothing is left. */
  nextModel(hash: string, role: string): ModelEntry {
    const models = this.entries.filter((e): e is ModelEntry => e.kind === "model" && e.role === role);
    const at = this.cursors.get(role) ?? 0;
    const entry = models[at];
    if (!entry) throw new ReplayMismatch(`no recorded model call left for role ${role} (call ${at})`, null, hash);
    if (entry.context_hash !== null && entry.context_hash !== hash) {
      if (this.strict) throw new ReplayMismatch(`context hash differs at ${role} call ${at}: recorded ${entry.context_hash.slice(0, 12)}, actual ${hash.slice(0, 12)}`, entry.context_hash, hash);
    }
    this.cursors.set(role, at + 1);
    return entry;
  }

  /**
   * Next recorded IPC result whose name and args hash match; `undefined` when none is left
   * (the caller falls back to its default fake). IPC matching is always lenient: harness-side
   * bookkeeping calls carry timestamps in their args, and the model seam is the strict one.
   */
  nextIpc(name: string, hash: string): IpcEntry | undefined {
    const ipcs = this.entries.filter((e): e is IpcEntry => e.kind === "ipc");
    for (let k = this.ipcCursor; k < ipcs.length; k++) {
      const e = ipcs[k];
      if (e.name !== name || e.args_hash !== hash) continue;
      this.ipcCursor = k + 1;
      return e;
    }
    return undefined;
  }

  remainingModels(): number {
    let n = 0;
    const byRole = new Map<string, number>();
    for (const e of this.entries) if (e.kind === "model") byRole.set(e.role, (byRole.get(e.role) ?? 0) + 1);
    for (const [role, total] of byRole) n += total - (this.cursors.get(role) ?? 0);
    return n;
  }

  // ----- serialisation ----------------------------------------------------

  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  static fromJsonl(text: string, strict?: boolean): Recording {
    const entries: ReplayEntry[] = [];
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      entries.push(JSON.parse(s) as ReplayEntry);
    }
    return new Recording(entries, strict);
  }
}

// ---------------------------------------------------------------------------
// Active recorder (process-wide switch consumed by pi-adapter and the IPC tap)
// ---------------------------------------------------------------------------

export type RecorderMode = "record" | "replay";

export interface ActiveRecorder {
  mode: RecorderMode;
  recording: Recording;
}

let active: ActiveRecorder | null = null;

/** Install (or clear with null) the recorder both seams consult. */
export function setActiveRecorder(r: ActiveRecorder | null): void { active = r; }
export function activeRecorder(): ActiveRecorder | null { return active; }

/** Convenience: start a fresh in-memory recording; `stopRecording` returns it. */
export function startRecording(meta?: Omit<MetaEntry, "kind" | "version">): Recording {
  const rec = new Recording([], true);
  rec.setMeta(meta ?? { session_id: null, project: null, turns: [], source: "seam" });
  active = { mode: "record", recording: rec };
  return rec;
}

export function stopRecording(): Recording | null {
  const r = active?.mode === "record" ? active.recording : null;
  active = null;
  return r;
}
