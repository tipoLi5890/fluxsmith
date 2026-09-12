// SPDX-License-Identifier: Apache-2.0
// Adopting a plan with Auto asks a second consent (docs/agent-runtime.md §1b). The dialog belongs to the
// stream, not to the card: the message stream is windowed and unmounts turn groups, so a card-owned dialog
// could vanish mid-decision.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

const invoke = vi.fn(async (cmd: string, _args: unknown) => (cmd === "consent_record" ? { id: "consent-7" } : null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invoke(c, a), Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));

import type { Card } from "../../agent/api";
import { CardView } from "../chat/CardView";
import { AutoConfirmProvider } from "../components/AutoPolicyDialog";

const PLAN_CARD: Card = {
  id: "pc1", kind: "plan_approval", turn: 1, title: "card.kind.plan_approval", body_md: "plan",
  actions: [{ id: "adopt_auto", label_key: "card.run_plan_auto", style: "secondary", consent: { grant_kind: "policy", payload_sha256: "sha" } }],
};

function Harness({ answers }: { answers: unknown[][] }) {
  const [mounted, setMounted] = useState(true);
  return (
    <AutoConfirmProvider>
      <button type="button" className="drop-card" onClick={() => setMounted(false)}>drop</button>
      {mounted && <CardView card={PLAN_CARD} projectKey="p1" onAnswer={async (...a) => { answers.push(a); }} />}
    </AutoConfirmProvider>
  );
}

const click = (el: Element | null) => { if (!el) throw new Error("missing element"); act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const arm = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 600)); }); };

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
  invoke.mockClear();
});

describe("Auto policy confirmation", () => {
  it("survives the card unmounting and only then records consent and answers", async () => {
    const answers: unknown[][] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<Harness answers={answers} />); });
    await arm();

    click(host.querySelector(".card-slot button.btn-consent"));
    const dialog = host.querySelector("[role=dialog]");
    expect(dialog).not.toBeNull();
    // Owned by the stream, not by the card.
    expect(host.querySelector(".card-slot [role=dialog]")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("consent_record", expect.anything());

    click(host.querySelector("button.drop-card"));
    expect(host.querySelector(".card-slot")).toBeNull();
    expect(host.querySelector("[role=dialog]")).not.toBeNull();

    await arm();
    click(host.querySelector("[role=dialog] .dialog-foot button.btn-consent"));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoke).toHaveBeenCalledWith("consent_record", expect.objectContaining({ event: expect.objectContaining({ card_kind: "plan_approval", payload_sha256: "sha" }) }));
    expect(answers[0]).toEqual(["pc1", "adopt_auto", undefined, "consent-7"]);
    expect(host.querySelector("[role=dialog]")).toBeNull();
  });

  it("keeps its own confirmation when no provider is mounted", async () => {
    const answers: unknown[][] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<CardView card={PLAN_CARD} projectKey="p1" onAnswer={async (...a) => { answers.push(a); }} />); });
    await arm();
    click(host.querySelector(".card-slot button.btn-consent"));
    expect(host.querySelector("[role=dialog]")).not.toBeNull();
    expect(answers).toHaveLength(0);
  });
});
