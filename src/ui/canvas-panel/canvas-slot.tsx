// SPDX-License-Identifier: Apache-2.0
// Lazy slot for the canvas renderer built by the canvas track (`src/canvas/index.ts`). Falls back to a
// placeholder when the module is absent so the UI type-checks and runs on its own.
import React, { Suspense } from "react";
import type { Ref } from "../../agent/api";
import { useT } from "../../i18n";
import { EmptyState } from "../components";

export interface CanvasViewProps {
  projectKey: string;
  sheet: string;
  selection: Ref[];
  onSelect: (refs: Ref[]) => void;
  onContextMenu?: (hit: import("../../canvas/hittest").Hit | null, refs: Ref[], at: { x: number; y: number }) => void;
  /** Bare refs (an agent focus) or explicit groups — a persistent "changed this turn" group carries uuids. */
  highlight: Ref[] | import("../../canvas/highlight").Highlight[];
  follow: boolean;
  theme: "light" | "dark";
  grid: boolean;
  /** Bumped by the shell to ask the renderer to re-read the sheet (fs change, apply). */
  revision?: number;
  /** Zoom command channel from the toolbar. */
  command?: import("../../canvas/commands").CanvasCommand | null;
  /** Agent presence: the canvas glides its marker to what the agent is looking at. */
  attention?: { seq: number; role: string; label: string; refs?: Ref[]; region_mil?: [[number, number], [number, number]]; sheet?: string } | null;
  /** Objects created by the last apply, revealed one by one after the re-fetch. */
  reveal?: { run_id: string; created: { uuid: string; kind: string }[] } | null;
  /** Verified-but-unapplied preview drawn as a ghost layer until the apply lands. */
  ghost?: { preview_id: string; sheet: string } | null;
  /** Hover readout (status bar): hit / marker under the pointer, or null when it leaves. */
  onHover?: (info: import("../../canvas/CanvasView").HoverInfo | null) => void;
  /** Engine `net_map` for this sheet (hover / pinned net highlight). */
  netMap?: import("../../ipc/types").NetMapResult | null;
  hoverNet?: string | null;
  netOfWire?: (uuid: string) => string | null;
  findings?: readonly import("../../agent/api").FindingRow[];
  sheetIds?: readonly string[];
  onOpen?: (hit: import("../../canvas/hittest").Hit, refs: Ref[]) => void;
  onMarker?: (marker: import("../../canvas/markers").Marker) => void;
  onFollowPaused?: (until: number | null) => void;
  onGestureHint?: (hint: "read_only_drag" | "read_only_double_click" | "read_only_key") => void;
  /** Combos the panel's own keyboard layer answers: the drawing lets exactly these bubble to it. */
  panelKeys?: ReadonlySet<string>;
  /** Geometry fetch failed (engine error text); the previous frame is kept. */
  onError?: (message: string) => void;
  onReady?: (sheet: import("../../canvas/types").RenderSheet) => void;
}

export function CanvasPlaceholder(_props: Partial<CanvasViewProps>) {
  const t = useT();
  return <div className="canvas-placeholder"><EmptyState icon="sheet" title={t("canvas.placeholder")} /></div>;
}

const mods = import.meta.glob("../../canvas/index.ts");
const loader = mods["../../canvas/index.ts"];

const LazyCanvas = loader
  ? React.lazy(async () => {
      const m = (await loader()) as { CanvasView?: React.ComponentType<CanvasViewProps> };
      return { default: m.CanvasView ?? CanvasPlaceholder };
    })
  : null;

export function CanvasSlot(props: CanvasViewProps) {
  if (!LazyCanvas) return <CanvasPlaceholder />;
  return (
    <Suspense fallback={<div className="canvas-placeholder" />}>
      <LazyCanvas {...props} />
    </Suspense>
  );
}
