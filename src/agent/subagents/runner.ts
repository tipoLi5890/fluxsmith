// SPDX-License-Identifier: Apache-2.0
// SubagentRunner: one pi loop per run with a frozen role prefix
// (agent-runtime.md §5, caching-strategy.md §4). Output is untrusted; the
// narrative field is capped and kept apart from executable fields.

import type { AgentEvent, AgentTool, Message, Model, Api, StreamFn, ThinkingLevel } from "../pi-adapter";
import { runLoop, toPiMessages, toolResultBlocks, type ToolBinding, bindTools, Semaphore } from "../pi-adapter";
import type { Role } from "../api";
import { SUBAGENT_OUTPUT_CAP } from "../limits";
import { ROLE_SYSTEM } from "../prompts/system";
import { renderToolTable, toolTable, type ToolDef } from "../tools/manifest";
import type { Mode } from "../../ipc/types";
import type { HMessage } from "../context/assembler";

export interface SubagentRun {
  role: Role;
  mode: Mode;
  model: Model<Api>;
  streamFn: StreamFn;
  /** English brief (tail of the prefix). */
  brief: string;
  /** Untrusted quotes appended after the brief. */
  untrusted?: string;
  extraTools?: string[];
  bind: (def: ToolDef) => ToolBinding;
  sem: Semaphore;
  signal: AbortSignal;
  reasoning?: ThinkingLevel;
  /** Internal: set on the single corrective retry after a validation failure. */
  retried?: boolean;
  /**
   * Internal: the exact pi messages of the first attempt (brief, assistant turns with their thinking
   * blocks, tool results), replayed verbatim as history so the retry continues the same conversation on
   * the same cache prefix. Rebuilding them from `HMessage` drops thinking blocks and re-serialises the
   * tool results, and the provider then sees a different prefix (caching-strategy.md, history is append-only).
   */
  prior?: Message[];
  retryNote?: string;
  onEvent?: (e: AgentEvent) => void;
  before?: (name: string, args: Record<string, unknown>, siblings: { name: string }[], id: string) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** Wait until the first Drafter of a batch has started streaming (cache rule). */
  waitForLeader?: Promise<void>;
  onFirstToken?: () => void;
  m3?: boolean;
  vision?: boolean;
}

export interface SubagentOutput<T> {
  ok: boolean;
  parsed: T | null;
  narrative: string;
  raw: string;
  error?: string;
  messages: HMessage[];
}

/** Extract the last JSON object from the assistant's final text. */
export function extractJson(text: string): unknown | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) last = m[1];
  const candidate = last ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(candidate); } catch { return null; }
}

export function roleTools(role: Role, mode: Mode, opts: { m3?: boolean; vision?: boolean }, whitelist?: string[]): ToolDef[] {
  const table = toolTable(mode, role, { m3: opts.m3, vision: opts.vision, webSearch: opts.m3 });
  return whitelist ? table.filter((t) => whitelist.includes(t.name)) : table;
}

export async function runSubagent<T>(run: SubagentRun, whitelist: string[] | undefined, validate: (v: unknown) => string[]): Promise<SubagentOutput<T>> {
  const defs = roleTools(run.role, run.mode, { m3: run.m3, vision: run.vision }, whitelist);
  const tools: AgentTool[] = bindTools(defs.map(run.bind), run.sem);
  const system = ROLE_SYSTEM[run.role] ?? ROLE_SYSTEM.explainer;
  const briefMsg: HMessage = { role: "user", content: [{ type: "text", text: run.untrusted ? `${run.brief}\n\n<untrusted>\n${run.untrusted}\n</untrusted>` : run.brief }], meta: { turn: 0, task: 0, kind: "user" } };
  // A corrective retry keeps the first attempt (brief, tool calls, results) as history and adds the rejection
  // as the next user message, so the subagent fixes its answer instead of re-exploring from scratch.
  // `run.prior` already starts with the brief: pi returns the prompt as the first of the new messages.
  const history: Message[] = run.prior ?? [];
  const prompt: Message[] = run.prior && run.retryNote ? toPiMessages([{ role: "user", content: [{ type: "text", text: run.retryNote }], meta: { turn: 0, task: 0, kind: "user" } }]) : toPiMessages([briefMsg]);
  if (run.waitForLeader) await run.waitForLeader;
  const out: HMessage[] = [];
  let finalText = "";
  let errorText: string | undefined;
  const events = (e: AgentEvent) => {
    run.onEvent?.(e);
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") run.onFirstToken?.();
    if (e.type === "message_end" && e.message.role === "assistant") {
      const m = e.message;
      const text = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
      if (text) finalText = text;
      if (m.stopReason === "error" || m.stopReason === "aborted") errorText = m.errorMessage ?? m.stopReason;
      out.push({ role: "assistant", content: [{ type: "text", text }], toolCalls: m.content.filter((c) => c.type === "toolCall").map((c) => ({ id: (c as { id: string }).id, name: (c as { name: string }).name, args: (c as { arguments: unknown }).arguments })), meta: { turn: 0, task: 0, kind: "tool" } });
    }
    // The transcript keeps exactly the blocks the provider was sent, never the wrapping AgentToolResult object.
    if (e.type === "tool_execution_end") out.push({ role: "toolResult", toolCallId: e.toolCallId, toolName: e.toolName, content: toolResultBlocks(e.result), isError: e.isError, meta: { turn: 0, task: 0, kind: "tool" } });
  };
  const before: NonNullable<Parameters<typeof runLoop>[0]["hooks"]["before"]> = async (ctx) => {
    const siblings = ctx.assistantMessage.content.filter((c) => c.type === "toolCall").map((c) => ({ name: (c as { name: string }).name }));
    return run.before?.(ctx.toolCall.name, (ctx.args ?? {}) as Record<string, unknown>, siblings, ctx.toolCall.id);
  };
  // The replay is byte-exact (pi's own messages, thinking blocks included), so the corrective round keeps
  // the first attempt's reasoning level and continues on the same cache prefix.
  const produced = await runLoop({ system, tools, history, prompt, model: run.model, streamFn: run.streamFn, reasoning: run.reasoning, signal: run.signal, hooks: { before }, onEvent: events });
  const wire: Message[] = [...history, ...produced];
  if (errorText) return { ok: false, parsed: null, narrative: "", raw: finalText, error: errorText, messages: out };
  if (finalText.length > SUBAGENT_OUTPUT_CAP) return { ok: false, parsed: null, narrative: "", raw: finalText.slice(0, 2000), error: "SUBAGENT_OUTPUT_TOO_LARGE", messages: out };
  const parsed = extractJson(finalText);
  const problems = parsed === null ? ["no JSON object in output"] : validate(parsed);
  const narrative = finalText.replace(/```[\s\S]*?```/g, "").trim().slice(0, 4000);
  if (problems.length) {
    // One corrective round: hand the exact problems back and ask for the JSON again.
    if (!run.retried) {
      const again = await runSubagent<T>({ ...run, retried: true, prior: wire, retryNote: `Your previous answer was rejected: ${problems.join("; ")}. Return the corrected JSON object in a \`\`\`json fence and nothing else.` }, whitelist, validate);
      return { ...again, messages: [...out, ...again.messages] };
    }
    return { ok: false, parsed: null, narrative, raw: finalText, error: problems.join("; "), messages: out };
  }
  return { ok: true, parsed: parsed as T, narrative, raw: finalText, messages: out };
}

export { renderToolTable };
