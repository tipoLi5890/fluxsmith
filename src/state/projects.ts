// SPDX-License-Identifier: Apache-2.0
// Project tabs: one window, many projects (D-57). Each tab owns a harness bridge (src/ui/harness-bridge.ts).
import { create } from "zustand";
import { call, isTauri, IpcFailure } from "../ipc/client";
import { errorToastText, useToasts } from "./toasts";
import type { ProjectInfo, RecentProject, NewProjectSpec } from "../ipc/types";

export interface ProjectTab {
  key: string;
  info: ProjectInfo;
  /** Sheet instance path currently shown on the canvas. */
  sheet: string;
  needsYou: boolean;
  running: boolean;
  sessionId: string | null;
}

interface ProjectsState {
  tabs: ProjectTab[];
  activeKey: string | null;
  recent: RecentProject[];
  opening: boolean;
  error: string | null;
  /** The folder was seen at another path before: the human decides moved (keep history) or copied (new project). */
  identityPrompt: { path: string; old_path: string } | null;
  loadRecent(): Promise<void>;
  open(path: string, identity?: "moved" | "copied"): Promise<ProjectTab | null>;
  create(spec: NewProjectSpec): Promise<ProjectTab | null>;
  close(key: string): Promise<void>;
  activate(key: string): void;
  /** Move the tab at `from` to index `to` (drag-and-drop reorder); persisted. */
  reorder(from: number, to: number): void;
  setSheet(key: string, sheet: string): void;
  setFlags(key: string, flags: Partial<Pick<ProjectTab, "needsYou" | "running" | "sessionId">>): void;
  refresh(key: string): Promise<void>;
  forget(key: string): Promise<void>;
}

const TABS_KEY = "fs.openTabs";

export const useProjects = create<ProjectsState>((set, get) => ({
  tabs: [],
  activeKey: null,
  recent: [],
  opening: false,
  error: null,
  identityPrompt: null,
  async loadRecent() {
    if (!isTauri()) return;
    try { set({ recent: await call("project_list_recent", {}) }); } catch { /* ignore */ }
  },
  async open(path, identity) {
    set({ opening: true, error: null });
    try {
      const info = await call("project_open", identity ? { path, identity } : { path });
      set({ identityPrompt: null });
      const existing = get().tabs.find((t) => t.key === info.key);
      if (existing) { set({ activeKey: existing.key, opening: false }); return existing; }
      const tab: ProjectTab = { key: info.key, info, sheet: info.sheets[0]?.instance_path ?? "/", needsYou: false, running: false, sessionId: null };
      set((s) => ({ tabs: [...s.tabs, tab], activeKey: tab.key, opening: false }));
      persistTabs(get().tabs);
      void get().loadRecent();
      return tab;
    } catch (e) {
      if (e instanceof IpcFailure && e.error.code === "PROJECT_MOVED_OR_COPIED") {
        const ev = (e.error.evidence ?? {}) as { old_path?: string; old_exists?: boolean };
        // A refused "moved" (the original still exists) keeps the dialog open and says why.
        set({ opening: false, identityPrompt: { path, old_path: ev.old_path ?? "" }, error: identity ? errorToastText(e) : null });
        return null;
      }
      set({ opening: false, identityPrompt: null, error: errorToastText(e) });
      // The Welcome screen shows `error`; with tabs open nothing else would, so a toast carries it too.
      if (get().tabs.length) useToasts.getState().pushError(e);
      return null;
    }
  },
  async create(spec) {
    set({ opening: true, error: null });
    try {
      const info = await call("project_new", { spec });
      const tab: ProjectTab = { key: info.key, info, sheet: info.sheets[0]?.instance_path ?? "/", needsYou: false, running: false, sessionId: null };
      set((s) => ({ tabs: [...s.tabs, tab], activeKey: tab.key, opening: false }));
      persistTabs(get().tabs);
      void get().loadRecent();
      return tab;
    } catch (e) {
      set({ opening: false, error: errorToastText(e) });
      return null;
    }
  },
  reorder(from, to) {
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return {};
      const tabs = s.tabs.slice();
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      persistTabs(tabs);
      return { tabs };
    });
  },
  async close(key) {
    try { if (isTauri()) await call("project_close", { project_key: key }); } catch { /* ignore */ }
    set((s) => {
      const tabs = s.tabs.filter((t) => t.key !== key);
      const activeKey = s.activeKey === key ? (tabs[tabs.length - 1]?.key ?? null) : s.activeKey;
      persistTabs(tabs);
      return { tabs, activeKey };
    });
  },
  activate(key) { set({ activeKey: key }); },
  setSheet(key, sheet) { set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, sheet } : t)) })); },
  setFlags(key, flags) { set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, ...flags } : t)) })); },
  async refresh(key) {
    if (!isTauri()) return;
    try {
      const info = await call("project_info", { project_key: key });
      set((s) => ({ tabs: s.tabs.map((t) => (t.key === key ? { ...t, info } : t)) }));
    } catch { /* ignore */ }
  },
  async forget(key) {
    try { await call("db_query", { query: { kind: "project_forget", project_key: key } }); } catch { /* ignore */ }
    await get().loadRecent();
  },
}));

function persistTabs(tabs: ProjectTab[]) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs.map((t) => `${t.info.root}/${t.info.root_sheet}`))); } catch { /* ignore */ }
}
export function loadPersistedTabs(): string[] {
  try {
    const v = localStorage.getItem(TABS_KEY);
    const list = v ? (JSON.parse(v) as unknown) : [];
    // Older builds persisted the project-relative root sheet; those entries
    // cannot be reopened and are dropped instead of surfacing FILE_UNREADABLE.
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && (x.startsWith("/") || /^[A-Za-z]:[\\/]/.test(x))) : [];
  } catch { return []; }
}
