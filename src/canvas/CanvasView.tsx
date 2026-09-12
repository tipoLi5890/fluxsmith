// SPDX-License-Identifier: Apache-2.0
// Read-only schematic canvas. Fetches `RenderSheet` from the engine through
// the typed IPC, draws it on two stacked <canvas> layers (a static scene that
// repaints only when the view or the data change, and an animated overlay for
// highlights / presence / rubber band), and reports selection / hover / gesture
// hints through callbacks. It never creates DOM for file content.

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Ref } from "../agent/api";
import { hitKey, hitTest, hitTestAll, refBoxes, regionToRefs, hitsToRefs, selectionHits, sheetSymbolHit, symbolHit, textOwnerHit, type Hit } from "./hittest";
import { drawNetHighlight, netGeometry } from "./netpaths";
import { drawMarkers, findingMarkers, markerAt, type Marker } from "./markers";
import { followDecision, pauseUntil } from "./follow";
import type { FindingRow } from "../agent/api";
import { findingMatches, findingRef } from "../agent/finding-ref";
import type { NetMapResult } from "../ipc/types";
import { anyFading, drawHighlightBoxes, highlightBoxes, withAlpha, type Highlight } from "./highlight";
import { cmdBounds, drawCommands, lodTier, paint, paintGrid, readTokens, FONT_MONO, FONT_SANS, type Cmd, type LodTier } from "./renderer";
import { makeMeasure, type MeasureFn } from "./textmetrics";
import { emptySheet, type Box, type Mil, type RenderSheet } from "./types";
import { boxUnion, expandBox, fitBox, gridPitch, lerpView, pan, screenToWorld, visibleWorld, worldToScreen, zoomAt, type ViewState } from "./viewport";
import { classifyWheel, gestureDown, gestureMove, gestureUp, type GestureState } from "./gesture";
import { contentBox, runCommand, type CanvasCommand, objectBox } from "./commands";
import { ORB_GLIDE_MS, ORB_LINGER_MS, attentionTarget, boxCentre, drawOrb, ghostDiff, hiddenAt, latestRevealed, objectsByUuid, orbPosition, prefersReducedMotion, revealAlpha, revealDone, revealSchedule, type CreatedObject, type OrbAnim, type SheetObject } from "./presence";
import { fetchRenderSheet, invalidateSheetCache } from "./sheet-cache";
import { useSettings } from "../state/settings";
import { canvasCombo } from "../ui/shortcuts/keymap";

export interface HoverInfo {
  hit: Hit | null;
  /** Screen position (CSS px, relative to the canvas). */
  screen: Mil;
  /** World position (mil) under the pointer. */
  world: Mil;
  /** Finding marker under the pointer, when any (takes precedence over geometry). */
  marker?: Marker | null;
  /** Grid pitch (mil) drawn at the current scale, so the status bar can say which grid is on screen. */
  pitch?: number;
}

export type GestureHint = "read_only_drag" | "read_only_double_click" | "read_only_key";

export const LARGE_SHEET_OBJECTS = 2000;

export interface CanvasViewProps {
  projectKey: string;
  sheet: string;
  selection: Ref[];
  onSelect: (refs: Ref[]) => void;
  /** Right-click: the hit under the pointer (or null on empty space) and the screen position for a menu. */
  onContextMenu?: (hit: Hit | null, refs: Ref[], at: { x: number; y: number }) => void;
  /** Highlight groups, or bare refs (treated as an agent focus highlight). */
  highlight: Highlight[] | Ref[];
  follow: boolean;
  theme: "light" | "dark";
  grid: boolean;
  /** Bump to force a geometry re-fetch (after apply / rollback / fs change). */
  revision?: number;
  /** Toolbar / shortcut command channel; a new `seq` runs the command once. */
  command?: CanvasCommand | null;
  showHidden?: boolean;
  onReady?: (sheet: RenderSheet) => void;
  onHover?: (info: HoverInfo | null) => void;
  onGestureHint?: (hint: GestureHint) => void;
  onError?: (message: string) => void;
  /** Optional net lookup for wires (from the harness' last nets query). */
  netOfWire?: (uuid: string) => string | null;
  /** Engine `net_map` for this sheet (hover / sticky net highlight; never computed here). */
  netMap?: NetMapResult | null;
  /** Net to highlight on the overlay (hovered or pinned by the user). */
  hoverNet?: string | null;
  /** Unresolved findings; those anchored on this sheet get markers. */
  findings?: readonly FindingRow[];
  /** Identifiers of the current sheet (file, instance path, names) to match `FindingRow.sheet`. */
  sheetIds?: readonly string[];
  /** Double-click on an object (empty space keeps the read-only hint). */
  onOpen?: (hit: Hit, refs: Ref[]) => void;
  /** Click on a finding marker. */
  onMarker?: (marker: Marker) => void;
  /** Following was paused by a manual interaction (until the given timestamp) or resumed (null). */
  onFollowPaused?: (until: number | null) => void;
  className?: string;
  /** Agent presence: a marker glides to what the agent is looking at; a new `seq` re-targets. */
  attention?: { seq: number; role: string; label: string; refs?: Ref[]; region_mil?: Box; sheet?: string } | null;
  /** Objects created by the last apply; revealed one by one once the re-fetched sheet contains them. */
  reveal?: { run_id: string; created: CreatedObject[] } | null;
  /** Verified-but-unapplied preview (sch.plan) drawn as a ghost layer until the apply lands. */
  ghost?: { preview_id: string; sheet: string } | null;
  /**
   * Combos the panel's keyboard layer answers (from the effective keymap, remaps included). Keys in
   * this set bubble untouched instead of being handled here, so the two layers never both fire and
   * the hand-off follows the user's keymap rather than a hard-coded default.
   */
  panelKeys?: ReadonlySet<string>;
}

export interface CanvasViewHandle {
  refresh(): Promise<void>;
  fit(): void;
  zoomTo(refs: Ref[]): void;
  zoomToBox(box: Box): void;
  zoomIn(): void;
  zoomOut(): void;
  sheet(): RenderSheet | null;
  /** Current view (tests / perf HUD). */
  view(): ViewState;
  /** Resume following now (clears the manual-interaction pause). */
  resumeFollow(): void;
  /** Current markers (tests / keyboard walk). */
  markers(): Marker[];
}

const FOLLOW_ANIM_MS = 320;
const FLASH_MS = 1600;
const ORB_PULSE_MS = 1600;
const REGION_FADE_MS = 300;
const REVEAL_FONT = "Geist Sans, system-ui, sans-serif";
const PERF_FRAMES = 120;

interface OrbState {
  anim: OrbAnim;
  label: string;
  region?: Box;
  regionSince: number;
  /** Set when the harness stopped pointing; the orb fades over `ORB_LINGER_MS`. */
  hiddenAt: number | null;
  /** When the current caption started (elapsed seconds are appended after 2 s). */
  since: number;
}

interface RevealState {
  run_id: string;
  schedule: Map<string, number>;
  start: number;
  objects: Map<string, SheetObject>;
  hopped: string | null;
  /** Uuids not yet revealed at the last scene repaint (the scene only repaints when this changes). */
  hidden: Set<string>;
}

interface PerfStats {
  frames: number[];
  scene: number;
  overlay: number;
  drawn: number;
  culled: number;
}

/** Accept `Ref[]` (the shell's focus list) as well as explicit highlight groups. */
function normalizeHighlight(h: Highlight[] | Ref[]): Highlight[] {
  if (!h.length) return [];
  const first = h[0] as { refs?: unknown; kind?: string };
  if (Array.isArray(first.refs)) return h as Highlight[];
  return [{ refs: h as Ref[], kind: "focus" }];
}

function perfEnabled(): boolean {
  try { return typeof location !== "undefined" && new URLSearchParams(location.search).has("perf"); } catch { return false; }
}

const LAYER_STYLE: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" };

export const CanvasView = forwardRef<CanvasViewHandle, CanvasViewProps>(function CanvasView(props, ref) {
  const { projectKey, sheet, selection, onSelect, onContextMenu, follow, theme, grid, revision = 0, showHidden, onReady, onHover, onGestureHint, onError, netOfWire, command, attention, reveal, ghost, netMap = null, hoverNet = null, findings, sheetIds, onOpen, onMarker, onFollowPaused, panelKeys } = props;
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);
  // `canvas.drag_selects` (docs/settings.md): read straight from the settings store so the gesture
  // follows the setting without another prop through the panel. Off = left-drag pans (default).
  const dragSelects = useSettings((st) => st.settings.agent.canvas_drag_selects === true);
  const perf = useMemo(() => perfEnabled(), []);
  const orbRef = useRef<OrbState | null>(null);
  const revealRef = useRef<RevealState | null>(null);
  const revealStartedRef = useRef<string>("");
  const [flash, setFlash] = useState<{ refs: Ref[]; since: number } | null>(null);
  const highlight = useMemo<Highlight[]>(() => {
    const base = normalizeHighlight(props.highlight);
    return flash ? [...base, { refs: flash.refs, kind: "changed", since: flash.since }] : base;
  }, [props.highlight, flash]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<RenderSheet | null>(null);
  // Ghost layer: geometry of a verified-but-unapplied preview (only what the sheet does not have yet).
  const [ghostData, setGhostData] = useState<{ id: string; sheet: RenderSheet } | null>(null);
  const ghostCmdsRef = useRef<{ key: string; cmds: Cmd[]; bounds: Float64Array } | null>(null);
  /** Uuids the on-disk sheet already has (ghost objects with these are not drawn); rebuilt per `data`. */
  const haveRef = useRef<ReadonlySet<string>>(new Set());
  /** Ghost layer: uuids unchanged between disk and preview (not drawn) and on-disk objects the preview removes (outlined). */
  const ghostSkipRef = useRef<{ skip: ReadonlySet<string>; removed: SheetObject[] }>({ skip: new Set(), removed: [] });
  const viewRef = useRef<ViewState>({ x: 0, y: 0, scale: 0.1 });
  const sizeRef = useRef<[number, number]>([1, 1]);
  const [size, setSize] = useState<[number, number]>([1, 1]);
  // One command list per LOD tier, built lazily for the tier the current zoom needs.
  const cmdsRef = useRef<{ cmds: Cmd[]; bounds: Float64Array; tiers: Partial<Record<LodTier, { cmds: Cmd[]; bounds: Float64Array }>>; gen: number; /** Indices of symbol-owned text commands (property-text hit fallback). */ texts: number[] }>({ cmds: [], bounds: new Float64Array(0), tiers: {}, gen: 0, texts: [] });
  // Text metrics from an offscreen canvas (label flag lengths); headless estimate when there is none.
  const measureRef = useRef<MeasureFn | null>(null);
  const getMeasure = (): MeasureFn => {
    if (!measureRef.current) {
      let ctx: CanvasRenderingContext2D | null = null;
      try { ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null; } catch { ctx = null; }
      measureRef.current = makeMeasure(ctx, { sans: FONT_SANS, mono: FONT_MONO });
    }
    return measureRef.current;
  };
  /** Commands for the tier that `scale` needs (built on first use per data generation). */
  const cmdsForScale = (scale: number): { cmds: Cmd[]; bounds: Float64Array } => {
    const tier = lodTier(scale);
    if (tier === "full" || tier === "text-off") return cmdsRef.current; // text-off is decided at paint time
    const have = cmdsRef.current.tiers[tier];
    if (have) return have;
    const d = dataRef.current ?? emptySheet();
    const cmds = drawCommands(d, { showHidden: propsRef.current.showHidden, frame: true, lod: tier, measure: getMeasure() });
    const built = { cmds, bounds: cmdBounds(cmds) };
    cmdsRef.current.tiers[tier] = built;
    return built;
  };
  const tokensRef = useRef<Record<string, string>>({});
  /** Markers for the current sheet / findings / zoom (clustering depends on the scale). */
  const findingsGenRef = useRef(0);
  const lastFindingsRef = useRef<readonly FindingRow[] | undefined>(undefined);
  const currentMarkers = (scale: number): Marker[] => {
    const d = dataRef.current;
    const f = propsRef.current.findings;
    if (!d || !f || !f.length) return [];
    // A re-check can move a finding while keeping the counts: key on the array identity, not on counts.
    if (f !== lastFindingsRef.current) { lastFindingsRef.current = f; findingsGenRef.current++; }
    const key = `${cmdsRef.current.gen}|${findingsGenRef.current}|${scale.toFixed(4)}`;
    if (markersRef.current.key !== key) markersRef.current = { key, markers: findingMarkers(d, f, scale, propsRef.current.sheetIds ?? [d.file, d.sheet_path]) };
    return markersRef.current.markers;
  };
  const animRef = useRef<{ from: ViewState; to: ViewState; start: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef<{ scene: boolean; overlay: boolean }>({ scene: true, overlay: true });
  const perfRef = useRef<PerfStats>({ frames: [], scene: 0, overlay: 0, drawn: 0, culled: 0 });
  const dragRef = useRef<GestureState | null>(null);
  const spaceRef = useRef(false);
  const interactedRef = useRef(false);
  const [cursor, setCursor] = useState<"default" | "grab" | "grabbing" | "crosshair">("default");
  const bandRef = useRef<Box | null>(null);
  const fittedRef = useRef<string>("");
  const fetchSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const dataRef = useRef<RenderSheet | null>(null);
  dataRef.current = data;
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const propsRef = useRef({ grid, showHidden, reducedMotion, attention, ghostData, netMap, hoverNet, findings, sheetIds, onHover, onFollowPaused });
  propsRef.current = { grid, showHidden, reducedMotion, attention, ghostData, netMap, hoverNet, findings, sheetIds, onHover, onFollowPaused };
  // Follow pause (FR-205): a manual pan / zoom keeps the camera still for FOLLOW_PAUSE_MS.
  const pausedUntilRef = useRef(0);
  const pauseFollow = useCallback(() => {
    const until = pauseUntil(performance.now());
    const was = pausedUntilRef.current;
    pausedUntilRef.current = until;
    if (propsRef.current.onFollowPaused && (was <= performance.now())) propsRef.current.onFollowPaused(until);
  }, []);
  // Hover: at most one hit-test per animation frame; the callback fires only when the hit changes.
  const hoverRafRef = useRef<number | null>(null);
  const hoverPendingRef = useRef<Mil | null>(null);
  const hoverKeyRef = useRef<string>("");
  // Overlay caches: markers for the current (data, findings, scale); net geometry via `netGeometry`.
  const markersRef = useRef<{ key: string; markers: Marker[] }>({ key: "", markers: [] });
  const lastClickRef = useRef<{ key: string; hits: Hit[]; index: number } | null>(null);
  /** Latest `cycleSelection` (defined further down), so the command effect can reach it. */
  const cycleRef = useRef<(dir: 1 | -1) => void>(() => undefined);

  // ------------------------------------------------------------ scheduling
  const drawRef = useRef<() => void>(() => undefined);
  const schedule = useCallback((layer: "scene" | "overlay" | "both" = "both") => {
    if (layer === "scene" || layer === "both") dirtyRef.current.scene = true;
    if (layer === "overlay" || layer === "both") dirtyRef.current.overlay = true;
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      drawRef.current();
      return;
    }
    rafRef.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  /** The view lives in a ref (no React re-render per pan/zoom/animation frame). */
  const applyView = useCallback((next: ViewState | ((v: ViewState) => ViewState)) => {
    viewRef.current = typeof next === "function" ? next(viewRef.current) : next;
    schedule("both");
  }, [schedule]);

  // ------------------------------------------------------------ data fetch
  const refresh = useCallback(async () => {
    if (!projectKey || !sheet) return;
    const seq = ++fetchSeqRef.current;
    try {
      const rs = await fetchRenderSheet(projectKey, sheet, revision);
      // A newer request (sheet switch, later revision) or unmount makes this result stale.
      if (seq !== fetchSeqRef.current || !mountedRef.current) return;
      setData(rs);
      onReady?.(rs);
    } catch (e) {
      if (seq !== fetchSeqRef.current || !mountedRef.current) return;
      onError?.(e instanceof Error ? e.message : String(e));
    }
  }, [projectKey, sheet, revision, onError, onReady]);

  useEffect(() => {
    if (revision > 0) invalidateSheetCache(projectKey);
    void refresh();
  }, [refresh, revision, projectKey]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (!ghost || !projectKey || ghost.sheet !== sheet) { setGhostData(null); ghostCmdsRef.current = null; schedule("scene"); return; }
    let cancelled = false;
    void (async () => {
      try {
        const { call } = await import("../ipc/client");
        const res = await call("engine_request", { project_key: projectKey, request: { kind: "render_preview", preview_id: ghost.preview_id, sheet }, auth: {} });
        if (cancelled || !res.ok) return;
        setGhostData({ id: ghost.preview_id, sheet: res.data as RenderSheet });
      } catch { /* the preview may already be gone */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost?.preview_id, ghost?.sheet, projectKey, sheet]);
  useEffect(() => {
    // Ghost commands depend only on the preview and the density; what to leave out is a skip set.
    if (ghostData) {
      const key = `${ghostData.id}|${showHidden ? 1 : 0}`;
      if (!ghostCmdsRef.current || ghostCmdsRef.current.key !== key) {
        const cmds = drawCommands(ghostData.sheet, { showHidden, frame: false, measure: getMeasure() });
        ghostCmdsRef.current = { key, cmds, bounds: cmdBounds(cmds) };
      }
      ghostSkipRef.current = data ? ghostDiff(data, ghostData.sheet) : { skip: new Set(), removed: [] };
    } else { ghostCmdsRef.current = null; ghostSkipRef.current = { skip: new Set(), removed: [] }; }
    schedule("both");
  }, [ghostData, showHidden, data, schedule]);

  // ------------------------------------------------------------ commands
  useEffect(() => {
    const cmds = drawCommands(data ?? emptySheet(sheet), { showHidden, frame: true, measure: getMeasure() });
    const texts: number[] = [];
    for (let i = 0; i < cmds.length; i++) if (cmds[i].op === "text" && cmds[i].uuid) texts.push(i);
    cmdsRef.current = { cmds, bounds: cmdBounds(cmds), tiers: {}, gen: cmdsRef.current.gen + 1, texts };
    haveRef.current = data ? new Set(objectsByUuid(data).keys()) : new Set();
    schedule("scene");
  }, [data, showHidden, sheet, schedule]);

  useEffect(() => {
    tokensRef.current = readTokens(sceneRef.current, theme);
    schedule("both");
  }, [theme, schedule]);

  useEffect(() => { schedule("scene"); }, [grid, schedule]);
  // Moving the window to a monitor with another pixel density changes `devicePixelRatio`: repaint.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let mql: MediaQueryList | null = null;
    let onChange: (() => void) | null = null;
    let disposed = false;
    const arm = () => {
      if (disposed) return;
      const dpr = window.devicePixelRatio || 1;
      try { mql = window.matchMedia(`(resolution: ${dpr}dppx)`); } catch { mql = null; }
      if (!mql) return;
      onChange = () => { mql?.removeEventListener("change", onChange!); schedule("both"); arm(); };
      mql.addEventListener("change", onChange);
    };
    arm();
    return () => { disposed = true; if (mql && onChange) mql.removeEventListener("change", onChange); };
  }, [schedule]);
  useEffect(() => { schedule("overlay"); }, [highlight, selection, hoverNet, netMap, findings, schedule]);

  // ------------------------------------------------------------ resize
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      sizeRef.current = [w, h];
      setSize([w, h]);
      schedule("both");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [schedule]);

  // Fit once per sheet load (content, or the paper when empty); keep re-fitting on
  // panel resizes until the user pans or zooms, then leave their view alone.
  useEffect(() => {
    if (!data) return;
    const key = `${projectKey}|${data.sheet_path}`;
    const [w, h] = sizeRef.current;
    // Wait for the ResizeObserver: fitting against a 1x1 placeholder would pin
    // the sheet to the top-left corner at the minimum zoom.
    if (w <= 1 || h <= 1) return;
    if (fittedRef.current === key && interactedRef.current) return;
    if (fittedRef.current !== key) interactedRef.current = false;
    fittedRef.current = key;
    applyView(fitBox(contentBox(data, objectBox(cmdsRef.current.cmds, cmdsRef.current.bounds)), w, h));
  }, [data, projectKey, size, applyView]);

  // ------------------------------------------------------------ commands
  const lastSeqRef = useRef(0);
  useEffect(() => {
    if (!command || command.seq === lastSeqRef.current) return;
    lastSeqRef.current = command.seq;
    if (command.kind === "resume_follow") { pausedUntilRef.current = 0; propsRef.current.onFollowPaused?.(null); setFollowTick((n) => n + 1); schedule("both"); return; }
    // Candidate cycling changes the selection, not the view: it is answered here because the stack of
    // candidates (the last click, or what sits at the selection) only exists in this component.
    if (command.kind === "cycle_next" || command.kind === "cycle_prev") { cycleRef.current(command.kind === "cycle_next" ? 1 : -1); return; }
    const [w, h] = sizeRef.current;
    const r = runCommand(command, { view: viewRef.current, w, h, sheet: data, selection, content: objectBox(cmdsRef.current.cmds, cmdsRef.current.bounds) });
    if (command.kind !== "fit") interactedRef.current = true;
    if (r.view) {
      if (r.animate) animRef.current = { from: viewRef.current, to: r.view, start: performance.now() };
      else { animRef.current = null; applyView(r.view); }
    }
    if (r.flash) setFlash({ refs: r.flash.refs, since: performance.now() });
    schedule("both");
  }, [command, data, selection, applyView, schedule]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(id);
  }, [flash]);

  // ------------------------------------------------------------ follow
  const followMsRef = useRef(FOLLOW_ANIM_MS);
  const [followTick, setFollowTick] = useState(0);
  useEffect(() => {
    if (!follow || !data) return;
    // The camera follows what the agent is pointing at and a one-shot change flash (`since`), never
    // the turn's persistent change set — that one stays on screen for reading, not for chasing.
    const focus = highlight.filter((h) => h.kind === "focus" || (h.kind === "changed" && h.since !== undefined)).flatMap((h) => refBoxes(data, h.refs));
    const union = boxUnion(focus);
    if (!union) return;
    const now = performance.now();
    const d = followDecision({ view: viewRef.current, size: sizeRef.current, target: union, pausedUntil: pausedUntilRef.current, now, animTo: animRef.current?.to ?? null, reducedMotion });
    if (d.kind !== "animate") return;
    if (d.ms === 0) { animRef.current = null; applyView(d.target); return; }
    followMsRef.current = d.ms;
    animRef.current = { from: viewRef.current, to: d.target, start: now };
    schedule("both");
  }, [highlight, follow, data, reducedMotion, applyView, schedule, followTick]);

  // ------------------------------------------------------------ presence
  /** Pan (keeping the zoom) so `p` is on screen; no-op when it already is. */
  const bringIntoView = useCallback((p: Mil) => {
    if (!follow || pausedUntilRef.current > performance.now()) return;
    const [w, h] = sizeRef.current;
    const v = viewRef.current;
    const s = worldToScreen(v, p);
    const m = 48;
    if (s[0] >= m && s[0] <= w - m && s[1] >= m && s[1] <= h - m) return;
    const target: ViewState = { scale: v.scale, x: p[0] - w / 2 / v.scale, y: p[1] - h / 2 / v.scale };
    if (reducedMotion) { animRef.current = null; applyView(target); return; }
    animRef.current = { from: v, to: target, start: performance.now() };
  }, [follow, reducedMotion, applyView]);

  const moveOrb = useCallback((to: Mil, label: string, region?: Box) => {
    const now = performance.now();
    const prev = orbRef.current;
    const from = prev ? orbPosition(prev.anim, now, reducedMotion ? 0 : ORB_GLIDE_MS) : to;
    const sameRegion = !!prev?.region && !!region && prev.region[0][0] === region[0][0] && prev.region[0][1] === region[0][1] && prev.region[1][0] === region[1][0] && prev.region[1][1] === region[1][1];
    orbRef.current = { anim: { from, to, start: now }, label, region, regionSince: sameRegion ? prev!.regionSince : now, hiddenAt: null, since: prev && prev.label === label ? prev.since : now };
    bringIntoView(to);
    schedule("overlay");
  }, [bringIntoView, reducedMotion, schedule]);

  // Attention: glide the marker to the target; when the harness stops pointing, linger then fade.
  useEffect(() => {
    if (!attention) {
      if (orbRef.current && orbRef.current.hiddenAt === null) { orbRef.current.hiddenAt = performance.now(); schedule("overlay"); }
      return;
    }
    if (attention.sheet && data && attention.sheet !== data.sheet_path && !attention.region_mil) return;
    const target = attentionTarget(data, attention);
    if (!target) {
      // Unknown target: keep the marker where it is but refresh the caption.
      if (orbRef.current) { orbRef.current.label = attention.label; orbRef.current.hiddenAt = null; schedule("overlay"); }
      return;
    }
    moveOrb(target.at, target.label, target.region);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attention?.seq, attention, data, moveOrb]);

  // Reveal: once the re-fetched sheet contains the created objects, draw them in op order.
  useEffect(() => {
    if (!reveal || !data || reveal.run_id === revealStartedRef.current) return;
    const objects = objectsByUuid(data);
    const present = reveal.created.filter((c) => objects.has(c.uuid));
    if (!present.length) return; // sheet not re-fetched yet (or another sheet)
    revealStartedRef.current = reveal.run_id;
    // Large projects (> LARGE_SHEET_OBJECTS objects on the sheet) skip the staged reveal: everything appears at once.
    const instant = reducedMotion || objects.size > LARGE_SHEET_OBJECTS;
    const schedule_ = instant ? new Map(present.map((c) => [c.uuid, 0])) : revealSchedule(present);
    const start = performance.now();
    revealRef.current = { run_id: reveal.run_id, schedule: schedule_, start, objects, hopped: null, hidden: hiddenAt(schedule_, start, start) };
    schedule("both");
  }, [reveal, data, reducedMotion, schedule]);

  // ------------------------------------------------------------ painting
  const ensureSize = (el: HTMLCanvasElement, w: number, h: number, dpr: number) => {
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
  };

  const drawScene = (ctx: CanvasRenderingContext2D, v: ViewState, w: number, h: number, dpr: number) => {
    const tokens = tokensRef.current;
    const { grid: showGrid, ghostData: gd } = propsRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = tokens["--fs-canvas-bg"];
    ctx.fillRect(0, 0, w, h);
    if (showGrid) paintGrid(ctx, v, w, h, tokens["--fs-canvas-grid"], dpr);
    const visible = visibleWorld(v, w, h);
    // Ghost preview under the real sheet: only objects the on-disk sheet does not have yet.
    if (gd && ghostCmdsRef.current) {
      paint(ctx, ghostCmdsRef.current.cmds, v, { grid: showGrid, tokens, alpha: 0.35, monochrome: tokens["--fs-canvas-changed"], visible, bounds: ghostCmdsRef.current.bounds, skip: ghostSkipRef.current.skip, dpr });
    }
    // Staged reveal: leave out the objects whose turn has not come yet.
    const rv = revealRef.current;
    const stats = perf ? { drawn: 0, culled: 0 } : undefined;
    const lod = cmdsForScale(v.scale);
    paint(ctx, lod.cmds, v, { grid: showGrid, tokens, visible, bounds: lod.bounds, skip: rv && rv.hidden.size ? rv.hidden : undefined, stats, dpr });
    if (stats) { perfRef.current.drawn = stats.drawn; perfRef.current.culled = stats.culled; }
  };

  const drawOverlay = (ctx: CanvasRenderingContext2D, v: ViewState, w: number, h: number, dpr: number, now: number) => {
    const tokens = tokensRef.current;
    const { reducedMotion: rm, attention: att } = propsRef.current;
    const d = dataRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // A highlight group may address objects by uuid (what an apply created); only this sheet's own
    // objects resolve, so a turn that also drew on another sheet simply highlights less here.
    if (d) drawHighlightBoxes(ctx, v, highlightBoxes(d, highlightRef.current, selectionRef.current, tokens, now, (u) => objectsByUuid(d).get(u)?.box ?? null));
    if (ghostCmdsRef.current && ghostSkipRef.current.removed.length) {
      // Objects the pending apply would remove: dashed outlines in the change tint.
      ctx.save();
      ctx.strokeStyle = tokens["--fs-canvas-changed"];
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      for (const o of ghostSkipRef.current.removed) {
        const [x0, y0] = worldToScreen(v, o.box[0]);
        const [x1, y1] = worldToScreen(v, o.box[1]);
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      ctx.restore();
    }
    const { netMap: nm, hoverNet: hn, findings: fs } = propsRef.current;
    if (d && nm && hn) drawNetHighlight(ctx, v, netGeometry(d, nm, hn), tokens["--fs-canvas-hover"]);
    if (d && nm) {
      // A selected net (sidebar row, context menu "show net") is drawn along its wires and pins, not only
      // at its labels — an unnamed `Net-(R1-Pad1)` has no label to box.
      for (const r of selectionRef.current) if (r.kind === "net" && r.name !== hn) drawNetHighlight(ctx, v, netGeometry(d, nm, r.name), tokens["--fs-canvas-selection"], 0.75);
    }
    if (d && fs && fs.length) {
      const sel = selectionRef.current;
      // A finding ref carries `location`, or the joined refs when the engine gave none, so same-code findings stay distinct.
      const current = sel.some((r) => r.kind === "finding") ? (f: FindingRow) => sel.some((r) => r.kind === "finding" && findingMatches(r, f)) : undefined;
      drawMarkers(ctx, v, currentMarkers(v.scale), tokens, REVEAL_FONT, tokens["--fs-canvas-paper"], current);
    }
    const rv = revealRef.current;
    if (rv && d) {
      // Pop-in glow around objects revealed in the last moment; the marker hops to the newest one.
      const ink = tokens["--fs-canvas-changed"];
      for (const [uuid, delay] of rv.schedule) {
        const a = revealAlpha(delay, rv.start, now, rm ? 0 : undefined);
        if (a <= 0 || a >= 1) continue;
        const o = rv.objects.get(uuid);
        if (!o) continue;
        const grow = (1 - a) * 30;
        const x0 = (o.box[0][0] - grow - v.x) * v.scale, y0 = (o.box[0][1] - grow - v.y) * v.scale;
        const x1 = (o.box[1][0] + grow - v.x) * v.scale, y1 = (o.box[1][1] + grow - v.y) * v.scale;
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = withAlpha(ink, (1 - a) * 0.8);
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        ctx.restore();
      }
      const latest = latestRevealed(rv.schedule, rv.start, now);
      if (latest && latest !== rv.hopped) {
        rv.hopped = latest;
        const o = rv.objects.get(latest);
        if (o) moveOrb(boxCentre(o.box), orbRef.current?.label ?? "", undefined);
      }
      if (revealDone(rv.schedule, rv.start, now, rm ? 0 : undefined)) {
        revealRef.current = null;
        dirtyRef.current.scene = true;
        if (orbRef.current && orbRef.current.hiddenAt === null && !att) orbRef.current.hiddenAt = now;
      }
    }
    const orb = orbRef.current;
    if (orb) {
      const alpha = orb.hiddenAt === null ? 1 : Math.max(0, 1 - (now - orb.hiddenAt) / ORB_LINGER_MS);
      if (alpha <= 0) orbRef.current = null;
      else {
        drawOrb(ctx, v, {
          at: orbPosition(orb.anim, now, rm ? 0 : ORB_GLIDE_MS),
          pulse: rm ? 0.25 : (now % ORB_PULSE_MS) / ORB_PULSE_MS,
          alpha,
          label: orb.since && now - orb.since > 2000 ? `${orb.label} · ${Math.round((now - orb.since) / 1000)} s` : orb.label,
          region: orb.region,
          regionAlpha: rm ? 1 : Math.min(1, (now - orb.regionSince) / REGION_FADE_MS),
        }, tokens, REVEAL_FONT);
      }
    }
    const band = bandRef.current;
    if (band) {
      const a = worldToScreen(v, band[0]);
      const b = worldToScreen(v, band[1]);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = tokens["--fs-canvas-selection"];
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.restore();
    }
    if (perf) {
      const p = perfRef.current;
      const n = p.frames.length;
      const avg = n ? p.frames.reduce((s, x) => s + x, 0) / n : 0;
      const max = n ? Math.max(...p.frames) : 0;
      ctx.save();
      ctx.font = `11px ${REVEAL_FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = withAlpha(tokens["--fs-canvas-bg"], 0.8);
      ctx.fillRect(4, 4, 250, 46);
      ctx.fillStyle = tokens["--fs-canvas-changed"];
      ctx.fillText(`frame avg ${avg.toFixed(2)} ms · max ${max.toFixed(1)} ms (n=${n})`, 8, 8);
      ctx.fillText(`scene ${p.scene} · overlay ${p.overlay} · cmds ${cmdsRef.current.cmds.length}`, 8, 22);
      ctx.fillText(`drawn ${p.drawn} · culled ${p.culled} · scale ${v.scale.toFixed(3)}`, 8, 36);
      ctx.restore();
    }
  };

  /** One animation frame: advance the view animation, repaint the dirty layers, re-arm if animating. */
  const frame = useCallback(() => {
    rafRef.current = null;
    const scene = sceneRef.current;
    const overlay = overlayRef.current;
    if (!scene || !overlay) return;
    const t0 = perf ? performance.now() : 0;
    const [w, h] = sizeRef.current;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const now = performance.now();
    let v = viewRef.current;
    if (animRef.current) {
      const t = (now - animRef.current.start) / followMsRef.current;
      v = lerpView(animRef.current.from, animRef.current.to, t);
      if (t >= 1) {
        v = animRef.current.to;
        animRef.current = null;
        followMsRef.current = FOLLOW_ANIM_MS;
      }
      viewRef.current = v;
      dirtyRef.current.scene = true;
      dirtyRef.current.overlay = true;
    }
    const rv = revealRef.current;
    if (rv) {
      const hidden = hiddenAt(rv.schedule, rv.start, now);
      if (hidden.size !== rv.hidden.size) { rv.hidden = hidden; dirtyRef.current.scene = true; }
      dirtyRef.current.overlay = true;
    }
    const { reducedMotion: rm } = propsRef.current;
    const orbLive = orbRef.current !== null && (!rm || orbRef.current.hiddenAt !== null);
    if (orbLive || anyFading(highlightRef.current, now)) dirtyRef.current.overlay = true;
    const dirty = dirtyRef.current;
    if (dirty.scene) {
      ensureSize(scene, w, h, dpr);
      const ctx = scene.getContext("2d");
      if (ctx) { drawScene(ctx, v, w, h, dpr); if (perf) perfRef.current.scene++; }
      dirty.scene = false;
    }
    if (dirty.overlay) {
      ensureSize(overlay, w, h, dpr);
      const ctx = overlay.getContext("2d");
      if (ctx) { drawOverlay(ctx, v, w, h, dpr, now); if (perf) perfRef.current.overlay++; }
      dirty.overlay = false;
    }
    if (perf) {
      const p = perfRef.current;
      p.frames.push(performance.now() - t0);
      if (p.frames.length > PERF_FRAMES) p.frames.shift();
    }
    if (pausedUntilRef.current && now >= pausedUntilRef.current) { pausedUntilRef.current = 0; propsRef.current.onFollowPaused?.(null); }
    const orbStill = orbRef.current !== null && (!rm || orbRef.current.hiddenAt !== null);
    if (animRef.current) schedule("both");
    else if (revealRef.current || orbStill || anyFading(highlightRef.current, now)) schedule("overlay");
    else if (pausedUntilRef.current > now && typeof setTimeout === "function") setTimeout(() => schedule("overlay"), Math.min(1000, pausedUntilRef.current - now + 5));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perf, moveOrb, schedule]);
  drawRef.current = frame;

  useEffect(() => () => {
    if (rafRef.current !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafRef.current);
  }, []);

  // ------------------------------------------------------------ interaction
  const localPoint = (e: { clientX: number; clientY: number }): Mil => {
    const r = sceneRef.current?.getBoundingClientRect();
    return [e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)];
  };
  const tol = () => 6 / viewRef.current.scale;
  const setBand = (b: Box | null) => { bandRef.current = b; schedule("overlay"); };

  // Wheel must be a non-passive native listener (React registers `wheel` passively,
  // so `preventDefault` there cannot stop the page/panel from scrolling).
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      animRef.current = null;
      interactedRef.current = true;
      pauseFollow();
      const r = el.getBoundingClientRect();
      const p: Mil = [e.clientX - r.left, e.clientY - r.top];
      const a = classifyWheel({ deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey });
      if (a.kind === "zoom") applyView((v) => zoomAt(v, p, a.factor));
      else applyView((v) => pan(v, a.dx, a.dy));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyView, pauseFollow]);

  /**
   * Give up the drag without committing it. A release this window never saw — focus lost to another
   * app or a dialog, a pointer capture taken away — would otherwise leave the drag armed and turn
   * every later mouse move into a pan.
   */
  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setBand(null);
    setCursor(spaceRef.current ? "grab" : "default");
  };
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => {
    const onBlur = () => endDragRef.current();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  /** Object under a world point: the geometric ladder first, then a symbol's drawn property text. */
  const hitAt = (d: RenderSheet, world: Mil): Hit | null => hitTest(d, world, tol()) ?? textOwnerHit(d, cmdsRef.current.cmds, cmdsRef.current.bounds, world, tol() / 2, cmdsRef.current.texts);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Middle button: cancelling `pointerdown` suppresses the compatibility `mousedown`, which is
    // what starts Chromium's autoscroll widget (WebView2 on Windows); `auxclick` is cancelled on
    // the element itself. Without this, middle-drag panning fights the browser's own scroll puck.
    if (e.button === 1) e.preventDefault();
    const p = localPoint(e);
    const hit = data ? hitAt(data, screenToWorld(viewRef.current, p)) : null;
    const g = gestureDown(p, e.button, { alt: e.altKey, shift: e.shiftKey, space: spaceRef.current, dragSelects }, hit?.kind === "symbol" || hit?.kind === "pin");
    if (!g) return;
    animRef.current = null;
    dragRef.current = g;
    if (g.mode === "pan") setCursor("grabbing");
    e.currentTarget.focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const hoverLastRef = useRef<HoverInfo | null>(null);
  const runHover = () => {
    hoverRafRef.current = null;
    const p = hoverPendingRef.current;
    const d = dataRef.current;
    const cb = propsRef.current.onHover;
    if (!p || !d || !cb) return;
    const v = viewRef.current;
    const marker = propsRef.current.findings?.length ? markerAt(currentMarkers(v.scale), v, p) : null;
    const hit = marker ? null : hitAt(d, screenToWorld(v, p));
    const key = marker ? `marker:${marker.at[0]},${marker.at[1]}` : hitKey(hit);
    // The status bar shows the cursor position, so every move reports; consumers that only care about
    // the object under the pointer compare `hit` identity, which is kept stable while the key is unchanged.
    const pitch = gridPitch(v.scale);
    if (key === hoverKeyRef.current && key !== "" && hoverLastRef.current) { cb({ ...hoverLastRef.current, screen: p, world: screenToWorld(v, p), pitch }); return; }
    hoverKeyRef.current = key;
    hoverLastRef.current = { hit, screen: p, world: screenToWorld(v, p), marker, pitch };
    cb(hoverLastRef.current);
  };
  const queueHover = (p: Mil) => {
    hoverPendingRef.current = p;
    if (hoverRafRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") { runHover(); return; }
    hoverRafRef.current = requestAnimationFrame(runHover);
  };
  const clearHover = () => {
    hoverPendingRef.current = null;
    if (hoverKeyRef.current !== "") { hoverKeyRef.current = ""; propsRef.current.onHover?.(null); }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = localPoint(e);
    const d = dragRef.current;
    // No button is down any more: the release happened somewhere this window never heard about.
    // Drop the drag here rather than panning on every hover from now on.
    if (d && e.buttons === 0) {
      endDrag();
      if (onHover && data) queueHover(p);
      return;
    }
    if (!d) {
      if (onHover && data) queueHover(p);
      return;
    }
    const { state, action } = gestureMove(d, p, { shift: e.shiftKey, alt: e.altKey, space: spaceRef.current, dragSelects });
    dragRef.current = state;
    if (action.kind === "pan") {
      interactedRef.current = true;
      pauseFollow();
      if (action.hint) onGestureHint?.("read_only_drag");
      if (cursor !== "grabbing") setCursor("grabbing");
      applyView((v) => pan(v, action.dx, action.dy));
    } else if (action.kind === "band") {
      if (cursor !== "crosshair") setCursor("crosshair");
      setBand([screenToWorld(viewRef.current, action.from), screenToWorld(viewRef.current, action.to)]);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = localPoint(e);
    const d = dragRef.current;
    dragRef.current = null;
    setCursor(spaceRef.current ? "grab" : "default");
    if (!d) return;
    const up = gestureUp(d, p);
    if (up.kind === "click") {
      if (!data) return;
      const v = viewRef.current;
      const marker = propsRef.current.findings?.length ? markerAt(currentMarkers(v.scale), v, up.at) : null;
      if (marker) {
        onMarker?.(marker);
        const f = marker.findings[0];
        onSelect([findingRef(f)]);
        return;
      }
      const world = screenToWorld(v, up.at);
      let hits = hitTestAll(data, world, tol());
      if (!hits.length) { const owner = textOwnerHit(data, cmdsRef.current.cmds, cmdsRef.current.bounds, world, tol() / 2, cmdsRef.current.texts); if (owner) hits = [owner]; }
      const clickKey = `${Math.round(world[0])},${Math.round(world[1])}`;
      lastClickRef.current = hits.length ? { key: clickKey, hits, index: 0 } : null;
      const hit = hits[0] ?? null;
      const refs = hit ? hitsToRefs(data, [hit], netOfWire) : [];
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const merged = [...selection];
        for (const r of refs) if (!merged.some((m) => sameRef(m, r))) merged.push(r);
        onSelect(merged);
      } else {
        onSelect(refs);
      }
    } else if (up.kind === "band" && bandRef.current && data) {
      onSelect(regionToRefs(data, bandRef.current, netOfWire));
    }
    setBand(null);
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dataRef.current;
    if (d && onOpen) {
      const hit = hitAt(d, screenToWorld(viewRef.current, localPoint(e)));
      if (hit) { onOpen(hit, hitsToRefs(d, [hit], netOfWire)); return; }
    }
    onGestureHint?.("read_only_double_click");
  };
  /**
   * `[` / `]`: step through the objects stacked under the last click. Without a click (the selection
   * came from the sidebar, the search box or `N`), fall back to what is stacked at the selection.
   */
  const cycleSelection = (dir: 1 | -1) => {
    const d = dataRef.current;
    if (!d) return;
    let lc = lastClickRef.current;
    if (!lc) {
      const hits = selectionHits(d, selection, tol());
      if (!hits.length) return;
      lc = { key: "selection", hits, index: 0 };
      lastClickRef.current = lc;
    }
    if (lc.hits.length < 2) return;
    lc.index = (lc.index + dir + lc.hits.length) % lc.hits.length;
    onSelect(hitsToRefs(d, [lc.hits[lc.index]], netOfWire));
  };
  cycleRef.current = cycleSelection;
  const onKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === " ") { spaceRef.current = false; if (!dragRef.current) setCursor("default"); }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    // The panel's keyboard layer owns the canvas-scope keymap, remaps included. Anything bound there
    // is left to bubble untouched, so no key is answered twice (`Mod+Home` fitting here and again in
    // the panel) and none is swallowed here after the human moved it somewhere else.
    if (panelKeys?.has(canvasCombo(e))) return;
    const nudge = 40;
    switch (e.key) {
      case " ":
        spaceRef.current = true;
        if (!dragRef.current) setCursor("grab");
        break;
      case "Escape":
        onSelect([]);
        setBand(null);
        clearHover();
        break;
      case "Enter": {
        // Keyboard equivalent of a double-click: open the detail of the one selected component, or
        // enter the one selected sheet symbol (the panel resolves it to a child instance).
        const d = dataRef.current;
        if (!d || !onOpen) return;
        const comps = selection.filter((r): r is Extract<Ref, { kind: "component" }> => r.kind === "component");
        const sheets = selection.filter((r): r is Extract<Ref, { kind: "sheet" }> => r.kind === "sheet");
        if (comps.length === 1) {
          const hit = symbolHit(d, comps[0].ref);
          if (!hit) return;
          onOpen(hit, [comps[0]]);
        } else if (sheets.length === 1) {
          const hit = sheetSymbolHit(d, sheets[0].path);
          if (!hit) return;
          onOpen(hit, [sheets[0]]);
        }
        break;
      }
      case "]":
        cycleSelection(1);
        break;
      case "[":
        cycleSelection(-1);
        break;
      case "+":
      case "=":
        interactedRef.current = true;
        pauseFollow();
        applyView((v) => zoomAt(v, [sizeRef.current[0] / 2, sizeRef.current[1] / 2], 1.25));
        break;
      case "-":
        interactedRef.current = true;
        pauseFollow();
        applyView((v) => zoomAt(v, [sizeRef.current[0] / 2, sizeRef.current[1] / 2], 0.8));
        break;
      case "0":
      case "Home":
        // Whatever combo the panel's `fitAll` is bound to was already ceded above; what is left here
        // is the canvas' own fit.
        if (data) applyView(fitBox(contentBox(data, objectBox(cmdsRef.current.cmds, cmdsRef.current.bounds)), sizeRef.current[0], sizeRef.current[1]));
        break;
      case "ArrowLeft": interactedRef.current = true; pauseFollow(); applyView((v) => pan(v, nudge, 0)); break;
      case "ArrowRight": interactedRef.current = true; pauseFollow(); applyView((v) => pan(v, -nudge, 0)); break;
      case "ArrowUp": interactedRef.current = true; pauseFollow(); applyView((v) => pan(v, 0, nudge)); break;
      case "ArrowDown": interactedRef.current = true; pauseFollow(); applyView((v) => pan(v, 0, -nudge)); break;
      case "Delete":
      case "Backspace":
      case "r":
      case "m":
      case "w":
        if (e.altKey || e.metaKey || e.ctrlKey) return; // Alt+Backspace = up one sheet (panel), not an edit attempt
        onGestureHint?.("read_only_key");
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ------------------------------------------------------------ handle
  useImperativeHandle(ref, (): CanvasViewHandle => ({
    refresh,
    fit: () => {
      if (data) applyView(fitBox(contentBox(data, objectBox(cmdsRef.current.cmds, cmdsRef.current.bounds)), sizeRef.current[0], sizeRef.current[1]));
    },
    zoomTo: (refs) => {
      if (!data) return;
      const u = boxUnion(refBoxes(data, refs));
      if (u) {
        animRef.current = { from: viewRef.current, to: fitBox(expandBox(u, 300), sizeRef.current[0], sizeRef.current[1], 48), start: performance.now() };
        schedule("both");
      }
    },
    zoomToBox: (box) => {
      animRef.current = { from: viewRef.current, to: fitBox(box, sizeRef.current[0], sizeRef.current[1], 48), start: performance.now() };
      schedule("both");
    },
    zoomIn: () => applyView((v) => zoomAt(v, [sizeRef.current[0] / 2, sizeRef.current[1] / 2], 1.25)),
    zoomOut: () => applyView((v) => zoomAt(v, [sizeRef.current[0] / 2, sizeRef.current[1] / 2], 0.8)),
    sheet: () => data,
    view: () => viewRef.current,
    resumeFollow: () => { pausedUntilRef.current = 0; propsRef.current.onFollowPaused?.(null); schedule("both"); },
    markers: () => currentMarkers(viewRef.current.scale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [data, refresh, applyView, schedule]);

  const wrapStyle = useMemo<React.CSSProperties>(() => ({ position: "relative", width: "100%", height: "100%", overflow: "hidden", touchAction: "none", cursor }), [cursor]);
  // No inline `outline`: the focus ring lives in CSS so `:focus-visible` can show it for keyboard focus only.
  const sceneStyle = useMemo<React.CSSProperties>(() => ({ ...LAYER_STYLE }), []);
  const overlayStyle = useMemo<React.CSSProperties>(() => ({ ...LAYER_STYLE, pointerEvents: "none" }), []);

  return (
    <div ref={wrapRef} className={props.className} style={wrapStyle}>
      <canvas
        ref={sceneRef}
        className="canvas-scene"
        style={sceneStyle}
        tabIndex={0}
        role="img"
        aria-label={data ? data.sheet_path : sheet}
        onPointerDown={onPointerDown}
        onAuxClick={(e) => e.preventDefault()}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={endDrag}
        onPointerLeave={clearHover}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!onContextMenu || !data) return;
          const p = localPoint(e as unknown as React.PointerEvent<HTMLCanvasElement>);
          const hit = hitAt(data, screenToWorld(viewRef.current, p));
          const refs = hit ? hitsToRefs(data, [hit], netOfWire) : [];
          if (hit && !selection.some((r) => sameRef(r, refs[0]))) onSelect(refs);
          onContextMenu(hit, refs, { x: e.clientX, y: e.clientY });
        }}
      />
      <canvas ref={overlayRef} style={overlayStyle} aria-hidden="true" />
    </div>
  );
});

/** Structural equality of two refs (they are small plain objects). */
function sameRef(a: Ref | undefined, b: Ref | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  const ka = Object.keys(a) as (keyof Ref)[];
  const kb = Object.keys(b) as (keyof Ref)[];
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k], vb = (b as Record<string, unknown>)[k];
    if (Array.isArray(va) && Array.isArray(vb)) { if (JSON.stringify(va) !== JSON.stringify(vb)) return false; }
    else if (va !== vb) return false;
  }
  return true;
}
