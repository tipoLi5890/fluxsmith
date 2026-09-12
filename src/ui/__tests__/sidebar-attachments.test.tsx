// SPDX-License-Identifier: Apache-2.0
// The attachments panel is not a read-only list: a datasheet is only worth having if it can be put
// into the next message, bound to the part it belongs to (what `DATASHEET_MISMATCH` needs), and
// dropped again. Binding follows the canvas selection, and removing asks first.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ref } from "../../agent/api";

const queries: Record<string, unknown>[] = [];
const LIST = [
  { sha256: "abc123def456", kind: "pdf", label: "AMS1117.pdf", size: 100, content_type: "application/pdf", pages: 4, image: null, bound_to: null, warnings: [] },
];
vi.mock("../../ipc/client", () => ({
  isTauri: () => true,
  call: vi.fn(async (name: string, args: { query?: Record<string, unknown>; request?: { kind: string } }) => {
    if (name === "db_query" && args.query) {
      queries.push(args.query);
      return args.query.kind === "attachment_list" ? LIST : null;
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
    info: { name: "x", root: "/p", root_uuid: "u", last_turn: 0, sheets: [{ file: "root.kicad_sch", instance_path: "/r", names: [], paper: "A4", symbols: 1 }] },
  } as unknown as import("../../state/projects").ProjectTab;
}
async function render(el: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { createRoot(container).render(el); });
  return container;
}
function button(container: HTMLElement, label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label)!;
}
async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

describe("attachments panel", () => {
  beforeEach(() => { setHarnessFactory(null); usePrefs.setState({ sidebarTab: "attachments" }); queries.length = 0; });

  it("adds an attachment to the conversation as a ref chip", async () => {
    const seen: Ref[][] = [];
    const h = (e: Event) => seen.push((e as CustomEvent<Ref[]>).detail);
    document.addEventListener("fs:canvas-selection", h);
    const container = await render(<Sidebar tab={tab()} bridge={createBridge()} onFocus={() => undefined} />);
    await click(button(container, "Add to conversation"));
    document.removeEventListener("fs:canvas-selection", h);
    expect(seen.pop()).toEqual([{ kind: "attachment", sha256: "abc123def456", label: "AMS1117.pdf" }]);
  });

  it("binds to the selected component, and offers nothing to bind to without a selection", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    expect(button(container, "Bind to component").disabled).toBe(true);
    await act(async () => { bridge.setState((s) => ({ ...s, selection: [{ kind: "component", ref: "U1" }] })); });
    const bind = button(container, "Bind to component");
    expect(bind.disabled).toBe(false);
    expect(bind.title).toBe("Bind to U1");
    await click(bind);
    // The write, then the reload that shows the new binding.
    expect(queries.find((q) => q.kind === "attachment_bind")).toEqual({ kind: "attachment_bind", project_key: "k", sha256: "abc123def456", bound_to: "U1" });
  });

  it("asks before dropping the pointer", async () => {
    const container = await render(<Sidebar tab={tab()} bridge={createBridge()} onFocus={() => undefined} />);
    await click(button(container, "Remove attachment"));
    const dialog = document.querySelector("[role='dialog']")!;
    expect(dialog.textContent).toContain("AMS1117.pdf");
    expect(queries.some((q) => q.kind === "attachment_remove")).toBe(false);
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === "Remove attachment").pop()!;
    await click(confirm);
    expect(queries.some((q) => q.kind === "attachment_remove" && q.sha256 === "abc123def456")).toBe(true);
  });
});
