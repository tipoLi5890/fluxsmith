// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import { call, isTauri } from "../ipc/client";
import type { Settings } from "../ipc/types";
import { setLang } from "../i18n";
import { RATES_UPDATED, applyBuiltinRates } from "../agent/models/rates";

export const DEFAULT_SETTINGS: Settings = {
  schema_version: 2,
  language: "auto",
  theme: "system",
  restore_tabs_on_launch: true,
  notifications: true,
  shortcuts: {},
  kicad: { app_path: null, cli_path: null, symbol_dir_override: null, target_version: 10 },
  providers: [],
  models_by_role: {},
  rates_as_of: null,
  disclosed_version: null,
  agent: {
    default_policy: "review",
    continuous_run: true,
    session_ceiling_components_added: 24,
    budget_defaults: { plan_tokens: null, plan_usd: 5, plan_tool_calls: 400, plan_wall_min: 60, turn_tool_calls: 200, turn_wall_min: 15, warn_pct: 80 },
    canvas_follow: true,
    canvas_grid: false,
    canvas_changes: true,
    canvas_drag_selects: false,
    chat_attach_selection: true,
    intake_defaults: { lib: "keep", pdf: "keep", sch: "reference", bom: "keep", image: "attach", project_zip: "ask" },
    chat_density: "compact",
  thinking_level: "medium",
  budget_enabled: true,
  },
  context: { hint_pct: 60, auto_pct: 80, emergency_pct: 92, keep_recent_tasks: 2, reserve_output_tokens: 8000 },
  storage: { checkpoint_turns: 50, checkpoint_mb: 500, external_cache_mb: 2048, datasheets_copy_to_project_default: false },
  privacy: { log_level: "info" },
  parts: { enabled: false, lib_nickname: "jlc", with_3d: true },
  advanced: { step_throttle: false, images_size: "standard", tool_parallel_max: 4, drafter_concurrency: 3, provider_conn_max: 6, sandbox_enabled: true, router_path: null, release_dir: null },
};

export function applyTheme(theme: Settings["theme"]): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
    const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", dark ? "dark" : "light");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  error: string | null;
  load(): Promise<void>;
  update(patch: Partial<Settings>): Promise<void>;
  /** Copy built-in rates into providers still at 0/0/0/0 and stamp `rates_as_of`; returns how many providers changed. */
  applyBuiltinRates(): Promise<number>;
  reset(keys: string[]): Promise<void>;
  applyLocal(s: Settings): void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: null,
  applyLocal(s) {
    set({ settings: s, loaded: true });
    applyTheme(s.theme);
    setLang(s.language);
  },
  async load() {
    if (!isTauri()) { get().applyLocal(DEFAULT_SETTINGS); return; }
    try {
      const s = await call("settings_get", {});
      get().applyLocal({ ...DEFAULT_SETTINGS, ...s });
    } catch (e) {
      set({ error: String(e), loaded: true });
      get().applyLocal(DEFAULT_SETTINGS);
    }
  },
  async update(patch) {
    const merged = deepMerge(get().settings, patch) as Settings;
    get().applyLocal(merged);
    if (isTauri()) {
      const s = await call("settings_set", { patch });
      get().applyLocal({ ...DEFAULT_SETTINGS, ...s });
    }
  },
  async applyBuiltinRates() {
    const cur = get().settings;
    const { providers, changed } = applyBuiltinRates(cur.providers, (p) => {
      const lead = Object.values(cur.models_by_role).find((m) => m?.startsWith(`${p.id}/`));
      return lead ? lead.slice(p.id.length + 1) : undefined;
    });
    await get().update({ providers, rates_as_of: RATES_UPDATED });
    return changed;
  },
  async reset(keys) {
    if (isTauri()) {
      const s = await call("settings_reset", { keys });
      get().applyLocal({ ...DEFAULT_SETTINGS, ...s });
    } else {
      get().applyLocal(DEFAULT_SETTINGS);
    }
  },
}));

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
export function deepMerge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b;
  const out: Record<string, unknown> = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

if (typeof matchMedia === "function") {
  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (useSettings.getState().settings.theme === "system") applyTheme("system");
    });
  } catch { /* jsdom */ }
}
