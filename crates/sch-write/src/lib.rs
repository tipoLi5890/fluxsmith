// SPDX-License-Identifier: Apache-2.0
//! Write side of the engine: `plan` (dry-run) and `apply` for op-lists, with
//! the integrity/net gates, atomic transactional writes, checkpoint/restore
//! and the journal.

pub mod atomic;
pub mod autoplace;
pub mod checkpoint;
pub mod gates;
pub mod handlers;
pub mod identity;
pub mod nodes;

use gates::{Finding, Severity};
use handlers::{Counts, OpResult, Workset};
use sch_net::{NetDiff, Netlist};
use sch_ops::OpList;
use sch_read::{SheetTree, SymbolLibrary};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("read: {0}")]
    Read(#[from] sch_read::ReadError),
    #[error("op-list invalid")]
    OpList(Vec<sch_ops::OpError>),
    #[error(transparent)]
    Apply(#[from] handlers::ApplyError),
    #[error(transparent)]
    Atomic(#[from] atomic::AtomicError),
    #[error("REFUSED: {0}")]
    Refused(String),
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpectedMerge {
    pub into: String,
    #[serde(default = "default_true")]
    pub sources_unnamed_only: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone)]
pub struct DrawRequest {
    /// Target schematic (ops without `sheet` apply here).
    pub target: PathBuf,
    /// Root of the hierarchy (defaults to target). Nets are built over the whole tree.
    pub root: Option<PathBuf>,
    pub oplist: OpList,
    pub strict_nets: bool,
    /// Layout errors this op-list introduces refuse the write (default). Off = they
    /// are reported as findings and the write goes ahead (last-resort Auto fallback).
    pub strict_layout: bool,
    pub expected_merges: Vec<ExpectedMerge>,
    pub note: Option<String>,
    pub backup_depth: usize,
    /// `.fluxsmith/journal.jsonl` (None = no journal).
    pub journal: Option<PathBuf>,
    /// Refuse to write when the target changed since this sha was observed.
    pub expected_target_sha: Option<String>,
    /// Directory to store the run backup (pre-images) for multi-file runs.
    pub run_backup_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetInfo {
    pub path: String,
    pub sha_before: Option<String>,
    pub sha_after: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetSummary {
    pub name: String,
    pub scope: String,
    pub sheets: Vec<String>,
    pub members: usize,
    pub named: bool,
}

impl NetSummary {
    pub fn from_net(n: &sch_net::Net) -> NetSummary {
        let mut sheets: Vec<String> = n.members.iter().map(|m| m.sheet.clone()).collect();
        sheets.sort();
        sheets.dedup();
        NetSummary {
            name: n.name.clone(),
            scope: format!("{:?}", n.scope).to_lowercase(),
            sheets,
            members: n.members.len(),
            named: sch_net::is_named(&n.name),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawResult {
    pub applied: bool,
    pub run_id: String,
    pub per_op: Vec<OpResult>,
    pub integrity: Vec<Finding>,
    /// Integrity findings that did not exist before this op-list.
    pub integrity_introduced: Vec<Finding>,
    pub layout: Vec<Finding>,
    pub net_diff: NetDiff,
    pub nets_after: usize,
    /// Every net after the op-list: name, scope and the sheets it has members on.
    pub nets: Vec<NetSummary>,
    pub counts: Counts,
    pub targets: Vec<TargetInfo>,
    pub authored_sha256: String,
    pub expanded_sha256: String,
    /// The would-be file contents (only for plan; empty after apply).
    #[serde(skip)]
    pub previews: BTreeMap<PathBuf, String>,
    pub refusal: Option<String>,
    pub expected_merges_used: Vec<String>,
    /// Files this op-list would have written that the caller did not declare (see
    /// [`Engine::apply_within`]); non-empty means nothing was written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub undeclared_sheets: Vec<String>,
    /// Bounding box (mil) of the symbols and labels this op-list created.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_mil: Option<[[f64; 2]; 2]>,
}

/// Engine handle: the symbol library plus the project name used in
/// `(instances (project "name"))`.
pub struct Engine {
    pub lib: SymbolLibrary,
}

impl Engine {
    pub fn new(lib: SymbolLibrary) -> Engine {
        Engine { lib }
    }

    /// Dry-run: everything except the write.
    pub fn plan(&mut self, req: &DrawRequest) -> Result<DrawResult, WriteError> {
        self.run(req, false, None)
    }

    /// Plan, then write when all gates pass.
    pub fn apply(&mut self, req: &DrawRequest) -> Result<DrawResult, WriteError> {
        self.run(req, true, None)
    }

    /// [`Engine::apply`], but the write is refused when the op-list would change a file that is
    /// not in `allowed` (files this run creates are exempt: creating them is a structural op the
    /// caller gates separately). The check runs on the files that actually changed, before the
    /// transaction opens, so a refused run has written nothing.
    pub fn apply_within(
        &mut self,
        req: &DrawRequest,
        allowed: &std::collections::BTreeSet<PathBuf>,
    ) -> Result<DrawResult, WriteError> {
        self.run(req, true, Some(allowed))
    }

    fn run(
        &mut self,
        req: &DrawRequest,
        write: bool,
        allowed: Option<&std::collections::BTreeSet<PathBuf>>,
    ) -> Result<DrawResult, WriteError> {
        let expanded = sch_ops::expand(&req.oplist).map_err(WriteError::OpList)?;
        let root = req.root.clone().unwrap_or_else(|| req.target.clone());
        let tree_before = sch_read::read_project(&root)?;
        let target = req.target.canonicalize().map_err(|e| WriteError::Io {
            path: req.target.clone(),
            source: e,
        })?;
        if !tree_before.files.contains_key(&target) {
            return Err(WriteError::Refused(format!(
                "target {} is not part of the hierarchy rooted at {}",
                target.display(),
                root.display()
            )));
        }
        let authored_sha = atomic::sha256_hex(
            serde_json::to_string(&req.oplist.ops)
                .unwrap_or_default()
                .as_bytes(),
        );
        let expanded_sha = atomic::sha256_hex(
            serde_json::to_string(&expanded.ops)
                .unwrap_or_default()
                .as_bytes(),
        );
        let run_id = format!("r_{}", &expanded_sha[..12]);

        let nets_before = sch_net::build_nets(&tree_before);
        let integrity_before = gates::integrity(&tree_before);
        let layout_before = gates::layout(&tree_before);
        let shas_before: BTreeMap<PathBuf, Option<String>> = tree_before
            .files
            .keys()
            .map(|p| (p.clone(), atomic::file_sha(p)))
            .collect();

        // Working set on cloned documents.
        let project_name = project_name(&tree_before.root_file);
        let mut ws = Workset::new(
            tree_before.root_file.clone(),
            project_name,
            tree_before.docs.clone(),
            &mut self.lib,
        )?;
        let mut per_op = Vec::new();
        // Set when an op refuses mid-list: the working set is then a partial edit, so the files it
        // would write are not the files a successful run would write.
        let mut hard_error: Option<String> = None;
        // Parser findings (`OPLIST_UNKNOWN_FIELD`) ride on the first result of the authored op
        // they belong to, so `per_op` is the one place a caller has to read.
        let mut oplist_warnings: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for wn in &expanded.warnings {
            oplist_warnings
                .entry(wn.index)
                .or_default()
                .push(format!("{}: {}", wn.code, wn.message));
        }
        for x in &expanded.ops {
            let file = match &x.sheet {
                Some(key) => {
                    let rel = req.oplist.sheets.get(key).cloned().unwrap_or_default();
                    let p = target.parent().unwrap_or(Path::new(".")).join(rel);
                    p.canonicalize().unwrap_or(p)
                }
                None => target.clone(),
            };
            match ws.apply(&file, x) {
                Ok(mut r) => {
                    if let Some(wn) = oplist_warnings.remove(&x.authored_index) {
                        r.warnings.splice(0..0, wn);
                    }
                    // The handler knows what it made, the loop knows where it landed: the file an op
                    // was routed to is the sheet every object it created lives on.
                    let label = handlers::file_label(&file);
                    for c in r.created.iter_mut() {
                        if c.sheet.is_none() {
                            c.sheet = Some(label.clone());
                        }
                    }
                    for c in r.changed.iter_mut() {
                        if c.sheet.is_none() {
                            c.sheet = Some(label.clone());
                        }
                    }
                    per_op.push(r);
                }
                Err(handlers::ApplyError::Op {
                    code,
                    message,
                    remediation,
                    evidence,
                }) => {
                    per_op.push(OpResult {
                        index: x.authored_index,
                        op: x.op.name().to_string(),
                        status: "refused".into(),
                        created: vec![],
                        changed: vec![],
                        warnings: vec![],
                        error: Some(sch_ops::OpError {
                            index: x.authored_index,
                            code: code.clone(),
                            message: message.clone(),
                            remediation,
                            evidence,
                        }),
                    });
                    hard_error = Some(format!("{code}: {message} (op #{})", x.authored_index));
                    break;
                }
            }
        }

        // Serialise the working set and re-read it as a tree for the gates.
        let mut previews: BTreeMap<PathBuf, String> = BTreeMap::new();
        for (p, d) in &ws.docs {
            previews.insert(p.clone(), kicad_sexpr::dumps(d));
        }
        let created_files = ws.created_files.clone();
        let counts = ws.counts.clone();
        drop(ws);

        let (integrity_after, layout_after, nets_after, tree_after) =
            evaluate(&tree_before, &previews)?;
        let introduced: Vec<Finding> = gates::introduced(&integrity_before, &integrity_after)
            .into_iter()
            .cloned()
            .collect();
        let mut net_diff = sch_net::diff_nets(&nets_before, &nets_after);
        let mut expected_used = Vec::new();
        if net_diff.has_risk {
            // Allow merges covered by expected_merges (named target, unnamed-only sources).
            let mut still_risky = false;
            for c in &net_diff.changes {
                match c {
                    sch_net::NetChange::Merged { into, from } => {
                        let named: Vec<&String> = from
                            .iter()
                            .filter(|n| !n.starts_with("Net-(") && !n.starts_with("unconnected-("))
                            .collect();
                        if named.len() >= 2 {
                            let ok = req
                                .expected_merges
                                .iter()
                                .any(|m| m.into == *into && !m.sources_unnamed_only);
                            if ok {
                                expected_used.push(into.clone());
                            } else {
                                still_risky = true;
                            }
                        }
                    }
                    sch_net::NetChange::Split { name, .. }
                        if !name.starts_with("Net-(") && !name.starts_with("unconnected-(") =>
                    {
                        still_risky = true;
                    }
                    _ => {}
                }
            }
            net_diff.has_risk = still_risky;
        }

        let op_refused = hard_error.is_some();
        let mut refusal = hard_error;
        if refusal.is_none() {
            let errors: Vec<&Finding> = introduced
                .iter()
                .filter(|f| f.severity == Severity::Error)
                .collect();
            if !errors.is_empty() {
                refusal = Some(format!(
                    "integrity: {} new error(s), first: {} {}",
                    errors.len(),
                    errors[0].code,
                    errors[0].message
                ));
            }
        }
        if refusal.is_none() {
            // Only layout errors this op-list introduces block it; pre-existing
            // ones are reported, not re-litigated.
            let layout_errors: Vec<&Finding> = gates::introduced(&layout_before, &layout_after)
                .into_iter()
                .filter(|f| f.severity == Severity::Error)
                .collect();
            if !layout_errors.is_empty() && req.strict_layout {
                let refs: Vec<String> = layout_errors
                    .iter()
                    .flat_map(|f| f.refs.iter().cloned())
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                refusal = Some(format!(
                    "layout: {} error(s), first: {} {} (refs: {}); fix with move_component or arrange_group",
                    layout_errors.len(),
                    layout_errors[0].code,
                    layout_errors[0].message,
                    refs.join(", ")
                ));
            }
        }
        if refusal.is_none() && req.strict_nets && net_diff.has_risk {
            refusal = Some("strict_nets: a named net would be split or merged".into());
        }

        let mut targets = Vec::new();
        for (p, text) in &previews {
            let before = shas_before.get(p).cloned().flatten();
            let after = atomic::sha256_hex(text.as_bytes());
            if before.as_deref() == Some(after.as_str()) {
                continue;
            }
            targets.push(TargetInfo {
                path: p.to_string_lossy().into_owned(),
                sha_before: before,
                sha_after: after,
                created: created_files.contains(p),
            });
        }

        // Second line on the approved scope: an op-list may only rewrite the files the caller
        // declared. This is measured on the files that actually changed (an op can reach a file
        // the op-list never names — a global rename, a sheet pin seeded in a child), and it wins
        // over the gate refusals below because writing an undeclared file is a scope breach, not
        // a drawing defect. A run that already refused an op is a partial edit and is not judged.
        let mut undeclared_sheets: Vec<String> = Vec::new();
        if let Some(allowed) = allowed {
            if !op_refused {
                undeclared_sheets = targets
                    .iter()
                    .filter(|t| !t.created && !allowed.contains(Path::new(&t.path)))
                    .map(|t| t.path.clone())
                    .collect();
                if !undeclared_sheets.is_empty() {
                    refusal = Some(format!(
                        "ENVELOPE_SHEET_UNDECLARED: {} would be written but is not one of the approved sheets",
                        undeclared_sheets.join(", ")
                    ));
                }
            }
        }

        let applied = write && refusal.is_none();
        if applied {
            if let Some(exp) = &req.expected_target_sha {
                let cur = atomic::file_sha(&target).unwrap_or_default();
                if cur != *exp {
                    return Err(WriteError::Refused(
                        "VERIFY_FAILED: target changed since it was read".into(),
                    ));
                }
            }
            // run backup of pre-images
            if let Some(dir) = &req.run_backup_dir {
                let files: Vec<PathBuf> = targets
                    .iter()
                    .filter(|t| !t.created)
                    .map(|t| PathBuf::from(&t.path))
                    .collect();
                let root_dir = tree_before
                    .root_file
                    .parent()
                    .unwrap_or(Path::new("."))
                    .to_path_buf();
                let _ = checkpoint::create(&root_dir, &files, &dir.join(&run_id));
            }
            let mut txn = atomic::Txn::new();
            for t in &targets {
                let p = PathBuf::from(&t.path);
                let text = &previews[&p];
                txn.add(
                    &p,
                    text.as_bytes(),
                    t.sha_before.as_deref(),
                    req.backup_depth,
                )?;
            }
            txn.commit()?;
            if let Some(j) = &req.journal {
                let _ = journal_append(
                    j,
                    &run_id,
                    &target,
                    &targets,
                    &counts,
                    &net_diff,
                    req.strict_nets,
                    req.note.as_deref(),
                    &authored_sha,
                    &expanded_sha,
                    expanded.ops.len(),
                );
            }
        }

        let bbox_mil = created_bbox(&tree_after, &per_op);
        Ok(DrawResult {
            bbox_mil,
            applied,
            run_id,
            per_op,
            integrity: integrity_after,
            integrity_introduced: introduced,
            layout: layout_after,
            net_diff,
            nets_after: nets_after.nets.len(),
            nets: nets_after.nets.iter().map(NetSummary::from_net).collect(),
            counts,
            targets,
            authored_sha256: authored_sha,
            expanded_sha256: expanded_sha,
            previews: if applied { BTreeMap::new() } else { previews },
            refusal,
            expected_merges_used: expected_used,
            undeclared_sheets,
        })
    }
}

/// Bounding box of the symbols and labels the op-list created (from `per_op[].created`).
fn created_bbox(
    tree: &sch_read::SheetTree,
    per_op: &[handlers::OpResult],
) -> Option<[[f64; 2]; 2]> {
    use sch_model::nm_to_mil;
    use sch_read::bbox::{label_flag_bbox, symbol_bbox, BBox};
    let uuids: std::collections::HashSet<&str> = per_op
        .iter()
        .flat_map(|r| r.created.iter())
        .filter(|c| {
            matches!(
                c.kind.as_str(),
                "symbol" | "power_port" | "label" | "component"
            )
        })
        .map(|c| c.uuid.as_str())
        .collect();
    if uuids.is_empty() {
        return None;
    }
    let mut acc: Option<BBox> = None;
    let mut add = |b: BBox| match &mut acc {
        Some(a) => a.union(&b),
        None => acc = Some(b),
    };
    for (file, sheet) in &tree.files {
        let doc = &tree.docs[file];
        for s in sheet
            .symbols
            .iter()
            .filter(|s| uuids.contains(s.uuid.as_str()))
        {
            if let Some(b) = symbol_bbox(doc, s) {
                add(b);
            }
        }
        for l in sheet
            .labels
            .iter()
            .filter(|l| uuids.contains(l.uuid.as_str()))
        {
            let kind = match l.kind {
                sch_model::LabelKind::Global => "global_label",
                sch_model::LabelKind::Hierarchical => "hierarchical_label",
                _ => "label",
            };
            add(label_flag_bbox(&l.text, kind, l.at, l.rot as f64, 50.0));
        }
    }
    acc.map(|b| {
        [
            [nm_to_mil(b.min.x), nm_to_mil(b.min.y)],
            [nm_to_mil(b.max.x), nm_to_mil(b.max.y)],
        ]
    })
}

/// Parse the previews into a tree (in a temp directory mirroring the project
/// layout so relative sheet files resolve) and run the gates.
fn evaluate(
    before: &SheetTree,
    previews: &BTreeMap<PathBuf, String>,
) -> Result<(Vec<Finding>, Vec<Finding>, Netlist, SheetTree), WriteError> {
    let root_dir = before
        .root_file
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf();
    let tmp = tempfile::tempdir().map_err(|e| WriteError::Io {
        path: root_dir.clone(),
        source: e,
    })?;
    // copy every file of the project dir that is a schematic (so untouched sheets resolve)
    for p in before.files.keys() {
        let rel = p.strip_prefix(&root_dir).unwrap_or(p);
        let dest = tmp.path().join(rel);
        if let Some(d) = dest.parent() {
            std::fs::create_dir_all(d).ok();
        }
        let text = previews
            .get(p)
            .cloned()
            .unwrap_or_else(|| std::fs::read_to_string(p).unwrap_or_default());
        std::fs::write(&dest, text).map_err(|e| WriteError::Io {
            path: dest.clone(),
            source: e,
        })?;
    }
    for (p, text) in previews {
        let rel = p.strip_prefix(&root_dir).unwrap_or(p);
        let dest = tmp.path().join(rel);
        if let Some(d) = dest.parent() {
            std::fs::create_dir_all(d).ok();
        }
        std::fs::write(&dest, text).map_err(|e| WriteError::Io {
            path: dest.clone(),
            source: e,
        })?;
    }
    let rel_root = before
        .root_file
        .strip_prefix(&root_dir)
        .unwrap_or(&before.root_file);
    let tree = sch_read::read_project(&tmp.path().join(rel_root))?;
    let nets = sch_net::build_nets(&tree);
    let integrity = gates::integrity(&tree);
    let layout = gates::layout(&tree);
    Ok((integrity, layout, nets, tree))
}

/// `(instances (project "NAME"))` must match the `.kicad_pro` stem.
pub fn project_name(root_file: &Path) -> String {
    let dir = root_file.parent().unwrap_or(Path::new("."));
    if let Ok(rd) = std::fs::read_dir(dir) {
        let mut pros: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "kicad_pro").unwrap_or(false))
            .collect();
        pros.sort();
        if let Some(stem) = root_file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
        {
            if pros.iter().any(|p| {
                p.file_stem()
                    .map(|s| s.to_string_lossy() == stem)
                    .unwrap_or(false)
            }) {
                return stem;
            }
        }
        if let Some(p) = pros.first() {
            return p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
    }
    root_file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "noname".into())
}

#[allow(clippy::too_many_arguments)]
fn journal_append(
    path: &Path,
    run_id: &str,
    target: &Path,
    targets: &[TargetInfo],
    counts: &Counts,
    diff: &NetDiff,
    strict: bool,
    note: Option<&str>,
    authored: &str,
    expanded: &str,
    op_count: usize,
) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let (split, merge, created, removed) = diff.summary();
    let line = serde_json::json!({
        "schema_version": 1,
        "ts": now_iso(),
        "kind": "apply",
        "cmd": "apply",
        "target": target.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        "files": targets.iter().map(|t| t.path.clone()).collect::<Vec<_>>(),
        "run_id": run_id,
        "ops_sha256": authored,
        "expanded_sha256": expanded,
        "op_count": op_count,
        "counts": counts,
        "net_diff": {"split": split, "merge": merge, "created": created, "removed": removed},
        "strict_nets": if strict { "enforced" } else { "waived" },
        "status": "applied",
        "note": note.unwrap_or(""),
    });
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{line}")?;
    Ok(())
}

pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // minimal UTC formatting without a chrono dependency
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil from days (Howard Hinnant)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}
