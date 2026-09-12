// SPDX-License-Identifier: Apache-2.0
// Conversation history for one project: list, switch, rename, delete, export.
import { useCallback, useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useLang, useT } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { ProjectTab } from "../../state/projects";
import { useToasts } from "../../state/toasts";
import { Badge, Button, Dialog, EmptyState, IconButton, Input } from "../components";
import type { BridgeStore } from "../harness-bridge";
import { listSessions, newSession, switchSession, type SessionRow } from "../sessions";

function relTime(iso: string, t: ReturnType<typeof useT>): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return t("time.justNow");
  const m = Math.floor(ms / 60_000);
  if (m < 60) return t("time.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t("time.hoursAgo", { n: h });
  return t("time.daysAgo", { n: Math.floor(h / 24) });
}

export function Sessions({ tab, bridge }: { tab: ProjectTab; bridge: BridgeStore }) {
  const t = useT();
  useLang();
  const toasts = useToasts();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [confirm, setConfirm] = useState<SessionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const turns = bridge((s) => s.turns.length);
  const running = bridge((s) => s.state.running);
  const reload = useCallback(() => { void listSessions(tab.key).then(setRows); }, [tab.key]);
  useEffect(() => { reload(); }, [reload, tab.sessionId, turns]);

  const firstLine = (r: SessionRow) => r.title?.trim() || t("side.sessionUntitled");
  const create = async () => { setBusy(true); try { await newSession(tab.key); reload(); } catch (e) { toasts.pushError(e); } finally { setBusy(false); } };
  const open = async (r: SessionRow) => { if (r.session_id === tab.sessionId) return; setBusy(true); try { await switchSession(tab.key, r.session_id); } catch (e) { toasts.pushError(e); } finally { setBusy(false); } };
  const rename = async () => {
    if (!editing) return;
    try { await call("db_query", { query: { kind: "session_rename", session_id: editing.id, title: editing.title.trim() } }); } catch (e) { toasts.pushError(e); }
    setEditing(null); reload();
  };
  const remove = async () => {
    if (!confirm) return;
    const id = confirm.session_id;
    try {
      await call("db_query", { query: { kind: "session_delete", session_id: id } });
      setConfirm(null);
      if (id === tab.sessionId) {
        const rest = rows.filter((r) => r.session_id !== id);
        if (rest[0]) await switchSession(tab.key, rest[0].session_id); else await newSession(tab.key);
      }
      reload();
    } catch (e) { toasts.pushError(e); }
  };
  const exportJsonl = async (r: SessionRow) => {
    try {
      const out = await saveDialog({ defaultPath: `fluxsmith-${firstLine(r).replace(/[^\w.-]+/g, "_").slice(0, 40)}.jsonl` });
      if (!out) return;
      const payload = await call("db_query", { query: { kind: "messages_export", session_id: r.session_id } });
      await call("export_file", { project_key: tab.key, kind: "transcript", payload, out_path: out });
      toasts.push({ tone: "success", text: t("side.exportSession") });
    } catch (e) { toasts.pushError(e); }
  };

  return (
    <div className="col">
      <Button size="sm" icon="add" onClick={() => void create()} disabled={busy || running || !isTauri()}>{t("side.newSession")}</Button>
      {rows.length === 0 ? <EmptyState icon="status" title={t("empty.sessions")} /> : (
        <ul className="session-list">
          {rows.map((r) => {
            const active = r.session_id === tab.sessionId;
            return (
              <li key={r.session_id} className={`session-item ${active ? "active" : ""}`}>
                {editing?.id === r.session_id ? (
                  <form className="row grow" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                    <Input autoFocus value={editing.title} onChange={(e) => setEditing({ id: r.session_id, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} className="grow" aria-label={t("side.renameSession")} />
                    <Button size="sm" type="submit">{t("common.save")}</Button>
                  </form>
                ) : (
                  <>
                    <button type="button" className="session-main" onClick={() => void open(r)} disabled={busy || running} title={firstLine(r)}>
                      <span className="truncate grow">{firstLine(r)}</span>
                      {active && <Badge tone="success">{t("side.sessionActive")}</Badge>}
                      <span className="muted copy-sm nowrap">{relTime(r.updated, t)}{r.messages ? ` · ${t("side.sessionMessages", { n: r.messages })}` : ""}</span>
                    </button>
                    <span className="session-actions">
                      <IconButton icon="edit" label={t("side.renameSession")} size="sm" variant="ghost" onClick={() => setEditing({ id: r.session_id, title: r.title ?? "" })} />
                      <IconButton icon="download" label={t("side.exportSession")} size="sm" variant="ghost" onClick={() => void exportJsonl(r)} />
                      <IconButton icon="trash" label={t("side.deleteSession")} size="sm" variant="ghost" onClick={() => setConfirm(r)} disabled={running && active} />
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title={t("side.deleteSession")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setConfirm(null)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" onClick={() => void remove()}>{t("side.deleteSession")}</Button></>}>
        <p>{t("side.deleteSessionBody", { title: confirm ? firstLine(confirm) : "" })}</p>
      </Dialog>
    </div>
  );
}
