// SPDX-License-Identifier: Apache-2.0
// UJ-0 / D-57: what the environment and a project without a `.kicad_pro` disable in the chat panel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const invoke = vi.fn(async (cmd: string, _args: unknown) => {
  if (cmd === "consent_record") return { id: "consent-7" };
  if (cmd === "project_shell_create") return null;
  if (cmd === "db_query") return [];
  if (cmd === "engine_request") return { ok: true, data: { symbols: [], nets: [] }, meta: { bytes: 0, truncated: false, elapsed_ms: 0, trust: "engine" } };
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invoke(c, a), Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null, save: async () => null }));

import { errorCopy } from "../../i18n";
import { ChatPanel } from "../chat/ChatPanel";
import { createBridge, setHarnessFactory } from "../harness-bridge";
import type { HarnessApi, HarnessState } from "../../agent/api";
import { blockedModes, kicadMajor, useEnv } from "../../state/env";
import type { EnvReport, ProjectInfo } from "../../ipc/types";
import type { ProjectTab } from "../../state/projects";

const REPORT: EnvReport = {
  status: "ok", kicad_app_path: "/Applications/KiCad/KiCad.app", kicad_cli_path: "/x/kicad-cli", kicad_version: "10.0.0",
  symbol_dir: "/x/symbols", symbol_lib_count: 200, sym_lib_table: "/x/sym-lib-table", keyring_available: true, problems: [],
  checked_at: new Date(0).toISOString(),
};

function info(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    key: "p1", root: "/tmp/p", root_sheet: "p.kicad_sch", root_uuid: "u", name: "p", version: 20260306,
    sheets: [{ file: "p.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }],
    config: {}, git: null, last_turn: 0, last_mode: "plan", policy_override: null, locked: false, ...over,
  };
}

function harness(mode: "plan" | "build" | "review" = "plan"): HarnessApi {
  let st: HarnessState = { project_key: null, session_id: "s", mode, policy: "review", running: false, current_turn: null, build_session: null, plan_ref: null, turns: [], cards: [], context: null };
  return {
    async attach() { /* */ }, async detach() { /* */ }, state: () => st, subscribe: () => () => undefined,
    async setMode(m) { st = { ...st, mode: m }; }, async setPolicy() { /* */ }, async send() { /* */ }, async stop() { /* */ },
    async answerCard() { /* */ }, async rollbackBefore() { /* */ }, async restorePreRollback() { /* */ }, async compact() { /* */ }, setSelection() { /* */ },
    async setLeadModel() { /* */ }, leadModel() { return null; }, async setThinkingLevel() { /* */ }, thinkingLevel() { return "medium" as const; },
    replay() { return []; }, plan() { return null; }, async editPlan() { /* */ }, async requestFix() { /* */ }, async waiveFinding() { /* */ },
  };
}

async function mountPanel(tabInfo: ProjectInfo, mode: "plan" | "build" | "review" = "plan") {
  setHarnessFactory(() => harness(mode));
  const bridge = createBridge();
  await bridge.getState().attach("p1", "s");
  const tab: ProjectTab = { key: "p1", sheet: "/", needsYou: false, running: false, sessionId: "s", info: tabInfo };
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => createRoot(host).render(<ChatPanel tab={tab} bridge={bridge} requestedMode={null} onModeConsumed={() => undefined} onSaveRule={() => undefined} />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return host;
}

const click = (el: Element | null) => { if (!el) throw new Error("missing element"); act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockClear();
  document.body.innerHTML = "";
  useEnv.setState({ report: REPORT });
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
});

describe("environment gating", () => {
  it("reads the KiCad major version numerically", () => {
    expect(kicadMajor("10.0.0")).toBe(10);
    expect(kicadMajor("9.0.1")).toBe(9);
    expect(kicadMajor("10.99.0-rc1")).toBe(10);
    expect(kicadMajor("Application: kicad-cli")).toBeNull();
    expect(kicadMajor(null)).toBeNull();
  });

  it("blocks Plan and Build while the environment is incomplete or degraded, and all three without a project", () => {
    expect(blockedModes(REPORT)).toEqual({});
    expect(blockedModes({ ...REPORT, status: "degraded" })).toEqual({ plan: "ENV_SETUP_REQUIRED", build: "ENV_SETUP_REQUIRED" });
    expect(blockedModes({ ...REPORT, status: "incomplete" })).toEqual({ plan: "ENV_SETUP_REQUIRED", build: "ENV_SETUP_REQUIRED" });
    expect(blockedModes(REPORT, true)).toEqual({ plan: "PROJECT_NO_PRO", build: "PROJECT_NO_PRO", review: "PROJECT_NO_PRO" });
  });

  it("disables the Plan and Build menu entries and refuses a design request inline, keeping the message", async () => {
    useEnv.setState({ report: { ...REPORT, status: "incomplete", kicad_version: null, problems: [{ code: "KICAD_NOT_FOUND", message: "m", remediation: "r", fatal: true }] } });
    const host = await mountPanel(info(), "plan");
    click(host.querySelector("button.composer-chip[aria-haspopup=menu]"));
    const entry = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")).find((b) => b.textContent?.includes(label));
    expect(entry("Build")?.disabled).toBe(true);
    expect(entry("Review")?.disabled).toBe(false); // Review and Q&A stay available
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); }); // close the menu, stay in Plan

    const ta = host.querySelector("textarea");
    if (!ta) throw new Error("no composer");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => { setValue?.call(ta, "add a 10k pull-up"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Send") ?? null);
    await flush();
    expect(host.textContent).toContain(errorCopy("ENV_SETUP_REQUIRED")?.title);
    expect(ta.value).toBe("add a 10k pull-up"); // the message stays in the composer
  });
});

describe("standalone schematic (D-57)", () => {
  it("shows the read-only reason, disables every mode and creates the project shell with a consent event", async () => {
    const host = await mountPanel(info({ no_pro: true }), "review");
    expect(host.textContent).toContain(errorCopy("PROJECT_NO_PRO")?.title);
    click(host.querySelector("button.composer-chip[aria-haspopup=menu]"));
    const entries = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]"));
    const modeEntry = (en: string) => entries.find((b) => b.textContent?.includes(`\u00b7 ${en}`));
    // Review is the current mode (never disabled); the two it could switch to are refused.
    expect(modeEntry("Plan")?.disabled).toBe(true);
    expect(modeEntry("Build")?.disabled).toBe(true);
    expect(modeEntry("Review")?.disabled).toBe(false);
    click(modeEntry("Plan") ?? null);
    await flush();

    click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Create project shell")) ?? null);
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog).not.toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); }); // consent buttons arm after 500 ms
    click(dialog?.querySelector("button.btn-consent") ?? null);
    await flush();
    expect(invoke).toHaveBeenCalledWith("consent_record", expect.objectContaining({ event: expect.objectContaining({ card_kind: "project_shell_create" }) }));
    expect(invoke).toHaveBeenCalledWith("project_shell_create", { sheet: "/tmp/p/p.kicad_sch", consent_event_id: "consent-7" });
  });
});
