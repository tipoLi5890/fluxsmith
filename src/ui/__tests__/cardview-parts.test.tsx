// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Card } from "../../agent/api";
import { partsDecisionCard } from "../../agent/tools/parts-decision";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { CardView } from "../chat/CardView";

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

describe("CardView parts_decision", () => {
  it("renders expected vs actual per field, highlights differences and submits the choices as JSON", async () => {
    const card: Card = partsDecisionCard(3, [
      { ref: "C3", expected: { value: "100n", package: "0603", voltage: "50V" }, actual: { lcsc: "C14663", mpn: "CL10B104KB8NNNC", value: "100nF", package: "0603", voltage: "25V" }, candidates: [{ lcsc: "C14663", mpn: "CL10B104KB8NNNC", value: "100nF", package: "0603", voltage: "25V" }, { lcsc: "C1525", value: "100nF", package: "0603", voltage: "50V" }], confidence: "low" },
      { ref: "U2", expected: { mpn: "AMS1117-3.3" }, actual: null, candidates: [], confidence: "none" },
    ], "two parts need a decision");
    card.id = "pd1";
    const answers: unknown[] = [];
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    expect(host.querySelectorAll(".pd-item")).toHaveLength(2);
    const first = host.querySelectorAll(".pd-item")[0];
    const rows = [...first.querySelectorAll(".pd-table tbody tr")];
    expect(rows).toHaveLength(5); // mpn, value, package, voltage, lcsc
    expect(rows[0].querySelectorAll("td")[2].textContent).toBe("CL10B104KB8NNNC");
    const diff = rows.filter((r) => r.classList.contains("pd-diff"));
    expect(diff.length).toBeGreaterThanOrEqual(1);
    expect(diff.some((r) => r.textContent?.includes("25V"))).toBe(true);
    // U2 has no match: "accept" is disabled, no-part is the default.
    const u2 = host.querySelector<HTMLInputElement>("input[name='pd-U2'][value='accept']")!;
    expect(u2.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>("input[name='pd-U2'][value='no_part']")!.checked).toBe(true);
    // Pick the alternate for C3 and choose the second candidate.
    await act(async () => { host.querySelector<HTMLInputElement>("input[name='pd-C3'][value='alternate']")!.click(); });
    const sel = first.querySelector<HTMLSelectElement>("select")!;
    expect(sel.options).toHaveLength(2);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(sel, "C1525");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const apply = [...host.querySelectorAll("button")].find((b) => /Apply decisions|套用決定|应用决定|判断を適用/.test(b.textContent ?? ""))!;
    expect(apply.disabled).toBe(true); // consent button arms after 500 ms visible
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    await act(async () => { apply.click(); });
    expect(answers).toHaveLength(1);
    const [id, action, free] = answers[0] as [string, string, string];
    expect(id).toBe("pd1");
    expect(action).toBe("apply");
    expect(JSON.parse(free)).toEqual({ decisions: [{ ref: "C3", choice: "alternate", lcsc: "C1525" }, { ref: "U2", choice: "no_part", lcsc: undefined }] });
  });
});
