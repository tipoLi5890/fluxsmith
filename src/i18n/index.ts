// SPDX-License-Identifier: Apache-2.0
// i18n core: four catalogues with identical key sets; `auto` maps navigator.language; runtime switch via store.
import { useSyncExternalStore } from "react";
import en from "./en";
import zhHant from "./zh-Hant";
import zhHans from "./zh-Hans";
import ja from "./ja";
import { isErrorCode } from "./errors/codes";
import { isFindingCode } from "../agent/finding-codes";

export type UiLang = "zh-Hant" | "zh-Hans" | "en" | "ja";
export type MessageKey = keyof typeof en;
export type Catalogue = Record<MessageKey, string>;

export const catalogues: Record<UiLang, Catalogue> = { en, "zh-Hant": zhHant, "zh-Hans": zhHans, ja };
export const UI_LANGS: UiLang[] = ["zh-Hant", "zh-Hans", "en", "ja"];

export function resolveAutoLang(navLang: string | undefined): UiLang {
  const l = (navLang ?? "en").toLowerCase();
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("zh")) {
    if (l.includes("hans") || l.includes("cn") || l.includes("sg")) return "zh-Hans";
    return "zh-Hant";
  }
  return "en";
}

let current: UiLang = resolveAutoLang(typeof navigator !== "undefined" ? navigator.language : "en");
const listeners = new Set<() => void>();

export function setLang(setting: UiLang | "auto"): void {
  const next = setting === "auto" ? resolveAutoLang(typeof navigator !== "undefined" ? navigator.language : "en") : setting;
  if (next === current) return;
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((l) => l());
}
export function getLang(): UiLang { return current; }

export type Params = Record<string, string | number>;

export function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

const reported = new Set<string>();
/** A key with no catalogue entry is a bug: report it once (console + Rust log) and fall back to the key. */
function reportMissing(key: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[i18n] missing key: ${key}`);
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    import("../ipc/client").then((m) => m.call("log_write", { level: "warn", message: `i18n missing key: ${key}`, req_id: null })).catch(() => undefined);
  }
}

export function t(key: MessageKey, params?: Params, lang: UiLang = current): string {
  const cat = catalogues[lang] ?? en;
  const tpl = cat[key] ?? en[key];
  if (tpl === undefined) { reportMissing(key); return format(key, params); }
  return format(tpl, params);
}

export function useLang(): UiLang {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current, () => current);
}

/** Hook returning a bound `t` that re-renders on language switch. */
/** Whether a catalogue entry exists (for optional labels such as `tool.<id>`), without reporting a miss. */
export function hasKey(key: string, lang: UiLang = current): boolean {
  const cat = catalogues[lang] ?? en;
  return (key in cat) || (key in en);
}

export function useT(): (key: MessageKey, params?: Params) => string {
  const lang = useLang();
  return (key, params) => t(key, params, lang);
}

export function fmtNumber(n: number, lang: UiLang = current, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(lang === "zh-Hant" ? "zh-TW" : lang === "zh-Hans" ? "zh-CN" : lang, opts).format(n);
}
export function fmtUsd(n: number, lang: UiLang = current): string {
  return `$${fmtNumber(n, lang, { minimumFractionDigits: 2, maximumFractionDigits: n < 0.1 ? 4 : 2 })}`;
}
export function fmtDate(iso: string, lang: UiLang = current): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "zh-Hant" ? "zh-TW" : lang === "zh-Hans" ? "zh-CN" : lang, { dateStyle: "medium", timeStyle: "short" }).format(d);
}
/** A calendar day (a waiver expiry: `YYYY-MM-DD` or an ISO instant) in the app locale, without a time. */
export function fmtDay(iso: string, lang: UiLang = current): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "zh-Hant" ? "zh-TW" : lang === "zh-Hans" ? "zh-CN" : lang, { dateStyle: "medium", timeZone: "UTC" }).format(d);
}
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export interface ErrorCopy { title: string; why: string; next: string }
/**
 * Three-part copy (what / why / what you can do) for an error code, or null when the code has
 * none — callers then fall back to `error.generic`. Evidence stays in the error message.
 */
export function errorCopy(code: string, lang: UiLang = current): ErrorCopy | null {
  if (!isErrorCode(code)) return null;
  const cat = catalogues[lang] ?? en;
  const k = (part: "title" | "why" | "next") => `error.${code}.${part}` as MessageKey;
  return { title: cat[k("title")] ?? en[k("title")], why: cat[k("why")] ?? en[k("why")], next: cat[k("next")] ?? en[k("next")] };
}

export interface FindingCopy { title: string; detail: string; remedy: string }
/**
 * Three-part copy (a short title, what the check measured, the usual fix) for a finding code, or
 * null when the code has none — a model advisory, or a KiCad rule the table does not list. Nothing
 * here judges the circuit (red line 6): the verdict and its evidence stay in the engine's own
 * `message`, which the caller shows verbatim beside this copy.
 */
export function findingCopy(code: string, lang: UiLang = current): FindingCopy | null {
  if (!isFindingCode(code)) return null;
  const cat = catalogues[lang] ?? en;
  const k = (part: "title" | "detail" | "remedy") => `finding.${code}.${part}` as MessageKey;
  return { title: cat[k("title")] ?? en[k("title")], detail: cat[k("detail")] ?? en[k("detail")], remedy: cat[k("remedy")] ?? en[k("remedy")] };
}

/** The English title for a code, for an export or a report; empty when the code has no entry. */
export function findingTitleEn(code: string): string {
  return findingCopy(code, "en")?.title ?? "";
}
