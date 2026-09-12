// SPDX-License-Identifier: Apache-2.0
// Rollback dialog: which external changes it warns about (a KiCad edit between turns belongs to no
// turn block, so time decides, not the turn the card was filed under), the files the restore moves
// out of the project, the state token it hands to the write, and the one-shot pre-rollback action
// on the result card.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const invoke = vi.fn(async (cmd: string, _args: unknown) => {
  if (cmd === "checkpoint_list") return [{ project_key: "p1", turn: 3, manifest_sha256: "m", bytes: 10, created: "2026-09-05T10:00:00.000Z", kind: "turn", pruned: false, verified: true }];
  if (cmd === "rollback_preview") return { before_turn: 3, kind: "turn", restore_files: ["root.kicad_sch"], remove_files: ["sub/new_sheet.kicad_sch"], state_sha256: "state-token" };
  if (cmd === "consent_record") return { id: "consent-1" };
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invoke(c, a), Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null, save: async () => null }));

import { RollbackDialog, overwrittenExternalChanges } from "../chat/RollbackDialog";
import { rollbackDoneCard } from "../../agent/cards";
import type { TurnBlock } from "../harness-bridge";
import type { Card } from "../../agent/api";

const block = (turn: number, cardIds: string[] = []): TurnBlock => ({
  turn, kind: "instruction", mode: "build", headline: `turn ${turn}`, envelope: null, started_at: "", phases: [], messages: [],
  applied: [], findings: [], cost_usd: 0, tokens: 0, usageByRole: {}, collapsed: false,
  items: cardIds.map((id, i) => ({ seq: i, kind: "card" as const, id })),
});
const externalCard = (id: string, turn: number, at?: string): Card => ({
  id, kind: "system", turn, title: "system.external_change", body_md: "", actions: [], data: { files: ["root.kicad_sch"], ...(at ? { at } : {}) },
});

describe("external changes a rollback would overwrite", () => {
  const CP = "2026-09-05T10:00:00.000Z";
  it("counts a change made after the checkpoint even when it belongs to no turn block", () => {
    // Turn 3 ended, KiCad wrote, turn 4 has not begun: the card is filed under turn 3 but the change
    // is younger than turn 3's checkpoint, so rolling back to 3 would overwrite it.
    const cards = { c1: externalCard("c1", 3, "2026-09-05T11:00:00.000Z") };
    expect(overwrittenExternalChanges([block(3, ["c1"])], cards, 3, CP).map((c) => c.id)).toEqual(["c1"]);
  });
  it("ignores a change the checkpoint already contains", () => {
    const cards = { c1: externalCard("c1", 3, "2026-09-05T09:00:00.000Z") };
    expect(overwrittenExternalChanges([block(3, ["c1"])], cards, 3, CP)).toEqual([]);
  });
  it("falls back to the undone turns when no checkpoint time or timestamp is known", () => {
    const cards = { c1: externalCard("c1", 4) };
    const turns = [block(3), block(4, ["c1"])];
    expect(overwrittenExternalChanges(turns, cards, 3, CP).map((c) => c.id)).toEqual(["c1"]);
    expect(overwrittenExternalChanges(turns, cards, 5, CP)).toEqual([]);
  });
});

describe("rollback dialog", () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    invoke.mockClear();
  });

  it("lists what leaves the project, warns about the overwritten KiCad edit and confirms with the previewed state", async () => {
    const seen: unknown[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const cards = { c1: externalCard("c1", 3, "2026-09-05T11:00:00.000Z") };
    await act(async () => {
      root.render(<RollbackDialog turn={3} turns={[block(3, ["c1"])]} cards={cards} projectKey="p1" onClose={() => undefined}
        onConfirm={async (t, o) => { seen.push([t, o]); return null; }} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(host.textContent).toContain("sub/new_sheet.kicad_sch");
    expect(host.textContent).toContain("external change");
    const confirm = Array.from(host.querySelectorAll("button")).find((b) => b.classList.contains("btn-consent"));
    expect(confirm?.disabled).toBe(false);
    await act(async () => { confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(seen).toEqual([[3, { state_sha256: "state-token" }]]);
    root.unmount();
  });

  it("keeps the dialog open and re-reads when the write is refused as stale", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let closed = false;
    await act(async () => {
      root.render(<RollbackDialog turn={3} turns={[block(3)]} projectKey="p1" onClose={() => { closed = true; }}
        onConfirm={async () => "ROLLBACK_STALE"} />);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    const previews = invoke.mock.calls.filter((c) => c[0] === "rollback_preview").length;
    const confirm = Array.from(host.querySelectorAll("button")).find((b) => b.classList.contains("btn-consent"));
    await act(async () => { confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(closed).toBe(false);
    expect(host.textContent).toContain("Files changed again before the rollback");
    expect(invoke.mock.calls.filter((c) => c[0] === "rollback_preview").length).toBe(previews + 1);
    root.unmount();
  });

  it("is given the cards from both entry points (without them it cannot warn)", () => {
    for (const f of ["src/ui/chat/ChatPanel.tsx", "src/ui/sidebar/Sidebar.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const tag = src.slice(src.indexOf("<RollbackDialog"));
      expect(tag.slice(0, tag.indexOf("/>")), f).toContain("cards={");
    }
  });
});

describe("rollback result card", () => {
  it("offers the one-shot restore only while the snapshot exists", () => {
    const withSnap = rollbackDoneCard(2, { turn: 3, before_turn: 3, files: ["root.kicad_sch"], removed: [], pre_rollback: 7 });
    expect(withSnap.title).toBe("system.rollback_done");
    expect(withSnap.actions.map((a) => a.id)).toEqual(["restore_pre_rollback"]);
    // Restoring the snapshot writes files: it carries a consent grant like any other write.
    expect(withSnap.actions[0].consent?.grant_kind).toBe("rollback");
    const consumed = rollbackDoneCard(2, { turn: 3, before_turn: 3, files: [], removed: [], pre_rollback: null });
    expect(consumed.actions).toEqual([]);
  });
});
