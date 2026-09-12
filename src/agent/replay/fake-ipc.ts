// SPDX-License-Identifier: Apache-2.0
// Fake IPC for harness tests and L5 replay. Mirrors the `vi.mock("../../ipc/client")`
// pattern of lead.test.ts as a reusable module: a default in-memory engine
// (summary / plan / apply / gate_run …) that a test can override per command,
// plus an optional Recording that (a) records every call in record mode and
// (b) serves recorded results first in replay mode, falling back to the
// default fake when the recording has none.
//
// Usage in a test file (the factory must stay inside vi.mock):
//   vi.mock("../../ipc/client", async () => (await import("../replay/fake-ipc")).fakeIpcModule());
//   import { fakeIpc } from "../replay/fake-ipc";
//   fakeIpc.reset({ engine: { read: () => ({ text: "…" }) } });

import { activeRecorder, argsHash, Recording } from "./recorder";

export interface IpcErrorShape { code: string; message: string; req_id: string }

export class FakeIpcFailure extends Error {
  constructor(public error: IpcErrorShape) { super(error.message); }
}

export interface FakeState { applied: number; checkpoints: number; turn: number }
export interface FakeCall { name: string; args: unknown }

export type EngineHandler = (req: Record<string, unknown>, auth: { build_session?: string | null; grant?: string | null }, state: FakeState) => unknown;

export interface FakeIpcOptions {
  /** Per-command overrides; return `undefined` to fall through to the default. */
  commands?: Record<string, (args: Record<string, unknown>, state: FakeState) => unknown>;
  /** Per engine request kind overrides (`read`, `apply`, …); return `undefined` to fall through. */
  engine?: Record<string, EngineHandler>;
  /** Settings object returned by `settings_get`. */
  settings?: unknown;
  /** Replay/record source. When absent, the process-wide active recorder is used (if any). */
  recording?: Recording | null;
}

export const FAKE_SETTINGS = {
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

const okMeta = { bytes: 0, truncated: false, elapsed_ms: 1, trust: "untrusted" };
const ok = (data: unknown) => ({ ok: true, data, meta: okMeta });
const fail = (code: string, message: string) => ({ ok: false, data: null, error: { code, message, req_id: "" }, meta: okMeta });

function defaultEngine(req: Record<string, unknown>, auth: { build_session?: string | null }, state: FakeState): unknown {
  switch (req.kind) {
    case "summary": return ok({ counts: { symbols: 2 }, refdes: { R: { used: [[1, 2]], next: 3 } }, rails: ["GND"], sheets: 1 });
    case "resolve": return ok({ resolved: [] });
    case "ops_validate": return ok({ ok: true, errors: [] });
    case "plan": return ok({ applied: false, integrity: [], net_diff: { changes: [] }, nets_after: [] });
    case "apply":
      if (!auth.build_session) return fail("BUILD_SESSION_REQUIRED", "no session");
      state.applied += 1;
      return ok({ applied: true, run_id: `run-${state.applied}`, counts: { added: 1, deleted: 0, wires: 0 }, net_diff: { changes: [] }, targets: [{ path: "root.kicad_sch", sha_before: "sha-before", sha_after: `sha-after-${state.applied}`, created: false }] });
    case "check": case "gate_run": return ok({ ok: true, families: [], findings: [] });
    case "component": return ok({ ref: "R1", units: [{ file: "root.kicad_sch" }] });
    case "read": return ok({ sheet: "root.kicad_sch", symbols: [], labels: [], text: "" });
    default: return ok({});
  }
}

class FakeIpc {
  calls: FakeCall[] = [];
  state: FakeState = { applied: 0, checkpoints: 0, turn: 0 };
  private opts: FakeIpcOptions = {};

  reset(opts: FakeIpcOptions = {}): void {
    this.calls = [];
    this.state = { applied: 0, checkpoints: 0, turn: 0 };
    this.opts = opts;
  }

  private recording(): { mode: "record" | "replay"; recording: Recording } | null {
    if (this.opts.recording) return { mode: activeRecorder()?.mode ?? "replay", recording: this.opts.recording };
    return activeRecorder();
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, args });
    const rec = this.recording();
    const hash = rec ? argsHash(args) : "";
    if (rec?.mode === "replay") {
      const e = rec.recording.nextIpc(name, hash);
      if (e) { if (e.error) throw new FakeIpcFailure(e.error); return e.result; }
    }
    let result: unknown;
    try {
      result = await this.serve(name, args);
    } catch (e) {
      if (rec?.mode === "record" && e instanceof FakeIpcFailure) rec.recording.recordIpc({ name, args_hash: hash, result: null, error: e.error });
      throw e;
    }
    if (rec?.mode === "record") rec.recording.recordIpc({ name, args_hash: hash, result, error: null });
    return result;
  }

  private async serve(name: string, args: Record<string, unknown>): Promise<unknown> {
    const over = this.opts.commands?.[name];
    if (over) { const r = over(args, this.state); if (r !== undefined) return r; }
    switch (name) {
      case "settings_get": return this.opts.settings ?? FAKE_SETTINGS;
      case "project_info": return { key: "pk", root: "/p", root_sheet: "root.kicad_sch", root_uuid: "u", name: "p", version: 20260306, sheets: [{ file: "root.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }], config: {}, git: null, last_turn: 0, last_mode: "plan", policy_override: null, locked: false };
      case "skills_list": return [];
      case "sidecar_read": return null;
      case "sidecar_write": return null;
      case "db_query": return (args.query as { kind: string }).kind === "message_list" ? [] : null;
      case "turn_begin": {
        this.state.turn += 1;
        const b = args.begin as { envelope: unknown };
        return { turn: this.state.turn, effective_envelope: b.envelope ?? { sheets: ["root.kicad_sch"], allowed_ops: [], components_added_max: 24, components_deleted_max: 0, wires_max: null, structural: [], nets_renamable: [], rails: [], interfaces: [], instance_designators: {}, source: "session_ceiling" }, ceiling_source: "session_ceiling", checkpoint_pending: true };
      }
      case "checkpoint_create": this.state.checkpoints += 1; return { project_key: "pk", turn: this.state.turn, manifest_sha256: "m", bytes: 1, created: "", kind: "turn", pruned: false, verified: true };
      case "build_session_open": return { token: "bs-1", project_key: "pk", plan_ref: "incremental", policy: "review", ceiling: {}, opened_at: "", idle_timeout_min: 15, absolute_timeout_h: 8 };
      case "build_session_close": return null;
      case "grant_create": return { id: "grant-1", kind: (args.request as { kind: string }).kind, expires_at: "" };
      case "engine_request": {
        const req = (args as { request: Record<string, unknown> }).request;
        const auth = (args as { auth: { build_session?: string | null; grant?: string | null } }).auth ?? {};
        const h = this.opts.engine?.[String(req.kind)];
        if (h) { const r = h(req, auth, this.state); if (r !== undefined) return r; }
        return defaultEngine(req, auth, this.state);
      }
      default: return null;
    }
  }
}

export const fakeIpc = new FakeIpc();

/** The module shape `vi.mock("../../ipc/client", …)` needs. */
export function fakeIpcModule(): Record<string, unknown> {
  return {
    call: (name: string, args: Record<string, unknown>) => fakeIpc.call(name, args),
    netFetch: async () => undefined,
    onAppEvent: async () => () => undefined,
    isTauri: () => false,
    installErrorLogging: () => undefined,
    setIpcTap: () => undefined,
    IpcFailure: FakeIpcFailure,
  };
}
