// SPDX-License-Identifier: Apache-2.0
// Prompt-cache invariants (caching-strategy.md, CLAUDE.md "Prompt cache"): tools + system are
// byte-deterministic for every (mode, role), carry no volatile tokens, and the Build-entry
// prewarm sends exactly the frozen prefix with a one-token answer.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall as piFauxToolCall, registerFauxProvider, type Context, type ThinkingContent } from "@mariozechner/pi-ai";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assemble, lintPrefix } from "../context/assembler";
import { renderToolTable, toolTable } from "../tools/manifest";
import { LEAD_CORE_RULES, OP_TEMPLATES, OP_VOCABULARY, ROLE_SYSTEM } from "../prompts/system";
import { DEFAULT_CONVENTIONS } from "../lead";
import { SkillRegistry } from "../skills/registry";
import { PREWARM_PROMPT, prewarmCache, encodeToolName, makeStreamFn, toPiMessages, wireForm, Semaphore } from "../pi-adapter";
import { findVolatile, lintRepo } from "../../../scripts/cache-lint.mjs";
import type { Mode } from "../../ipc/types";
import type { Role } from "../api";

// The engine / Rust side is mocked: this file measures what reaches the provider, not what the engine answers.
const ipcCalls: { name: string; args: unknown }[] = [];
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (name: string, args: Record<string, unknown>) => {
    ipcCalls.push({ name, args });
    switch (name) {
      case "settings_get": return cacheSettings;
      case "skills_list": return [];
      case "sidecar_read": return null;
      case "sidecar_write": return null;
      case "db_query": return (args.query as { kind: string }).kind === "message_list" ? [] : null;
      case "turn_begin": return { turn: 1, effective_envelope: (args.begin as { envelope?: unknown }).envelope ?? { sheets: ["root.kicad_sch"], allowed_ops: [], components_added_max: 8, components_deleted_max: 0, wires_max: null, structural: [], nets_renamable: [], rails: [], interfaces: [], instance_designators: {}, source: "session_ceiling" }, ceiling_source: "session_ceiling", checkpoint_pending: true };
      case "checkpoint_create": return { project_key: "pk", turn: 1, manifest_sha256: "m", bytes: 1, created: "", kind: "turn", pruned: false, verified: true };
      case "kicad_advisory": return null;
      case "engine_request": {
        const req = (args as { request: { kind: string } }).request;
        const ok = (data: unknown) => ({ ok: true, data, meta: { bytes: 0, truncated: false, elapsed_ms: 1, trust: "untrusted" } });
        if (req.kind === "summary") return ok({ counts: { symbols: 1 }, refdes: { R: { used: [[1, 1]], next: 2 } }, rails: ["GND"], sheets: [{ path: "/", file: "root.kicad_sch" }] });
        if (req.kind === "component") return ok({ ref: "R1", units: [{ file: "root.kicad_sch" }] });
        if (req.kind === "bbox") return ok({ bbox_mil: [[0, 0], [100, 100]] });
        return ok({});
      }
      default: return null;
    }
  }),
  netFetch: vi.fn(),
  onAppEvent: vi.fn(async () => () => undefined),
  IpcFailure: class extends Error { constructor(public error: { code: string; message: string; req_id: string }) { super(error.message); } },
}));

const ROOT = process.cwd(); // vitest runs from the repo root (import.meta.url is /@fs-prefixed under jsdom)
const MODES: Mode[] = ["plan", "build", "review"];
const ROLES: Role[] = ["lead", "architect", "librarian", "drafter", "fixer", "reviewer", "sourcer", "facts"];

/** The real builtin skill packs, read from `skills/` the way the app's reader would. */
async function realL0(): Promise<string> {
  const dir = join(ROOT, "skills");
  const packs = readdirSync(dir).filter((d) => existsSync(join(dir, d, "SKILL.md")));
  const reg = new SkillRegistry({
    list: async () => packs.map((p) => ({ pack: p, layer: "builtin" as const, path: join(dir, p), sha256: "0".repeat(64), trusted: true, origin_agent: false, skills: [{ name: p, path: "SKILL.md", front_matter: null, sections: [], l0_chars: 0 }], workflows: [], lint: [] })),
    read: async (pack, path) => readFileSync(join(dir, pack, path), "utf8"),
  });
  await reg.load(null);
  return reg.l0();
}

describe("cache prefix determinism", () => {
  it("renderToolTable is byte-identical across two renders for every (mode, role)", () => {
    for (const mode of MODES) for (const role of ROLES) {
      for (const opts of [{}, { vision: true, webSearch: true }]) {
        const a = JSON.stringify(renderToolTable(toolTable(mode, role, opts)));
        const b = JSON.stringify(renderToolTable(toolTable(mode, role, opts)));
        expect(a, `${mode}/${role}`).toBe(b);
      }
    }
  });

  it("two full assemblies with the real skills L0 are byte-identical and lint clean", async () => {
    const l0 = await realL0();
    expect(l0.startsWith("<skills_index")).toBe(true);
    const input = () => ({ toolTable: toolTable("build", "lead"), coreRules: LEAD_CORE_RULES, skillsL0: l0, planSnapshot: null, mode: "build" as const, policy: "auto" as const, history: [], systemMarkers: false });
    const a = assemble(input());
    const b = assemble(input());
    expect(a.system).toBe(b.system);
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.prefixSha).toBe(b.prefixSha);
    expect(lintPrefix(a.system, a.tools)).toEqual([]);
    expect(findVolatile(a.system)).toEqual([]);
    expect(findVolatile(a.tools.map((t) => t.description).join("\n"))).toEqual([]);
  });

  it("no system prompt (lead or subagent role) or tool description carries a volatile token", () => {
    for (const [role, text] of Object.entries(ROLE_SYSTEM)) expect(findVolatile(text), role).toEqual([]);
    for (const mode of MODES) for (const role of ROLES) {
      const tools = renderToolTable(toolTable(mode, role, { vision: true, webSearch: true }));
      expect(lintPrefix("", tools), `${mode}/${role}`).toEqual([]);
      expect(findVolatile(tools.map((t) => t.description).join("\n")), `${mode}/${role}`).toEqual([]);
    }
  });

  it("mode, policy, plan and summary never enter system or tools", () => {
    const a = assemble({ toolTable: toolTable("build", "lead"), coreRules: LEAD_CORE_RULES, skillsL0: "", planSnapshot: { id: "plan-x", version: 3, text: "PLAN BODY" }, mode: "build", policy: "auto", history: [], systemMarkers: false });
    const b = assemble({ toolTable: toolTable("build", "lead"), coreRules: LEAD_CORE_RULES, skillsL0: "", planSnapshot: null, mode: "review", policy: "ask", history: [], systemMarkers: false });
    expect(a.prefixSha).toBe(b.prefixSha);
    expect(a.system).not.toMatch(/plan-x|PLAN BODY|<<mode/);
    expect(JSON.stringify(a.tools)).not.toMatch(/plan-x|PLAN BODY/);
  });

  it("scripts/cache-lint.mjs (pnpm lint:cache) is clean on the repo sources", () => {
    expect(lintRepo(ROOT)).toEqual([]);
  });

  it("findVolatile catches the forbidden tokens", () => {
    expect(findVolatile("built 2026-08-30T12:00:00Z").map((h) => h.rule)).toEqual(["iso-timestamp"]);
    expect(findVolatile("id 123e4567-e89b-12d3-a456-426614174000").map((h) => h.rule)).toEqual(["uuid"]);
    expect(findVolatile("open /Users/someone/x.kicad_sch").map((h) => h.rule)).toEqual(["absolute-path"]);
    expect(findVolatile("const t = Date.now();").map((h) => h.rule)).toEqual(["date-now"]);
    expect(findVolatile("plain text with no volatile parts")).toEqual([]);
  });
});

describe("Build-entry cache prewarm", () => {
  const faux = registerFauxProvider({ provider: "faux-prewarm", models: [{ id: "faux-p", contextWindow: 200_000, input: ["text"] }] });
  it("sends the frozen prefix plus one tiny user message with maxTokens 1 and returns the usage", async () => {
    let seen: Context | null = null;
    let seenMax: number | undefined;
    faux.setResponses([(ctx, opts) => { seen = ctx; seenMax = opts?.maxTokens; return fauxAssistantMessage("."); }]);
    const tools = renderToolTable(toolTable("build", "lead"));
    const req = assemble({ toolTable: toolTable("build", "lead"), coreRules: LEAD_CORE_RULES, skillsL0: "", planSnapshot: { id: "p", version: 1, text: "{}" }, mode: "build", policy: "review", history: [], systemMarkers: false });
    const history = toPiMessages(req.messages);
    const before = faux.state.callCount;
    const usage = await prewarmCache({ model: faux.getModel(), system: req.system, tools, history });
    expect(faux.state.callCount).toBe(before + 1);
    expect(usage).not.toBeNull();
    expect(seenMax).toBe(1);
    const ctx = seen as Context | null;
    expect(ctx?.systemPrompt).toBe(req.system);
    expect((ctx?.tools ?? []).map((t) => t.name)).toEqual(tools.map((t) => t.name));
    expect(ctx?.messages.length).toBe(history.length + 1);
    const last = ctx?.messages[ctx.messages.length - 1];
    const lastBlock = last?.role === "user" && Array.isArray(last.content) ? last.content[0] : null;
    expect(lastBlock && lastBlock.type === "text" ? lastBlock.text : null).toBe(PREWARM_PROMPT);
    // the prewarm's prefix is exactly what the next real call sends (same messages before the prompt)
    expect(ctx?.messages.slice(0, -1).map((m) => (m.role === "user" ? m.content : null))).toEqual(history.map((m) => m.content));
  });

  it("never throws: a failing provider yields null", async () => {
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
    const usage = await prewarmCache({ model: faux.getModel(), system: "s", tools: [], history: [] });
    expect(usage).toBeNull();
  });
});

describe("prompt consistency", () => {
  it("subagents are never told to frame blocks (the Lead / harness does) and conventions cover the golden failure modes", () => {
    expect(ROLE_SYSTEM.drafter).not.toMatch(/Frame a block/);
    expect(ROLE_SYSTEM.fixer).not.toMatch(/Frame a block/);
    expect(LEAD_CORE_RULES).toMatch(/Frame a block/);
    const ids = DEFAULT_CONVENTIONS(["GND"]).map((c) => c.id);
    for (const id of ["decoupling", "grid", "rails-are-not-signals", "net-name-format", "passive-symbols", "footprints", "macros-are-complete"]) expect(ids).toContain(id);
    // The Lead self-drafts small tasks: it must see the same conventions the Drafter gets in its brief.
    for (const needle of ["C_Polarized", "within 300 mil", "regulator or converter are rails", "do not call ops.list"]) expect(LEAD_CORE_RULES).toContain(needle);
    expect(LEAD_CORE_RULES.match(/turn\.begin/g)?.length ?? 0).toBeLessThanOrEqual(4);
  });
  // The `sheet` field means two different things in opspec v1 (a file, or a sheet symbol name on the three
  // sheet-symbol ops). The rule is taught once, verbatim; changing these bytes invalidates the cache prefix.
  it("states the two meanings of `sheet` once, byte for byte", () => {
    const sentence = 'On add_sheet_pin, delete_sheet_pin and resize_sheet "sheet" is the hierarchical sheet symbol\'s name (its Sheetname property, as sch.summary and sch.read show it) and "in_sheet" names the file that symbol is drawn on; on every other op "sheet" is optional and names the target file, so omit it to draw on the step\'s own sheet.';
    expect(OP_VOCABULARY).toContain(sentence);
    expect(LEAD_CORE_RULES.split(sentence).length - 1).toBe(1);
  });

  // F9: three real runs raised a question card after the user wrote "make reasonable assumptions and do
  // not ask me questions". Buried mid-sentence as an exception the rule was read as an afterthought, so
  // the negative now leads, as its own sentence, before the sentence that orders the card. Deliberate
  // cache-prefix change (the whole Lead prefix is re-cached once).
  it("the pre-plan question rule leads with the case where the user said not to ask", () => {
    const noAsk = "When the user's message says to assume, to make reasonable assumptions, or not to ask, raise no ask_user card in that turn: record every open choice as a plan assumption instead.";
    expect(LEAD_CORE_RULES).toContain(noAsk);
    // The order matters: the exception is stated before the rule it overrides, not appended to it.
    expect(LEAD_CORE_RULES.indexOf(noAsk)).toBeLessThan(LEAD_CORE_RULES.indexOf("Otherwise, before plan.write, ask once"));
    expect(findVolatile(OP_TEMPLATES)).toEqual([]);
  });

  // The Architect kept putting connectors on a child sheet, inventing rail names and quoting a fixed
  // component value with no operating point; all three are constants in its role prefix now.
  it("the architect prefix states the sheet-split, rail-name and operating-point rules", () => {
    for (const s of [
      "Connectors, indicators and anything the user did not name for a child sheet stay on the root sheet",
      "Rail names come from stock KiCad power symbols when one fits (VBUS for USB input power, +5V, +3V3, GND)",
      "state the operating point it implies (current, dissipation, dropout) as an assumption",
    ]) expect(ROLE_SYSTEM.architect).toContain(s);
    expect(findVolatile(ROLE_SYSTEM.architect)).toEqual([]);
  });

  // F11: `ops.template` was called 100 times over four runs to fetch this static JSON, one uncached round
  // trip each. The shapes now ride in the drafter / fixer prefix, which is paid for once per role session.
  it("drafter and fixer carry the op field shapes in their frozen prefix", () => {
    for (const role of ["drafter", "fixer"]) {
      expect(ROLE_SYSTEM[role], role).toContain(OP_TEMPLATES);
      expect(ROLE_SYSTEM[role], role).toContain("Call ops.template only for a field you cannot infer from this list.");
    }
    for (const op of ["place_component", "add_net_label", "place_decoupling", "arrange_group"]) expect(OP_TEMPLATES).toContain(op);
  });
});

// ---------------------------------------------------------------------------
// The prefix must survive the calls of a turn (F5). What the provider is sent on call n+1 has to start
// with exactly what it was sent on call n — the same messages, byte for byte, in the same order. A
// re-serialised tool result or a replay that drops blocks makes call n+1 a fresh prefix and the cache
// read drops to whatever the two arrays still share.
// ---------------------------------------------------------------------------

const cacheSettings = {
  schema_version: 2, language: "en", theme: "system", restore_tabs_on_launch: true, notifications: true, shortcuts: {},
  kicad: { app_path: null, cli_path: null, symbol_dir_override: null, target_version: 10 },
  providers: [{ id: "fauxc", kind: "custom", label: "fauxc", base_url: "http://localhost:9/v1", enabled: true, rates: [1, 1, 0.1, 5], context_window: 200_000, build_capable: "full", vision: false, cache_reporting: true, raw_base64_images: false, models: ["faux-c"], probed_at: null, has_secret: true }],
  models_by_role: { lead: "fauxc/faux-c", drafter: "fauxc/faux-c", fixer: "fauxc/faux-c" }, rates_as_of: null,
  agent: { default_policy: "review", continuous_run: false, session_ceiling_components_added: 24, budget_defaults: { plan_tokens: null, plan_usd: 5, plan_tool_calls: 400, plan_wall_min: 60, turn_tool_calls: 200, turn_wall_min: 15, warn_pct: 80 }, canvas_follow: true, canvas_grid: false, canvas_changes: true, chat_attach_selection: false, intake_defaults: {}, chat_density: "compact" },
  context: { hint_pct: 60, auto_pct: 80, emergency_pct: 92, keep_recent_tasks: 2, reserve_output_tokens: 8000 },
  storage: { checkpoint_turns: 50, checkpoint_mb: 500, external_cache_mb: 2048, datasheets_copy_to_project_default: false },
  privacy: { log_level: "info" },
  advanced: { step_throttle: false, images_size: "standard", tool_parallel_max: 4, drafter_concurrency: 1, provider_conn_max: 6, sandbox_enabled: true, router_path: null },
};

/** Every call's wire form, in call order, and the wire form of the assistant message each call produced. */
const sent: string[][] = [];
const produced: string[] = [];
const cacheFaux = registerFauxProvider({ provider: "faux-cache", models: [{ id: "faux-c", contextWindow: 200_000, input: ["text"] }] });
// The provider stamps the message it finalises with the model that produced it (pi does the same for every
// real provider); that stamp is part of what the next call must replay, so `produced` carries it.
const record = (answer: ReturnType<typeof fauxAssistantMessage>) => (ctx: Context) => {
  const model = cacheFaux.getModel();
  sent.push(wireForm(ctx.messages));
  produced.push(wireForm([{ ...answer, api: model.api, provider: model.provider, model: model.id }])[0]);
  return answer;
};
const fauxToolCall: typeof piFauxToolCall = (name, args, o) => piFauxToolCall(encodeToolName(name), args, o);
/** A reasoning block as a provider streams it: text plus the opaque signature the provider must get back verbatim. */
const think = (thinking: string, thinkingSignature: string): ThinkingContent => ({ type: "thinking", thinking, thinkingSignature });

/**
 * The assertion this whole section exists for: array n is an exact element-wise prefix of array n+1, and
 * the element right after that prefix is the assistant message call n produced, thinking block, signature
 * and provenance included (`produced[n]`). `wireForm` serialises each message the way the adapter hands it
 * to the provider (role, provenance, content blocks with every signature, tool call ids / names /
 * arguments), so an equal element is a byte-equal message. An error message is never appended to the
 * history, so `errors` names the calls whose answer must not be looked for in the next array.
 */
function expectPrefixChain(chain: string[][], answers: string[] | null = null, errors: number[] = []): void {
  expect(chain.length).toBeGreaterThan(1);
  for (let n = 0; n + 1 < chain.length; n++) {
    const before = chain[n];
    const after = chain[n + 1];
    expect(after.length, `call ${n + 1} sent fewer messages than call ${n}`).toBeGreaterThanOrEqual(before.length);
    expect(after.slice(0, before.length), `call ${n + 1} is not a byte-prefix of call ${n}`).toEqual(before);
    if (answers && !errors.includes(n)) expect(after[before.length], `call ${n + 1} does not continue with the message call ${n} produced`).toBe(answers[n]);
  }
}

async function newLead(sessionId: string) {
  const { LeadLoop } = await import("../lead");
  const { SkillRegistry: Reg } = await import("../skills/registry");
  const { Persistence } = await import("../persistence");
  const adapter = await import("../pi-adapter");
  vi.spyOn(adapter, "buildModel").mockImplementation(() => cacheFaux.getModel());
  const lead = new LeadLoop({
    settings: () => cacheSettings as never, projectKey: "pk", sessionId, emit: () => undefined,
    skills: new Reg({ list: async () => [], read: async () => "" }), persistence: new Persistence("pk", sessionId),
    plans: { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) },
    showCard: async () => ({ action_id: "dismiss" }), selection: () => [], sheets: () => ["root.kicad_sch"],
  });
  const run = async (text: string, responses: ReturnType<typeof fauxAssistantMessage>[]) => {
    cacheFaux.setResponses(responses.map(record));
    lead.enqueue({ message: { text, refs: [], attachments: [], session_id: sessionId }, task: null, steer: false });
    for (let i = 0; i < 400 && (lead.running || (lead as unknown as { queue: unknown[] }).queue.length); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { lead, run };
}

describe("cache prefix survives the calls of a turn", () => {
  beforeEach(() => { sent.length = 0; produced.length = 0; ipcCalls.length = 0; });

  it("lead: every call of a multi-call turn (and the next turn) extends the previous array by the produced message, thinking included", async () => {
    const { lead, run } = await newLead("s-cache");
    // Turn 1: three calls (thinking + tool call -> result -> thinking + tool call -> result -> thinking + prose),
    // the shape a reasoning model (Anthropic extended thinking, Codex) produces.
    await run("what is R1?", [
      fauxAssistantMessage([think("the user asks about R1", "sig-c1"), fauxToolCall("turn.begin", { kind: "question", headline: "what is R1" }, { id: "c1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([think("look the component up", "sig-c2"), fauxToolCall("sch.component", { ref: "R1" }, { id: "c2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([think("answer briefly", "sig-c3"), { type: "text", text: "R1 is a resistor" }]),
    ]);
    expect(sent.length).toBe(3);
    expectPrefixChain(sent, produced);
    // Turn 2 continues the same history: its first call must still extend the last call of turn 1 by the
    // prose message turn 1 produced, and every thinking block of turn 1 must still be on the wire verbatim.
    const afterTurn1 = sent.length;
    await run("and R2?", [
      fauxAssistantMessage([think("R2 now", "sig-c4"), fauxToolCall("turn.begin", { kind: "question", headline: "what is R2" }, { id: "c3" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("R2 is a resistor too"),
    ]);
    expect(sent.length).toBeGreaterThan(afterTurn1);
    expectPrefixChain(sent, produced);
    const turn2First = sent[afterTurn1];
    for (const sig of ["sig-c1", "sig-c2", "sig-c3"]) expect(turn2First.some((m) => m.includes(`"thinkingSignature":"${sig}"`)), sig).toBe(true);
    // The persisted copy is what gets replayed after a restart: it carries the same blocks.
    const stored = lead.history.filter((m) => m.role === "assistant" && m.meta.turn === 1);
    expect(stored.map((m) => m.content.filter((c) => c.type === "thinking").length)).toEqual([1, 1, 1]);
    expect(stored.every((m) => m.role === "assistant" && m.origin?.model === "faux-c" && m.origin.provider === "faux-cache")).toBe(true);
  });

  it("lead: a provider that rejects replayed thinking gets it dropped once, at that boundary, and the drop is recorded", async () => {
    const { lead, run } = await newLead("s-reject");
    await run("what is R1?", [
      fauxAssistantMessage([think("about R1", "sig-r1"), fauxToolCall("turn.begin", { kind: "question", headline: "what is R1" }, { id: "r1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([think("done", "sig-r2"), { type: "text", text: "R1 is a resistor" }]),
    ]);
    const afterTurn1 = sent.length;
    expect(afterTurn1).toBe(2);
    // Turn 2: the first call is refused because of the replayed signatures; the resend must carry no
    // thinking from turn 1, and the turn then completes normally on the rebuilt prefix.
    await run("and R2?", [
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "PROVIDER_BAD_REQUEST: Invalid signature in thinking block" }),
      fauxAssistantMessage([think("R2", "sig-r3"), fauxToolCall("turn.begin", { kind: "question", headline: "what is R2" }, { id: "r3" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("R2 is a resistor too"),
    ]);
    expect(sent.length).toBe(afterTurn1 + 3);
    const rejected = sent[afterTurn1];
    const resent = sent[afterTurn1 + 1];
    // Up to the rejected call the chain is intact (it replayed the thinking verbatim).
    expectPrefixChain(sent.slice(0, afterTurn1 + 1), produced.slice(0, afterTurn1 + 1));
    expect(rejected.some((m) => m.includes('"thinkingSignature":"sig-r1"'))).toBe(true);
    // The resend is the same array without the turn-1 thinking blocks and nothing else changed.
    expect(resent.length).toBe(rejected.length);
    expect(resent.some((m) => m.includes('"type":"thinking"'))).toBe(false);
    expect(resent.map((m) => m.replace(/\{"type":"thinking"[^}]*\},?/g, ""))).toEqual(rejected.map((m) => m.replace(/\{"type":"thinking"[^}]*\},?/g, "")));
    // From the resend on the chain holds again, the new turn's own thinking included.
    expectPrefixChain(sent.slice(afterTurn1 + 1), produced.slice(afterTurn1 + 1));
    expect(sent[afterTurn1 + 2].some((m) => m.includes('"thinkingSignature":"sig-r3"'))).toBe(true);
    // Recorded like a forced mid-turn compaction; the DB rows keep the original blocks.
    const metrics = ipcCalls.filter((c) => c.name === "db_query" && (c.args as { query: { kind: string; kind_?: string } }).query.kind === "metric_append").map((c) => (c.args as { query: { kind_: string } }).query.kind_);
    expect(metrics).toContain("thinking_dropped_on_reject");
    expect(lead.history.filter((m) => m.role === "assistant" && m.meta.turn === 1).every((m) => m.meta.thinking_dropped === true)).toBe(true);
    const appended = ipcCalls.filter((c) => c.name === "db_query" && (c.args as { query: { kind: string } }).query.kind === "message_append").map((c) => (c.args as { query: { content: { role: string; content: { type: string }[] } } }).query.content);
    expect(appended.filter((m) => m.role === "assistant" && m.content.some((b) => b.type === "thinking")).length).toBe(3);
  });

  it("subagent: the corrective retry replays the first attempt verbatim", async () => {
    const { runSubagent } = await import("../subagents/runner");
    const bind = (def: { name: string; description: string; parameters: unknown }) => ({
      name: def.name, description: def.description, parameters: def.parameters as never, parallel: false,
      execute: async () => ({ text: JSON.stringify({ bbox_mil: [[0, 0], [100, 100]] }), isError: false }),
    });
    const good = { groups: { g: { origin_mil: [0, 0] } }, ops: [{ op: "place_component", lib_id: "Device:R", designator: "R9", group: "g", x_mil: 0, y_mil: 0 }], refdes_used: ["R9"] };
    cacheFaux.setResponses([
      record(fauxAssistantMessage([fauxToolCall("sch.bbox", { region_mil: [[0, 0], [100, 100]] }, { id: "s1" })], { stopReason: "toolUse" })),
      record(fauxAssistantMessage("```json\n{\"nope\":1}\n```")),
      record(fauxAssistantMessage("```json\n" + JSON.stringify(good) + "\n```")),
    ]);
    const out = await runSubagent<typeof good>({
      role: "drafter", mode: "build", model: cacheFaux.getModel(), streamFn: makeStreamFn({ role: "drafter", cacheKey: "fluxsmith.s-cache.drafter" }),
      brief: "draft the block", bind, sem: new Semaphore(1), signal: new AbortController().signal,
    }, ["sch.bbox"], (v) => (Array.isArray((v as { ops?: unknown }).ops) ? [] : ["ops[] required"]));
    expect(out.ok).toBe(true);
    expect(sent.length).toBe(3);
    expectPrefixChain(sent);
  });
});
