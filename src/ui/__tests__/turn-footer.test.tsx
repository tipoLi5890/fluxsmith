// SPDX-License-Identifier: Apache-2.0
// The turn footer says three separate things about a Build turn: what was drawn (parts, power
// ports, wires), what fluxsmith's own checks found, and what KiCad's ERC said — including that
// kicad-cli did not run, which must never be shown as a clean result.
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { TurnGroupView } from "../chat/StreamView";
import { createBridge, reduceEvent, type BridgeState, type TurnBlock } from "../harness-bridge";
import type { KicadTurnResult } from "../../agent/api";

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

function block(applied: { components_added: number; power_ports_added: number; wires_added: number }, kicad?: KicadTurnResult): TurnBlock {
  let s = createBridge().getState() as BridgeState;
  const apply = (e: Parameters<typeof reduceEvent>[1]) => { s = { ...s, ...reduceEvent(s, e) }; };
  apply({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "add the regulator", envelope: null });
  apply({ kind: "turn_ended", summary: { turn: 1, kind: "instruction", mode: "build", headline: "add the regulator", outcome: "done", applied: { ...applied, components_deleted: 0, sheets: ["root.kicad_sch"] }, ...(kicad ? { kicad } : {}), cost_usd: 0, tokens: 0, duration_ms: 10, checkpoint: 1 } });
  return s.turns[0];
}

function render(b: TurnBlock): string {
  const host = mount(<TurnGroupView block={b} cards={{}} projectKey="pk" density="compact" isCurrent={false} onAnswer={async () => undefined} onRollback={() => undefined} onContinue={() => undefined} onSaveRule={() => undefined} retrying={null} />);
  return host.textContent ?? "";
}

describe("turn footer", () => {
  it("counts power ports apart from components", () => {
    const text = render(block({ components_added: 4, power_ports_added: 4, wires_added: 2 }));
    expect(text).toContain("Components +4 / −0");
    expect(text).toContain("Power ports +4");
    expect(text).toContain("Wires +2");
  });

  it("leaves the power-port segment out when the turn placed none", () => {
    expect(render(block({ components_added: 2, power_ports_added: 0, wires_added: 0 }))).not.toContain("Power ports");
  });

  it("shows KiCad's ERC as its own segment", () => {
    expect(render(block({ components_added: 1, power_ports_added: 0, wires_added: 0 }, { available: true, errors: 2, warnings: 1 })))
      .toContain("KiCad ERC 2 errors · 1 warnings");
  });

  it("says kicad-cli was not available instead of implying a clean result", () => {
    const text = render(block({ components_added: 1, power_ports_added: 0, wires_added: 0 }, { available: false, errors: 0, warnings: 0, note: "KICAD_CLI_MISSING" }));
    expect(text).toContain("kicad-cli not available");
    expect(text).not.toContain("KiCad ERC 0 errors");
  });

  it("says nothing about KiCad when it was not asked (a turn that wrote nothing)", () => {
    const text = render(block({ components_added: 0, power_ports_added: 0, wires_added: 0 }));
    expect(text).not.toContain("KiCad ERC");
    expect(text).not.toContain("kicad-cli");
  });
});
