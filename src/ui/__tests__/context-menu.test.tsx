// SPDX-License-Identifier: Apache-2.0
// ContextMenu keyboard behaviour (WAI-ARIA menu pattern): the menu takes focus when it opens,
// Arrow / Home / End move between enabled items, Escape and Tab close it, and focus goes back
// to whatever had it. Without this the canvas right-click menu is unreachable from the keyboard.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ContextMenu, type MenuItem } from "../components";

const items: MenuItem[] = [
  { id: "a", label: "Reference in chat" },
  { id: "b", label: "Nothing here", disabled: true },
  { id: "c", label: "Copy name" },
];

function label(el: Element | null): string {
  return el?.textContent ?? "";
}

describe("ContextMenu keyboard", () => {
  it("focuses the first enabled item, walks with arrows, skips disabled ones and returns focus on close", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const chosen: string[] = [];
    let root: Root | null = null;
    const view = (at: { x: number; y: number } | null) => (
      <ContextMenu at={at} items={items} onSelect={(id) => chosen.push(id)} onClose={() => { closed++; }} />
    );
    let closed = 0;
    await act(async () => { root = createRoot(host); root.render(view({ x: 10, y: 10 })); });
    const menu = host.querySelector(".menu")!;
    expect(label(document.activeElement)).toContain("Reference in chat");
    // ArrowDown skips the disabled item and wraps
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
    expect(label(document.activeElement)).toContain("Copy name");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
    expect(label(document.activeElement)).toContain("Reference in chat");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" })); });
    expect(label(document.activeElement)).toContain("Copy name");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })); });
    expect(label(document.activeElement)).toContain("Reference in chat");
    // Enter on the focused item is the button's own activation
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    expect(chosen).toEqual(["a"]);
    // closing gives focus back to whatever opened the menu
    await act(async () => { root!.render(view(null)); });
    expect(document.activeElement).toBe(opener);
    expect(closed).toBeGreaterThan(0);
    await act(async () => { root!.unmount(); });
  });

  it("closes on Escape and on Tab", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let closed = 0;
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(host);
      root.render(<ContextMenu at={{ x: 5, y: 5 }} items={items} onSelect={() => undefined} onClose={() => { closed++; }} />);
    });
    const menu = host.querySelector(".menu")!;
    const esc = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });
    await act(async () => { menu.dispatchEvent(esc); });
    expect(closed).toBeGreaterThan(0);
    const tab = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
    await act(async () => { menu.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true); // focus does not leak past the menu
    await act(async () => { root!.unmount(); });
  });
});
