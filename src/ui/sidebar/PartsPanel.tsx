// SPDX-License-Identifier: Apache-2.0
// Shared parts library: every LCSC part fetched for any project (app data
// `parts/<LCSC>/` + `libs/fluxsmith-parts.*`), browsable and reusable here.
import { useEffect, useState } from "react";
import { useT, fmtDate } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { PartsCacheRow } from "../../ipc/types";
import type { ProjectTab } from "../../state/projects";
import { Button, ContextMenu, EmptyState, Icon, Input } from "../components";
import { useToasts } from "../../state/toasts";
import type { BridgeStore } from "../harness-bridge";

export function PartsPanel({ tab, bridge }: { tab: ProjectTab; bridge: BridgeStore }) {
  const t = useT();
  const toasts = useToasts();
  const st = bridge((s) => s.state);
  const [rows, setRows] = useState<PartsCacheRow[]>([]);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; row: PartsCacheRow } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // OQ: multi-unit symbols with units still unplaced (engine summary `units`).
  const [unplaced, setUnplaced] = useState<{ ref: string; placed: number[]; total: number }[]>([]);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    call("engine_request", { project_key: tab.key, request: { kind: "summary" }, auth: {} }).then((res) => {
      if (!alive || !res.ok) return;
      const units = ((res.data as { units?: Record<string, { placed?: number[]; total?: number }> })?.units) ?? {};
      setUnplaced(Object.entries(units).map(([ref, u]) => ({ ref, placed: u.placed ?? [], total: u.total ?? 1 })).filter((u) => u.placed.length < u.total).sort((a, b) => a.ref.localeCompare(b.ref)));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [tab.key, tab.info.last_turn]);
  const load = async (q = query) => {
    if (!isTauri()) return;
    try { setRows(((await call("db_query", { query: { kind: "parts_cache_list", query: q || null } })) as PartsCacheRow[]) ?? []); } catch { setRows([]); }
  };
  useEffect(() => { void load(); }, [tab.key, tab.info.last_turn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = window.setTimeout(() => void load(query), 200); return () => window.clearTimeout(id); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (id: string, row: PartsCacheRow) => {
    setMenu(null);
    setBusy(row.lcsc);
    try {
      if (id === "import") {
        if (!st.build_session) { toasts.push({ tone: "warning", text: t("parts.importNeedsBuild") }); return; }
        const res = await call("parts_convert", { project_key: tab.key, lcsc: row.lcsc, lib_nickname: null, with_3d: null, auth: { build_session: st.build_session, role: "lead" } });
        const data = (res as { data?: { lib_id?: string; warnings?: unknown } }).data;
        const lib_id = data?.lib_id ?? "?";
        // Conversion warnings (pin/pad mismatch, skipped shapes, no 3D model) used to be dropped
        // here behind a success toast: a converted part is a claim, and this is where the human
        // finds out what is wrong with it. The strings come from the engine and are shown as text.
        const warnings = (Array.isArray(data?.warnings) ? data.warnings : []).filter((w): w is string => typeof w === "string" && !!w.trim());
        if (warnings.length) toasts.push({ tone: "warning", sticky: true, text: t("parts.importedWithWarnings", { lcsc: row.lcsc, lib_id, n: warnings.length, warnings: warnings.join(" / ") }) });
        else toasts.push({ tone: "success", text: t("parts.imported", { lcsc: row.lcsc, lib_id }) });
      } else if (id === "refresh") {
        await call("parts_refresh", { lcsc: row.lcsc });
      } else if (id === "remove") {
        await call("db_query", { query: { kind: "parts_cache_forget", lcsc: row.lcsc } });
      } else if (id === "reveal") {
        const base = await call("app_data_path", {});
        await call("open_path", { path: `${base}/parts/${row.lcsc}` });
      }
      await load();
    } catch (e) {
      toasts.pushError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="col parts-panel">
      <details className="unplaced" open={unplaced.length > 0}>
        <summary className="label-sm">{t("parts.unplacedTitle")}{unplaced.length > 0 && <span className="badge">{unplaced.length}</span>}</summary>
        {unplaced.length === 0 ? <div className="muted copy-sm">{t("parts.unplacedNone")}</div> : (
          <ul className="unplaced-list">
            {unplaced.map((u) => {
              const missing = Array.from({ length: u.total }, (_, i) => i + 1).filter((n) => !u.placed.includes(n));
              return <li key={u.ref} className="copy-sm fs-mono">{t("parts.unplacedUnits", { ref: u.ref, placed: u.placed.length, total: u.total, missing: missing.map((n) => String.fromCharCode(64 + n)).join(", ") })}</li>;
            })}
          </ul>
        )}
      </details>
      <p className="muted copy-sm">{t("parts.intro")}</p>
      <Input placeholder={t("parts.search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("parts.search")} />
      {rows.length === 0 ? (
        <EmptyState icon="parts" title={t("parts.empty")} />
      ) : (
        <ul className="parts-list">
          {rows.map((r) => (
            <li key={r.lcsc} className={`parts-item ${busy === r.lcsc ? "busy" : ""}`} onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row: r }); }}>
              <div className="row">
                <span className="fs-mono label-sm">{r.lcsc}</span>
                <span className="truncate grow label-sm">{r.mpn}</span>
                {r.basic && <span className="badge">{t("parts.basic")}</span>}
              </div>
              <div className="row copy-sm muted">
                <span className="truncate grow">{r.description || r.package}</span>
                <span>{r.package}</span>
              </div>
              <div className="row copy-sm muted">
                <span>{t("parts.stock", { n: r.stock })}</span>
                <span className="grow">{t("parts.fetched", { when: fmtDate(r.fetched_at) })}</span>
                <span className="parts-assets" aria-hidden>
                  {r.has_cad && <Icon name="component" className="icon-sm" title={t("parts.asset.cad")} />}
                  {r.has_symbol && <Icon name="sheet" className="icon-sm" title={t("parts.asset.symbol")} />}
                  {r.has_footprint && <Icon name="grid" className="icon-sm" title={t("parts.asset.footprint")} />}
                  {r.has_step && <Icon name="storage" className="icon-sm" title={t("parts.asset.step")} />}
                  {r.datasheet_sha && <Icon name="doc" className="icon-sm" title={t("parts.asset.pdf")} />}
                </span>
                <Button size="sm" variant="ghost" icon="download" onClick={() => void act("import", r)} disabled={busy === r.lcsc}>{t("parts.import")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ContextMenu at={menu ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)}
        items={[{ id: "import", label: t("parts.import"), icon: "download" }, { id: "refresh", label: t("parts.refresh"), icon: "loading" }, { id: "reveal", label: t("parts.reveal"), icon: "open" }, { id: "remove", label: t("parts.remove"), icon: "trash" }]}
        onSelect={(id) => { if (menu) void act(id, menu.row); }} />
    </div>
  );
}
