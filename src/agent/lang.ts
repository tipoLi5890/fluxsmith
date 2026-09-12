// SPDX-License-Identifier: Apache-2.0
// Reply-language detection (CLAUDE.md "語言"): kana → ja; majority of
// Traditional-only vs Simplified-only characters; otherwise the UI language.
// Internal prompts, briefs and tool descriptions are always English.

import type { Language } from "../ipc/types";

export type ReplyLanguage = "zh-Hant" | "zh-Hans" | "en" | "ja";

// Small but discriminative character sets (tests/i18n/lang-detect.jsonl drives the full corpus).
const TRAD_ONLY = "這個們來會說對時體當發經過麼們裡後電氣圖線數設計號動應該讓開關檢驗閘迴義書學國語們與從點鐘體體萬區網為義";
const SIMP_ONLY = "这个们来会说对时体当发经过么里后电气图线数设计号动应该让开关检验闸回义书学国语与从点钟万区网为";

export function detectReplyLanguage(text: string, uiLanguage: Language): ReplyLanguage {
  if (/[぀-ゟ゠-ヿ]/.test(text)) return "ja";
  let trad = 0;
  let simp = 0;
  let cjk = 0;
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) {
      cjk++;
      if (TRAD_ONLY.includes(ch)) trad++;
      else if (SIMP_ONLY.includes(ch)) simp++;
    }
  }
  if (cjk > 0) {
    if (trad > simp) return "zh-Hant";
    if (simp > trad) return "zh-Hans";
  }
  if (uiLanguage === "auto") return cjk > 0 ? "zh-Hant" : "en";
  return uiLanguage;
}
