// SPDX-License-Identifier: Apache-2.0
// What `@` can reach and what the canvas selection adds to the next message. `@` is the only way to
// point at something that is not on screen, so it asks the engine for the whole project (components
// and nets on every sheet instance) and offers the sheets and the open findings as well; every ref
// carries the sheet instance it lives on so the canvas can switch before framing it. The selection
// pill states what rides along with the next message and can be dismissed for that one message.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingRow, Ref, UserMessage } from "../../agent/api";

const engineCalls: { kind: string; sheet: unknown; all_sheets?: unknown }[] = [];
vi.mock("../../ipc/client", () => ({
  isTauri: () => true,
  call: vi.fn(async (_name: string, args: { request: { kind: string; sheet?: unknown; all_sheets?: unknown } }) => {
    const r = args.request;
    engineCalls.push({ kind: r.kind, sheet: r.sheet, all_sheets: r.all_sheets });
    if (r.kind === "read") {
      return { ok: true, data: { all_sheets: true, symbols: [
        { reference: "R1", value: "10k", lib_id: "Device:R", sheet: "root.kicad_sch", instance_path: "/r" },
        { reference: "R7", value: "1k", lib_id: "Device:R", sheet: "amp.kicad_sch", instance_path: "/r/a2" },
        { reference: "#PWR01", value: "GND", lib_id: "power:GND", sheet: "root.kicad_sch", instance_path: "/r" },
      ] } };
    }
    if (r.kind === "nets") return { ok: true, data: { nets: [{ name: "VOUT", scope: "local", members: 2, sheets: ["/Right/"] }] } };
    return { ok: true, data: {} };
  }),
}));

import { Composer, type ComposerMenuProps } from "../chat/Composer";
import type { SheetInfo } from "../../ipc/types";

const SHEETS: SheetInfo[] = [
  { file: "root.kicad_sch", instance_path: "/r", names: [], paper: "A4", symbols: 2 },
  { file: "amp.kicad_sch", instance_path: "/r/a2", names: ["Right"], paper: "A4", symbols: 1 },
];
const FINDINGS: FindingRow[] = [
  { code: "ERC_PIN_NOT_DRIVEN", severity: "Error", message: "U1.3 is not driven", refs: ["U1.3"], origin: "engine", turn: 1, resolved: false, sheet: "/r/a2" },
  { code: "ERC_OLD", severity: "Error", message: "gone", refs: ["U2.1"], origin: "engine", turn: 1, resolved: true },
];
const MENUS: ComposerMenuProps = {
  mode: "plan", policy: "review", density: "compact", hasPendingCard: false, shortcuts: {},
  onMode: () => undefined, onPolicy: () => undefined, onDensity: () => undefined, onSearch: () => undefined, onJump: () => undefined,
  providers: [], leadModel: null, onPickModel: async () => undefined, onOpenModelSettings: () => undefined,
};

function props(over: Partial<React.ComponentProps<typeof Composer>> = {}): React.ComponentProps<typeof Composer> {
  return {
    projectKey: "k", sheet: "/r", sheets: SHEETS, sessionId: "s", running: false, context: null,
    onSend: async () => undefined, onStop: async () => undefined, onCompact: async () => undefined,
    turns: [], attachments: [], findings: FINDINGS, selection: [], sendCombo: "Mod+Enter", attachCombo: "Mod+Shift+A",
    menus: MENUS, ...over,
  };
}

async function render(el: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(el); });
  return container;
}

/** Type into the composer the way a human does, so React sees the change and opens the `@` panel. */
async function type(container: HTMLElement, text: string): Promise<void> {
  const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, text);
    ta.selectionStart = text.length;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function menuGroups(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".mention-group")].map((g) => g.textContent ?? "");
}
function options(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[role='option']")].map((o) => o.textContent ?? "");
}

describe("composer @ references", () => {
  beforeEach(() => { engineCalls.length = 0; });

  it("asks the engine for the whole project and offers sheets and open findings", async () => {
    const container = await render(<Composer {...props()} />);
    await type(container, "@");
    expect(engineCalls).toEqual([
      { kind: "read", sheet: null, all_sheets: true },
      { kind: "nets", sheet: null, all_sheets: undefined },
    ]);
    expect(menuGroups(container)).toEqual(["Components", "Nets", "Sheets", "Findings"]);
    const opts = options(container);
    // Components come from every sheet instance and name the one they sit on; power symbols stay out.
    expect(opts).toContain("R1 10k · root.kicad_sch");
    expect(opts).toContain("R7 1k · Right");
    expect(opts.some((o) => o.includes("#PWR01"))).toBe(false);
    expect(opts).toContain("Right · amp.kicad_sch");
    // Only the open finding is offered.
    expect(opts).toContain("ERC_PIN_NOT_DRIVEN U1.3");
    expect(opts.some((o) => o.includes("ERC_OLD"))).toBe(false);
  });

  it("picks a ref that carries its sheet instance, so the canvas can switch to it", async () => {
    const sent: UserMessage[] = [];
    const container = await render(<Composer {...props({ onSend: async (m) => { sent.push(m); } })} />);
    await type(container, "@R7");
    const pick = [...container.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent?.startsWith("R7"))!;
    await act(async () => { pick.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    const send = [...container.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Send")!;
    await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(sent[0].refs).toEqual([{ kind: "component", ref: "R7", sheet: "/r/a2" }]);
    // A net with no member on this sheet is framed where it lives.
    await type(container, "@VOUT");
    const net = [...container.querySelectorAll<HTMLElement>("[role='option']")].find((o) => o.textContent === "VOUT")!;
    await act(async () => { net.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    await act(async () => { send.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(sent[1].refs).toEqual([{ kind: "net", name: "VOUT", sheet: "/r/a2" }]);
  });
});

describe("canvas selection pill", () => {
  const selection: Ref[] = [{ kind: "component", ref: "U1" }, { kind: "component", ref: "C3" }];

  it("says what the canvas selection adds to the next message and can be dismissed", async () => {
    let skipped = 0;
    const container = await render(<Composer {...props({ selection, onSkipSelection: () => { skipped += 1; } })} />);
    const pill = container.querySelector(".selection-pill")!;
    expect(pill.textContent).toContain("Current selection attached");
    expect(pill.textContent).toContain("U1, C3");
    const dismiss = pill.querySelector<HTMLElement>("button")!;
    await act(async () => { dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(skipped).toBe(1);
  });

  it("shows nothing when the selection is empty (the setting is off, or it was dismissed)", async () => {
    const container = await render(<Composer {...props({ selection: [] })} />);
    expect(container.querySelector(".selection-pill")).toBeNull();
  });
});
