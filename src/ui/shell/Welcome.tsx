// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useT, fmtDate } from "../../i18n";
import { useProjects } from "../../state/projects";
import { useToasts } from "../../state/toasts";
import { call, isTauri } from "../../ipc/client";
import { Button, Dialog, Input, Select, Icon, EmptyState } from "../components";

const PAPERS = ["A4", "A3", "A2", "A1", "A0", "A", "B", "C", "D", "E", "USLetter", "USLegal", "USLedger"];

export function useOpenProjectDialog() {
  const projects = useProjects();
  return async () => {
    if (!isTauri()) return;
    const picked = await open({ multiple: false, directory: false, filters: [{ name: "KiCad", extensions: ["kicad_pro", "kicad_sch"] }] });
    if (typeof picked === "string") await projects.open(picked);
  };
}

/**
 * First run has nothing to open. The bundled example is read-only inside the app bundle, so it is
 * copied into a folder the human picks (Rust does the copy and never overwrites) and then opened
 * like any other project — editable, with turns and rollback.
 */
export function useOpenExample() {
  const projects = useProjects();
  const toasts = useToasts();
  const t = useT();
  return async () => {
    if (!isTauri()) return;
    const dir = await open({ directory: true, multiple: false, title: t("project.exampleFolder") });
    if (typeof dir !== "string") return;
    try {
      const path = await call("example_install", { dir });
      await projects.open(path);
    } catch (e) { toasts.pushError(e); }
  };
}

export function NewProjectDialog({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const projects = useProjects();
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [paper, setPaper] = useState("A4");
  const pickDir = async () => {
    if (!isTauri()) return;
    const d = await open({ directory: true, multiple: false });
    if (typeof d === "string") setDir(d);
  };
  const create = async () => {
    const tab = await projects.create({ dir, name: name.trim(), paper, kicad_version: 10 });
    if (tab) onClose();
  };
  return (
    <Dialog open={isOpen} onClose={onClose} title={t("project.newTitle")} closeLabel={t("common.close")}
      footer={<><Button onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" disabled={!name.trim() || !dir} loading={projects.opening} onClick={() => void create()}>{t("project.new")}</Button></>}>
      <Input label={t("project.newName")} value={name} onChange={(e) => setName(e.target.value)} mono autoFocus />
      <div className="field">
        <label className="field-label">{t("project.newDir")}</label>
        <div className="row"><Input value={dir} readOnly mono className="grow" placeholder={t("common.pathPlaceholder")} /><Button icon="open" onClick={() => void pickDir()}>{t("project.chooseFolder")}</Button></div>
      </div>
      <Select label={t("project.newPaper")} value={paper} onChange={(e) => setPaper(e.target.value)} options={PAPERS.map((p) => ({ value: p, label: p }))} />
      {projects.error && <div className="field-error">{projects.error}</div>}
    </Dialog>
  );
}

export function Welcome() {
  const t = useT();
  const projects = useProjects();
  const openDialog = useOpenProjectDialog();
  const openExample = useOpenExample();
  const [showNew, setShowNew] = useState(false);
  useEffect(() => { void projects.loadRecent(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>{t("welcome.title")}</h1>
        <p className="muted">{t("welcome.hint")}</p>
        <div className="row">
          <Button variant="primary" icon="open" onClick={() => void openDialog()}>{t("project.open")}</Button>
          <Button icon="newProject" onClick={() => setShowNew(true)}>{t("project.new")}</Button>
          <Button icon="sparkles" onClick={() => void openExample()}>{t("project.example")}</Button>
        </div>
        <h3 className="welcome-recent-title">{t("project.recent")}</h3>
        {projects.recent.length === 0 ? (
          <EmptyState icon="sheet" title={t("welcome.noRecent")} hint={t("project.openHint")}
            primary={<Button size="sm" variant="primary" icon="sparkles" onClick={() => void openExample()}>{t("project.example")}</Button>} />
        ) : (
          <ul className="recent-list">
            {projects.recent.map((r) => (
              <li key={r.key} className="recent-item">
                <button type="button" className="recent-main" disabled={!r.exists} onClick={() => void projects.open(r.path)}>
                  <Icon name="sheet" />
                  <span className="col grow">
                    <span className="label truncate">{r.name}</span>
                    <span className="fs-mono muted truncate">{r.path}</span>
                  </span>
                  <span className="muted copy-sm">{r.exists ? fmtDate(r.last_opened) : t("project.recentMissing")}</span>
                </button>
                <Button variant="ghost" size="sm" icon="trash" onClick={() => void projects.forget(r.key)} aria-label={t("project.forget")} title={t("project.forget")} />
              </li>
            ))}
          </ul>
        )}
        {projects.error && <div className="field-error">{projects.error}</div>}
      </div>
      <NewProjectDialog open={showNew} onClose={() => setShowNew(false)} />
    </div>
  );
}


/** The folder was opened at another path before (moved or copied): the human decides, nothing is guessed. */
export function IdentityDialog() {
  const t = useT();
  const projects = useProjects();
  const p = projects.identityPrompt;
  const dismiss = () => useProjects.setState({ identityPrompt: null });
  return (
    <Dialog open={!!p} onClose={dismiss} title={t("project.identityTitle")} closeLabel={t("common.close")} width={520}
      footer={<>
        <Button onClick={dismiss}>{t("common.cancel")}</Button>
        <Button variant="secondary" loading={projects.opening} onClick={() => p && void projects.open(p.path, "copied")}>{t("project.identityCopied")}</Button>
        <Button variant="primary" loading={projects.opening} onClick={() => p && void projects.open(p.path, "moved")}>{t("project.identityMoved")}</Button>
      </>}>
      <p>{t("project.identityBody", { old: p?.old_path ?? "" })}</p>
      <p className="muted copy-sm fs-mono">{p?.path}</p>
      {projects.error && <div className="field-error">{projects.error}</div>}
    </Dialog>
  );
}
