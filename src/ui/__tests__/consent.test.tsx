// SPDX-License-Identifier: Apache-2.0
// Card action → consent_record → answerCard; Build mode switch requires consent dialog.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (cmd: string, _args: unknown) => {
  if (cmd === "consent_record") return { id: "consent-42" };
  if (cmd === "db_query") return [];
  if (cmd === "engine_request") return { ok: true, data: { symbols: [], nets: [] }, meta: { bytes: 0, truncated: false, elapsed_ms: 0, trust: "engine" } };
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invoke(c, a), Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null, save: async () => null }));

import { CardView } from "../chat/CardView";
import { ChatPanel } from "../chat/ChatPanel";
import { createBridge, setHarnessFactory } from "../harness-bridge";
import type { HarnessApi, HarnessState } from "../../agent/api";
import type { ProjectTab } from "../../state/projects";

function mount(el: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, root };
}
const click = (el: Element | null) => { if (!el) throw new Error("missing element"); act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockClear();
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
});

describe("consent flows", () => {
  it("consent-bearing card action records a consent event before answering", async () => {
    const answers: unknown[] = [];
    const onAnswer = async (...a: unknown[]) => { answers.push(a); };
    const { host } = mount(<CardView projectKey="p1" onAnswer={onAnswer} card={{ id: "c1", kind: "hard_stop", turn: 1, title: "t", body_md: "b", actions: [{ id: "approve", label_key: "card.approve", style: "primary", consent: { grant_kind: "net_risk", payload_sha256: "sha" } }, { id: "abandon", label_key: "card.abandon", style: "secondary" }] }} />);
    const btn = host.querySelector<HTMLButtonElement>("button.btn-consent");
    expect(btn?.disabled).toBe(true); // arming (≥ 500 ms visible)
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(host.querySelector<HTMLButtonElement>("button.btn-consent")?.disabled).toBe(false);
    click(host.querySelector("button.btn-consent"));
    await flush();
    expect(invoke).toHaveBeenCalledWith("consent_record", expect.objectContaining({ event: expect.objectContaining({ card_kind: "hard_stop", payload_sha256: "sha", input_kind: "click" }) }));
    expect(answers[0]).toEqual(["c1", "approve", undefined, "consent-42"]);
    // non-consent action answers without a consent event
    invoke.mockClear();
    click(Array.from(host.querySelectorAll("button")).find((b) => !b.classList.contains("btn-consent")) ?? null);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("consent_record", expect.anything());
  });

  it("switching to Build shows a consent dialog and only then calls setMode with the consent id", async () => {
    const calls: string[] = [];
    let st: HarnessState = { project_key: null, session_id: "s", mode: "plan", policy: "review", running: false, current_turn: null, build_session: null, plan_ref: null, turns: [], cards: [], context: null };
    const h: HarnessApi = {
      async attach() { /* */ }, async detach() { /* */ }, state: () => st, subscribe: () => () => undefined,
      async setMode(m, cid) { calls.push(`${m}:${cid}`); st = { ...st, mode: m }; }, async setPolicy() { /* */ }, async send() { /* */ }, async stop() { /* */ },
      async answerCard() { /* */ }, async rollbackBefore() { /* */ }, async restorePreRollback() { /* */ }, async compact() { /* */ }, setSelection() { /* */ },
      async setLeadModel() { /* */ }, leadModel() { return null; }, async setThinkingLevel() { /* */ }, thinkingLevel() { return "medium" as const; }, replay() { return []; }, plan() { return null; }, async editPlan() { /* */ }, async requestFix() { /* */ }, async waiveFinding() { /* */ },
    };
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s");
    const tab: ProjectTab = { key: "p1", sheet: "/", needsYou: false, running: false, sessionId: "s", info: { key: "p1", root: "/tmp/p", root_sheet: "/tmp/p/p.kicad_sch", root_uuid: "u", name: "p", version: 20260306, sheets: [{ file: "p.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }], config: {}, git: null, last_turn: 0, last_mode: "plan", policy_override: null, locked: false } };
    const { host } = mount(<ChatPanel tab={tab} bridge={bridge} requestedMode={null} onModeConsumed={() => undefined} onSaveRule={() => undefined} />);
    await flush();
    const pickMode = (label: string) => {
      click(host.querySelector("button.composer-chip[aria-haspopup=menu]"));
      const item = Array.from(document.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")).find((b) => b.textContent?.includes(label));
      click(item ?? null);
    };
    pickMode("Build");
    await flush();
    expect(calls).toEqual([]); // no mode change yet
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog).not.toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    click(dialog!.querySelector("button.btn-consent"));
    await flush();
    expect(invoke).toHaveBeenCalledWith("consent_record", expect.objectContaining({ event: expect.objectContaining({ card_kind: "enter_build" }) }));
    expect(calls).toEqual(["build:consent-42"]);
    // Review needs no consent
    pickMode("Review");
    await flush();
    expect(calls).toEqual(["build:consent-42", "review:undefined"]);
  });
});
