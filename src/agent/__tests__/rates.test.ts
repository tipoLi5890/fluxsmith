// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { applyBuiltinRates, effectiveRates, findRateFamily, ratesStale } from "../models/rates";

describe("rates", () => {
  it("prefers configured rates, falls back to the built-in table by family prefix", () => {
    expect(effectiveRates({ kind: "anthropic", rates: [1, 1, 1, 1] }, "claude-sonnet-5")?.origin).toBe("provider");
    const r = effectiveRates({ kind: "openai-codex", rates: [0, 0, 0, 0] }, "gpt-5.2-codex-max");
    expect(r?.origin).toBe("builtin");
    expect(r?.entry?.model).toBe("gpt-5.2");
    expect(r?.entry?.estimated).toBe(true);
    expect(findRateFamily("openai", "gpt-5-2026-01-01")?.model).toBe("gpt-5");
    expect(findRateFamily("openai", "gpt-5.7")).toBeUndefined();
    expect(effectiveRates({ kind: "custom", rates: [0, 0, 0, 0] }, "llama")).toBeNull();
  });
  it("copies built-in rates only into zero providers", () => {
    const { providers, changed } = applyBuiltinRates([
      { kind: "openai-codex", rates: [0, 0, 0, 0], models: ["gpt-5-codex"] },
      { kind: "custom", rates: [0, 0, 0, 0], models: ["x"] },
      { kind: "anthropic", rates: [9, 9, 9, 9], models: ["claude-opus-5"] },
    ]);
    expect(changed).toBe(1);
    expect(providers[0].rates).toEqual([1.25, 1.25, 0.125, 10]);
    expect(providers[1].rates).toEqual([0, 0, 0, 0]);
    expect(providers[2].rates).toEqual([9, 9, 9, 9]);
  });
  it("bills unknown minors of a known major as estimated (gpt-5.6-luna, gpt-5.9-x)", () => {
    expect(findRateFamily("openai-codex", "gpt-5.6-luna")?.rates[0]).toBe(1.75);
    const f = findRateFamily("openai-codex", "gpt-5.9-foo");
    expect(f?.estimated).toBe(true);
    expect(f?.rates[3]).toBe(14);
    expect(effectiveRates({ kind: "openai-codex", rates: [0, 0, 0, 0] }, "gpt-5.6-luna")?.origin).toBe("builtin");
    expect(findRateFamily("openai-codex", "o3")).toBeUndefined();
  });
  it("flags stale tables", () => {
    expect(ratesStale("2026-01-01", new Date("2026-06-01"))).toBe(true);
    expect(ratesStale("2026-05-01", new Date("2026-06-01"))).toBe(false);
  });
});
