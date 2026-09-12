// SPDX-License-Identifier: Apache-2.0
// Skill editor (docs/skill-packs.md): front-matter form + Markdown body for a pack's
// SKILL.md, an L0 preview (what the model sees in every session), lint results, save
// (the pack drops to untrusted until reviewed again — trust is a separate consent) and
// [Test] which replays the pack's `tests/` golden cases through the engine (no model).
// Mounted from the Skills tab: `import { SkillEditor } from "./SkillEditor";`
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { SkillPreview, SkillTestReport } from "../../ipc/types";
import { useToasts } from "../../state/toasts";
import { Badge, Button, Callout, Dialog, Input, Select, TextArea } from "../components";

export interface SkillEditorProps {
  open: boolean;
  pack: string;
  scope: "project" | "user";
  projectKey: string | null;
  /** SKILL.md path inside the pack (default `SKILL.md`). */
  path?: string;
  onClose: () => void;
  onSaved?: () => void;
}

interface FrontMatter { name: string; description: string; activation: string; roles: string }

/** Splits `---\n…\n---\n` front matter into a small form model + body; unknown keys are kept verbatim. */
export function splitFrontMatter(text: string): { fm: FrontMatter; extra: string[]; body: string } {
  const fm: FrontMatter = { name: "", description: "", activation: "manual", roles: "" };
  const extra: string[] = [];
  if (!text.startsWith("---")) return { fm, extra, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fm, extra, body: text };
  const block = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  let cur: string | null = null;
  const vals: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (/^\s/.test(line) && cur) { vals[cur] = `${vals[cur]} ${line.trim()}`.trim(); continue; }
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    cur = m[1];
    vals[cur] = m[2].replace(/^>-?\s*/, "").trim();
  }
  for (const [k, v] of Object.entries(vals)) {
    if (k === "name") fm.name = v;
    else if (k === "description") fm.description = v;
    else if (k === "activation") fm.activation = v;
    else if (k === "roles") fm.roles = v.replace(/^\[|\]$/g, "");
    else extra.push(`${k}: ${v}`);
  }
  return { fm, extra, body };
}

export function joinFrontMatter(fm: FrontMatter, extra: string[], body: string): string {
  const lines = [`name: ${fm.name}`, `description: >-\n  ${fm.description.trim()}`, `activation: ${fm.activation}`];
  if (fm.roles.trim()) lines.push(`roles: [${fm.roles.split(",").map((s) => s.trim()).filter(Boolean).join(", ")}]`);
  lines.push(...extra);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
}

export function SkillEditor({ open, pack, scope, projectKey, path = "SKILL.md", onClose, onSaved }: SkillEditorProps) {
  const t = useT();
  const toasts = useToasts();
  const [fm, setFm] = useState<FrontMatter>({ name: pack, description: "", activation: "manual", roles: "" });
  const [extra, setExtra] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SkillTestReport | null>(null);
  useEffect(() => {
    if (!open || !isTauri()) return;
    call("skills_read", { pack, path }).then((text) => { const s = splitFrontMatter(text); setFm(s.fm); setExtra(s.extra); setBody(s.body); }).catch((e) => toasts.pushError(e));
    setReport(null);
  }, [open, pack, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = joinFrontMatter(fm, extra, body);
  useEffect(() => {
    if (!open || !isTauri()) return;
    const id = window.setTimeout(() => { call("skills_preview", { text }).then(setPreview).catch(() => setPreview(null)); }, 250);
    return () => window.clearTimeout(id);
  }, [text, open]);
  const save = async () => {
    setBusy(true);
    try {
      await call("skills_write_file", { pack, path, text, scope, project_key: projectKey });
      toasts.push({ tone: "info", text: t("settings.skillEditor.saved") });
      onSaved?.();
    } catch (e) { toasts.pushError(e); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try { setReport(await call("skills_test", { pack, project_key: projectKey })); } catch (e) { toasts.pushError(e); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`${t("settings.skillEditor.title")} · ${pack}`} closeLabel={t("common.close")} width={760} className="skill-editor"
      footer={<><Button onClick={() => void test()} disabled={busy} icon="play">{t("settings.skillEditor.test")}</Button><span className="grow" /><Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void save()} disabled={!fm.name.trim() || !fm.description.trim()}>{t("common.save")}</Button></>}>
      <div className="row skill-editor-fm">
        <Input label={t("settings.skillEditor.name")} value={fm.name} onChange={(e) => setFm({ ...fm, name: e.target.value })} mono />
        <Select label={t("settings.skillEditor.activation")} value={fm.activation} onChange={(e) => setFm({ ...fm, activation: e.target.value })} options={["always", "auto", "manual"].map((v) => ({ value: v, label: v }))} />
        <Input label={t("settings.skillEditor.roles")} value={fm.roles} onChange={(e) => setFm({ ...fm, roles: e.target.value })} mono placeholder="lead, drafter" />
      </div>
      <TextArea label={t("settings.skillEditor.description")} value={fm.description} onChange={(e) => setFm({ ...fm, description: e.target.value })} rows={2} />
      <TextArea label={t("settings.skillEditor.body")} value={body} onChange={(e) => setBody(e.target.value)} rows={14} className="fs-mono" />
      {preview && (
        <div className="skill-preview">
          <div className="row"><span className="label-sm">{t("settings.skillEditor.preview")}</span><span className="muted copy-sm">{t("settings.skillEditor.l0Chars", { n: preview.l0_chars })}</span><span className="grow" />{preview.sections.length > 0 && <span className="muted copy-sm">{t("settings.skillEditor.sections")}: {preview.sections.join(", ")}</span>}</div>
          <pre className="md-pre selectable">{preview.l0_text}</pre>
          {preview.lint.length > 0 && <Callout tone="warning">{t("settings.skillEditor.lint")}: {preview.lint.join("; ")}</Callout>}
        </div>
      )}
      {report && (
        <div className="skill-tests">
          <div className="row"><Badge tone={report.total === 0 ? "neutral" : report.pass === report.total ? "success" : "warning"}>{report.total === 0 ? t("settings.skillEditor.noTests") : t("settings.skillEditor.testResult", { pass: report.pass, total: report.total })}</Badge></div>
          {report.cases.map((c) => <div key={c.name} className="row copy-sm"><span className="fs-mono">{c.name}</span><Badge tone={c.pass ? "success" : "error"}>{c.score.toFixed(2)}</Badge><span className="muted truncate">{c.detail}</span></div>)}
        </div>
      )}
    </Dialog>
  );
}
