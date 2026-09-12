// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

// Mount the whole shell outside Tauri: must render without throwing.
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

describe("App smoke", () => {
  it("renders the welcome shell without runtime errors", async () => {
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); orig(...a); };
    const { App } = await import("../App");
    const el = document.createElement("div");
    document.body.appendChild(el);
    await act(async () => { createRoot(el).render(<App />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    console.error = orig;
    expect(el.textContent?.length ?? 0).toBeGreaterThan(0);
    const fatal = (errors as unknown[][]).filter((e) => String(e[0]).includes("Error") && !String(e[0]).includes("act("));
    expect(fatal, JSON.stringify(fatal).slice(0, 500)).toHaveLength(0);
  });
});
