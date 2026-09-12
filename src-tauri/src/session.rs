// SPDX-License-Identifier: Apache-2.0
//! BuildSession / turn / grant state (red line 13). Tokens live only in
//! memory; Rust re-checks envelope and counters independently of hooks.

use crate::error::err;
use crate::ipc::*;
use crate::paths::now_iso;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(8 * 3600);
pub const GRANT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
pub struct BuildSession {
    pub token: String,
    pub project_key: String,
    pub plan_ref: String,
    pub plan_sha256: Option<String>,
    pub policy: String,
    pub lead_model: String,
    pub manifest_version: u32,
    pub ceiling: Envelope,
    pub opened: Instant,
    pub opened_at: String,
    pub last_touch: Instant,
    pub consent_event_id: String,
}

#[derive(Debug, Clone)]
pub struct TurnState {
    pub turn: u32,
    pub kind: String,
    pub mode: String,
    pub headline: String,
    pub plan_step: Option<String>,
    pub build_session: Option<String>,
    pub envelope: Envelope,
    pub ceiling_source: String,
    pub counters: TurnCounters,
    pub checkpoint_done: bool,
    pub started: Instant,
    pub running: bool,
}

#[derive(Debug, Clone)]
pub struct Grant {
    pub id: String,
    pub project_key: String,
    pub kind: String,
    pub payload_sha256: String,
    pub action: Option<serde_json::Value>,
    pub created: Instant,
    pub consumed: bool,
}

#[derive(Default)]
pub struct SessionStore {
    pub build: HashMap<String, BuildSession>,
    pub turns: HashMap<String, TurnState>,
    pub grants: HashMap<String, Grant>,
    /// Session-open netlists for `diff.nets before: session_open`.
    pub session_open_nets: HashMap<String, sch_net::Netlist>,
}

fn token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// The bound every turn of a build session is measured against, derived by Rust from the *approved*
/// plan and the project's own files -- never from the webview's declaration (red line 13: the scope
/// always has an upper bound the model did not produce).
#[derive(Debug, Clone, Default)]
pub struct PlanCeiling {
    pub components_added: u32,
    pub components_deleted: u32,
    pub wires_max: Option<u32>,
    /// Every file the plan may write: the plan's own sheets plus the project's existing ones.
    pub sheets: Vec<String>,
    /// `verb` or `verb:<file>` entries, in the vocabulary `structural_key` produces.
    pub structural: Vec<String>,
    pub nets_renamable: Vec<String>,
}

/// Structural verbs an *incremental* (plan-less) build session may use without a scope card. Entering
/// Build incrementally is consent to draw inside this project, which includes adding a sheet symbol
/// and reshaping one; the deletion counters and the project-root canonicalisation are what bound it.
/// A plan session replaces this with the approved plan's own entries.
const INCREMENTAL_STRUCTURAL: &[&str] = &[
    "add_sheet",
    "create_sheet",
    "delete_sheet_pin",
    "resize_sheet",
];

fn all_ops() -> Vec<String> {
    sch_ops::CORE_OPS
        .iter()
        .chain(sch_ops::MACRO_OPS.iter())
        .map(|s| s.to_string())
        .collect()
}

impl SessionStore {
    pub fn open_build(
        &mut self,
        open: &BuildSessionOpen,
        ceiling_components: u32,
        // The approved plan's own bound, for a plan session (`commands::build_session_open`).
        plan: Option<&PlanCeiling>,
    ) -> BuildSessionInfo {
        // One build session per project: opening a new one closes the old.
        self.build.retain(|_, s| s.project_key != open.project_key);
        let ceiling = match plan {
            Some(p) => Envelope {
                sheets: p.sheets.clone(),
                // Not re-derived from the plan: closing `allowed_ops` under macro expansion is the
                // webview's `closeAllowedOps`, and a second, drifting copy of that table here would
                // refuse ops the human approved. The counters, sheets and structural entries below
                // are what actually bound the turn.
                allowed_ops: all_ops(),
                components_added_max: p.components_added,
                components_deleted_max: p.components_deleted,
                wires_max: p.wires_max,
                structural: p.structural.clone(),
                nets_renamable: p.nets_renamable.clone(),
                // The plan may re-pose and re-label the parts it draws; the settings ceiling is the floor
                // so a small plan still has the edit room an incremental session would have.
                properties_changed_max: p.components_added.max(ceiling_components),
                components_moved_max: p.components_added.max(ceiling_components),
                refs_editable: vec![],
                rails: vec![],
                interfaces: vec![],
                instance_designators: Default::default(),
                source: "plan_ceiling".into(),
            },
            None => Envelope {
                // Empty = every file inside the project root, which is exactly what entering an
                // incremental Build consents to (paths are canonicalised under the root anyway).
                sheets: vec![],
                allowed_ops: all_ops(),
                components_added_max: ceiling_components,
                components_deleted_max: 0,
                wires_max: None,
                structural: INCREMENTAL_STRUCTURAL
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                nets_renamable: vec![],
                // Twice the component ceiling: a bound from settings, not from the model. The webview
                // narrows each turn further (twice the parts the human named, never below four).
                properties_changed_max: ceiling_components.saturating_mul(2),
                components_moved_max: ceiling_components.saturating_mul(2),
                refs_editable: vec![],
                rails: vec![],
                interfaces: vec![],
                instance_designators: Default::default(),
                source: "session_ceiling".into(),
            },
        };
        let t = token();
        let now = Instant::now();
        let s = BuildSession {
            token: t.clone(),
            project_key: open.project_key.clone(),
            plan_ref: open.plan_ref.clone(),
            plan_sha256: open.plan_sha256.clone(),
            policy: open.policy.clone(),
            lead_model: open.lead_model.clone(),
            manifest_version: open.tool_manifest_version,
            ceiling: ceiling.clone(),
            opened: now,
            opened_at: now_iso(),
            last_touch: now,
            consent_event_id: open.consent_event_id.clone(),
        };
        self.build.insert(t.clone(), s);
        BuildSessionInfo {
            token: t,
            project_key: open.project_key.clone(),
            plan_ref: open.plan_ref.clone(),
            policy: open.policy.clone(),
            ceiling,
            opened_at: now_iso(),
            idle_timeout_min: (IDLE_TIMEOUT.as_secs() / 60) as u32,
            absolute_timeout_h: (ABSOLUTE_TIMEOUT.as_secs() / 3600) as u32,
        }
    }

    pub fn close_build(&mut self, token: &str) {
        self.build.remove(token);
        for t in self.turns.values_mut() {
            if t.build_session.as_deref() == Some(token) {
                t.build_session = None;
            }
        }
    }

    pub fn expire_project(&mut self, project_key: &str) -> Vec<String> {
        let toks: Vec<String> = self
            .build
            .values()
            .filter(|s| s.project_key == project_key)
            .map(|s| s.token.clone())
            .collect();
        for t in &toks {
            self.close_build(t);
        }
        toks
    }

    /// Validate a token for the project, refresh the idle timer.
    pub fn touch(
        &mut self,
        token: &str,
        project_key: Option<&str>,
    ) -> Result<&BuildSession, IpcError> {
        let now = Instant::now();
        let expired = match self.build.get(token) {
            None => {
                return Err(err("NO_BUILD_SESSION", "no build session")
                    .with_remediation("enter Build mode again"))
            }
            Some(s) => {
                now.duration_since(s.last_touch) > IDLE_TIMEOUT
                    || now.duration_since(s.opened) > ABSOLUTE_TIMEOUT
            }
        };
        if expired {
            self.build.remove(token);
            return Err(err("SESSION_EXPIRED", "the build session timed out")
                .with_remediation("enter Build mode again"));
        }
        let s = self.build.get_mut(token).unwrap();
        if let Some(pk) = project_key {
            if s.project_key != pk {
                return Err(err(
                    "NO_BUILD_SESSION",
                    "session belongs to another project",
                ));
            }
        }
        s.last_touch = now;
        Ok(s)
    }

    pub fn info(&self, token: &str) -> Option<BuildSessionInfo> {
        self.build.get(token).map(|s| BuildSessionInfo {
            token: s.token.clone(),
            project_key: s.project_key.clone(),
            plan_ref: s.plan_ref.clone(),
            policy: s.policy.clone(),
            ceiling: s.ceiling.clone(),
            opened_at: s.opened_at.clone(),
            idle_timeout_min: (IDLE_TIMEOUT.as_secs() / 60) as u32,
            absolute_timeout_h: (ABSOLUTE_TIMEOUT.as_secs() / 3600) as u32,
        })
    }

    pub fn begin_turn(&mut self, b: &TurnBegin, next_turn: u32) -> Result<TurnInfo, IpcError> {
        if !["question", "instruction"].contains(&b.kind.as_str()) {
            return Err(err("BAD_CONFIG", "turn kind must be question|instruction"));
        }
        if !["plan", "build", "review"].contains(&b.mode.as_str()) {
            return Err(err("MODE_MISMATCH", "unknown mode"));
        }
        let (envelope, source) = if b.mode == "build" {
            let tok = b
                .build_session
                .as_deref()
                .ok_or_else(|| err("NO_BUILD_SESSION", "Build mode requires a build session"))?;
            let s = self.touch(tok, Some(&b.project_key))?.clone();
            match &b.envelope {
                Some(e) => {
                    let mut e = e.clone();
                    // A scope grant (approved card) lets this turn's declaration exceed the ceiling,
                    // but only the exact declaration the human saw: the grant carries the sha256 of
                    // this envelope's canonical JSON, the same string the card and the recorded
                    // consent event were built over. An unbound or stale approval widens nothing.
                    let widened_ok = match &b.grant {
                        Some(g) => {
                            let pk = b.project_key.clone();
                            let want = e.canonical_sha256();
                            match self.consume_grant(g, &pk, "scope", Some(&want)) {
                                Ok(_) => true,
                                Err(refused) => {
                                    crate::log::write(
                                        "warn",
                                        &format!(
                                            "scope grant not honoured: {} {}",
                                            refused.code, refused.message
                                        ),
                                        &refused.req_id,
                                    );
                                    false
                                }
                            }
                        }
                        None => false,
                    };
                    // The declaration never exceeds the session ceiling (settings for an incremental
                    // session, the approved plan for a plan session) unless a scope grant widens it.
                    if !widened_ok {
                        narrow_to_ceiling(&mut e, &s.ceiling);
                    }
                    let src = e.source.clone();
                    (e, src)
                }
                None => (s.ceiling.clone(), "session_ceiling".into()),
            }
        } else {
            (Envelope::default(), "none".into())
        };
        let inherited = b.inherit_from_turn.and_then(|n| {
            self.turns
                .get(&b.project_key)
                .filter(|t| t.turn == n)
                .cloned()
        });
        // A redeclare (approved scope / structural card mid-turn) widens the running turn: the checkpoint
        // already taken and the accumulated counters carry over, only the envelope changes. Rebuilding the
        // turn from scratch refused the very apply the human approved (CHECKPOINT_FAILED) and restarted the
        // second-line accounting at zero.
        let carried = if b.redeclare {
            self.turns
                .get(&b.project_key)
                .filter(|t| t.turn == next_turn && t.running)
                .map(|t| (t.counters.clone(), t.checkpoint_done, t.started))
        } else {
            None
        };
        let t = TurnState {
            turn: next_turn,
            kind: b.kind.clone(),
            mode: b.mode.clone(),
            headline: b.headline.clone(),
            plan_step: b.plan_step.clone(),
            build_session: b.build_session.clone(),
            envelope: inherited.map(|i| i.envelope).unwrap_or(envelope),
            ceiling_source: source,
            counters: carried
                .as_ref()
                .map(|c| c.0.clone())
                .unwrap_or(TurnCounters {
                    turn: next_turn,
                    components_added: 0,
                    components_deleted: 0,
                    wires_added: 0,
                    components_moved: 0,
                    properties_changed: 0,
                    refs_created: Vec::new(),
                    apply_count: 0,
                    tool_calls: 0,
                    billed_tokens: 0,
                    cost_usd: 0.0,
                    wall_active_ms: 0,
                }),
            checkpoint_done: carried.as_ref().map(|c| c.1).unwrap_or(false),
            started: carried.as_ref().map(|c| c.2).unwrap_or_else(Instant::now),
            running: true,
        };
        let info = TurnInfo {
            turn: t.turn,
            effective_envelope: t.envelope.clone(),
            ceiling_source: t.ceiling_source.clone(),
            checkpoint_pending: b.mode == "build" && b.kind == "instruction",
        };
        self.turns.insert(b.project_key.clone(), t);
        Ok(info)
    }

    pub fn end_turn(&mut self, project_key: &str, turn: u32) -> Result<TurnCounters, IpcError> {
        let t = self
            .turns
            .get_mut(project_key)
            .ok_or_else(|| err("MODE_MISMATCH", "no running turn"))?;
        if t.turn != turn {
            return Err(err(
                "MODE_MISMATCH",
                format!("turn {turn} is not the running turn {}", t.turn),
            ));
        }
        t.running = false;
        t.counters.wall_active_ms = t.started.elapsed().as_millis() as u64;
        Ok(t.counters.clone())
    }

    /// Authorise a D-tier engine request. Returns the running turn (for counters).
    pub fn authorize_d(
        &mut self,
        project_key: &str,
        auth: &Auth,
        grant_kind: &str,
    ) -> Result<DAuth, IpcError> {
        if let Some(g) = &auth.grant {
            // The op-list binding is checked by the caller before it gets here (`engine.rs`
            // matches `action.ops_sha256` against the list it is about to apply).
            let grant = self.consume_grant(g, project_key, grant_kind, None)?;
            return Ok(DAuth::Grant(grant));
        }
        let tok = auth.build_session.as_deref().ok_or_else(|| {
            err(
                "NO_BUILD_SESSION",
                "write requires a build session or a grant",
            )
            .with_remediation("enter Build mode")
        })?;
        self.touch(tok, Some(project_key))?;
        let role = auth.role.as_deref().unwrap_or("lead");
        if role != "lead" && !(role == "sourcer" && grant_kind == "parts_convert") {
            return Err(err("POLICY_DENY_P1", "only the Lead agent may write"));
        }
        let t = self
            .turns
            .get(project_key)
            .ok_or_else(|| err("MODE_MISMATCH", "no running turn"))?;
        if !t.running {
            return Err(err("MODE_MISMATCH", "the turn has ended"));
        }
        if t.mode != "build" {
            return Err(err(
                "MODE_MISMATCH",
                "writes are only allowed in Build mode",
            ));
        }
        if t.kind != "instruction" {
            return Err(err(
                "POLICY_DENY_P0",
                "a question turn cannot write design files",
            )
            .with_remediation("begin an instruction turn"));
        }
        if t.build_session.as_deref() != Some(tok) {
            return Err(err(
                "NO_BUILD_SESSION",
                "turn was begun under a different session",
            ));
        }
        if !t.checkpoint_done {
            return Err(err("CHECKPOINT_FAILED", "no checkpoint for this turn")
                .with_remediation("create the turn checkpoint before writing"));
        }
        Ok(DAuth::Session(t.turn))
    }

    pub fn create_grant(&mut self, r: &GrantRequest) -> GrantInfo {
        let id = token();
        self.grants.insert(
            id.clone(),
            Grant {
                id: id.clone(),
                project_key: r.project_key.clone(),
                kind: r.kind.clone(),
                payload_sha256: r.payload_sha256.clone(),
                action: r.action.clone(),
                created: Instant::now(),
                consumed: false,
            },
        );
        GrantInfo {
            id,
            kind: r.kind.clone(),
            expires_at: (chrono::Utc::now() + chrono::Duration::from_std(GRANT_TTL).unwrap())
                .to_rfc3339(),
        }
    }

    /// The `action` a grant was created with (None when unknown or absent); does not consume it.
    pub fn grant_action(&self, id: &str) -> Option<serde_json::Value> {
        self.grants.get(id).and_then(|g| g.action.clone())
    }

    /// Spend a single-use grant. `expect_sha` is the payload the caller is about to act on: a grant
    /// is an approval of *one* thing, so a caller that can name that thing (the canonical widened
    /// envelope, an op-list sha) passes it here and a grant recorded over anything else is refused
    /// rather than silently reused. `None` is only for callers whose binding is checked elsewhere
    /// (`engine.rs` matches `action.ops_sha256` before consuming).
    pub fn consume_grant(
        &mut self,
        id: &str,
        project_key: &str,
        kind: &str,
        expect_sha: Option<&str>,
    ) -> Result<Grant, IpcError> {
        let g = self
            .grants
            .get_mut(id)
            .ok_or_else(|| err("GRANT_INVALID", "unknown grant"))?;
        if g.consumed {
            return Err(err("GRANT_INVALID", "grant already used"));
        }
        if g.created.elapsed() > GRANT_TTL {
            self.grants.remove(id);
            return Err(
                err("GRANT_EXPIRED", "grant expired").with_remediation("approve the card again")
            );
        }
        if g.project_key != project_key || g.kind != kind {
            return Err(err(
                "GRANT_INVALID",
                format!("grant is for {} / {}", g.kind, g.project_key),
            ));
        }
        if let Some(exp) = expect_sha {
            if g.payload_sha256 != exp {
                return Err(err(
                    "GRANT_INVALID",
                    "the approval was recorded over a different payload",
                )
                .with_remediation("approve the card again for this exact request"));
            }
        }
        g.consumed = true;
        Ok(g.clone())
    }

    pub fn turn_mut(&mut self, project_key: &str) -> Option<&mut TurnState> {
        self.turns.get_mut(project_key)
    }
}

#[derive(Debug)]
pub enum DAuth {
    Session(u32),
    Grant(Grant),
}

/// Pure envelope check over an expanded op-list, relative to the counters
/// accumulated since the turn checkpoint (P2 as re-checked by Rust).
/// `power`, `power.kicad_sch` and `sub/power.kicad_sch` name the same sheet for envelope purposes
/// (op-lists refer to sheets by name, envelopes by file).
pub fn sheet_matches(env_entry: &str, s: &str) -> bool {
    if env_entry == s {
        return true;
    }
    let a = sheet_segments(env_entry);
    let b = sheet_segments(s);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    // Once either side carries a directory, the comparison is on the whole project-relative path:
    // comparing stems alone let an envelope that approved `power.kicad_sch` authorise a write to
    // `sub/power.kicad_sch`, a different file the human never saw.
    if a.len() > 1 || b.len() > 1 {
        return a == b;
    }
    a[0] == b[0]
}

/// Project-relative path segments of a sheet reference, with the `.kicad_sch` suffix off the last
/// one: `power`, `power.kicad_sch` and the instance path `/power/` all give `["power"]`, while
/// `sub/power.kicad_sch` gives `["sub", "power"]`.
fn sheet_segments(x: &str) -> Vec<&str> {
    let mut v: Vec<&str> = x.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if let Some(last) = v.last_mut() {
        if let Some(stem) = last.strip_suffix(".kicad_sch") {
            *last = stem;
        }
    }
    v
}

/// Does one ceiling structural entry permit one declared entry? Entries are `verb` or `verb:<file>`;
/// `create_sheet` and `add_sheet` are the same action under two names (the plan vocabulary and the
/// op name). A bare ceiling verb permits the verb on any file the `sheets` dimension still allows; a
/// qualified ceiling entry permits only that file.
fn structural_covers(ceiling: &str, decl: &str) -> bool {
    if ceiling == decl {
        return true;
    }
    let split = |x: &str| -> (String, Option<String>) {
        match x.find(':') {
            Some(i) => (
                x[..i].trim().to_string(),
                Some(x[i + 1..].trim().to_string()).filter(|f| !f.is_empty()),
            ),
            None => (x.trim().to_string(), None),
        }
    };
    let verb = |v: String| {
        if v == "create_sheet" {
            "add_sheet".to_string()
        } else {
            v
        }
    };
    let (cv, cf) = split(ceiling);
    let (dv, df) = split(decl);
    if verb(cv) != verb(dv) {
        return false;
    }
    match (cf, df) {
        (None, _) => true,
        // An under-qualified declaration is not a human decision either way: it is satisfied by the
        // ceiling's own entry, which is the string the effective envelope then carries.
        (Some(_), None) => true,
        (Some(a), Some(b)) => sheet_matches(&a, &b),
    }
}

/// `decl` narrowed to `ceiling` for a dimension where an empty list means "no restriction"
/// (`sheets`, `allowed_ops`). An empty ceiling imposes nothing; a declaration that lists nothing
/// inherits the ceiling; a declaration disjoint from the ceiling falls back to the ceiling rather
/// than to the empty list, which `check_envelope` would read as "everything is permitted".
fn narrow_open(
    ceiling: &[String],
    decl: &[String],
    eq: impl Fn(&str, &str) -> bool,
) -> Vec<String> {
    if ceiling.is_empty() {
        return decl.to_vec();
    }
    if decl.is_empty() {
        return ceiling.to_vec();
    }
    let kept: Vec<String> = decl
        .iter()
        .filter(|d| ceiling.iter().any(|c| eq(c, d)))
        .cloned()
        .collect();
    if kept.is_empty() {
        ceiling.to_vec()
    } else {
        kept
    }
}

/// `decl` narrowed to `ceiling` for a dimension where an empty list means "nothing is permitted"
/// (`structural`, `nets_renamable`). The kept entries are the *ceiling's* spellings, so the
/// effective envelope never carries a string the ceiling does not (the same rule as the webview's
/// `intersectEnvelope`). Widening past this needs a `scope` grant.
fn narrow_closed(
    ceiling: &[String],
    decl: &[String],
    covers: impl Fn(&str, &str) -> bool,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for d in decl {
        for c in ceiling {
            if covers(c, d) && !out.contains(c) {
                out.push(c.clone());
            }
        }
    }
    out
}

/// Rust's second envelope check (red line 13): *every* dimension of a model-authored declaration is
/// narrowed to the ceiling the human approved, not only the two component counters. A declaration
/// wider than the ceiling is narrowed, never refused -- the webview's own hook raises the scope card
/// for it, and an approved card comes back as a `scope` grant bound to the widened envelope.
pub fn narrow_to_ceiling(e: &mut Envelope, c: &Envelope) {
    e.components_added_max = e.components_added_max.min(c.components_added_max);
    e.components_deleted_max = e.components_deleted_max.min(c.components_deleted_max);
    e.wires_max = match (c.wires_max, e.wires_max) {
        (Some(cw), Some(dw)) => Some(dw.min(cw)),
        (Some(cw), None) => Some(cw),
        (None, dw) => dw,
    };
    e.sheets = narrow_open(&c.sheets, &e.sheets, sheet_matches);
    e.allowed_ops = narrow_open(&c.allowed_ops, &e.allowed_ops, |a, b| a == b);
    e.structural = narrow_closed(&c.structural, &e.structural, structural_covers);
    e.nets_renamable = narrow_closed(&c.nets_renamable, &e.nets_renamable, |a, b| a == b);
    e.properties_changed_max = e.properties_changed_max.min(c.properties_changed_max);
    e.components_moved_max = e.components_moved_max.min(c.components_moved_max);
    // An unrestricted ceiling (the usual session ceiling) keeps whatever the webview derived from the
    // human's message: naming parts only narrows. A restricting ceiling admits a subset of its own.
    if !c.refs_editable.is_empty() {
        // Kept in the ceiling's spelling (the human's), like `narrow_closed`; an empty or disjoint
        // declaration falls back to the ceiling, like `narrow_open`.
        let kept: Vec<String> = c
            .refs_editable
            .iter()
            .filter(|r| e.refs_editable.iter().any(|d| d.eq_ignore_ascii_case(r)))
            .cloned()
            .collect();
        e.refs_editable = if kept.is_empty() {
            c.refs_editable.clone()
        } else {
            kept
        };
    }
}

/// What one op-list spends of the envelope's budgets, counted from the expanded ops before the
/// write (the numbers `check_envelope` compared against the maxima).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnvelopeUse {
    pub added: u32,
    pub deleted: u32,
    pub wires: u32,
    pub moved: u32,
    pub properties: u32,
}

/// The parts an op-list may edit or move under `refs_editable`: the named ones, the ones this turn
/// already placed, and the ones the same list places. `None` when the envelope does not restrict.
fn editable_refs(
    env: &Envelope,
    counters: &TurnCounters,
    expanded: &sch_ops::Expanded,
) -> Option<std::collections::BTreeSet<String>> {
    if env.refs_editable.is_empty() {
        return None;
    }
    let mut set: std::collections::BTreeSet<String> = env
        .refs_editable
        .iter()
        .chain(counters.refs_created.iter())
        .map(|r| r.to_ascii_uppercase())
        .collect();
    for eo in &expanded.ops {
        if let sch_ops::Op::PlaceComponent { designator, .. } = &eo.op {
            set.insert(designator.to_ascii_uppercase());
        }
    }
    Some(set)
}

fn reference_refused(env: &Envelope, op: &str, what: &str) -> IpcError {
    err(
        "ENVELOPE_REFERENCE",
        format!("{op} on {what}: this turn may edit or move only the parts the user named"),
    )
    .with_remediation(format!(
        "the user's message named {}; edit or move only those (or parts placed in this turn), address them by designator, or ask the user to include {what}",
        env.refs_editable.join(", ")
    ))
    .with_evidence(serde_json::json!({
        "reference": what,
        "op": op,
        "refs_editable": env.refs_editable,
    }))
}

pub fn check_envelope(
    env: &Envelope,
    counters: &TurnCounters,
    expanded: &sch_ops::Expanded,
    target_rel: &str,
    sheets_rel: &[String],
    // uuids of the symbols currently in the project: a `delete_object` naming one of them is a component deletion.
    symbol_uuids: &std::collections::BTreeSet<String>,
    // uuid -> file of every hierarchical sheet symbol: deleting one is a structural `delete_sheet:<file>`.
    sheet_uuids: &std::collections::BTreeMap<String, String>,
) -> Result<EnvelopeUse, IpcError> {
    let mut added = 0u32;
    let mut deleted = 0u32;
    let mut wires = 0u32;
    let mut moved = 0u32;
    let mut properties = 0u32;
    let editable = editable_refs(env, counters, expanded);
    // A designator-addressed edit or move is checked against the editable set; a uuid-only address
    // cannot be, so under a restricted envelope it is refused rather than let through unverified.
    let ref_ok = |op: &str, designator: Option<&String>| -> Result<(), IpcError> {
        let Some(set) = &editable else { return Ok(()) };
        match designator {
            Some(d) if set.contains(&d.to_ascii_uppercase()) => Ok(()),
            Some(d) => Err(reference_refused(env, op, d)),
            None => Err(reference_refused(env, op, "a uuid-addressed part")),
        }
    };
    if !env.sheets.is_empty() {
        for s in std::iter::once(&target_rel.to_string()).chain(sheets_rel.iter()) {
            if !env.sheets.iter().any(|e| sheet_matches(e, s)) {
                return Err(err(
                    "ENVELOPE_SHEET",
                    format!("{s} is not in the approved sheets"),
                )
                .with_evidence(serde_json::json!({"sheet": s})));
            }
        }
    }
    for eo in &expanded.ops {
        let name = eo.op.name();
        if !env.allowed_ops.is_empty() && !env.allowed_ops.iter().any(|a| a == name) {
            // Naming only the rejected op left the model to guess the rest of the list; print it,
            // so the retry can be built out of ops that are actually approved.
            return Err(err("ENVELOPE_OP", format!("{name} is not in allowed_ops"))
                .with_remediation(format!(
                    "the approved plan step allows only these ops: {}. Rewrite the op-list with those, or ask the user to widen the plan",
                    env.allowed_ops.join(", ")
                ))
                .with_evidence(serde_json::json!({
                    "op": name,
                    "index": eo.authored_index,
                    "allowed_ops": env.allowed_ops,
                })));
        }
        if eo.op.is_structural() {
            let key = structural_key(&eo.op);
            // `add_sheet:<file>` is also satisfied by the plan vocabulary `create_sheet:<file>`.
            let alt = key.replacen("add_sheet:", "create_sheet:", 1);
            if !env
                .structural
                .iter()
                .any(|s| s == &key || s == name || s == &alt)
            {
                return Err(err(
                    "ENVELOPE_STRUCTURAL",
                    format!("structural op {key} not listed in the envelope"),
                )
                .with_evidence(serde_json::json!({"structural": key})));
            }
        }
        match &eo.op {
            // Power ports and PWR_FLAG are net anchors, not BOM components.
            sch_ops::Op::PlaceComponent {
                lib_id, designator, ..
            } if !(lib_id.starts_with("power:") || designator.starts_with('#')) => {
                added += 1;
            }
            sch_ops::Op::DeleteComponent { .. } => deleted += 1,
            // delete_object by uuid: the engine knows whether that uuid is a symbol; labels / wires / junctions are free.
            sch_ops::Op::DeleteObject { uuid: Some(u), .. } if symbol_uuids.contains(u) => {
                deleted += 1
            }
            sch_ops::Op::DeleteObject { uuid: Some(u), .. } if sheet_uuids.contains_key(u) => {
                let file = &sheet_uuids[u];
                let key = format!("delete_sheet:{file}");
                if !env
                    .structural
                    .iter()
                    .any(|s| s == &key || s == "delete_sheet")
                {
                    return Err(err(
                        "ENVELOPE_STRUCTURAL",
                        format!(
                            "deleting sheet {file} is structural and not listed in the envelope"
                        ),
                    )
                    .with_evidence(serde_json::json!({"structural": key})));
                }
            }
            sch_ops::Op::AddWire { .. }
            | sch_ops::Op::RouteNet { .. }
            | sch_ops::Op::AddBus { .. } => wires += 1,
            sch_ops::Op::RenameNet { old_name, .. }
                if !env.nets_renamable.iter().any(|n| n == old_name) =>
            {
                return Err(err(
                    "ENVELOPE_RENAME",
                    format!("{old_name} is not renamable in this envelope"),
                )
                .with_evidence(serde_json::json!({"rename": old_name})));
            }
            sch_ops::Op::SetComponentParameters {
                new_designator,
                parameters,
                ..
            } if new_designator.is_some()
                || parameters
                    .keys()
                    .any(|k| k.eq_ignore_ascii_case("reference")) =>
            {
                return Err(err(
                    "ENVELOPE_REFERENCE",
                    "set_component_parameters may not change the reference",
                ));
            }
            sch_ops::Op::SetComponentParameters { designator, .. }
            | sch_ops::Op::SetComponentAttributes { designator, .. } => {
                ref_ok(name, Some(designator))?;
                properties += 1;
            }
            sch_ops::Op::MoveComponent { designator, .. }
            | sch_ops::Op::SetComponentTransform { designator, .. } => {
                // A uuid-only address is fine when nothing is restricted; `ref_ok` decides.
                ref_ok(name, designator.as_ref())?;
                moved += 1;
            }
            sch_ops::Op::ArrangeGroup { designators, .. } => {
                // With a designator list the fan-out is known here; without one the engine picks the
                // parts inside the region, so the pre-write count is one and the engine's own count
                // is what the turn accumulates (`engine.rs`). Under `refs_editable` the list is required.
                match designators {
                    Some(ds) => {
                        for d in ds {
                            ref_ok(name, Some(d))?;
                        }
                        moved += ds.len() as u32;
                    }
                    None => {
                        ref_ok(name, None)?;
                        moved += 1;
                    }
                }
            }
            _ => {}
        }
    }
    if counters.properties_changed + properties > env.properties_changed_max {
        return Err(err("SCOPE_WIDEN", format!("properties changed would reach {} > {}", counters.properties_changed + properties, env.properties_changed_max))
            .with_evidence(serde_json::json!({"budget": "properties_changed", "have": counters.properties_changed, "add": properties, "max": env.properties_changed_max})));
    }
    if counters.components_moved + moved > env.components_moved_max {
        return Err(err("SCOPE_WIDEN", format!("components moved would reach {} > {}", counters.components_moved + moved, env.components_moved_max))
            .with_evidence(serde_json::json!({"budget": "components_moved", "have": counters.components_moved, "add": moved, "max": env.components_moved_max})));
    }
    if counters.components_added + added > env.components_added_max {
        return Err(err("SCOPE_WIDEN", format!("components added would reach {} > {}", counters.components_added + added, env.components_added_max))
            .with_evidence(serde_json::json!({"budget": "components_added", "have": counters.components_added, "add": added, "max": env.components_added_max})));
    }
    if counters.components_deleted + deleted > env.components_deleted_max {
        return Err(err("SCOPE_WIDEN", format!("components deleted would reach {} > {}", counters.components_deleted + deleted, env.components_deleted_max))
            .with_evidence(serde_json::json!({"budget": "components_deleted", "have": counters.components_deleted, "add": deleted, "max": env.components_deleted_max})));
    }
    if let Some(wmax) = env.wires_max {
        if counters.wires_added + wires > wmax {
            return Err(err("SCOPE_WIDEN", "wire budget exceeded")
                .with_evidence(serde_json::json!({"budget": "wires", "max": wmax})));
        }
    }
    Ok(EnvelopeUse {
        added,
        deleted,
        wires,
        moved,
        properties,
    })
}

fn structural_key(op: &sch_ops::Op) -> String {
    match op {
        sch_ops::Op::AddSheet { file, .. } => format!("add_sheet:{file}"),
        sch_ops::Op::RenameNet { old_name, .. } => format!("rename_net:{old_name}"),
        sch_ops::Op::DeleteComponent { designator, .. } => format!("delete_component:{designator}"),
        other => other.name().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(store: &mut SessionStore) -> String {
        store
            .open_build(
                &BuildSessionOpen {
                    project_key: "p".into(),
                    plan_ref: "incremental".into(),
                    plan_sha256: None,
                    policy: "review".into(),
                    consent_event_id: "c".into(),
                    lead_model: "m".into(),
                    tool_manifest_version: 1,
                },
                24,
                None,
            )
            .token
    }

    fn begin(store: &mut SessionStore, tok: &str, kind: &str, mode: &str) -> TurnInfo {
        store
            .begin_turn(
                &TurnBegin {
                    project_key: "p".into(),
                    build_session: Some(tok.into()),
                    kind: kind.into(),
                    headline: "h".into(),
                    plan_step: None,
                    envelope: None,
                    inherit_from_turn: None,
                    mode: mode.into(),
                    grant: None,
                    redeclare: false,
                },
                1,
            )
            .unwrap()
    }

    fn plan_ceiling() -> PlanCeiling {
        PlanCeiling {
            components_added: 12,
            components_deleted: 1,
            wires_max: Some(30),
            sheets: vec!["power.kicad_sch".into(), "sub/analog.kicad_sch".into()],
            structural: vec!["add_sheet:power.kicad_sch".into()],
            nets_renamable: vec!["GLB".into()],
        }
    }

    fn open_plan(store: &mut SessionStore, c: &PlanCeiling) -> String {
        store
            .open_build(
                &BuildSessionOpen {
                    project_key: "p".into(),
                    plan_ref: "plan:p1@2".into(),
                    plan_sha256: Some("sha".into()),
                    policy: "review".into(),
                    consent_event_id: "c".into(),
                    lead_model: "m".into(),
                    tool_manifest_version: 1,
                },
                24,
                Some(c),
            )
            .token
    }

    fn declare(
        store: &mut SessionStore,
        tok: &str,
        env: Envelope,
        grant: Option<String>,
    ) -> Result<TurnInfo, IpcError> {
        store.begin_turn(
            &TurnBegin {
                project_key: "p".into(),
                build_session: Some(tok.into()),
                kind: "instruction".into(),
                headline: "h".into(),
                plan_step: None,
                envelope: Some(env),
                inherit_from_turn: None,
                mode: "build".into(),
                grant,
                redeclare: false,
            },
            1,
        )
    }

    /// P1-1: Rust's second envelope check covered only the two component counters, so `sheets`,
    /// `allowed_ops`, `structural`, `nets_renamable` and `wires_max` were taken from the webview
    /// verbatim. Every dimension is now narrowed to the ceiling the human approved.
    #[test]
    fn every_envelope_dimension_is_narrowed_to_the_ceiling() {
        let c = plan_ceiling();
        let mut s = SessionStore::default();
        let tok = open_plan(&mut s, &c);
        let wide = Envelope {
            // A sibling file, a file the plan never listed, and one it did.
            sheets: vec![
                "power.kicad_sch".into(),
                "secrets.kicad_sch".into(),
                "sub/analog.kicad_sch".into(),
            ],
            allowed_ops: vec!["place_component".into(), "not_an_op".into()],
            components_added_max: 999,
            components_deleted_max: 999,
            wires_max: Some(9999),
            structural: vec![
                "add_sheet:power.kicad_sch".into(),
                "add_sheet:secrets.kicad_sch".into(),
            ],
            nets_renamable: vec!["GLB".into(), "VBUS".into()],
            source: "model".into(),
            ..Default::default()
        };
        let e = declare(&mut s, &tok, wide, None)
            .unwrap()
            .effective_envelope;
        assert_eq!(
            e.sheets,
            vec!["power.kicad_sch".to_string(), "sub/analog.kicad_sch".into()],
            "a file the plan never listed is dropped"
        );
        assert_eq!(
            e.allowed_ops,
            vec!["place_component".to_string()],
            "an op outside the vocabulary is dropped"
        );
        assert_eq!(e.components_added_max, 12);
        assert_eq!(e.components_deleted_max, 1);
        assert_eq!(e.wires_max, Some(30));
        assert_eq!(
            e.structural,
            vec!["add_sheet:power.kicad_sch".to_string()],
            "a structural entry for a file the ceiling does not carry is dropped"
        );
        assert_eq!(
            e.nets_renamable,
            vec!["GLB".to_string()],
            "a net the plan never made renamable is dropped"
        );
    }

    /// An empty ceiling dimension must never read as "everything": `sheets` and `allowed_ops` are
    /// open (empty = unrestricted, so an incremental session may touch any file in the project),
    /// `structural` and `nets_renamable` are closed (empty = nothing without a card).
    #[test]
    fn incremental_ceiling_is_open_on_files_and_closed_on_structure() {
        let mut s = SessionStore::default();
        let tok = open(&mut s);
        let decl = Envelope {
            sheets: vec!["anything.kicad_sch".into()],
            structural: vec!["add_sheet:new.kicad_sch".into()],
            nets_renamable: vec!["GLB".into()],
            components_added_max: 5,
            source: "model".into(),
            ..Default::default()
        };
        let e = declare(&mut s, &tok, decl, None)
            .unwrap()
            .effective_envelope;
        assert_eq!(e.sheets, vec!["anything.kicad_sch".to_string()]);
        assert_eq!(
            e.structural,
            vec!["add_sheet".to_string(), "create_sheet".into()],
            "adding a sheet is inside an incremental session, spelled as the ceiling's own entries"
        );
        assert!(
            e.nets_renamable.is_empty(),
            "renaming a net in an incremental session needs a scope card"
        );
    }

    /// A declaration that shares nothing with the ceiling falls back to the ceiling, never to the
    /// empty list -- `check_envelope` reads an empty `sheets` as "no restriction at all".
    #[test]
    fn a_disjoint_declaration_does_not_become_unrestricted() {
        let c = plan_ceiling();
        let mut s = SessionStore::default();
        let tok = open_plan(&mut s, &c);
        let decl = Envelope {
            sheets: vec!["elsewhere.kicad_sch".into()],
            components_added_max: 1,
            source: "model".into(),
            ..Default::default()
        };
        let e = declare(&mut s, &tok, decl, None)
            .unwrap()
            .effective_envelope;
        assert_eq!(e.sheets, c.sheets);
    }

    /// P1-2: a `scope` grant used to be bound to nothing, so any live one widened any envelope for
    /// ten minutes. It now carries the canonical sha of the envelope it was approved for.
    #[test]
    fn a_scope_grant_only_widens_the_envelope_it_was_approved_for() {
        let c = plan_ceiling();
        let mut s = SessionStore::default();
        let tok = open_plan(&mut s, &c);
        let approved = Envelope {
            sheets: vec!["power.kicad_sch".into()],
            allowed_ops: vec!["place_component".into()],
            components_added_max: 40,
            source: "approved_scope".into(),
            ..Default::default()
        };
        let other = Envelope {
            sheets: vec!["secrets.kicad_sch".into()],
            allowed_ops: vec!["delete_component".into()],
            components_added_max: 40,
            components_deleted_max: 40,
            source: "approved_scope".into(),
            ..Default::default()
        };
        let grant = |s: &mut SessionStore, sha: String| {
            s.create_grant(&GrantRequest {
                project_key: "p".into(),
                kind: "scope".into(),
                payload_sha256: sha,
                consent_event_id: "c".into(),
                action: None,
            })
            .id
        };

        // Spent on a different envelope: narrowed as if there were no approval at all.
        let g = grant(&mut s, approved.canonical_sha256());
        let e = declare(&mut s, &tok, other.clone(), Some(g.clone()))
            .unwrap()
            .effective_envelope;
        assert_eq!(e.components_added_max, 12, "{e:?}");
        assert_eq!(e.components_deleted_max, 1);
        assert_eq!(e.sheets, c.sheets, "the other file never enters scope");
        assert!(
            !s.grants.get(&g).unwrap().consumed,
            "a refused grant is not spent: the human's approval still stands for what they approved"
        );

        // Spent on the envelope it names: honoured verbatim.
        let e = declare(&mut s, &tok, approved.clone(), Some(g.clone()))
            .unwrap()
            .effective_envelope;
        assert_eq!(e.components_added_max, 40);
        assert_eq!(e.sheets, vec!["power.kicad_sch".to_string()]);
        // Single use.
        let e = declare(&mut s, &tok, approved.clone(), Some(g))
            .unwrap()
            .effective_envelope;
        assert_eq!(e.components_added_max, 12, "the grant is spent");
    }

    /// P2-4: an envelope entry and a project path only name the same sheet when the path agrees;
    /// stem-only matching let `power.kicad_sch` authorise a write to `sub/power.kicad_sch`.
    #[test]
    fn sheet_matching_compares_paths_not_stems() {
        assert!(sheet_matches("power.kicad_sch", "power"));
        assert!(sheet_matches("power", "power.kicad_sch"));
        assert!(sheet_matches("power.kicad_sch", "/power/"));
        assert!(sheet_matches("sub/power.kicad_sch", "sub/power"));
        assert!(!sheet_matches("power.kicad_sch", "sub/power.kicad_sch"));
        assert!(!sheet_matches("sub/power.kicad_sch", "power.kicad_sch"));
        assert!(!sheet_matches("a/power.kicad_sch", "b/power.kicad_sch"));
        assert!(!sheet_matches("power.kicad_sch", "power2"));
        assert!(!sheet_matches("power.kicad_sch", "/"));
    }

    /// The canonical envelope serialisation a scope grant is bound to has to be the same string on
    /// both sides of the IPC boundary; `tests/fixtures/envelope-canonical.json` pins it, and
    /// `src/agent/__tests__/envelope-canonical.test.ts` checks the webview against the same file.
    #[test]
    fn canonical_envelope_matches_the_shared_fixture() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/envelope-canonical.json");
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        let env: Envelope = serde_json::from_value(v["envelope"].clone()).unwrap();
        assert_eq!(env.canonical_json(), v["canonical_json"].as_str().unwrap());
        assert_eq!(env.canonical_sha256(), v["sha256"].as_str().unwrap());
    }

    #[test]
    fn redeclare_keeps_checkpoint_and_counters() {
        let mut s = SessionStore::default();
        let tok = open(&mut s);
        let first = begin(&mut s, &tok, "instruction", "build");
        {
            let t = s.turn_mut("p").unwrap();
            t.checkpoint_done = true;
            t.counters.components_added = 3;
            t.counters.apply_count = 1;
        }
        let g = s.create_grant(&GrantRequest {
            project_key: "p".into(),
            kind: "scope".into(),
            payload_sha256: "x".into(),
            consent_event_id: "c".into(),
            action: None,
        });
        let env = Envelope {
            components_added_max: 12,
            ..Default::default()
        };
        let info = s
            .begin_turn(
                &TurnBegin {
                    project_key: "p".into(),
                    build_session: Some(tok.clone()),
                    kind: "instruction".into(),
                    headline: "h".into(),
                    plan_step: None,
                    envelope: Some(env),
                    inherit_from_turn: None,
                    mode: "build".into(),
                    grant: Some(g.id),
                    redeclare: true,
                },
                first.turn,
            )
            .unwrap();
        assert_eq!(info.turn, first.turn);
        assert_eq!(info.effective_envelope.components_added_max, 12);
        let t = s.turns.get("p").unwrap();
        assert!(
            t.checkpoint_done,
            "the checkpoint taken before the approval carries over"
        );
        assert_eq!(t.counters.components_added, 3);
        assert_eq!(t.counters.apply_count, 1);
        let auth = Auth {
            build_session: Some(tok.clone()),
            grant: None,
            role: Some("lead".into()),
        };
        assert!(
            s.authorize_d("p", &auth, "apply").is_ok(),
            "the approved apply proceeds without a second checkpoint"
        );
    }

    #[test]
    fn question_turn_denies_writes_and_checkpoint_required() {
        let mut s = SessionStore::default();
        let tok = open(&mut s);
        begin(&mut s, &tok, "question", "build");
        let auth = Auth {
            build_session: Some(tok.clone()),
            grant: None,
            role: Some("lead".into()),
        };
        assert_eq!(
            s.authorize_d("p", &auth, "apply").unwrap_err().code,
            "POLICY_DENY_P0"
        );
        begin(&mut s, &tok, "instruction", "build");
        assert_eq!(
            s.authorize_d("p", &auth, "apply").unwrap_err().code,
            "CHECKPOINT_FAILED"
        );
        s.turn_mut("p").unwrap().checkpoint_done = true;
        assert!(s.authorize_d("p", &auth, "apply").is_ok());
        let sub = Auth {
            role: Some("drafter".into()),
            ..auth.clone()
        };
        assert_eq!(
            s.authorize_d("p", &sub, "apply").unwrap_err().code,
            "POLICY_DENY_P1"
        );
        assert_eq!(
            s.authorize_d("p", &Auth::default(), "apply")
                .unwrap_err()
                .code,
            "NO_BUILD_SESSION"
        );
    }

    #[test]
    fn grants_are_single_use_and_kind_checked() {
        let mut s = SessionStore::default();
        let g = s.create_grant(&GrantRequest {
            project_key: "p".into(),
            kind: "rollback".into(),
            payload_sha256: "x".into(),
            consent_event_id: "c".into(),
            action: None,
        });
        assert_eq!(
            s.consume_grant(&g.id, "p", "waiver", None)
                .unwrap_err()
                .code,
            "GRANT_INVALID"
        );
        // A caller that names the payload it is about to act on gets a grant recorded over anything
        // else refused, and the approval is left standing for what it was actually given for.
        assert_eq!(
            s.consume_grant(&g.id, "p", "rollback", Some("y"))
                .unwrap_err()
                .code,
            "GRANT_INVALID"
        );
        assert!(s.consume_grant(&g.id, "p", "rollback", Some("x")).is_ok());
        assert_eq!(
            s.consume_grant(&g.id, "p", "rollback", None)
                .unwrap_err()
                .code,
            "GRANT_INVALID"
        );
    }

    #[test]
    fn envelope_ceiling_enforced() {
        let env = Envelope {
            components_added_max: 2,
            components_deleted_max: 0,
            allowed_ops: vec!["place_component".into(), "delete_component".into()],
            ..Default::default()
        };
        let mut counters = TurnCounters {
            turn: 1,
            components_added: 1,
            components_deleted: 0,
            wires_added: 0,
            components_moved: 0,
            properties_changed: 0,
            refs_created: Vec::new(),
            apply_count: 0,
            tool_calls: 0,
            billed_tokens: 0,
            cost_usd: 0.0,
            wall_active_ms: 0,
        };
        let list = sch_ops::OpList::from_json(r#"{"protocol_version":1,"ops":[{"op":"place_component","lib_id":"Device:R","designator":"R9","value":"1k","x_mil":100,"y_mil":100}]}"#).unwrap();
        let ex = sch_ops::expand(&list).unwrap();
        assert!(check_envelope(
            &env,
            &counters,
            &ex,
            "a.kicad_sch",
            &[],
            &Default::default(),
            &Default::default()
        )
        .is_ok());
        counters.components_added = 2;
        assert_eq!(
            check_envelope(
                &env,
                &counters,
                &ex,
                "a.kicad_sch",
                &[],
                &Default::default(),
                &Default::default()
            )
            .unwrap_err()
            .code,
            "SCOPE_WIDEN"
        );
        let del = sch_ops::OpList::from_json(
            r#"{"protocol_version":1,"ops":[{"op":"delete_component","designator":"R1"}]}"#,
        )
        .unwrap();
        let exd = sch_ops::expand(&del).unwrap();
        // delete_object: a symbol uuid costs a deletion, any other uuid does not
        let dobj = sch_ops::OpList::from_json(
            r#"{"protocol_version":1,"ops":[{"op":"delete_object","uuid":"sym-1"}]}"#,
        )
        .unwrap();
        let exo = sch_ops::expand(&dobj).unwrap();
        let mut env_del = env.clone();
        env_del.allowed_ops.push("delete_object".into());
        let mut syms = std::collections::BTreeSet::new();
        syms.insert("sym-1".to_string());
        assert!(check_envelope(
            &env_del,
            &counters,
            &exo,
            "a.kicad_sch",
            &[],
            &syms,
            &Default::default()
        )
        .is_err());
        // a hierarchical sheet uuid is structural: refused without `delete_sheet:<file>`, free with it
        let mut sheets = std::collections::BTreeMap::new();
        sheets.insert("sym-1".to_string(), "sub.kicad_sch".to_string());
        let no_syms = std::collections::BTreeSet::new();
        let refused = check_envelope(
            &env_del,
            &counters,
            &exo,
            "a.kicad_sch",
            &[],
            &no_syms,
            &sheets,
        )
        .unwrap_err();
        assert_eq!(refused.code, "ENVELOPE_STRUCTURAL");
        let mut env_sheet = env_del.clone();
        env_sheet
            .structural
            .push("delete_sheet:sub.kicad_sch".into());
        assert!(check_envelope(
            &env_sheet,
            &counters,
            &exo,
            "a.kicad_sch",
            &[],
            &no_syms,
            &sheets
        )
        .is_ok());
        assert!(check_envelope(
            &env_del,
            &counters,
            &exo,
            "a.kicad_sch",
            &[],
            &Default::default(),
            &Default::default()
        )
        .is_ok());
        let e = check_envelope(
            &env,
            &counters,
            &exd,
            "a.kicad_sch",
            &[],
            &Default::default(),
            &Default::default(),
        )
        .unwrap_err();
        assert!(
            e.code == "SCOPE_WIDEN" || e.code == "ENVELOPE_STRUCTURAL",
            "{}",
            e.code
        );
    }

    // F13: naming only the rejected op left the model guessing the rest of the list, so it
    // retried the same op-list. The allowed set has to travel with the refusal.
    #[test]
    fn envelope_op_prints_the_allowed_ops() {
        let env = Envelope {
            components_added_max: 4,
            allowed_ops: vec!["place_component".into(), "add_wire".into()],
            ..Default::default()
        };
        let counters = TurnCounters {
            turn: 1,
            components_added: 0,
            components_deleted: 0,
            wires_added: 0,
            components_moved: 0,
            properties_changed: 0,
            refs_created: Vec::new(),
            apply_count: 0,
            tool_calls: 0,
            billed_tokens: 0,
            cost_usd: 0.0,
            wall_active_ms: 0,
        };
        let list = sch_ops::OpList::from_json(
            r#"{"protocol_version":1,"ops":[{"op":"add_text","text":"hi","at":[100,100]}]}"#,
        )
        .unwrap();
        let ex = sch_ops::expand(&list).unwrap();
        let e = check_envelope(
            &env,
            &counters,
            &ex,
            "a.kicad_sch",
            &[],
            &Default::default(),
            &Default::default(),
        )
        .unwrap_err();
        assert_eq!(e.code, "ENVELOPE_OP");
        let rem = e.remediation.unwrap_or_default();
        assert!(
            rem.contains("place_component") && rem.contains("add_wire"),
            "{rem}"
        );
        assert_eq!(e.evidence.unwrap()["allowed_ops"][1], "add_wire");
    }

    fn zero_counters() -> TurnCounters {
        TurnCounters {
            turn: 1,
            components_added: 0,
            components_deleted: 0,
            wires_added: 0,
            components_moved: 0,
            properties_changed: 0,
            refs_created: Vec::new(),
            apply_count: 0,
            tool_calls: 0,
            billed_tokens: 0,
            cost_usd: 0.0,
            wall_active_ms: 0,
        }
    }

    fn expand(json: &str) -> sch_ops::Expanded {
        sch_ops::expand(&sch_ops::OpList::from_json(json).unwrap()).unwrap()
    }

    fn check(
        env: &Envelope,
        counters: &TurnCounters,
        ex: &sch_ops::Expanded,
    ) -> Result<EnvelopeUse, IpcError> {
        check_envelope(
            env,
            counters,
            ex,
            "a.kicad_sch",
            &[],
            &Default::default(),
            &Default::default(),
        )
    }

    // P0-1: an edit turn has a non-model bound too. The parts the human named are the only existing
    // parts an op-list may edit or move; parts the turn places itself are always editable.
    #[test]
    fn edits_and_moves_are_confined_to_the_named_parts() {
        let env = Envelope {
            allowed_ops: vec![
                "set_component_parameters".into(),
                "move_component".into(),
                "place_component".into(),
                "arrange_group".into(),
            ],
            components_added_max: 2,
            properties_changed_max: 4,
            components_moved_max: 4,
            refs_editable: vec!["C3".into(), "R2".into()],
            ..Default::default()
        };
        let counters = zero_counters();
        // Three refs edited against refs_editable [C3, R2]: refused, and the refusal names the allowed set.
        let three = expand(
            r#"{"protocol_version":1,"ops":[
              {"op":"set_component_parameters","designator":"R2","value":"2k2"},
              {"op":"set_component_parameters","designator":"C3","value":"100n"},
              {"op":"set_component_parameters","designator":"R1","value":"1k"}]}"#,
        );
        let e = check(&env, &counters, &three).unwrap_err();
        assert_eq!(e.code, "ENVELOPE_REFERENCE");
        assert_eq!(e.evidence.as_ref().unwrap()["reference"], "R1");
        assert!(e.remediation.unwrap_or_default().contains("C3, R2"));
        // The named parts alone pass, and the use is counted.
        let two = expand(
            r#"{"protocol_version":1,"ops":[
              {"op":"set_component_parameters","designator":"r2","value":"2k2"},
              {"op":"move_component","designator":"C3","x_mil":100,"y_mil":100}]}"#,
        );
        let used = check(&env, &counters, &two).unwrap();
        assert_eq!((used.properties, used.moved), (1, 1));
        // A uuid-only address cannot be checked against the named parts: refused under a restriction.
        let by_uuid = expand(
            r#"{"protocol_version":1,"ops":[{"op":"move_component","uuid":"sym-9","x_mil":100,"y_mil":100}]}"#,
        );
        assert_eq!(
            check(&env, &counters, &by_uuid).unwrap_err().code,
            "ENVELOPE_REFERENCE"
        );
        // An arrange_group without a designator list would move whatever sits in the region.
        let region = expand(
            r#"{"protocol_version":1,"groups":{"g":{"origin_mil":[0,0]}},"ops":[{"op":"arrange_group","group":"g","region_mil":[[0,0],[1000,1000]]}]}"#,
        );
        assert_eq!(
            check(&env, &counters, &region).unwrap_err().code,
            "ENVELOPE_REFERENCE"
        );
        // A part the same list places, or one placed earlier in the turn, is editable.
        let placed = expand(
            r#"{"protocol_version":1,"ops":[
              {"op":"place_component","lib_id":"Device:R","designator":"R9","value":"1k","x_mil":100,"y_mil":100},
              {"op":"set_component_parameters","designator":"R9","footprint":"Resistor_SMD:R_0402_1005Metric"}]}"#,
        );
        assert!(check(&env, &counters, &placed).is_ok());
        let earlier = expand(
            r#"{"protocol_version":1,"ops":[{"op":"move_component","designator":"R7","x_mil":100,"y_mil":100}]}"#,
        );
        assert_eq!(
            check(&env, &counters, &earlier).unwrap_err().code,
            "ENVELOPE_REFERENCE"
        );
        let mut with_r7 = zero_counters();
        with_r7.refs_created.push("R7".into());
        assert!(check(&env, &with_r7, &earlier).is_ok());
        // Without named parts every existing part is editable, but the budgets still bound the turn.
        let open = Envelope {
            refs_editable: vec![],
            ..env.clone()
        };
        assert!(check(&open, &counters, &three).is_ok());
        let mut spent = zero_counters();
        spent.properties_changed = 2;
        let e = check(&open, &spent, &three).unwrap_err();
        assert_eq!(e.code, "SCOPE_WIDEN");
        assert_eq!(e.evidence.unwrap()["budget"], "properties_changed");
        let mut moved = zero_counters();
        moved.components_moved = 4;
        let e = check(&open, &moved, &earlier).unwrap_err();
        assert_eq!(e.code, "SCOPE_WIDEN");
        assert_eq!(e.evidence.unwrap()["budget"], "components_moved");
    }

    // The new dimensions narrow like the old ones: maxima clamp to the ceiling, and a ceiling that
    // does not restrict parts keeps the list the webview derived from the human's message.
    #[test]
    fn edit_dimensions_narrow_to_the_ceiling() {
        let ceiling = Envelope {
            properties_changed_max: 6,
            components_moved_max: 6,
            ..Default::default()
        };
        let mut decl = Envelope {
            properties_changed_max: 40,
            components_moved_max: 2,
            refs_editable: vec!["R2".into()],
            ..Default::default()
        };
        narrow_to_ceiling(&mut decl, &ceiling);
        assert_eq!(decl.properties_changed_max, 6);
        assert_eq!(decl.components_moved_max, 2);
        assert_eq!(decl.refs_editable, vec!["R2".to_string()]);
        let restricting = Envelope {
            refs_editable: vec!["R2".into(), "C3".into()],
            ..ceiling.clone()
        };
        let mut wider = Envelope {
            refs_editable: vec!["c3".into(), "U1".into()],
            ..Default::default()
        };
        narrow_to_ceiling(&mut wider, &restricting);
        assert_eq!(wider.refs_editable, vec!["C3".to_string()]);
        // Envelopes written before the fields existed still parse, as refusing zeros.
        let old: Envelope = serde_json::from_str(
            r#"{"sheets":[],"allowed_ops":[],"components_added_max":1,"components_deleted_max":0,"wires_max":null,"structural":[],"nets_renamable":[],"rails":[],"interfaces":[],"instance_designators":{},"source":"x"}"#,
        )
        .unwrap();
        assert_eq!(old.properties_changed_max, 0);
        assert!(old.refs_editable.is_empty());
    }
}
