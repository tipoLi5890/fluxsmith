// SPDX-License-Identifier: Apache-2.0
// Composer bottom-row menus: the mode/policy chip (mode, approval policy, density, stream actions)
// and the model picker chip (models grouped by enabled provider, switch-cost warning).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { modelsFor } from "../../agent/models/catalog";
import { useT, type MessageKey } from "../../i18n";
import type { Mode, Policy, ProviderConfig } from "../../ipc/types";
import { Button, Dialog, Icon, Kbd, Tooltip } from "../components";
import type { IconName } from "../icons";
import { THINKING_LEVELS, type ThinkingLevel } from "../harness-bridge";

export type Density = "compact" | "detailed" | "developer";

export interface MenuEntry {
  id: string;
  label: string;
  icon?: IconName;
  checked?: boolean;
  disabled?: boolean;
  shortcut?: string;
  /** Section header rows are not selectable. */
  header?: boolean;
  /** Explains a disabled entry (rendered as a native tooltip and muted text). */
  hint?: string;
}

/** Anchored dropdown (opens below the trigger, flips above when there is no room). */
export function DropMenu({ open, anchor, entries, onSelect, onClose, ariaLabel }: { open: boolean; anchor: HTMLElement | null; entries: MenuEntry[]; onSelect: (id: string) => void; onClose: () => void; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 0;
    const below = r.bottom + 4 + h <= window.innerHeight;
    setPos(below ? { left: r.left, top: r.bottom + 4 } : { left: r.left, bottom: window.innerHeight - r.top + 4 });
  }, [open, anchor, entries.length]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && e.target !== anchor && !anchor?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", off); window.removeEventListener("keydown", key); };
  }, [open, onClose, anchor]);
  if (!open) return null;
  return (
    <div ref={ref} className="menu composer-menu" role="menu" aria-label={ariaLabel} style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}>
      {entries.map((it) => it.header ? (
        <div key={it.id} className="menu-group muted copy-sm">{it.label}</div>
      ) : (
        <button key={it.id} role="menuitemradio" aria-checked={it.checked ?? false} type="button" disabled={it.disabled} title={it.disabled ? it.hint : undefined} className={`menu-item ${it.checked ? "checked" : ""}`} onClick={() => { onSelect(it.id); onClose(); }}>
          <span className="menu-check">{it.checked ? <Icon name="done" className="icon-sm" /> : null}</span>
          {it.icon && <Icon name={it.icon} />}
          <span className="grow">{it.label}</span>
          {it.disabled && it.hint && <span className="muted copy-sm">{it.hint}</span>}
          {it.shortcut && <Kbd combo={it.shortcut} />}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- mode chip
export function ModeMenu({ mode, policy, density, hasPendingCard, shortcuts, running = false, blocked = {}, onMode, onPolicy, onDensity, onSearch, onJump, onCompact, onNewSession, onViewPlan }: {
  mode: Mode; policy: Policy; density: Density; hasPendingCard: boolean; shortcuts: Record<string, string>; /** A turn is running: switching mode would stop it, so the mode entries are disabled. */ running?: boolean;
  /** Modes the environment or the project refuses (UJ-0 / D-57), each with the reason shown on the disabled entry. */
  blocked?: Partial<Record<Mode, string>>;
  onMode: (m: Mode) => void; onPolicy: (p: Policy) => void; onDensity: (d: Density) => void; onSearch: () => void; onJump: () => void; onCompact: () => void; onNewSession?: () => void; onViewPlan?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const modeIcon: Record<Mode, IconName> = { plan: "plan", build: "building", review: "reviewing" };
  // The current mode is never disabled (picking it again does nothing); a blocked one carries its reason.
  const modeEntry = (m: Mode, en: string, icon: IconName, shortcut?: string): MenuEntry => ({
    id: `mode:${m}`,
    label: `${t(`mode.${m}` as MessageKey)} · ${en}`,
    icon,
    checked: mode === m,
    shortcut,
    disabled: mode !== m && (running || !!blocked[m]),
    hint: blocked[m] && mode !== m ? blocked[m] : t("chat.menuModeRunning"),
  });
  const entries: MenuEntry[] = [
    { id: "h-mode", label: t("chat.menuMode"), header: true },
    modeEntry("plan", "Plan", "plan", shortcuts.modePlan),
    modeEntry("build", "Build", "building", shortcuts.modeBuild),
    modeEntry("review", "Review", "reviewing", shortcuts.modeReview),
    { id: "h-policy", label: t("policy.label"), header: true },
    { id: "policy:ask", label: t("policy.ask"), checked: policy === "ask" },
    { id: "policy:review", label: t("policy.review"), checked: policy === "review" },
    { id: "policy:auto", label: t("policy.auto"), checked: policy === "auto" },
    { id: "h-density", label: t("chat.density"), header: true },
    { id: "density:compact", label: t("chat.densityCompact"), checked: density === "compact" },
    { id: "density:detailed", label: t("chat.densityDetailed"), checked: density === "detailed" },
    { id: "density:developer", label: t("chat.densityDeveloper"), checked: density === "developer" },
    { id: "h-actions", label: t("chat.menuActions"), header: true },
    { id: "act:search", label: t("chat.searchStream"), icon: "search" },
    { id: "act:jump", label: t("chat.jumpToCard"), icon: "waiting", disabled: !hasPendingCard, shortcut: shortcuts.jumpCard },
    { id: "act:compact", label: t("chat.compact"), icon: "cache", shortcut: shortcuts.compact },
    { id: "h-session", label: t("side.sessions"), header: true },
    { id: "act:newSession", label: t("side.newSession"), icon: "add", shortcut: shortcuts.newSession },
    { id: "act:viewPlan", label: t("chat.viewPlan"), icon: "plan" },
  ];
  const onSelect = (id: string) => {
    const [k, v] = id.split(":");
    if (k === "mode") onMode(v as Mode);
    else if (k === "policy") onPolicy(v as Policy);
    else if (k === "density") onDensity(v as Density);
    else if (v === "search") onSearch();
    else if (v === "jump") onJump();
    else if (v === "compact") onCompact();
    else if (v === "newSession") onNewSession?.();
    else if (v === "viewPlan") onViewPlan?.();
  };
  const modeLabel = t(`mode.${mode}` as MessageKey);
  const policyLabel = t(`policy.${policy}` as MessageKey);
  return (
    <>
      <Tooltip text={`${t(`mode.${mode}Hint` as MessageKey)} · ${t(`policy.${policy}Hint` as MessageKey)}`}>
        <button ref={btn} type="button" className={`composer-chip mode-${mode}`} aria-haspopup="menu" aria-expanded={open} aria-label={t("chat.menuMode")} onClick={() => setOpen((o) => !o)}>
          <Icon name={modeIcon[mode]} className="icon-sm" />
          <span>{modeLabel}</span>
          <span className="muted chip-secondary">· {policyLabel}</span>
          <Icon name="chevronDown" className="icon-sm muted" />
        </button>
      </Tooltip>
      <DropMenu open={open} anchor={btn.current} entries={entries} onSelect={onSelect} onClose={() => setOpen(false)} ariaLabel={t("chat.menuMode")} />
    </>
  );
}

// -------------------------------------------------------------- model chip
export interface ModelChoice { providerId: string; providerLabel: string; model: string; rateInput: number | null; kind: string }

export function listModelChoices(providers: ProviderConfig[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    if (!(p.has_secret || p.kind === "openai-codex")) continue;
    for (const m of modelsFor(p)) out.push({ providerId: p.id, providerLabel: p.label, model: m, rateInput: p.rates.every((r) => r === 0) ? null : p.rates[0], kind: p.kind });
  }
  return out;
}

/** Cost estimate for re-sending `usedTokens` of context to a model at `ratePerM` USD / 1M input tokens. */
export function resendCostUsd(usedTokens: number, ratePerM: number | null): number | null {
  if (ratePerM == null) return null;
  return (usedTokens / 1_000_000) * ratePerM;
}

export function ModelPicker({ providers, current, running, usedTokens, ceilingTokens, turnCount, inBuild, onPick, onOpenSettings, thinking = "medium", onThinking }: {
  providers: ProviderConfig[]; current: string | null; running: boolean; usedTokens: number; ceilingTokens: number; turnCount: number; inBuild: boolean;
  onPick: (id: string) => Promise<void>; onOpenSettings: () => void; thinking?: ThinkingLevel; onThinking?: (level: ThinkingLevel) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<ModelChoice | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const choices = listModelChoices(providers);
  const cur = choices.find((c) => `${c.providerId}/${c.model}` === current) ?? null;
  const entries: MenuEntry[] = [];
  let lastProvider = "";
  for (const c of choices) {
    if (c.providerId !== lastProvider) { entries.push({ id: `h-${c.providerId}`, label: c.providerLabel, header: true }); lastProvider = c.providerId; }
    entries.push({ id: `${c.providerId}/${c.model}`, label: c.model, checked: `${c.providerId}/${c.model}` === current });
  }
  entries.push({ id: "h-thinking", label: t("chat.thinkingLevel"), header: true });
  for (const lv of THINKING_LEVELS) entries.push({ id: `thinking:${lv}`, label: t(`chat.thinking.${lv}` as MessageKey), checked: thinking === lv });
  if (entries.length) entries.push({ id: "h-more", label: "", header: true });
  entries.push({ id: "settings", label: t("chat.modelSetup"), icon: "settings" });

  const pick = (id: string) => {
    if (id === "settings") { onOpenSettings(); return; }
    if (id.startsWith("thinking:")) { void onThinking?.(id.slice("thinking:".length) as ThinkingLevel); return; }
    if (id === current) return;
    const choice = choices.find((c) => `${c.providerId}/${c.model}` === id);
    if (!choice) return;
    const pct = ceilingTokens > 0 ? (usedTokens / ceilingTokens) * 100 : 0;
    if (pct > 20 || turnCount >= 2) setConfirm(choice);
    else void onPick(id);
  };
  const cost = confirm ? resendCostUsd(usedTokens, confirm.rateInput) : null;
  const modelLabel = cur ? cur.model : current ? current.split("/").slice(1).join("/") || current : t("chat.modelNone");
  const label = thinking !== "medium" ? `${modelLabel} · ${t(`chat.thinking.${thinking}` as MessageKey)}` : modelLabel;
  return (
    <>
      <Tooltip text={running ? t("chat.modelBusy") : t("chat.modelPicker")}>
        <button ref={btn} type="button" className="composer-chip model-chip" aria-haspopup="menu" aria-expanded={open} aria-label={t("chat.modelPicker")} disabled={running} onClick={() => setOpen((o) => !o)}>
          <Icon name="agent" className="icon-sm" />
          <span className="truncate">{label}</span>
          <Icon name="chevronDown" className="icon-sm muted" />
        </button>
      </Tooltip>
      <DropMenu open={open} anchor={btn.current} entries={entries} onSelect={pick} onClose={() => setOpen(false)} ariaLabel={t("chat.modelPicker")} />
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} title={t("chat.modelSwitchTitle", { model: confirm ? `${confirm.providerLabel} · ${confirm.model}` : "" })} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setConfirm(null)} autoFocus>{t("common.cancel")}</Button><Button variant="primary" onClick={() => { const c = confirm; setConfirm(null); if (c) void onPick(`${c.providerId}/${c.model}`); }}>{t("chat.modelSwitchConfirm")}</Button></>}>
        <p>{t("chat.modelSwitchBody", { tokens: Math.round(usedTokens / 1000) })}</p>
        <p>{cost != null ? t("chat.modelSwitchCost", { usd: cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}` }) : t("chat.modelSwitchCostUnknown")}</p>
        {inBuild && <p>{t("chat.modelSwitchBuild")}</p>}
        {confirm && cur && confirm.kind !== cur.kind && <p>{t("chat.modelSwitchTools")}</p>}
      </Dialog>
    </>
  );
}
