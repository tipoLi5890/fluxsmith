// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { addUsage, byRoleList, cacheHitRatio, emptyUsage, fmtTokens, sumUsage, usageLine, usageTokens } from "../chat/usage";
import { createBridge, reduceEvent, usagePhaseIndex, type BridgeState, type PhaseSection } from "../harness-bridge";
import { t as translate, type MessageKey, type Params, type UiLang } from "../../i18n";

const call = (input: number, cache_read: number, cache_creation: number, output: number, cost_usd: number | null = 0) => ({ input, cache_read, cache_creation, output, cost_usd });
const line = (lang: UiLang) => ({ t: (k: MessageKey, p?: Params) => translate(k, p, lang), lang });

describe("usage totals", () => {
  it("folds calls, sums tokens and keeps the cost only while every call had a rate", () => {
    let u = addUsage(undefined, call(100, 900, 50, 20, 0.25));
    expect(u.calls).toBe(1);
    expect(usageTokens(u)).toBe(1070);
    expect(u.cost_known).toBe(true);
    u = addUsage(u, call(10, 0, 0, 5, null));
    expect(u.calls).toBe(2);
    expect(u.cost_usd).toBeCloseTo(0.25, 10);
    expect(u.cost_known).toBe(false); // a call with no rate: the total is a lower bound
    expect(usageTokens(u)).toBe(1085);
  });

  it("hit ratio is cache_read / (input + cache_creation + cache_read) and never divides by zero", () => {
    expect(cacheHitRatio(addUsage(undefined, call(100, 300, 100, 40)))).toBeCloseTo(0.6, 10);
    expect(cacheHitRatio(emptyUsage())).toBe(0);
    // output alone is not part of the denominator
    expect(cacheHitRatio(addUsage(undefined, call(0, 0, 0, 500)))).toBe(0);
    expect(cacheHitRatio(addUsage(undefined, call(0, 400, 0, 10)))).toBe(1);
  });

  it("sums totals across roles", () => {
    const a = addUsage(undefined, call(100, 0, 0, 10, 0.1));
    const b = addUsage(undefined, call(50, 50, 0, 5, null));
    const total = sumUsage([a, b]);
    expect(usageTokens(total)).toBe(215);
    expect(total.calls).toBe(2);
    expect(total.cost_known).toBe(false);
    expect(sumUsage([])).toEqual(emptyUsage());
  });

  it("lists roles busiest first and drops roles with no calls", () => {
    const roles = byRoleList({
      lead: addUsage(undefined, call(100, 0, 0, 10)),
      drafter: addUsage(undefined, call(1000, 0, 0, 100)),
      fixer: emptyUsage(),
    });
    expect(roles.map((r) => r.role)).toEqual(["drafter", "lead"]);
    expect(byRoleList({})).toEqual([]);
  });
});

describe("usage aggregation in the bridge", () => {
  const apply = (s: BridgeState, e: Parameters<typeof reduceEvent>[1]) => ({ ...s, ...reduceEvent(s, e) });

  it("accumulates per turn and per role and attributes each call to the role's phase", () => {
    let s = createBridge().getState() as BridgeState;
    s = apply(s, { kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
    s = apply(s, { kind: "phase", turn: 1, role: "lead", phase: "exploring" });
    s = apply(s, { kind: "usage", turn: 1, role: "lead", input: 200, cache_read: 800, cache_creation: 0, output: 50, cost_usd: 0.02 });
    s = apply(s, { kind: "phase", turn: 1, role: "drafter", phase: "building", detail: "power" });
    s = apply(s, { kind: "usage", turn: 1, role: "drafter", input: 100, cache_read: 100, cache_creation: 200, output: 300, cost_usd: 0.05 });
    s = apply(s, { kind: "usage", turn: 1, role: "drafter", input: 100, cache_read: 100, cache_creation: 0, output: 100, cost_usd: 0.01 });
    // a lead call while the drafter phase is open goes back to the lead's own (finished) phase
    s = apply(s, { kind: "usage", turn: 1, role: "lead", input: 10, cache_read: 0, cache_creation: 0, output: 10, cost_usd: 0.001 });
    // a second turn keeps its own totals
    s = apply(s, { kind: "usage", turn: 2, role: "lead", input: 1, cache_read: 0, cache_creation: 0, output: 1, cost_usd: 0.5 });

    const turn1 = s.turns.find((x) => x.turn === 1)!;
    expect(Object.keys(turn1.usageByRole).sort()).toEqual(["drafter", "lead"]);
    expect(turn1.usageByRole.lead!.calls).toBe(2);
    expect(usageTokens(turn1.usageByRole.lead!)).toBe(1070);
    expect(usageTokens(turn1.usageByRole.drafter!)).toBe(1000);
    expect(cacheHitRatio(turn1.usageByRole.drafter!)).toBeCloseTo(200 / 600, 10);
    expect(sumUsage(byRoleList(turn1.usageByRole).map((r) => r.usage)).cost_usd).toBeCloseTo(0.081, 10);
    expect(turn1.phases[0].usage!.calls).toBe(2); // exploring (lead)
    expect(turn1.phases[1].usage!.calls).toBe(2); // building (drafter)
    expect(usageTokens(s.turns.find((x) => x.turn === 2)!.usageByRole.lead!)).toBe(2);
  });

  it("counts a call with no rate as tokens only", () => {
    let s = createBridge().getState() as BridgeState;
    s = apply(s, { kind: "usage", turn: 1, role: "lead", input: 10, cache_read: 0, cache_creation: 0, output: 5, cost_usd: null });
    expect(s.turns[0].usageByRole.lead!.cost_known).toBe(false);
    expect(s.turns[0].usageByRole.lead!.cost_usd).toBe(0);
  });

  it("picks the phase a call belongs to: live same-role, then last same-role, then the live phase", () => {
    const p = (id: string, role: PhaseSection["role"], ended?: boolean): PhaseSection =>
      ({ id, phase: "exploring", role, started_at: "t", ended_at: ended ? "t2" : undefined, activities: [], cards: [] });
    expect(usagePhaseIndex([], "lead")).toBe(-1);
    expect(usagePhaseIndex([p("a", "lead", true), p("b", "drafter")], "lead")).toBe(0);
    expect(usagePhaseIndex([p("a", "lead", true), p("b", "lead")], "lead")).toBe(1);
    // compaction has no phase of its own: it lands on whatever is running
    expect(usagePhaseIndex([p("a", "lead", true), p("b", "drafter")], "compaction")).toBe(1);
    expect(usagePhaseIndex([p("a", "lead", true)], "compaction")).toBe(-1);
  });
});

describe("usage line formatting", () => {
  const u = addUsage(addUsage(undefined, { input: 2000, cache_read: 8000, cache_creation: 0, output: 500, cost_usd: 0.4 }), { input: 100, cache_read: 400, cache_creation: 0, output: 100, cost_usd: 0.02 });

  it("shows tokens, cost and cache share in the app locale", () => {
    expect(usageLine(u, { ...line("en"), showCost: true })).toBe("11,100 tokens · $0.42 · cache 80%");
    expect(usageLine(u, { ...line("en"), showCost: true, compact: true })).toBe("11.1k tokens · $0.42 · cache 80%");
    expect(usageLine(u, { ...line("ja"), showCost: true, compact: true })).toBe("11.1k トークン · $0.42 · キャッシュ 80%");
    expect(usageLine(u, { ...line("zh-Hant"), showCost: true })).toContain("快取 80%");
    expect(usageLine(u, { ...line("zh-Hans"), showCost: true })).toContain("缓存 80%");
  });

  it("drops the price when the budget display is off, and keeps the tokens", () => {
    expect(usageLine(u, { ...line("en"), showCost: false })).toBe("11,100 tokens · cache 80%");
    expect(usageLine(u, { ...line("en"), showCost: false, note: true })).toBe("11,100 tokens · cache 80%");
  });

  it("says so when a call had no rate, and omits the cache share for a restored turn", () => {
    const noRate = addUsage(u, { input: 10, cache_read: 0, cache_creation: 0, output: 10, cost_usd: null });
    expect(usageLine(noRate, { ...line("en"), showCost: true, note: true })).toContain("no price for this model");
    expect(usageLine(noRate, { ...line("en"), showCost: true })).not.toContain("no price");
    const restored = { ...emptyUsage(), input: 1234, cost_usd: 0.03, calls: 1 };
    expect(usageLine(restored, { ...line("en"), showCost: true, showCache: false })).toBe("1,234 tokens · $0.03");
    expect(usageLine(emptyUsage(), { ...line("en"), showCost: true })).toBe("0 tokens · cache 0%");
  });

  it("formats token counts compactly only above a thousand", () => {
    expect(fmtTokens(999, "en", true)).toBe("999");
    expect(fmtTokens(1500, "en", true)).toBe("1.5k");
    expect(fmtTokens(1500, "en")).toBe("1,500");
  });
});
