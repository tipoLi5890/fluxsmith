// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import { call, isTauri } from "../ipc/client";
import type { EnvReport, Mode, VersionInfo } from "../ipc/types";

interface EnvState {
  report: EnvReport | null;
  checking: boolean;
  version: VersionInfo | null;
  dismissedGate: boolean;
  check(force?: boolean): Promise<EnvReport | null>;
  setReport(r: EnvReport): void;
  dismissGate(): void;
  loadVersion(): Promise<void>;
}

/** KiCad major version as `kicad-cli version` reports it ("10.0.0" -> 10, nightly "10.99" -> 10); null when it cannot be read. */
export function kicadMajor(version: string | null | undefined): number | null {
  const m = /^\s*(\d+)/.exec(version ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Modes the environment or the project state refuses, mapped to the error code that says why
 * (UJ-0 / D-57). `incomplete` and `degraded` both stop Plan and Build and keep Review and Q&A;
 * a standalone sheet has nowhere to keep plans, approvals or checkpoints, so all three stop
 * while questions still work. Rust checks the same things again (`build_session_open`,
 * `sidecar_write`); this only keeps the UI honest.
 */
export function blockedModes(report: EnvReport | null, noPro = false): Partial<Record<Mode, string>> {
  if (noPro) return { plan: "PROJECT_NO_PRO", build: "PROJECT_NO_PRO", review: "PROJECT_NO_PRO" };
  if (!report || report.status === "ok") return {};
  return { plan: "ENV_SETUP_REQUIRED", build: "ENV_SETUP_REQUIRED" };
}

const DEV_REPORT: EnvReport = {
  status: "incomplete", kicad_app_path: null, kicad_cli_path: null, kicad_version: null, symbol_dir: null, symbol_lib_count: 0,
  sym_lib_table: null, keyring_available: false, problems: [{ code: "ENV_NO_BACKEND", message: "Running without the app backend", remediation: "Start with `pnpm app:dev`", fatal: false }],
  checked_at: new Date(0).toISOString(),
};

const GATE_KEY = "fluxsmith.envGateDismissed";
function readDismissed(): boolean { try { return localStorage.getItem(GATE_KEY) === "1"; } catch { return false; } }

export const useEnv = create<EnvState>((set) => ({
  report: null,
  checking: false,
  version: null,
  dismissedGate: readDismissed(),
  setReport(r) { set({ report: r }); },
  dismissGate() { set({ dismissedGate: true }); try { localStorage.setItem(GATE_KEY, "1"); } catch { /* private window / blocked storage */ } },
  async check(force) {
    set({ checking: true });
    try {
      const r = isTauri() ? await call("env_check", { force: !!force }) : DEV_REPORT;
      set({ report: r, checking: false });
      return r;
    } catch {
      set({ checking: false });
      return null;
    }
  },
  async loadVersion() {
    if (!isTauri()) return;
    try { set({ version: await call("version_info", {}) }); } catch { /* ignore */ }
  },
}));
