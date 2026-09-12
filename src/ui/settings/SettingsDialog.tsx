// SPDX-License-Identifier: Apache-2.0
// Settings (docs/settings.md): nine tabs, every key wired to settings_get/set/reset; safety-affecting items double-confirm.
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useT, UI_LANGS, errorCopy, fmtDate, fmtBytes, type MessageKey } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { ProjectConfigEdit, Settings, VersionInfo } from "../../ipc/types";
import { useEnv } from "../../state/env";
import { usePrefs } from "../../state/prefs";
import { useProjects } from "../../state/projects";
import { useSettings } from "../../state/settings";
import { errorToastText, useToasts } from "../../state/toasts";
import { Badge, Button, Callout, Dialog, Input, Kbd, ProgressBar, Select, Switch, Tabs } from "../components";
import { ModelsTab } from "./ModelsTab";
import { isMac } from "../shortcuts/keymap";
import { SkillsTab } from "./SkillsTab";
import { DEFAULT_SHORTCUTS, findConflict, comboFromEvent, normalizeCombo, type ShortcutAction } from "../shortcuts/keymap";

type TabId = "general" | "environment" | "models" | "agent" | "skills" | "project" | "storage" | "privacy" | "advanced";

export function SettingsDialog({ open, onClose, initialTab }: { open: boolean; onClose: () => void; initialTab?: TabId | null }) {
  const t = useT();
  const prefs = usePrefs();
  const [q, setQ] = useState("");
  const active = useProjects((s) => s.tabs.find((x) => x.key === s.activeKey));
  // `initialTab` only seeds the selection when the dialog (re)opens; clicking
  // the navigation must win afterwards.
  const tab = prefs.settingsTab as TabId;
  useEffect(() => { if (open && initialTab) prefs.setSettingsTab(initialTab); }, [open, initialTab]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => {
    const all: { id: TabId; label: string }[] = [
      { id: "general", label: t("settings.tab.general") }, { id: "environment", label: t("settings.tab.environment") }, { id: "models", label: t("settings.tab.models") },
      { id: "agent", label: t("settings.tab.agent") }, { id: "skills", label: t("settings.tab.skills") }, { id: "project", label: t("settings.tab.project") },
      { id: "storage", label: t("settings.tab.storage") }, { id: "privacy", label: t("settings.tab.privacy") }, { id: "advanced", label: t("settings.tab.advanced") },
    ];
    return all.filter((x) => x.id !== "project" || active);
  }, [t, active]);
  return (
    <Dialog open={open} onClose={onClose} title={t("settings.title")} closeLabel={t("common.close")} className="dialog-settings">
      <div className="settings">
        <div className="settings-nav">
          <Input placeholder={t("settings.search")} value={q} onChange={(e) => setQ(e.target.value)} />
          <Tabs variant="vertical" items={items} value={tab} onChange={(id) => prefs.setSettingsTab(id)} ariaLabel={t("settings.title")} />
        </div>
        <div className="settings-body scroll" data-filter={q.toLowerCase()}>
         <SettingsFilter.Provider value={q.trim().toLowerCase()}>
          {/* With a search query every tab is rendered (each row filters itself), so a match on another tab is found. */}
          {(() => {
            const searching = q.trim().length > 0;
            const show = (id: TabId) => searching || tab === id;
            const section = (id: TabId, node: React.ReactNode) => (show(id) ? (searching ? <section key={id} className="settings-search-section"><h2 className="muted copy-sm">{items.find((x) => x.id === id)?.label ?? id}</h2>{node}</section> : node) : null);
            return (
              <>
                {section("general", <GeneralTab />)}
                {section("environment", <EnvironmentTab />)}
                {section("models", <ModelsTab />)}
                {section("agent", <AgentTab />)}
                {section("skills", <SkillsTab />)}
                {active && section("project", <ProjectSettingsTab projectKey={active.key} root={active.info.root} />)}
                {section("storage", <StorageTab />)}
                {section("privacy", <PrivacyTab />)}
                {section("advanced", <AdvancedTab />)}
              </>
            );
          })()}
         </SettingsFilter.Provider>
        </div>
      </div>
    </Dialog>
  );
}

/** Lower-cased search text typed in the settings nav; rows whose label / hint do not contain it are not rendered. */
const SettingsFilter = createContext("");
/** Native names for the UI language picker (never translated: each entry is read by its own speakers). */
const LANG_NAMES: Record<string, string> = { "zh-Hant": "繁體中文", "zh-Hans": "简体中文", en: "English", ja: "日本語" };

/** Hides its children while the settings search is active and none of `labels` contains the query (for controls not wrapped in `Row`). */
function Visible({ labels, children }: { labels: string[]; children: React.ReactNode }) {
  const q = useContext(SettingsFilter);
  if (q && !labels.some((l) => l.toLowerCase().includes(q))) return null;
  return <>{children}</>;
}

function Row({ label, hint, children, def, onReset, frozen, id }: { label: string; hint?: string; children: React.ReactNode; def?: string; onReset?: () => void; frozen?: boolean; /** Stable settings key (`agent.default_policy`) for deep links; falls back to a label-derived id. */ id?: string }) {
  const t = useT();
  const q = useContext(SettingsFilter);
  if (q && !`${label} ${hint ?? ""}`.toLowerCase().includes(q)) return null;
  return (
    <div className="srow" id={`setting-${id ?? label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}`} data-label={label.toLowerCase()}>
      <div className="srow-main">
        <div className="label">{label}</div>
        {hint && <div className="muted copy-sm">{hint}</div>}
        {def && <div className="muted copy-sm">{t("common.default", { value: def })}</div>}
        {frozen && <div className="muted copy-sm">{t("settings.frozen")}</div>}
      </div>
      <div className="srow-ctl">{children}</div>
      {onReset && <Button size="sm" variant="ghost" onClick={onReset}>{t("common.reset")}</Button>}
    </div>
  );
}

function useSet() {
  const { settings, update, reset } = useSettings();
  return { s: settings, set: (patch: Partial<Settings>) => void update(patch), reset };
}

function GeneralTab() {
  const t = useT();
  const { s, set, reset } = useSet();
  const [editing, setEditing] = useState<ShortcutAction | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (!editing) return;
    e.preventDefault();
    if (e.key === "Escape") { setEditing(null); return; }
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    const combo = normalizeCombo(comboFromEvent(e.nativeEvent));
    const c = findConflict(editing, combo, s.shortcuts);
    if (c) { setConflict(c === "reserved" ? t("error.SHORTCUT_CONFLICT.title") : t("settings.shortcutConflict", { action: t(DEFAULT_SHORTCUTS.find((d) => d.action === c)?.labelKey ?? "common.unknown") })); return; }
    set({ shortcuts: { ...s.shortcuts, [editing]: combo } });
    setEditing(null); setConflict(null);
  };
  return (
    <div className="col">
      <p className="muted">{t("settings.general.intro")}</p>
      <Row label={t("settings.language")} onReset={() => void reset(["language"])}>
        <Select value={s.language} onChange={(e) => set({ language: e.target.value as Settings["language"] })} options={[{ value: "auto", label: t("settings.language.auto") }, ...UI_LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] ?? l }))]} />
      </Row>
      <Row label={t("settings.theme")} onReset={() => void reset(["theme"])}>
        <Select value={s.theme} onChange={(e) => set({ theme: e.target.value as Settings["theme"] })} options={[{ value: "system", label: t("settings.theme.system") }, { value: "light", label: t("settings.theme.light") }, { value: "dark", label: t("settings.theme.dark") }]} />
      </Row>
      <Row label={t("settings.restoreTabs")} hint={t("settings.restoreTabsHint")}><Switch checked={s.restore_tabs_on_launch} onChange={(v) => set({ restore_tabs_on_launch: v })} /></Row>
      <Row label={t("settings.notifications")}><Switch checked={s.notifications} onChange={(v) => set({ notifications: v })} /></Row>
      <h3>{t("settings.shortcuts")}</h3>
      <p className="muted copy-sm">{t("settings.shortcutsHint")}</p>
      <table className="shortcut-table" onKeyDown={onKey}>
        <tbody>
          {DEFAULT_SHORTCUTS.filter((d) => d.customizable).map((d) => {
            const combo = d.action in s.shortcuts ? s.shortcuts[d.action] : d.combo;
            return (
              <tr key={d.action}>
                <td>{t(d.labelKey)}</td>
                <td className="shortcut-key">{editing === d.action ? <span className="muted">…</span> : combo ? <Kbd combo={combo} /> : <span className="muted">{t("common.none")}</span>}</td>
                <td><Button size="sm" variant="ghost" onClick={() => { setEditing(d.action); setConflict(null); }}>{t("common.edit")}</Button><Button size="sm" variant="ghost" onClick={() => { const sc = { ...s.shortcuts }; delete sc[d.action]; set({ shortcuts: sc }); }}>{t("common.reset")}</Button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {conflict && <Callout tone="error">{conflict}</Callout>}
      <div className="row"><span className="grow" /><Button variant="ghost" onClick={() => void reset(["language", "theme", "restore_tabs_on_launch", "notifications", "shortcuts"])}>{t("common.resetAll")}</Button></div>
    </div>
  );
}

function EnvironmentTab() {
  const t = useT();
  const { s } = useSet();
  const env = useEnv();
  const toasts = useToasts();
  const pick = async (key: "app_path" | "cli_path" | "symbol_dir_override") => {
    if (!isTauri()) return;
    // Windows / Linux installs are directories (C:\Program Files\KiCad\10.0); only the macOS .app bundle picks as a file.
    const p = await openDialog({ directory: key === "symbol_dir_override" || (key === "app_path" && !isMac()), multiple: false });
    if (typeof p === "string") { await useSettings.getState().update({ kicad: { ...s.kicad, [key]: p } }); await env.check(true); }
  };
  return (
    <div className="col">
      <p className="muted">{t("settings.env.intro")}</p>
      {(["app_path", "cli_path", "symbol_dir_override"] as const).map((k) => (
        <Row key={k} label={t(k === "app_path" ? "settings.env.appPath" : k === "cli_path" ? "settings.env.cliPath" : "settings.env.symbolDirOverride")} onReset={() => { void useSettings.getState().update({ kicad: { ...s.kicad, [k]: null } }).then(() => env.check(true)); }}>
          <div className="row"><Input mono value={s.kicad[k] ?? ""} placeholder={t("settings.env.auto")} readOnly className="grow" /><Button icon="open" onClick={() => void pick(k)}>{t("common.open")}</Button></div>
        </Row>
      ))}
      <Row label={t("settings.env.targetVersion")}><Input mono value={String(s.kicad.target_version)} readOnly /></Row>
      <Row label={t("settings.env.experimentalWrite")}><Badge>{t("common.none")}</Badge></Row>
      <div className="row">
        <Button icon="externalChange" loading={env.checking} onClick={() => void env.check(true)}>{t("env.recheck")}</Button>
        <Button icon="component" onClick={() => { void call("lib_index_rebuild", {}).then(() => toasts.push({ tone: "info", text: t("env.rebuildIndex") })); }}>{t("env.rebuildIndex")}</Button>
      </div>
      {env.report && (
        <table className="env-table">
          <tbody>
            <tr><td>{t("env.kicadApp")}</td><td className="fs-mono">{env.report.kicad_app_path ?? t("env.missing")}</td></tr>
            <tr><td>{t("env.kicadVersion")}</td><td className="fs-mono">{env.report.kicad_version ?? t("env.missing")}</td></tr>
            <tr><td>{t("env.symbolDir")}</td><td className="fs-mono">{env.report.symbol_dir ?? t("env.missing")} ({t("env.symbolLibs", { n: env.report.symbol_lib_count })})</td></tr>
            <tr><td>{t("env.symLibTable")}</td><td className="fs-mono">{env.report.sym_lib_table ?? t("env.missing")}</td></tr>
            <tr><td>{t("env.kicadCli")}</td><td className="fs-mono">{env.report.kicad_cli_path ?? t("env.missing")}</td></tr>
            <tr><td>{t("env.keyring")}</td><td>{env.report.keyring_available ? t("env.available") : t("env.missing")}</td></tr>
            <tr><td>{t("env.lastChecked", { when: fmtDate(env.report.checked_at) })}</td><td /></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function AgentTab() {
  const t = useT();
  const { s, set, reset } = useSet();
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [confirmBudgetOff, setConfirmBudgetOff] = useState(false);
  const a = s.agent;
  const c = s.context;
  const setA = (patch: Partial<Settings["agent"]>) => set({ agent: { ...a, ...patch } });
  const b = a.budget_defaults;
  const setB = (k: keyof typeof b, v: string) => setA({ budget_defaults: { ...b, [k]: v === "" ? null : Number(v) } });
  const num = (v: number | null) => (v == null ? "" : String(v));
  return (
    <div className="col">
      <p className="muted">{t("settings.agent.intro")}</p>
      <Row label={t("settings.agent.defaultPolicy")} onReset={() => setA({ default_policy: "review" })}>
        <Select value={a.default_policy} onChange={(e) => (e.target.value === "auto" ? setConfirmAuto(true) : setA({ default_policy: e.target.value as Settings["agent"]["default_policy"] }))} options={[{ value: "ask", label: t("policy.ask") }, { value: "review", label: t("policy.review") }, { value: "auto", label: t("policy.auto") }]} />
      </Row>
      <h3>{t("settings.agent.budget")}</h3>
      <Row label={t("settings.agent.budgetEnabled")} hint={t("settings.agent.budgetEnabledHint")}><Switch checked={a.budget_enabled} onChange={(v) => (v ? setA({ budget_enabled: true }) : setConfirmBudgetOff(true))} /></Row>
      <Row label={t("settings.agent.sessionCeiling")} hint={t("settings.agent.sessionCeilingHint")} onReset={() => setA({ session_ceiling_components_added: 24 })}>
        <Input mono type="number" min={1} max={500} value={String(a.session_ceiling_components_added)} onChange={(e) => { if (e.target.value === "") return; setA({ session_ceiling_components_added: Math.max(1, Math.min(500, Number(e.target.value) || 1)) }); }} />
      </Row>
      <div className="grid2">
        {([["plan_tokens", "settings.agent.budget.planTokens"], ["plan_usd", "settings.agent.budget.planUsd"], ["plan_tool_calls", "settings.agent.budget.planToolCalls"], ["plan_wall_min", "settings.agent.budget.planWall"], ["turn_tool_calls", "settings.agent.budget.turnToolCalls"], ["turn_wall_min", "settings.agent.budget.turnWall"]] as const).map(([k, lk]) => (
          <Input key={k} mono type="number" min={0} label={t(lk)} value={num(b[k])} disabled={!a.budget_enabled} onChange={(e) => setB(k, e.target.value)} placeholder={t("settings.agent.budget.unset")} />
        ))}
        <Input mono type="number" min={1} max={100} label={t("settings.agent.budget.warnPct")} value={String(b.warn_pct)} disabled={!a.budget_enabled} onChange={(e) => setA({ budget_defaults: { ...b, warn_pct: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } })} />
      </div>
      <Row label={t("settings.agent.canvasFollow")}><Switch checked={a.canvas_follow} onChange={(v) => setA({ canvas_follow: v })} /></Row>
      <Row label={t("settings.agent.canvasGrid")}><Switch checked={a.canvas_grid} onChange={(v) => setA({ canvas_grid: v })} /></Row>
      <Row label={t("settings.agent.canvasChanges")}><Switch checked={a.canvas_changes} onChange={(v) => setA({ canvas_changes: v })} /></Row>
      <Row label={t("settings.agent.canvasDragSelects")} hint={t("settings.agent.canvasDragSelectsHint")}><Switch checked={a.canvas_drag_selects === true} onChange={(v) => setA({ canvas_drag_selects: v })} /></Row>
      <Row label={t("settings.agent.attachSelection")}><Switch checked={a.chat_attach_selection} onChange={(v) => setA({ chat_attach_selection: v })} /></Row>
      <h3>{t("settings.agent.intakeDefaults")}</h3>
      <div className="grid2">
        {(["lib", "pdf", "sch", "bom", "image", "project_zip"] as const).map((k) => (
          <Select key={k} label={t(`settings.agent.intake.${k}` as MessageKey)} value={a.intake_defaults[k] ?? "ask"} onChange={(e) => setA({ intake_defaults: { ...a.intake_defaults, [k]: e.target.value } })} options={(["keep", "attach", "reference", "ask"] as const).map((v) => ({ value: v, label: t(`settings.agent.intake.${v}` as MessageKey) }))} />
        ))}
      </div>
      <Row label={t("settings.agent.density")}>
        <Select value={a.chat_density} onChange={(e) => setA({ chat_density: e.target.value as Settings["agent"]["chat_density"] })} options={[{ value: "compact", label: t("chat.densityCompact") }, { value: "detailed", label: t("chat.densityDetailed") }, { value: "developer", label: t("chat.densityDeveloper") }]} />
      </Row>
      <Row label={t("settings.agent.contextThresholds")} hint={t("settings.agent.contextThresholdsHint")}>
        <div className="row">
          <Input mono type="number" min={1} max={100} label={t("settings.agent.thresholdHint")} value={String(c.hint_pct)} onChange={(e) => set({ context: { ...c, hint_pct: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } })} />
          <Input mono type="number" min={1} max={100} label={t("settings.agent.thresholdAuto")} value={String(c.auto_pct)} onChange={(e) => set({ context: { ...c, auto_pct: Math.max(1, Math.min(100, Number(e.target.value) || 1)) } })} />
          <Input mono type="number" min={1} max={95} label={t("settings.agent.thresholdEmergency")} value={String(c.emergency_pct)} onChange={(e) => set({ context: { ...c, emergency_pct: Math.min(95, Number(e.target.value)) } })} />
        </div>
      </Row>
      <Row label={t("settings.agent.keepRecentTasks")}><Input mono type="number" min={0} value={String(c.keep_recent_tasks)} onChange={(e) => set({ context: { ...c, keep_recent_tasks: Number(e.target.value) } })} /></Row>
      <Row label={t("settings.agent.reserveOutput")} frozen><Input mono type="number" min={0} value={String(c.reserve_output_tokens)} onChange={(e) => set({ context: { ...c, reserve_output_tokens: Number(e.target.value) } })} /></Row>
      <div className="row"><span className="grow" /><Button variant="ghost" onClick={() => void reset(["agent", "context"])}>{t("common.resetAll")}</Button></div>
      <Dialog open={confirmBudgetOff} onClose={() => setConfirmBudgetOff(false)} title={t("settings.agent.budgetOffTitle")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setConfirmBudgetOff(false)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent onClick={() => { setA({ budget_enabled: false }); setConfirmBudgetOff(false); }}>{t("common.ok")}</Button></>}>
        <p>{t("settings.agent.budgetOffBody")}</p>
        <p className="muted copy-sm">{t("settings.safetyConfirm")}</p>
      </Dialog>
      <Dialog open={confirmAuto} onClose={() => setConfirmAuto(false)} title={t("policy.autoConfirmTitle")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setConfirmAuto(false)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent onClick={() => { setA({ default_policy: "auto" }); setConfirmAuto(false); }}>{t("policy.autoConfirm")}</Button></>}>
        <p>{t("policy.autoConfirmBody")}</p>
        <p className="muted copy-sm">{t("settings.safetyConfirm")}</p>
      </Dialog>
    </div>
  );
}


interface ProjectConfig { rails?: string[] | { names?: string[]; mechanism?: string } | null; waiver?: { code: string; refs?: string[]; expires?: string; reason: string; granted?: string }[] | null; check?: { fail_on?: string } | null; backup_depth?: number; refdes_policy?: { frozen_existing?: boolean; reuse_freed?: boolean }; display_units?: string; kicad_target?: number }

/** `fluxsmith.toml` may spell rails as an array or as a `[rails]` table with `names`. */
function railsOf(cfg: ProjectConfig): string[] {
  const r = cfg.rails;
  if (Array.isArray(r)) return r.map(String);
  if (r && typeof r === "object" && Array.isArray(r.names)) return r.names.map(String);
  return [];
}
function waiversOf(cfg: ProjectConfig): NonNullable<Exclude<ProjectConfig["waiver"], null>> {
  return Array.isArray(cfg.waiver) ? cfg.waiver : [];
}

/**
 * A guarded change waiting for the human's confirmation (`SETTINGS_PROJECT_CARD`): what Rust will be
 * asked to write, which row raised it, and a plain-text rendering of the new value.
 */
interface PendingEdit { edit: ProjectConfigEdit; row: string; label: string; preview: string }

/** Write the rails back in the shape the file uses, as the value of a one-key patch. */
function railsEdit(cfg: ProjectConfig, names: string[]): ProjectConfigEdit {
  const r = cfg.rails;
  const value = r && typeof r === "object" && !Array.isArray(r) ? { ...r, names } : names;
  return { op: "set", key: "rails", value };
}

/**
 * Project settings (`docs/settings.md` §6). Two write paths, because `fluxsmith.toml` is not one
 * kind of setting: the benign rows (`display_units`, `refdes_policy`) go straight through
 * `sidecar_write` as a one-key patch that Rust merges, while the guarded rows (`rails`, `[[waiver]]`,
 * `[check]`, `backup_depth` — the ones that change what the hard stops and the checks decide) are
 * confirmed by the human first and then written by `project_config_apply` against that consent event.
 * Either way the row moves only after the file did; a refusal is shown under the row that caused it.
 */
export function ProjectSettingsTab({ projectKey, root }: { projectKey: string; root: string }) {
  const toastsForCopy = useToasts();
  const [copying, setCopying] = useState(false);
  // Copy every PDF attachment of this project into <project>/datasheets/ (a KiCad-friendly, portable copy).
  const copyDatasheets = async () => {
    setCopying(true);
    try {
      const list = (await call("db_query", { query: { kind: "attachment_list", project_key: projectKey } })) as { sha256: string; kind: string; label: string }[];
      const pdfs = (Array.isArray(list) ? list : []).filter((a) => a.kind === "pdf");
      let n = 0;
      for (const a of pdfs) { try { await call("attach_bind_to_project", { project_key: projectKey, sha256: a.sha256, dest: "datasheets" }); n++; } catch { /* skip this one */ } }
      toastsForCopy.push({ tone: n > 0 ? "success" : "warning", text: t("settings.project.copiedDatasheets", { n }) });
    } catch (e) { toastsForCopy.push({ tone: "error", text: String(e) }); } finally { setCopying(false); }
  };
  const t = useT();
  const toasts = useToasts();
  const [cfg, setCfg] = useState<ProjectConfig>({});
  const [local, setLocal] = useState<{ policy_override?: string | null; cloud_sync_notified?: boolean }>({});
  /** Text being typed in a row, before it is committed on blur; cleared once the file answers. */
  const [draft, setDraft] = useState<{ rails?: string; backup_depth?: string }>({});
  /** Engine / Rust refusals, per row, shown under the control that caused them. */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const [writing, setWriting] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    call("sidecar_read", { project_key: projectKey, kind: "project_config" }).then((c) => setCfg((c as ProjectConfig) ?? {})).catch(() => undefined);
    call("db_query", { query: { kind: "project_state", project_key: projectKey } }).then((s) => setLocal((s as typeof local) ?? {})).catch(() => undefined);
  }, [projectKey]);
  const clearRow = (row: string) => setRowErrors((e) => { const n = { ...e }; delete n[row]; return n; });
  const failRow = (row: string, e: unknown) => setRowErrors((x) => ({ ...x, [row]: errorToastText(e) }));
  /** A benign key: one shallow patch (Rust merges it into the file), applied to the row only on success. */
  const savePatch = async (row: string, patch: ProjectConfig) => {
    clearRow(row);
    try {
      await call("sidecar_write", { project_key: projectKey, write: { kind: "project_config", config: patch } });
      setCfg((c) => ({ ...c, ...patch }));
    } catch (e) { failRow(row, e); }
  };
  /** A guarded key: raise the confirm card; nothing is written until the human answers it. */
  const ask = (row: string, label: string, preview: string, edit: ProjectConfigEdit) => { clearRow(row); setPending({ edit, row, label, preview }); };
  const cancelPending = () => { setPending(null); setDraft({}); };
  const applyPending = async () => {
    if (!pending) return;
    setWriting(true);
    clearRow(pending.row);
    try {
      const ev = await call("consent_record", { event: { project_key: projectKey, card_kind: "project_config", payload_sha256: JSON.stringify(pending.edit).slice(0, 200), input_kind: "click" } });
      const next = await call("project_config_apply", { project_key: projectKey, edit: pending.edit, consent_event_id: ev.id });
      setCfg((next as ProjectConfig) ?? {});
    } catch (e) { failRow(pending.row, e); }
    setDraft({});
    setPending(null);
    setWriting(false);
  };
  const exportBom = async (ext: "csv" | "json") => {
    const p = await saveDialog({ defaultPath: `bom.${ext}` });
    if (!p) return;
    try { await call("export_file", { project_key: projectKey, kind: "bom", payload: {}, out_path: p }); toasts.push({ tone: "success", text: p }); } catch (e) { toasts.pushError(e); }
  };
  const saveLocal = async (patch: typeof local) => { const next = { ...local, ...patch }; setLocal(next); try { await call("db_query", { query: { kind: "project_state_set", project_key: projectKey, patch } }); } catch (e) { toasts.pushError(e); } };
  const rowError = (row: string) => (rowErrors[row] ? <div className="field-error" role="alert">{rowErrors[row]}</div> : null);
  const railsText = draft.rails ?? railsOf(cfg).join(", ");
  const depthText = draft.backup_depth ?? String(cfg.backup_depth ?? 3);
  const cardCopy = errorCopy("SETTINGS_PROJECT_CARD");
  return (
    <div className="col">
      <p className="muted">{t("settings.project.intro")}</p>
      <Row label={t("settings.project.rails")} hint={t("settings.project.railsHint")}>
        <div className="col">
          <Input mono value={railsText} onChange={(e) => setDraft((d) => ({ ...d, rails: e.target.value }))} onBlur={() => {
            const names = railsText.split(",").map((x) => x.trim()).filter(Boolean);
            if (names.join("\u0000") === railsOf(cfg).join("\u0000")) { setDraft((d) => ({ ...d, rails: undefined })); return; }
            ask("rails", t("settings.project.rails"), names.join(", ") || t("common.none"), railsEdit(cfg, names));
          }} />
          {rowError("rails")}
        </div>
      </Row>
      <Row label={t("settings.project.waivers")} hint={t("settings.project.waiversHint")}>
        <div className="col">{waiversOf(cfg).length === 0 && <span className="muted copy-sm">{t("common.none")}</span>}{waiversOf(cfg).map((w, i) => (
          <div key={i} className="row"><Badge mono>{w.code}</Badge><span className="grow truncate copy-sm">{w.reason}{w.expires ? ` · ${w.expires}` : ""}</span><Button size="sm" variant="ghost" icon="trash" onClick={() => ask("waiver", t("settings.project.waivers"), t("settings.project.waiverRemoved", { code: w.code, reason: w.reason }), { op: "waiver_revoke", index: i, granted: w.granted ?? null })} aria-label={t("common.remove")} /></div>
        ))}{rowError("waiver")}</div>
      </Row>
      <Row label={t("settings.project.checkFailOn")}>
        <div className="col">
          <Select value={(cfg.check && typeof cfg.check === "object" ? cfg.check.fail_on : undefined) ?? "error"} onChange={(e) => ask("check", t("settings.project.checkFailOn"), e.target.value === "warning" ? t("side.severity.warning") : t("side.severity.error"), { op: "set", key: "check", value: { fail_on: e.target.value } })} options={[{ value: "error", label: t("side.severity.error") }, { value: "warning", label: t("side.severity.warning") }]} />
          {rowError("check")}
        </div>
      </Row>
      <Row label={t("settings.project.backupDepth")} def="3">
        <div className="col">
          <Input mono type="number" min={1} max={10} value={depthText} onChange={(e) => setDraft((d) => ({ ...d, backup_depth: e.target.value }))} onBlur={() => {
            const n = Number(depthText);
            if (!Number.isFinite(n) || n === (cfg.backup_depth ?? 3)) { setDraft((d) => ({ ...d, backup_depth: undefined })); return; }
            ask("backup_depth", t("settings.project.backupDepth"), String(n), { op: "set", key: "backup_depth", value: n });
          }} />
          {rowError("backup_depth")}
        </div>
      </Row>
      <Row label={t("settings.project.refdesFrozen")}>
        <div className="col"><Switch checked={cfg.refdes_policy?.frozen_existing ?? true} onChange={(v) => void savePatch("refdes_policy", { refdes_policy: { ...cfg.refdes_policy, frozen_existing: v } })} />{rowError("refdes_policy")}</div>
      </Row>
      <Row label={t("settings.project.refdesReuse")}>
        <div className="col"><Switch checked={cfg.refdes_policy?.reuse_freed ?? false} onChange={(v) => void savePatch("refdes_policy", { refdes_policy: { ...cfg.refdes_policy, reuse_freed: v } })} />{rowError("refdes_policy")}</div>
      </Row>
      <Row label={t("settings.project.displayUnits")}>
        <div className="col"><Select value={cfg.display_units ?? "mil"} onChange={(e) => void savePatch("display_units", { display_units: e.target.value })} options={[{ value: "mil", label: "mil" }, { value: "mm", label: "mm" }]} />{rowError("display_units")}</div>
      </Row>
      <Row label={t("settings.project.kicadTarget")}><Input mono value={String(cfg.kicad_target ?? 10)} readOnly /></Row>
      <Row label={t("settings.project.policyOverride")}><Select value={local.policy_override ?? ""} onChange={(e) => void saveLocal({ policy_override: e.target.value || null })} options={[{ value: "", label: t("common.default", { value: t(`policy.${useSettings.getState().settings.agent.default_policy}` as "policy.review") }) }, { value: "ask", label: t("policy.ask") }, { value: "review", label: t("policy.review") }, { value: "auto", label: t("policy.auto") }]} /></Row>
      <Row label={t("settings.project.cloudSync")}><Switch checked={!!local.cloud_sync_notified} onChange={(v) => void saveLocal({ cloud_sync_notified: v })} /></Row>
      <div className="row wrap">
        <Button size="sm" icon="open" onClick={() => void call("open_path", { path: `${root}/.fluxsmith` }).catch((e) => toastsForCopy.push({ tone: "error", text: String(e) }))}>{t("settings.storage.openSidecar")}</Button>
        <Button size="sm" loading={copying} onClick={() => void copyDatasheets()}>{t("settings.project.copyDatasheets")}</Button>
      </div>
      <Row label={t("settings.project.exportBom")} hint={t("settings.project.exportBomHint")}>
        <div className="row">
          <Button size="sm" icon="download" onClick={() => void exportBom("csv")}>CSV</Button>
          <Button size="sm" onClick={() => void exportBom("json")}>JSON</Button>
        </div>
      </Row>
      <Dialog open={!!pending} onClose={cancelPending} title={cardCopy?.title ?? t("settings.tab.project")} closeLabel={t("common.close")}
        footer={<><Button onClick={cancelPending} autoFocus>{t("common.cancel")}</Button><Button variant="primary" consent loading={writing} onClick={() => void applyPending()}>{t("settings.project.confirmWrite")}</Button></>}>
        <p>{t("settings.project.confirmBody", { key: pending?.label ?? "" })}</p>
        <p className="fs-mono copy-sm selectable">{t("settings.project.newValue", { value: pending?.preview ?? "" })}</p>
        {cardCopy?.why && <p className="muted copy-sm">{cardCopy.why}</p>}
      </Dialog>
    </div>
  );
}

interface StorageInfo { checkpoints?: { bytes: number; turns: number }; external?: { bytes: number }; assets?: { bytes: number }; logs?: { bytes: number } }

function StorageTab() {
  const t = useT();
  const { s, set } = useSet();
  const toasts = useToasts();
  const [info, setInfo] = useState<StorageInfo>({});
  const [orphans, setOrphans] = useState<{ key: string; path: string; root_uuid?: string; bytes?: number }[]>([]);
  const [confirm, setConfirm] = useState<"checkpoints" | "external" | "assets" | "logs" | "wipe" | null>(null);
  const load = async () => { if (!isTauri()) return; try { setInfo((await call("db_query", { query: { kind: "storage" } })) as StorageInfo); setOrphans(((await call("db_query", { query: { kind: "orphan_projects" } })) as typeof orphans) ?? []); } catch { /* ignore */ } };
  useEffect(() => { void load(); }, []);
  const clear = async () => {
    if (!confirm) return;
    try {
      if (confirm === "wipe") { const ev = await call("consent_record", { event: { project_key: "", card_kind: "wipe", payload_sha256: "wipe", input_kind: "click" } }); await call("app_data_wipe", { consent_event_id: ev.id }); }
      else await call("db_query", { query: { kind: "storage_clear", area: confirm } });
      await load();
    } catch (e) { toasts.pushError(e); }
    setConfirm(null);
  };
  const exportData = async () => { const p = await saveDialog({ defaultPath: "fluxsmith-appdata.zip" }); if (p) { try { await call("app_data_export", { out_path: p }); } catch (e) { toasts.pushError(e); } } };
  const quota = (used: number | undefined, maxMb: number) => t("settings.storage.quota", { used: fmtBytes(used ?? 0), max: fmtBytes(maxMb * 1024 * 1024) });
  return (
    <div className="col">
      <p className="muted">{t("settings.storage.intro")}</p>
      <Row label={t("settings.storage.checkpoints")} hint={quota(info.checkpoints?.bytes, s.storage.checkpoint_mb)}><Button size="sm" variant="destructive" onClick={() => setConfirm("checkpoints")}>{t("settings.storage.clear")}</Button></Row>
      <ProgressBar pct={((info.checkpoints?.bytes ?? 0) / (s.storage.checkpoint_mb * 1048576)) * 100} />
      <Row label={t("settings.storage.external")} hint={quota(info.external?.bytes, s.storage.external_cache_mb)}><Button size="sm" variant="destructive" onClick={() => setConfirm("external")}>{t("settings.storage.clear")}</Button></Row>
      <ProgressBar pct={((info.external?.bytes ?? 0) / (s.storage.external_cache_mb * 1048576)) * 100} />
      <Row label={t("settings.storage.assets")} hint={fmtBytes(info.assets?.bytes ?? 0)}><Button size="sm" variant="destructive" onClick={() => setConfirm("assets")}>{t("settings.storage.clear")}</Button></Row>
      <Row label={t("settings.storage.logs")} hint={fmtBytes(info.logs?.bytes ?? 0)}><Button size="sm" variant="destructive" onClick={() => setConfirm("logs")}>{t("settings.storage.clear")}</Button></Row>
      <Row label={t("settings.storage.datasheetsCopyDefault")}><Switch checked={s.storage.datasheets_copy_to_project_default} onChange={(v) => set({ storage: { ...s.storage, datasheets_copy_to_project_default: v } })} /></Row>
      <h3>{t("settings.storage.orphans")}</h3>
      <p className="muted copy-sm">{t("settings.storage.orphansHint")}</p>
      {orphans.length === 0 && <div className="muted copy-sm">{t("common.none")}</div>}
      {orphans.map((o) => <div key={o.key} className="row"><span className="fs-mono truncate grow">{o.path}</span><span className="muted copy-sm">{fmtBytes(o.bytes ?? 0)}</span><Button size="sm" variant="destructive" onClick={() => void call("db_query", { query: { kind: "project_forget", project_key: o.key } }).then(load)}>{t("settings.storage.deleteHistory")}</Button></div>)}
      <div className="row wrap">
        <Button size="sm" icon="download" onClick={() => void exportData()}>{t("settings.storage.exportAppData")}</Button>
        <Button size="sm" icon="upload" onClick={() => void openDialog({ multiple: false }).then(() => toasts.push({ tone: "info", text: t("settings.storage.importHint") }))}>{t("settings.storage.importAppData")}</Button>
        <Button size="sm" icon="open" onClick={() => void call("app_data_path", {}).then((p) => call("open_path", { path: p }))}>{t("settings.storage.openAppData")}</Button>
        <span className="grow" />
        <Button size="sm" variant="destructive" icon="trash" onClick={() => setConfirm("wipe")}>{t("settings.storage.wipe")}</Button>
      </div>
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title={confirm === "wipe" ? t("settings.storage.wipe") : t("settings.storage.clear")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setConfirm(null)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent onClick={() => void clear()}>{t("common.confirm")}</Button></>}>
        <p>{confirm === "checkpoints" ? t("settings.storage.clearCheckpointsBody", { a: 1, b: info.checkpoints?.turns ?? 0 }) : confirm === "external" ? t("settings.storage.clearExternalBody") : confirm === "assets" ? t("settings.storage.clearAssetsBody") : confirm === "logs" ? t("settings.storage.clearLogsBody") : t("settings.storage.wipeBody")}</p>
      </Dialog>
    </div>
  );
}

interface MetricSummary { [kind: string]: { count: number; avg: number; series?: number[] } }

function PrivacyTab() {
  const t = useT();
  const { s, set } = useSet();
  const toasts = useToasts();
  const active = useProjects((x) => x.tabs.find((y) => y.key === x.activeKey));
  const [diag, setDiag] = useState({ log: true, settings: true, tables: false, project: false });
  const [crashes, setCrashes] = useState<{ ts: string; req_id: string; message: string }[]>([]);
  const [metrics, setMetrics] = useState<MetricSummary>({});
  const [partsConsent, setPartsConsent] = useState(false);
  const [partsClear, setPartsClear] = useState(false);
  const [partsInfo, setPartsInfo] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 });
  const loadParts = async () => { if (!isTauri()) return; try { const i = (await call("db_query", { query: { kind: "storage" } })) as { parts?: { bytes: number; count: number } }; setPartsInfo({ count: i.parts?.count ?? 0, bytes: i.parts?.bytes ?? 0 }); } catch { /* ignore */ } };
  const clearParts = async () => { try { await call("db_query", { query: { kind: "storage_clear", area: "parts" } }); await loadParts(); } catch (e) { toasts.pushError(e); } setPartsClear(false); };
  const enableParts = async () => {
    try {
      const ev = await call("consent_record", { event: { project_key: "", card_kind: "parts_network", payload_sha256: `parts:${s.parts.lib_nickname || "jlc"}`, input_kind: "click" } });
      if (ev.id) set({ parts: { ...s.parts, enabled: true } });
    } catch (e) { toasts.pushError(e); }
    setPartsConsent(false);
  };
  const [origins, setOrigins] = useState<{ id: number; origin: string; granted_at: string }[]>([]);
  const loadOrigins = async () => { if (!isTauri()) return; try { setOrigins((await call("fetch_origin_list", {})) ?? []); } catch { /* ignore */ } };
  const revokeOrigin = async (id: number) => { try { await call("fetch_origin_revoke", { id }); await loadOrigins(); } catch (e) { toasts.pushError(e); } };
  useEffect(() => { void loadParts(); void loadOrigins(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isTauri()) return;
    call("db_query", { query: { kind: "crash_list" } }).then((c) => setCrashes((c as typeof crashes) ?? [])).catch(() => undefined);
    call("db_query", { query: { kind: "metric_summary", project_key: active?.key ?? null } }).then((m) => setMetrics((m as MetricSummary) ?? {})).catch(() => undefined);
  }, [active?.key]);
  const bundle = async () => {
    const p = await saveDialog({ defaultPath: "fluxsmith-diagnostics.zip" });
    if (!p) return;
    try { await call("diag_bundle", { spec: { include_log: diag.log, include_settings: diag.settings, include_db_tables: diag.tables ? ["approvals", "consent_events", "checkpoints", "metrics", "model_calls", "compactions"] : [], include_project_meta: diag.project ? active?.key ?? null : null, out_path: p } }); toasts.push({ tone: "success", text: t("settings.privacy.diagCreate") }); }
    catch (e) { toasts.pushError(e); }
  };
  const exportFile = async (kind: "costs" | "metrics" | "transcript", ext: string) => {
    if (!active) return;
    const p = await saveDialog({ defaultPath: `fluxsmith-${kind}.${ext}` });
    if (!p) return;
    try { await call("export_file", { project_key: active.key, kind, payload: { format: ext }, out_path: p }); } catch (e) { toasts.pushError(e); }
  };
  return (
    <div className="col">
      <p className="muted">{t("settings.privacy.intro")}</p>
      <Callout tone="success" icon="security">{t("settings.privacy.zeroTelemetry")}</Callout>
      <Row label={t("settings.privacy.logLevel")} hint={t("settings.privacy.logLevelHint")}><Select value={s.privacy.log_level} onChange={(e) => set({ privacy: { log_level: e.target.value as "info" | "debug" } })} options={[{ value: "info", label: "info" }, { value: "debug", label: "debug" }]} /></Row>
      <h3>{t("settings.privacy.parts")}</h3>
      <p className="muted copy-sm">{t("settings.privacy.partsIntro")}</p>
      <Visible labels={[t("settings.privacy.partsEnable")]}><Switch label={t("settings.privacy.partsEnable")} checked={s.parts.enabled} onChange={(v) => { if (v) setPartsConsent(true); else set({ parts: { ...s.parts, enabled: false } }); }} /></Visible>
      <Visible labels={[t("settings.privacy.partsWith3d")]}><Switch label={t("settings.privacy.partsWith3d")} checked={s.parts.with_3d} onChange={(v) => set({ parts: { ...s.parts, with_3d: v } })} disabled={!s.parts.enabled} /></Visible>
      <Row label={t("settings.privacy.partsLibrary")} hint={t("settings.privacy.partsLibraryHint", { count: partsInfo.count, bytes: fmtBytes(partsInfo.bytes) })}><Button size="sm" variant="destructive" onClick={() => setPartsClear(true)}>{t("settings.privacy.partsLibraryClear")}</Button></Row>
      <Dialog open={partsClear} onClose={() => setPartsClear(false)} title={t("settings.privacy.partsLibraryClear")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setPartsClear(false)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent onClick={() => void clearParts()}>{t("common.confirm")}</Button></>}>
        <p>{t("settings.privacy.partsLibraryClearBody")}</p>
      </Dialog>
      <Dialog open={partsConsent} onClose={() => setPartsConsent(false)} title={t("settings.privacy.partsConsentTitle")} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setPartsConsent(false)}>{t("common.cancel")}</Button><Button variant="primary" consent onClick={() => void enableParts()}>{t("common.confirm")}</Button></>}>
        <p>{t("settings.privacy.partsConsentBody")}</p>
        <Callout tone="warning">{t("settings.privacy.partsConsentClaim")}</Callout>
      </Dialog>
      <h3>{t("settings.privacy.webOrigins")}</h3>
      <p className="muted copy-sm">{t("settings.privacy.webOriginsIntro")}</p>
      {origins.length === 0 ? <p className="muted copy-sm">{t("settings.privacy.webOriginsEmpty")}</p> : origins.map((o) => (
        <Row key={o.id} label={o.origin} hint={t("settings.privacy.webOriginsGranted", { at: fmtDate(o.granted_at) })}>
          <Button size="sm" variant="destructive" onClick={() => void revokeOrigin(o.id)}>{t("settings.privacy.webOriginsRevoke")}</Button>
        </Row>
      ))}
      <h3>{t("settings.privacy.diag")}</h3>
      <Switch label={t("settings.privacy.diagLog")} checked={diag.log} onChange={(v) => setDiag({ ...diag, log: v })} />
      <Switch label={t("settings.privacy.diagSettings")} checked={diag.settings} onChange={(v) => setDiag({ ...diag, settings: v })} />
      <Switch label={`${t("settings.privacy.diagTables")} — ${t("settings.privacy.diagTablesHint")}`} checked={diag.tables} onChange={(v) => setDiag({ ...diag, tables: v })} />
      <Switch label={t("settings.privacy.diagProject")} checked={diag.project} onChange={(v) => setDiag({ ...diag, project: v })} disabled={!active} />
      <div className="row"><Button size="sm" icon="download" onClick={() => void bundle()}>{t("settings.privacy.diagCreate")}</Button><Button size="sm" onClick={() => void exportFile("transcript", "jsonl")} disabled={!active}>{t("settings.privacy.exportTranscript")}</Button></div>
      <h3>{t("settings.privacy.crashes")}</h3>
      {crashes.length === 0 && <div className="muted copy-sm">{t("common.none")}</div>}
      {crashes.map((c) => <div key={c.req_id} className="row"><span className="muted copy-sm">{fmtDate(c.ts)}</span><span className="grow truncate copy-sm">{c.message}</span><Button size="sm" variant="ghost" icon="copy" onClick={() => { void navigator.clipboard?.writeText(c.req_id); toasts.push({ tone: "info", text: t("event.copiedReqId") }); }}>{t("chat.copyReqId")}</Button></div>)}
      <h3>{t("settings.privacy.stats")}</h3>
      <MetricsChart metrics={metrics} />
      <div className="row wrap">
        <Button size="sm" onClick={() => void exportFile("metrics", "json")} disabled={!active}>{t("settings.privacy.exportJson")}</Button>
        <span className="label">{t("settings.privacy.costs")}</span>
        <Button size="sm" onClick={() => void exportFile("costs", "csv")} disabled={!active}>{t("settings.privacy.exportCsv")}</Button>
        <Button size="sm" onClick={() => void exportFile("costs", "json")} disabled={!active}>{t("settings.privacy.exportJson")}</Button>
      </div>
    </div>
  );
}

function MetricsChart({ metrics }: { metrics: MetricSummary }) {
  const t = useT();
  const keys = ["intervention", "hard_stop", "rollback", "time_to_first_apply_ms", "cache_hit_ratio"] as const;
  const rows = keys.map((k) => ({ k, v: metrics[k]?.count ?? 0, avg: metrics[k]?.avg ?? 0, series: metrics[k]?.series ?? [] }));
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <div className="metrics">
      {rows.map((r) => (
        <div key={r.k} className="metric-row">
          <span className="copy-sm metric-label">{t(`settings.privacy.stats.${r.k}` as MessageKey)}</span>
          <svg className="metric-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden><rect x="0" y="0" width={(r.v / max) * 100} height="8" className="metric-fill" /></svg>
          <span className="fs-mono muted">{r.k === "cache_hit_ratio" ? `${Math.round(r.avg * 100)}%` : r.k === "time_to_first_apply_ms" ? `${Math.round(r.avg / 1000)} s` : r.v}</span>
          {r.series.length > 1 && <Sparkline data={r.series} />}
        </div>
      ))}
    </div>
  );
}

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 60},${16 - (v / max) * 14}`).join(" ");
  return <svg className="sparkline" viewBox="0 0 60 16" aria-hidden><polyline points={pts} fill="none" className="spark-line" strokeWidth={1} /></svg>;
}

function AdvancedTab() {
  const t = useT();
  const { s, set } = useSet();
  const env = useEnv();
  const toasts = useToasts();
  const [sandboxOff, setSandboxOff] = useState(false);
  const [about, setAbout] = useState(false);
  const a = s.advanced;
  const setA = (patch: Partial<Settings["advanced"]>) => set({ advanced: { ...a, ...patch } });
  useEffect(() => { void env.loadVersion(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const v: VersionInfo | null = env.version;
  const checkUpdates = async () => {
    if (!isTauri()) return;
    try {
      const r = await call("update_check", {});
      if (r.status === "unset") toasts.push({ tone: "warning", text: t("error.UPDATE_SOURCE_UNSET.title") + " — " + t("error.UPDATE_SOURCE_UNSET.next") });
      else if (r.status === "up_to_date") toasts.push({ tone: "success", text: t("update.upToDate", { ver: r.current }) });
      else toasts.push({ tone: "info", sticky: true, text: t("update.available", { ver: r.latest ?? "?", source: r.source ?? "" }), action: r.folder ? { label: t("update.openFolder"), run: () => void call("open_path", { path: r.folder as string }) } : undefined });
    } catch (e) { toasts.pushError(e); }
  };
  return (
    <div className="col">
      <details>
        <summary className="muted">{t("settings.advanced.intro")}</summary>
        <div className="col">
          <Row label={t("settings.advanced.stepThrottle")}><Switch checked={a.step_throttle} onChange={(v2) => setA({ step_throttle: v2 })} /></Row>
          <Row label={t("settings.advanced.imagesSize")}><Select value={a.images_size} onChange={(e) => setA({ images_size: e.target.value as "standard" | "large" })} options={[{ value: "standard", label: "standard" }, { value: "large", label: "large" }]} /></Row>
          <Row label={t("settings.advanced.toolParallelMax")} def="4" frozen><Input mono type="number" min={1} max={16} value={String(a.tool_parallel_max)} onChange={(e) => setA({ tool_parallel_max: Number(e.target.value) })} /></Row>
          <Row label={t("settings.advanced.drafterConcurrency")} def="3" frozen><Input mono type="number" min={1} max={8} value={String(a.drafter_concurrency)} onChange={(e) => setA({ drafter_concurrency: Number(e.target.value) })} /></Row>
          <Row label={t("settings.advanced.providerConnMax")} def="6" frozen><Input mono type="number" min={1} max={16} value={String(a.provider_conn_max)} onChange={(e) => setA({ provider_conn_max: Number(e.target.value) })} /></Row>
          <Row label={t("settings.advanced.sandbox")} frozen><Switch checked={a.sandbox_enabled} onChange={(v2) => (v2 ? setA({ sandbox_enabled: true }) : setSandboxOff(true))} /></Row>
          <Row label={t("settings.advanced.releaseDir")}><div className="col"><div className="row"><Input mono value={a.release_dir ?? ""} readOnly className="grow" /><Button size="sm" icon="open" onClick={() => void openDialog({ multiple: false, directory: true }).then((p) => typeof p === "string" && setA({ release_dir: p }))}>{t("common.open")}</Button><Button size="sm" variant="ghost" onClick={() => setA({ release_dir: null })}>{t("common.reset")}</Button></div><span className="muted copy-sm">{t("settings.advanced.releaseDirHint")}</span></div></Row>
          <Row label={t("settings.advanced.routerPath")}><div className="row"><Input mono value={a.router_path ?? ""} readOnly className="grow" /><Button size="sm" icon="open" onClick={() => void openDialog({ multiple: false }).then((p) => typeof p === "string" && setA({ router_path: p }))}>{t("common.open")}</Button><Button size="sm" variant="ghost" onClick={() => setA({ router_path: null })}>{t("common.reset")}</Button></div></Row>
        </div>
      </details>
      <h3>{t("settings.advanced.versions")}</h3>
      {v ? (
        <table className="env-table fs-mono"><tbody>
          <tr><td>app</td><td>{v.app}</td></tr><tr><td>engine</td><td>{v.engine}</td></tr><tr><td>protocol</td><td>{v.protocol_version}</td></tr><tr><td>tool manifest</td><td>{v.tool_manifest_version}</td></tr>
          <tr><td>db schema</td><td>{v.db_schema}</td></tr><tr><td>settings schema</td><td>{v.settings_schema}</td></tr><tr><td>kicad write</td><td>{v.kicad_write_version}</td></tr><tr><td>git</td><td>{v.git_sha}</td></tr>
        </tbody></table>
      ) : <div className="muted copy-sm">{t("common.unknown")}</div>}
      <div className="row">
        <Button size="sm" onClick={() => void checkUpdates()}>{t("settings.advanced.checkUpdates")}</Button>
        <Button size="sm" variant="ghost" onClick={() => setAbout(true)}>{t("settings.advanced.about")}</Button>
      </div>
      <Dialog open={sandboxOff} onClose={() => setSandboxOff(false)} title={t("settings.advanced.sandboxOffTitle")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setSandboxOff(false)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent onClick={() => { setA({ sandbox_enabled: false }); setSandboxOff(false); }}>{t("common.disable")}</Button></>}>
        <p>{t("settings.advanced.sandboxOffBody")}</p><p className="muted copy-sm">{t("settings.safetyConfirm")}</p>
      </Dialog>
      <Dialog open={about} onClose={() => setAbout(false)} title={t("about.title")} closeLabel={t("common.close")}>
        <p className="label">{t("app.name")} {v?.app ?? ""}</p>
        <p>{t("about.never")}</p>
        <p className="muted copy-sm">{t("about.licensesFull")}</p>
      </Dialog>
    </div>
  );
}
