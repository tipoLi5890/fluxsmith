// SPDX-License-Identifier: Apache-2.0
// The plan card is where a KiCad engineer signs off the plan, so it has to show what the JSON says:
// which sheet each block goes on, the package of every part, and the acceptance the gate will measure
// the block by (real runs 17 and 18 showed none of it). The rows are a restatement of the plan, never
// a verdict of the card's own (red line 6).
import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { PlanAuthority } from "../chat/CardView";
import { setLang } from "../../i18n";

const PLAN = {
  plan: {
    sheets: [{ file: "ldo_board.kicad_sch" }, { file: "power.kicad_sch", create: true }],
    envelope: { budgets: { components_added: 8, components_deleted: 0, wires_added: 24 }, structural: ["create_sheet:power.kicad_sch"], nets: { rails: ["VBUS", "+3V3", "GND"], renamable: [] } },
    blocks: [
      {
        id: "ldo", sheet: "power.kicad_sch", summary: "3.3 V linear regulator",
        parts: [
          { ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3", value: "AMS1117-3.3", footprint: "Package_TO_SOT_SMD:SOT-223-3_TabPin2" },
          { ref_prefix: "C", lib_id: "Device:C", value: "10uF", footprint: "Capacitor_SMD:C_0603_1608Metric" },
        ],
        acceptance: [
          { type: "pin_on_net", ref_prefix: "U", pin: "3", net: "+3V3" },
          { type: "component_count", prefix: "C", min: 2, derived: true },
          { type: "text", text: "The 10 uF capacitor sits within 300 mil of the input." },
        ],
      },
    ],
  },
};

function render(data: unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(<PlanAuthority data={data} />); });
  return host;
}

beforeEach(() => { setLang("en"); });

describe("plan card authority summary", () => {
  it("lists every acceptance row of a block under it, marking derived and informational rows", () => {
    const host = render(PLAN);
    const rows = [...host.querySelectorAll(".plan-authority-acceptance li")].map((li) => li.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe("pin_on_net U.3 = +3V3");
    // A row the harness restated from the plan's own parts and nets says so.
    expect(rows[1]).toContain("component_count C >= 2");
    expect(rows[1]).toContain("from the plan's own parts and nets");
    // A prose row is a note: the gate can neither pass nor fail it.
    expect(rows[2]).toContain("The 10 uF capacitor sits within 300 mil of the input.");
    expect(rows[2]).toContain("a note, not a check");
    expect(host.querySelector(".plan-authority-acceptance summary")?.textContent).toBe("Acceptance (3)");
  });

  it("names the sheet and the package of every part", () => {
    const host = render(PLAN);
    const block = host.querySelector(".plan-authority-blocks > li")?.textContent ?? "";
    expect(block).toContain("power.kicad_sch");
    expect(block).toContain("U AMS1117-3.3 Regulator_Linear:AMS1117-3.3 SOT-223");
    expect(block).toContain("C 10uF Device:C 0603");
  });

  it("shows no acceptance section for a block that declared none", () => {
    const bare = { plan: { ...PLAN.plan, blocks: [{ ...PLAN.plan.blocks[0], acceptance: [] }] } };
    expect(render(bare).querySelector(".plan-authority-acceptance")).toBeNull();
  });
});
