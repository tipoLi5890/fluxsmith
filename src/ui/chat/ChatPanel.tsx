// SPDX-License-Identifier: Apache-2.0
// Right column: message stream (turn groups with cards inline), composer with menus.
import { newSession } from "../sessions";
import { effectiveLead } from "../../agent/models/catalog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UserMessage } from "../../agent/api";
import { errorCopy, useT } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { AttachInfo, Mode, Policy } from "../../ipc/types";
import { usePrefs } from "../../state/prefs";
import { useToasts } from "../../state/toasts";
import { useSettings } from "../../state/settings";
import { blockedModes, useEnv } from "../../state/env";
import { useProjects, type ProjectTab } from "../../state/projects";
import { Button, Callout, Dialog, EmptyState, Icon } from "../components";
import { AutoConfirmProvider, AutoPolicyDialog } from "../components/AutoPolicyDialog";
import type { BridgeStore, ThinkingLevel } from "../harness-bridge";
import { effectiveShortcuts } from "../shortcuts/keymap";
import { Composer } from "./Composer";
import { TurnGroupView, UserBubble } from "./StreamView";
import { RollbackDialog } from "./RollbackDialog";
import { useWindowed } from "./useWindowed";

export function ChatPanel({ tab, bridge, requestedMode, onModeConsumed, onSaveRule, onFocusCanvas }: { tab: ProjectTab; bridge: BridgeStore; requestedMode: Mode | null; onModeConsumed: () => void; onSaveRule: () => void; /** Frame refs on the canvas the way a sidebar click does (one-shot select + zoom). */ onFocusCanvas?: (refs: import("../../agent/api").Ref[]) => void }) {
  const t = useT();
  const { settings, update } = useSettings();
  const prefs = usePrefs();
  const toasts = useToasts();
  const { setFlags } = useProjects();
  const st = bridge((s) => s.state);
  const turns = bridge((s) => s.turns);
  const cards = bridge((s) => s.cards);
  const pendingId = bridge((s) => s.pendingCardId);
  const context = bridge((s) => s.context);
  const retrying = bridge((s) => s.retrying);
  const { send, stop, setMode, setPolicy, answerCard, rollbackBefore, compact, setLeadModel, setThinkingLevel, focusRefs } = bridge.getState();
  const planView = bridge((s) => s.plan);
  const thinking = bridge((s) => s.thinkingLevel);
  const pending = bridge((s) => s.pending);
  const findings = bridge((s) => s.findings);
  // What rides along with the next message: the canvas selection, unless the human turned the
  // setting off or dismissed the pill for this one message.
  const selection = bridge((s) => s.selection);
  const selectionSkipped = bridge((s) => s.selectionSkipped);
  const skipSelectionOnce = bridge.getState().skipSelectionOnce;
  const attachedSelection = settings.agent.chat_attach_selection && !selectionSkipped ? selection : [];
  const bridgeLead = bridge((s) => s.leadModel);
  const effective = effectiveLead(settings);
  const leadModel = effective ? `${effective.provider.id}/${effective.model}` : bridgeLead;
  const [buildConsent, setBuildConsent] = useState(false);
  const [shellConsent, setShellConsent] = useState(false);
  const [autoConsent, setAutoConsent] = useState(false);
  const [rollbackTurn, setRollbackTurn] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<AttachInfo[]>([]);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);
  const windowed = useWindowed(streamRef, turns.map((b) => b.turn));
  const density = settings.agent.chat_density;
  const shortcutDefs = effectiveShortcuts(settings.shortcuts);
  const sendCombo = shortcutDefs.find((d) => d.action === "send")?.combo ?? "Mod+Enter";
  const attachCombo = shortcutDefs.find((d) => d.action === "attach")?.combo ?? "Mod+Shift+A";
  const shortcutMap: Record<string, string> = Object.fromEntries(shortcutDefs.filter((d) => !!d.combo).map((d) => [d.action, d.combo as string]));

  useEffect(() => { setFlags(tab.key, { running: st.running, needsYou: !!pendingId }); }, [st.running, pendingId, tab.key, setFlags]);
  useEffect(() => {
    if (!isTauri()) return;
    call("db_query", { query: { kind: "attachment_list", project_key: tab.key } }).then((r) => setAttachments((r as AttachInfo[]) ?? [])).catch(() => undefined);
  }, [tab.key, turns.length]);
  // Follow the stream while the user is at the bottom; otherwise offer a "jump to latest" pill.
  const [stick, setStick] = useState(true);
  const onStreamScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };
  useEffect(() => {
    const el = streamRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [turns, pending, stick]);
  const jumpLatest = () => { const el = streamRef.current; if (el) { el.scrollTop = el.scrollHeight; setStick(true); } };

  // UJ-0 / D-57: which modes this environment and this project allow, and the code that says why.
  // Rust refuses the same things again (`build_session_open`, `sidecar_write`).
  const envReport = useEnv((s) => s.report);
  const noPro = !!tab.info.no_pro;
  const blocked = blockedModes(isTauri() ? envReport : null, noPro);
  const blockedHints: Partial<Record<Mode, string>> = Object.fromEntries(
    Object.entries(blocked).map(([m, code]) => [m, errorCopy(code)?.title ?? code]),
  );
  const modeBlock = blocked[st.mode];
  // Set when a message was refused because the current mode needs an environment that is not ready.
  const [envBlockedSend, setEnvBlockedSend] = useState(false);
  useEffect(() => { if (!modeBlock) setEnvBlockedSend(false); }, [modeBlock]);
  const requestMode = useCallback((mode: Mode) => {
    if (mode === st.mode) return;
    const reason = blocked[mode];
    if (reason) {
      // Shortcuts reach this without going through the (disabled) menu entry.
      toasts.push({ tone: "warning", text: errorCopy(reason)?.title ?? reason });
      return;
    }
    if (mode === "build") setBuildConsent(true);
    else void setMode(mode);
  }, [st.mode, setMode, blocked.plan, blocked.build, blocked.review, toasts]);
  useEffect(() => { if (requestedMode) { requestMode(requestedMode); onModeConsumed(); } }, [requestedMode, requestMode, onModeConsumed]);

  const confirmBuild = async () => {
    let cid: string | undefined;
    if (isTauri()) cid = (await call("consent_record", { event: { project_key: tab.key, card_kind: "enter_build", payload_sha256: tab.info.root_uuid, input_kind: "click" } })).id;
    await setMode("build", cid ?? "dev");
    setBuildConsent(false);
    if (!prefs.dismissedTips.firstBuild) prefs.dismissTip("firstBuild");
  };
  // D-57: write `<stem>.kicad_pro`, the lib tables and a `.gitignore` next to the standalone sheet,
  // then reopen it as a project. Structural, so a consent event is recorded first.
  const confirmShell = async () => {
    try {
      const cid = isTauri()
        ? (await call("consent_record", { event: { project_key: tab.key, card_kind: "project_shell_create", payload_sha256: tab.info.root_uuid, input_kind: "click" } })).id
        : "dev";
      if (isTauri()) await call("project_shell_create", { sheet: `${tab.info.root}/${tab.info.root_sheet}`, consent_event_id: cid });
      setShellConsent(false);
      await useProjects.getState().refresh(tab.key);
    } catch (e) {
      setShellConsent(false);
      toasts.pushError(e);
    }
  };
  const requestPolicy = (p: Policy) => { if (p === "auto") setAutoConsent(true); else void setPolicy(p); };
  const confirmAuto = async () => {
    let cid: string | undefined;
    if (isTauri()) cid = (await call("consent_record", { event: { project_key: tab.key, card_kind: "policy_auto", payload_sha256: tab.info.root_uuid, input_kind: "click" } })).id;
    await setPolicy("auto", cid ?? "dev");
    setAutoConsent(false);
  };
  const doRollback = async (turn: number, opts?: { state_sha256?: string }) => {
    let cid = "dev";
    if (isTauri()) cid = (await call("consent_record", { event: { project_key: tab.key, card_kind: "rollback", payload_sha256: String(turn), input_kind: "click" } })).id;
    // A refused rollback (ROLLBACK_STALE: the project changed since the preview) keeps the dialog
    // open with the reason; the code goes back to it.
    const code = await rollbackBefore(turn, cid, opts);
    if (!code) setRollbackTurn(null);
    return code;
  };
  useEffect(() => {
    const h = (e: Event) => { const d = (e as CustomEvent<string>).detail; if (typeof d === "string") setPrefill(d); };
    document.addEventListener("fs:composer-prefill", h);
    return () => document.removeEventListener("fs:composer-prefill", h);
  }, []);
  const jumpToCard = () => { if (pendingId) document.getElementById(`card-${pendingId}`)?.scrollIntoView({ block: "center" }); };
  const onSend = async (m: UserMessage) => {
    // Typing an answer into the composer while an open question card waits answers that card instead of queueing a new turn.
    const pendingCard = pendingId ? cards[pendingId] : null;
    if (pendingCard && pendingCard.kind === "question" && !pendingCard.answered && !pendingCard.auto && m.text.trim() && m.attachments.length === 0) {
      const text = m.text.trim();
      // An option typed verbatim picks that option; anything else is the free-text answer when the card allows one.
      const opt = pendingCard.actions.find((a) => a.id !== "free" && (a.label ?? "").trim().toLowerCase() === text.toLowerCase());
      if (opt) { await answerCard(pendingCard.id, opt.id, undefined); return; }
      if (pendingCard.actions.some((a) => a.id === "free")) { await answerCard(pendingCard.id, "free", text); return; }
      // No free-text path: queueing the text as a new turn would leave the card waiting and the bubble "sending" forever.
      toasts.push({ tone: "warning", text: t("chat.answerCardFirst"), action: { label: t("chat.jumpToCard"), run: jumpToCard } });
      throw new Error("CARD_WAITING"); // the composer keeps the text
    }
    // A hard stop waits for a decision: text typed now would be queued behind it and nothing would happen.
    if (pendingCard && pendingCard.kind === "hard_stop" && !pendingCard.answered && !pendingCard.auto) {
      toasts.push({ tone: "warning", text: t("chat.hardStopFirst"), action: { label: t("chat.jumpToCard"), run: jumpToCard } });
      throw new Error("CARD_WAITING");
    }
    // ui-states: a Plan / Build request needs the environment; the text stays in the composer.
    if (modeBlock === "ENV_SETUP_REQUIRED") {
      setEnvBlockedSend(true);
      throw new Error("ENV_SETUP_REQUIRED");
    }
    setEnvBlockedSend(false);
    await send(m);
  };
  // ui-states §B: budget stop (an open budget hard-stop card) and provider unreachable on the latest turn.
  const budgetPaused = Object.values(cards).some((c) => c.kind === "hard_stop" && !c.answered && !c.auto && /^hard_stop\.budget$/.test(c.title));
  const lastTurn = turns[turns.length - 1];
  const offline = !st.running && !!lastTurn?.error && ["NET_OFFLINE", "NET_TIMEOUT", "PROVIDER_STREAM_BROKEN"].includes(lastTurn.error.code);
  const retryLast = async () => {
    const last = [...(lastTurn?.messages ?? [])].reverse().find((m) => m.kind === "user");
    if (last) await send({ text: last.text, refs: last.refs ?? [], attachments: [], session_id: st.session_id ?? tab.sessionId ?? "" });
  };
  const visibleTurns = q.trim() ? turns.filter((b) => b.messages.some((m) => m.text.toLowerCase().includes(q.trim().toLowerCase())) || b.headline.toLowerCase().includes(q.trim().toLowerCase())) : turns;
  const noProviders = settings.providers.filter((p) => p.enabled && p.has_secret).length === 0 && isTauri();
  const menus = {
    mode: st.mode, policy: st.policy, density, hasPendingCard: !!pendingId, shortcuts: shortcutMap, running: st.running, blocked: blockedHints,
    onMode: requestMode, onPolicy: requestPolicy,
    onDensity: (d: typeof density) => void update({ agent: { ...settings.agent, chat_density: d } }),
    onSearch: () => setQ(q ? "" : " "), onJump: jumpToCard,
    onNewSession: () => { void newSession(tab.key); },
    providers: settings.providers, leadModel,
    onPickModel: (id: string) => setLeadModel(id),
    thinking, onThinking: (level: ThinkingLevel) => setThinkingLevel(level),
    onViewPlan: () => { prefs.setSidebarTab("plan"); },
    onOpenModelSettings: () => { document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "models" })); },
  };
  return (
    <section className="chat" aria-label={t("chat.title")}>
      <ModeBar mode={st.mode} policy={st.policy} plan={planView} running={st.running} buildOpen={!!st.build_session} onViewPlan={menus.onViewPlan} />
      {q && <input className="input chat-search" autoFocus placeholder={t("chat.searchStream")} value={q.trim()} onChange={(e) => setQ(e.target.value || " ")} onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }} />}
      {/* The stream is windowed: a card's Auto confirmation is owned here so it survives the card unmounting. */}
      <AutoConfirmProvider>
      <div ref={streamRef} className="stream scroll" onScroll={onStreamScroll}>
        {noProviders && <Callout tone="warning" actions={<Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "models" }))}>{t("empty.aiUnconfiguredAction")}</Button>}>{t("empty.aiUnconfigured")}</Callout>}
        {noPro && (
          <Callout tone="warning" actions={<Button size="sm" icon="newProject" onClick={() => setShellConsent(true)}>{t("project.createShell")}</Button>}>
            <div>{errorCopy("PROJECT_NO_PRO")?.title ?? "PROJECT_NO_PRO"}</div>
            <div className="muted copy-sm">{errorCopy("PROJECT_NO_PRO")?.why}</div>
          </Callout>
        )}
        {envBlockedSend && (
          <Callout tone="error" actions={<Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "environment" }))}>{t("env.openSettings")}</Button>}>
            <div>{errorCopy("ENV_SETUP_REQUIRED")?.title ?? "ENV_SETUP_REQUIRED"}</div>
            <div className="muted copy-sm">{errorCopy("ENV_SETUP_REQUIRED")?.next}</div>
          </Callout>
        )}
        {budgetPaused && <Callout tone="warning" actions={<Button size="sm" onClick={() => document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "agent" }))}>{t("empty.aiPausedAction")}</Button>}>{t("empty.aiPaused")}</Callout>}
        {offline && <Callout tone="warning" actions={<Button size="sm" onClick={() => void retryLast()}>{t("common.retry")}</Button>}>{t("empty.aiOffline")}</Callout>}
        {st.mode === "build" && !prefs.dismissedTips.firstBuildTip && <Callout tone="info" actions={<Button size="sm" variant="ghost" onClick={() => prefs.dismissTip("firstBuildTip")}>{t("common.dontShowAgain")}</Button>}>{t("chat.firstBuildTip")}</Callout>}
        {visibleTurns.length === 0 && (
          <EmptyState icon="sparkles" title={t(tab.info.sheets.some((s) => s.symbols > 0) ? "empty.noConversation" : "empty.sheetBlank")} hint={t("empty.sheetBlankHint")}
            primary={<div className="row wrap">
              <Button size="sm" onClick={() => setPrefill(t("empty.suggestAsk"))}>{t("empty.suggestAsk")}</Button>
              <Button size="sm" onClick={() => setPrefill(t("empty.suggestBuild"))}>{t("empty.suggestBuild")}</Button>
              <Button size="sm" onClick={() => setPrefill(t("empty.suggestReview"))}>{t("empty.suggestReview")}</Button>
            </div>} />
        )}
        {context?.last_compaction && !prefs.dismissedTips.firstCompaction && <Callout tone="info" actions={<Button size="sm" variant="ghost" onClick={() => prefs.dismissTip("firstCompaction")}>{t("common.dontShowAgain")}</Button>}>{t("tips.firstCompaction")}</Callout>}
        {visibleTurns.map((b) => (
          windowed.visible(b.turn)
            ? <TurnGroupView key={b.turn} block={b} cards={cards} projectKey={tab.key} sessionId={st.session_id ?? tab.sessionId} density={density} isCurrent={st.running && b.turn === (st.current_turn ?? turns[turns.length - 1]?.turn)} onAnswer={answerCard} onRollback={(n) => setRollbackTurn(n)} onContinue={() => void send({ text: "/continue", refs: [], attachments: [], session_id: st.session_id ?? tab.sessionId ?? "" })} onSaveRule={onSaveRule} onShowOnCanvas={onFocusCanvas ?? focusRefs} retrying={retrying} hasPlan={!!st.plan_ref} measure={windowed.measure(b.turn)} />
            : <div key={b.turn} id={`turn-${b.turn}`} className="turn-spacer" style={{ height: windowed.height(b.turn) }} aria-hidden />
        ))}
        {pending.map((m) => <UserBubble key={m.id} m={m} pending />)}
        {density === "developer" && <DeveloperTail bridge={bridge} />}
      </div>
      </AutoConfirmProvider>
      {!stick && <button type="button" className="jump-latest" onClick={jumpLatest}><Icon name="chevronDown" className="icon-sm" /> {t("chat.jumpLatest")}</button>}
      <Composer projectKey={tab.key} sheet={tab.sheet} sheets={tab.info.sheets} findings={findings} selection={attachedSelection} onSkipSelection={skipSelectionOnce} sessionId={st.session_id ?? tab.sessionId ?? ""} running={st.running} context={context} onSend={onSend} onStop={stop} onCompact={() => compact()} turns={turns} attachments={attachments} sendCombo={sendCombo} attachCombo={attachCombo} prefill={prefill} onPrefillConsumed={() => setPrefill(null)} menus={menus} />
      <Dialog open={buildConsent} onClose={() => setBuildConsent(false)} title={t("mode.enterBuildTitle")} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setBuildConsent(false)} autoFocus>{t("common.cancel")}</Button><Button variant="primary" consent onClick={() => void confirmBuild()}>{t("mode.enterBuildConfirm")}</Button></>}>
        <p>{t("mode.enterBuildBody")}</p>
      </Dialog>
      <Dialog open={shellConsent} onClose={() => setShellConsent(false)} title={t("project.createShell")} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setShellConsent(false)} autoFocus>{t("common.cancel")}</Button><Button variant="primary" consent onClick={() => void confirmShell()}>{t("project.createShellConfirm")}</Button></>}>
        <p>{t("project.createShellBody", { name: tab.info.name })}</p>
      </Dialog>
      <AutoPolicyDialog destructive open={autoConsent} onClose={() => setAutoConsent(false)} onConfirm={() => void confirmAuto()} />
      <RollbackDialog turn={rollbackTurn} turns={turns} cards={cards} projectKey={tab.key} locked={tab.info.locked} onClose={() => setRollbackTurn(null)} onConfirm={doRollback} />
    </section>
  );
}

/**
 * Always-visible authority line at the top of the conversation: which mode the agent is in (what it may do),
 * the approval policy, and the plan's progress. The composer menus change these; this only shows them.
 */
function ModeBar({ mode, policy, plan, running, buildOpen, onViewPlan }: { mode: Mode; policy: Policy; plan: import("../../agent/api").PlanView | null; running: boolean; buildOpen: boolean; onViewPlan: () => void }) {
  const t = useT();
  const done = plan ? plan.steps.filter((s) => s.status === "done").length : 0;
  const skipped = plan ? plan.steps.filter((s) => s.status === "skipped").length : 0;
  const current = plan?.steps.find((s) => s.status === "current");
  return (
    <div className={`mode-bar mode-bar-${mode}`} role="status" aria-label={t("chat.modeBar")}>
      <span className="mode-bar-mode"><Icon name={mode === "build" ? "building" : mode === "review" ? "reviewing" : "designing"} className="icon-sm" /> {t(`mode.${mode}`)}</span>
      <span className="muted copy-sm">{t(`mode.${mode}Hint`)}</span>
      <span className="grow" />
      {mode === "build" && <span className="muted copy-sm">{t("policy.label")}: {t(`policy.${policy}`)}</span>}
      {mode === "build" && !buildOpen && !running && <span className="muted copy-sm">{t("chat.modeBar.sessionClosed")}</span>}
      {plan && plan.status !== "draft" && plan.status !== "abandoned" ? (
        <button type="button" className="mode-bar-plan" onClick={onViewPlan}>
          {t("chat.modeBar.plan", { id: plan.id, version: plan.version, k: done, n: plan.steps.length })}{skipped ? ` · ${t("chat.modeBar.skipped", { n: skipped })}` : ""}{current ? ` · ${current.summary}` : ""}
        </button>
      ) : mode === "build" ? <span className="muted copy-sm">{t("chat.modeBar.incremental")}</span> : null}
    </div>
  );
}

function DeveloperTail({ bridge }: { bridge: BridgeStore }) {
  const t = useT();
  const events = bridge((s) => s.events);
  const last = events.slice(-20);
  return (
    <details className="dev-tail">
      <summary className="muted copy-sm">{t("chat.rawEvent")} ({events.length})</summary>
      <pre className="md-pre selectable">{last.map((e) => JSON.stringify(e)).join("\n")}</pre>
    </details>
  );
}
