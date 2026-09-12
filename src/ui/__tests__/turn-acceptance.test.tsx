// SPDX-License-Identifier: Apache-2.0
// A plan gate step reports two things the human must not have to dig for: the turn ended with
// engine Errors still open (`done_with_findings`, not a bare "done"), and how the plan's own typed
// acceptance stood. Both are the engine's words; the UI only lays them out.
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { TurnGroupView } from "../chat/StreamView";
import { CardView } from "../chat/CardView";
import { summaryCard } from "../../agent/cards";
import { createBridge, reduceEvent, type BridgeState, type TurnBlock } from "../harness-bridge";
import type { AcceptanceResult, TurnSummary } from "../../agent/api";

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

const ACCEPTANCE: AcceptanceResult[] = [
  { block: "ldo", type: "net_has_pins", status: "pass", label: "net_has_pins +3V3 >= 2", detail: "3" },
  { block: "ldo", type: "check_clean", status: "fail", label: "check_clean FOOTPRINT_MISSING", detail: "FOOTPRINT_MISSING x2" },
  { block: "ldo", type: "text", status: "na", label: "text keep the loop area small", na_reason: "informational" },
];

function summary(over: Partial<TurnSummary> = {}): TurnSummary {
  return {
    turn: 4, kind: "instruction", mode: "build", headline: "gate", outcome: "done_with_findings",
    applied: { components_added: 0, components_deleted: 0, wires_added: 0, sheets: [] },
    acceptance: ACCEPTANCE, cost_usd: 0, tokens: 0, duration_ms: 10, checkpoint: 4, ...over,
  };
}

function block(s: TurnSummary): TurnBlock {
  let st = createBridge().getState() as BridgeState;
  const apply = (e: Parameters<typeof reduceEvent>[1]) => { st = { ...st, ...reduceEvent(st, e) }; };
  apply({ kind: "turn_started", turn: s.turn, turn_kind: "instruction", mode: "build", headline: s.headline, envelope: null });
  apply({ kind: "turn_ended", summary: s });
  return st.turns[0];
}

function render(b: TurnBlock): HTMLElement {
  return mount(<TurnGroupView block={b} cards={{}} projectKey="pk" density="compact" isCurrent={false} onAnswer={async () => undefined} onRollback={() => undefined} onContinue={() => undefined} onSaveRule={() => undefined} retrying={null} />);
}

describe("turn footer: gate findings and plan acceptance", () => {
  it("a turn that left engine Errors open is badged apart from a clean done", () => {
    expect(render(block(summary())).textContent ?? "").toContain("done, findings open");
    const clean = render(block(summary({ outcome: "done", acceptance: undefined }))).textContent ?? "";
    expect(clean).toContain("done");
    expect(clean).not.toContain("done, findings open");
  });

  it("counts the acceptance items and names the ones that did not hold", () => {
    const text = render(block(summary())).textContent ?? "";
    expect(text).toContain("Acceptance 1 passed · 1 failed · 1 n/a");
    expect(text).toContain("Acceptance not met");
    expect(text).toContain("ldo · check_clean FOOTPRINT_MISSING · FOOTPRINT_MISSING x2");
    // A passing item is counted, not listed: the footer names only what needs attention.
    expect(text).not.toContain("net_has_pins +3V3 >= 2");
  });

  it("says nothing about acceptance when the turn reported none", () => {
    const text = render(block(summary({ acceptance: undefined }))).textContent ?? "";
    expect(text).not.toContain("Acceptance");
  });

  it("the turn summary card lists every item with its status and the engine's evidence", () => {
    const card = summaryCard(4, summary(), [], false);
    const text = mount(<CardView projectKey="pk" card={card} onAnswer={async () => undefined} />).textContent ?? "";
    expect(text).toContain("Plan acceptance");
    expect(text).toContain("net_has_pins +3V3 >= 2");
    expect(text).toContain("check_clean FOOTPRINT_MISSING");
    expect(text).toContain("FOOTPRINT_MISSING x2");
    expect(text).toContain("a note, not a check");
  });

  // Run 19 shape: what the engine measured is the whole point of a failed row — "583mil" is why the
  // decoupling item did not hold. It has to reach both surfaces, never just the assertion.
  it("a failed row carries the engine's measurement into the footer and the summary card", () => {
    const measured: AcceptanceResult[] = [
      { block: "power", type: "decoupling_near", status: "fail", label: "decoupling_near U.3 <= 500mil", detail: "C1 10uF 583mil" },
      { block: "power", type: "net_has_pins", status: "fail", label: "net_has_pins +3V3 >= 5", detail: "4: C2.1, C3.1, R1.1, U1.2" },
    ];
    const footer = render(block(summary({ acceptance: measured }))).textContent ?? "";
    expect(footer).toContain("power · decoupling_near U.3 <= 500mil · C1 10uF 583mil");
    expect(footer).toContain("power · net_has_pins +3V3 >= 5 · 4: C2.1, C3.1, R1.1, U1.2");
    const card = summaryCard(4, summary({ acceptance: measured }), [], false);
    const text = mount(<CardView projectKey="pk" card={card} onAnswer={async () => undefined} />).textContent ?? "";
    expect(text).toContain("C1 10uF 583mil");
    expect(text).toContain("4: C2.1, C3.1, R1.1, U1.2");
  });

  it("labels the rows the harness restated from the plan's own declarations and keeps them out of the tally", () => {
    const derived: AcceptanceResult[] = [
      { block: "led", type: "component_count", status: "advisory", outcome: "pass", label: "component_count D >= 1", detail: "1", derived: true },
      ...ACCEPTANCE,
    ];
    const card = summaryCard(4, summary({ acceptance: derived }), [], false);
    const text = mount(<CardView projectKey="pk" card={card} onAnswer={async () => undefined} />).textContent ?? "";
    expect(text).toContain("component_count D >= 1 · from the plan's own parts and nets");
    // A row the Architect wrote carries no such label.
    expect(text).toContain("net_has_pins +3V3 >= 2 · 3");
    // The counts are unchanged by it: a harness-restated row is reported apart, it never passes or fails.
    expect(text).toContain("Acceptance 1 passed · 1 failed · 1 n/a · 1 advisory");
    const footer = render(block(summary({ acceptance: derived }))).textContent ?? "";
    expect(footer).toContain("Acceptance 1 passed · 1 failed · 1 n/a · 1 advisory");
    expect(footer).not.toContain("component_count D >= 1");
  });
});
