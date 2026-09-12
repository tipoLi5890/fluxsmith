// SPDX-License-Identifier: Apache-2.0
// Flat conversation stream: user bubbles on the right, everything the agent
// does (prose, tool activity, phase status, cards, notices) on the left, with
// a slim divider per turn. Turn numbers come from the harness only.
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ActivityLine, Card, Ref, Role } from "../../agent/api";
import { useT, useLang, fmtUsd, fmtDuration, fmtBytes, type MessageKey , hasKey } from "../../i18n";
import { detectLang } from "../../i18n/lang-detect";
import { Badge, Button, Callout, Chip, Icon } from "../components";
import { ErrorBlock } from "../components/ErrorBlock";
import { usePrefs } from "../../state/prefs";
import { useSettings } from "../../state/settings";
import { ThinkingOrb } from "../orbs/ThinkingOrb";
import { orbStateOf, phaseIcon, type UiPhase } from "../orb-state";
import type { ChatMessage, TurnBlock } from "../harness-bridge";
import { CardView } from "./CardView";
import { Markdown, RefChip } from "./Markdown";
import { byRoleList, emptyUsage, sumUsage, usageLine } from "./usage";
import { acceptanceFailedLines, acceptanceTally, addedItems, changedItems, movedItems, netLines, type NamedLine } from "./turn-lines";

type Density = "compact" | "detailed" | "developer";
/** `done_with_findings`: the turn finished its work and left unwaived engine Errors open. */
type Status = "done" | "done_with_findings" | "stopped" | "failed" | "running" | "rolled_back" | "pending";

export function statusOf(block: TurnBlock, isCurrent: boolean): Status {
  if (block.rolled_back) return "rolled_back";
  if (block.summary) return block.summary.outcome === "rolled_back" ? "rolled_back" : block.summary.outcome;
  if (block.error) return "failed";
  return isCurrent ? "running" : "done";
}

export function TurnDivider({ block, status, elapsedMs }: { block: TurnBlock; status: Status; elapsedMs: number }) {
  const t = useT();
  // Budgets off in settings: the header keeps the token count and drops the price (same rule as TurnUsage).
  const showCost = useSettings((st) => st.settings.agent.budget_enabled);
  const meter = [showCost && block.cost_usd > 0 ? fmtUsd(block.cost_usd) : "", block.tokens > 0 ? fmtTokens(block.tokens) : ""].filter(Boolean);
  const tone = status === "failed" ? "error" : status === "done" ? "success" : status === "done_with_findings" ? "warning" : status === "running" ? "info" : "neutral";
  const reason = block.error ? `${block.error.code}: ${block.error.message}` : undefined;
  return (
    <div className={`turn-divider ${status === "rolled_back" ? "rolled" : ""}`} role="separator" aria-label={t("chat.turn", { n: block.turn })}>
      <span className="turn-divider-line" />
      <span className="turn-divider-text">
        <span className="fs-mono">{t("chat.turn", { n: block.turn })}</span>
        <Badge tone={tone}>{t(`side.turnStatus.${status === "pending" ? "running" : status}` as MessageKey)}</Badge>
        {/* Why it failed is plain text, not a hover-only tooltip (a badge takes no focus, so a tooltip hid it). */}
        {reason && <span className="turn-divider-reason muted truncate" title={reason}>{reason}</span>}
        <span className="muted num">{block.summary ? fmtDuration(block.summary.duration_ms) : status === "running" ? fmtDuration(elapsedMs) : ""}</span>
        {meter.length > 0 && <span className="muted num"><Icon name="cost" className="icon-sm" /> {meter.join(" · ")}</span>}
      </span>
      <span className="turn-divider-line" />
    </div>
  );
}

function refLabel(r: { kind: string; [k: string]: unknown }): string {
  switch (r.kind) {
    case "component": return String(r.ref);
    case "net": return String(r.name);
    case "sheet": return String(r.path);
    case "block": return String(r.group);
    case "region": return "region";
    case "turn": return `#${String(r.turn)}`;
    case "finding": return String(r.code);
    case "attachment": return String(r.label);
    default: return r.kind;
  }
}

export function UserBubble({ m, pending }: { m: ChatMessage; pending?: boolean }) {
  const t = useT();
  const ui = useLang();
  return (
    <div className={`bubble-row right ${pending ? "pending" : ""}`}>
      <div className="bubble bubble-user selectable" lang={detectLang(m.text, ui, null)}>
        <div className="bubble-text">{m.text}</div>
        {m.refs && m.refs.length > 0 && <div className="row wrap chips">{m.refs.map((r, i) => <Chip key={i} icon={r.kind === "attachment" ? "attachment" : r.kind === "net" ? "net" : r.kind === "sheet" ? "sheet" : r.kind === "turn" ? "turn" : "component"}>{refLabel(r)}</Chip>)}</div>}
        {pending && <div className="muted copy-sm bubble-meta"><ThinkingOrb state="working" size={12} /> {t("chat.pendingSend")}</div>}
      </div>
    </div>
  );
}

function AssistantBubble({ m }: { m: ChatMessage }) {
  const ui = useLang();
  const t = useT();
  return (
    <div className="bubble-row left">
      <div className="bubble bubble-assistant" lang={detectLang(m.text, ui, null)}>
        <Markdown text={m.text} />
        {m.streaming && <span className="muted copy-sm bubble-meta"><ThinkingOrb state="working" size={12} /> {t("chat.streaming")}</span>}
      </div>
    </div>
  );
}

function SystemNotice({ m }: { m: ChatMessage }) {
  const t = useT();
  return (
    <div className={`notice notice-${m.severity ?? "info"}`} role="status">
      <Icon name={m.severity === "error" ? "failed" : m.severity === "warning" ? "warning" : "info"} className="icon-sm" />
      <span>{m.text_key ? t(m.text_key as MessageKey, m.params) : m.text}</span>
    </div>
  );
}

function fmtTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

function ActivityRow({ line, density, children, nested }: { line: ActivityLine; density: Density; children?: ActivityLine[]; nested?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const live = !line.ended_at;
  const ms = live ? Date.now() - new Date(line.started_at).getTime() : new Date(line.ended_at as string).getTime() - new Date(line.started_at).getTime();
  const secs = ms >= 1000 ? `${(ms / 1000).toFixed(live ? 0 : 1)} s` : "";
  const thinking = line.kind === "thinking";
  // Tool ids become human labels when the catalogue has one (`tool.sch.apply` = "Applying to the schematic"); the id stays as fallback.
  const label = thinking ? t("chat.thinkingLine", { s: Math.round(ms / 1000), tokens: fmtTokens(line.tokens ?? 0) }) : hasKey(`tool.${line.label}`) ? t(`tool.${line.label}` as MessageKey) : line.label;
  const kids = children ?? [];
  return (
    <>
      <div className={`activity ${live ? "live" : ""} ${nested ? "nested" : ""} ${thinking ? "thinking" : ""}`}>
        {kids.length > 0 ? <button type="button" className="activity-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="chevronRight" className={`icon-sm chev ${open ? "open" : ""}`} /></button> : null}
        {live ? <ThinkingOrb state={thinking ? "working" : "working"} size={14} /> : <Icon name={line.ok === false ? "failed" : "done"} className={`icon-sm ${line.ok === false ? "bad" : "muted"}`} />}
        <span className={thinking ? "muted" : "fs-mono"}>{label}</span>
        {/* A failed call always says why, at every density (the detail carries the engine / provider reason);
            on a successful line the detail is extra context and stays out of the compact density. */}
        {!thinking && line.detail && (line.ok === false || density !== "compact") && (
          <span className={`truncate ${line.ok === false ? "bad" : "muted"}`} title={line.detail}>{line.detail}</span>
        )}
        <span className="grow" />
        {kids.length > 0 && <span className="muted copy-sm num">{t("chat.calls", { n: kids.length })}</span>}
        {line.role !== "lead" && !nested && <span className="muted copy-sm">{roleLabel(t, line.role)}</span>}
        {line.bytes != null && density === "developer" && <span className="muted copy-sm">{fmtBytes(line.bytes)}</span>}
        {!thinking && secs && <span className={`muted copy-sm num ${live ? "live-clock" : ""}`}>{secs}</span>}
      </div>
      {open && kids.map((k) => <ActivityRow key={k.id} line={k} density={density} nested />)}
    </>
  );
}

/** All tool activity of a turn as one collapsible group; open while the turn runs. */
function ActivityGroup({ acts, running, density }: { acts: ActivityLine[]; running: boolean; density: Density }) {
  const t = useT();
  const [open, setOpen] = useState(running);
  useEffect(() => { if (running) setOpen(true); else setOpen(false); }, [running]);
  if (!acts.length) return null;
  const failed = acts.filter((a) => a.ok === false).length;
  // Child lines (a subagent's own calls) nest under their parent; the group counts top-level lines only.
  const top = acts.filter((a) => !a.parent_id);
  const kidsOf = (id: string) => acts.filter((a) => a.parent_id === id);
  const liveTop = top.filter((a) => !a.ended_at);
  // The group collapses itself when the turn ends, so the head carries the first failure's reason: a failed
  // call never becomes invisible just because the turn finished.
  const firstFailed = acts.find((a) => a.ok === false);
  const failReason = firstFailed ? [firstFailed.label, firstFailed.detail].filter(Boolean).join(" · ") : "";
  return (
    <div className="bubble-row left">
      <div className="activity-group">
        <button type="button" className="activity-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name="chevronRight" className={`icon-sm chev ${open ? "open" : ""}`} />
          <span>{t("chat.actions", { n: top.length })}</span>
          {failed > 0 && <Badge tone="error">{failed}</Badge>}
          {!open && (failReason
            ? <span className="bad truncate copy-sm" title={failReason}>{failReason}</span>
            : <span className="muted truncate copy-sm">{(liveTop.length ? liveTop : top.slice(-3)).map((a) => a.label).join(" · ")}</span>)}
        </button>
        {open && <div className="activity-body">{top.map((a) => <ActivityRow key={a.id} line={a} density={density} children={kidsOf(a.id)} />)}</div>}
      </div>
    </div>
  );
}

/**
 * Role name. Every `Role` of `agent/api.ts` has a `settings.models.role.<role>` entry in all four
 * catalogues (the i18n lint checks that family), but the id arrives at runtime from the harness:
 * a role this build does not know keeps its id instead of rendering a raw key.
 */
function roleLabel(t: ReturnType<typeof useT>, role: Role): string {
  return hasKey(`settings.models.role.${role}`) ? t(`settings.models.role.${role}` as MessageKey) : role;
}

/** Phase name, guarded the same way (`phase.<phase>` covers `UiPhase`; an unknown one keeps its id). */
function phaseLabel(t: ReturnType<typeof useT>, phase: UiPhase): string {
  return hasKey(`phase.${phase}`) ? t(`phase.${phase}` as MessageKey) : phase;
}

/**
 * Tokens / cost / cache hit of the turn (message-stream-ux.md §1, caching-strategy.md §6): the total,
 * then one entry per role once more than one role worked. Numbers come from the harness `usage` events,
 * the same per-call rows the cost report aggregates. Budgets off in settings (`agent.budget_enabled`)
 * hides the price and keeps the tokens; a turn restored from its summary has totals but no hit ratio.
 */
export function TurnUsage({ block }: { block: TurnBlock }) {
  const t = useT();
  const lang = useLang();
  const showCost = useSettings((s) => s.settings.agent.budget_enabled);
  const roles = byRoleList(block.usageByRole);
  if (!roles.length) {
    if (!block.tokens) return null;
    const restored = { ...emptyUsage(), input: block.tokens, cost_usd: block.cost_usd, calls: 1 };
    return (
      <div className="bubble-row left turn-usage" aria-label={t("chat.usageTitle")}>
        <span className="muted copy-sm num"><Icon name="cost" className="icon-sm" /> {usageLine(restored, { t, lang, showCost, showCache: false })}</span>
      </div>
    );
  }
  const total = sumUsage(roles.map((r) => r.usage));
  return (
    <div className="bubble-row left turn-usage" aria-label={t("chat.usageTitle")}>
      <span className="muted copy-sm num"><Icon name="cost" className="icon-sm" /> {usageLine(total, { t, lang, showCost, note: true })}</span>
      {roles.length > 1 && roles.map((r) => (
        <span key={r.role} className="muted copy-sm num">{roleLabel(t, r.role)} {usageLine(r.usage, { t, lang, showCost, compact: true })}</span>
      ))}
    </div>
  );
}

/**
 * Every finished phase of the turn as one compact line (message-stream-ux.md §1: explore -> build -> fix -> review
 * stays readable after the turn); the live phase is the PhaseLine below. Thinking phases are folded into their
 * neighbours (their tokens show on the live line), single-phase turns show nothing extra.
 */
function PhaseHistory({ block }: { block: TurnBlock }) {
  const t = useT();
  const lang = useLang();
  const showCost = useSettings((st) => st.settings.agent.budget_enabled);
  const done = block.phases.filter((p) => p.ended_at && p.phase !== "thinking");
  if (done.length < 2 && !(done.length === 1 && block.phases.some((p) => !p.ended_at))) return null;
  return (
    <div className="phase-history">
      {done.map((p) => {
        const ms = new Date(p.ended_at as string).getTime() - new Date(p.started_at).getTime();
        const phase = (p.phase === "stopped" ? "failed" : p.phase) as UiPhase;
        const roleName = p.role !== "lead" ? roleLabel(t, p.role) : "";
        const failed = p.activities.filter((a) => a.ok === false).length;
        // One line per finished phase; the full text (a long block name) stays available as the tooltip.
        const line = `${phaseLabel(t, phase)}${p.detail ? ` · ${p.detail}` : ""}${roleName ? ` · ${roleName}` : ""}`;
        return (
          <div key={p.id} className={`bubble-row left phase-line done phase-${p.phase}`}>
            <Icon name={phaseIcon(phase)} className="icon-sm muted" />
            <span className="phase-title truncate muted" title={line}>{line}</span>
            {p.activities.length > 0 && <span className="muted copy-sm">{t("chat.actions", { n: p.activities.length })}</span>}
            {failed > 0 && <Badge tone="error">{failed}</Badge>}
            {p.usage && <span className="muted copy-sm num">{usageLine(p.usage, { t, lang, showCost, compact: true })}</span>}
            <span className="muted copy-sm num">{fmtDuration(ms)}</span>
          </div>
        );
      })}
    </div>
  );
}

function PhaseLine({ block, retrying, elapsedMs }: { block: TurnBlock; retrying: { i: number; n: number } | null; elapsedMs: number }) {
  const t = useT();
  const last = block.phases[block.phases.length - 1];
  if (!last || last.ended_at) return null;
  const phase = last.phase as UiPhase;
  const orb = orbStateOf(phase, { retrying: !!retrying });
  // Cumulative tokens received over the whole turn so far (every phase, thinking and streaming
  // lines): a number that keeps growing reads as "still working" far better than a rate.
  // Provider-reported usage of every finished call (input + cache + output, from `budget` events)
  // plus the character-based estimate of whatever is still streaming.
  const inFlight = block.phases.reduce((n, p) => n + p.activities.filter((a) => !a.ended_at).reduce((m, a) => m + (a.tokens ?? 0), 0), 0);
  const tokens = (block.tokens ?? 0) + inFlight;
  const phaseSecs = Math.round((Date.now() - new Date(last.started_at).getTime()) / 1000);
  const roleName = last.role !== "lead" ? roleLabel(t, last.role) : "";
  const title = phase === "thinking"
    ? t("phase.thinkingDetail", { s: Math.round(elapsedMs / 1000), tokens: fmtTokens(tokens) })
    : last.detail
      ? t("phase.workingOn", { phase: phaseLabel(t, phase), what: last.detail, role: roleName || t("settings.models.role.lead") })
      : `${phaseLabel(t, phase === "stopped" ? "failed" : phase)}${roleName ? ` · ${roleName}` : ""}`;
  return (
    <div className={`bubble-row left phase-line phase-${phase}`} aria-live="polite">
      {orb !== "none" ? <ThinkingOrb state={orb} size={20} /> : <Icon name={phaseIcon(phase)} />}
      <span className="phase-title truncate" title={title}>{title}</span>
      {phase !== "thinking" && phaseSecs >= 3 && <span className="muted copy-sm num">{phaseSecs} s{tokens ? ` · ${t("chat.tokensSoFar", { tokens: fmtTokens(tokens) })}` : ""}</span>}
      {retrying && <Badge tone="warning">{t("chat.retrying", { i: retrying.i, n: retrying.n })}</Badge>}
      {last.status && <span className="muted copy-sm truncate" title={last.status}>· {last.status}</span>}
      {elapsedMs > 120000 && <span className="muted copy-sm">{t("chat.continueInBackground")}</span>}
    </div>
  );
}

/** Refs a turn's applies point at (engine focus per apply); falls back to the sheets written. */
export function appliedRefs(block: TurnBlock): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  for (const a of block.applied) for (const r of a.focus ?? []) { const k = JSON.stringify(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
  if (!out.length) for (const sheet of block.summary?.applied.sheets ?? []) out.push({ kind: "sheet", path: sheet });
  return out;
}

// Shared with the turn summary card (CardView): the same lines from one source.
export { addedLine, changedLine, netLines, FOOTER_ITEMS_MAX } from "./turn-lines";

/**
 * A turn-summary line whose names are reference chips: "added R5, C7, U2" is the list of things to
 * go and look at, so each name points the canvas at the object the engine reported (its own sheet
 * included). The wording around the names stays the catalogue's.
 */
function NamedLineView({ line }: { line: NamedLine }) {
  return (
    <span className="muted copy-sm fs-mono selectable">
      {line.lead}
      {line.items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 ? ", " : ""}
          {it.ref ? <RefChip target={it.ref} label={it.text} /> : it.text}
        </Fragment>
      ))}
      {line.more > 0 ? ` +${line.more}` : ""}
      {line.tail}
    </span>
  );
}

export function TurnGroupView({ block, cards, projectKey, sessionId, density, isCurrent, onAnswer, onRollback, onContinue, onSaveRule, onShowOnCanvas, retrying, hasPlan = false, measure }: {
  hasPlan?: boolean; sessionId?: string | null; measure?: (el: HTMLElement | null) => void; onShowOnCanvas?: (refs: Ref[]) => void;
  block: TurnBlock; cards: Record<string, Card>; projectKey: string; density: Density; isCurrent: boolean;
  onAnswer: (card_id: string, action_id: string, free_text?: string, consent_event_id?: string) => Promise<void>;
  onRollback: (turn: number) => void; onContinue: () => void; onSaveRule: () => void; retrying: { i: number; n: number } | null;
}) {
  const t = useT();
  const prefs = usePrefs();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isCurrent || block.summary) return;
    const start = block.started_at ? new Date(block.started_at).getTime() : Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - start), 1000);
    return () => window.clearInterval(id);
  }, [isCurrent, block.started_at, block.summary]);
  const status = statusOf(block, isCurrent);
  const users = block.messages.filter((m) => m.kind === "user");
  const running = isCurrent && !block.summary;
  // Body in arrival order: consecutive activities collapse into one group. Turns restored from
  // summaries only (no items) fall back to the legacy phases/messages order.
  const rows = useMemo(() => {
    const acts = new Map(block.phases.flatMap((p) => p.activities).map((a) => [a.id, a]));
    const msgs = new Map(block.messages.map((m) => [m.id, m]));
    const items = block.items.length ? block.items : [
      ...block.phases.flatMap((p) => p.activities).map((a, i) => ({ seq: i, kind: "activity" as const, id: a.id })),
      ...block.messages.filter((m) => m.kind !== "user").map((m, i) => ({ seq: 100000 + i, kind: "message" as const, id: m.id })),
      ...block.phases.flatMap((p) => p.cards).map((id, i) => ({ seq: 200000 + i, kind: "card" as const, id })),
      ...(block.error ? [{ seq: 300000, kind: "error" as const, id: "error" }] : []),
    ];
    const out: ({ kind: "activities"; key: string; acts: ActivityLine[] } | { kind: "message"; key: string; m: ChatMessage } | { kind: "card"; key: string; id: string } | { kind: "error"; key: string })[] = [];
    for (const it of [...items].sort((a, b) => a.seq - b.seq)) {
      if (it.kind === "activity") {
        const a = acts.get(it.id); if (!a) continue;
        const last = out[out.length - 1];
        if (last && last.kind === "activities") last.acts.push(a); else out.push({ kind: "activities", key: `acts-${it.seq}`, acts: [a] });
      } else if (it.kind === "message") {
        const m = msgs.get(it.id); if (m && m.kind !== "user") out.push({ kind: "message", key: m.id, m });
      } else if (it.kind === "card") out.push({ kind: "card", key: it.id, id: it.id });
      else out.push({ kind: "error", key: "error" });
    }
    // The plan card is the turn's hand-off to the human: always the last thing in the turn.
    const planRows = out.filter((r) => r.kind === "card" && cards[r.id]?.kind === "plan_approval");
    return planRows.length ? [...out.filter((r) => !planRows.includes(r)), ...planRows] : out;
  }, [block.items, block.phases, block.messages, block.error, cards]);
  const lastActs = useMemo(() => { const g = [...rows].reverse().find((r) => r.kind === "activities"); return g && g.kind === "activities" ? g.key : null; }, [rows]);
  // What the turn drew and changed, by name; a rolled-back turn drew nothing that is still there.
  const reported = block.summary && status !== "rolled_back" ? block.summary.applied : null;
  const added = reported ? addedItems(reported.created, t) : null;
  const changed = reported ? changedItems(reported.changed, t) : null;
  const moved = reported ? movedItems(reported.changed, t) : null;
  return (
    <section ref={measure} id={`turn-${block.turn}`} className={`turn-group ${status === "rolled_back" ? "rolled" : ""}`} aria-label={t("chat.turn", { n: block.turn })}>
      {block.turn > 0 && <TurnDivider block={block} status={status} elapsedMs={elapsed} />}
      {users.map((m) => <UserBubble key={m.id} m={m} />)}
      {block.headline && block.kind === "instruction" && (
        <div className="bubble-row left"><div className="announce">
          <div>{t("chat.willDo", { headline: block.headline })}</div>
          {block.envelope && <div className="muted copy-sm">{t("chat.scope", { sheets: block.envelope.sheets.join(", ") || "root", add: block.envelope.components_added_max, del: block.envelope.components_deleted_max })}</div>}
        </div></div>
      )}
      {rows.map((r) => {
        if (r.kind === "activities") return <ActivityGroup key={r.key} acts={r.acts} running={running && r.key === lastActs} density={density} />;
        if (r.kind === "message") return r.m.kind === "system" ? <SystemNotice key={r.key} m={r.m} /> : <AssistantBubble key={r.key} m={r.m} />;
        if (r.kind === "card") return cards[r.id] ? <div key={r.key} className="bubble-row left card-row"><CardView card={cards[r.id]} projectKey={projectKey} sessionId={sessionId} onAnswer={onAnswer} /></div> : null;
        return block.error ? <div key={r.key} className="bubble-row left"><ErrorBlock error={block.error} /></div> : null;
      })}
      <PhaseHistory block={block} />
      {running && <PhaseLine block={block} retrying={retrying} elapsedMs={elapsed} />}
      {running && <TurnUsage block={block} />}
      {block.budget && block.budget.warn && <div className="bubble-row left"><Callout tone="warning">{t("chat.budgetWarn", { pct: block.budget.limits.usd ? Math.round((block.budget.used.usd / block.budget.limits.usd) * 100) : block.budget.limits.tokens ? Math.round((block.budget.used.tokens / block.budget.limits.tokens) * 100) : 0 })}</Callout></div>}
      {block.summary && status !== "rolled_back" && block.turn === 1 && !prefs.dismissedTips.firstSummary && (
        <div className="bubble-row left"><Callout tone="info" actions={<Button size="sm" variant="ghost" onClick={() => prefs.dismissTip("firstSummary")}>{t("common.dontShowAgain")}</Button>}>{t("tips.firstSummary")}</Callout></div>
      )}
      {/* What was drawn and what was changed, by name: counts alone never say which parts they were. */}
      {(added || changed || moved) && (
        <div className="bubble-row left turn-changes">
          {added && <NamedLineView line={added} />}
          {changed && <NamedLineView line={changed} />}
          {moved && <NamedLineView line={moved} />}
        </div>
      )}
      {block.summary && status !== "rolled_back" && netLines(block.summary.applied.nets, t).length > 0 && (
        <div className="bubble-row left turn-nets">
          {netLines(block.summary.applied.nets, t).map((line, i) => <span key={i} className="muted copy-sm fs-mono selectable">{line}</span>)}
        </div>
      )}
      {/* Acceptance items the engine could not confirm, named: the counts alone never say which. */}
      {block.summary && status !== "rolled_back" && acceptanceFailedLines(block.summary.acceptance).length > 0 && (
        <div className="bubble-row left turn-acceptance" role="group" aria-label={t("chat.summaryAcceptanceFailed")}>
          <span className="copy-sm">{t("chat.summaryAcceptanceFailed")}</span>
          {acceptanceFailedLines(block.summary.acceptance).map((line, i) => <span key={i} className="muted copy-sm fs-mono selectable">{line}</span>)}
        </div>
      )}
      {/* What the engine drew differently from what the op-list authored: its own code and sentence,
          untrusted text in a text node (red line 21). A report, never a verdict (red line 6). */}
      {block.summary && status !== "rolled_back" && (block.summary.applied.warnings?.length ?? 0) > 0 && (
        <div className="bubble-row left turn-warnings" role="group" aria-label={t("chat.turnWarnings")}>
          <span className="copy-sm">{t("chat.turnWarnings")}</span>
          {(block.summary.applied.warnings ?? []).map((w, i) => (
            <span key={i} className="muted copy-sm fs-mono selectable">{w.code}{w.sheet ? ` \u00b7 ${w.sheet}` : ""}: {w.message}</span>
          ))}
        </div>
      )}
      {block.summary && status !== "rolled_back" && <TurnUsage block={block} />}
      {block.summary && status !== "rolled_back" && (
        <div className="bubble-row left turn-foot">
          {(block.summary.applied.components_added > 0 || block.summary.applied.components_deleted > 0 || block.summary.applied.wires_added > 0 || (block.summary.applied.power_ports_added ?? 0) > 0) && (
            // Power ports are net anchors, not parts: they are counted apart so "+4 components" means four parts.
            <span className="muted copy-sm fs-mono">{t("chat.summaryComponents", { add: block.summary.applied.components_added, del: block.summary.applied.components_deleted })}{(block.summary.applied.power_ports_added ?? 0) > 0 ? ` · ${t("chat.summaryPowerPorts", { n: block.summary.applied.power_ports_added ?? 0 })}` : ""} · {t("chat.summaryWires", { n: block.summary.applied.wires_added })}{block.summary.applied.sheets.length ? ` · ${t("chat.summarySheets", { sheets: block.summary.applied.sheets.join(", ") })}` : ""}</span>
          )}
          {block.applied.length > 0 && onShowOnCanvas && <Button size="sm" variant="ghost" icon="focus" onClick={() => onShowOnCanvas(appliedRefs(block))}>{t("chat.showOnCanvas")}</Button>}
          {block.findings.length > 0 && <span className="muted copy-sm">{t("chat.summaryFindings", { e: block.findings.filter((f) => String((f as { severity?: string }).severity).toLowerCase() === "error").length, w: block.findings.filter((f) => String((f as { severity?: string }).severity).toLowerCase() === "warning").length })}</span>}
          {/* KiCad's own ERC, separate from the engine's counts. Not available says so: silence would read as clean. */}
          {block.summary.kicad && <span className="muted copy-sm">{block.summary.kicad.available ? t("chat.summaryKicad", { e: block.summary.kicad.errors, w: block.summary.kicad.warnings }) : t("chat.summaryKicadMissing")}</span>}
          {/* The plan's own acceptance, measured from engine results at the gate step (a report, not a gate). */}
          {block.summary.acceptance && block.summary.acceptance.length > 0 && <span className="muted copy-sm">{t("chat.summaryAcceptance", acceptanceTally(block.summary.acceptance))}{acceptanceTally(block.summary.acceptance).advisory > 0 ? ` · ${t("chat.summaryAcceptanceAdvisory", { n: acceptanceTally(block.summary.acceptance).advisory })}` : ""}</span>}
          <span className="grow" />
          {block.summary.checkpoint != null && <Button size="sm" variant="ghost" icon="rollback" onClick={() => onRollback(block.turn)}>{t("chat.revertBefore", { n: block.turn })}</Button>}
          {/* A gate step that left findings still finished its work: the plan goes on, it is not retried. */}
          {block.kind === "instruction" && hasPlan && (block.summary.outcome === "done" || block.summary.outcome === "done_with_findings" || block.summary.outcome === "failed" || block.summary.outcome === "stopped") && <Button size="sm" variant="ghost" icon="play" onClick={onContinue}>{block.summary.outcome === "done" || block.summary.outcome === "done_with_findings" ? t("chat.continueNext") : t("chat.retryStep")}</Button>}
          <Button size="sm" variant="ghost" icon="skill" onClick={onSaveRule}>{t("chat.saveAsRule")}</Button>
        </div>
      )}
      {status === "rolled_back" && <div className="turn-divider rolled-note"><span className="turn-divider-line" /><span className="turn-divider-text muted"><Icon name="rollback" className="icon-sm" /> {t("chat.rolledBackDivider", { n: block.turn })}</span><span className="turn-divider-line" /></div>}
    </section>
  );
}
