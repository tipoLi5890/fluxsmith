// SPDX-License-Identifier: Apache-2.0
// Per-message language detection (CLAUDE.md "語言"): kana → ja; shinjitai-only kanji → ja; Hant/Hans-exclusive
// character majority; ambiguous CJK → UI language (if CJK) → previous message → OS locale; Latin words → en; else UI.
import type { UiLang } from "./index";

const HANT = "這個們來時說對會學國開關動過長點發電線圖將與後裡體麼還當請問題應該讓臺灣訊軟體為從網際見識歡迎誰輸幫繼續輪顆離內電容統系統供給輸";
const HANS = "这个们来时说对会学国开关动过长点发电线图将与后里体么还当请问题应该让台湾讯软体为从网际见识欢迎谁输帮继续轮颗离内电容统系统供给输";
// Kanji forms that exist only in Japanese shinjitai (neither traditional nor simplified Chinese).
// Characters shared by both scripts carry no signal; strip them once.
const SHARED = new Set([...HANT].filter((c) => HANS.includes(c)));
const HANT_ONLY = [...HANT].filter((c) => !SHARED.has(c)).join("");
const HANS_ONLY = [...HANS].filter((c) => !SHARED.has(c)).join("");
const JA_ONLY = "変図駅円険検験蔵実発戦売読楽歳広恵継続応対関帰総経済釈訳";

export function detectLang(text: string, ui: UiLang, prev: UiLang | null, locale?: string | null): UiLang {
  if (text.trim().startsWith("/")) return ui;
  if (/[぀-ヿ]/.test(text)) return "ja";
  let hant = 0;
  let hans = 0;
  let ja = 0;
  let cjk = 0;
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) cjk++;
    if (JA_ONLY.includes(ch)) ja++;
    else if (HANT_ONLY.includes(ch)) hant++;
    else if (HANS_ONLY.includes(ch)) hans++;
  }
  if (ja > 0 && ja >= Math.max(hant, hans)) return "ja";
  if (hant > hans) return "zh-Hant";
  if (hans > hant) return "zh-Hans";
  if (cjk > 0) {
    if (ui === "zh-Hant" || ui === "zh-Hans" || ui === "ja") return ui;
    if (prev === "zh-Hant" || prev === "zh-Hans" || prev === "ja") return prev;
    const loc = (locale ?? (typeof navigator !== "undefined" ? navigator.language : "")).toLowerCase();
    if (loc.startsWith("ja")) return "ja";
    if (loc.includes("hans") || loc.includes("cn") || loc.includes("sg")) return "zh-Hans";
    return "zh-Hant";
  }
  // No CJK: a real English word (lowercase letters, ≥ 3 chars) means English; codes like "U1 VDD" follow the UI.
  if (/\b[A-Za-z][a-z]{2,}\b/.test(text)) return "en";
  return ui;
}
