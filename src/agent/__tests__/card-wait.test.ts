// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createCardWaiter } from "../card-wait";

describe("card waiter", () => {
  it("resolves a waiter registered before the answer", async () => {
    const w = createCardWaiter();
    const p = w.show("c1");
    expect(w.answer("c1", { action_id: "opt:0" })).toBe(true);
    expect(await p).toEqual({ action_id: "opt:0" });
  });
  it("keeps an answer that arrives before the tool registers its waiter (the autorun race)", async () => {
    const w = createCardWaiter();
    expect(w.answer("c2", { action_id: "opt:0", free_text: "x" })).toBe(false);
    expect(await w.show("c2")).toEqual({ action_id: "opt:0", free_text: "x" });
    expect(w.has("c2")).toBe(false);
  });
  it("drops answers to a dismissed card", async () => {
    const w = createCardWaiter();
    w.answer("c3", { action_id: "abandon" });
    w.dismiss("c3");
    let resolved = false;
    void w.show("c3").then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
  });
});
