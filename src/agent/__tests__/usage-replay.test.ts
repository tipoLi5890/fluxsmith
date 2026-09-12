// SPDX-License-Identifier: Apache-2.0
// A restored session rebuilds the per-role usage of its turns from `model_calls` (db_query
// `model_call_by_turn`), so the turn footer after a restart shows the same tokens, cost and cache
// share as the live turn did (message-stream-ux.md §1, caching-strategy.md §6).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/client", async () => (await import("../replay/fake-ipc")).fakeIpcModule());

import { fakeIpc } from "../replay/fake-ipc";
import { createHarness } from "../index";
import type { TurnEvent } from "../api";
import { createBridge, reduceEvent, type BridgeState } from "../../ui/harness-bridge";
import { byRoleList, sumUsage, usageLine, usageTokens } from "../../ui/chat/usage";
import { t as translate, type MessageKey, type Params } from "../../i18n";

/** One persisted history message (the row shape `message_list` returns). */
const msg = (turn: number, content: unknown) => ({ id: turn, content, compacted_by: null });
const userMsg = (turn: number, text: string) => msg(turn, { role: "user", content: [{ type: "text", text }], meta: { turn, task: turn, kind: "user" } });
const assistantMsg = (turn: number, text: string) => msg(turn, { role: "assistant", content: [{ type: "text", text }], toolCalls: [], meta: { turn, task: turn, kind: "prose" } });

/** `model_call_by_turn` rows: already summed per (turn, role), ordered by turn then role. */
const USAGE_ROWS = [
  { turn: 1, role: "drafter", input: 200, cache_creation: 100, cache_read: 300, output: 400, cost_usd: 0.05, calls: 2 },
  { turn: 1, role: "lead", input: 110, cache_creation: 20, cache_read: 930, output: 55, cost_usd: 0.03, calls: 2 },
  { turn: 2, role: "lead", input: 10, cache_creation: 0, cache_read: 90, output: 5, cost_usd: 0.001, calls: 1 },
];

function attachWithUsage(rows: unknown[] = USAGE_ROWS) {
  fakeIpc.reset({
    commands: {
      db_query: (args) => {
        const q = args.query as { kind: string };
        if (q.kind === "message_list") return [userMsg(1, "add a divider"), assistantMsg(1, "done"), userMsg(2, "thanks"), assistantMsg(2, "you are welcome")];
        if (q.kind === "model_call_by_turn") return rows;
        return undefined;
      },
    },
  });
  return createHarness();
}

const apply = (s: BridgeState, e: TurnEvent) => ({ ...s, ...reduceEvent(s, e) });
const line = { t: (k: MessageKey, p?: Params) => translate(k, p, "en"), lang: "en" as const, showCost: true };

describe("restored session usage", () => {
  beforeEach(() => fakeIpc.reset());

  it("reads model_call_by_turn once per attach and replays one usage event per (turn, role)", async () => {
    const h = attachWithUsage();
    await h.attach("pk", "s");
    const queries = fakeIpc.calls
      .filter((c) => c.name === "db_query")
      .map((c) => (c.args as { query: { kind: string } }).query)
      .filter((q) => q.kind === "model_call_by_turn");
    expect(queries.length).toBe(1);
    expect(queries[0]).toMatchObject({ project_key: "pk", from_turn: null, to_turn: null });

    const items = h.replay();
    expect(items.filter((i) => i.kind === "usage")).toEqual([
      { kind: "usage", turn: 1, role: "drafter", input: 200, cache_read: 300, cache_creation: 100, output: 400, cost_usd: 0.05 },
      { kind: "usage", turn: 1, role: "lead", input: 110, cache_read: 930, cache_creation: 20, output: 55, cost_usd: 0.03 },
      { kind: "usage", turn: 2, role: "lead", input: 10, cache_read: 90, cache_creation: 0, output: 5, cost_usd: 0.001 },
    ]);
    // Each usage event sits inside its own turn: after that turn started, before it ended.
    for (const [i, item] of items.entries()) {
      if (item.kind !== "usage") continue;
      expect(items.findIndex((x) => x.kind === "turn_started" && x.turn === item.turn)).toBeLessThan(i);
      expect(items.findIndex((x) => x.kind === "turn_ended" && x.summary.turn === item.turn)).toBeGreaterThan(i);
    }
  });

  it("aggregates to the same footer as the live path", async () => {
    const h = attachWithUsage();
    await h.attach("pk", "s");
    let restored = createBridge().getState() as BridgeState;
    for (const item of h.replay()) if (item.kind !== "user_message") restored = apply(restored, item);

    // The live path: the same calls, one `usage` event each, as `onUsage` emits them.
    let live = createBridge().getState() as BridgeState;
    live = apply(live, { kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
    live = apply(live, { kind: "usage", turn: 1, role: "lead", input: 100, cache_read: 900, cache_creation: 0, output: 50, cost_usd: 0.01 });
    live = apply(live, { kind: "usage", turn: 1, role: "lead", input: 10, cache_read: 30, cache_creation: 20, output: 5, cost_usd: 0.02 });
    live = apply(live, { kind: "usage", turn: 1, role: "drafter", input: 100, cache_read: 200, cache_creation: 100, output: 300, cost_usd: 0.04 });
    live = apply(live, { kind: "usage", turn: 1, role: "drafter", input: 100, cache_read: 100, cache_creation: 0, output: 100, cost_usd: 0.01 });

    const turnOf = (s: BridgeState) => s.turns.find((x) => x.turn === 1)!;
    const rolesOf = (s: BridgeState) => byRoleList(turnOf(s).usageByRole);
    expect(rolesOf(restored).map((r) => r.role)).toEqual(rolesOf(live).map((r) => r.role));
    for (const r of rolesOf(live)) {
      const same = rolesOf(restored).find((x) => x.role === r.role)!.usage;
      expect(usageTokens(same)).toBe(usageTokens(r.usage));
      expect(usageLine(same, line)).toBe(usageLine(r.usage, line));
    }
    // The turn footer line itself (total tokens, cost, cache share) is identical.
    expect(usageLine(sumUsage(rolesOf(restored).map((r) => r.usage)), line)).toBe(usageLine(sumUsage(rolesOf(live).map((r) => r.usage)), line));
    expect(usageLine(sumUsage(rolesOf(restored).map((r) => r.usage)), line)).toBe("2,115 tokens · $0.08 · cache 74%");
  });

  it("counts a turn once: live turns are not in the attach-time snapshot", async () => {
    const h = attachWithUsage();
    await h.attach("pk", "s");
    let s = createBridge().getState() as BridgeState;
    for (const item of h.replay()) if (item.kind !== "user_message") s = apply(s, item);
    // Replaying again (a re-mounted stream) must not double the numbers of the restored turns.
    let again = createBridge().getState() as BridgeState;
    for (const item of h.replay()) if (item.kind !== "user_message") again = apply(again, item);
    const tokens = (st: BridgeState, turn: number) => usageTokens(sumUsage(byRoleList(st.turns.find((x) => x.turn === turn)!.usageByRole).map((r) => r.usage)));
    expect(tokens(again, 1)).toBe(tokens(s, 1));

    // A turn that ran after the attach has no row in the snapshot: only its live events count.
    s = apply(s, { kind: "turn_started", turn: 3, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
    s = apply(s, { kind: "usage", turn: 3, role: "lead", input: 7, cache_read: 3, cache_creation: 0, output: 1, cost_usd: 0.001 });
    expect(tokens(s, 3)).toBe(11);
    expect(h.replay().some((i) => i.kind === "usage" && i.turn === 3)).toBe(false);
  });

  it("attaches with no usage rows at all", async () => {
    const h = attachWithUsage([]);
    await h.attach("pk", "s");
    expect(h.replay().some((i) => i.kind === "usage")).toBe(false);
  });
});
