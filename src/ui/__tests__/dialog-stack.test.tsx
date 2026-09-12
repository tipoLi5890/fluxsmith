// SPDX-License-Identifier: Apache-2.0
// Nested dialogs: Escape closes only the innermost one; Tab stays inside; the app-level Escape yields while any is open.
import { describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, hasOpenDialog } from "../components";

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

describe("dialog stack", () => {
  it("routes Escape to the top dialog only and reports open state", async () => {
    let outer = 0, inner = 0;
    const host = mount(
      <Dialog open onClose={() => { outer++; }} title="Outer" closeLabel="close">
        <button type="button">a</button>
        <Dialog open onClose={() => { inner++; }} title="Inner" closeLabel="close"><button type="button">b</button></Dialog>
      </Dialog>,
    );
    expect(hasOpenDialog()).toBe(true);
    expect(host.querySelectorAll("[role='dialog'][aria-labelledby]").length).toBe(2);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(inner).toBe(1);
    expect(outer).toBe(0);
    // Tab from the last focusable wraps to the first inside the top dialog
    const innerDialog = host.querySelectorAll<HTMLElement>("[role='dialog']")[1];
    const buttons = innerDialog.querySelectorAll<HTMLButtonElement>("button");
    buttons[buttons.length - 1].focus();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(innerDialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
  });
});
