// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall as piFauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import { encodeToolName } from "../pi-adapter";

// Real providers echo the wire (encoded) tool name; mirror that here.
const fauxToolCall: typeof piFauxToolCall = (name, args, o) => piFauxToolCall(encodeToolName(name), args, o);

// ---- fake IPC -----------------------------------------------------------
const calls: { name: string; args: unknown }[] = [];
/** `applyRefusals`: engine refusals (`ok` + applied:false) served to the next step applies, in order. */
/** `summarySheets`: what `sch.summary` reports as `sheets` (a `{path,file}` row per sheet instance).
 *  `findings`: what `gate.run` reports. */
/** `kicad`: what the Rust `kicad_advisory` command returns (null = the default "no report"). */
/** `netPins` / `netLabels`: what `net_map` reports for a sheet (`REF.PIN` -> net, label uuid -> net). */
/** `applyErrors`: engine errors (`ok: false`) served to the next step applies, in order. */
/** `styleFindings`: what `check.style` reports (the stylist pass reads it every round). */
/** `symbols` / `netList`: what `sch.read` and `sch.nets` report (the acceptance evaluation reads
 *  power symbols off the symbol list and the `flagged` bit off the net list). */
/** `applyWarnings`: what the engine reports in `per_op[].warnings` for the next apply. */
const state = { applied: 0, checkpoints: 0, turn: 0, applyWarnings: [] as string[], applyRefusals: [] as string[], applyErrors: [] as { code: string; message: string; remediation?: string }[], summarySheets: 1 as unknown, findings: [] as unknown[], styleFindings: [] as unknown[], kicad: null as unknown, netPins: {} as Record<string, string>, netLabels: {} as Record<string, string>, symbols: [] as unknown[], netList: [] as unknown[] };
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    switch (name) {
      case "settings_get": return settings;
      case "project_info": return { key: "pk", root: "/p", root_sheet: "root.kicad_sch", root_uuid: "u", name: "p", version: 20260306, sheets: [{ file: "root.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }], config: {}, git: null, last_turn: 0, last_mode: "plan", policy_override: null, locked: false };
      case "skills_list": return [];
      case "sidecar_read": return null;
      case "sidecar_write": return null;
      case "db_query": return (args.query as { kind: string }).kind === "message_list" ? [] : null;
      case "turn_begin": { state.turn += 1; const b = args.begin as { envelope: unknown; kind: string }; return { turn: state.turn, effective_envelope: b.envelope ?? { sheets: ["root.kicad_sch"], allowed_ops: [], components_added_max: 24, components_deleted_max: 0, wires_max: null, structural: [], nets_renamable: [], rails: [], interfaces: [], instance_designators: {}, source: "session_ceiling" }, ceiling_source: "session_ceiling", checkpoint_pending: true }; }
      case "checkpoint_create": state.checkpoints += 1; return { project_key: "pk", turn: state.turn, manifest_sha256: "m", bytes: 1, created: "", kind: "turn", pruned: false, verified: true };
      case "build_session_open": return { token: "bs-1", project_key: "pk", plan_ref: "incremental", policy: "review", ceiling: {}, opened_at: "", idle_timeout_min: 15, absolute_timeout_h: 8 };
      case "build_session_close": return null;
      case "grant_create": return { id: "grant-1", kind: (args.request as { kind: string }).kind, expires_at: "" };
      case "kicad_advisory": return state.kicad;
      case "engine_request": {
        const req = (args as { request: { kind: string; oplist?: unknown; note?: string; sheet?: string; family?: string; target?: string } }).request;
        const auth = (args as { auth: { build_session?: string | null; grant?: string | null } }).auth;
        const ok = (data: unknown) => ({ ok: true, data, meta: { bytes: 0, truncated: false, elapsed_ms: 1, trust: "untrusted" } });
        switch (req.kind) {
          case "summary": return ok({ counts: { symbols: 2 }, refdes: { R: { used: [[1, 2]], next: 3 } }, rails: ["GND"], sheets: state.summarySheets });
          case "resolve": return ok({ resolved: [] });
          case "ops_validate": return ok({ ok: true, errors: [] });
          case "plan": return ok({ applied: false, integrity: [], net_diff: { changes: [] }, nets_after: [] });
          case "apply": {
            if (!auth.build_session) return { ok: false, data: null, error: { code: "BUILD_SESSION_REQUIRED", message: "no session", req_id: "" }, meta: { bytes: 0, truncated: false, elapsed_ms: 1, trust: "untrusted" } };
            // A rejected call (envelope, lock, ledger) is `ok: false` with a structured error.
            const failure = /^step /.test(String(req.note ?? "")) ? state.applyErrors.shift() : undefined;
            if (failure) return { ok: false, data: null, error: { req_id: "", ...failure }, meta: { bytes: 0, truncated: false, elapsed_ms: 1, trust: "untrusted" } };
            // A refused write is `ok` with applied:false and the engine's refusal line (sch-write lib.rs).
            const refusal = /^step /.test(String(req.note ?? "")) ? state.applyRefusals.shift() : undefined;
            if (refusal) return ok({ applied: false, refusal, run_id: "refused", counts: { added: 0, deleted: 0, wires: 0 }, net_diff: { changes: [] }, targets: [] });
            state.applied += 1;
            // Mirrors sch-write: a power port counts in `components_added` and is named in `per_op[].created`.
            const ops = ((req.oplist as { ops?: { op?: string }[] } | undefined)?.ops ?? []);
            const placed = ops.filter((o) => /^place_/.test(String(o.op)));
            const per_op: { created: { uuid: string; kind: string }[]; warnings?: string[] }[] = placed.map((o, i) => ({ created: /^place_(pwr_flag|power_port|gnd|vcc)$/.test(String(o.op)) ? [{ uuid: `pp-${i}`, kind: "power_port" }] : [{ uuid: `sym-${i}`, kind: "symbol" }] }));
            // The engine writes what it did differently from the op-list on the op that did it.
            if (state.applyWarnings.length) per_op.push({ created: [], warnings: state.applyWarnings.splice(0) });
            // The engine reports the files it actually wrote: the apply's own target (`applyFiles`).
            return ok({ applied: true, run_id: `run-${state.applied}`, counts: { added: placed.length || 1, deleted: 0, wires: 0 }, per_op, net_diff: { changes: [] }, targets: [{ path: String(req.target ?? "root.kicad_sch"), sha_before: "sha-before", sha_after: `sha-after-${state.applied}`, created: false }] });
          }
          case "check": return ok({ ok: true, families: [], findings: req.family === "style" ? state.styleFindings : [] });
          case "gate_run": return ok({ ok: true, families: [], findings: state.findings });
          // `net_map` is where the acceptance evaluation reads pin membership from (`REF.PIN` -> net).
          case "net_map": return ok({ sheet: req.sheet ?? "/", wires: {}, labels: state.netLabels, pins: state.netPins });
          // `sch.read` (per sheet or `all_sheets`) is the only list of symbols, power ones included;
          // `sch.nets` is where the per-net `flagged` bit ("a PWR_FLAG sits on it") comes from.
          case "read": return ok({ symbols: state.symbols, labels: [], wires: [] });
          case "nets": return ok({ nets: state.netList });
          case "component": return ok({ ref: "R1", units: [{ file: "root.kicad_sch" }] });
          default: return ok({});
        }
      }
      default: return null;
    }
  }),
  netFetch: vi.fn(),
  onAppEvent: vi.fn(async () => () => undefined),
  IpcFailure: class extends Error { constructor(public error: { code: string; message: string; req_id: string }) { super(error.message); } },
}));

const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, input: ["text"] }] });

const settings = {
  schema_version: 2, language: "en", theme: "system", restore_tabs_on_launch: true, notifications: true, shortcuts: {},
  kicad: { app_path: null, cli_path: null, symbol_dir_override: null, target_version: 10 },
  providers: [{ id: "faux", kind: "custom", label: "faux", base_url: "http://localhost:9/v1", enabled: true, rates: [1, 1, 0.1, 5], context_window: 200_000, build_capable: "full", vision: false, cache_reporting: true, raw_base64_images: false, models: ["faux-1"], probed_at: null, has_secret: true }],
  models_by_role: { lead: "faux/faux-1", drafter: "faux/faux-1", fixer: "faux/faux-1" }, rates_as_of: null,
  agent: { default_policy: "review", continuous_run: true, session_ceiling_components_added: 24, budget_defaults: { plan_tokens: null, plan_usd: 5, plan_tool_calls: 400, plan_wall_min: 60, turn_tool_calls: 200, turn_wall_min: 15, warn_pct: 80 }, canvas_follow: true, canvas_grid: false, canvas_changes: true, chat_attach_selection: true, intake_defaults: {}, chat_density: "compact" },
  context: { hint_pct: 60, auto_pct: 80, emergency_pct: 92, keep_recent_tasks: 2, reserve_output_tokens: 8000 },
  storage: { checkpoint_turns: 50, checkpoint_mb: 500, external_cache_mb: 2048, datasheets_copy_to_project_default: false },
  privacy: { log_level: "info" },
  advanced: { step_throttle: false, images_size: "standard", tool_parallel_max: 4, drafter_concurrency: 3, provider_conn_max: 6, sandbox_enabled: true, router_path: null },
};

import { LeadLoop } from "../lead";
import { SkillRegistry } from "../skills/registry";
import { Persistence } from "../persistence";
import * as adapter from "../pi-adapter";
import type { TurnEvent, Card } from "../api";
import type { DesignPlan } from "../plans/schema";
import { newTurnPolicyState } from "../policy/types";
import { p7 } from "../policy/hooks";

function makeLead(events: TurnEvent[], answer: (c: Card) => { action_id: string; grant?: string } = () => ({ action_id: "modify" }), sheets: string[] = ["root.kicad_sch"]) {
  const skills = new SkillRegistry({ list: async () => [], read: async () => "" });
  const lead = new LeadLoop({
    settings: () => settings as never, projectKey: "pk", sessionId: "s", emit: (e) => events.push(e), skills, persistence: new Persistence("pk", "s"),
    plans: { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) },
    showCard: async (c) => answer(c), selection: () => [], sheets: () => sheets,
  });
  // route the faux provider through pi's registry: buildModel gives api openai-completions; override to faux
  vi.spyOn(adapter, "buildModel").mockImplementation(() => faux.getModel());
  return lead;
}

async function runUntilIdle(lead: LeadLoop, text: string): Promise<void> {
  lead.enqueue({ message: { text, refs: [], attachments: [], session_id: "s" }, task: null, steer: false });
  for (let i = 0; i < 400 && (lead.running || (lead as unknown as { queue: unknown[] }).queue.length); i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => { calls.length = 0; state.applied = 0; state.checkpoints = 0; state.turn = 0; state.applyWarnings.length = 0; state.applyRefusals.length = 0; state.applyErrors.length = 0; state.summarySheets = 1; state.findings.length = 0; state.styleFindings.length = 0; state.kicad = null; state.netPins = {}; state.netLabels = {}; state.symbols = []; state.netList = []; });

describe("LeadLoop", () => {
  it("question turn: turn.begin first, read-only answer, summary card with do-this", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "question", headline: "what is R1" }, { id: "t1" }), fauxToolCall("sch.component", { ref: "R1" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("R1 is a resistor [[ref:component:R1]]"),
    ]);
    await runUntilIdle(lead, "what is R1?");
    const started = events.find((e) => e.kind === "turn_started");
    expect(started && started.kind === "turn_started" && started.turn_kind).toBe("question");
    expect(events.some((e) => e.kind === "assistant_done" && e.text.includes("R1 is a resistor"))).toBe(true);
    const summary = events.find((e) => e.kind === "card" && e.card.kind === "system" && e.card.title === "card.turn_summary");
    expect(summary && summary.kind === "card" && summary.card.actions.some((a) => a.id === "do_it")).toBe(true);
    expect(calls.some((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "component")).toBe(true);
    expect(lead.turns[0].status).toBe("summarized");
  });

  it("D call in a question turn is denied by P0b and never reaches the engine", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "question", headline: "q" }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist: { groups: { g: {} }, ops: [], refdes_used: [] }, target: "root.kicad_sch", note: "n" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    await runUntilIdle(lead, "just asking");
    expect(state.applied).toBe(0);
    const denied = lead.history.find((m) => m.role === "toolResult" && m.toolCallId === "t2");
    expect(denied && denied.role === "toolResult" && denied.content[0].type === "text" && denied.content[0].text).toMatch(/P0b/);
  });

  it("instruction turn in Build: checkpoint before first apply, apply recorded, gate run, summary", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    const oplist = { groups: { g: { origin_mil: [0, 0] } }, ops: [{ op: "place_component", reference: "R3", group: "g", x_mil: 0, y_mil: 0, lib_id: "Device:R" }], refdes_used: ["R3"] };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "add R3", envelope: { sheets: ["root.kicad_sch"], allowed_ops: ["place_component"], components_added_max: 2, components_deleted_max: 0, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.plan", { oplist, target: "root.kicad_sch" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist, target: "root.kicad_sch", note: "add R3" }, { id: "t3" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await runUntilIdle(lead, "add a resistor R3");
    expect(state.checkpoints).toBe(1);
    expect(state.applied).toBe(1);
    const cpIdx = calls.findIndex((c) => c.name === "checkpoint_create");
    const applyIdx = calls.findIndex((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "apply");
    expect(cpIdx).toBeGreaterThan(-1);
    expect(cpIdx).toBeLessThan(applyIdx);
    expect(events.some((e) => e.kind === "applied")).toBe(true);
    expect(calls.some((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "gate_run")).toBe(true);
    expect(lead.turns[0].applies.length).toBe(1);
    const ledgerWrites = calls.filter((c) => c.name === "sidecar_write" && (c.args as { write: { kind: string } }).write.kind === "ledger").map((c) => (c.args as { write: { phase: string; payload: Record<string, unknown> } }).write);
    expect(ledgerWrites.map((w) => w.phase)).toEqual(["intended", "applied", "done"]);
    // crash-recovery.md §3: intended is write-ahead (before the engine call) and carries the target paths;
    // applied carries the engine's per-target sha_before/sha_after.
    const intendedIdx = calls.findIndex((c) => c.name === "sidecar_write" && (c.args as { write: { phase?: string } }).write.phase === "intended");
    expect(intendedIdx).toBeLessThan(applyIdx);
    expect(ledgerWrites[0].payload.targets).toEqual([{ path: "root.kicad_sch", sha_before: null }]);
    expect(typeof ledgerWrites[0].payload.ops_sha256).toBe("string");
    expect(ledgerWrites[1].payload.targets).toEqual([{ path: "root.kicad_sch", sha_before: "sha-before", sha_after: "sha-after-1", created: false }]);
    expect(ledgerWrites[1].payload.run_id).toBe("run-1");
  });

  // P0-2: `per_op[].warnings` used to end inside a tool result nobody reads. A route drawn across a
  // foreign pin joins those pins to the net, so it has to reach the human: one compact stream line,
  // the full list on the turn summary, and a suggested-bucket row for the connection warnings.
  it("promotes engine apply warnings to the stream, the turn summary and the findings panel", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    state.applyWarnings = [
      "ROUTE_THROUGH_PIN: no leg order and no jog was clear, so the wire from (1200,900) to (1600,900) mil is drawn as authored and runs across U1.7; those pins join this net",
      "PLACEMENT_SNAPPED: R3 moved from (13,17) to (0,0) mil onto the 50 mil grid",
      "WIRE_ON_NO_CONNECT: this wire touches the no-connect marker at (2000,1000) mil; a pin marked unused that a wire reaches is an ERC error, so delete the marker (delete_object) or route around it",
    ];
    const oplist = { groups: { g: { origin_mil: [0, 0] } }, ops: [{ op: "place_component", reference: "R3", group: "g", x_mil: 0, y_mil: 0, lib_id: "Device:R" }], refdes_used: ["R3"] };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "add R3", envelope: { sheets: ["root.kicad_sch"], allowed_ops: ["place_component"], components_added_max: 2, components_deleted_max: 0, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist, target: "root.kicad_sch", note: "add R3" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await runUntilIdle(lead, "add a resistor R3");
    expect(state.applied).toBe(1);
    // One line per apply, keyed (four languages) and naming the codes with their counts.
    const line = events.find((e) => e.kind === "system" && e.text_key === "system.apply_warnings");
    expect(line && line.kind === "system" && line.severity).toBe("warning");
    expect(line && line.kind === "system" && line.params?.n).toBe(3);
    expect(String(line && line.kind === "system" ? line.params?.codes : "")).toContain("ROUTE_THROUGH_PIN \u00d71");
    expect(String(line && line.kind === "system" ? line.params?.codes : "")).toContain("PLACEMENT_SNAPPED \u00d71");
    // The raw list rides on the turn summary so the expanded turn can list code and message.
    const ended = events.find((e) => e.kind === "turn_ended");
    const warnings = ended && ended.kind === "turn_ended" ? ended.summary.applied.warnings ?? [] : [];
    expect(warnings.map((w) => w.code)).toEqual(["ROUTE_THROUGH_PIN", "PLACEMENT_SNAPPED", "WIRE_ON_NO_CONNECT"]);
    expect(warnings[0].message).toContain("those pins join this net");
    expect(warnings[0].sheet).toBe("root.kicad_sch");
    // Only the two that mean "this may have connected something" become findings rows, as
    // suggestions (`origin: "advisory"`), with the anchor the engine wrote into the sentence.
    const rows = events.filter((e) => e.kind === "findings").flatMap((e) => (e.kind === "findings" ? e.findings : [])) as { code: string; origin?: string; at_mil?: [number, number]; severity: string }[];
    const promoted = rows.filter((r) => r.code === "ROUTE_THROUGH_PIN" || r.code === "WIRE_ON_NO_CONNECT");
    expect(promoted.map((r) => r.code).sort()).toEqual(["ROUTE_THROUGH_PIN", "WIRE_ON_NO_CONNECT"]);
    expect(promoted.every((r) => r.origin === "advisory" && r.severity === "Warning")).toBe(true);
    expect(promoted.find((r) => r.code === "ROUTE_THROUGH_PIN")?.at_mil).toEqual([1200, 900]);
    expect(promoted.find((r) => r.code === "WIRE_ON_NO_CONNECT")?.at_mil).toEqual([2000, 1000]);
    expect(rows.some((r) => r.code === "PLACEMENT_SNAPPED")).toBe(false);
  });

  // --- KiCad is the oracle: the post-turn gate asks kicad-cli, the harness never grades itself ----
  /** A Build turn that draws `oplist` and ends (the same shape as the instruction-turn test). */
  async function buildTurn(lead: LeadLoop, oplist: unknown, add = 2): Promise<void> {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "draw", envelope: { sheets: ["root.kicad_sch"], allowed_ops: ["place_component", "place_pwr_flag"], components_added_max: add, components_deleted_max: 0, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist, target: "root.kicad_sch", note: "draw" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await runUntilIdle(lead, "draw it");
  }

  const RAIL_OPLIST = { groups: { g: { origin_mil: [0, 0] } }, ops: [{ op: "place_component", designator: "U1", group: "g", x_mil: 0, y_mil: 0, lib_id: "Regulator_Linear:AMS1117-3.3" }, { op: "place_pwr_flag", at: "U1.2" }], refdes_used: ["U1"] };

  it("post-turn gate asks KiCad's own ERC once and merges its rows (sheet, refs, waivable location)", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    state.kicad = { available: true, ok: false, total: 2, trust: "untrusted", violations: [
      { type: "power_pin_not_driven", severity: "error", description: "Input Power pin not driven by any Output Power pins", sheet: "/", items: [{ description: "Symbol U1 Pin 8 [VDD, Power input, Line]", uuid: "aaa" }] },
      { type: "endpoint_off_grid", severity: "warning", description: "Symbol pin or wire end off connection grid", sheet: "/power/", items: [{ description: "Wire", uuid: "bbb" }] },
    ] };
    await buildTurn(lead, RAIL_OPLIST);
    expect(calls.filter((c) => c.name === "kicad_advisory").length).toBe(1);
    const ended = events.find((e) => e.kind === "turn_ended");
    expect(ended && ended.kind === "turn_ended" && ended.summary.kicad).toEqual({ available: true, errors: 1, warnings: 1 });
    const rows = events.flatMap((e) => (e.kind === "findings" ? e.findings : [])) as { code: string; severity: string; sheet?: string; refs?: string[]; location?: string; origin?: string }[];
    const kicad = rows.filter((f) => f.code.startsWith("KICAD_"));
    expect(kicad.map((f) => f.code)).toEqual(["KICAD_POWER_PIN_NOT_DRIVEN", "KICAD_ENDPOINT_OFF_GRID"]);
    expect(kicad[0]).toMatchObject({ severity: "Error", sheet: "/", refs: ["U1.8"], location: "kicad:power_pin_not_driven:aaa", origin: "advisory" });
    expect(kicad[1]).toMatchObject({ severity: "Warning", sheet: "/power/" });
    expect(lead.turns[0].findings.map((f) => (f as { code: string }).code)).toContain("KICAD_POWER_PIN_NOT_DRIVEN");
  });

  it("a missing kicad-cli is reported as not available, never as a clean KiCad result", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    state.kicad = { available: false, code: "KICAD_CLI_MISSING" };
    await buildTurn(lead, RAIL_OPLIST);
    const ended = events.find((e) => e.kind === "turn_ended");
    expect(ended && ended.kind === "turn_ended" && ended.summary.kicad).toEqual({ available: false, errors: 0, warnings: 0, note: "KICAD_CLI_MISSING" });
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.kicad_advisory_unavailable")).toBe(true);
  });

  // A turn that fixed everything must say so: the full batch is what resolves the rows an earlier
  // turn left on the findings panel (and their canvas markers). Emitting nothing used to leave a
  // clean project showing the previous run's findings as still open.
  it("a clean gate and a clean KiCad run each emit an empty full batch", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    state.kicad = { available: true, ok: true, total: 0, trust: "untrusted", violations: [] };
    await buildTurn(lead, RAIL_OPLIST);
    const full = events.filter((e): e is Extract<TurnEvent, { kind: "findings" }> => e.kind === "findings" && !!e.full);
    // One from the engine gate, one from KiCad's own ERC; both empty, both complete.
    expect(full.length).toBe(2);
    expect(full.every((e) => e.findings.length === 0)).toBe(true);
  });

  it("power ports are counted apart from components in the turn footer", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    await buildTurn(lead, RAIL_OPLIST);
    const ended = events.find((e) => e.kind === "turn_ended");
    expect(ended && ended.kind === "turn_ended" && ended.summary.applied).toMatchObject({ components_added: 1, power_ports_added: 1 });
    const applied = events.find((e) => e.kind === "applied");
    expect(applied && applied.kind === "applied" && applied.counts).toEqual({ added: 1, deleted: 0, wires: 0, power_ports: 1, moved: 0 });
  });

  it("scope widening beyond the ceiling is a hard stop the human can approve (no modify) and nothing is applied", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "abandon" }));
    lead.setMode("build", "bs-1");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "big", envelope: { sheets: ["root.kicad_sch"], allowed_ops: [], components_added_max: 999, components_deleted_max: 5, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("stopped"),
    ]);
    await runUntilIdle(lead, "delete everything and add 999 parts");
    const card = events.find((e) => e.kind === "card" && e.card.kind === "hard_stop");
    expect(card && card.kind === "card" && card.card.actions.some((a) => a.id === "approve")).toBe(true);
    expect(card && card.kind === "card" && card.card.actions.some((a) => a.id === "modify")).toBe(false);
    expect(state.applied).toBe(0);
    // While the card waited, pending_card.json held the card (no grant ids); it is cleared once answered.
    const pc = calls.filter((c) => c.name === "sidecar_write" && (c.args as { write: { kind: string } }).write.kind === "pending_card").map((c) => (c.args as { write: { turn: number; card: { card: Card; grant_kind: string | null; step: string } | null } }).write);
    expect(pc.length).toBe(2);
    expect(pc[0].card?.card.kind).toBe("hard_stop");
    expect(pc[0].card?.grant_kind).toBe("scope");
    expect(JSON.stringify(pc[0].card)).not.toMatch(/grant-1|consent_event_id/);
    expect(pc[1].card).toBeNull();
  });

  it("Stop while a hard-stop card waits ends the turn without applying and without a second card", async () => {
    const events: TurnEvent[] = [];
    let lead!: LeadLoop;
    // The card never gets a human answer; the user presses Stop instead.
    lead = makeLead(events, () => { setTimeout(() => void lead.stop(), 10); return new Promise(() => undefined) as never; });
    lead.setMode("build", "bs-1");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "big", envelope: { sheets: ["root.kicad_sch"], allowed_ops: [], components_added_max: 999, components_deleted_max: 5, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("stopped"),
    ]);
    const t0 = Date.now();
    await runUntilIdle(lead, "delete everything and add 999 parts");
    expect(Date.now() - t0).toBeLessThan(5000); // no 15 s watchdog wait
    expect(lead.running).toBe(false);
    expect(state.applied).toBe(0);
    expect(events.filter((e) => e.kind === "card" && e.card.kind === "hard_stop").length).toBe(1);
    expect(["stopped", "abandoned"]).toContain(lead.turns[0].status);
  });

  it("a provider error message with no content is not pushed into the history", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "question", headline: "q" }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "PROVIDER_RATE_LIMIT: 429" }),
    ]);
    await runUntilIdle(lead, "hello?");
    const empties = lead.history.filter((m) => m.role === "assistant" && m.toolCalls.length === 0 && !m.content.some((c) => c.type === "text" && c.text.trim()));
    expect(empties).toEqual([]);
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  it("rollback keeps compaction blocks anchored before the rollback point and drops later ones", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    const msg = (turn: number, kind: string, text = "x"): (typeof lead.history)[number] => ({ role: "user", content: [{ type: "text", text }], meta: { turn, task: turn, kind: kind as "user" } });
    lead.history.push(msg(1, "user"), msg(2, "compaction", "summary of 1"), msg(3, "user"), msg(4, "compaction", "summary of 3"), msg(5, "user"));
    lead.afterRollback(4);
    const kinds = lead.history.filter((m) => m.meta.kind === "compaction").map((m) => m.meta.turn);
    expect(kinds).toEqual([2]);
  });

  it("micro-edit fast path applies without a model call", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    faux.setResponses([]);
    const before = faux.state.callCount;
    await runUntilIdle(lead, "set R1 value = 10k");
    expect(state.applied).toBe(1);
    expect(faux.state.callCount).toBe(before);
    expect(lead.turns[0].headline).toBe("set R1.value = 10k");
  });

  it("/fix names what it dropped, folds a KiCad row into the engine finding, and says which sheet it ran on", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch", "power.kicad_sch"]);
    lead.setMode("build", "bs-1");
    faux.setResponses([]);
    (lead as unknown as { pendingFix: unknown[] }).pendingFix = [
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", location: "erc:1", sheet: "/", refs: ["U1.5"], origin: "engine" },
      { code: "KICAD_POWER_PIN_NOT_DRIVEN", severity: "Error", location: "kicad:a", sheet: "/", refs: ["U1.5"], origin: "advisory" },
      { code: "KICAD_LIB_SYMBOL_ISSUES", severity: "Warning", location: "kicad:b", refs: ["U9"], origin: "advisory" },
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", location: "erc:2", sheet: "/power/", refs: ["U2.5"], origin: "engine" },
    ];
    await runUntilIdle(lead, "/fix");
    const sys = events.filter((e) => e.kind === "system") as Extract<TurnEvent, { kind: "system" }>[];
    const routed = sys.find((e) => e.text_key === "system.fix_routed");
    expect(routed?.params?.n).toBe(1);
    const dropped = sys.find((e) => e.text_key === "system.fix_not_fixable");
    expect(dropped?.params?.n).toBe(1);
    expect(String(dropped?.params?.codes)).toContain("KICAD_LIB_SYMBOL_ISSUES");
    const other = sys.find((e) => e.text_key === "system.fix_other_sheets");
    expect(other?.params).toMatchObject({ sheet: "root.kicad_sch", n: 1, sheets: "power.kicad_sch" });
    // The closing line names the sheet the repairs went to and what of the selection is still open.
    const done = sys.find((e) => e.text_key === "system.fix_done");
    expect(done?.params).toMatchObject({ sheet: "root.kicad_sch" });
    expect(done?.params).toHaveProperty("codes");
  });

  it("/fix that moved the gate counts ends on a review card, with no reviewer call", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "modify" }));
    lead.setMode("build", "bs-1");
    // One Fixer round: the model returns a replacement op-list, the apply goes through.
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    // The review that produced the selection saw two errors; the gate now reports one, so the fix
    // moved the counts and the turn owes the human a verdict.
    (lead as unknown as { lastGate: { errors: number; warnings: number } }).lastGate = { errors: 2, warnings: 0 };
    const open = { code: "ERC_INPUT_FLOATING", severity: "Error", location: "erc:1", sheet: "/", refs: ["U1.5"], origin: "engine" };
    state.findings = [open];
    (lead as unknown as { pendingFix: unknown[] }).pendingFix = [open];
    const calls0 = faux.state.callCount;
    await runUntilIdle(lead, "/fix");
    expect(state.applied).toBeGreaterThan(0);
    const cards = events.filter((e) => e.kind === "card").map((e) => (e as Extract<TurnEvent, { kind: "card" }>).card);
    const card = cards.find((c) => c.title === "card.review_after_fix");
    expect(card?.kind).toBe("review");
    expect(card?.actions.map((a) => a.id)).toEqual(["fix_selected", "waive_selected", "dismiss"]);
    // The rows are the engine's gate run, not a Reviewer's: the only model calls were the Fixer's.
    expect(((card?.data as { findings?: { code: string }[] })?.findings ?? []).map((f) => f.code)).toEqual(["ERC_INPUT_FLOATING"]);
    expect((card?.data as { advisory?: number })?.advisory).toBe(0);
    expect(faux.state.callCount - calls0).toBeLessThan(3);
  });

  /** Every `set_title_block` op the turn sent to the engine, with the file it targeted. */
  function titleApplies(): { target: string; title: unknown }[] {
    return calls
      .filter((c) => c.name === "engine_request")
      .map((c) => (c.args as { request: { kind: string; target?: string; oplist?: { ops?: { op?: string; title?: unknown }[] } } }).request)
      .filter((r) => r.kind === "apply")
      .flatMap((r) => (r.oplist?.ops ?? []).filter((o) => o.op === "set_title_block").map((o) => ({ target: String(r.target ?? ""), title: o.title })));
  }

  // The skill promises "the system fills an empty title block from the sheet name after the turn".
  // The verdict is the engine's (`TITLE_BLOCK_EMPTY` from sch-check, red line 6); the harness only
  // mechanises the repair the finding asks for, on the file the finding names.
  it("post-turn: an empty title block on a sheet this turn wrote is filled from the file stem", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    state.findings = [{ code: "TITLE_BLOCK_EMPTY", severity: "Info", message: "sheet / has no title", location: "title:/u", sheet: "/", file: "root.kicad_sch" }];
    await buildTurn(lead, RAIL_OPLIST);
    expect(titleApplies()).toEqual([{ target: "root.kicad_sch", title: "root" }]);
  });

  it("post-turn: a title finding on a file this turn did not write is left alone", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, undefined, ["root.kicad_sch", "power.kicad_sch"]);
    lead.setMode("build", "bs-1");
    // The turn only ever applies to root.kicad_sch (the fake engine's `targets`), so the child's
    // empty title block is somebody else's to fill: never overwrite a sheet this turn did not touch.
    state.findings = [{ code: "TITLE_BLOCK_EMPTY", severity: "Info", message: "sheet /power/ has no title", location: "title:/u/p", sheet: "/power/", file: "power.kicad_sch" }];
    await buildTurn(lead, RAIL_OPLIST);
    expect(titleApplies()).toEqual([]);
  });

  // P2-11: "change R1 to 2k2" asked for one value. An incremental edit turn (no gate step, no part
  // added) leaves the sheet's empty title block alone, so the file differs from before only in the edit.
  it("post-turn: an edit-only turn gets no title block", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    state.findings = [{ code: "TITLE_BLOCK_EMPTY", severity: "Info", message: "sheet / has no title", location: "title:/u", sheet: "/", file: "root.kicad_sch" }];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "edit R1", envelope: { sheets: ["root.kicad_sch"], allowed_ops: ["set_component_parameters"], components_added_max: 0, components_deleted_max: 0, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist: { groups: {}, ops: [{ op: "set_component_parameters", designator: "R1", value: "2k2" }], refdes_used: [] }, target: "root.kicad_sch", note: "edit" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await runUntilIdle(lead, "change R1 to 2k2");
    expect(events.some((e) => e.kind === "applied")).toBe(true);
    expect(titleApplies()).toEqual([]);
  });

  // Run 19: the plan drew everything on the child sheet, so the fill only ever saw `power.kicad_sch`
  // and the root sheet finished the plan unnamed. The gate step is the plan's last word on the whole
  // project: there the fill reaches every sheet the approved plan declared (and nothing else).
  it("the gate step fills every plan sheet the engine reports unnamed, not only the ones the turn wrote", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }, { path: "/power/", file: "power.kicad_sch" }];
    state.findings = [
      { code: "TITLE_BLOCK_EMPTY", severity: "Info", message: "sheet / has no title", location: "title:/u", sheet: "/", file: "root.kicad_sch" },
      { code: "TITLE_BLOCK_EMPTY", severity: "Info", message: "sheet /power/ has no title", location: "title:/u/p", sheet: "/power/", file: "power.kicad_sch" },
    ];
    const lead = makeLead(events, undefined, ["root.kicad_sch", "power.kicad_sch"]);
    lead.setMode("build", "bs-1");
    const plan = JSON.parse(JSON.stringify(draftPlan)) as DesignPlan;
    plan.sheets = [{ file: "root.kicad_sch", role: "root" }, { file: "power.kicad_sch", create: true, parent: "root.kicad_sch" }];
    plan.blocks[0].sheet = "power.kicad_sch";
    plan.floorplan = { "power.kicad_sch": [{ group: "ldo", origin_mil: [1000, 1000], extent_mil: [2000, 1500] }] };
    plan.steps = [{ id: "s1", block: "ldo", kind: "draft" }, { id: "s2", block: "ldo", kind: "gate" }];
    lead.adoptPlan(plan, true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    // The draft step wrote the child only; both titles are filled at the gate, one op per sheet.
    const drafted = lead.turns.find((t) => t.plan_step === "s1");
    expect(drafted?.applies.flatMap((a) => a.targets ?? [a.target])).toEqual(["power.kicad_sch"]);
    expect(titleApplies()).toEqual([{ target: "root.kicad_sch", title: "root" }, { target: "power.kicad_sch", title: "power" }]);
    // The gate step declared both plan sheets, which is what let the root be filled at all.
    expect(lead.turns.find((t) => t.plan_step === "s2")?.envelope?.sheets).toEqual(["power.kicad_sch", "root.kicad_sch"]);
  });

  it("post-turn: a sheet whose title block is already set gets no set_title_block", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    // No `TITLE_BLOCK_EMPTY` means the engine sees a title: the harness never inspects one itself,
    // so it cannot overwrite a human-written title block.
    state.findings = [{ code: "OFF_GRID", severity: "Warning", message: "a", location: "style:1", sheet: "/" }];
    await buildTurn(lead, RAIL_OPLIST);
    expect(titleApplies()).toEqual([]);
  });

  it("/review <sheet> scopes the per-sheet checks, the card and the reviewer's brief", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "dismiss" }), ["root.kicad_sch", "power.kicad_sch"]);
    faux.setResponses([]);
    state.findings = [
      { code: "OFF_GRID", severity: "Warning", message: "a", location: "style:1", sheet: "/" },
      { code: "LABEL_OVERLAP", severity: "Warning", message: "b", location: "labels:1", sheet: "/power/" },
      { code: "LIB_UNVERIFIED_CLAIM", severity: "Info", message: "c", location: "lib:1" },
    ];
    await runUntilIdle(lead, "/review power");
    // Every `check.*` node of the review workflow runs on that sheet; `gate.run` stays project-wide.
    const checks = calls.filter((c) => c.name === "engine_request").map((c) => (c.args as { request: { kind: string; sheet?: string } }).request);
    expect(checks.filter((r) => r.kind === "check").length).toBeGreaterThan(0);
    for (const r of checks.filter((x) => x.kind === "check")) expect(r.sheet).toBe("power.kicad_sch");
    const card = events.filter((e) => e.kind === "card").map((e) => (e as Extract<TurnEvent, { kind: "card" }>).card).find((c) => c.title === "card.review");
    const codes = ((card?.data as { findings?: { code: string }[] })?.findings ?? []).map((f) => f.code);
    // The scoped sheet's row and the row that names no sheet (a project-level check); not the root's.
    expect(codes).toContain("LABEL_OVERLAP");
    expect(codes).toContain("LIB_UNVERIFIED_CLAIM");
    expect(codes).not.toContain("OFF_GRID");
    expect(lead.turns[0].headline).toBe("review power.kicad_sch");
    // A partial batch: a scoped review must not resolve the findings of the sheets it left out.
    const batch = events.filter((e) => e.kind === "findings").pop() as Extract<TurnEvent, { kind: "findings" }>;
    expect(batch.full).toBe(false);
  });

  it("/review <sheet> with an unknown sheet says so and reviews the project", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "dismiss" }), ["root.kicad_sch"]);
    faux.setResponses([]);
    state.findings = [{ code: "OFF_GRID", severity: "Warning", message: "a", location: "style:1", sheet: "/" }];
    await runUntilIdle(lead, "/review nope.kicad_sch");
    const sys = events.filter((e) => e.kind === "system") as Extract<TurnEvent, { kind: "system" }>[];
    expect(sys.find((e) => e.text_key === "system.review_scope_unknown")?.params).toMatchObject({ arg: "nope.kicad_sch" });
    const card = events.filter((e) => e.kind === "card").map((e) => (e as Extract<TurnEvent, { kind: "card" }>).card).find((c) => c.title === "card.review");
    expect(((card?.data as { findings?: { code: string }[] })?.findings ?? []).map((f) => f.code)).toContain("OFF_GRID");
  });

  it("apply outside Build (plan mode) is impossible: tool table has no D and P1 denies", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "x" }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist: { groups: { g: {} }, ops: [], refdes_used: [] }, target: "root.kicad_sch", note: "n" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    await runUntilIdle(lead, "add R3");
    expect(state.applied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SHEET_NOT_FOUND: one redraw per step with the engine's sheet symbol names
// ---------------------------------------------------------------------------

/** The engine's message for a sheet symbol that does not exist; it lists the names that do. */
const SNF_DETAIL = "no sheet symbol named ldo_board.kicad_sch; sheet symbols on this sheet: power, mcu";
const SNF_REFUSAL = `SHEET_NOT_FOUND: ${SNF_DETAIL} (op #1)`;

const draftPlan: DesignPlan = {
  schema_version: 1, kind: "schematic", id: "plan-1", version: 1, created: "", source: "architect", goal: "LDO", constraints: [], assumptions: [], open_questions: [],
  sheets: [{ file: "root.kicad_sch", role: "root" }], interfaces: [], net_naming: { rails: ["GND"], rail_mechanism: "power_port" },
  conventions: [], floorplan: { "root.kicad_sch": [{ group: "ldo", origin_mil: [1000, 1000], extent_mil: [2000, 1500] }] },
  blocks: [{ id: "ldo", sheet: "root.kicad_sch", summary: "ldo block", parts: [{ ref_prefix: "R", lib_id: "Device:R", resolved: true }], nets_in: ["GND"], nets_out: [], acceptance: [] }],
  steps: [{ id: "s1", block: "ldo", kind: "draft" }],
  envelope: { budgets: { components_added: 20, components_deleted: 0, components_moved: 0, objects_deleted: {}, wires_added: 50, labels_added: 30, properties_changed: {}, transforms_changed: 0, attributes_changed: 0 }, nets: { rails: ["GND"], renamable: [], may_create_named: true }, structural: [], allowed_ops: ["place_component"] },
  refdes_policy: { frozen_existing: true, reuse_freed: false }, budget: { tokens: null, cost_usd: 5, tool_calls: 400, wall_active_min: 60 }, display: { status: "approved", approved_at: null },
};

const DRAFT_ANSWER = `\`\`\`json\n${JSON.stringify({ groups: { ldo: { origin_mil: [1000, 1000] } }, ops: [{ op: "place_component", designator: "R3", lib_id: "Device:R", group: "ldo", x_mil: 100, y_mil: 100 }], refdes_used: ["R3"], region_used: [[1000, 1000], [3000, 2500]] })}\n\`\`\``;

/** The brief of every Drafter dispatch, in order (the harness archives each subagent transcript). */
function drafterBriefs(): string[] {
  return calls
    .filter((c) => c.name === "sidecar_write" && (c.args as { write: { kind: string; role?: string } }).write?.kind === "subagent" && (c.args as { write: { role?: string } }).write.role === "drafter")
    .map((c) => String((c.args as { write: { transcript: { brief: string } } }).write.transcript.brief));
}

async function runDraftStep(events: TurnEvent[], refusals: string[]): Promise<LeadLoop> {
  const lead = makeLead(events);
  lead.setMode("build", "bs-1");
  lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
  state.applyRefusals.push(...refusals);
  faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
  await runUntilIdle(lead, "/run");
  return lead;
}

describe("SHEET_NOT_FOUND redraw", () => {
  it("a refused apply redraws the step exactly once, with the engine's sheet names in the second brief", async () => {
    const events: TurnEvent[] = [];
    await runDraftStep(events, [SNF_REFUSAL]);
    const briefs = drafterBriefs();
    expect(briefs.length).toBe(2);
    expect(briefs[0]).not.toMatch(/SHEET_NOT_FOUND/);
    expect(briefs[1]).toMatch(/SHEET_NOT_FOUND/);
    expect(briefs[1]).toContain(SNF_DETAIL);
    expect(briefs[1]).toContain("Return the corrected op-list.");
    // The redraw is what got written, and the user is told why.
    expect(state.applied).toBe(1);
    expect(events.some((e) => e.kind === "status" && /redrawing after SHEET_NOT_FOUND/.test(e.text))).toBe(true);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.sheet_redraw")).toBe(true);
  });

  it("a second SHEET_NOT_FOUND fails the step instead of redrawing again", async () => {
    const events: TurnEvent[] = [];
    const lead = await runDraftStep(events, [SNF_REFUSAL, SNF_REFUSAL]);
    expect(drafterBriefs().length).toBe(2);
    expect(state.applied).toBe(0);
    expect(events.some((e) => e.kind === "card" && e.card.kind === "system" && e.card.title === "system.step_failed")).toBe(true);
    expect(lead.turns[0].status).not.toBe("done");
  });

  it("another engine refusal fails the step without a redraw", async () => {
    const events: TurnEvent[] = [];
    await runDraftStep(events, ["SYMBOL_NOT_FOUND: no symbol Device:XYZ in any library (op #1)"]);
    expect(drafterBriefs().length).toBe(1);
    expect(state.applied).toBe(0);
    expect(events.some((e) => e.kind === "status" && /redrawing after SHEET_NOT_FOUND/.test(e.text))).toBe(false);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.sheet_redraw")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ENVELOPE_SHEET_UNDECLARED: the draft would write a file outside the step's approved sheets
// ---------------------------------------------------------------------------

/** The Rust envelope check's own words (src-tauri/src/engine.rs) for an out-of-scope write. */
const ESU_MESSAGE = "this op-list would write power.kicad_sch, which the approved sheets do not include";
const ESU_REMEDIATION = "keep the ops on the step's own sheet (a local label is renamed per sheet), or the user widens the scope";
const ESU_ERROR = { code: "ENVELOPE_SHEET_UNDECLARED", message: ESU_MESSAGE, remediation: ESU_REMEDIATION };

async function runDraftStepWithErrors(events: TurnEvent[], errors: typeof state.applyErrors, policy: "review" | "auto" = "review"): Promise<LeadLoop> {
  const lead = makeLead(events);
  lead.setMode("build", "bs-1");
  lead.setPolicy(policy);
  lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
  state.applyErrors.push(...errors);
  faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
  await runUntilIdle(lead, "/run");
  return lead;
}

describe("ENVELOPE_SHEET_UNDECLARED redraw", () => {
  it("redraws the step once, with the engine's message and remediation in the second brief", async () => {
    const events: TurnEvent[] = [];
    await runDraftStepWithErrors(events, [ESU_ERROR]);
    const briefs = drafterBriefs();
    expect(briefs.length).toBe(2);
    expect(briefs[0]).not.toMatch(/ENVELOPE_SHEET_UNDECLARED/);
    expect(briefs[1]).toContain(ESU_MESSAGE);
    expect(briefs[1]).toContain(ESU_REMEDIATION);
    // The rule the drafter broke, spelled out: a rail crosses on power ports, not on a sheet pin.
    expect(briefs[1]).toContain("sheet pins are for signals");
    expect(briefs[1]).toContain("Return the corrected op-list.");
    expect(state.applied).toBe(1);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.sheet_scope_redraw")).toBe(true);
  });

  it("a step whose applies were all refused ends failed, never done, and says it wrote nothing", async () => {
    const events: TurnEvent[] = [];
    const lead = await runDraftStepWithErrors(events, [ESU_ERROR, ESU_ERROR], "auto");
    expect(drafterBriefs().length).toBe(2);
    expect(state.applied).toBe(0);
    expect(lead.turns[0].applies).toEqual([]);
    // Auto carries the plan past the step, but the turn record still says what happened: the skip is on
    // the turn (so the summary card exists) and the outcome is not a silent "done".
    expect(lead.turns[0].status).toBe("failed");
    // The second failure is adjudicated like any other step failure (the redraw itself raises no card, so
    // claiming it had been carded made this skip silent): one auto decision, one reported skip.
    expect(lead.turns[0].auto_decisions.map((d) => d.action)).toContain("reverted_and_skipped");
    expect(events.filter((e) => e.kind === "system" && e.text_key === "system.auto_step_skipped").length).toBe(1);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.step_wrote_nothing")).toBe(true);
  });

  it("cards the second failure under Review instead of skipping the step in silence", async () => {
    const events: TurnEvent[] = [];
    const seen: Card[] = [];
    const lead = makeLead(events, (c) => { seen.push(c); return { action_id: "skip" }; });
    lead.setMode("build", "bs-1");
    lead.setPolicy("review");
    lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
    state.applyErrors.push(ESU_ERROR, ESU_ERROR);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    expect(state.applied).toBe(0);
    expect(seen.some((c) => c.title.startsWith("hard_stop."))).toBe(true);
    expect(lead.turns[0].status).not.toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Hierarchical interfaces: the scaffold step owns the sheet pins
// ---------------------------------------------------------------------------

/** A two-sheet plan whose child is created by a scaffold step and carries three interfaces. */
function interfacePlan(): DesignPlan {
  const p = JSON.parse(JSON.stringify(draftPlan)) as DesignPlan;
  p.sheets = [{ file: "root.kicad_sch", role: "root" }, { file: "power.kicad_sch", role: "child", create: true }];
  p.interfaces = [
    { net: "PGOOD_OUT", mechanism: "sheet_pin", from: "power.kicad_sch", to: "root.kicad_sch" },
    { net: "EN", mechanism: "sheet_pin", from: "root.kicad_sch", to: "power.kicad_sch" },
    { net: "SYS_ALERT", mechanism: "global_label", from: "power.kicad_sch", to: "root.kicad_sch" },
  ];
  p.blocks[0].sheet = "power.kicad_sch";
  p.blocks[0].nets_in = ["EN", "GND"];
  p.blocks[0].nets_out = ["PGOOD_OUT"];
  p.floorplan = { "power.kicad_sch": [{ group: "ldo", origin_mil: [1000, 1000], extent_mil: [2000, 1500] }] };
  p.steps = [{ id: "s0", kind: "scaffold" }, { id: "s1", block: "ldo", kind: "draft" }];
  p.envelope.structural = ["create_sheet:power.kicad_sch", "add_sheet:power.kicad_sch"];
  return p;
}

/** Every `sheet_create` engine request, in order. */
function sheetCreates(): Record<string, unknown>[] {
  return calls
    .filter((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request?.kind === "sheet_create")
    .map((c) => (c.args as { request: Record<string, unknown> }).request);
}

describe("plan interfaces", () => {
  it("the scaffold step creates the sheet with its interface pins, and the Drafter brief names them", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch"]);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(interfacePlan(), true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const created = sheetCreates();
    expect(created.length).toBe(1);
    expect(created[0].file).toBe("power.kicad_sch");
    // Sheet pins only: a global-label interface needs no pin. Outputs leave on the right edge.
    expect(created[0].pins).toEqual([
      { name: "PGOOD_OUT", type: "output", side: "right" },
      { name: "EN", type: "input", side: "left" },
    ]);
    const brief = drafterBriefs()[0] ?? "";
    expect(brief).toContain("Interfaces leaving power.kicad_sch");
    expect(brief).toContain("PGOOD_OUT (output)");
    expect(brief).toContain("EN (input)");
    expect(brief).toContain("by global label: SYS_ALERT");
    // The mechanism is spelled out: there is no add_hier_label op.
    expect(brief).toContain('add_net_label scope "hierarchical"');
    expect(brief).not.toMatch(/\badd_hier_label\b(?! op)/);
  });

  it("a nested sheet is created after its parent and names it", async () => {
    const events: TurnEvent[] = [];
    const plan = interfacePlan();
    // The nested sheet is listed before the sheet it hangs under: the scaffold still creates the
    // parent first, and the child names it so its symbol lands in the parent's file.
    plan.sheets = [
      { file: "root.kicad_sch", role: "root" },
      { file: "analog.kicad_sch", role: "child", create: true, parent: "power.kicad_sch", paper: "A3" },
      { file: "power.kicad_sch", role: "child", create: true },
    ];
    plan.envelope.structural = ["create_sheet:power.kicad_sch", "add_sheet:power.kicad_sch", "create_sheet:analog.kicad_sch", "add_sheet:analog.kicad_sch"];
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch"]);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(plan, true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const created = sheetCreates();
    expect(created.map((c) => c.file)).toEqual(["power.kicad_sch", "analog.kicad_sch"]);
    expect(created[0].parent).toBe(null);
    expect(created[1].parent).toBe("power.kicad_sch");
    expect(created[1].paper).toBe("A3");
  });

  it("a plan without interfaces scaffolds a pinless sheet and leaves the brief alone", async () => {
    const events: TurnEvent[] = [];
    const plan = interfacePlan();
    plan.interfaces = [];
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch"]);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(plan, true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    expect(sheetCreates()[0]?.pins).toEqual([]);
    expect(drafterBriefs()[0] ?? "").not.toContain("Interfaces leaving");
  });
});

// ---------------------------------------------------------------------------
// FR-611: multi-instance sheets (INSTANCE_REFS_REQUIRED)
// ---------------------------------------------------------------------------

/** `sch.summary.sheets` for a project whose amp.kicad_sch is instantiated twice. */
const REUSED_SHEETS = [
  { path: "/root-uuid", file: "root.kicad_sch" },
  { path: "/root-uuid/inst-b", file: "amp.kicad_sch" },
  { path: "/root-uuid/inst-a", file: "amp.kicad_sch" },
];
const INSTANCE_FINDING = {
  code: "INSTANCE_REFS_REQUIRED", severity: "Error", sheet: "/Amp A/", location: "instrefs:sheet-uuid",
  message: "amp.kicad_sch is instantiated 2 times; 2 symbols without a reference for every instance path: R1, C1 (missing paths: /root-uuid/inst-b)",
  refs: ["R1", "C1"],
  remediation: "annotate amp.kicad_sch in KiCad so every instance gets its own reference, or re-place the parts with place_component instance_designators covering all 2 instance paths",
};

/** A one-block plan whose sheet is instantiated twice (D-18 `sheets[].instances`). */
function reusedSheetPlan(withInstances: boolean): DesignPlan {
  const p = JSON.parse(JSON.stringify(draftPlan)) as DesignPlan;
  p.sheets = [{ file: "amp.kicad_sch", role: "child", ...(withInstances ? { instances: [{ name: "Amp A", at_mil: [1000, 1000] as [number, number] }, { name: "Amp B", at_mil: [1000, 3000] as [number, number] }] } : {}) }];
  p.floorplan = { "amp.kicad_sch": [{ group: "ldo", origin_mil: [1000, 1000], extent_mil: [2000, 1500] }] };
  p.blocks[0].sheet = "amp.kicad_sch";
  return p;
}

describe("FR-611 multi-instance sheets", () => {
  it("a plan that declares the instances puts the paths in the Drafter brief and raises no card", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = REUSED_SHEETS;
    state.findings.push(INSTANCE_FINDING);
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch", "amp.kicad_sch"]);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(reusedSheetPlan(true), true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const brief = drafterBriefs()[0] ?? "";
    expect(brief).toContain("amp.kicad_sch is instantiated 2 times");
    expect(brief).toContain("instance_designators");
    // Sorted, so the brief (and the prompt prefix) is deterministic.
    expect(brief).toContain("Instance paths: /root-uuid/inst-a, /root-uuid/inst-b");
    expect(events.some((e) => e.kind === "card" && e.card.kind === "question")).toBe(false);
  });

  it("without a plan declaration the finding raises a question card with the two instance options", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = REUSED_SHEETS;
    state.findings.push(INSTANCE_FINDING);
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch", "amp.kicad_sch"]);
    lead.setMode("build", "bs-1");
    const oplist = { groups: { g: { origin_mil: [0, 0] } }, ops: [{ op: "place_component", reference: "R3", group: "g", x_mil: 0, y_mil: 0, lib_id: "Device:R" }], refdes_used: ["R3"] };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "add R3", envelope: { sheets: ["amp.kicad_sch"], allowed_ops: ["place_component"], components_added_max: 2, components_deleted_max: 0, structural: [], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { oplist, target: "amp.kicad_sch", note: "add R3" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await runUntilIdle(lead, "add a resistor to the amp");
    const card = events.find((e) => e.kind === "card" && e.card.kind === "question");
    expect(card && card.kind === "card" && card.card.actions.map((a) => a.id)).toEqual(["all", "this_only"]);
    const data = card && card.kind === "card" ? (card.card.data as { code: string; sheet: string; paths: string[]; refs: string[]; instances: number }) : null;
    expect(data?.code).toBe("INSTANCE_REFS_REQUIRED");
    expect(data?.sheet).toBe("amp.kicad_sch");
    expect(data?.instances).toBe(2);
    expect(data?.paths).toEqual(["/root-uuid/inst-a", "/root-uuid/inst-b"]);
    expect(data?.refs).toEqual(["R1", "C1"]);
    // The card is a question, not a hard stop: the turn finished on its own.
    expect(lead.turns[0].status).toBe("summarized");
    expect(lead.running).toBe(false);
  });

  it("answering \"this instance only\" writes nothing and says so", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch", "amp.kicad_sch"]);
    lead.setMode("build", "bs-1");
    lead.answerInstanceRefs({ sheet: "amp.kicad_sch", paths: ["/root-uuid/inst-a", "/root-uuid/inst-b"], refs: ["R1"] }, "this");
    await runUntilIdle(lead, "/instances");
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.instance_refs_this_only")).toBe(true);
    expect(state.applied).toBe(0);
  });

  it("answering \"all instances\" re-places the affected parts inside the envelope", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = REUSED_SHEETS;
    const lead = makeLead(events, () => ({ action_id: "modify" }), ["root.kicad_sch", "amp.kicad_sch"]);
    lead.setMode("build", "bs-1");
    const ops = [
      { op: "delete_component", designator: "R1" },
      { op: "place_component", designator: "R1", lib_id: "Device:R", x_mil: 1000, y_mil: 1000, exact: true, instance_designators: { "/root-uuid/inst-a": "R1", "/root-uuid/inst-b": "R101" } },
    ];
    faux.setResponses([fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ groups: {}, ops, refdes_used: ["R1", "R101"] })}\n\`\`\``)]);
    lead.answerInstanceRefs({ sheet: "amp.kicad_sch", paths: ["/root-uuid/inst-a", "/root-uuid/inst-b"], refs: ["R1"] }, "all");
    for (let i = 0; i < 400 && (lead.running || (lead as unknown as { queue: unknown[] }).queue.length); i++) await new Promise((r) => setTimeout(r, 5));
    const brief = calls.filter((c) => c.name === "sidecar_write" && (c.args as { write: { kind: string; role?: string } }).write?.kind === "subagent").map((c) => String((c.args as { write: { transcript: { brief: string } } }).write.transcript.brief))[0] ?? "";
    expect(brief).toContain("delete_component");
    expect(brief).toContain("instance_designators");
    expect(state.applied).toBe(1);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.instance_refs_done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The plan's gate step: what it reports, and what the wiring step tells the Drafter
// ---------------------------------------------------------------------------

/** A plan whose block declares two typed acceptance items and ends in a gate step. */
function gatePlan(): DesignPlan {
  const p = JSON.parse(JSON.stringify(draftPlan)) as DesignPlan;
  p.blocks[0].acceptance = [
    { type: "check_clean", codes: ["FOOTPRINT_MISSING"] },
    { type: "net_has_pins", net: "GND", min: 2 },
  ];
  p.steps = [{ id: "s1", block: "ldo", kind: "draft" }, { id: "s2", kind: "gate" }];
  return p;
}

describe("plan gate step", () => {
  it("reports done_with_findings when unwaived Errors are left, and keeps the plan running", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    state.findings.push({ code: "FOOTPRINT_MISSING", severity: "Error", message: "U1 has no footprint" });
    state.netPins = { "U1.1": "GND", "C1.2": "GND" };
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(gatePlan(), true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const gateTurn = lead.turns.find((t) => t.plan_step === "s2");
    expect(gateTurn?.gate_errors_left).toBe(1);
    // The draft step ends "done"; the gate step, which found the Error, is the last turn to end.
    const ended = events.filter((e) => e.kind === "turn_ended").map((e) => (e.kind === "turn_ended" ? e.summary : null));
    expect(ended.map((s) => s?.outcome)).toEqual(["done", "done_with_findings"]);
    // The gate is a report, not a wall: the step counts as done and the plan finished.
    expect(lead.planStepsDone.has("s2")).toBe(true);
    expect(events.some((e) => e.kind === "card" && e.card.kind === "system" && e.card.title === "system.plan_done")).toBe(true);
  });

  // A waiver is a recorded human decision the engine already honours (it leaves the row out of its
  // own verdict). The turn must honour it too: the same Error, waived, ends the gate step "done".
  it("does not count a waived Error against the gate step", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    state.findings.push({ code: "FOOTPRINT_MISSING", severity: "Error", message: "U1 has no footprint", waived: true, waived_until: "2099-01-01T00:00:00Z", waived_reason: "footprint chosen at layout" });
    state.netPins = { "U1.1": "GND", "C1.2": "GND" };
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(gatePlan(), true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const gateTurn = lead.turns.find((t) => t.plan_step === "s2");
    expect(gateTurn?.gate_errors_left).toBe(0);
    const ended = events.filter((e) => e.kind === "turn_ended").map((e) => (e.kind === "turn_ended" ? e.summary : null));
    expect(ended.map((s) => s?.outcome)).toEqual(["done", "done"]);
  });

  it("evaluates the block's acceptance from engine results and reports it per item", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    state.findings.push({ code: "FOOTPRINT_MISSING", severity: "Error", message: "U1 has no footprint" });
    state.netPins = { "U1.1": "GND", "C1.2": "GND" };
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(gatePlan(), true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const gateTurn = lead.turns.find((t) => t.plan_step === "s2");
    const acc = gateTurn?.acceptance ?? [];
    expect(acc.map((a) => [a.type, a.status])).toEqual([["check_clean", "fail"], ["net_has_pins", "pass"]]);
    expect(acc[0].detail).toBe("FOOTPRINT_MISSING");
    // The counts ride along on `system.plan_done`, next to the findings and KiCad's own ERC.
    const done = events.find((e) => e.kind === "card" && e.card.title === "system.plan_done");
    const params = done && done.kind === "card" ? (done.card.data as { acceptance_passed: number; acceptance_failed: number; acceptance_key: string }) : null;
    expect(params?.acceptance_passed).toBe(1);
    expect(params?.acceptance_failed).toBe(1);
    expect(params?.acceptance_key).toBe("system.plan_done_acceptance");
    // A failed acceptance is a report: it refuses nothing and raises no hard stop.
    expect(events.some((e) => e.kind === "card" && e.card.kind === "hard_stop")).toBe(false);
  });

  // Run 19: `component_count #FLG 1..1` read 0 and `pin_on_net #FLG.1 = USB_5V` read "no #FLG*.1"
  // over a PWR_FLAG that was on the sheet — the netlist hides a power symbol's pin. The gate reads
  // the two engine answers that do carry them: the symbol list and the net's own `flagged` bit.
  it("power-symbol acceptance is answered from the symbol list and the net's flagged bit", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    state.netPins = { "U1.3": "USB_5V", "J1.1": "USB_5V", "U1.1": "GND" };
    state.netList = [{ name: "USB_5V", flagged: true }, { name: "GND", flagged: false }];
    // Run 21: `place_pwr_flag` annotates its flag out of the same `#PWRnn` sequence as every other
    // power port, so the flag on this sheet is `#PWR07` and only its lib_id says what it is. The
    // reference seeds the symbol's uuid and is frozen (red line 1); the evaluation resolves the
    // prefix by the library symbol instead.
    state.symbols = [
      { reference: "#PWR07", value: "PWR_FLAG", lib_id: "power:PWR_FLAG" },
      { reference: "#PWR01", value: "GND", lib_id: "power:GND" },
      { reference: "U1", value: "AMS1117-3.3", lib_id: "Regulator_Linear:AMS1117-3.3" },
    ];
    const plan = gatePlan();
    plan.blocks[0].acceptance = [
      { type: "component_count", prefix: "#FLG", min: 1, max: 1 },
      { type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "USB_5V" },
      { type: "pin_on_net", ref_prefix: "#PWR", pin: "1", net: "GND" },
    ] as unknown as DesignPlan["blocks"][number]["acceptance"];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(plan, true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const acc = lead.turns.find((t) => t.plan_step === "s2")?.acceptance ?? [];
    expect(acc.map((a) => [a.label, a.status, a.detail])).toEqual([
      ["component_count #FLG 1..1", "pass", "1"],
      ["pin_on_net #FLG.1 = USB_5V", "pass", "#PWR07 on USB_5V"],
      ["pin_on_net #PWR.1 = GND", "pass", "#PWR01 GND"],
    ]);
  });

  // Run 21: `DECAP_FAR` is a `delivery` finding, so the stylist pass — which reads `check.style` and
  // `check.layout` — never saw the two the gate had already reported and C1 stayed 808 mil from the
  // pin it decouples. The gate step's pass reads the delivery codes it has an op for as well.
  it("the gate step's stylist repairs a far decoupling capacitor", async () => {
    const events: TurnEvent[] = [];
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    state.findings.push({
      code: "DECAP_FAR", severity: "Warning", message: "C1 (100nF) is 808 mil from the nearest power pin on +3V3",
      refs: ["C1.1"], file: "root.kicad_sch", at_mil: [2200, 1600],
      evidence: { nearest_pin: "U1.1", nearest_pin_at_mil: [1800, 1500] },
    });
    state.symbols = [
      { reference: "U1", value: "AMS1117-3.3", x_mil: 1500, y_mil: 1500 },
      { reference: "C1", value: "100n", x_mil: 2200, y_mil: 1600 },
    ];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(gatePlan(), true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage("```json\n{\"groups\":{},\"ops\":[]}\n```"), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const applies = calls
      .filter((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "apply")
      .map((c) => (c.args as { request: { oplist?: { ops?: Record<string, unknown>[]; note?: string } } }).request.oplist);
    const tidy = applies.filter((o) => o?.note === "stylist");
    const move = tidy.flatMap((o) => o?.ops ?? []).find((o) => o.op === "move_component" && o.designator === "C1");
    // Beside the pin the engine measured to (1800,1500), on its free side and on the 50 mil grid.
    expect(move).toBeTruthy();
    expect(Math.abs(Number(move!.x_mil) - 1800)).toBeLessThanOrEqual(300);
    expect(Math.abs(Number(move!.y_mil) - 1500)).toBeLessThanOrEqual(300);
  });

  it("the wiring step's hint reaches the Drafter's brief", async () => {
    const events: TurnEvent[] = [];
    const plan = gatePlan();
    plan.steps = [{ id: "s1", block: "ldo", kind: "draft" }, { id: "s2", kind: "wiring", nets: ["GND"] }];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(plan, true);
    faux.setResponses([fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER), fauxAssistantMessage(DRAFT_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const briefs = drafterBriefs();
    expect(briefs.length).toBeGreaterThan(1);
    const wiring = briefs.find((b) => /wire nets/.test(b)) ?? "";
    expect(wiring).toContain("This is a wiring step: absolute coordinates are fine;");
    expect(wiring).toContain('{"groups":{"wiring":{"origin_mil":[0,0]}},"ops":[...],"refdes_used":[]}');
  });
});

// ---------------------------------------------------------------------------
// Provider exhaustion: a stop-class hard stop pauses the plan, it is never a skip
// ---------------------------------------------------------------------------

/** Three draft steps whose blocks are told apart by their summary (the Drafter brief carries it). */
function threeStepPlan(): DesignPlan {
  const p = JSON.parse(JSON.stringify(draftPlan)) as DesignPlan;
  p.blocks = ["ONE", "TWO", "THREE"].map((n, i) => ({ ...p.blocks[0], id: `b${i + 1}`, summary: `BLOCK_${n}` }));
  p.floorplan["root.kicad_sch"] = p.blocks.map((b, i) => ({ group: b.id, origin_mil: [1000 + i * 2500, 1000] as [number, number], extent_mil: [2000, 1500] as [number, number] }));
  p.steps = p.blocks.map((b, i) => ({ id: `s${i + 1}`, block: b.id, kind: "draft" as const }));
  return p;
}

/** A provider that answers normally until the brief names `block`, then reports a rate limit forever. */
function providerOutOfQuotaOn(block: string): ReturnType<typeof fauxAssistantMessage>[] {
  const responder = (ctx: { messages: { content: unknown }[] }) => {
    const text = JSON.stringify(ctx.messages);
    return text.includes(block)
      ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "PROVIDER_RATE_LIMIT: 429 too many requests" })
      : fauxAssistantMessage(DRAFT_ANSWER);
  };
  return Array.from({ length: 40 }, () => responder) as unknown as ReturnType<typeof fauxAssistantMessage>[];
}

/** Which plan steps the harness actually started a turn for. */
const stepsRun = (lead: LeadLoop): string[] => lead.turns.map((t) => t.plan_step).filter((x): x is string => !!x);
const providerCards = (events: TurnEvent[]): Card[] => events.flatMap((e) => (e.kind === "card" && e.card.title === "hard_stop.provider_exhausted" ? [e.card] : []));

// ---------------------------------------------------------------------------
// The Drafter has to answer with the op-list a dry run accepted (F4). Run 14 dry-ran on one sheet and
// then answered with another; nothing noticed until sch.apply refused the whole step.
// ---------------------------------------------------------------------------

describe("drafter dry-run contract", () => {
  const listFor = (ref: string) => ({ groups: { ldo: { origin_mil: [1000, 1000] } }, ops: [{ op: "place_component", designator: ref, lib_id: "Device:R", group: "ldo", x_mil: 100, y_mil: 100 }], refdes_used: [ref], region_used: [[1000, 1000], [3000, 2500]] });
  const answer = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

  it("rejects a final op-list that no dry run accepted, and takes the matching retry", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
    faux.setResponses([
      // The Drafter dry-runs the R3 list (its digest comes back in the result) ...
      fauxAssistantMessage([fauxToolCall("sch.dryrun_scratch", { oplist: listFor("R3"), target: "root.kicad_sch" }, { id: "d1" })], { stopReason: "toolUse" }),
      // ... then answers with a different one, which is rejected ...
      fauxAssistantMessage(answer(listFor("R4"))),
      // ... and the single corrective round returns the list that actually passed.
      fauxAssistantMessage(answer(listFor("R3"))),
    ]);
    await runUntilIdle(lead, "/run");
    const dry = calls.filter((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "dryrun_scratch");
    expect(dry.length).toBe(1);
    // The applied op-list is the one that was dry-run, not the one the Drafter first answered with.
    const applied = calls.find((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "apply");
    expect(applied).toBeTruthy();
    const ops = (applied!.args as { request: { oplist: { ops: { designator?: string }[] } } }).request.oplist.ops;
    expect(ops.some((o) => o.designator === "R3")).toBe(true);
    expect(ops.some((o) => o.designator === "R4")).toBe(false);
  });

  it("a subagent that never dry-ran anything is not second-guessed", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
    faux.setResponses([fauxAssistantMessage(answer(listFor("R7")))]);
    await runUntilIdle(lead, "/run");
    const applied = calls.find((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "apply");
    const ops = (applied!.args as { request: { oplist: { ops: { designator?: string }[] } } }).request.oplist.ops;
    expect(ops.some((o) => o.designator === "R7")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A missing sheet file is a precondition, not a per-step surprise (F3). Runs 14 and 15 rediscovered the
// same absent file on every step: nine drafts, ~200k tokens, one `system.auto_step_skipped` each.
// ---------------------------------------------------------------------------

/** `threeStepPlan`, but every block draws on a sheet the project does not have. */
function missingSheetPlan(declared: boolean): DesignPlan {
  const p = threeStepPlan();
  for (const b of p.blocks) b.sheet = "power.kicad_sch";
  p.floorplan["power.kicad_sch"] = p.floorplan["root.kicad_sch"];
  if (declared) p.sheets = [...p.sheets, { file: "power.kicad_sch", role: "child", parent: "root.kicad_sch" }];
  return p;
}

describe("a step whose sheet file does not exist", () => {
  it("pauses the plan on the first step instead of skipping every step for the same reason", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "wait" }), ["root.kicad_sch"]);
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(missingSheetPlan(false), true);
    faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(DRAFT_ANSWER)));
    await runUntilIdle(lead, "/run");
    // One step attempted, not three; no Drafter was paid for a sheet that is not there.
    expect(stepsRun(lead)).toEqual(["s1"]);
    expect(drafterBriefs().length).toBe(0);
    expect(lead.planView()?.status).toBe("paused");
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.plan_paused")).toBe(true);
    expect(events.some((e) => e.kind === "card" && e.card.title === "system.plan_done")).toBe(false);
    // The pause is a card of its own, with the reason in it: a status line inside a running plan is easy
    // to miss, and Auto shows no other card at all.
    const paused = events.filter((e) => e.kind === "card" && e.card.title === "system.plan_paused");
    expect(paused.length).toBe(1);
    expect(JSON.stringify((paused[0] as { card: Card }).card.data)).toContain("power.kicad_sch");
  });

  // A draft step's own envelope carries no structural entry (only a scaffold step's does), and the ones
  // `runPlanStepTurn` adds are keyed on the app's cached sheet list: when that list already names the file
  // the engine summary reports missing, the repair used to run into P2 as a structural hard stop.
  it("creates the plan's sheet even when the step envelope carries no structural entry for it", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "wait" }), ["root.kicad_sch", "power.kicad_sch"]);
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(missingSheetPlan(true), true);
    faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(DRAFT_ANSWER)));
    await runUntilIdle(lead, "/run");
    const created = calls.filter((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request.kind === "sheet_create");
    expect(created.length).toBeGreaterThan(0);
    expect((created[0].args as { request: { file: string } }).request.file).toBe("power.kicad_sch");
    // Not a structural hard stop, and the widening does not outlive the repair.
    expect(events.some((e) => e.kind === "card" && e.card.title === "hard_stop.structural")).toBe(false);
  });

  it("creates the sheet first when the plan declares it", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "wait" }), ["root.kicad_sch"]);
    state.summarySheets = [{ path: "/", file: "root.kicad_sch" }];
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(missingSheetPlan(true), true);
    faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(DRAFT_ANSWER)));
    await runUntilIdle(lead, "/run");
    const created = calls.filter((c) => c.name === "engine_request" && (c.args as { request: { kind: string; file?: string } }).request.kind === "sheet_create");
    expect(created.length).toBeGreaterThan(0);
    expect((created[0].args as { request: { file: string } }).request.file).toBe("power.kicad_sch");
  });
});

describe("provider exhaustion under Auto", () => {
  it("pauses the plan at the failing step: no skip, no next step, no plan_done", async () => {
    const events: TurnEvent[] = [];
    const seen: Card[] = [];
    const lead = makeLead(events, (c) => { seen.push(c); return { action_id: "wait" }; });
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(threeStepPlan(), true);
    faux.setResponses(providerOutOfQuotaOn("BLOCK_TWO"));
    await runUntilIdle(lead, "/run");

    // Step 2 failed on the provider; step 3 was never attempted (it would fail and be skipped too).
    expect(stepsRun(lead)).toEqual(["s1", "s2"]);
    expect(drafterBriefs().some((b) => b.includes("BLOCK_THREE"))).toBe(false);
    // The plan is paused at s2, which stays open: it is not "skipped" and the plan is not "done".
    expect(lead.planView()?.status).toBe("paused");
    expect(lead.planView()?.steps.find((x) => x.id === "s2")?.status).not.toBe("skipped");
    expect(events.some((e) => e.kind === "card" && e.card.title === "system.plan_done")).toBe(false);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.plan_paused")).toBe(true);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.auto_step_skipped")).toBe(false);
    // The card is the provider one (ui-states.md §A(P)), with its four actions and no approval.
    const card = providerCards(events)[0];
    expect(card).toBeTruthy();
    expect(card.actions.map((a) => a.id)).toEqual(["retry_now", "wait", "switch_provider", "abandon"]);
    expect(card.actions.some((a) => a.consent)).toBe(false);
    expect(seen.filter((c) => c.title === "hard_stop.provider_exhausted").length).toBe(1);
  });

  it("retry now resumes at the same step instead of moving on", async () => {
    const events: TurnEvent[] = [];
    let answers = 0;
    const lead = makeLead(events, () => ({ action_id: answers++ === 0 ? "retry_now" : "wait" }));
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(threeStepPlan(), true);
    faux.setResponses(providerOutOfQuotaOn("BLOCK_TWO"));
    await runUntilIdle(lead, "/run");
    // s2 was tried twice (the retry), s3 still never started, and the plan still is not done.
    expect(stepsRun(lead)).toEqual(["s1", "s2", "s2"]);
    expect(providerCards(events).length).toBe(2);
    expect(lead.planView()?.status).toBe("paused");
    expect(events.some((e) => e.kind === "card" && e.card.title === "system.plan_done")).toBe(false);
  });

  it("abandon on the card stops the run without skipping the step", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "abandon" }));
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(threeStepPlan(), true);
    faux.setResponses(providerOutOfQuotaOn("BLOCK_TWO"));
    await runUntilIdle(lead, "/run");
    expect(stepsRun(lead)).toEqual(["s1", "s2"]);
    expect(lead.planView()?.steps.find((x) => x.id === "s2")?.status).not.toBe("skipped");
    expect(events.some((e) => e.kind === "card" && e.card.title === "system.plan_done")).toBe(false);
  });

  it("under Review the same failure blocks on the card and leaves the plan where it was", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events, () => ({ action_id: "wait" }));
    lead.setMode("build", "bs-1");
    lead.adoptPlan(threeStepPlan(), true); // policy stays Review (the default)
    faux.setResponses(providerOutOfQuotaOn("BLOCK_TWO"));
    await runUntilIdle(lead, "/run");
    expect(providerCards(events).length).toBe(1);
    expect(stepsRun(lead)).toEqual(["s1", "s2"]);
    expect(lead.planView()?.status).toBe("paused");
    expect(events.some((e) => e.kind === "card" && e.card.title === "system.plan_done")).toBe(false);
    // Review never turns a failed step into a "step failed" retry/skip card when the provider is the reason.
    expect(events.some((e) => e.kind === "card" && e.card.title === "system.step_failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "Make reasonable assumptions and do not ask me questions" (real run 17, turn 1: the card came up
// anyway). The prompt says it and the hook enforces it, so the card never reaches the human.
// ---------------------------------------------------------------------------

describe("a Plan turn where the user said not to ask", () => {
  it("denies the ask_user card and tells the model to record assumptions instead", async () => {
    const events: TurnEvent[] = [];
    const shown: Card[] = [];
    const lead = makeLead(events, (c) => { shown.push(c); return { action_id: "default" }; });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "plan a 3.3 V supply" }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("ask_user", { question: "which connector?", options: ["USB-C", "micro-B"], default: "USB-C" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Assuming USB-C; the plan is written."),
      fauxAssistantMessage("Assuming USB-C; the plan is written."),
    ]);
    await runUntilIdle(lead, "Design a 3.3 V supply. Make reasonable assumptions and do not ask me questions.");
    // No question card was ever put to the human.
    expect(shown.filter((c) => c.kind === "question")).toEqual([]);
    expect(events.some((e) => e.kind === "card" && e.card.kind === "question")).toBe(false);
    const asked = lead.turns[0].tools.filter((x) => x.name === "ask_user");
    expect(asked.length).toBe(1);
    expect(asked[0].ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The stylist pass beyond the draft step, and what it cannot resolve. Real run 18: the wiring step
// raised six POWER_PORT_ORIENTATION findings and the gate step still reported the same six, because
// only draft steps were ever tidied and the rotation the engine asked for was never emitted.
// ---------------------------------------------------------------------------

/** Every op-list the engine was asked to apply, with the note it carried. */
function appliedOplists(): { note: string; ops: { op?: string }[] }[] {
  return calls
    .filter((c) => c.name === "engine_request" && (c.args as { request: { kind: string } }).request?.kind === "apply")
    .map((c) => {
      const req = (c.args as { request: { note?: string; oplist?: { ops?: { op?: string }[] } } }).request;
      return { note: String(req.note ?? ""), ops: req.oplist?.ops ?? [] };
    });
}

const UPSIDE_DOWN_PORT = {
  code: "POWER_PORT_ORIENTATION", severity: "Warning", message: "#PWR03 (GND) points up instead of down",
  remediation: "GND ports point down: set_component_transform {uuid, rotation} or re-place with place_gnd (the engine orients it from the pin)",
  location: "style:power:33333333-3333-4333-8333-333333333333", at_mil: [1500, 1400],
};

/** A plan whose only step wires the blocks up: any stylist apply in the run came from that step. */
function wiringOnlyPlan(): DesignPlan {
  const p = JSON.parse(JSON.stringify(draftPlan)) as DesignPlan;
  p.steps = [{ id: "w1", kind: "wiring" }];
  return p;
}

const WIRING_ANSWER = `\`\`\`json\n${JSON.stringify({ groups: { wiring: { origin_mil: [0, 0] } }, ops: [{ op: "add_net_label", name: "VBUS", at: "R3.1" }], refdes_used: [] })}\n\`\`\``;

describe("stylist pass beyond the draft step", () => {
  it("a wiring step is tidied too: the power port the engine reported is rotated by uuid", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(wiringOnlyPlan(), true);
    state.styleFindings.push(UPSIDE_DOWN_PORT);
    faux.setResponses([fauxAssistantMessage(WIRING_ANSWER), fauxAssistantMessage(WIRING_ANSWER), fauxAssistantMessage(WIRING_ANSWER)]);
    await runUntilIdle(lead, "/run");
    expect(stepsRun(lead)).toEqual(["w1"]);
    const tidy = appliedOplists().filter((a) => a.note === "stylist");
    // A rotation is idempotent: repeating it would be a replay, so one round is all it gets.
    expect(tidy.length).toBe(1);
    // The engine's remediation names no angle; upright (0) is the only orientation it can be asking for.
    expect(tidy[0].ops).toEqual([{ op: "set_component_transform", uuid: "33333333-3333-4333-8333-333333333333", rotation: 0 }]);
    // A finding the tidy-up does not clear is exactly the case that used to ship in silence.
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.layout_unresolved")).toBe(true);
  });

  it("a text collision the stylist cannot clear costs three move attempts and is then reported, not hidden", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(wiringOnlyPlan(), true);
    state.styleFindings.push({ code: "TEXT_OVERLAP", severity: "Warning", message: "R3 Value over C2", location: "text:R3:C2", at_mil: [1500, 1400] });
    faux.setResponses([fauxAssistantMessage(WIRING_ANSWER), fauxAssistantMessage(WIRING_ANSWER), fauxAssistantMessage(WIRING_ANSWER)]);
    await runUntilIdle(lead, "/run");
    const tidy = appliedOplists().filter((a) => a.note === "stylist");
    // Three attempts, each laid out wider: a repeat of the same pitch would not be another attempt.
    expect(tidy.length).toBe(3);
    expect(tidy.map((a) => (a.ops[0] as { pitch_mil?: number }).pitch_mil)).toEqual([undefined, 700, 800]);
    const line = events.find((e) => e.kind === "system" && e.text_key === "system.layout_unresolved");
    expect(line).toBeTruthy();
    expect(JSON.stringify(line)).toContain("TEXT_OVERLAP");
  });
});

// ---------------------------------------------------------------------------
// A draft step that applied nothing is never "done" (run 17, turn 3), whichever way it got there.
// ---------------------------------------------------------------------------

const EMPTY_DRAFT = `\`\`\`json\n${JSON.stringify({ groups: { ldo: { origin_mil: [1000, 1000] } }, ops: [], refdes_used: [] })}\n\`\`\``;

describe("a draft step that wrote nothing", () => {
  it("the drafter returned no ops at all: retried once, then failed, never done", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
    faux.setResponses([fauxAssistantMessage(EMPTY_DRAFT), fauxAssistantMessage(EMPTY_DRAFT), fauxAssistantMessage(EMPTY_DRAFT)]);
    await runUntilIdle(lead, "/run");
    // The empty answer is worth exactly one escalated retry, and nothing was written.
    expect(drafterBriefs().length).toBe(2);
    expect(state.applied).toBe(0);
    expect(lead.turns[0].applies).toEqual([]);
    expect(lead.turns[0].status).toBe("failed");
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.step_wrote_nothing")).toBe(true);
  });

  it("the step was skipped because the drafter never delivered: the turn still says it wrote nothing", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    lead.setMode("build", "bs-1");
    lead.setPolicy("auto");
    lead.adoptPlan(JSON.parse(JSON.stringify(draftPlan)) as DesignPlan, true);
    // No JSON fence: the dispatch fails, is retried once, and the step is adjudicated as a skip.
    faux.setResponses([fauxAssistantMessage("I could not draw this block."), fauxAssistantMessage("Still not able to."), fauxAssistantMessage("no.")]);
    await runUntilIdle(lead, "/run");
    expect(state.applied).toBe(0);
    expect(lead.turns[0].applies).toEqual([]);
    expect(lead.turns[0].auto_decisions.some((d) => d.action === "skipped" || d.action === "reverted_and_skipped")).toBe(true);
    // A skipped step with no applies is a failed turn, whatever the plan does next.
    expect(lead.turns[0].status).toBe("failed");
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.step_wrote_nothing")).toBe(true);
  });
});

// Replays of the two hard_stop.scope_widen cards the 2026-09-06 golden run raised (ldo_3v3,
// power_subsheet). Both requests were inside the session ceiling; only the model's own turn.begin was
// narrower than it. Red line 13 puts the human's decision in that ceiling, so neither may reach a card.
describe("a turn that under-declared its own scope", () => {
  it("golden ldo_3v3: an op the ceiling allows and the declaration omitted is a tool error, not a card", async () => {
    const events: TurnEvent[] = [];
    const cards: Card[] = [];
    const lead = makeLead(events, (c) => { cards.push(c); return { action_id: "approve", grant: "g-1" }; });
    lead.setMode("build", "bs-1");
    const declared = (ops: string[]) => ({ kind: "instruction", headline: "Add 3.3 V AMS1117 regulator stage", envelope: { sheets: ["root.kicad_sch"], allowed_ops: ops, components_added_max: 3, components_deleted_max: 0, structural: [], nets_renamable: [] } });
    const oplist = { groups: { ldo: { origin_mil: [4000, 3000] } }, ops: [
      { op: "place_component", lib_id: "Regulator_Linear:AMS1117-3.3", designator: "U1", group: "ldo", x_mil: 0, y_mil: 0 },
      { op: "route_net", net: "+3V3", from: "U1.3", to: "C2.1", group: "ldo" },
    ], refdes_used: ["U1"] };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", declared(["place_component", "place_power_port", "place_gnd", "add_wire"]), { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { target: "root.kicad_sch", oplist, note: "ldo" }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("turn.begin", declared(["place_component", "place_power_port", "place_gnd", "add_wire", "route_net"]), { id: "t3" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sch.apply", { target: "root.kicad_sch", oplist, note: "ldo" }, { id: "t4" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Added the regulator stage."),
    ]);
    await runUntilIdle(lead, "Add an AMS1117-3.3 linear regulator from VDC to +3V3 with a 10u input capacitor.");
    // No approval card: the session ceiling leaves allowed_ops unrestricted, so route_net was already the
    // human's to allow. The model is told what its own declaration is missing and re-declares.
    expect(cards.filter((c) => c.kind === "hard_stop")).toEqual([]);
    expect(events.some((e) => e.kind === "system" && e.text_key === "system.turn_scope_narrow")).toBe(true);
    expect(state.applied).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c.name === "turn_begin").length).toBe(2);
    expect(lead.turns[0].status).not.toBe("hard_stopped");
  });

  it("golden power_subsheet: a bare create_sheet is satisfied by the file-qualified ceiling entry", async () => {
    const events: TurnEvent[] = [];
    const cards: Card[] = [];
    const lead = makeLead(events, (c) => { cards.push(c); return { action_id: "approve", grant: "g-1" }; });
    lead.setMode("build", "bs-1");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "Create power hierarchical sub-sheet with VIN and VOUT pins", envelope: { sheets: ["root.kicad_sch", "power.kicad_sch"], allowed_ops: ["add_sheet", "add_sheet_pin"], components_added_max: 0, components_deleted_max: 0, structural: ["create_sheet"], nets_renamable: [] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("sheet.create", { file: "power.kicad_sch", name: "power", parent: "root.kicad_sch", at_mil: [2000, 2000], size_mil: [2000, 1500], pins: [{ name: "VIN", side: "left", type: "input" }, { name: "VOUT", side: "right", type: "output" }] }, { id: "t2" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Created hierarchical sheet power.kicad_sch."),
    ]);
    await runUntilIdle(lead, "Create a hierarchical sub-sheet named power (file power.kicad_sch) with an input pin VIN and an output pin VOUT.");
    expect(cards.filter((c) => c.kind === "hard_stop")).toEqual([]);
    // The declaration is rewritten into the ceiling's own spelling, so nothing reads as a widening and the
    // turn is declared once (the second turn_begin in the golden journal was the approval redeclare).
    const started = events.find((e) => e.kind === "turn_started") as { envelope?: { structural: string[] } } | undefined;
    expect(started?.envelope?.structural).toContain("create_sheet:power.kicad_sch");
    expect(started?.envelope?.structural).not.toContain("create_sheet");
    expect(calls.filter((c) => c.name === "turn_begin").length).toBe(1);
  });

  // P1-4: the nets list qualifies a local label by its sheet instance (`/power/NET_X`) while the
  // envelope entry is the label text Rust compares `rename_net.old_name` against. The filter used to
  // keep only root spellings, so a declared rename of a child-sheet label was emptied and the apply
  // hard-stopped with ENVELOPE_RENAME. Names that exist nowhere are still dropped (not a widening).
  it("turn.begin keeps a renamable local label that lives on a child sheet", async () => {
    const events: TurnEvent[] = [];
    const cards: Card[] = [];
    // No approved plan: the session ceiling renames nothing, so the declaration is a scope widening the
    // human approves; the redeclared envelope is the filtered declaration.
    const lead = makeLead(events, (c) => { cards.push(c); return { action_id: "approve", grant: "g-1" }; }, ["root.kicad_sch", "power.kicad_sch"]);
    lead.setMode("build", "bs-1");
    state.netList = [{ name: "/power/NET_X", members: 3 }, { name: "/MIDROOT", members: 2 }, { name: "GND", members: 4 }];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "instruction", headline: "rename NET_X on the power sheet", envelope: { sheets: ["power.kicad_sch"], allowed_ops: ["rename_net"], components_added_max: 0, components_deleted_max: 0, structural: [], nets_renamable: ["NET_X", "MIDROOT", "GND", "GHOST"] } }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await runUntilIdle(lead, "rename NET_X on the power sheet to VSENSE");
    const scope = cards.find((c) => c.kind === "hard_stop" && c.title === "hard_stop.scope_widen");
    const asked = ((scope?.data as { system?: { widened?: { field: string; requested: string }[] } } | undefined)?.system?.widened ?? []).find((w) => w.field === "nets_renamable")?.requested ?? "";
    expect(asked).toBe("NET_X, MIDROOT, GND");
    const begins = calls.filter((c) => c.name === "turn_begin") as { args: { begin: { envelope: { nets_renamable: string[] } } } }[];
    const renamable = begins.at(-1)?.args.begin.envelope.nets_renamable ?? [];
    expect(renamable).toEqual(["NET_X", "MIDROOT", "GND"]);
  });
});

describe("external events between turns (agent-runtime.md §4.2)", () => {
  it("an external change while idle puts one byte-stable marker in front of the next turn's message", async () => {
    const events: TurnEvent[] = [];
    const lead = makeLead(events);
    // Two watcher events before any turn: folded into one marker, files sorted, no timestamp.
    lead.externalEvent("changed", { files: ["root.kicad_sch"] });
    lead.externalEvent("changed", { files: ["pwr.kicad_sch", "root.kicad_sch"] });
    const isExternalMarker = (m: (typeof lead.history)[number]) => m.meta.kind === "marker" && m.content.some((c) => c.type === "text" && c.text.includes("changed outside fluxsmith"));
    expect(lead.history.filter(isExternalMarker)).toEqual([]);
    const responses = () => [
      fauxAssistantMessage([fauxToolCall("turn.begin", { kind: "question", headline: "q" }, { id: "t1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ];
    faux.setResponses(responses());
    await runUntilIdle(lead, "what changed?");
    const markers = lead.history.filter(isExternalMarker);
    expect(markers).toHaveLength(1);
    const text = markers[0].content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toBe(LeadLoop.externalMarker(["pwr.kicad_sch", "root.kicad_sch"], 0));
    expect(text).toMatch(/^<system>.*<\/system>$/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Ahead of the user message of the turn it opens.
    const idxUser = lead.history.findIndex((m) => m.meta.kind === "user" && m.meta.turn === 1);
    expect(idxUser).toBeGreaterThan(-1);
    expect(lead.history.indexOf(markers[0])).toBeLessThan(idxUser);
    expect(markers[0].meta.turn).toBe(1);
    // The next turn does not repeat it.
    faux.setResponses(responses());
    await runUntilIdle(lead, "and now?");
    expect(lead.history.filter(isExternalMarker)).toHaveLength(1);
  });

  it("a lock release clears the P7 flag the lock had set on the running turn", () => {
    const lead = makeLead([]);
    const st = newTurnPolicyState(1, "build", "review", "lead", "bs-1");
    (lead as unknown as { policyState: unknown }).policyState = st;
    const apply = { id: "c1", name: "sch.apply", args: {}, role: "lead" as const, index: 0, siblings: [{ name: "sch.apply" }] };
    lead.externalEvent("locked");
    expect(p7(st, apply).kind).toBe("deny");
    lead.externalEvent("unlocked");
    expect(st.external.locked).toBe(false);
    expect(p7(st, apply).kind).toBe("allow");
  });
});
