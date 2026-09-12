// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useProjects } from "../../state/projects";
import { Button, ContextMenu, Dialog, Icon, IconButton } from "../components";
import { useOpenProjectDialog, NewProjectDialog } from "./Welcome";
import { dropBridge } from "../harness-bridge";

const DRAG_THRESHOLD_PX = 4;

/**
 * Project tab strip. Tabs live in a horizontally scrollable strip (wheel and
 * trackpad scroll it; the active tab is kept in view); the "+" and the
 * settings button are pinned outside the strip so they never get covered.
 * Tabs are reordered by dragging (pointer events, no HTML5 DnD: WebKit in the
 * webview drops the drag image and fires no dragover for same-window drags).
 */
export function ProjectTabs({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT();
  const { tabs, activeKey, activate, close, reorder } = useProjects();
  const openDialog = useOpenProjectDialog();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ key: string; from: number; to: number; dx: number } | null>(null);
  const press = useRef<{ key: string; index: number; x: number; y: number; moved: boolean } | null>(null);

  const doClose = async (key: string) => { dropBridge(key); await close(key); setConfirmClose(null); };
  const requestClose = (key: string) => {
    const tab = tabs.find((x) => x.key === key);
    if (tab?.running) setConfirmClose(key); else void doClose(key);
  };
  // The keyboard shortcut (App keymap) closes through the same path: a running turn always gets the confirm.
  useEffect(() => {
    const h = (e: Event) => { const k = (e as CustomEvent<string>).detail; if (typeof k === "string") requestClose(k); };
    document.addEventListener("fs:request-close-tab", h);
    return () => document.removeEventListener("fs:request-close-tab", h);
  });

  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  // Keep the active tab visible when it changes or a tab is added; track the scroll edges for the fades.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.ptab[aria-selected="true"]');
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateEdges();
  }, [activeKey, tabs.length]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Vertical wheel on the strip scrolls it horizontally (mice have no horizontal wheel).
  const onWheel = (e: React.WheelEvent) => {
    const el = stripRef.current;
    if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    el.scrollLeft += e.deltaY;
  };

  const indexAt = (clientX: number): number => {
    const el = stripRef.current;
    if (!el) return 0;
    const items = Array.from(el.querySelectorAll<HTMLElement>(".ptab"));
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return Math.max(0, items.length - 1);
  };

  const onPointerDown = (e: React.PointerEvent, key: string, index: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".ptab-x")) return;
    press.current = { key, index, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    const dx = e.clientX - p.x;
    if (!p.moved && Math.hypot(dx, e.clientY - p.y) < DRAG_THRESHOLD_PX) return;
    p.moved = true;
    const to = indexAt(e.clientX);
    setDrag({ key: p.key, from: p.index, to, dx });
    // Auto-scroll the strip when dragging near its edges.
    const el = stripRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left + 24) el.scrollLeft -= 8;
      else if (e.clientX > r.right - 24) el.scrollLeft += 8;
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.moved) {
      const to = indexAt(e.clientX);
      if (to !== p.index) reorder(p.index, to);
    } else {
      activate(p.key);
    }
    setDrag(null);
  };
  const onPointerCancel = () => { press.current = null; setDrag(null); };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div ref={stripRef} className={`project-tabs ${drag ? "dragging" : ""} ${edges.left ? "scroll-left" : ""} ${edges.right ? "scroll-right" : ""}`} role="tablist" aria-label={t("project.recent")} onWheel={onWheel} onScroll={updateEdges}>
        {tabs.map((tab, index) => {
          const isDragged = drag?.key === tab.key;
          const insertBefore = drag && !isDragged && drag.to === index && drag.to < drag.from;
          const insertAfter = drag && !isDragged && drag.to === index && drag.to > drag.from;
          return (
            <div key={tab.key} role="tab" aria-selected={activeKey === tab.key} tabIndex={0}
              className={`ptab ${activeKey === tab.key ? "active" : ""} ${isDragged ? "drag-source" : ""} ${insertBefore ? "insert-before" : ""} ${insertAfter ? "insert-after" : ""}`}
              style={isDragged ? { transform: `translateX(${drag!.dx}px)` } : undefined}
              onPointerDown={(e) => onPointerDown(e, tab.key, index)} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(tab.key); return; }
                // Roving focus along the strip: arrows move and activate, Home / End jump (WAI-ARIA tabs pattern).
                const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -index : e.key === "End" ? tabs.length - 1 - index : 0;
                if (!step) return;
                e.preventDefault();
                const next = tabs[(index + step + tabs.length) % tabs.length];
                if (!next) return;
                activate(next.key);
                (e.currentTarget.parentElement?.children[(index + step + tabs.length) % tabs.length] as HTMLElement | undefined)?.focus();
              }}
              onAuxClick={(e) => { if (e.button === 1) requestClose(tab.key); }} title={tab.info.root}>
              <Icon name="sheet" className="icon-sm" />
              <span className="truncate">{tab.info.name}</span>
              {tab.needsYou && <span className="tab-badge" title={t("tabs.needsYou")} aria-label={t("tabs.needsYou")} />}
              {!tab.needsYou && tab.running && <Icon name="loading" className="icon-sm spin muted" title={t("tabs.running")} />}
              <button type="button" className="ptab-x" aria-label={t("tabs.closeTab")} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); requestClose(tab.key); }}><Icon name="close" className="icon-sm" /></button>
            </div>
          );
        })}
      </div>
      <div className="titlebar-right">
        <IconButton icon="add" label={t("tabs.addProject")} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY + 8 })} />
        <IconButton icon="settings" label={t("settings.title")} onClick={onOpenSettings} />
      </div>
      <ContextMenu at={menu} onClose={() => setMenu(null)} items={[{ id: "open", label: t("project.open"), icon: "open" }, { id: "new", label: t("project.new"), icon: "newProject" }]}
        onSelect={(id) => { if (id === "open") void openDialog(); else setShowNew(true); }} />
      <NewProjectDialog open={showNew} onClose={() => setShowNew(false)} />
      <Dialog open={!!confirmClose} onClose={() => setConfirmClose(null)} title={t("project.closeConfirmTitle")} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setConfirmClose(null)}>{t("common.cancel")}</Button><Button variant="destructive" onClick={() => confirmClose && void doClose(confirmClose)}>{t("tabs.closeTab")}</Button></>}>
        <p>{t("project.closeConfirmRunning")}</p>
      </Dialog>
    </div>
  );
}
