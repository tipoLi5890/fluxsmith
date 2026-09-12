// SPDX-License-Identifier: Apache-2.0
// Rate table (USD per 1M tokens: input, cache_write, cache_read, output).
// Each entry carries `as_of` and a source URL; the settings page shows
// staleness (> 90 days). Users can override per provider in settings.
//
// `effectiveRates` is the single place that decides which rates the harness
// bills with: the provider's configured rates when any of them is non-zero,
// else the built-in entry for the model id (exact, then longest family prefix),
// else null (local / unbilled). Keep it pure: the cost path in lead.ts and the
// settings page both call it.

export interface RateEntry {
  provider: string;
  model: string;
  rates: [number, number, number, number];
  context_window: number;
  as_of: string;
  source: string;
  /** Not published by the vendor (e.g. Codex OAuth plans); an estimate for budgeting only. */
  estimated?: boolean;
}

export type Rates = [number, number, number, number];

export const RATES_AS_OF = "2026-08-30";
/** Date the built-in table was last reviewed (what the settings page stamps into `rates_as_of`). */
export const RATES_UPDATED = RATES_AS_OF;

const ANTHROPIC = "https://www.anthropic.com/pricing";
const OPENAI = "https://openai.com/api/pricing";
const GOOGLE = "https://ai.google.dev/pricing";
/** Codex OAuth is billed through the ChatGPT plan; we estimate with the matching API model's list price. */
const CODEX = "https://openai.com/api/pricing (estimated: plan-billed)";

export const RATE_TABLE: readonly RateEntry[] = [
  { provider: "anthropic", model: "claude-fable-5", rates: [15, 18.75, 1.5, 75], context_window: 200_000, as_of: RATES_AS_OF, source: ANTHROPIC },
  { provider: "anthropic", model: "claude-opus-5", rates: [15, 18.75, 1.5, 75], context_window: 200_000, as_of: RATES_AS_OF, source: ANTHROPIC },
  { provider: "anthropic", model: "claude-sonnet-5", rates: [3, 3.75, 0.3, 15], context_window: 200_000, as_of: RATES_AS_OF, source: ANTHROPIC },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", rates: [1, 1.25, 0.1, 5], context_window: 200_000, as_of: RATES_AS_OF, source: ANTHROPIC },
  { provider: "openai", model: "gpt-5", rates: [1.25, 1.25, 0.125, 10], context_window: 400_000, as_of: RATES_AS_OF, source: OPENAI },
  { provider: "openai", model: "gpt-5-mini", rates: [0.25, 0.25, 0.025, 2], context_window: 400_000, as_of: RATES_AS_OF, source: OPENAI },
  { provider: "openai", model: "gpt-5-nano", rates: [0.05, 0.05, 0.005, 0.4], context_window: 400_000, as_of: RATES_AS_OF, source: OPENAI },
  { provider: "openai", model: "gpt-5-codex", rates: [1.25, 1.25, 0.125, 10], context_window: 400_000, as_of: RATES_AS_OF, source: OPENAI },
  // Codex OAuth (openai-codex): the plan does not expose per-token prices; these mirror the API list price
  // for the same family so budgets and golden-set cost columns are non-zero. Family prefixes cover
  // gpt-5.1 / gpt-5.2 / gpt-5.x-codex variants.
  { provider: "openai-codex", model: "gpt-5-codex", rates: [1.25, 1.25, 0.125, 10], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "openai-codex", model: "gpt-5", rates: [1.25, 1.25, 0.125, 10], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "openai-codex", model: "gpt-5-mini", rates: [0.25, 0.25, 0.025, 2], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "openai-codex", model: "gpt-5.1", rates: [1.25, 1.25, 0.125, 10], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "openai-codex", model: "gpt-5.2", rates: [1.75, 1.75, 0.175, 14], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "openai-codex", model: "gpt-5.5", rates: [1.75, 1.75, 0.175, 14], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "openai-codex", model: "gpt-5.6", rates: [1.75, 1.75, 0.175, 14], context_window: 400_000, as_of: RATES_AS_OF, source: CODEX, estimated: true },
  { provider: "google", model: "gemini-2.5-pro", rates: [1.25, 1.25, 0.31, 10], context_window: 1_000_000, as_of: RATES_AS_OF, source: GOOGLE },
  { provider: "google", model: "gemini-2.5-flash", rates: [0.3, 0.3, 0.075, 2.5], context_window: 1_000_000, as_of: RATES_AS_OF, source: GOOGLE },
];

/** Exact match on (provider kind, model id). */
export function findRate(provider: string, model: string): RateEntry | undefined {
  return RATE_TABLE.find((r) => r.provider === provider && r.model === model);
}

/**
 * Exact match, else the entry whose model id is the longest prefix of `model` at a
 * family boundary (`gpt-5.2` matches `gpt-5.2-codex-max`, `gpt-5` matches `gpt-5-2026-01-01`).
 * A dotted minor version never matches a shorter one (`gpt-5.1` is not `gpt-5`-prefixed
 * at a boundary because "." is not a boundary).
 */
export function findRateFamily(provider: string, model: string): RateEntry | undefined {
  const exact = findRate(provider, model);
  if (exact) return exact;
  let best: RateEntry | undefined;
  for (const r of RATE_TABLE) {
    if (r.provider !== provider || !model.startsWith(r.model)) continue;
    const next = model.charAt(r.model.length);
    if (next !== "-" && next !== "_" && next !== ":") continue;
    if (!best || r.model.length > best.model.length) best = r;
  }
  if (best) return best;
  // Unknown minor of a known major (`gpt-5.7-foo` with only `gpt-5.6` in the table): bill at the newest
  // entry of the same major, flagged as estimated, rather than at zero.
  const major = /^([a-z]+-\d+)\.\d+/i.exec(model)?.[1];
  if (!major) return undefined;
  let newest: RateEntry | undefined;
  for (const r of RATE_TABLE) {
    if (r.provider !== provider || !r.model.startsWith(`${major}.`) || /[-_:]/.test(r.model.slice(major.length))) continue;
    if (!newest || r.model.localeCompare(newest.model, undefined, { numeric: true }) > 0) newest = r;
  }
  return newest ? { ...newest, model, estimated: true } : undefined;
}

export interface EffectiveRates {
  rates: Rates;
  /** `provider`: configured in settings; `builtin`: fell back to the table. */
  origin: "provider" | "builtin";
  entry?: RateEntry;
}

/** The rates the harness should bill `model` on `provider` with, or null when unbilled (all zero, no table entry). */
export function effectiveRates(provider: { kind: string; rates: Rates | readonly number[] }, model: string): EffectiveRates | null {
  const own = provider.rates;
  if (own && own.length === 4 && own.some((r) => Number(r) > 0)) return { rates: [own[0], own[1], own[2], own[3]] as Rates, origin: "provider" };
  const entry = findRateFamily(provider.kind, model);
  return entry ? { rates: [...entry.rates] as Rates, origin: "builtin", entry } : null;
}

export function ratesStale(asOf: string, now: Date, days = 90): boolean {
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > days * 86_400_000;
}

/**
 * Providers whose configured rates are all zero but have a built-in entry for at
 * least one of their models: the "update rate table" button copies the table in.
 * Pure: returns the new provider list (unchanged objects are reused) and how many changed.
 */
export function applyBuiltinRates<P extends { kind: string; rates: Rates; models: string[] }>(providers: P[], pickModel?: (p: P) => string | undefined): { providers: P[]; changed: number } {
  let changed = 0;
  const out = providers.map((p) => {
    if (p.rates.some((r) => r > 0)) return p;
    const model = pickModel?.(p) ?? p.models[0];
    const entry = model ? findRateFamily(p.kind, model) : undefined;
    if (!entry) return p;
    changed++;
    return { ...p, rates: [...entry.rates] as Rates };
  });
  return { providers: out, changed };
}
