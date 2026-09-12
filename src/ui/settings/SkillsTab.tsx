// SPDX-License-Identifier: Apache-2.0
// Settings > Skills: pack trust (skills) and the separate `trust_workflows`
// consent with the static permission summary of each workflow file
// (agent-runtime.md §9.3, skill-packs.md §6).
import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useT, type MessageKey } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { SkillPackInfo } from "../../ipc/types";
import { useProjects } from "../../state/projects";
import { useToasts } from "../../state/toasts";
import { Badge, Button, Callout, Dialog, Icon, ProgressBar } from "../components";
import { SkillEditor } from "./SkillEditor";
import { parseWorkflowYaml, permissionSummary, needsWorkflowConsent } from "../../agent/workflows/schema";

interface WorkflowRow { path: string; id: string | null; needs_consent: boolean; summary: ReturnType<typeof permissionSummary> | null; errors: string[] }

async function loadWorkflowRows(pack: SkillPackInfo): Promise<WorkflowRow[]> {
  const rows: WorkflowRow[] = [];
  for (const path of pack.workflows) {
    try {
      const text = await call("skills_read", { pack: pack.pack, path });
      const parsed = parseWorkflowYaml(text);
      rows.push({ path, id: parsed.def?.id ?? null, needs_consent: parsed.def ? needsWorkflowConsent(parsed.def) : false, summary: parsed.def ? permissionSummary(parsed.def) : null, errors: parsed.errors });
    } catch (e) { rows.push({ path, id: null, needs_consent: false, summary: null, errors: [String(e)] }); }
  }
  return rows;
}

export function WorkflowSummary({ row }: { row: WorkflowRow }) {
  const t = useT();
  if (!row.summary) return <Callout tone="warning">{t("settings.skills.permLint")}: {row.errors.join("; ")}</Callout>;
  const s = row.summary;
  return (
    <div className="col copy-sm">
      <div className="row"><span className="fs-mono">{row.id ?? row.path}</span><span className="grow" /><span className="muted">{t("settings.skills.runHint", { id: row.id ?? "" })}</span></div>
      <div className="row muted">
        <span>{t("settings.skills.permMode")}: <span className="fs-mono">{s.mode}</span></span>
        <span>{t("settings.skills.permDTools")}: <span className="fs-mono">{s.d_tools.length ? s.d_tools.join(", ") : "-"}</span></span>
        <span>{t("settings.skills.permStructural")}: {s.structural}</span>
        <span>{t("settings.skills.permConcurrency")}: {s.concurrency}</span>
        <span>{t("settings.skills.permMaxApplies")}: {s.max_applies ?? "-"}</span>
        {s.sheet_selectors.length > 0 && <span>{t("settings.skills.permSheets")}: <span className="fs-mono">{s.sheet_selectors.join(", ")}</span></span>}
      </div>
    </div>
  );
}

export function SkillsTab() {
  const t = useT();
  const toasts = useToasts();
  const active = useProjects((s) => s.tabs.find((x) => x.key === s.activeKey));
  const [packs, setPacks] = useState<SkillPackInfo[]>([]);
  const [trusting, setTrusting] = useState<SkillPackInfo | null>(null);
  const [wfTrusting, setWfTrusting] = useState<SkillPackInfo | null>(null);
  const [editing, setEditing] = useState<SkillPackInfo | null>(null);
  const [rows, setRows] = useState<Record<string, WorkflowRow[]>>({});
  const load = async () => {
    if (!isTauri()) return;
    try {
      const list = await call("skills_list", { project_key: active?.key ?? null });
      setPacks(list);
      const next: Record<string, WorkflowRow[]> = {};
      for (const p of list) if (p.workflows.length && (p.layer === "builtin" || p.trusted)) next[p.pack] = await loadWorkflowRows(p);
      setRows(next);
    } catch (e) { toasts.pushError(e); }
  };
  useEffect(() => { void load(); }, [active?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const trust = async () => {
    if (!trusting) return;
    try {
      const ev = await call("consent_record", { event: { project_key: active?.key ?? "", card_kind: "skill_trust", payload_sha256: trusting.sha256, input_kind: "click" } });
      await call("skills_trust", { pack: trusting.pack, sha256: trusting.sha256, consent_event_id: ev.id, project_key: active?.key ?? null });
      setTrusting(null); await load(); toasts.push({ tone: "info", text: t("settings.skills.nextSession") });
    } catch (e) { toasts.pushError(e); }
  };
  const trustWorkflows = async () => {
    if (!wfTrusting) return;
    try {
      const ev = await call("consent_record", { event: { project_key: active?.key ?? "", card_kind: "trust_workflows", payload_sha256: wfTrusting.sha256, input_kind: "click" } });
      await call("skills_trust_workflows", { pack: wfTrusting.pack, sha256: wfTrusting.sha256, consent_event_id: ev.id, project_key: active?.key ?? null });
      setWfTrusting(null); await load();
    } catch (e) { toasts.pushError(e); }
  };
  const revokeWorkflows = async (pack: string) => {
    try { await call("skills_revoke_workflows", { pack, project_key: active?.key ?? null }); await load(); } catch (e) { toasts.pushError(e); }
  };
  const importZip = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "zip", extensions: ["zip"] }] });
    if (typeof p === "string") { try { await call("skills_import_zip", { path: p, scope: active ? "project" : "user", project_key: active?.key ?? null }); await load(); } catch (e) { toasts.pushError(e); } }
  };
  const exportZip = async (pack: string) => {
    const p = await saveDialog({ defaultPath: `${pack}.zip` });
    if (p) { try { await call("skills_export_zip", { pack, out_path: p }); } catch (e) { toasts.pushError(e); } }
  };
  const l0 = packs.filter((p) => p.trusted).reduce((n, p) => n + p.skills.reduce((m, s) => m + s.l0_chars, 0), 0);
  return (
    <div className="col">
      <p className="muted">{t("settings.skills.intro")}</p>
      <div className="row"><span className="muted copy-sm">{t("settings.skills.l0Usage", { used: l0, max: 4096 })}</span><span className="grow" /><Button size="sm" icon="upload" onClick={() => void importZip()}>{t("settings.skills.importZip")}</Button></div>
      <ProgressBar pct={(l0 / 4096) * 100} tone={l0 > 4096 ? "error" : "neutral"} />
      {(["builtin", "user", "project"] as const).map((layer) => (
        <div key={layer} className="col">
          <h3>{t(`settings.skills.layer.${layer}` as MessageKey)}</h3>
          {packs.filter((p) => p.layer === layer).length === 0 && <div className="muted copy-sm">{t("empty.skills")}</div>}
          {packs.filter((p) => p.layer === layer).map((p) => {
            const wf = rows[p.pack] ?? [];
            const needs = wf.some((r) => r.needs_consent);
            return (
              <div key={p.path} className="provider-card">
                <div className="row">
                  <Icon name="skill" />
                  <span className="label grow truncate">{p.pack}</span>
                  <Badge tone={p.trusted ? "success" : "warning"}>{p.trusted ? t("settings.skills.trusted") : t("settings.skills.untrusted")}</Badge>
                  {p.workflows.length > 0 && layer !== "builtin" && p.trusted && needs && <Badge tone={p.workflows_trusted ? "success" : "warning"}>{p.workflows_trusted ? t("settings.skills.workflowsTrusted") : t("settings.skills.workflowsUntrusted")}</Badge>}
                  {p.origin_agent && <Badge>{t("settings.skills.originAgent")}</Badge>}
                  <span className="fs-mono muted">{p.sha256.slice(0, 8)}</span>
                  {layer !== "builtin" && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(p)}>{t("common.edit")}</Button>}
                  {layer !== "builtin" && !p.trusted && <Button size="sm" onClick={() => setTrusting(p)}>{t("common.trust")}</Button>}
                  {layer !== "builtin" && p.trusted && <Button size="sm" variant="ghost" onClick={() => setTrusting(p)}>{t("common.revoke")}</Button>}
                  {layer !== "builtin" && p.trusted && needs && !p.workflows_trusted && <Button size="sm" onClick={() => setWfTrusting(p)}>{t("settings.skills.trustWorkflows")}</Button>}
                  {layer !== "builtin" && p.trusted && needs && p.workflows_trusted && <Button size="sm" variant="ghost" onClick={() => void revokeWorkflows(p.pack)}>{t("settings.skills.revokeWorkflows")}</Button>}
                  <Button size="sm" variant="ghost" icon="download" onClick={() => void exportZip(p.pack)} aria-label={t("settings.skills.exportZip")} />
                </div>
                <div className="muted copy-sm">{p.skills.map((s) => `${s.name} (${s.l0_chars})`).join(" · ")}</div>
                {wf.length > 0 && (
                  <div className="col">
                    <div className="label copy-sm">{t("settings.skills.workflowsTitle")}</div>
                    {wf.map((r) => <WorkflowSummary key={r.path} row={r} />)}
                  </div>
                )}
                {p.lint.length > 0 && <Callout tone="warning">{t("settings.skills.lint")}: {p.lint.join("; ")}</Callout>}
              </div>
            );
          })}
        </div>
      ))}
      <p className="muted copy-sm">{t("settings.skills.nextSession")}</p>
      <Dialog open={!!trusting} onClose={() => setTrusting(null)} title={t("settings.skills.trustTitle", { pack: trusting?.pack ?? "" })} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setTrusting(null)}>{t("common.cancel")}</Button><Button variant="primary" consent onClick={() => void trust()}>{t("common.trust")}</Button></>}>
        <p>{t("settings.skills.trustBody")}</p>
        <div className="fs-mono muted copy-sm">{trusting?.sha256}</div>
      </Dialog>
      <Dialog open={!!wfTrusting} onClose={() => setWfTrusting(null)} title={t("settings.skills.trustWorkflowsTitle", { pack: wfTrusting?.pack ?? "" })} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setWfTrusting(null)}>{t("common.cancel")}</Button><Button variant="primary" consent onClick={() => void trustWorkflows()}>{t("settings.skills.trustWorkflows")}</Button></>}>
        <p>{t("settings.skills.trustWorkflowsBody")}</p>
        {(wfTrusting ? rows[wfTrusting.pack] ?? [] : []).map((r) => <WorkflowSummary key={r.path} row={r} />)}
        <div className="fs-mono muted copy-sm">{wfTrusting?.sha256}</div>
      </Dialog>
      {editing && <SkillEditor open pack={editing.pack} scope={editing.layer === "project" ? "project" : "user"} projectKey={active?.key ?? null} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </div>
  );
}
