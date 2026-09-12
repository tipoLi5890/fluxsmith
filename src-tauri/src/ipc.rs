// SPDX-License-Identifier: Apache-2.0
//! Typed IPC contract between the webview and the Rust effect kernel.
//! Mirrored byte-for-byte in `src/ipc/types.ts`. Every command takes closed
//! enums or plain structs; the webview never sends SQL, shell strings or
//! arbitrary paths (project-relative paths are canonicalised in Rust).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const IPC_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Structured error returned by every command (`docs/error-codes.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
    pub req_id: String,
}

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        IpcError {
            code: code.to_string(),
            message: message.into(),
            remediation: None,
            evidence: None,
            req_id: String::new(),
        }
    }
    pub fn with_remediation(mut self, r: impl Into<String>) -> Self {
        self.remediation = Some(r.into());
        self
    }
    pub fn with_evidence(mut self, e: serde_json::Value) -> Self {
        self.evidence = Some(e);
        self
    }
}

pub type IpcResult<T> = Result<T, IpcError>;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EnvReport {
    /// `ok` | `degraded` (reads fine, cannot write: KiCad 9 with resolvable libraries —
    /// Review and Q&A stay, Plan and Build are stopped) | `incomplete` (`EnvIncomplete`
    /// state, D-51: AI features off). See `env::status_for`.
    pub status: String,
    pub kicad_app_path: Option<String>,
    pub kicad_cli_path: Option<String>,
    pub kicad_version: Option<String>,
    pub symbol_dir: Option<String>,
    pub symbol_lib_count: usize,
    pub sym_lib_table: Option<String>,
    pub keyring_available: bool,
    pub problems: Vec<EnvProblem>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvProblem {
    pub code: String,
    pub message: String,
    pub remediation: String,
    pub fatal: bool,
}

// ---------------------------------------------------------------------------
// Settings (`docs/settings.md`, `workspace-format.md` §9)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    /// `anthropic` | `openai` | `google` | `openrouter` | `xai` | `groq` | `mistral` | `openai-codex` | `custom`
    pub kind: String,
    pub label: String,
    pub base_url: String,
    pub enabled: bool,
    /// USD per 1M tokens: input, cache_write, cache_read, output
    pub rates: [f64; 4],
    pub context_window: u32,
    /// `full` | `degraded` | `none` | `manual` | `unknown`
    pub build_capable: String,
    pub vision: bool,
    pub cache_reporting: bool,
    pub raw_base64_images: bool,
    pub models: Vec<String>,
    pub probed_at: Option<String>,
    pub has_secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub schema_version: u32,
    pub language: String,
    pub theme: String,
    pub restore_tabs_on_launch: bool,
    pub notifications: bool,
    pub shortcuts: BTreeMap<String, String>,
    pub kicad: KicadSettings,
    pub providers: Vec<ProviderConfig>,
    pub models_by_role: BTreeMap<String, String>,
    pub rates_as_of: Option<String>,
    /// App version whose first-run disclosure was acknowledged (updates-and-compatibility.md §4).
    #[serde(default)]
    pub disclosed_version: Option<String>,
    pub agent: AgentSettings,
    pub context: ContextSettings,
    pub storage: StorageSettings,
    pub privacy: PrivacySettings,
    pub advanced: AdvancedSettings,
    /// Parts sourcing (JLCPCB/LCSC/EasyEDA network access), off until consented.
    #[serde(default)]
    pub parts: PartsSettings,
    #[serde(default, flatten)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KicadSettings {
    pub app_path: Option<String>,
    pub cli_path: Option<String>,
    pub symbol_dir_override: Option<String>,
    pub target_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSettings {
    /// `ask` | `review` | `auto`
    pub default_policy: String,
    pub continuous_run: bool,
    pub session_ceiling_components_added: u32,
    pub budget_defaults: BudgetDefaults,
    pub canvas_follow: bool,
    pub canvas_grid: bool,
    /// Keep what the last turn drew and changed highlighted on the canvas until the next turn starts.
    #[serde(default = "default_true")]
    pub canvas_changes: bool,
    /// Left-drag on empty canvas rubber-bands (eeschema reflex) instead of panning.
    #[serde(default)]
    pub canvas_drag_selects: bool,
    pub chat_attach_selection: bool,
    pub intake_defaults: BTreeMap<String, String>,
    /// `compact` | `detailed` | `developer`
    pub chat_density: String,
    /// `off` | `minimal` | `low` | `medium` | `high`
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    /// Master switch for plan/turn budgets (tokens, USD, tool calls, wall time). Off by default.
    #[serde(default)]
    pub budget_enabled: bool,
}

fn default_thinking_level() -> String {
    "medium".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetDefaults {
    pub plan_tokens: Option<u64>,
    pub plan_usd: Option<f64>,
    pub plan_tool_calls: Option<u32>,
    pub plan_wall_min: Option<u32>,
    pub turn_tool_calls: Option<u32>,
    pub turn_wall_min: Option<u32>,
    pub warn_pct: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSettings {
    pub hint_pct: u8,
    pub auto_pct: u8,
    pub emergency_pct: u8,
    pub keep_recent_tasks: u32,
    pub reserve_output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageSettings {
    pub checkpoint_turns: u32,
    pub checkpoint_mb: u32,
    pub external_cache_mb: u32,
    pub datasheets_copy_to_project_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacySettings {
    pub log_level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PartsSettings {
    /// Master switch; enabling requires a consent event (`parts_network`).
    #[serde(default)]
    pub enabled: bool,
    /// Library nickname used for converted parts (default `jlc`).
    #[serde(default = "default_parts_nickname")]
    pub lib_nickname: String,
    /// Download STEP models with footprints.
    #[serde(default = "default_true")]
    pub with_3d: bool,
}

fn default_parts_nickname() -> String {
    "jlc".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedSettings {
    pub step_throttle: bool,
    pub images_size: String,
    pub tool_parallel_max: u32,
    pub drafter_concurrency: u32,
    pub provider_conn_max: u32,
    pub sandbox_enabled: bool,
    pub router_path: Option<String>,
    /// Local release folder for the update check (`releases/v<ver>/`); None = unset.
    #[serde(default)]
    pub release_dir: Option<String>,
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub key: String,
    pub root: String,
    pub root_sheet: String,
    pub root_uuid: String,
    pub name: String,
    pub version: u32,
    pub sheets: Vec<SheetInfo>,
    pub config: serde_json::Value,
    pub git: Option<GitState>,
    pub last_turn: u32,
    pub last_mode: String,
    pub policy_override: Option<String>,
    pub locked: bool,
    /// Startup crash-recovery scan result (`docs/crash-recovery.md`); `None` when nothing was found.
    #[serde(default)]
    pub recovery: Option<RecoveryReport>,
    /// Project root lies in a cloud-sync folder (iCloud / OneDrive / Dropbox / Google Drive).
    #[serde(default)]
    pub cloud_synced: bool,
    /// Opened as a standalone `.kicad_sch` with no `.kicad_pro` beside it (D-57): read-only
    /// plus Q&A, no sidecar is written, Plan / Build / Review are refused until
    /// `project_shell_create` writes the project files.
    #[serde(default)]
    pub no_pro: bool,
}

/// Result of `recovery::scan` for one project (crash-recovery.md §3–§4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryReport {
    pub scanned_at: String,
    /// The turn left unfinished (no `turn.json`, or status running/stopping/hard_stopped).
    pub turn: Option<u32>,
    pub phase_at_interrupt: Option<String>,
    pub cleaned: Vec<RecoveryCleaned>,
    pub steps: Vec<RecoveryStep>,
    /// `turns/<n>/artifacts/pending_card.json` of the last turn, if the crash hit while a card was waiting.
    pub pending_card: Option<serde_json::Value>,
    /// Machine-readable notes; the UI owns the copy (four languages), Rust never writes prose here.
    pub notes: Vec<RecoveryNote>,
}

/// One note of a recovery scan, as a code plus its parameters (`{"code": "...", ...}` on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RecoveryNote {
    /// A journal `rollback_begin` with no matching `rollback`: the restore was cut short and some
    /// sheets may be at the checkpoint while others are not. Rolling back again completes it.
    RollbackInterrupted { before_turn: u32 },
    /// An applied step whose target files no longer match the recorded shas: roll back to before
    /// the turn, or keep the files and mark the step done.
    StepNeedsReview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryCleaned {
    /// `temp_file` | `bak_pending` | `stage` | `preview` | `run_backup`
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryStep {
    pub turn: u32,
    pub step: String,
    pub ledger_phase: String,
    /// `orphan_cleaned` | `done_confirmed` | `needs_review` | `failed` | `done`
    pub verdict: String,
    pub files: Vec<RecoveryFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryFile {
    pub path: String,
    pub expected_sha: Option<String>,
    pub actual_sha: Option<String>,
    pub matches: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SheetInfo {
    pub file: String,
    pub instance_path: String,
    pub names: Vec<String>,
    pub paper: String,
    pub symbols: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitState {
    pub dirty: bool,
    pub head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentProject {
    pub key: String,
    pub path: String,
    pub name: String,
    pub last_opened: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProjectSpec {
    pub dir: String,
    pub name: String,
    pub paper: String,
    pub kicad_version: u32,
}

// ---------------------------------------------------------------------------
// Engine requests (closed enum; red line 14)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EngineRequest {
    Summary {
        sheet: Option<String>,
    },
    Read {
        sheet: Option<String>,
        r#match: Option<String>,
        limit: Option<u32>,
        /// List every sheet instance's symbols instead of one sheet's (the UI's "all sheets" list).
        /// Rows carry the sheet file and the instance path they were read through; the reference is
        /// the per-instance one, so a reused sheet reads the way KiCad annotates it.
        all_sheets: Option<bool>,
    },
    Nets {
        sheet: Option<String>,
        r#match: Option<String>,
        limit: Option<u32>,
    },
    Net {
        name: String,
    },
    Component {
        reference: String,
        unit: Option<u32>,
    },
    Pins {
        lib_id: String,
        at_mil: [f64; 2],
        rotation: f64,
        mirror: Option<String>,
        unit: Option<u32>,
    },
    Bbox {
        refs: Option<Vec<String>>,
        region_mil: Option<[[f64; 2]; 2]>,
    },
    /// Overlay geometry (bboxes, pins) for the canvas hit-test layer.
    Geom {
        sheet: String,
    },
    /// Full render geometry for the self-drawn canvas.
    Render {
        sheet: String,
    },
    /// Item -> net map for one sheet (canvas net highlight); connectivity comes from sch-net.
    NetMap {
        sheet: String,
    },
    /// Raw bytes of one sheet file (for export / debug only; untrusted).
    Bytes {
        sheet: String,
    },
    LibSearch {
        query: Option<String>,
        lib_id: Option<String>,
        category: Option<String>,
        pins: Option<u32>,
        limit: Option<u32>,
    },
    LibResolve {
        lib_id: String,
    },
    LibSymbol {
        lib_id: String,
    },
    OpsList {},
    OpsTemplate {
        op: String,
        required_only: Option<bool>,
    },
    OpsValidate {
        oplist: serde_json::Value,
    },
    OpsExpand {
        oplist: serde_json::Value,
    },
    DryrunScratch {
        oplist: serde_json::Value,
        target: String,
    },
    Plan {
        oplist: serde_json::Value,
        target: String,
        flat: Option<bool>,
    },
    Apply {
        oplist: serde_json::Value,
        target: String,
        expected_merges: Vec<ExpectedMergeSpec>,
        note: String,
        waived: Option<WaiverRef>,
        /// `Some(false)`: layout errors become findings instead of a refusal.
        #[serde(default)]
        strict_layout: Option<bool>,
    },
    Check {
        family: String,
        sheet: Option<String>,
    },
    GateRun {},
    DiffNets {
        before: String,
        after: Option<String>,
    },
    ProjectCheck {},
    Bom {},
    IntentSnapshot {
        note: String,
    },
    SheetCreate {
        file: String,
        name: String,
        at_mil: [f64; 2],
        size_mil: [f64; 2],
        pins: Vec<serde_json::Value>,
        paper: Option<String>,
        /// Sheet the new sheet symbol is drawn on: a sheet file, an instance path
        /// (`/power/`) or an instance names path. The root sheet when absent.
        #[serde(default)]
        parent: Option<String>,
    },
    /// Resolve a chat `Ref` (component/net/sheet/region) to engine facts.
    Resolve {
        refs: Vec<serde_json::Value>,
    },
    /// Write `[[waiver]]` into `fluxsmith.toml` (D tier, grant only).
    PolicyWaive {
        code: String,
        refs: Option<Vec<String>>,
        severity: Option<String>,
        reason: String,
        expires: Option<String>,
    },
    PolicyRead {},
    /// Convert an external CAD part into project libraries (Sourcer, D).
    PartsConvert {
        source: serde_json::Value,
        lib_nickname: String,
        with_3d: bool,
    },
    /// Geometry of a `sch.plan` preview (ghost layer), same shape as `Render`.
    RenderPreview {
        preview_id: String,
        sheet: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedMergeSpec {
    pub into: String,
    pub sources_unnamed_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaiverRef {
    pub grant_id: String,
    pub reason: String,
}

/// Authorisation attached to an engine request. D-tier variants require
/// `build_session` (Build mode, running instruction turn, envelope) or a
/// single-use `grant`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Auth {
    #[serde(default)]
    pub build_session: Option<String>,
    #[serde(default)]
    pub grant: Option<String>,
    /// Which role is calling (hooks decide; Rust re-checks lead-only for D).
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineResponse {
    pub ok: bool,
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<IpcError>,
    pub meta: ResponseMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ResponseMeta {
    pub bytes: usize,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ops_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub elapsed_ms: u64,
    pub trust: String,
}

// ---------------------------------------------------------------------------
// Build session / turns / grants (red line 13)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Envelope {
    pub sheets: Vec<String>,
    pub allowed_ops: Vec<String>,
    pub components_added_max: u32,
    pub components_deleted_max: u32,
    pub wires_max: Option<u32>,
    pub structural: Vec<String>,
    pub nets_renamable: Vec<String>,
    /// Upper bound on `set_component_parameters` / `set_component_attributes` ops in the turn,
    /// counted from the checkpoint like the component budgets (red line 13: an edit turn has a
    /// non-model bound too). Envelopes written before the field existed deserialise as 0, which
    /// refuses rather than permits.
    #[serde(default)]
    pub properties_changed_max: u32,
    /// Upper bound on `move_component` / `set_component_transform` / `arrange_group` moves.
    #[serde(default)]
    pub components_moved_max: u32,
    /// Designators the human's own message named ("change R2 and C3"). Non-empty: an edit or move of
    /// any other part that already existed is refused (`ENVELOPE_REFERENCE`); parts placed in the
    /// same turn are always editable. Empty: unrestricted (an incremental turn without named parts).
    #[serde(default)]
    pub refs_editable: Vec<String>,
    pub rails: Vec<String>,
    pub interfaces: Vec<String>,
    pub instance_designators: BTreeMap<String, Vec<String>>,
    /// `plan:<id>@<version>/<step>` | `session_ceiling`
    pub source: String,
}

impl Envelope {
    /// Canonical JSON of an envelope, byte-identical to the webview's `canonicalEnvelope`
    /// (`src/agent/util.ts`): exactly these fourteen fields, object keys sorted, no whitespace.
    /// `serde_json::Value` keeps object keys in a `BTreeMap`, so serialising through `to_value`
    /// gives the sorted form for free (the same trick `check_waiver_grant` relies on).
    ///
    /// This is the string a `scope` grant is bound to: the card the human approved, the recorded
    /// consent event and the `turn.begin` that spends the grant all carry the sha of the *same*
    /// widened envelope, so one approval can never be spent on a different widening.
    pub fn canonical_json(&self) -> String {
        serde_json::to_value(self)
            .map(|v| v.to_string())
            .unwrap_or_default()
    }

    /// sha256 of [`Envelope::canonical_json`].
    pub fn canonical_sha256(&self) -> String {
        crate::paths::sha256_hex(self.canonical_json().as_bytes())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildSessionOpen {
    pub project_key: String,
    /// `plan:<id>@<version>` or `incremental`
    pub plan_ref: String,
    pub plan_sha256: Option<String>,
    pub policy: String,
    pub consent_event_id: String,
    pub lead_model: String,
    pub tool_manifest_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildSessionInfo {
    pub token: String,
    pub project_key: String,
    pub plan_ref: String,
    pub policy: String,
    pub ceiling: Envelope,
    pub opened_at: String,
    pub idle_timeout_min: u32,
    pub absolute_timeout_h: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnBegin {
    pub project_key: String,
    pub build_session: Option<String>,
    /// `question` | `instruction`
    pub kind: String,
    pub headline: String,
    pub plan_step: Option<String>,
    pub envelope: Option<Envelope>,
    pub inherit_from_turn: Option<u32>,
    pub mode: String,
    /// Single-use `scope` grant: the declared envelope may exceed the session ceiling.
    #[serde(default)]
    pub grant: Option<String>,
    /// Re-declaration of the turn that is already open (after a scope card): keep the
    /// same turn number so the checkpoint taken for it still counts.
    #[serde(default)]
    pub redeclare: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnInfo {
    pub turn: u32,
    pub effective_envelope: Envelope,
    pub ceiling_source: String,
    pub checkpoint_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnCounters {
    pub turn: u32,
    pub components_added: u32,
    pub components_deleted: u32,
    pub wires_added: u32,
    /// Moves and re-poses applied since the checkpoint (`components_moved_max`).
    #[serde(default)]
    pub components_moved: u32,
    /// Property / attribute edits applied since the checkpoint (`properties_changed_max`).
    #[serde(default)]
    pub properties_changed: u32,
    /// Designators of the symbols this turn placed: editable and movable whatever `refs_editable`
    /// says, because the human's component budget already covers them.
    #[serde(default)]
    pub refs_created: Vec<String>,
    pub apply_count: u32,
    pub tool_calls: u32,
    pub billed_tokens: u64,
    pub cost_usd: f64,
    pub wall_active_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantRequest {
    pub project_key: String,
    /// `scope` | `structural` | `net_risk` | `unresolved` | `interface` | `rollback` | `waiver` | `intent` | `user_action` | `policy` | `lib_import` | `skill_draft` | `parts_convert`
    pub kind: String,
    pub payload_sha256: String,
    pub consent_event_id: String,
    /// Optional five-tuple identifying the exact action the grant unlocks.
    pub action: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantInfo {
    pub id: String,
    pub kind: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsentEvent {
    pub project_key: String,
    pub card_kind: String,
    pub payload_sha256: String,
    /// `click` | `keyboard` | `auto`
    pub input_kind: String,
}

// ---------------------------------------------------------------------------
// Checkpoints / rollback
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointInfo {
    pub project_key: String,
    pub turn: u32,
    pub manifest_sha256: String,
    pub bytes: u64,
    pub created: String,
    pub kind: String,
    pub pruned: bool,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackRequest {
    pub project_key: String,
    /// Restore the state as it was before this turn began.
    pub before_turn: u32,
    pub grant: String,
    /// `turn` (default) restores that turn's checkpoint; `pre_rollback`
    /// restores the one-shot snapshot an earlier rollback took of the files it
    /// was about to overwrite (single use: it is consumed).
    #[serde(default)]
    pub kind: Option<String>,
    /// The `state_sha256` `rollback_preview` returned for the state the human
    /// was shown. Anything that changed since makes this a different decision:
    /// `ROLLBACK_STALE`, nothing written.
    #[serde(default)]
    pub state_sha256: Option<String>,
}

impl RollbackRequest {
    pub fn kind(&self) -> &str {
        match self.kind.as_deref() {
            Some(k) if !k.is_empty() => k,
            _ => "turn",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackResult {
    pub restored_files: Vec<String>,
    /// Files created after the checkpoint: moved into the backup, not deleted.
    pub removed_files: Vec<String>,
    /// The snapshot of what this rollback overwrote (`None` when the rollback
    /// restored such a snapshot: it is consumed, not taken again).
    pub pre_rollback_checkpoint: Option<CheckpointInfo>,
    pub now_turn: u32,
}

/// What a rollback would do, computed from the manifest and the files on disk
/// (no model, no consent): the confirm dialog shows it and hands
/// `state_sha256` back so the write refuses a project that moved since.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollbackPreview {
    pub before_turn: u32,
    pub kind: String,
    pub restore_files: Vec<String>,
    pub remove_files: Vec<String>,
    pub state_sha256: String,
}

// ---------------------------------------------------------------------------
// Sidecar writes (S tier; `.fluxsmith/**` only)
// ---------------------------------------------------------------------------

/// One guarded change to `fluxsmith.toml`, made by the human in the project settings tab
/// (`docs/settings.md` §6, card `SETTINGS_PROJECT_CARD`). The agent-reachable path
/// (`sidecar_write kind: "project_config"`) refuses the guarded keys outright; this one accepts
/// exactly one of them per call and only against a recorded consent event (red line 13: consent is
/// a human action, never something a model can produce).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ProjectConfigEdit {
    /// Replace one guarded top-level key (`rails`, `check`, `backup_depth`). `waiver` is not
    /// settable here: a waiver is granted by the `policy.waive` card and removed by `waiver_revoke`.
    Set {
        key: String,
        value: serde_json::Value,
    },
    /// Remove one `[[waiver]]` record: its index in the list, checked against the `granted` stamp
    /// the settings tab read, so a list that changed underneath cannot revoke the wrong record.
    WaiverRevoke {
        index: usize,
        granted: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidecarWrite {
    Journal {
        entry: serde_json::Value,
    },
    Turn {
        turn: u32,
        turn_json: serde_json::Value,
    },
    Ledger {
        turn: u32,
        step: String,
        phase: String,
        payload: serde_json::Value,
    },
    /// Full transcript of one subagent run (brief, messages, raw output) for debugging.
    Subagent {
        turn: u32,
        role: String,
        id: String,
        transcript: serde_json::Value,
    },
    Plan {
        plan: serde_json::Value,
    },
    Notes {
        text: String,
        anchor: serde_json::Value,
    },
    Facts {
        mpn: String,
        facts: serde_json::Value,
    },
    Review {
        turn: u32,
        report: serde_json::Value,
    },
    Intent {
        intent: serde_json::Value,
    },
    BomLock {
        lock: serde_json::Value,
    },
    ProjectConfig {
        config: serde_json::Value,
    },
    /// `turns/<n>/artifacts/pending_card.json`: written when a card starts waiting,
    /// removed (`card: None`) once it is answered. Holds the full card and the
    /// op-list sha, never grant or consent ids (crash-recovery.md §3 "waiting").
    PendingCard {
        turn: u32,
        card: Option<serde_json::Value>,
    },
}

// ---------------------------------------------------------------------------
// Database queries (closed enum; no SQL crosses IPC)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DbQuery {
    SessionCreate {
        project_key: String,
        title: Option<String>,
    },
    SessionList {
        project_key: String,
    },
    SessionRename {
        session_id: String,
        title: String,
    },
    SessionDelete {
        session_id: String,
    },
    MessageAppend {
        session_id: String,
        turn: u32,
        role: String,
        content: serde_json::Value,
    },
    MessageList {
        session_id: String,
        after_id: Option<i64>,
        limit: Option<u32>,
    },
    MessageSearch {
        project_key: String,
        query: String,
        limit: Option<u32>,
    },
    /// Mark the messages summarised by an L2 compaction (turn range minus the turns / recent tasks the
    /// in-memory `isProtected` kept; markers and plan snapshots are never marked) so `messages_list` skips them.
    MessagesCompact {
        session_id: String,
        from_turn: i64,
        to_turn: i64,
        #[serde(default)]
        keep_turns: Vec<i64>,
        #[serde(default)]
        min_task: i64,
        compaction: serde_json::Value,
    },
    MessagesExport {
        session_id: String,
    },
    ApprovalUpsert {
        project_key: String,
        kind_: String,
        r#ref: String,
        sha256: String,
        consent_event_id: String,
    },
    ApprovalList {
        project_key: Option<String>,
        kind_: Option<String>,
    },
    ApprovalRevoke {
        id: i64,
    },
    ApprovalCheck {
        project_key: Option<String>,
        kind_: String,
        r#ref: String,
        sha256: String,
    },
    MetricAppend {
        project_key: String,
        kind_: String,
        value: f64,
        dims: serde_json::Value,
    },
    MetricSummary {
        project_key: Option<String>,
    },
    ModelCallAppend {
        project_key: String,
        call: serde_json::Value,
    },
    ModelCallSummary {
        project_key: String,
        plan_id: Option<String>,
    },
    /// `model_calls` aggregated per (turn, role) for one project, so a restored session can rebuild
    /// the same per-role `usage` events a live turn emits. Turn numbers are per project
    /// (`projects.last_turn`), which is what makes the project key enough to identify a turn; the
    /// caller narrows to the turns it actually restored with `from_turn` / `to_turn`.
    ModelCallByTurn {
        project_key: String,
        from_turn: Option<i64>,
        to_turn: Option<i64>,
    },
    ModelCallExport {
        project_key: String,
    },
    AttachmentUpsert {
        project_key: String,
        sha256: String,
        kind_: String,
        label: String,
        bound_to: Option<String>,
    },
    AttachmentList {
        project_key: String,
    },
    AttachmentBind {
        project_key: String,
        sha256: String,
        bound_to: Option<String>,
    },
    AttachmentRemove {
        project_key: String,
        sha256: String,
    },
    CompactionAppend {
        project_key: String,
        session_id: String,
        level: u8,
        from_turn: u32,
        to_turn: u32,
        reclaimed: u64,
        block_sha256: String,
    },
    CompactionList {
        session_id: String,
    },
    ProjectState {
        project_key: String,
    },
    ProjectStateSet {
        project_key: String,
        patch: serde_json::Value,
    },
    ProjectForget {
        project_key: String,
    },
    OrphanProjects {},
    Storage {},
    StorageClear {
        area: String,
    },
    CrashList {},
    LibIndexState {},
    /// Shared parts library rows (`parts_cache`), optionally filtered by free text.
    PartsCacheList {
        query: Option<String>,
    },
    /// Remove one part from the shared cache (directory + row).
    PartsCacheForget {
        lcsc: String,
    },
}

// ---------------------------------------------------------------------------
// Network (red line 12)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetRequest {
    pub id: String,
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    /// UTF-8 body (JSON for providers).
    pub body: Option<String>,
    /// Provider id whose secret Rust injects as `Authorization` / `x-api-key`.
    pub provider: Option<String>,
    pub timeout_ms: Option<u64>,
    /// `provider` | `parts` | `web_fetch` (each has its own whitelist/consent)
    pub purpose: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NetChunk {
    Head {
        status: u16,
        headers: BTreeMap<String, String>,
    },
    Body {
        data_base64: String,
    },
    Done {
        bytes: u64,
    },
    Error {
        error: IpcError,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeState {
    /// `pending` | `authorized` | `expired` | `denied` | `error`
    pub status: String,
    pub user_code: Option<String>,
    pub verification_url: Option<String>,
    pub expires_at: Option<String>,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Attachments / intake (`chat-references-and-attachments.md`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntakeRequest {
    pub project_key: String,
    /// Absolute path picked by dialog/drag-drop, or `None` when `bytes_base64` is set (paste).
    pub path: Option<String>,
    pub bytes_base64: Option<String>,
    pub filename: Option<String>,
    /// `keep` | `attach` | `reference` | `ask`
    pub mode: Option<String>,
}

/// `lib_register`: adopt a private symbol / footprint library into the project's `lib/` and
/// register it in `sym-lib-table` / `fp-lib-table`. The symbol library comes either from an
/// attachment (`sha256`, what `lib.import_request` proposes) or from a file the human picked
/// (`path`); `pretty_path` adds a footprint library directory. Needs a `lib_import` grant.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibRegisterRequest {
    pub nickname: String,
    /// Absolute path of a `.kicad_sym` file.
    #[serde(default)]
    pub path: Option<String>,
    /// Attachment handle of a `.kicad_sym` (wins over `path`).
    #[serde(default)]
    pub sha256: Option<String>,
    /// Absolute path of a `.pretty` directory of `.kicad_mod` footprints.
    #[serde(default)]
    pub pretty_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachInfo {
    pub sha256: String,
    /// `lib` | `pdf` | `doc` | `sch` | `image` | `netlist` | `bom` | `fragment` | `project_zip` | `unknown`
    pub kind: String,
    pub label: String,
    pub size: u64,
    pub content_type: String,
    pub pages: Option<u32>,
    pub image: Option<ImageInfo>,
    pub bound_to: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub est_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachRead {
    Text {
        sha256: String,
        offset: Option<u64>,
        limit: Option<u64>,
    },
    PdfText {
        sha256: String,
        pages: Option<Vec<u32>>,
    },
    PdfPageImage {
        sha256: String,
        page: u32,
    },
    Image {
        sha256: String,
        size: Option<String>,
    },
    Sch {
        sha256: String,
        r#match: Option<String>,
        limit: Option<u32>,
    },
    Netlist {
        sha256: String,
    },
    Bom {
        sha256: String,
    },
    Fragment {
        sha256: String,
    },
}

// ---------------------------------------------------------------------------
// Skills (`docs/skill-packs.md`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPackInfo {
    pub pack: String,
    /// `builtin` | `user` | `project`
    pub layer: String,
    pub path: String,
    pub sha256: String,
    pub trusted: bool,
    pub origin_agent: bool,
    pub skills: Vec<SkillFileInfo>,
    pub workflows: Vec<String>,
    pub lint: Vec<String>,
    /// Second consent (`trust_workflows`): `mode: build` workflows of this pack may run.
    #[serde(default)]
    pub workflows_trusted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFileInfo {
    pub name: String,
    pub path: String,
    pub front_matter: serde_json::Value,
    pub sections: Vec<String>,
    pub l0_chars: usize,
}

// ---------------------------------------------------------------------------
// Events pushed from Rust → webview
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppEvent {
    FsChanged {
        project_key: String,
        files: Vec<String>,
        external: bool,
    },
    LockDetected {
        project_key: String,
        file: String,
    },
    /// A lock the watcher had reported is gone (KiCad closed the sheet): the UI re-reads
    /// `ProjectInfo.locked` and the harness clears the P7 `external.locked` flag.
    LockReleased {
        project_key: String,
        file: String,
    },
    SymbolIndex {
        state: String,
        done: usize,
        total: usize,
    },
    SessionExpired {
        project_key: String,
        reason: String,
    },
    EnvChanged {
        report: EnvReport,
    },
    Notification {
        title: String,
        body: String,
        project_key: Option<String>,
    },
    Log {
        level: String,
        message: String,
        req_id: String,
    },
    /// The OS asked the running app to open a project file (Open With, a dock/taskbar drop).
    OpenFile {
        path: String,
    },
}

// ---------------------------------------------------------------------------
// Logging / diagnostics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagBundleSpec {
    pub include_log: bool,
    pub include_settings: bool,
    pub include_db_tables: Vec<String>,
    pub include_project_meta: Option<String>,
    pub out_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionInfo {
    pub app: String,
    pub engine: String,
    pub protocol_version: u32,
    pub tool_manifest_version: u32,
    pub db_schema: u32,
    pub settings_schema: u32,
    pub ipc_version: u32,
    pub kicad_write_version: u32,
    pub git_sha: String,
}

// ---------------------------------------------------------------------------
// Phase F: updates, clipboard, skill editor
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheck {
    /// `unset` | `up_to_date` | `available`
    pub status: String,
    pub current: String,
    pub latest: Option<String>,
    /// `release_dir` | `git_tag`
    pub source: Option<String>,
    pub folder: Option<String>,
    pub changelog: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Disclosure {
    pub version: String,
    pub bytes_affecting: Vec<String>,
    pub entries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardImage {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPreview {
    pub front_matter: serde_json::Value,
    pub sections: Vec<String>,
    pub l0_chars: usize,
    pub l0_text: String,
    pub lint: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillTestCase {
    pub name: String,
    pub pass: bool,
    pub score: f64,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillTestReport {
    pub pack: String,
    pub total: usize,
    pub pass: usize,
    pub cases: Vec<SkillTestCase>,
}
