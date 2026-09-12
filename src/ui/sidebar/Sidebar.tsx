// SPDX-License-Identifier: Apache-2.0
// Left column: sheet tree, components/nets, findings, turns timeline, attachments, symbol-index state.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useT, useLang, fmtDay, fmtUsd, fmtDuration, findingCopy, type MessageKey } from "../../i18n";
import { waiveBatch, waiveConsentSha, waiverRefs } from "../../agent/review-waiver";
import { bucketCounts, defaultFixSelection, findingBucket, fixCost, fixCostCounts, isWaivable, type FindingBucket, type FixCost } from "../../agent/findings";
import { countsBySheet, filterFindings, SEVERITY_KEYS, type SeverityKey } from "../finding-filter";
import { call, isTauri } from "../../ipc/client";
import type { AttachInfo, DbQuery, ProjectInfo } from "../../ipc/types";
import type { Card, PlanView, Ref, FindingRow } from "../../agent/api";
import { findingFocusRefs, findingMatches } from "../../agent/finding-ref";
import { isWaived } from "../../agent/policy/types";
import { usePrefs } from "../../state/prefs";
import { useToasts } from "../../state/toasts";
import { useProjects, type ProjectTab } from "../../state/projects";
import { Badge, Button, Callout, Dialog, EmptyState, Icon, IconButton, Input, ProgressBar, Select, Tabs, TextArea } from "../components";
import { AutoPolicyDialog } from "../components/AutoPolicyDialog";
import { WaiverForm } from "../components/WaiverForm";
import { RollbackDialog } from "../chat/RollbackDialog";
import { sheetThumb } from "../thumbs";
import type { BridgeStore, TurnBlock } from "../harness-bridge";
import { instanceByNames, instanceByPath, sheetLabel } from "../sheet-paths";
import { duplicateInstances, netInstance, netSheetLabels, otherSheets, type CompRow, type ListScope, type NetRow } from "./list-scope";
import { useEnvIndex } from "./index-state";
import { Sessions } from "./Sessions";
import { PartsPanel } from "./PartsPanel";


export function Sidebar({ tab, bridge, onFocus }: { tab: ProjectTab; bridge: BridgeStore; onFocus: (refs: Ref[]) => void }) {
  const t = useT();
  const { sidebarTab, setSidebarTab } = usePrefs();
  const pending = bridge((s) => s.pendingCardId);
  // Canvas double-click / marker click / context menu: switch to the requested tab (the tab's own listener does the rest).
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<{ tab?: string }>).detail; if (d?.tab) setSidebarTab(d.tab); };
    document.addEventListener("fs:sidebar-open", h);
    return () => document.removeEventListener("fs:sidebar-open", h);
  }, [setSidebarTab]);
  const items = [
    { id: "sheets", label: t("side.sheets"), icon: "sheet" as const },
    { id: "components", label: t("side.components"), icon: "component" as const },
    { id: "findings", label: t("side.findings"), icon: "findings" as const },
    { id: "plan", label: t("side.plan"), icon: "plan" as const },
    { id: "turns", label: t("side.turns"), icon: "turn" as const, badge: !!pending },
    { id: "sessions", label: t("side.sessions"), icon: "status" as const },
    { id: "attachments", label: t("side.attachments"), icon: "attachment" as const },
    { id: "parts", label: t("side.parts"), icon: "parts" as const },
  ];
  return (
    <aside className="sidebar" aria-label={t("side.panel")} tabIndex={-1}>
      <Tabs items={items} value={sidebarTab} onChange={setSidebarTab} variant="underline" ariaLabel={t("side.panel")} iconOnly />
      <div className="sidebar-body scroll">
        {sidebarTab === "sheets" && <SheetTree tab={tab} />}
        {sidebarTab === "components" && <ComponentsNets tab={tab} onFocus={onFocus} bridge={bridge} />}
        {sidebarTab === "findings" && <Findings tab={tab} bridge={bridge} onFocus={onFocus} />}
        {sidebarTab === "plan" && <PlanPanel tab={tab} bridge={bridge} />}
        {sidebarTab === "turns" && <Turns tab={tab} bridge={bridge} />}
        {sidebarTab === "sessions" && <Sessions tab={tab} bridge={bridge} />}
        {sidebarTab === "attachments" && <Attachments tab={tab} bridge={bridge} />}
        {sidebarTab === "parts" && <PartsPanel tab={tab} bridge={bridge} />}
      </div>
      <IndexStatus />
    </aside>
  );
}

function SheetTree({ tab }: { tab: ProjectTab }) {
  const t = useT();
  const { setSheet } = useProjects();
  const info: ProjectInfo = tab.info;
  const theme = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    for (const s of info.sheets) {
      void sheetThumb(tab.key, s.instance_path, info.last_turn, theme).then((url) => { if (alive && url) setThumbs((m) => (m[s.instance_path] === url ? m : { ...m, [s.instance_path]: url })); });
    }
    return () => { alive = false; };
  }, [tab.key, info.sheets, info.last_turn, theme]);
  return (
    <div className="col">
      <ul className="tree">
        {info.sheets.map((s) => {
          const depth = Math.max(0, s.instance_path.split("/").filter(Boolean).length);
          return (
            <li key={s.instance_path}>
              <button type="button" className={`tree-item ${tab.sheet === s.instance_path ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setSheet(tab.key, s.instance_path)}>
                {thumbs[s.instance_path] ? <img className="sheet-thumb" src={thumbs[s.instance_path]} alt="" width={48} height={32} /> : <Icon name="sheet" className="icon-sm" />}
                <span className="truncate grow">{s.names[s.names.length - 1] || info.name}</span>
                <span className="muted fs-mono">{s.symbols}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="muted copy-sm sidebar-foot">
        <div className="fs-mono truncate" title={info.root}>{info.root}</div>
        {info.git && <div>{t("side.git", { state: info.git.dirty ? t("side.gitDirty") : t("side.gitClean") })}</div>}
        {info.locked && <Badge tone="warning">{t("project.locked")}</Badge>}
      </div>
    </div>
  );
}

interface NetsData { nets: NetRow[]; total: number; truncated: boolean }
/** `read` answers with `total` as a count per kind; the older shape (a plain number) still reads. */
interface ReadData { symbols?: CompRow[]; total?: number | { symbols?: number }; truncated?: boolean }

/** Symbols the engine returned, before the search box filters them. */
function totalSymbols(rd: ReadData | null | undefined): number | null {
  if (typeof rd?.total === "number") return rd.total;
  return typeof rd?.total?.symbols === "number" ? rd.total.symbols : null;
}

interface ComponentDetail { ref: string; lib_id: string; value: string; footprint?: string; total_units?: number; attributes?: { dnp?: boolean; in_bom?: boolean; on_board?: boolean }; fields?: { name: string; value: string }[]; pins?: { unit?: number; number: string; name: string; type?: string; net?: string | null }[] }

/** Expanded detail of one component (FR-204 popover content, rendered as text nodes in the row below). */
function ComponentDetailRow({ tab, reference, cols }: { tab: ProjectTab; reference: string; cols: number }) {
  const t = useT();
  const [d, setD] = useState<ComponentDetail | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    (async () => {
      try {
        const r = await call("engine_request", { project_key: tab.key, request: { kind: "component", reference }, auth: {} });
        if (alive && r.ok) setD(r.data as ComponentDetail);
      } catch { /* shown empty */ }
    })();
    return () => { alive = false; };
  }, [tab.key, reference, tab.info.last_turn]);
  if (!d) return <tr className="component-detail"><td colSpan={cols} className="muted">{t("common.loading")}</td></tr>;
  const attrs = [d.attributes?.dnp ? t("side.component.dnp") : null, d.attributes && d.attributes.in_bom === false ? t("side.component.notInBom") : null, d.attributes && d.attributes.on_board === false ? t("side.component.notOnBoard") : null].filter(Boolean).join(" · ");
  return (
    <tr className="component-detail"><td colSpan={cols}>
      <div className="col copy-sm">
        <div><span className="muted">{t("side.component.footprint")}: </span><span className="fs-mono">{d.footprint || "-"}</span></div>
        {attrs && <div className="muted">{attrs}</div>}
        {(d.fields ?? []).filter((f) => !["Reference", "Value", "Footprint", "Datasheet"].includes(f.name) && f.value).map((f) => <div key={f.name}><span className="muted">{f.name}: </span><span className="selectable">{f.value}</span></div>)}
        {(d.pins ?? []).length > 0 && (
          <table className="side-table fs-mono"><tbody>
            {(d.pins ?? []).map((p) => <tr key={`${p.unit ?? 1}:${p.number}`}><td>{p.number}</td><td className="truncate">{p.name}</td><td className={p.net ? "" : "muted"}>{p.net ?? t("canvas.status.noNet")}</td></tr>)}
          </tbody></table>
        )}
      </div>
    </td></tr>
  );
}

function ComponentsNets({ tab, onFocus, bridge }: { tab: ProjectTab; onFocus: (refs: Ref[]) => void; bridge: BridgeStore }) {
  const t = useT();
  const [q, setQ] = useState("");
  /** This sheet (the default) or the whole project; the engine answers both in one request. */
  const [scope, setScope] = useState<ListScope>("sheet");
  const [comps, setComps] = useState<NonNullable<ReadData["symbols"]>>([]);
  const [nets, setNets] = useState<NetsData["nets"]>([]);
  /** Engine-side truncation of either list (the panel asks for 500): shown, never silent. */
  const [truncated, setTruncated] = useState<{ comps: number | null; nets: number | null }>({ comps: null, nets: null });
  const selection = bridge((s) => s.selection);
  const selectedRefs = useMemo(() => new Set(selection.filter((r) => r.kind === "component").map((r) => (r as { ref: string }).ref)), [selection]);
  const selectedNets = useMemo(() => new Set(selection.filter((r) => r.kind === "net").map((r) => (r as { name: string }).name)), [selection]);
  const [openRef, setOpenRef] = useState<string | null>(null);
  // Canvas selection / double-click: bring the matching row into view (and expand it when asked).
  // Rows are found by data attribute, not by id: across sheets the same designator can be two rows.
  useEffect(() => {
    const first = selection.find((r) => r.kind === "component" || r.kind === "net");
    if (!first) return;
    const want = first.kind === "component" ? first.ref : (first as { name: string }).name;
    const attr = first.kind === "component" ? "ref" : "net";
    for (const el of document.querySelectorAll<HTMLElement>("tr[data-ref], tr[data-net]")) {
      if (el.dataset[attr] === want) { el.scrollIntoView?.({ block: "nearest" }); break; }
    }
  }, [selection]);
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ tab: string; refs: Ref[] }>).detail;
      if (d?.tab !== "components") return;
      const c = d.refs?.find((r) => r.kind === "component");
      if (c) { setOpenRef(c.ref); setQ(""); }
    };
    document.addEventListener("fs:sidebar-open", h);
    return () => document.removeEventListener("fs:sidebar-open", h);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    (async () => {
      try {
        // One request for the whole project, not one per sheet: `all_sheets` walks every instance
        // (a reused sheet is listed once per instance, with the reference KiCad annotates there).
        const all = scope === "all";
        const r = await call("engine_request", { project_key: tab.key, request: { kind: "read", sheet: all ? null : tab.sheet, limit: 500, all_sheets: all }, auth: {} });
        const n = await call("engine_request", { project_key: tab.key, request: { kind: "nets", sheet: all ? null : tab.sheet, limit: 500 }, auth: {} });
        if (!alive) return;
        const rd = r.data as ReadData; const nd = n.data as NetsData;
        const rows = rd?.symbols ?? [];
        setComps(rows.filter((s) => !s.reference.startsWith("#")));
        setNets(nd?.nets ?? []);
        // What is missing is what the engine counted minus what it sent -- the byte cap can cut a
        // list the engine itself did not consider truncated, and silence would be a lie either way.
        const ct = totalSymbols(rd);
        setTruncated({
          comps: ct !== null && ct > rows.length ? ct : null,
          nets: typeof nd?.total === "number" && nd.total > (nd.nets?.length ?? 0) ? nd.total : null,
        });
      } catch { /* shown as empty */ }
    })();
    return () => { alive = false; };
  }, [tab.key, tab.sheet, tab.info.last_turn, scope]);
  const ql = q.trim().toLowerCase();
  const fc = useMemo(() => comps.filter((c) => !ql || c.reference.toLowerCase().includes(ql) || c.value.toLowerCase().includes(ql) || c.lib_id.toLowerCase().includes(ql)), [comps, ql]);
  const [showUnconnected, setShowUnconnected] = useState(false);
  // KiCad names a no-connect / dangling pin `unconnected-(J1-D+-PadA6)`: noise unless asked for.
  const isUnconnected = (name: string) => /^\/?unconnected-/i.test(name);
  const unconnectedCount = useMemo(() => nets.filter((n) => isUnconnected(n.name)).length, [nets]);
  const fn = useMemo(() => nets.filter((n) => (showUnconnected || !isUnconnected(n.name)) && (!ql || n.name.toLowerCase().includes(ql))), [nets, ql, showUnconnected]);
  const all = scope === "all";
  const sheets = tab.info.sheets;
  const here = useMemo(() => sheets.find((s) => s.instance_path === tab.sheet) ?? null, [sheets, tab.sheet]);
  // Designators shared by two sheet instances. This is not a verdict: the engine's own finding is
  // named when it has one, and otherwise the row only states where else the designator sits.
  const dupes = useMemo(() => (all ? duplicateInstances(comps) : new Map<string, string[]>()), [all, comps]);
  const findings = bridge((s) => s.findings);
  const dupFinding = useCallback((reference: string) => findings.find((f) => !f.resolved && f.code === "DUPLICATE_DESIGNATOR_PROJECT" && (f.refs ?? []).some((r) => r.split(".")[0] === reference))?.code ?? null, [findings]);
  /** The ref a row hands the canvas: its own sheet instance, so a reused sheet frames the right one. */
  const compRef = useCallback((c: CompRow): Ref => ({ kind: "component", ref: c.reference, sheet: c.instance_path ?? tab.sheet }), [tab.sheet]);
  return (
    <div className="col">
      <Tabs variant="segmented" value={scope} onChange={(v) => setScope(v as ListScope)} ariaLabel={t("side.listScope")} items={[{ id: "sheet", label: t("side.listScope.sheet") }, { id: "all", label: t("side.listScope.all") }]} />
      <Input placeholder={t("common.search")} aria-label={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      <h3>{t("side.components")}</h3>
      {truncated.comps !== null && <Callout tone="warning">{t("side.truncated", { n: comps.length, total: truncated.comps })}</Callout>}
      {fc.length === 0 ? <EmptyState title={ql ? t("empty.searchNone", { q }) : t("empty.components")} primary={ql ? <Button size="sm" onClick={() => setQ("")}>{t("common.clear")}</Button> : undefined} /> : (
        <table className="side-table fs-mono" role="grid" aria-label={t("side.components")} aria-multiselectable="true">
          <thead><tr><th scope="col">{t("side.col.ref")}</th><th scope="col">{t("side.col.value")}</th><th scope="col">{t("side.col.footprint")}</th>{all && <th scope="col">{t("side.col.sheet")}</th>}<th scope="col" aria-label={t("side.col.detail")} /></tr></thead>
          <tbody>{fc.map((c) => {
            const others = dupes.has(c.reference) ? otherSheets(sheets, dupes.get(c.reference)!, c.instance_path, c.sheet ?? "") : [];
            const code = others.length ? dupFinding(c.reference) : null;
            return (
            <React.Fragment key={`${c.instance_path ?? ""}:${c.reference}`}>
              <tr data-ref={c.reference} role="row" className={selectedRefs.has(c.reference) ? "selected" : ""} aria-selected={selectedRefs.has(c.reference)} onClick={() => onFocus([compRef(c)])} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onFocus([compRef(c)]); if (e.key === " ") { e.preventDefault(); setOpenRef((o) => (o === c.reference ? null : c.reference)); } }}>
                <td>{c.reference}{others.length > 0 && <div className="copy-sm muted">{code ? t("side.duplicateDesignator", { code, sheet: others.join(", ") }) : t("side.alsoOn", { sheet: others.join(", ") })}</div>}</td>
                <td className="truncate" title={c.value}>{c.value}</td><td className="muted truncate" title={c.footprint ? `${c.footprint} · ${c.lib_id}` : c.lib_id}>{c.footprint ? c.footprint.replace(/^[^:]+:/, "") : c.lib_id}{c.footprint && ql && c.lib_id.toLowerCase().includes(ql) && <div className="copy-sm">{c.lib_id}</div>}</td>
                {all && <td className="muted truncate" title={sheetLabel(instanceByPath(sheets, c.instance_path ?? ""), c.sheet ?? "")}>{c.sheet}</td>}
                <td className="side-table-ctl"><IconButton icon={openRef === c.reference ? "chevronUp" : "chevronDown"} label={t("side.col.detail")} aria-expanded={openRef === c.reference} tabIndex={-1} onClick={(e) => { e.stopPropagation(); setOpenRef((o) => (o === c.reference ? null : c.reference)); }} /></td>
              </tr>
              {openRef === c.reference && <ComponentDetailRow tab={tab} reference={c.reference} cols={all ? 5 : 4} />}
            </React.Fragment>
          ); })}</tbody>
        </table>
      )}
      <h3>{t("side.nets")}</h3>
      {unconnectedCount > 0 && <label className="row copy-sm muted"><input type="checkbox" checked={showUnconnected} onChange={(e) => setShowUnconnected(e.target.checked)} /> {t("side.showUnconnected", { n: unconnectedCount })}</label>}
      {truncated.nets !== null && <Callout tone="warning">{t("side.truncated", { n: nets.length, total: truncated.nets })}</Callout>}
      {fn.length === 0 ? <EmptyState title={ql ? t("empty.searchNone", { q }) : t("empty.nets")} /> : (
        <table className="side-table fs-mono" role="grid" aria-label={t("side.nets")} aria-multiselectable="true">
          <thead><tr><th scope="col">{t("side.col.net")}</th><th scope="col">{t("side.col.scope")}</th><th scope="col">{t("side.col.pins")}</th>{all && <th scope="col">{t("side.col.sheet")}</th>}</tr></thead>
          <tbody>{fn.map((n) => {
            const to = all ? netInstance(sheets, here, n.sheets) : undefined;
            const netRef: Ref = to ? { kind: "net", name: n.name, sheet: to } : { kind: "net", name: n.name };
            return (
            <tr key={n.name} data-net={n.name} role="row" className={selectedNets.has(n.name) ? "selected" : ""} aria-selected={selectedNets.has(n.name)} onClick={() => onFocus([netRef])} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") onFocus([netRef]); }}>
              <td className="truncate" title={n.name}>{n.name}</td><td className="muted">{n.scope}</td><td className="muted">{n.members}</td>
              {all && <td className="muted truncate" title={netSheetLabels(sheets, n.sheets)}>{netSheetLabels(sheets, n.sheets)}</td>}
            </tr>
          ); })}</tbody>
        </table>
      )}
    </div>
  );
}

/**
 * What a row says about where it came from, and what the origin filter offers. The three buckets
 * carry different authority (`src/agent/findings.ts`): only the engine gate decides pass/fail,
 * `kicad-cli sch erc` is the oracle's own second opinion, the model's rows are suggestions. A
 * `KICAD_*` row used to read "suggested" because the label only knew `origin`, which is `advisory`
 * for both of the last two.
 */
const BUCKET_LABEL: Record<FindingBucket, MessageKey> = {
  engine: "side.confidence.engine",
  kicad: "side.confidence.kicad",
  model: "side.confidence.advisory",
};

/**
 * What ticking the row costs, said before the click rather than after it: an `ercfix` op-list is
 * mechanical, everything else the fix path can act on is a Fixer round (a model call), and a row
 * with no repair stays listed whatever happens. From `fixCost`, the same predicate that decides
 * which rows start ticked — the panel never guesses at a repair the harness does not have.
 */
const FIX_COST_LABEL: Record<FixCost, MessageKey> = {
  mechanical: "side.fixKind.mechanical",
  model: "side.fixKind.model",
  none: "side.fixKind.none",
};

function Findings({ tab, bridge, onFocus }: { tab: ProjectTab; bridge: BridgeStore; onFocus: (refs: Ref[]) => void }) {
  const t = useT();
  const lang = useLang();
  const toasts = useToasts();
  const rows = bridge((s) => s.findings);
  const checked = bridge((s) => s.checked);
  const mode = bridge((s) => s.state.mode);
  const running = bridge((s) => s.state.running);
  const requestFix = bridge((s) => s.requestFix);
  const waiveFinding = bridge((s) => s.waiveFinding);
  // The filter lives in the bridge, not here: the canvas draws its markers and walks `N` / `Shift+N`
  // over exactly the rows this panel is showing (`src/ui/finding-filter.ts`). `sheet` is a row's
  // `sheet` string (the instance names path the engine put on it, `/`, `/Power/`); the options are
  // the ones the rows actually carry, so a project that never reported a sheet shows no selector.
  const filter = bridge((s) => s.findingFilter);
  const setFilter = bridge((s) => s.setFindingFilter);
  const { origin, sheet } = filter;
  const [picks, setPicks] = useState<Set<string>>(() => new Set());
  // Rows whose explanation is open. Collapsed, a row is the title, the code and where it is; opened,
  // it adds what the check measured, the usual fix, and the engine's own English message.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const key = (f: FindingRow) => `${f.code}|${f.location ?? f.message}`;
  // A finding picked on the canvas (marker click, `N` / `Shift+N`) is selected in the bridge: bring its
  // row into view and mark it, so the click that switched to this tab lands on something visible.
  const selection = bridge((s) => s.selection);
  const picked = useMemo(() => {
    const r = selection.find((x): x is Extract<Ref, { kind: "finding" }> => x.kind === "finding");
    return r ? rows.find((f) => findingMatches(r, f)) ?? null : null;
  }, [selection, rows]);
  const pickedKey = picked ? key(picked) : null;
  useEffect(() => {
    if (pickedKey) document.getElementById(`finding-${pickedKey}`)?.scrollIntoView?.({ block: "nearest" });
  }, [pickedKey]);
  const open = rows.filter((f) => !f.resolved);
  // An ERC report reads worst-first and stays in one order while the bridge appends: severity, then sheet, then arrival.
  const rank = (f: FindingRow) => (f.resolved ? 3 : f.severity === "Error" ? 0 : f.severity === "Warning" ? 1 : 2);
  const shown = new Set(filterFindings(rows, filter));
  const list = rows
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => shown.has(f))
    .sort((a, b) => rank(a.f) - rank(b.f) || (a.f.sheet ?? "").localeCompare(b.f.sheet ?? "") || a.i - b.i);
  // The sheets the rows name, labelled by their names path (`instanceByNames`) so the option reads
  // like the sheet tree; a row the engine could not place on a sheet is only listed under "all".
  const sheetOptions = useMemo(() => {
    const seen = [...new Set(rows.map((f) => f.sheet ?? "").filter(Boolean))].sort();
    // The count is what choosing that sheet would list (the severity and origin toggles still apply),
    // so the option never promises rows the filter is hiding.
    const counts = countsBySheet(rows, filter);
    return seen.map((s) => ({ value: s, label: t("side.sheetFindings", { label: sheetLabel(instanceByNames(tab.info.sheets, s), s), n: counts.get(s) ?? 0 }) }));
  }, [rows, tab.info.sheets, filter, t]);
  // Three sources, counted apart: the engine gate decides pass/fail, kicad-cli is the oracle's own
  // second opinion, the model's rows are suggestions. One header count over all three used to read
  // "0 errors" above red KiCad rows.
  const counts = bucketCounts(open);
  // Closed rows are counted apart by *why* they closed: a repair changed the schematic, a waiver is a
  // decision to live with the finding. One "resolved" number over both read as if the waived ones had
  // been fixed — eeschema keeps its exclusions separate for the same reason.
  const closed = rows.filter((f) => f.resolved);
  const waivedCount = closed.filter((f) => isWaived(f)).length;
  const repaired = closed.length - waivedCount;
  // Default selection: the harness predicate the review card uses, so both agree on the same rows.
  // Keyed on what the rows are, not how many there are: a `/review` that replaced seven rows with
  // seven different ones kept the old ticks, so the Fix button carried a selection of rows that were
  // no longer listed.
  useEffect(() => { setPicks(new Set(defaultFixSelection(open).map(key))); }, [rows.map((f) => `${key(f)}|${f.severity}|${f.resolved ? 1 : 0}`).join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => setPicks((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleOpen = (k: string) => setOpened((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const consent = async (card_kind: string, sha: string) => (isTauri() ? (await call("consent_record", { event: { project_key: tab.key, card_kind, payload_sha256: sha, input_kind: "click" } })).id : "dev");
  const fixSelected = async () => {
    const sel = open.filter((f) => picks.has(key(f)));
    if (!sel.length) return;
    setBusy(true);
    try { await requestFix(sel, mode === "build" ? undefined : await consent("enter_build", tab.info.root_uuid)); } finally { setBusy(false); }
  };
  // The report a reviewer hands on: the rows currently listed, written by Rust through the OS save
  // dialog (S tier, the only write outside the project). The extension picks the format — `.md` for
  // the Markdown report, anything else for JSON — the same rule the BOM and cost exports follow.
  const exportFindings = async () => {
    const out = await saveDialog({ defaultPath: "findings.md" });
    if (!out) return;
    setBusy(true);
    try {
      // The report keeps the code and adds the English title, so a reader outside the app knows what
      // the code names without looking it up. The interface language never reaches an exported file.
      // Title, detail and remedy come from the same table the row reads, always in English: a report
      // read outside the app needs what the check measured and the usual fix, not only the code.
      const rows = list.map(({ f }) => { const en = findingCopy(f.code, "en"); return en ? { ...f, title: en.title, detail: en.detail, remedy: en.remedy } : f; });
      await call("export_file", { project_key: tab.key, kind: "findings", payload: { project: tab.info.name, filters: { severity: filter.severities, origin, sheet }, findings: rows }, out_path: out });
      toasts.push({ tone: "success", text: out });
    } catch (e) { toasts.pushError(e); } finally { setBusy(false); }
  };
  // Waiving here is the same decision as on the review card, so it asks for the same things: the
  // button opens `WaiverForm`, and only the form's own button records the waiver (D-17).
  const [waiving, setWaiving] = useState<FindingRow | null>(null);
  const waive = async (f: FindingRow, reason: string, expires: string) => {
    setBusy(true);
    // The waiver names what it hides: the finding's refs, else its location (Rust refuses a blanket waiver).
    const refs = waiverRefs(f);
    // Same shape as the review card's answer, with one row in it: the consent event is recorded over
    // the finding, the reason and the expiry, and the grant repeats them so Rust can check the two.
    const batch = waiveBatch([f], reason, expires);
    try {
      await waiveFinding({ code: f.code, refs, severity: f.severity, location: f.location }, batch.reason, await consent("waiver", waiveConsentSha(batch)), expires, batch);
      setWaiving(null);
    } catch (e) {
      // A refused waiver (WAIVER_SEVERITY / WAIVER_SCOPE) keeps the form open so it can be corrected.
      toasts.pushError(e);
    } finally { setBusy(false); }
  };
  return (
    <div className="col">
      {/* Severity is three independent toggles, as in eeschema's ERC dialog (Error and Warning on,
          exclusions off): a reviewer reads errors and warnings together, never one at a time. */}
      <div className="tabs tabs-segmented" role="group" aria-label={t("side.severityFilter")}>
        {SEVERITY_KEYS.map((k: SeverityKey) => (
          <button key={k} type="button" aria-pressed={filter.severities[k]} className={`tab ${filter.severities[k] ? "active" : ""}`}
            onClick={() => setFilter({ severities: { ...filter.severities, [k]: !filter.severities[k] } })}>
            <span>{t(`side.severity.${k}` as "side.severity.error")}</span>
          </button>
        ))}
      </div>
      <Tabs variant="segmented" value={origin} onChange={(id) => setFilter({ origin: id })} ariaLabel={t("side.originFilter")} items={[{ id: "all", label: t("side.origin.all") }, ...(["engine", "kicad", "model"] as FindingBucket[]).map((b) => ({ id: b, label: t(BUCKET_LABEL[b]) }))]} />
      <div className="row findings-nav">
        {sheetOptions.length > 1 && <Select className="grow" aria-label={t("side.sheetFilter")} value={sheet} onChange={(e) => setFilter({ sheet: e.target.value })} options={[{ value: "all", label: t("side.allSheets") }, ...sheetOptions]} />}
        <span className="grow" />
        {/* The same walk as the canvas keys: the panel dispatches the command `N` / `Shift+N` run. */}
        <IconButton icon="chevronUp" label={t("side.prevFinding")} disabled={list.length === 0} onClick={() => document.dispatchEvent(new CustomEvent("fs:walk-finding", { detail: { dir: -1 } }))} />
        <IconButton icon="chevronDown" label={t("side.nextFinding")} disabled={list.length === 0} onClick={() => document.dispatchEvent(new CustomEvent("fs:walk-finding", { detail: { dir: 1 } }))} />
      </div>
      <div className="row muted copy-sm findings-head"><span className="grow">{[
        t("side.findingsEngine", { errors: counts.engine.errors, warnings: counts.engine.warnings }),
        counts.kicad.total > 0 ? t("side.findingsKicad", { errors: counts.kicad.errors, warnings: counts.kicad.warnings }) : "",
        counts.model.total > 0 ? t("side.findingsModel", { n: counts.model.total }) : "",
        repaired > 0 ? t("side.findingsRepaired", { n: repaired }) : "",
        waivedCount > 0 ? t("side.findingsWaived", { n: waivedCount }) : "",
      ].filter(Boolean).join(" \u00b7 ")}</span>
        <IconButton icon="download" label={t("side.exportFindings")} disabled={busy || rows.length === 0} onClick={() => void exportFindings()} />
        <Button size="sm" variant="primary" icon="done" loading={busy} disabled={busy || running || picks.size === 0} onClick={() => void fixSelected()}>{t("side.fixSelected", { n: picks.size })}</Button>
      </div>
      {rows.length === 0 && !checked ? (
        <EmptyState icon="search" title={t("empty.findings")} primary={<Button size="sm" variant="secondary" onClick={() => document.dispatchEvent(new CustomEvent("fs:composer-prefill", { detail: "/review" }))}>{t("side.runChecks")}</Button>} />
      ) : rows.length === 0 || open.length === 0 ? <EmptyState icon="done" title={t("empty.reviewClean")} /> : null}
      {/* What the Fix button will actually do with the ticks as they stand: how many rows are a
          deterministic op-list, how many cost a Fixer round, how many it will leave listed. */}
      {picks.size > 0 && <div className="muted copy-sm">{t("side.fixPlan", fixCostCounts(open.filter((f) => picks.has(key(f)))))}</div>}
      {list.map(({ f, i }) => {
        // The app's own copy for the code (red line 6: it names what the check looked at and the
        // usual fix, it does not judge the circuit). A code with no entry keeps the old row: the
        // engine's message is the primary line.
        const copy = findingCopy(f.code, lang);
        const isOpen = opened.has(key(f));
        return (
        <div key={`${key(f)}|${i}`} id={`finding-${key(f)}`} className={`finding ${f.resolved ? "resolved" : ""}${pickedKey === key(f) ? " selected" : ""}`}>
          <div className="row">
            {!f.resolved && <input type="checkbox" aria-label={f.code} checked={picks.has(key(f))} onChange={() => toggle(key(f))} />}
            <button type="button" className="finding-main grow" onClick={() => onFocus(findingFocusRefs(f))}>
              <span className="finding-title grow truncate">{copy?.title ?? f.message}</span>
              <Badge tone={f.resolved ? "neutral" : f.severity.toLowerCase() === "error" ? "error" : f.severity.toLowerCase() === "warning" ? "warning" : "neutral"} mono>{f.code}</Badge>
              {!f.resolved && <Badge tone="neutral">{t(FIX_COST_LABEL[fixCost(f)])}</Badge>}
              <span className="muted copy-sm">{t(BUCKET_LABEL[findingBucket(f)])}{f.resolved ? ` · ${t("side.resolved")}` : ""}</span>
            </button>
            <IconButton icon={isOpen ? "chevronUp" : "chevronDown"} size="sm" variant="ghost" label={t("side.findingDetail")} aria-expanded={isOpen} onClick={() => toggleOpen(key(f))} />
            {!f.resolved && isWaivable(f) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWaiving(waiving && key(waiving) === key(f) ? null : f)}>{t("empty.reviewCleanAction")}</Button>}
          </div>
          {isOpen && copy && <div className="muted copy-sm">{copy.detail}</div>}
          {isOpen && copy && <div className="muted copy-sm">{t("side.findingRemedy", { text: copy.remedy })}</div>}
          {/* The engine's own English sentence, untrusted input (red line 21): a text node, never markup. */}
          {isOpen && <div className="copy-sm selectable">{f.message}</div>}
          {/* What the check measured (`gates.rs` evidence): engine key/value data, as text nodes. */}
          {isOpen && f.evidence && Object.keys(f.evidence).length > 0 && (
            <dl className="finding-evidence muted copy-sm fs-mono selectable" aria-label={t("side.findingEvidence")}>
              {Object.entries(f.evidence).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}
          {(f.sheet || f.location || f.refs?.length) && (
            <div className="muted copy-sm fs-mono selectable finding-where">{[f.sheet, f.location ?? f.refs?.join(", ")].filter(Boolean).join(" · ")}</div>
          )}
          {waiving && key(waiving) === key(f) && (
            <WaiverForm count={1} hasError={f.severity === "Error"} name={key(f)} busy={busy}
              onCancel={() => setWaiving(null)} onSubmit={(reason, expires) => void waive(f, reason, expires)} />
          )}
          {/* Why the finding is hidden, next to until when — eeschema shows the exclusion's comment the
              same way. The reason was typed by a human and recorded in fluxsmith.toml: a text node. */}
          {(f.waived_until || f.waived_reason) && (
            <div className="muted copy-sm">
              {f.waived_until ? t("card.waiver.waivedUntil", { date: fmtDay(f.waived_until) }) : ""}
              {f.waived_reason ? <span className="selectable">{(f.waived_until ? " · " : "") + t("side.waivedReason", { reason: f.waived_reason })}</span> : null}
            </div>
          )}
          {isOpen && f.remediation && !f.resolved && <div className="muted copy-sm">{t("error.remediation", { text: f.remediation })}</div>}
        </div>
        );
      })}
    </div>
  );
}

function Turns({ tab, bridge }: { tab: ProjectTab; bridge: BridgeStore }) {
  const t = useT();
  const turns = bridge((s) => s.turns).filter((x) => x.turn > 0);
  const rollback = bridge((s) => s.rollbackBefore);
  const cards = bridge((s) => s.cards);
  const [confirm, setConfirm] = useState<TurnBlock | null>(null);
  const doRollback = async (turn: number, opts?: { state_sha256?: string }) => {
    const ev = await call("consent_record", { event: { project_key: tab.key, card_kind: "rollback", payload_sha256: String(turn), input_kind: "click" } });
    const code = await rollback(turn, ev.id, opts);
    if (!code) setConfirm(null);
    return code;
  };
  return (
    <div className="col">
      {turns.length === 0 ? <EmptyState icon="turn" title={t("empty.turns")} /> : (
        <ol className="timeline">
          {turns.map((b) => {
            const status = b.rolled_back ? "rolled_back" : b.summary?.outcome ?? "running";
            return (
              <li key={b.turn} className={`timeline-item ${b.rolled_back ? "rolled" : ""}`} title={`${t("chat.turn", { n: b.turn })} · ${b.headline || b.messages[0]?.text || ""}${b.summary ? ` · ${fmtDuration(b.summary.duration_ms)} · ${fmtUsd(b.summary.cost_usd)}` : ""}`}>
                <a href={`#turn-${b.turn}`} className="timeline-main">
                  <span className="fs-mono nowrap">{t("chat.turn", { n: b.turn })}</span>
                  <span className="truncate grow">{b.headline || b.messages[0]?.text || ""}</span>
                  <Badge tone={status === "failed" ? "error" : status === "done" ? "success" : "neutral"}>{t(`side.turnStatus.${status}` as "side.turnStatus.done")}</Badge>
                  {b.summary && <span className="muted copy-sm nowrap">{fmtDuration(b.summary.duration_ms)}</span>}
                </a>
                {!b.rolled_back && <IconButton className="timeline-action" icon="rollback" size="sm" variant="ghost" label={t("chat.revertBefore", { n: b.turn })} onClick={() => setConfirm(b)} />}
              </li>
            );
          })}
        </ol>
      )}
      {/* `cards` is what carries the external-change notices: without it the dialog cannot warn that a
          KiCad edit would be overwritten. */}
      <RollbackDialog turn={confirm?.turn ?? null} turns={turns} cards={cards} projectKey={tab.key} locked={tab.info.locked} onClose={() => setConfirm(null)} onConfirm={doRollback} />
    </div>
  );
}

/**
 * The attachments the project points at (`attachments/<sha>.json`), and the three things a human can
 * do with one: put it in the next message, bind it to the selected component (what makes
 * `DATASHEET_MISMATCH` possible at all), and drop the pointer. Nothing here reads file bytes.
 */
function Attachments({ tab, bridge }: { tab: ProjectTab; bridge: BridgeStore }) {
  const t = useT();
  const toasts = useToasts();
  const [list, setList] = useState<AttachInfo[]>([]);
  const [confirm, setConfirm] = useState<AttachInfo | null>(null);
  const [rev, setRev] = useState(0);
  const selection = bridge((s) => s.selection);
  const selected = selection.find((r): r is Extract<Ref, { kind: "component" }> => r.kind === "component");
  useEffect(() => {
    if (!isTauri()) return;
    call("db_query", { query: { kind: "attachment_list", project_key: tab.key } }).then((r) => setList((r as AttachInfo[]) ?? [])).catch(() => setList([]));
  }, [tab.key, tab.info.last_turn, rev]);
  // The composer owns the chips: it listens for this event from the canvas as well.
  const insert = (a: AttachInfo) => document.dispatchEvent(new CustomEvent("fs:canvas-selection", { detail: [{ kind: "attachment", sha256: a.sha256, label: a.label }] }));
  const run = async (query: DbQuery) => {
    try { await call("db_query", { query }); setRev((r) => r + 1); }
    catch (e) { toasts.pushError(e); }
  };
  const bind = (a: AttachInfo) => { if (selected) void run({ kind: "attachment_bind", project_key: tab.key, sha256: a.sha256, bound_to: selected.ref }); };
  const remove = async () => { if (confirm) { await run({ kind: "attachment_remove", project_key: tab.key, sha256: confirm.sha256 }); setConfirm(null); } };
  if (!list.length) return <EmptyState icon="attachment" title={t("empty.attachments")} />;
  return (
    <>
      <ul className="attach-list">
        {list.map((a) => (
          <li key={a.sha256} className="attach-item">
            <Icon name={a.kind === "image" ? "image" : a.kind === "pdf" ? "doc" : a.kind === "lib" ? "component" : "attachment"} />
            <div className="col grow">
              <span className="truncate label-sm">{a.label}</span>
              <span className="muted copy-sm">{t(`side.attachKind.${a.kind}` as "side.attachKind.unknown")}{a.bound_to ? ` \u00b7 ${t("side.attachmentBoundTo", { ref: a.bound_to })}` : ""}</span>
            </div>
            <span className="fs-mono muted">{a.sha256.slice(0, 8)}</span>
            <IconButton icon="add" size="sm" variant="ghost" label={t("side.attachmentInsert")} title={t("side.attachmentInsert")} onClick={() => insert(a)} />
            <IconButton icon="link" size="sm" variant="ghost" disabled={!selected} label={t("side.bindAttachment")}
              title={selected ? t("side.bindAttachmentTo", { ref: selected.ref }) : t("side.bindAttachmentNeedsSelection")} onClick={() => bind(a)} />
            <IconButton icon="trash" size="sm" variant="ghost" label={t("side.removeAttachment")} title={t("side.removeAttachment")} onClick={() => setConfirm(a)} />
          </li>
        ))}
      </ul>
      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title={t("side.removeAttachment")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setConfirm(null)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" onClick={() => void remove()}>{t("side.removeAttachment")}</Button></>}>
        <p>{t("side.removeAttachmentBody", { label: confirm?.label ?? "" })}</p>
      </Dialog>
    </>
  );
}

function IndexStatus() {
  const t = useT();
  const idx = useEnvIndex();
  if (!idx) return null;
  const label = idx.state === "building" ? t("side.symbolIndexBuilding", { done: idx.done, total: idx.total }) : idx.state === "ready" ? t("side.symbolIndexReady", { n: idx.total }) : idx.state === "empty" ? t("side.symbolIndexEmpty") : t("side.symbolIndexError");
  return (
    <div className="index-status">
      <div className="row copy-sm muted"><Icon name="component" className="icon-sm" /><span className="grow truncate">{label}</span></div>
      {idx.state === "building" && <ProgressBar pct={idx.total ? (idx.done / idx.total) * 100 : 0} />}
    </div>
  );
}


// ------------------------------------------------------------------ plan
const PLAN_STEP_ICON: Record<PlanView["steps"][number]["status"], "done" | "waiting" | "close" | "circle"> = { done: "done", current: "waiting", skipped: "close", pending: "circle" };

function PlanPanel({ tab, bridge }: { tab: ProjectTab; bridge: BridgeStore }) {
  const t = useT();
  const plan = bridge((s) => s.plan);
  const send = bridge((s) => s.send);
  const sessionId = bridge((s) => s.state.session_id);
  const redo = (id: string) => void send({ text: `/redo ${id}`, refs: [], attachments: [], session_id: sessionId ?? tab.sessionId ?? "" });
  const cards = bridge((s) => s.cards);
  const answerCard = bridge((s) => s.answerCard);
  const editPlan = bridge((s) => s.editPlan);
  const running = bridge((s) => s.state.running);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAuto, setConfirmAuto] = useState<Card["actions"][number] | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ goal: string; constraints: string; steps: Record<string, string> }>({ goal: "", constraints: "", steps: {} });
  const save = async () => {
    setSaving(true);
    try {
      await editPlan({ goal: draft.goal, constraints: draft.constraints.split("\n").map((x) => x.trim()).filter(Boolean), steps: Object.entries(draft.steps).map(([id, summary]) => ({ id, summary })) });
      setEditing(false);
    } finally { setSaving(false); }
  };
  // The latest unanswered plan card is the one whose actions the panel mirrors.
  const planCard: Card | null = useMemo(() => {
    const open = Object.values(cards).filter((c) => c.kind === "plan_approval" && !c.answered && !c.auto);
    return open.length ? open.reduce((a, b) => (a.turn >= b.turn ? a : b)) : null;
  }, [cards]);
  if (!plan) return <EmptyState icon="plan" title={t("empty.plan")} hint={t("side.planEmpty")} primary={<Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("fs:composer-prefill", { detail: "/plan " }))}>{t("empty.planAction")}</Button>} />;
  const tone = plan.status === "done" ? "success" : plan.status === "abandoned" ? "error" : plan.status === "draft" ? "neutral" : "info";
  const run = async (action: Card["actions"][number], confirmed = false) => {
    if (!planCard) return;
    // Adopting with Auto is two decisions: the policy switch gets its own confirmation (same as the chat card).
    if (action.id === "adopt_auto" && !confirmed) { setConfirmAuto(action); return; }
    setBusy(action.id);
    try {
      let cid: string | undefined;
      if (action.consent && isTauri()) {
        const ev = await call("consent_record", { event: { project_key: tab.key, card_kind: planCard.kind, payload_sha256: action.consent.payload_sha256, input_kind: "click" } });
        cid = ev.id;
      }
      await answerCard(planCard.id, action.id, undefined, cid);
    } finally { setBusy(null); }
  };
  return (
    <div className="col plan-panel">
      <div className="row plan-head">
        <Badge tone={tone}>{t(`plan.status.${plan.status}` as "plan.status.draft")}</Badge>
        <span className="muted fs-mono copy-sm">v{plan.version}</span>
      </div>
      {editing ? (
        <div className="col plan-editor">
          <TextArea label={t("plan.goalLabel")} value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} rows={3} />
          <TextArea label={t("plan.constraints")} value={draft.constraints} onChange={(e) => setDraft({ ...draft, constraints: e.target.value })} rows={4} />
          {plan.steps.map((s) => (
            <Input key={s.id} aria-label={s.id} value={draft.steps[s.id] ?? s.summary} onChange={(e) => setDraft({ ...draft, steps: { ...draft.steps, [s.id]: e.target.value } })} />
          ))}
          <div className="row">
            <Button size="sm" variant="primary" loading={saving} disabled={saving || running} onClick={() => void save()}>{t("plan.save")}</Button>
            <Button size="sm" onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="plan-goal">{plan.goal}</p>
          {plan.constraints.length > 0 && (
            <section>
              <h4 className="muted copy-sm">{t("plan.constraints")}</h4>
              <ul className="plan-list">{plan.constraints.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </section>
          )}
          {!running && plan.status !== "abandoned" && <Button size="sm" variant="ghost" onClick={() => { setDraft({ goal: plan.goal, constraints: plan.constraints.join("\n"), steps: {} }); setEditing(true); }}>{t("plan.edit")}</Button>}
        </>
      )}
      {/* What the Architect assumed and what it left open outlive the plan card: the card scrolls away
          with its turn, these stay on the plan for as long as the plan does. */}
      {plan.assumptions.length > 0 && (
        <section>
          <h4 className="muted copy-sm">{t("plan.assumptions")}</h4>
          <ul className="plan-list">{plan.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </section>
      )}
      {plan.open_questions.length > 0 && (
        <section>
          <h4 className="muted copy-sm">{t("plan.openQuestions")}</h4>
          <ul className="plan-list">{plan.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
          {plan.status === "draft" && planCard && <p className="muted copy-sm">{t("plan.openQuestions.answerOnCard")}</p>}
        </section>
      )}
      {plan.rails.length > 0 && (
        <section>
          <h4 className="muted copy-sm">{t("plan.rails")}</h4>
          <div className="row wrap">{plan.rails.map((r) => <span key={r} className="ref-chip ref-chip-net">{r}</span>)}</div>
        </section>
      )}
      <section>
        <h4 className="muted copy-sm">{t("plan.steps", { n: plan.steps.length })}</h4>
        <ol className="plan-steps">
          {plan.steps.map((s, i) => (
            <li key={s.id} className={`plan-step plan-step-${s.status}`} title={t(`plan.step.${s.status}` as "plan.step.pending")}>
              <Icon name={PLAN_STEP_ICON[s.status]} className="icon-sm" />
              <span className="plan-step-n fs-mono muted">{i + 1}</span>
              <span className="grow">
                <span className="truncate">{s.summary}</span>
                {s.parts.length > 0 && <span className="muted copy-sm plan-parts">{s.parts.join(", ")}</span>}
                {s.note && <span className="muted copy-sm plan-note">{s.note}</span>}
              </span>
              {s.status === "skipped" && !running && <Button size="sm" variant="ghost" icon="play" onClick={() => redo(s.id)}>{t("plan.redo")}</Button>}
            </li>
          ))}
        </ol>
      </section>
      {(plan.budget.cost_usd !== null || plan.budget.tokens !== null) && (
        <p className="muted copy-sm">{t("plan.budget")}: {plan.budget.cost_usd !== null ? fmtUsd(plan.budget.cost_usd) : ""}{plan.budget.tokens !== null ? ` · ${plan.budget.tokens} tokens` : ""}</p>
      )}
      <AutoPolicyDialog open={!!confirmAuto} onClose={() => setConfirmAuto(null)}
        onConfirm={() => { const a = confirmAuto; setConfirmAuto(null); if (a) void run(a, true); }} />
      {plan.status === "draft" && planCard && (
        <div className="col plan-actions">
          {planCard.actions.map((a) => (
            <Button key={a.id} variant={a.style} consent={!!a.consent} loading={busy === a.id} disabled={!!busy || running} onClick={() => void run(a)}>
              {t(a.label_key as "card.run_plan_review")}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
