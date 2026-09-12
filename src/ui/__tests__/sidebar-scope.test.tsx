// SPDX-License-Identifier: Apache-2.0
// The components / nets lists across the whole project: one engine request for every sheet
// instance (not one per sheet), rows that name the sheet they came from, a click that hands the
// canvas the instance path so a reused sheet frames the right copy, and a plain-text note where
// one designator sits on two instances.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingRow, Ref } from "../../agent/api";

const engineCalls: { kind: string; sheet: unknown; all_sheets?: unknown }[] = [];
const READ_ALL = {
  all_sheets: true,
  symbols: [
    { reference: "R1", value: "10k", lib_id: "Device:R", sheet: "root.kicad_sch", instance_path: "/r" },
    { reference: "R2", value: "1k", lib_id: "Device:R", sheet: "amp.kicad_sch", instance_path: "/r/a1" },
    { reference: "R2", value: "1k", lib_id: "Device:R", sheet: "amp.kicad_sch", instance_path: "/r/a2" },
    { reference: "#PWR01", value: "GND", lib_id: "power:GND", sheet: "amp.kicad_sch", instance_path: "/r/a1" },
  ],
  total: { symbols: 4 },
  truncated: false,
};
const READ_SHEET = { symbols: [{ reference: "R1", value: "10k", lib_id: "Device:R" }], total: { symbols: 1 } };

vi.mock("../../ipc/client", () => ({
  isTauri: () => true,
  call: vi.fn(async (_name: string, args: { request: { kind: string; sheet?: unknown; all_sheets?: unknown } }) => {
    const r = args.request;
    engineCalls.push({ kind: r.kind, sheet: r.sheet, all_sheets: r.all_sheets });
    if (r.kind === "read") return { ok: true, data: r.all_sheets ? READ_ALL : READ_SHEET };
    if (r.kind === "nets") {
      return {
        ok: true,
        data: r.all_sheets === undefined && r.sheet === null
          ? { nets: [{ name: "VOUT", scope: "local", members: 2, sheets: ["/Right/"] }, { name: "GND", scope: "global", members: 6, sheets: ["/", "/Left/", "/Right/"] }], total: 2, truncated: false }
          : { nets: [{ name: "VIN", scope: "local", members: 2, sheets: ["/"] }], total: 1, truncated: false },
      };
    }
    return { ok: true, data: {} };
  }),
}));

import { Sidebar } from "../sidebar/Sidebar";
import { createBridge, setHarnessFactory } from "../harness-bridge";
import { usePrefs } from "../../state/prefs";

function tab() {
  return {
    key: "k", path: "/p/x.kicad_pro", sheet: "/r", sessionId: "s",
    info: {
      name: "x", root: "/p", root_uuid: "u", last_turn: 0,
      sheets: [
        { file: "root.kicad_sch", instance_path: "/r", names: [], paper: "A4", symbols: 1 },
        { file: "amp.kicad_sch", instance_path: "/r/a1", names: ["Left"], paper: "A4", symbols: 2 },
        { file: "amp.kicad_sch", instance_path: "/r/a2", names: ["Right"], paper: "A4", symbols: 2 },
      ],
    },
  } as unknown as import("../../state/projects").ProjectTab;
}

async function render(el: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  return container;
}
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}
function rows(container: HTMLElement, table: string): HTMLElement[] {
  const t = [...container.querySelectorAll("table")].find((x) => x.getAttribute("aria-label") === table);
  return t ? [...t.querySelectorAll<HTMLElement>("tbody tr")] : [];
}
async function showAll(container: HTMLElement): Promise<void> {
  const all = [...container.querySelectorAll<HTMLElement>("[role='tab']")].find((b) => b.textContent === "All sheets")!;
  await act(async () => { click(all); });
}

describe("components / nets across sheets", () => {
  beforeEach(() => { setHarnessFactory(null); usePrefs.setState({ sidebarTab: "components" }); engineCalls.length = 0; });

  it("defaults to this sheet and asks the engine once for the whole project when switched", async () => {
    const container = await render(<Sidebar tab={tab()} bridge={createBridge()} onFocus={() => undefined} />);
    expect(engineCalls).toEqual([{ kind: "read", sheet: "/r", all_sheets: false }, { kind: "nets", sheet: "/r", all_sheets: undefined }]);
    expect(rows(container, "Components").map((r) => r.getAttribute("data-ref"))).toEqual(["R1"]);
    engineCalls.length = 0;
    await showAll(container);
    // One read for every instance, not one request per sheet.
    expect(engineCalls).toEqual([{ kind: "read", sheet: null, all_sheets: true }, { kind: "nets", sheet: null, all_sheets: undefined }]);
    const comps = rows(container, "Components");
    expect(comps.map((r) => r.getAttribute("data-ref"))).toEqual(["R1", "R2", "R2"]); // power symbols stay out
    // Each row names the sheet file it was read from.
    expect(comps[0].textContent).toContain("root.kicad_sch");
    expect(comps[1].textContent).toContain("amp.kicad_sch");
  });

  it("marks a designator that sits on two instances, in plain text, and names the engine finding when there is one", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await showAll(container);
    const comps = rows(container, "Components");
    expect(comps[0].textContent).not.toContain("also on");
    expect(comps[1].textContent).toContain("also on Right");
    expect(comps[2].textContent).toContain("also on Left");
    // With the engine's own finding open, the row names the code instead of asserting anything itself.
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [{ code: "DUPLICATE_DESIGNATOR_PROJECT", severity: "Error", message: "R2 unit 1 appears 2 times", refs: ["R2"], origin: "engine", turn: 1, resolved: false }] as FindingRow[] })); });
    expect(rows(container, "Components")[1].textContent).toContain("DUPLICATE_DESIGNATOR_PROJECT");
    expect(rows(container, "Components")[1].textContent).toContain("also on Right");
  });

  it("hands the canvas the instance path of the row, so the panel switches sheets before framing", async () => {
    const focused: Ref[][] = [];
    const container = await render(<Sidebar tab={tab()} bridge={createBridge()} onFocus={(r) => focused.push(r)} />);
    await showAll(container);
    const comps = rows(container, "Components");
    await act(async () => { click(comps[2]); });
    expect(focused.pop()).toEqual([{ kind: "component", ref: "R2", sheet: "/r/a2" }]);
    await act(async () => { click(comps[0]); });
    expect(focused.pop()).toEqual([{ kind: "component", ref: "R1", sheet: "/r" }]);
    // A net with no member on this sheet switches to the first sheet it reaches; one that is here stays.
    const nets = rows(container, "Nets");
    expect(nets.map((r) => r.getAttribute("data-net"))).toEqual(["VOUT", "GND"]);
    expect(nets[0].textContent).toContain("Right");
    await act(async () => { click(nets[0]); });
    expect(focused.pop()).toEqual([{ kind: "net", name: "VOUT", sheet: "/r/a2" }]);
    await act(async () => { click(nets[1]); });
    expect(focused.pop()).toEqual([{ kind: "net", name: "GND" }]);
  });
});
