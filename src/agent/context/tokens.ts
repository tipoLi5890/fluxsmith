// SPDX-License-Identifier: Apache-2.0
// Token estimation (context-compaction.md §0). Provider-reported prompt
// totals win; this heuristic only covers messages added since the last
// response. Always labelled "estimate".

export interface EstimateCalibration {
  ascii: number; // chars per token
  cjk: number;
  json: number;
}

export const DEFAULT_CALIBRATION: EstimateCalibration = { ascii: 4, cjk: 0.8, json: 3 };

const PER_PROVIDER: Record<string, EstimateCalibration> = {
  anthropic: { ascii: 3.8, cjk: 0.8, json: 2.8 },
  openai: { ascii: 4, cjk: 1.0, json: 3 },
  google: { ascii: 4, cjk: 1.0, json: 3 },
};

export function calibrationFor(providerKind: string): EstimateCalibration {
  return PER_PROVIDER[providerKind] ?? DEFAULT_CALIBRATION;
}

export function estimateTokens(text: string, cal: EstimateCalibration = DEFAULT_CALIBRATION): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff)) cjk++;
    else ascii++;
  }
  const jsonish = /^\s*[[{]/.test(text);
  const asciiTokens = ascii / (jsonish ? cal.json : cal.ascii);
  return Math.ceil(asciiTokens + cjk / cal.cjk);
}

export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** Normalised "prompt tokens total" per provider usage shape. */
export function promptTokensTotal(providerKind: string, u: { input: number; cacheRead: number; cacheWrite: number }): number {
  // pi-ai normalises every provider to `input` = uncached prompt tokens, so the
  // prompt size is always input + cacheRead + cacheWrite (verified against the
  // Codex responses usage stored in model_calls: input 1992 / cache_read 10752).
  void providerKind;
  return u.input + u.cacheRead + u.cacheWrite;
}
