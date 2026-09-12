// SPDX-License-Identifier: Apache-2.0
// Typed IPC contract — mirror of `src-tauri/src/ipc.rs`. Keep both in sync;
// `tests/ipc-contract.test.ts` asserts the enum tag sets match.

export const IPC_VERSION = 1;

export interface IpcError {
  code: string;
  message: string;
  remediation?: string;
  evidence?: unknown;
  req_id: string;
}

// ---------------------------------------------------------------- environment
export interface EnvProblem { code: string; message: string; remediation: string; fatal: boolean }
export interface EnvReport {
  /** `degraded` = reads fine, cannot write (KiCad 9 with resolvable libraries): Review and Q&A stay, Plan and Build are stopped. */
  status: "ok" | "degraded" | "incomplete";
  kicad_app_path: string | null;
  kicad_cli_path: string | null;
  kicad_version: string | null;
  symbol_dir: string | null;
  symbol_lib_count: number;
  sym_lib_table: string | null;
  keyring_available: boolean;
  problems: EnvProblem[];
  checked_at: string;
}

// ------------------------------------------------------------------- settings
export type ProviderKind = "anthropic" | "openai" | "google" | "openrouter" | "xai" | "groq" | "mistral" | "openai-codex" | "custom";
export type BuildCapable = "full" | "degraded" | "none" | "manual" | "unknown";
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  base_url: string;
  enabled: boolean;
  rates: [number, number, number, number];
  context_window: number;
  build_capable: BuildCapable;
  vision: boolean;
  cache_reporting: boolean;
  raw_base64_images: boolean;
  models: string[];
  probed_at: string | null;
  has_secret: boolean;
}
export interface KicadSettings { app_path: string | null; cli_path: string | null; symbol_dir_override: string | null; target_version: number }
export interface BudgetDefaults {
  plan_tokens: number | null; plan_usd: number | null; plan_tool_calls: number | null; plan_wall_min: number | null;
  turn_tool_calls: number | null; turn_wall_min: number | null; warn_pct: number;
}
export type Policy = "ask" | "review" | "auto";
export interface AgentSettings {
  default_policy: Policy;
  continuous_run: boolean;
  session_ceiling_components_added: number;
  budget_defaults: BudgetDefaults;
  canvas_follow: boolean;
  canvas_grid: boolean;
  /** Keep the last turn's changes highlighted on the canvas until the next turn starts. */
  canvas_changes: boolean;
  /** `canvas.drag_selects`: left-drag on empty canvas rubber-bands (eeschema reflex) instead of panning. */
  canvas_drag_selects: boolean;
  chat_attach_selection: boolean;
  intake_defaults: Record<string, string>;
  chat_density: "compact" | "detailed" | "developer";
  /** Reasoning effort for the lead model: off | minimal | low | medium | high. */
  thinking_level: string;
  /** Master switch for budgets; when false no limits, warnings or budget stops apply. */
  budget_enabled: boolean;
}
export interface ContextSettings { hint_pct: number; auto_pct: number; emergency_pct: number; keep_recent_tasks: number; reserve_output_tokens: number }
export interface StorageSettings { checkpoint_turns: number; checkpoint_mb: number; external_cache_mb: number; datasheets_copy_to_project_default: boolean }
export interface PrivacySettings { log_level: "info" | "debug" }
/** Parts sourcing (JLCPCB/LCSC/EasyEDA network access); `enabled` needs a consent event. */
export interface PartsSettings { enabled: boolean; lib_nickname: string; with_3d: boolean }
export interface AdvancedSettings {
  step_throttle: boolean; images_size: "standard" | "large"; tool_parallel_max: number; drafter_concurrency: number;
  provider_conn_max: number; sandbox_enabled: boolean; router_path: string | null;
  /** Local release folder (`releases/v<ver>/`) read by the update check; null = unset. */
  release_dir?: string | null;
}
export type Language = "auto" | "zh-Hant" | "zh-Hans" | "en" | "ja";
export interface Settings {
  schema_version: number;
  language: Language;
  theme: "system" | "light" | "dark";
  restore_tabs_on_launch: boolean;
  notifications: boolean;
  shortcuts: Record<string, string>;
  kicad: KicadSettings;
  providers: ProviderConfig[];
  models_by_role: Record<string, string>;
  rates_as_of: string | null;
  /** App version whose first-run disclosure (bytes-affecting changes) was shown. */
  disclosed_version?: string | null;
  agent: AgentSettings;
  context: ContextSettings;
  storage: StorageSettings;
  privacy: PrivacySettings;
  advanced: AdvancedSettings;
  parts: PartsSettings;
  [unknown: string]: unknown;
}

export interface PartsSearchRow { lcsc: string; mpn: string; package: string; description: string; stock: number; price_usd: number | null; basic: boolean; preferred: boolean; cached?: boolean }
export interface PartsSearchResult { query: string; results: PartsSearchRow[]; source: string; cached?: boolean; claim: true; note: string }

// ------------------------------------------------------------------- projects
export interface SheetInfo { file: string; instance_path: string; names: string[]; paper: string; symbols: number }
export interface GitState { dirty: boolean; head: string | null }
export interface ProjectInfo {
  key: string; root: string; root_sheet: string; root_uuid: string; name: string; version: number;
  sheets: SheetInfo[]; config: unknown; git: GitState | null; last_turn: number; last_mode: string;
  policy_override: Policy | null; locked: boolean;
  /** Project root is inside a cloud-sync folder (iCloud / OneDrive / Dropbox / Google Drive). */
  cloud_synced?: boolean;
  /** Standalone `.kicad_sch` with no `.kicad_pro` (D-57): read-only + Q&A until a project shell is created. */
  no_pro?: boolean;
  /** Startup crash-recovery scan (docs/crash-recovery.md); absent when nothing was found. */
  recovery?: RecoveryReport | null;
}
export interface RecoveryCleaned { kind: "temp_file" | "bak_pending" | "stage" | "preview" | "run_backup" | string; path: string }
export interface RecoveryFile { path: string; expected_sha: string | null; actual_sha: string | null; matches: boolean }
export interface RecoveryStep { turn: number; step: string; ledger_phase: string; verdict: "orphan_cleaned" | "done_confirmed" | "needs_review" | "failed" | "done" | string; files: RecoveryFile[] }
/** A recovery-scan note as a code plus parameters (Rust `RecoveryNote`); the copy lives in the four catalogues (`recovery.note.<code>`). */
export type RecoveryNote = { code: "rollback_interrupted"; before_turn: number } | { code: "step_needs_review" } | { code: string };
export interface RecoveryReport { scanned_at: string; turn: number | null; phase_at_interrupt: string | null; cleaned: RecoveryCleaned[]; steps: RecoveryStep[]; pending_card: PendingCardFile | null; notes: RecoveryNote[] }
/** `turns/<n>/artifacts/pending_card.json` — the card a turn was waiting on when the process died. Never carries grant or consent ids. */
export interface PendingCardFile { turn: number; step: string; condition: string | null; grant_kind: string | null; card: unknown; oplist_sha256: string | null; written_at: string }
export interface RecentProject { key: string; path: string; name: string; last_opened: string; exists: boolean }
export interface NewProjectSpec { dir: string; name: string; paper: string; kicad_version: number }

// --------------------------------------------------------------------- engine
export interface ExpectedMergeSpec { into: string; sources_unnamed_only: boolean }
export interface WaiverRef { grant_id: string; reason: string }
export type EngineRequest =
  | { kind: "summary"; sheet?: string | null }
  // `all_sheets` lists every sheet instance's symbols instead of one sheet's (the sidebar's "all
  // sheets" list): rows carry `sheet` (file) and `instance_path`, and the per-instance reference.
  | { kind: "read"; sheet?: string | null; match?: string | null; limit?: number | null; all_sheets?: boolean | null }
  | { kind: "nets"; sheet?: string | null; match?: string | null; limit?: number | null }
  | { kind: "net"; name: string }
  | { kind: "component"; reference: string; unit?: number | null }
  | { kind: "pins"; lib_id: string; at_mil: [number, number]; rotation: number; mirror?: string | null; unit?: number | null }
  | { kind: "bbox"; refs?: string[] | null; region_mil?: [[number, number], [number, number]] | null }
  | { kind: "geom"; sheet: string }
  | { kind: "render"; sheet: string }
  | { kind: "net_map"; sheet: string }
  | { kind: "render_preview"; preview_id: string; sheet: string }
  | { kind: "bytes"; sheet: string }
  | { kind: "lib_search"; query?: string | null; lib_id?: string | null; category?: string | null; pins?: number | null; limit?: number | null }
  | { kind: "lib_resolve"; lib_id: string }
  | { kind: "lib_symbol"; lib_id: string }
  | { kind: "ops_list" }
  | { kind: "ops_template"; op: string; required_only?: boolean | null }
  | { kind: "ops_validate"; oplist: unknown }
  | { kind: "ops_expand"; oplist: unknown }
  | { kind: "dryrun_scratch"; oplist: unknown; target: string }
  | { kind: "plan"; oplist: unknown; target: string; flat?: boolean | null }
  | { kind: "apply"; oplist: unknown; target: string; expected_merges: ExpectedMergeSpec[]; note: string; waived?: WaiverRef | null; strict_layout?: boolean | null }
  | { kind: "check"; family: "integrity" | "erc" | "nets" | "pinmap" | "power" | "intent" | "layout" | "style" | "project"; sheet?: string | null }
  | { kind: "gate_run" }
  | { kind: "diff_nets"; before: string; after?: string | null }
  | { kind: "project_check" }
  | { kind: "bom" }
  | { kind: "intent_snapshot"; note: string }
  | { kind: "sheet_create"; file: string; name: string; at_mil: [number, number]; size_mil: [number, number]; pins: unknown[]; paper?: string | null; /** Sheet the symbol is drawn on (file, instance path or names path); the root sheet when absent. */ parent?: string | null }
  | { kind: "resolve"; refs: unknown[] }
  | { kind: "policy_waive"; code: string; refs?: string[] | null; severity?: string | null; reason: string; expires?: string | null }
  | { kind: "policy_read" }
  | { kind: "parts_convert"; source: unknown; lib_nickname: string; with_3d: boolean };

/** D-tier request kinds (write design truth). Must match Rust `is_d_tier`. */
export const D_TIER_KINDS: ReadonlySet<EngineRequest["kind"]> = new Set([
  "apply", "sheet_create", "intent_snapshot", "policy_waive", "parts_convert",
]);

export interface Auth { build_session?: string | null; grant?: string | null; role?: string | null }
export interface ResponseMeta {
  bytes: number; truncated: boolean; hint?: string; stamp?: string; ops_sha256?: string; run_id?: string; elapsed_ms: number; trust: "untrusted" | "engine";
}
export interface EngineResponse<T = unknown> { ok: boolean; data: T; error?: IpcError; meta: ResponseMeta }

// ------------------------------------------------------- build session / turns
export interface Envelope {
  sheets: string[]; allowed_ops: string[]; components_added_max: number; components_deleted_max: number; wires_max: number | null;
  structural: string[]; nets_renamable: string[];
  /** Bound on `set_component_parameters` / `set_component_attributes` ops, counted from the checkpoint (an edit turn is bounded too). */
  properties_changed_max: number;
  /** Bound on `move_component` / `set_component_transform` / `arrange_group` moves. */
  components_moved_max: number;
  /** Designators the human's own message named; non-empty confines edits and moves of existing parts to them. Empty: unrestricted. */
  refs_editable: string[];
  rails: string[]; interfaces: string[];
  instance_designators: Record<string, string[]>; source: string;
}
export interface BuildSessionOpen {
  project_key: string; plan_ref: string; plan_sha256: string | null; policy: Policy; consent_event_id: string; lead_model: string; tool_manifest_version: number;
}
export interface BuildSessionInfo {
  token: string; project_key: string; plan_ref: string; policy: Policy; ceiling: Envelope; opened_at: string; idle_timeout_min: number; absolute_timeout_h: number;
}
export type TurnKind = "question" | "instruction";
export type Mode = "plan" | "build" | "review";
export interface TurnBegin {
  project_key: string; build_session: string | null; kind: TurnKind; headline: string; plan_step: string | null;
  envelope: Envelope | null; inherit_from_turn: number | null; mode: Mode;
  /** Single-use `scope` grant that lets the declared envelope exceed the session ceiling. */
  grant?: string | null;
  /** Re-declaration of the already open turn (after a scope card): keeps the turn number. */
  redeclare?: boolean;
}
export interface TurnInfo { turn: number; effective_envelope: Envelope; ceiling_source: string; checkpoint_pending: boolean }
export interface TurnCounters {
  turn: number; components_added: number; components_deleted: number; wires_added: number; apply_count: number; tool_calls: number;
  billed_tokens: number; cost_usd: number; wall_active_ms: number;
}
export type GrantKind = "scope" | "structural" | "net_risk" | "unresolved" | "interface" | "rollback" | "waiver" | "intent" | "user_action" | "policy" | "lib_import" | "skill_draft" | "parts_convert";
export interface GrantRequest { project_key: string; kind: GrantKind; payload_sha256: string; consent_event_id: string; action?: unknown }
export interface GrantInfo { id: string; kind: GrantKind; expires_at: string }
export interface ConsentEvent { project_key: string; card_kind: string; payload_sha256: string; input_kind: "click" | "keyboard" | "auto" }

// ---------------------------------------------------------------- checkpoints
export interface CheckpointInfo {
  project_key: string; turn: number; manifest_sha256: string; bytes: number; created: string; kind: "turn" | "pre_rollback"; pruned: boolean; verified: boolean;
}
export interface RollbackRequest {
  project_key: string; before_turn: number; grant: string;
  /** `turn` (default) or the one-shot `pre_rollback` snapshot of what a rollback overwrote. */
  kind?: "turn" | "pre_rollback";
  /** From `rollback_preview`: the state the human confirmed. A project that changed since is `ROLLBACK_STALE`. */
  state_sha256?: string;
}
export interface RollbackResult {
  restored_files: string[];
  /** Files created after the checkpoint, moved into the snapshot (not deleted). */
  removed_files: string[];
  /** Null when this rollback restored (and consumed) such a snapshot. */
  pre_rollback_checkpoint: CheckpointInfo | null;
  now_turn: number;
}
export interface RollbackPreview {
  before_turn: number; kind: "turn" | "pre_rollback"; restore_files: string[]; remove_files: string[]; state_sha256: string;
}

// -------------------------------------------------------------------- sidecar
export type SidecarWrite =
  | { kind: "journal"; entry: unknown }
  | { kind: "turn"; turn: number; turn_json: unknown }
  | { kind: "ledger"; turn: number; step: string; phase: "intended" | "applied" | "done" | "failed" | "injected" | "denied"; payload: unknown }
  | { kind: "subagent"; turn: number; role: string; id: string; transcript: unknown }
  | { kind: "plan"; plan: unknown }
  | { kind: "notes"; text: string; anchor: unknown }
  | { kind: "facts"; mpn: string; facts: unknown }
  | { kind: "review"; turn: number; report: unknown }
  | { kind: "intent"; intent: unknown }
  | { kind: "bom_lock"; lock: unknown }
  | { kind: "project_config"; config: unknown }
  | { kind: "pending_card"; turn: number; card: PendingCardFile | null };

/**
 * One guarded `fluxsmith.toml` change (`rails`, `check`, `backup_depth`, and waiver removal), which
 * `sidecar_write` refuses. Only the settings tab sends these, behind a consent event.
 */
export type ProjectConfigEdit =
  | { op: "set"; key: "rails" | "check" | "backup_depth"; value: unknown }
  | { op: "waiver_revoke"; index: number; granted: string | null };

// ------------------------------------------------------------------------- db
export type DbQuery =
  | { kind: "session_create"; project_key: string; title?: string | null }
  | { kind: "session_list"; project_key: string }
  | { kind: "session_rename"; session_id: string; title: string }
  | { kind: "session_delete"; session_id: string }
  | { kind: "message_append"; session_id: string; turn: number; role: string; content: unknown }
  | { kind: "message_list"; session_id: string; after_id?: number | null; limit?: number | null }
  | { kind: "message_search"; project_key: string; query: string; limit?: number | null }
  | { kind: "messages_compact"; session_id: string; from_turn: number; to_turn: number; keep_turns: number[]; min_task: number; compaction: unknown }
  | { kind: "messages_export"; session_id: string }
  | { kind: "approval_upsert"; project_key: string; kind_: string; ref: string; sha256: string; consent_event_id: string }
  | { kind: "approval_list"; project_key?: string | null; kind_?: string | null }
  | { kind: "approval_revoke"; id: number }
  | { kind: "approval_check"; project_key?: string | null; kind_: string; ref: string; sha256: string }
  | { kind: "metric_append"; project_key: string; kind_: string; value: number; dims: unknown }
  | { kind: "metric_summary"; project_key?: string | null }
  | { kind: "model_call_append"; project_key: string; call: unknown }
  | { kind: "model_call_summary"; project_key: string; plan_id?: string | null }
  /** `model_calls` summed per (turn, role) — what a restored session replays as `usage` events. */
  | { kind: "model_call_by_turn"; project_key: string; from_turn?: number | null; to_turn?: number | null }
  | { kind: "model_call_export"; project_key: string }
  | { kind: "attachment_upsert"; project_key: string; sha256: string; kind_: string; label: string; bound_to?: string | null }
  | { kind: "attachment_list"; project_key: string }
  | { kind: "attachment_bind"; project_key: string; sha256: string; bound_to?: string | null }
  | { kind: "attachment_remove"; project_key: string; sha256: string }
  | { kind: "compaction_append"; project_key: string; session_id: string; level: number; from_turn: number; to_turn: number; reclaimed: number; block_sha256: string }
  | { kind: "compaction_list"; session_id: string }
  | { kind: "project_state"; project_key: string }
  | { kind: "project_state_set"; project_key: string; patch: unknown }
  | { kind: "project_forget"; project_key: string }
  | { kind: "orphan_projects" }
  | { kind: "storage" }
  | { kind: "storage_clear"; area: "checkpoints" | "external" | "assets" | "logs" | "parts" }
  | { kind: "crash_list" }
  | { kind: "lib_index_state" }
  | { kind: "parts_cache_list"; query?: string | null }
  | { kind: "parts_cache_forget"; lcsc: string };

/** One row of the shared parts library (`parts_cache`). */
export interface BomLine { refs: string[]; qty: number; value: string; footprint: string; lib_id: string; dnp: boolean; lcsc: string | null; mpn: string | null; package: string | null; stock: number | null; price_usd: number | null; basic: boolean | null; cached: boolean; substituted: string | null }
export interface BomReport { lines: BomLine[]; totals: { lines: number; parts: number; with_lcsc: number; without_lcsc: number }; findings: { code: string; severity: string; refs: string[]; message: string; origin: string }[]; lock_written: boolean; drift: { ref: string; kind: "added" | "removed" | "changed"; changes?: { field: string; from: string; to: string }[] }[] | null; claim: true; note: string }

export interface PartsCacheRow { lcsc: string; mpn: string; package: string; description: string; basic: boolean; stock: number; price_usd: number | null; fetched_at: string; last_used: string; has_cad: boolean; has_symbol: boolean; has_footprint: boolean; has_step: boolean; datasheet_sha: string | null; pins: number }

// -------------------------------------------------------------------- network
export interface NetRequest {
  id: string; method: string; url: string; headers: Record<string, string>; body: string | null; provider: string | null;
  timeout_ms: number | null; purpose: "provider" | "parts" | "web_fetch";
}
export type NetChunk =
  | { kind: "head"; status: number; headers: Record<string, string> }
  | { kind: "body"; data_base64: string }
  | { kind: "done"; bytes: number }
  | { kind: "error"; error: IpcError };
export interface DeviceCodeState {
  status: "pending" | "authorized" | "expired" | "denied" | "error" | "cancelled"; user_code: string | null; verification_url: string | null;
  expires_at: string | null; message: string | null;
}

// ---------------------------------------------------------------- attachments
export type AttachKind = "lib" | "pdf" | "doc" | "sch" | "image" | "netlist" | "bom" | "fragment" | "project_zip" | "unknown";
export interface IntakeRequest { project_key: string; path: string | null; bytes_base64: string | null; filename: string | null; mode: string | null }
/** `lib_register`: adopt a private library into the project's `lib/` and its lib tables. */
export interface LibRegisterRequest { nickname: string; path?: string | null; sha256?: string | null; pretty_path?: string | null }
export interface LibRegisterResult { nickname: string; written: string[]; reused: string[]; registered: string[]; symbols: string[]; lib_dir: string }
export interface ImageInfo { width: number; height: number; est_tokens: number }
export interface AttachInfo {
  sha256: string; kind: AttachKind; label: string; size: number; content_type: string; pages: number | null; image: ImageInfo | null;
  bound_to: string | null; warnings: string[];
}
export type AttachRead =
  | { kind: "text"; sha256: string; offset?: number | null; limit?: number | null }
  | { kind: "pdf_text"; sha256: string; pages?: number[] | null }
  | { kind: "pdf_page_image"; sha256: string; page: number }
  | { kind: "image"; sha256: string; size?: "standard" | "large" | null }
  | { kind: "sch"; sha256: string; match?: string | null; limit?: number | null }
  | { kind: "netlist"; sha256: string }
  | { kind: "bom"; sha256: string }
  | { kind: "fragment"; sha256: string };

// --------------------------------------------------------------------- skills
export interface UpdateCheck { status: "unset" | "up_to_date" | "available"; current: string; latest: string | null; source: "release_dir" | "git_tag" | null; folder: string | null; changelog: string | null }
export interface SkillPreview { front_matter: Record<string, unknown>; sections: string[]; l0_chars: number; l0_text: string; lint: string[] }
export interface SkillTestCase { name: string; pass: boolean; score: number; detail: string }
export interface SkillTestReport { pack: string; total: number; pass: number; cases: SkillTestCase[] }
export interface SkillFileInfo { name: string; path: string; front_matter: unknown; sections: string[]; l0_chars: number }
export interface SkillPackInfo {
  pack: string; layer: "builtin" | "user" | "project"; path: string; sha256: string; trusted: boolean; origin_agent: boolean;
  skills: SkillFileInfo[]; workflows: string[]; lint: string[];
  /** Second consent (`trust_workflows`): the pack's `mode: build` workflows may run. Builtin packs: always true. */
  workflows_trusted?: boolean;
}

// --------------------------------------------------------------------- events
export type AppEvent =
  | { kind: "fs_changed"; project_key: string; files: string[]; external: boolean }
  | { kind: "lock_detected"; project_key: string; file: string }
  /** A lock reported earlier is gone (KiCad closed the sheet): `ProjectInfo.locked` is stale, re-read it. */
  | { kind: "lock_released"; project_key: string; file: string }
  | { kind: "symbol_index"; state: "building" | "ready" | "empty" | "error"; done: number; total: number }
  | { kind: "session_expired"; project_key: string; reason: string }
  | { kind: "env_changed"; report: EnvReport }
  | { kind: "notification"; title: string; body: string; project_key: string | null }
  | { kind: "log"; level: string; message: string; req_id: string }
  /** The OS asked the running app to open a project file (Open With, a dock/taskbar drop). */
  | { kind: "open_file"; path: string };

// ---------------------------------------------------------------- diagnostics
export interface DiagBundleSpec { include_log: boolean; include_settings: boolean; include_db_tables: string[]; include_project_meta: string | null; out_path: string }
export interface VersionInfo {
  app: string; engine: string; protocol_version: number; tool_manifest_version: number; db_schema: number; settings_schema: number;
  ipc_version: number; kicad_write_version: number; git_sha: string;
}

// ------------------------------------------------------------ command surface
/** Every Tauri command, its argument shape and result. `src/ipc/client.ts` wraps these. */
export interface Commands {
  startup_args: { args: Record<string, never>; result: string[] };
  dev_script_read: { args: Record<string, never>; result: string | null };
  dev_script_report: { args: { text: string }; result: null };
  dev_exit: { args: Record<string, never>; result: null };
  dev_sleep: { args: { ms: number }; result: null };
  version_info: { args: Record<string, never>; result: VersionInfo };
  env_check: { args: { force?: boolean }; result: EnvReport };
  settings_get: { args: Record<string, never>; result: Settings };
  settings_set: { args: { patch: Partial<Settings> }; result: Settings };
  settings_reset: { args: { keys: string[] }; result: Settings };
  provider_models: { args: { provider_id: string }; result: string[] };
  provider_probe: { args: { provider_id: string; model: string }; result: ProviderConfig };
  project_open: { args: { path: string; identity?: "moved" | "copied" }; result: ProjectInfo };
  project_close: { args: { project_key: string }; result: null };
  project_list_recent: { args: Record<string, never>; result: RecentProject[] };
  example_install: { args: { dir: string | null }; result: string };
  project_new: { args: { spec: NewProjectSpec }; result: ProjectInfo };
  project_info: { args: { project_key: string }; result: ProjectInfo };
  project_shell_create: { args: { sheet: string; consent_event_id: string }; result: ProjectInfo };
  engine_request: { args: { project_key: string; request: EngineRequest; auth: Auth }; result: EngineResponse };
  build_session_open: { args: { open: BuildSessionOpen }; result: BuildSessionInfo };
  build_session_close: { args: { token: string }; result: null };
  build_session_touch: { args: { token: string }; result: BuildSessionInfo };
  turn_begin: { args: { begin: TurnBegin }; result: TurnInfo };
  turn_end: { args: { project_key: string; turn: number; outcome: string }; result: TurnCounters };
  turn_counters: { args: { project_key: string }; result: TurnCounters };
  consent_record: { args: { event: ConsentEvent }; result: { id: string } };
  grant_create: { args: { request: GrantRequest }; result: GrantInfo };
  checkpoint_create: { args: { project_key: string; turn: number; kind?: "turn" | "pre_rollback" }; result: CheckpointInfo };
  checkpoint_list: { args: { project_key: string }; result: CheckpointInfo[] };
  rollback_preview: { args: { project_key: string; before_turn: number; kind?: "turn" | "pre_rollback" }; result: RollbackPreview };
  rollback: { args: { request: RollbackRequest }; result: RollbackResult };
  sidecar_write: { args: { project_key: string; write: SidecarWrite }; result: null };
  sidecar_read: { args: { project_key: string; kind: "journal" | "turn" | "ledger" | "pending_card" | "plan" | "notes" | "facts" | "review" | "intent" | "bom_lock" | "project_config"; turn?: number; key?: string }; result: unknown };
  /** One guarded project-config change from the settings tab; needs a recorded consent event. Returns the new config. */
  project_config_apply: { args: { project_key: string; edit: ProjectConfigEdit; consent_event_id: string }; result: unknown };
  db_query: { args: { query: DbQuery }; result: unknown };
  keyring_set: { args: { provider_id: string; secret: string }; result: null };
  keyring_has: { args: { provider_id: string }; result: boolean };
  keyring_delete: { args: { provider_id: string }; result: null };
  /** Remove a provider row and its secret together. */
  provider_remove: { args: { provider_id: string }; result: Settings };
  net_fetch: { args: { request: NetRequest; on_chunk: unknown }; result: null };
  net_abort: { args: { id: string }; result: null };
  origin_register: { args: { origin: string; consent_event_id: string }; result: string[] };
  origin_list: { args: Record<string, never>; result: string[] };
  /** One-time consent for `web.fetch` on a new origin (kind `fetch_origin`). */
  fetch_origin_approve: { args: { origin: string; consent_event_id: string }; result: null };
  /** Fetch + land an external file (web_fetch purpose; origin must be approved). */
  web_fetch: { args: { url: string }; result: { sha256: string; content_type: string; size: number; text: string | null; url: string } };
  /** `web.fetch` tool body: landed bytes + model-readable text (HTML converted in Rust; PDFs return only the sha256). */
  web_fetch_text: { args: { url: string }; result: { sha256: string; url: string; content_type: string; size: number; kind: "html" | "text" | "pdf" | "binary"; text: string | null; truncated: boolean; note: string | null; trust: "untrusted" } };
  fetch_origin_list: { args: Record<string, never>; result: { id: number; origin: string; granted_at: string }[] };
  fetch_origin_revoke: { args: { id: number }; result: null };
  /** `docs.pdf_text`: per-page text of a cached PDF (cached as external/<sha>.txt). */
  pdf_text: { args: { sha256: string; pages?: number[] | null }; result: { sha256: string; total_pages: number; pages: { n: number; text: string }[]; missing_pages: number[]; truncated: boolean; hint: string | null; trust: "untrusted" } };
  /** `parts.bom`: BOM lines + shared-library snapshot; lock write / drift against bom.lock.json. */
  parts_bom: { args: { project_key: string; lock?: boolean | null; against_lock?: string | null }; result: BomReport };
  // parts sourcing (M3): jlcsearch + EasyEDA through the Rust `parts` whitelist
  parts_search: { args: { query?: string | null; mpn?: string | null; lcsc?: string | null; value?: string | null; package?: string | null; category?: string | null; limit?: number | null; in_stock?: boolean | null; basic_only?: boolean | null }; result: PartsSearchResult };
  parts_show: { args: { lcsc: string }; result: unknown };
  parts_datasheet: { args: { project_key: string; lcsc?: string | null; mpn?: string | null }; result: { lcsc: string; mpn: string; sha256: string; label: string; pages: number | null; warnings: string[]; url: string; note: string } };
  parts_convert: { args: { project_key: string; lcsc: string; lib_nickname?: string | null; with_3d?: boolean | null; auth: Auth }; result: EngineResponse };
  parts_refresh: { args: { lcsc: string }; result: PartsCacheRow };
  codex_device_begin: { args: { consent_event_id: string; method?: "browser" | "device" }; result: DeviceCodeState };
  codex_device_poll: { args: Record<string, never>; result: DeviceCodeState };
  codex_revoke: { args: Record<string, never>; result: null };
  attach_intake: { args: { request: IntakeRequest }; result: AttachInfo };
  attach_read: { args: { project_key: string; read: AttachRead }; result: unknown };
  attach_bind_to_project: { args: { project_key: string; sha256: string; dest: "datasheets" | "libs" }; result: string };
  lib_register: { args: { project_key: string; request: LibRegisterRequest; auth: Auth }; result: LibRegisterResult };
  skills_list: { args: { project_key?: string | null }; result: SkillPackInfo[] };
  skills_read: { args: { pack: string; path: string }; result: string };
  skills_trust: { args: { pack: string; sha256: string; consent_event_id: string; project_key?: string | null }; result: SkillPackInfo };
  skills_trust_workflows: { args: { pack: string; sha256: string; consent_event_id: string; project_key?: string | null }; result: SkillPackInfo };
  skills_revoke_workflows: { args: { pack: string; project_key?: string | null }; result: SkillPackInfo };
  skills_write_draft: { args: { pack: string; name: string; section_text: string; activation?: string | null; scope: "project" | "user"; project_key?: string | null; grant: string }; result: SkillPackInfo };
  skills_import_zip: { args: { path: string; scope: "project" | "user"; project_key?: string | null }; result: SkillPackInfo };
  skills_export_zip: { args: { pack: string; out_path: string }; result: null };
  export_file: { args: { project_key: string; kind: "svg" | "netlist" | "findings" | "plan" | "transcript" | "costs" | "metrics" | "bom"; payload: unknown; out_path: string }; result: string };
  kicad_advisory: { args: { project_key: string; kind: "erc" | "netlist" }; result: unknown };
  lib_index_rebuild: { args: Record<string, never>; result: null };
  log_write: { args: { level: string; message: string; req_id?: string | null }; result: null };
  diag_bundle: { args: { spec: DiagBundleSpec }; result: string };
  app_data_path: { args: Record<string, never>; result: string };
  /** Phase F: local update check (release folder / git tag; no network). */
  update_check: { args: Record<string, never>; result: UpdateCheck };
  /** Bytes-affecting entries of CHANGELOG `[Unreleased]` + this version (first-run disclosure). */
  update_disclosure: { args: Record<string, never>; result: { version: string; bytes_affecting: string[]; entries: string[] } };
  /** OS clipboard image (PNG) when the webview paste carried none; null when the clipboard has no image. */
  clipboard_read_image: { args: Record<string, never>; result: { png_base64: string; width: number; height: number } | null };
  /** Structured log event (JSONL, rotated) — see docs/logging.md §3. */
  log_event: { args: { event: string; level?: string | null; fields?: Record<string, unknown> | null; req_id?: string | null }; result: null };
  skills_preview: { args: { text: string }; result: SkillPreview };
  skills_write_file: { args: { pack: string; path: string; text: string; scope: "project" | "user"; project_key?: string | null }; result: SkillPackInfo };
  skills_test: { args: { pack: string; project_key?: string | null }; result: SkillTestReport };
  open_path: { args: { path: string }; result: null };
  open_url: { args: { url: string }; result: null };
  app_data_export: { args: { out_path: string }; result: null };
  app_data_wipe: { args: { consent_event_id: string }; result: null };
}
export type CommandName = keyof Commands;

/** `engine_request { kind: "net_map" }`: which net each wire / label / pin of one sheet belongs to (untrusted). */
export interface NetMapResult {
  sheet: string;
  wires: Record<string, string>;
  labels: Record<string, string>;
  pins: Record<string, string>;
  /** Sheet-pin uuid -> net, for the sheet symbols drawn on this sheet (added after the first release). */
  sheet_pins?: Record<string, string>;
  /** Junction uuid -> net (added after the first release). */
  junctions?: Record<string, string>;
  /** No-connect uuid -> net (added after the first release). */
  no_connects?: Record<string, string>;
}

