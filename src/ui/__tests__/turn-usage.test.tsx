// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { TurnUsage } from "../chat/StreamView";
import { createBridge, reduceEvent, type BridgeState, type TurnBlock } from "../harness-bridge";
import { DEFAULT_SETTINGS, useSettings } from "../../state/settings";

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

function budgets(on: boolean): void {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, budget_enabled: on } }, loaded: true });
}

/** A finished two-role turn built the way the harness builds it. */
function block(): TurnBlock {
  let s = createBridge().getState() as BridgeState;
  const apply = (e: Parameters<typeof reduceEvent>[1]) => { s = { ...s, ...reduceEvent(s, e) }; };
  apply({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
  apply({ kind: "phase", turn: 1, role: "lead", phase: "exploring" });
  apply({ kind: "usage", turn: 1, role: "lead", input: 2000, cache_read: 8000, cache_creation: 0, output: 500, cost_usd: 0.4 });
  apply({ kind: "phase", turn: 1, role: "drafter", phase: "building" });
  apply({ kind: "usage", turn: 1, role: "drafter", input: 1000, cache_read: 0, cache_creation: 0, output: 500, cost_usd: 0.1 });
  return s.turns[0];
}

describe("turn usage footer", () => {
  it("shows total tokens, cost and cache share, then one line per role", () => {
    budgets(true);
    const host = mount(<TurnUsage block={block()} />);
    const spans = [...host.querySelectorAll("span")].map((e) => e.textContent ?? "");
    expect(spans[0]).toBe(" 12,000 tokens · $0.50 · cache 73%");
    expect(spans.some((s) => s.startsWith("Lead 10.5k tokens · $0.40 · cache 80%"))).toBe(true);
    expect(spans.some((s) => s.startsWith("Drafter 1.5k tokens · $0.10 · cache 0%"))).toBe(true);
  });

  it("hides the price when the budget display is off and keeps the tokens", () => {
    budgets(false);
    const host = mount(<TurnUsage block={block()} />);
    const text = host.textContent ?? "";
    expect(text).toContain("12,000 tokens");
    expect(text).toContain("cache 73%");
    expect(text).not.toContain("$");
    budgets(true);
  });

  it("falls back to the summary totals of a restored turn (no per-call usage, so no hit ratio)", () => {
    budgets(true);
    const restored = { ...block(), usageByRole: {}, tokens: 4321, cost_usd: 0.12 };
    const host = mount(<TurnUsage block={restored} />);
    expect(host.textContent).toContain("4,321 tokens · $0.12");
    expect(host.textContent).not.toContain("cache");
    const empty = mount(<TurnUsage block={{ ...restored, tokens: 0, cost_usd: 0 }} />);
    expect(empty.textContent).toBe("");
  });
});
