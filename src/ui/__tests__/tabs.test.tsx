// SPDX-License-Identifier: Apache-2.0
// WAI-ARIA tabs pattern for the shared Tabs component: exactly one tab stop (even when `value`
// matches no tab), arrows move and activate, Home / End jump to the ends.
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { Tabs, type TabItem } from "../components";

const ITEMS: TabItem[] = [{ id: "all", label: "All" }, { id: "error", label: "Errors" }, { id: "warning", label: "Warnings" }];

function mount(value: string, onChange: (id: string) => void = () => {}): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(<Tabs items={ITEMS} value={value} onChange={onChange} ariaLabel="filter" />); });
  return host;
}

function tabs(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>("[role=tab]")];
}

function press(el: HTMLButtonElement, key: string) {
  act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
}

describe("Tabs", () => {
  it("gives the selected tab the only tab stop", () => {
    const host = mount("warning");
    expect(tabs(host).map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("keeps the strip reachable when the value matches no tab", () => {
    const host = mount("gone");
    expect(tabs(host).map((b) => b.tabIndex)).toEqual([0, -1, -1]);
    expect(tabs(host).some((b) => b.getAttribute("aria-selected") === "true")).toBe(false);
  });

  it("moves and activates with the arrow keys, wrapping at both ends", () => {
    const picked: string[] = [];
    const host = mount("all", (id) => picked.push(id));
    const [first, second, third] = tabs(host);
    press(first, "ArrowRight");
    expect(picked).toEqual(["error"]);
    expect(document.activeElement).toBe(second);
    press(first, "ArrowLeft");
    expect(picked).toEqual(["error", "warning"]);
    expect(document.activeElement).toBe(third);
  });

  it("jumps to the first and last tab with Home and End", () => {
    const picked: string[] = [];
    const host = mount("error", (id) => picked.push(id));
    const [first, second, third] = tabs(host);
    press(second, "End");
    expect(picked).toEqual(["warning"]);
    expect(document.activeElement).toBe(third);
    press(second, "Home");
    expect(picked).toEqual(["warning", "all"]);
    expect(document.activeElement).toBe(first);
  });

  it("uses Up / Down only in a vertical strip", () => {
    const picked: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<Tabs items={ITEMS} value="all" variant="vertical" onChange={(id) => picked.push(id)} ariaLabel="sections" />); });
    press(tabs(host)[0], "ArrowDown");
    expect(picked).toEqual(["error"]);
    expect(host.querySelector("[role=tablist]")?.getAttribute("aria-orientation")).toBe("vertical");
  });
});
