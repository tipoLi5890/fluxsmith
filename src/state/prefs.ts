// SPDX-License-Identifier: Apache-2.0
// Per-machine UI preferences (localStorage): dismissed one-time tips, sidebar tab, split sizes.
import { create } from "zustand";
import { normalizeFindingFilter, type FindingFilter } from "../ui/finding-filter";

interface Prefs {
  dismissedTips: Record<string, boolean>;
  sidebarTab: string;
  settingsTab: string;
  /** Last opened conversation per project key (restored on reopen). */
  lastSession: Record<string, string>;
  /** Findings panel filter per project key (severity toggles, origin, sheet). */
  findingFilter: Record<string, FindingFilter>;
  dismissTip(id: string): void;
  setLastSession(projectKey: string, sessionId: string | null): void;
  setSidebarTab(id: string): void;
  setSettingsTab(id: string): void;
  setFindingFilter(projectKey: string, filter: FindingFilter): void;
}

const KEY = "fs.prefs";
function load(): Partial<Prefs> {
  try { const v = localStorage.getItem(KEY); return v ? (JSON.parse(v) as Partial<Prefs>) : {}; } catch { return {}; }
}
function save(p: Pick<Prefs, "dismissedTips" | "sidebarTab" | "settingsTab" | "lastSession" | "findingFilter">) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export const usePrefs = create<Prefs>((set, get) => {
  const init = load();
  const persist = () => { const { dismissedTips, sidebarTab, settingsTab, lastSession, findingFilter } = get(); save({ dismissedTips, sidebarTab, settingsTab, lastSession, findingFilter }); };
  return {
    dismissedTips: init.dismissedTips ?? {},
    sidebarTab: init.sidebarTab ?? "sheets",
    settingsTab: init.settingsTab ?? "general",
    lastSession: init.lastSession ?? {},
    // Read back defensively: a stored filter from another version must not hide every row.
    findingFilter: Object.fromEntries(Object.entries(init.findingFilter ?? {}).map(([k, v]) => [k, normalizeFindingFilter(v)])),
    setLastSession(projectKey, sessionId) {
      set((s) => { const next = { ...s.lastSession }; if (sessionId) next[projectKey] = sessionId; else delete next[projectKey]; return { lastSession: next }; });
      persist();
    },
    dismissTip(id) { set((s) => ({ dismissedTips: { ...s.dismissedTips, [id]: true } })); persist(); },
    setSidebarTab(id) { set({ sidebarTab: id }); persist(); },
    setSettingsTab(id) { set({ settingsTab: id }); persist(); },
    setFindingFilter(projectKey, filter) { set((s) => ({ findingFilter: { ...s.findingFilter, [projectKey]: filter } })); persist(); },
  };
});
