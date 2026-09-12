// SPDX-License-Identifier: Apache-2.0
// Centre column: read-only canvas + toolbar (follow, grid, zoom, sheet selector, search) + a
// status bar that reads out what is under the pointer. Everything in the status bar is a React
// text node; net membership comes from the engine `net_map`; the canvas stays read-only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT, useLang, errorCopy, findingCopy } from "../../i18n";
import type { FindingRow, Ref } from "../../agent/api";
import { findingMatches, findingRef } from "../../agent/finding-ref";
import { call, isTauri } from "../../ipc/client";
import { useProjects, type ProjectTab } from "../../state/projects";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { Button, Callout, ContextMenu, Icon, IconButton, Input, Select, Tooltip, hasOpenDialog, type MenuItem } from "../components";
import { chipRef } from "../chat/Markdown";
import { netInstance } from "../sidebar/list-scope";
import { blockOfHit } from "../../canvas/blockof";
import type { Hit } from "../../canvas/hittest";
import type { HoverInfo } from "../../canvas/CanvasView";
import type { Highlight as CanvasHighlight } from "../../canvas/highlight";
import type { Marker } from "../../canvas/markers";
import { markerAnchor, onSheet, sheetIdMatches } from "../../canvas/markers";
import { nextCursor, searchMatches } from "../../canvas/commands";
import { childInstance, instanceByPath, parentInstance, sheetLabel } from "../sheet-paths";
import { inInput } from "../shortcuts/useShortcuts";
import { canvasCombo, effectiveShortcuts, normalizeCombo, type ShortcutAction } from "../shortcuts/keymap";
import { netOfHit, selectionNet } from "../../canvas/netpaths";
import type { Box, RenderSheet } from "../../canvas/types";
import type { BridgeStore } from "../harness-bridge";
import { filterFindings } from "../finding-filter";
import { CanvasSlot, type CanvasViewProps } from "./canvas-slot";
import { describeHit, readoutParams } from "./status-readout";
import { describeBox, describeLength, fmtMil, fmtMm } from "./measure";
import { objectsByUuid } from "../../canvas/presence";
import { useNetMap } from "./use-net-map";

function resolveTheme(setting: "system" | "light" | "dark"): "light" | "dark" {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
  }
  if (setting === "dark" || setting === "light") return setting;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Text to copy for a selection: component refs, net names and sheet paths, comma separated. */
export function selectionText(refs: readonly Ref[]): string {
  const parts: string[] = [];
  for (const r of refs) {
    if (r.kind === "component") parts.push(r.ref);
    else if (r.kind === "net") parts.push(r.name);
    else if (r.kind === "sheet") parts.push(r.path);
    else if (r.kind === "finding") parts.push(r.code);
  }
  return parts.join(", ");
}

/** Unresolved findings anchored on this sheet, in reading order (top-left first), for `N` / `Shift+N`. */
export function orderedFindings(sheet: RenderSheet | null, findings: readonly FindingRow[], sheetIds: readonly string[]): { f: FindingRow; at: [number, number] }[] {
  if (!sheet) return [];
  const out: { f: FindingRow; at: [number, number] }[] = [];
  for (const f of findings) {
    if (f.resolved || !onSheet(f, sheetIds)) continue;
    const at = markerAnchor(sheet, f);
    if (at) out.push({ f, at });
  }
  out.sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  return out;
}

/**
 * Marker anchor of the first `finding` ref that names a finding of this sheet, as a degenerate box the
 * view can frame. Findings that name no component (a wire, a label, a whole sheet) resolve to nothing in
 * `refBoxes`, so without this a sidebar click on them would leave the canvas where it was.
 */
export function findingFocusBox(sheet: RenderSheet | null, findings: readonly FindingRow[], refs: readonly Ref[], sheetIds: readonly string[]): Box | null {
  if (!sheet) return null;
  for (const r of refs) {
    if (r.kind !== "finding") continue;
    for (const f of findings) {
      if (!findingMatches(r, f) || !onSheet(f, sheetIds)) continue;
      const at = markerAnchor(sheet, f);
      if (at) return [[at[0] - 1, at[1] - 1], [at[0] + 1, at[1] + 1]];
    }
  }
  return null;
}

export function CanvasPanel({ tab, bridge, revision, externalFocus }: { tab: ProjectTab; bridge: BridgeStore; revision: number; externalFocus: { seq: number; refs: Ref[] } }) {
  const t = useT();
  const lang = useLang();
  const { settings, update } = useSettings();
  const { setSheet } = useProjects();
  const toasts = useToasts();
  const focus = bridge((s) => s.focus);
  const attention = bridge((s) => s.attention);
  const lastApplied = bridge((s) => s.lastApplied);
  const turnChanges = bridge((s) => s.turnChanges);
  // Default on: a turn's changes are the thing the human came to look at. Absent in settings restored
  // from an older session, which is also "on".
  const showChanges = settings.agent.canvas_changes !== false;
  const ghost = bridge((s) => s.ghost);
  // The markers, the finding walk and the sheet count read what the findings panel is showing:
  // an Info row the human filtered out is not a glyph on the sheet and not a stop for `N`.
  const allFindings = bridge((s) => s.findings);
  const findingFilter = bridge((s) => s.findingFilter);
  const findings = useMemo(() => filterFindings(allFindings, findingFilter), [allFindings, findingFilter]);
  const setSelection = bridge((s) => s.setSelection);
  const [selection, setSel] = useState<Ref[]>([]);
  const [cmd, setCmd] = useState<CanvasViewProps["command"]>(null);
  const [search, setSearch] = useState<string | null>(null);
  /** Which of the current query's matches is framed (Enter / Shift+Enter cycle it). */
  const [searchCursor, setSearchCursor] = useState(-1);
  const [sheetData, setSheetData] = useState<RenderSheet | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  /** Net pinned by the context menu ("highlight net"); Esc clears it. */
  const [stickyNet, setStickyNet] = useState<string | null>(null);
  const [followPausedUntil, setFollowPausedUntil] = useState<number | null>(null);
  /** Geometry fetch state for the status overlays (ui-states §E): loading until the engine answers, error keeps the last frame. */
  const [load, setLoad] = useState<{ state: "loading" | "ready" | "error"; message?: string }>({ state: "loading" });
  const [retries, setRetries] = useState(0);
  const hintShown = useRef(false);
  // Engine errors arrive as "CODE: message": the three-part copy for the code when it is a known one.
  const loadCopy = useMemo(() => (load.state === "error" && load.message ? errorCopy(load.message.split(":")[0].trim(), lang) : null), [load, lang]);
  useEffect(() => { setLoad({ state: "loading" }); }, [tab.key, tab.sheet, revision, retries]);
  const onReady = useCallback((rs: RenderSheet) => { setSheetData(rs); setLoad({ state: "ready" }); }, []);
  const onError = useCallback((message: string) => setLoad({ state: "error", message }), []);
  // The first drag / double-click on empty space / edit key explains once per session that the canvas is read-only.
  const onGestureHint = useCallback(() => {
    if (hintShown.current) return;
    hintShown.current = true;
    toasts.push({ tone: "info", text: t("canvas.readOnlyHint") });
  }, [toasts, t]);
  const isEmpty = load.state === "ready" && !!sheetData && ["symbols", "wires", "bus_entries", "labels", "sheets", "texts", "text_boxes", "graphics", "junctions", "no_connects", "images"].every((k) => ((sheetData as unknown as Record<string, unknown[] | undefined>)[k] ?? []).length === 0);
  const [findingCursor, setFindingCursor] = useState(-1);
  const seq = useRef(0);
  const send = useCallback((kind: NonNullable<CanvasViewProps["command"]>["kind"], query?: string) => setCmd({ seq: ++seq.current, kind, query }), []);
  /** Frame `refs` (plus an optional anchor box) without waiting for the selection state to commit. */
  const focusRefs = useCallback((refs: Ref[], box?: [[number, number], [number, number]]) => setCmd({ seq: ++seq.current, kind: "focus_refs", refs, box }), []);
  const netMap = useNetMap(tab.key, tab.sheet, revision);
  const sheetInfo = tab.info.sheets.find((s) => s.instance_path === tab.sheet);
  const sheetFile = sheetInfo?.file ?? null;
  // File, instance uuid path and names path; never the bare leaf name (two instances of a reused sheet share it).
  const sheetIds = useMemo(() => [sheetFile ?? "", tab.sheet, sheetInfo?.names.length ? sheetInfo.names.join("/") : ""].filter(Boolean), [sheetFile, tab.sheet, sheetInfo]);
  /** Instance path of the sheet a ref's `sheet` field names (file, instance path or names path), or null when unknown / this sheet. */
  const instanceFor = useCallback((sheet: string | undefined): string | null => {
    if (!sheet || sheetIdMatches(sheet, sheetIds)) return null;
    // An exact instance path wins over the loose match: two instances of one reused file differ
    // only there, and the loose match would answer with whichever comes first in the project.
    const hit = tab.info.sheets.find((s) => s.instance_path === sheet)
      ?? tab.info.sheets.find((s) => sheetIdMatches(sheet, [s.file, s.instance_path, s.names.length ? s.names.join("/") : ""].filter(Boolean)));
    return hit && hit.instance_path !== tab.sheet ? hit.instance_path : null;
  }, [sheetIds, tab.info.sheets, tab.sheet]);
  // The harness names sheets by plan file (`power.kicad_sch`); the tab is keyed by instance uuid path and the
  // engine's `RenderSheet.sheet_path` is the names path. Resolve both agent overlays to "this sheet or not".
  const ghostHere = useMemo(() => (ghost && sheetIdMatches(ghost.sheet, sheetIds) ? { preview_id: ghost.preview_id, sheet: tab.sheet } : null), [ghost, sheetIds, tab.sheet]);
  const attentionHere = useMemo(() => {
    if (!attention) return null;
    if (attention.sheet && !sheetIdMatches(attention.sheet, sheetIds)) return null;
    return attention.sheet ? { ...attention, sheet: undefined } : attention;
  }, [attention, sheetIds]);
  /** Latest `focusRef`, so the chip listener is installed once and still sees the current sheet. */
  const focusRefFn = useRef<(r: Ref) => void>(() => undefined);
  // A ref chip in the chat (`[[ref:component:C2]]`) or in a turn summary selects and frames what it
  // names, on whatever sheet that is; the global Mod+F opens the search box.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ kind?: string; value?: string; ref?: Ref }>).detail;
      const r = d?.ref ?? (d?.kind && d?.value ? chipRef(d.kind, d.value) : null);
      // A block names a group of objects and no single ref: the text search is all the canvas can do with it.
      if (!r || r.kind === "block") { if (d?.value) send("search", d.value); return; }
      focusRefFn.current(r);
    };
    const open = () => setSearch((cur) => cur ?? "");
    document.addEventListener("fs:focus-ref", h);
    document.addEventListener("fs:canvas-search", open);
    return () => { document.removeEventListener("fs:focus-ref", h); document.removeEventListener("fs:canvas-search", open); };
  }, [send]);
  // Hierarchy: the parent instance of the current sheet (null at the root), and the child instance a
  // sheet symbol on this sheet stands for. Both resolve by KiCad instance path (`parent + "/" + the
  // sheet symbol's uuid`), so two symbols pointing at one reused file enter two different instances.
  const parentSheet = useMemo(() => parentInstance(tab.info.sheets, tab.sheet), [tab.info.sheets, tab.sheet]);
  const childSheet = useCallback((symbolUuid: string) => childInstance(tab.info.sheets, tab.sheet, symbolUuid), [tab.info.sheets, tab.sheet]);
  // Canvas colours follow the app theme live: `data-theme` on <html> (set by `applyTheme`) and,
  // for `system`, the OS preference.
  const themeSetting = settings.theme;
  const [theme, setTheme] = useState<"light" | "dark">(() => resolveTheme(themeSetting));
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setTheme(resolveTheme(useSettings.getState().settings.theme));
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mql = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mql?.addEventListener("change", update);
    return () => { mo.disconnect(); mql?.removeEventListener("change", update); };
  }, [themeSetting]);
  const onSelect = useCallback((refs: Ref[]) => { setSel(refs); setSelection(refs); }, [setSelection]);
  // A pinned net highlight follows the engineer into other sheets (eeschema keeps it across the hierarchy);
  // only a project switch clears it. Hover and the finding cursor are per sheet.
  useEffect(() => { setStickyNet(null); }, [tab.key]);
  useEffect(() => { setHover(null); setFindingCursor(-1); }, [tab.key, tab.sheet]);
  // A sidebar click (component / net / finding row) is a one-shot: select it and frame it. The agent's own
  // `focus` keeps driving the highlight and the follow camera afterwards. Refs that name another sheet switch
  // to it first and are framed once that sheet's geometry arrives.
  const pendingFocusRef = useRef<Ref[] | null>(null);
  const lastFocusSeq = useRef(externalFocus.seq); // a freshly mounted panel (project switch) must not replay the last click
  /** Select `refs` and frame them; refs naming another sheet switch to it and are framed once it arrives. */
  const applyFocus = useCallback((refs: Ref[]) => {
    const other = refs.map((r) => ("sheet" in r && typeof r.sheet === "string" ? instanceFor(r.sheet) : null)).find((x) => x);
    if (other) { pendingFocusRef.current = refs; setSheet(tab.key, other); return; }
    onSelect(refs);
    // A finding ref resolves to no geometry of its own: frame its marker anchor, as `N` / `Shift+N` do.
    focusRefs(refs, findingFocusBox(sheetData, findings, refs, sheetIds) ?? undefined);
  }, [instanceFor, setSheet, tab.key, onSelect, focusRefs, sheetData, findings, sheetIds]);
  useEffect(() => {
    if (!externalFocus.refs.length || externalFocus.seq === lastFocusSeq.current) return;
    lastFocusSeq.current = externalFocus.seq;
    applyFocus(externalFocus.refs);
  }, [externalFocus, applyFocus]);
  /** Does this sheet already have what `r` names? What is here is never looked for anywhere else. */
  const hasHere = useCallback((r: Ref): boolean => {
    if (!sheetData) return true; // nothing drawn yet: frame here rather than send the human elsewhere
    if (r.kind === "component") return sheetData.symbols.some((s) => s.reference === r.ref);
    if (r.kind === "net") {
      // Membership is the engine's word (`net_map`), never read off label text or a power symbol's
      // value: those are drawn strings, and whether they name this net is a connectivity judgement.
      if (!netMap) return true; // no map yet: stay here rather than guess from the drawing
      const named = (m: Record<string, string> | undefined) => !!m && Object.values(m).includes(r.name);
      return named(netMap.wires) || named(netMap.labels) || named(netMap.pins) || named(netMap.sheet_pins) || named(netMap.junctions) || named(netMap.no_connects);
    }
    return true;
  }, [sheetData, netMap]);
  /**
   * Which sheet instance has what `query` names, asked of the engine — the same all-sheets read and
   * project-wide nets list the sidebar's "all sheets" scope uses. Null when it is on this sheet, when
   * the project has no such thing, or when there is no engine to ask (the answer is never guessed here).
   */
  const locateOffSheet = useCallback(async (query: string): Promise<{ instance: string; label: string; refs: Ref[] } | null> => {
    const q = query.trim();
    if (!q || !isTauri()) return null;
    const low = q.toLowerCase();
    const found = (instance: string, refs: Ref[]) => ({ instance, label: sheetLabel(instanceByPath(tab.info.sheets, instance), instance), refs });
    try {
      const res = await call("engine_request", { project_key: tab.key, request: { kind: "read", sheet: null, match: q, limit: 50, all_sheets: true }, auth: {} });
      type Row = { reference: string; value?: string; sheet?: string; instance_path?: string };
      const rows = (((res.ok ? res.data : null) as { symbols?: Row[] } | null)?.symbols ?? []).filter((s) => !s.reference.startsWith("#"));
      const sym = rows.find((s) => s.reference.toLowerCase() === low) ?? rows.find((s) => (s.value ?? "").toLowerCase().includes(low)) ?? rows.find((s) => s.reference.toLowerCase().startsWith(low));
      if (sym) {
        const inst = instanceFor(sym.instance_path ?? sym.sheet ?? "");
        return inst ? found(inst, [{ kind: "component", ref: sym.reference, sheet: inst }]) : null;
      }
      const nres = await call("engine_request", { project_key: tab.key, request: { kind: "nets", sheet: null, match: q, limit: 50 }, auth: {} });
      const nets = ((nres.ok ? nres.data : null) as { nets?: { name: string; sheets?: string[] }[] } | null)?.nets ?? [];
      const net = nets.find((n) => n.name.toLowerCase() === low) ?? nets[0];
      const inst = net ? netInstance(tab.info.sheets, sheetInfo ?? null, net.sheets) : undefined;
      return net && inst ? found(inst, [{ kind: "net", name: net.name, sheet: inst }]) : null;
    } catch { return null; } // the engine is the only source: no answer beats a guessed one
  }, [tab.key, tab.info.sheets, sheetInfo, instanceFor]);
  /** A chip click: frame it here, or on the sheet the engine says has it (a chip carries no sheet of its own). */
  const focusRef = useCallback((r: Ref) => {
    if (("sheet" in r && typeof r.sheet === "string" && r.sheet) || hasHere(r)) { applyFocus([r]); return; }
    void locateOffSheet(r.kind === "component" ? r.ref : r.kind === "net" ? r.name : "").then((hit) => {
      if (hit) { pendingFocusRef.current = hit.refs; setSheet(tab.key, hit.instance); return; }
      applyFocus([r]); // nowhere else either: select it and leave the view where it is
    });
  }, [hasHere, applyFocus, locateOffSheet, setSheet, tab.key]);
  focusRefFn.current = focusRef;
  const justFocusedRef = useRef<RenderSheet | null>(null);
  useEffect(() => {
    if (!sheetData || !pendingFocusRef.current) return;
    const refs = pendingFocusRef.current; pendingFocusRef.current = null;
    justFocusedRef.current = sheetData;
    onSelect(refs);
    focusRefs(refs, findingFocusBox(sheetData, findings, refs, sheetIds) ?? undefined);
  }, [sheetData, onSelect, focusRefs, findings, sheetIds]);
  // After a re-render (apply, rollback, external change) drop selected components that no longer exist.
  const selRef = useRef(selection);
  selRef.current = selection;
  useEffect(() => {
    if (!sheetData) return;
    if (justFocusedRef.current === sheetData) return; // the selection was just set for this sheet by a cross-sheet focus
    const have = new Set(sheetData.symbols.map((s) => s.reference));
    const next = selRef.current.filter((r) => r.kind !== "component" || have.has(r.ref));
    if (next.length !== selRef.current.length) onSelect(next);
  }, [sheetData, onSelect]);
  /**
   * A search this sheet cannot answer: which sheet does have it, offered as a jump. "No match on this
   * sheet" is true and useless when the part is one sheet away, and eeschema itself searches the project.
   */
  const [offSheet, setOffSheet] = useState<{ query: string; instance: string; label: string; refs: Ref[] } | null>(null);
  useEffect(() => {
    const q = (search ?? "").trim();
    setOffSheet(null);
    if (!q || !sheetData || searchMatches(sheetData, q).length) return;
    let alive = true;
    // Typing is not a query: only a pause in it asks the engine about the rest of the project.
    const id = window.setTimeout(() => { void locateOffSheet(q).then((hit) => { if (alive && hit) setOffSheet({ query: q, ...hit }); }); }, 250);
    return () => { alive = false; window.clearTimeout(id); };
  }, [search, sheetData, locateOffSheet]);
  const netOfWire = useCallback((uuid: string) => netMap?.wires[uuid] ?? null, [netMap]);
  const hoverNet = stickyNet ?? (hover ? netOfHit(netMap, hover.hit) : null);

  // Right-click menu: reference in chat / show net / redraw the block the symbol belongs to / copy / zoom / sidebar.
  const plan = bridge((s) => s.plan);
  const sendMsg = bridge((s) => s.send);
  const sessionId = bridge((s) => s.state.session_id);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; hit: Hit | null; refs: Ref[] } | null>(null);
  const block = menu ? blockOfHit(menu.hit, plan?.blocks ?? [], sheetFile) : null;
  const canRedo = !!block?.step_id && !!plan && plan.status !== "draft" && plan.status !== "abandoned";
  const menuNet = menu ? netOfHit(netMap, menu.hit) : null;
  const menuItems: MenuItem[] = menu ? [
    { id: "reference", label: t("canvas.menu.reference"), icon: "component", disabled: menu.refs.length === 0 },
    { id: "zoomTo", label: t("canvas.menu.zoomTo"), icon: "zoomSelection", disabled: menu.refs.length === 0 && selection.length === 0 },
    { id: "highlightNet", label: stickyNet && stickyNet === menuNet ? t("canvas.menu.unhighlightNet") : t("canvas.menu.highlightNet"), icon: "net", disabled: !menuNet },
    { id: "net", label: t("canvas.menu.showNet"), icon: "net", disabled: !menu.hit || !["pin", "wire", "label", "sheet_pin"].includes(menu.hit.kind) },
    { id: "showInSidebar", label: t("canvas.menu.showInSidebar"), icon: "findings", disabled: !menu.hit || !["symbol", "pin", "wire", "label", "sheet_pin"].includes(menu.hit.kind) },
    { id: "copyName", label: t("canvas.menu.copyName"), icon: "copy", disabled: menu.refs.length === 0 && selection.length === 0 },
    { id: "redo", label: block ? t("canvas.menu.redoBlock", { block: block.id }) : t("canvas.menu.redoBlockNone"), icon: "play", disabled: !canRedo },
  ] : [];
  const onContextMenu = useCallback((hit: Hit | null, refs: Ref[], at: { x: number; y: number }) => setMenu({ at, hit, refs }), []);
  const copyText = useCallback(async (text: string) => {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toasts.push({ tone: "success", text: t("common.copied") }); } catch { /* clipboard unavailable */ }
  }, [toasts, t]);
  const openInSidebar = useCallback((hit: Hit | null, refs: Ref[]) => {
    if (!hit) return;
    const net = netOfHit(netMap, hit);
    const detail = hit.kind === "symbol" || hit.kind === "pin"
      ? { tab: "components", refs: [{ kind: "component", ref: hit.reference, sheet: tab.sheet } as Ref] }
      : net ? { tab: "components", refs: [{ kind: "net", name: net } as Ref] } : { tab: "components", refs };
    document.dispatchEvent(new CustomEvent("fs:sidebar-open", { detail }));
  }, [netMap, tab.sheet]);
  const onMenu = (id: string) => {
    if (!menu) return;
    const refs = menu.refs.length ? menu.refs : selection;
    if (id === "reference") document.dispatchEvent(new CustomEvent("fs:canvas-selection", { detail: refs }));
    if (id === "zoomTo") { if (menu.refs.length) onSelect(menu.refs); send("focus_selection"); }
    if (id === "highlightNet") setStickyNet((s) => (s && s === menuNet ? null : menuNet));
    if (id === "net") {
      const nets: Ref[] = menu.refs.filter((r) => r.kind === "net");
      if (!nets.length && menuNet) nets.push({ kind: "net", name: menuNet });
      if (nets.length) { onSelect(nets); focusRefs(nets); }
    }
    if (id === "showInSidebar") openInSidebar(menu.hit, menu.refs);
    if (id === "copyName") void copyText(selectionText(refs));
    if (id === "redo" && block?.step_id) void sendMsg({ text: `/redo ${block.step_id}`, refs: [], attachments: [], session_id: sessionId ?? tab.sessionId ?? "" });
  };
  const onOpen = useCallback((hit: Hit, refs: Ref[]) => {
    // Double-click on a sheet symbol (or on one of its pins, which sit on its border) enters that
    // sheet instance, as in eeschema; anything else opens its detail.
    if (hit.kind === "sheet" || hit.kind === "sheet_pin") {
      const child = childSheet(hit.kind === "sheet" ? hit.uuid : hit.sheet_uuid);
      if (child) { setSheet(tab.key, child.instance_path); return; }
    }
    onSelect(refs); openInSidebar(hit, refs);
  }, [onSelect, openInSidebar, childSheet, setSheet, tab.key]);
  const onMarker = useCallback((m: Marker) => {
    document.dispatchEvent(new CustomEvent("fs:sidebar-open", { detail: { tab: "findings", refs: m.findings.map(findingRef) } }));
  }, []);

  // Keyboard on the panel: F focus, N / Shift+N walk findings, [ / ] cycle candidates, Mod+C copy,
  // Esc clears the pinned net. Mod+F (search) is global and arrives as `fs:canvas-search`.
  const ordered = useMemo(() => orderedFindings(sheetData, findings, sheetIds), [sheetData, findings, sheetIds]);
  const walkFinding = useCallback((dir: 1 | -1) => {
    if (!ordered.length) return;
    const next = nextCursor(findingCursor, dir, ordered.length);
    setFindingCursor(next);
    const { f, at } = ordered[next];
    const refs = f.refs?.length ? f.refs.map((r) => ({ kind: "component", ref: r.split(".")[0], sheet: tab.sheet } as Ref)) : [];
    // The finding ref keeps the sidebar row in sync (its location falls back to the refs so two findings with the
    // same code stay distinct); the component refs give the canvas something to frame, and the marker anchor is
    // framed even when the finding names no component.
    onSelect([...refs, findingRef(f)]);
    focusRefs(refs, [[at[0] - 1, at[1] - 1], [at[0] + 1, at[1] + 1]]);
  }, [ordered, findingCursor, onSelect, focusRefs, tab.sheet]);
  // The findings panel's next / previous buttons: the same walk as `N` / `Shift+N`, so the two can
  // never disagree about which finding is current.
  const walkRef = useRef(walkFinding);
  walkRef.current = walkFinding;
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<{ dir?: number }>).detail; walkRef.current(d?.dir === -1 ? -1 : 1); };
    document.addEventListener("fs:walk-finding", h);
    return () => document.removeEventListener("fs:walk-finding", h);
  }, []);
  const panelRef = useRef<HTMLDivElement>(null);
  // Canvas-scope shortcuts come from the keymap (user remaps in Settings apply here, not only in the help sheet).
  const shortcutOverrides = settings.shortcuts;
  // `searchCanvas` is a global shortcut owned by the app shell (it dispatches `fs:canvas-search`, which
  // the effect above listens for); answering it here as well would run the same open twice.
  const combos = useMemo(() => {
    const m = new Map<string, ShortcutAction>();
    for (const d of effectiveShortcuts(shortcutOverrides)) if (d.scope === "canvas" && d.combo) m.set(normalizeCombo(d.combo), d.action);
    return m;
  }, [shortcutOverrides]);
  // The keys this panel answers, handed to the drawing so it cedes exactly those and no more: the
  // hand-off has to follow the user's remaps, never a hard-coded default. `openDetail` (Enter) stays
  // with the drawing, which owns the click stack that key reads.
  const panelKeys = useMemo(() => new Set([...combos].filter(([, a]) => a !== "openDetail").map(([c]) => c)), [combos]);
  const keyRef = useRef({ walkFinding, copyText, selection, stickyNet, hoverNet, parentSheet, combos });
  keyRef.current = { walkFinding, copyText, selection, stickyNet, hoverNet, parentSheet, combos };
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      // Typing is typing: the chat composer, the search box and the sheet selector keep their keystrokes.
      if (inInput(e.target)) return; // the search box handles its own Escape
      if (hasOpenDialog()) return; // a modal owns the keyboard while it is open
      // Where the keystroke came from: a few keys (Escape, copy) act only inside the panel.
      const inside = !!e.target && el.contains(e.target as Node);
      // Escape is meant for whatever has focus, and is deliberately outside the hand-off below: the
      // drawing clears its selection and the panel its pinned net — two pieces of state, one key.
      if (e.key === "Escape") { if (inside) { setStickyNet(null); setFindingCursor(-1); } return; }
      // Already answered on the way up (the drawing's own keys, a dialog, the sidebar): never twice.
      if (e.defaultPrevented) return;
      const action = keyRef.current.combos.get(canvasCombo(e));
      if (!action) return;
      switch (action) {
        case "focusSelection": send("focus_selection"); break;
        case "nextFinding": keyRef.current.walkFinding(1); break;
        case "prevFinding": keyRef.current.walkFinding(-1); break;
        // The stack of candidates lives in the drawing; the key reaches it through the command
        // channel, so cycling works without having clicked the canvas first, like the other keys.
        case "cycleNext": send("cycle_next"); break;
        case "cyclePrev": send("cycle_prev"); break;
        case "copyName": {
          // Copy belongs to whatever has focus; only inside the panel does it take the selection.
          if (!inside) return;
          const text = selectionText(keyRef.current.selection);
          if (!text || (typeof window !== "undefined" && window.getSelection?.()?.toString())) return; // a text selection keeps native copy
          void keyRef.current.copyText(text);
          break;
        }
        // eeschema parity: ` pins / unpins the net under the pointer, Alt+Backspace goes up one sheet, Mod+Home fits everything.
        // Keyboard-only: with nothing under the pointer, the net of the current selection (a wire, label or net row).
        case "highlightNet": { const n = keyRef.current.hoverNet ?? selectionNet(keyRef.current.selection); if (!n) return; setStickyNet((s) => (s === n ? null : n)); break; }
        case "parentSheet": { const p = keyRef.current.parentSheet; if (!p) return; setSheet(tab.key, p.instance_path); break; }
        case "fitAll": send("fit"); break;
        default: return; // Enter (openDetail) is answered by the canvas element itself
      }
      e.preventDefault();
    };
    // On the document, not on the panel: the canvas keys used to be dead until the human had clicked
    // the drawing, which is not something a keyboard-first engineer would ever discover.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [send, setSheet, tab.key]);
  // What the turn drew and changed stays highlighted until the next turn starts (the pop-in reveal is
  // one-shot and never replays), across sheet switches: uuids resolve only on the sheet that has them,
  // and a changed part is addressed by designator because it kept its uuid.
  // Created and changed are two different things to an engineer — a part the turn drew is not a part
  // whose value it edited — so they go out as two groups with two styles, never folded into one.
  const highlight = useMemo<CanvasHighlight[]>(() => {
    const out: CanvasHighlight[] = [];
    if (focus.length) out.push({ refs: focus, kind: "focus" });
    if (showChanges && turnChanges) {
      if (turnChanges.uuids.length) out.push({ refs: [], kind: "created", uuids: turnChanges.uuids });
      if (turnChanges.refs.length) out.push({ refs: turnChanges.refs.map((r) => ({ kind: "component", ref: r }) as Ref), kind: "changed" });
    }
    return out;
  }, [focus, showChanges, turnChanges]);
  const matches = useMemo(() => (sheetData && search ? searchMatches(sheetData, search) : []), [sheetData, search]);
  const readout = useMemo(() => describeHit(hover?.hit ?? null, sheetData, netMap), [hover, sheetData, netMap]);
  // Selection measurement: a region's box, a single wire's length (only when the hovered/selected hit is a wire).
  const region = selection.find((r): r is Extract<Ref, { kind: "region" }> => r.kind === "region");
  const sizeText = region ? describeBox(region.bbox_mil, lang) : null;
  const wireLen = hover?.hit?.kind === "wire" ? describeLength(hover.hit.a, hover.hit.b, lang) : null;
  // Every unresolved finding of this sheet counts; those the canvas cannot place get their own suffix
  // so "3 findings on this sheet" never disagrees with the two markers actually drawn.
  const unresolvedHere = useMemo(() => findings.filter((f) => !f.resolved && onSheet(f, sheetIds)).length, [findings, sheetIds]);
  const unanchoredHere = sheetData ? Math.max(0, unresolvedHere - ordered.length) : 0;
  // What this turn touched, split by whether the drawn sheet actually carries it: a change on another
  // sheet is invisible here, and silence would read as "the turn changed nothing". Resolution is by
  // uuid for created objects and by designator for edited parts — no guessing, only what the sheet has.
  const changeCounts = useMemo(() => {
    if (!showChanges || !turnChanges) return null;
    const objects = sheetData ? objectsByUuid(sheetData) : null;
    const refsHere = new Set(sheetData?.symbols.map((s) => s.reference) ?? []);
    let here = 0;
    let elsewhere = 0;
    for (const u of turnChanges.uuids) { if (objects?.has(u)) here++; else elsewhere++; }
    for (const r of turnChanges.refs) { if (refsHere.has(r)) here++; else elsewhere++; }
    return here + elsewhere > 0 ? { n: here, m: elsewhere } : null;
  }, [showChanges, turnChanges, sheetData]);
  return (
    <div ref={panelRef} className="canvas-panel" tabIndex={0} aria-label={t("canvas.sheet")}>
      <div className="canvas-toolbar">
        <Select aria-label={t("canvas.sheet")} value={tab.sheet} onChange={(e) => setSheet(tab.key, e.target.value)} options={tab.info.sheets.map((s) => ({ value: s.instance_path, label: s.names.length ? s.names.join(" / ") : tab.info.name }))} className="canvas-sheet-select" />
        {parentSheet && <Tooltip text={t("canvas.parentSheet")}><IconButton icon="parentSheet" label={t("canvas.parentSheet")} onClick={() => setSheet(tab.key, parentSheet.instance_path)} /></Tooltip>}
        <span className="grow" />
        {search !== null && <Input autoFocus className="canvas-search" placeholder={t("canvas.search")} value={search} onChange={(e) => { setSearch(e.target.value); setSearchCursor(-1); send("search", e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setSearch(null); setSearchCursor(-1); return; }
            // Enter / Shift+Enter (and F3 / Shift+F3 as in eeschema) step through the matches one at a time.
            if ((e.key === "Enter" || e.key === "F3") && matches.length) { e.preventDefault(); const next = nextCursor(searchCursor, e.shiftKey ? -1 : 1, matches.length); setSearchCursor(next); onSelect([matches[next]]); focusRefs([matches[next]]); }
          }} />}
        {search !== null && search.trim() && (matches.length
          ? <span className="muted copy-sm canvas-search-count" role="status">{t("canvas.search.count", { k: searchCursor < 0 ? 1 : searchCursor + 1, n: matches.length })}</span>
          : offSheet && offSheet.query === search.trim()
            ? <Button size="sm" variant="ghost" icon="sheet" className="canvas-search-jump" onClick={() => { pendingFocusRef.current = offSheet.refs; setSheet(tab.key, offSheet.instance); }}>{t("canvas.search.goToSheet", { sheet: offSheet.label })}</Button>
            : <span className="muted copy-sm canvas-search-count" role="status">{t("canvas.search.none")}</span>)}
        <Tooltip text={t("canvas.search")}><IconButton icon="search" label={t("canvas.search")} onClick={() => setSearch(search === null ? "" : null)} /></Tooltip>
        <Tooltip text={t("canvas.zoomSelection")}><IconButton icon="zoomSelection" label={t("canvas.zoomSelection")} disabled={selection.length === 0} onClick={() => send("focus_selection")} /></Tooltip>
        <Tooltip text={t("canvas.follow")}><IconButton icon="focus" label={t("canvas.follow")} aria-pressed={settings.agent.canvas_follow} className={settings.agent.canvas_follow ? "pressed" : ""} onClick={() => void update({ agent: { ...settings.agent, canvas_follow: !settings.agent.canvas_follow } })} /></Tooltip>
        <Tooltip text={t("canvas.changes")}><IconButton icon="sparkles" label={t("canvas.changes")} aria-pressed={showChanges} className={showChanges ? "pressed" : ""} onClick={() => void update({ agent: { ...settings.agent, canvas_changes: !showChanges } })} /></Tooltip>
        <Tooltip text={t("canvas.grid")}><IconButton icon="grid" label={t("canvas.grid")} aria-pressed={settings.agent.canvas_grid} className={settings.agent.canvas_grid ? "pressed" : ""} onClick={() => void update({ agent: { ...settings.agent, canvas_grid: !settings.agent.canvas_grid } })} /></Tooltip>
        <Tooltip text={t("canvas.zoomOut")}><IconButton icon="zoomOut" label={t("canvas.zoomOut")} onClick={() => send("zoom_out")} /></Tooltip>
        <Tooltip text={t("canvas.zoomIn")}><IconButton icon="zoomIn" label={t("canvas.zoomIn")} onClick={() => send("zoom_in")} /></Tooltip>
        <Tooltip text={t("canvas.fit")}><IconButton icon="fit" label={t("canvas.fit")} onClick={() => send("fit")} /></Tooltip>
      </div>
      <div className="canvas-body">
        <CanvasSlot projectKey={tab.key} sheet={tab.sheet} selection={selection} onSelect={onSelect} onContextMenu={onContextMenu} highlight={highlight} follow={settings.agent.canvas_follow} theme={theme} grid={settings.agent.canvas_grid} revision={revision + retries} command={cmd} attention={attentionHere} reveal={lastApplied} ghost={ghostHere}
          onHover={setHover} netMap={netMap} hoverNet={hoverNet} netOfWire={netOfWire} findings={findings} sheetIds={sheetIds} onOpen={onOpen} onMarker={onMarker} onFollowPaused={setFollowPausedUntil} onReady={onReady} onError={onError} onGestureHint={onGestureHint} panelKeys={panelKeys} />
        {load.state === "loading" && <div className="canvas-overlay canvas-overlay-loading muted copy-sm" role="status">{t("canvas.loading")}</div>}
        {load.state === "error" && (
          <div className="canvas-overlay canvas-overlay-error">
            <Callout tone="error" actions={<Button size="sm" onClick={() => setRetries((n) => n + 1)}>{t("common.retry")}</Button>}>{loadCopy?.title ?? t("canvas.loadError")}{loadCopy?.next ? <div className="copy-sm">{loadCopy.next}</div> : null}<div className="fs-mono copy-sm selectable">{load.message}</div></Callout>
          </div>
        )}
        {/* Only the drawing under it is decorative (the canvas layers carry their own aria): the empty-sheet
            line and what to do about it stay readable, so a screen reader is not left with a blank sheet. */}
        {isEmpty && (
          <div className="canvas-overlay canvas-overlay-empty" role="status">
            <Icon name="sheet" size={20} className="muted" />
            <span className="muted copy-sm">{t("empty.sheetBlank")}</span>
            <span className="muted copy-sm">{t("empty.sheetBlankHint")}</span>
          </div>
        )}
      </div>
      <ContextMenu at={menu?.at ?? null} items={menuItems} onSelect={onMenu} onClose={() => setMenu(null)} />
      <div className="canvas-status muted copy-sm" role="status">
        <span className="fs-mono" title={tab.sheet}>{sheetInfo && sheetInfo.names.length ? sheetInfo.names.join(" / ") : t("canvas.rootSheet")}</span>
        {/* A marker reads as `CODE: title` in the interface language; the engine's own sentence,
            what it measured and the usual fix are on the row in the findings panel. */}
        {hover?.marker ? (
          <span className="canvas-readout">{hover.marker.findings.length > 1 ? t("canvas.status.findings", { n: hover.marker.findings.length }) : t("canvas.status.finding", { code: hover.marker.findings[0].code, message: findingCopy(hover.marker.findings[0].code, lang)?.title ?? hover.marker.findings[0].message })}</span>
        ) : readout.map((r, i) => <span key={i} className={`canvas-readout${i === 0 ? " fs-mono" : ""}`}>{t(r.key, readoutParams(r, t))}</span>)}
        {wireLen && <span className="canvas-readout">{t("canvas.status.length", wireLen)}</span>}
        {stickyNet && <span className="canvas-readout fs-mono">{t("canvas.status.pinnedNet", { name: stickyNet })}</span>}
        <span className="grow" />
        {sizeText && <span className="canvas-readout">{t("canvas.status.size", sizeText)}</span>}
        {hover && <span className="fs-mono">{t("canvas.status.cursor", { x: fmtMil(hover.world[0], lang), y: fmtMil(hover.world[1], lang), xmm: fmtMm(hover.world[0], lang), ymm: fmtMm(hover.world[1], lang) })}</span>}
        {/* The pitch of the grid on screen; it doubles as you zoom out. Only while the grid is drawn:
            the canvas is read-only, so with the grid off there is no pitch the human can see or use. */}
        {settings.agent.canvas_grid && hover?.pitch !== undefined && <span className="canvas-readout">{t("canvas.status.grid", { pitch: fmtMil(hover.pitch, lang) })}</span>}
        {changeCounts && <span>{t("canvas.status.changes", changeCounts)}</span>}
        {unresolvedHere > 0 && <span>{t("canvas.status.findingsOnSheet", { n: unresolvedHere })}{unanchoredHere > 0 ? ` ${t("canvas.status.findingsNoPosition", { n: unanchoredHere })}` : ""}</span>}
        {selection.length > 0 && <span>{t("canvas.selected", { n: selection.length })}</span>}
        {settings.agent.canvas_follow && followPausedUntil !== null && (
          <span className="canvas-follow-paused">{t("canvas.followPaused")}<Button size="sm" variant="ghost" onClick={() => send("resume_follow")}>{t("canvas.followResume")}</Button></span>
        )}
        {!hover && selection.length === 0 && <span>{t("canvas.readOnlyHint")}</span>}
      </div>
    </div>
  );
}
