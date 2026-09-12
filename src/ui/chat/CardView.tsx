// SPDX-License-Identifier: Apache-2.0
// Cards are rendered ONLY from TurnEvent{card}. Consent-bearing actions record a consent event first (D-17).
// Questions are two-step: pick an option (or "other" + free text), then confirm.
import { useState } from "react";
import type { Card, CardAction, TurnSummary } from "../../agent/api";
import { useT , hasKey , fmtDay , fmtDuration , errorCopy , findingCopy , useLang } from "../../i18n";
import { call, isTauri, IpcFailure } from "../../ipc/client";
import type { IpcError } from "../../ipc/types";
import { Badge, Button, Card as CardBox, Icon, Input, TextArea } from "../components";
import { fixCost, fixCostCounts, type FixCost } from "../../agent/findings";
import { AutoPolicyDialog, useAutoConfirm } from "../components/AutoPolicyDialog";
import { ErrorBlock } from "../components/ErrorBlock";
import { waiveBatch, waiveConsentSha, waivePayload, waivedIds } from "../../agent/review-waiver";
import { WaiverForm } from "../components/WaiverForm";
import { Markdown } from "./Markdown";
import { ACCEPTANCE_ROWS_MAX, acceptanceTally, addedLine, changedLine, movedLine, netLines } from "./turn-lines";
import { DECISION_FIELDS, defaultChoice, diffFields, type Candidate, type Choice, type DecisionItem } from "../../agent/tools/parts-decision";
import { REMEMBERABLE, rememberCondition } from "../../agent/policy/remembered";
import { acceptanceRows, partLabel as planPartLabel, openQuestionPayload, parseOpenQuestionAnswers, type Acceptance, type PlanPart } from "../../agent/plans/schema";
import { usePrefs } from "../../state/prefs";
import { useToasts } from "../../state/toasts";
import { Callout } from "../components";

const ACTION_LABELS: Record<string, string> = {};
const OTHER = "__other__";

/**
 * What ticking a review row costs when "Fix selected" is clicked: an `ercfix` op-list (mechanical),
 * a Fixer round (a model call), or nothing at all because the fix path has no repair for the code.
 * The same three labels the findings panel shows, from the same `fixCost` predicate.
 */
const FIX_COST_LABEL = {
  mechanical: "side.fixKind.mechanical",
  model: "side.fixKind.model",
  none: "side.fixKind.none",
} as const satisfies Record<FixCost, string>;

export function CardView({ card, projectKey, sessionId, onAnswer, pinned }: { card: Card; projectKey: string; sessionId?: string | null; onAnswer: (card_id: string, action_id: string, free_text?: string, consent_event_id?: string) => Promise<void>; pinned?: boolean }) {
  const t = useT();
  const lang = useLang();
  const prefs = usePrefs();
  const toasts = useToasts();
  const [remember, setRemember] = useState(false);
  /** Reason typed on a net-risk / structural hard stop (required before approve; recorded as the waiver reason). */
  const [reason, setReason] = useState("");
  const [free, setFree] = useState("");
  const defaultOptionId = (() => {
    if (card.kind !== "question") return null;
    const def = (card.data as { default?: unknown } | undefined)?.default;
    if (typeof def !== "string" || !def.trim()) return null;
    const hit = card.actions.find((a) => a.id !== "free" && (a.label ?? "").trim().toLowerCase() === def.trim().toLowerCase());
    return hit?.id ?? null;
  })();
  const [choice, setChoice] = useState<string | null>(defaultOptionId);
  const [picks, setPicks] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const answered = !!card.answered || !!card.auto;
  // Answered cards start collapsed; unanswered start open. The user can toggle either way.
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? !answered;
  const tone = card.kind === "hard_stop" || card.kind === "rollback" || card.kind === "waiver" ? "decision" : card.kind === "system" || card.kind === "compaction" || card.kind === "env" ? "system" : "plain";
  const labelOf = (a: CardAction) => a.label ?? ACTION_LABELS[a.label_key] ?? safeT(t, a.label_key);
  const [autoConfirm, setAutoConfirm] = useState<{ a: CardAction; inputKind: "click" | "keyboard" } | null>(null);
  // The confirm dialog must outlive this card: the stream is windowed (and answered cards collapse), so a
  // dialog owned by the card can unmount mid-decision. The stream's provider holds it; without one (a card
  // rendered on its own) the local dialog below stands in, never a skipped consent.
  const requestAutoConfirm = useAutoConfirm();
  const run = async (a: CardAction, inputKind: "click" | "keyboard", freeText?: string) => {
    // The provider hard stop's "switch provider" opens the Models settings on the way through; the
    // answer still reaches the harness, which leaves the plan paused at its step either way.
    if (a.id === "switch_provider") document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "models" }));
    // Adopting with Auto is two decisions (adopt the plan, switch the policy): the second one gets its own confirm.
    if (card.kind === "plan_approval" && a.id === "adopt_auto" && !autoConfirm) {
      if (requestAutoConfirm) requestAutoConfirm(() => { void runConfirmed(a, inputKind, freeText); });
      else setAutoConfirm({ a, inputKind });
      return;
    }
    // Waiving from the review card is two steps as well: the reason and the expiry first, then the answer.
    if (isReview && a.id === "waive_selected" && !waiveOpen) { setWaiveRefused(null); setWaiveOpen(true); return; }
    await runConfirmed(a, inputKind, freeText);
  };
  const runConfirmed = async (a: CardAction, inputKind: "click" | "keyboard", freeText?: string, waive?: { reason: string; expires: string }) => {
    setBusy(a.id);
    try {
      let cid: string | undefined;
      if (a.consent && isTauri()) {
        // Waiving hides an engine verdict, so the consent event is recorded over the decision the
        // human just made — the rows ticked on this card plus the reason and expiry typed on the
        // form — not over the card's declared sha, which was computed before any of that existed.
        // The harness repeats the same batch in every grant it creates from this answer, and Rust
        // checks the two against each other (`commands.rs grant_create`).
        const batch = isReview && a.id === "waive_selected" ? waiveBatch(reviewRows.filter((r) => reviewPicks.has(r.id)), waive?.reason ?? "", waive?.expires ?? null) : null;
        const ev = await call("consent_record", { event: { project_key: projectKey, card_kind: card.kind, payload_sha256: batch ? waiveConsentSha(batch) : a.consent.payload_sha256, input_kind: inputKind } });
        cid = ev.id;
      }
      const synth = isReview && a.id === "waive_selected" ? waivePayload([...reviewPicks], waive?.reason, waive?.expires) : isReview && a.id === "fix_selected" ? JSON.stringify([...reviewPicks]) : isParts && a.id === "apply" ? JSON.stringify({ decisions: partsItems.map((it) => ({ ref: it.ref, ...(partsChoice[it.ref] ?? { choice: defaultChoice(it), lcsc: it.actual?.lcsc }) })) }) : isPlan && (a.id === "adopt" || a.id === "adopt_auto") ? openQuestionPayload(planAnswers) : "";
      // OQ-17: remember the condition for this session only when the human approved it.
      if (isHardStop && a.id === "approve" && remember && hardStopCondition && sessionId) rememberCondition(sessionId, hardStopCondition);
      const hardStopReason = isHardStop && a.id === "approve" && needsReason ? reason.trim() : "";
      await onAnswer(card.id, a.id, (freeText || synth || hardStopReason) || undefined, cid);
      if (isReview && a.id === "waive_selected" && waive) { setWaived({ ids: [...reviewPicks], until: waive.expires }); setWaiveOpen(false); setWaiveRefused(null); }
    } catch (e) {
      // A waive that failed part-way already recorded some findings: drop those from the selection so
      // a retry cannot write a second `[[waiver]]` row for them, and show on the rows what went in.
      const done = waivedIds(e);
      if (done.length) {
        setReviewPicks((p) => { const n = new Set(p); for (const id of done) n.delete(id); return n; });
        if (waive) setWaived({ ids: done, until: waive.expires });
      }
      // A refused waiver is answered on the card itself (translated, selection kept); anything else is a toast.
      const gate = waiverRefusal(e);
      if (gate) setWaiveRefused(gate);
      // A failed answer must be visible: the card stays open and the button is enabled again.
      else toasts.pushError(e);
    } finally { setBusy(null); }
  };
  const isQuestion = card.kind === "question";
  // A question the harness raised about an engine finding (FR-611 INSTANCE_REFS_REQUIRED): the card
  // body carries identifiers only, the explanation is the code's copy in the reader's language.
  const codeCopy = isQuestion ? errorCopy(String((card.data as { code?: unknown } | undefined)?.code ?? ""), lang) : null;
  const isReview = card.kind === "review";
  const reviewRows = isReview ? (((card.data as { findings?: { id: string; code: string; severity: string; message: string; origin?: string; selected?: boolean; refs?: string[]; location?: string; waived_until?: string }[] })?.findings) ?? []) : [];
  const [reviewPicks, setReviewPicks] = useState<Set<string>>(() => new Set(reviewRows.filter((r) => r.selected).map((r) => r.id)));
  const toggleReview = (id: string) => setReviewPicks((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Waiving is a recorded, time-bound decision: the shared `WaiverForm` collects the reason and the
  // expiry the Rust gate asks for (an Error needs both) before the selection is sent — the same form
  // the findings panel opens. See `agent/review-waiver.ts`.
  const [waiveOpen, setWaiveOpen] = useState(false);
  /** WAIVER_SEVERITY / WAIVER_SCOPE from Rust: shown on the card, selection kept so the human can correct it. */
  const [waiveRefused, setWaiveRefused] = useState<IpcError | null>(null);
  /** What this card just waived and until when (the engine hides those findings from the next run). */
  const [waived, setWaived] = useState<{ ids: string[]; until: string } | null>(null);
  const waiveSelectedErrors = reviewRows.filter((r) => reviewPicks.has(r.id) && String(r.severity).toLowerCase() === "error").length;
  // Plan card: the Architect's open questions, each with a free-text answer. Adopting sends them as
  // the card's free text; `agent/index.ts` folds the answered ones into the plan's constraints before
  // it is frozen. Questions left blank are a plain-text note, never a blocker.
  const isPlan = card.kind === "plan_approval";
  const planQuestions: string[] = isPlan ? (((card.data as { plan?: { open_questions?: unknown } } | undefined)?.plan?.open_questions as string[] | undefined) ?? []).filter((q) => typeof q === "string" && q.trim()) : [];
  const answeredQuestions = isPlan ? parseOpenQuestionAnswers(card.answered?.free_text) : null;
  const [planAnswers, setPlanAnswers] = useState<Record<string, string>>({});
  const planUnanswered = planQuestions.filter((_, i) => !planAnswers[String(i)]?.trim()).length;
  const isParts = card.kind === "parts_decision";
  const partsItems: DecisionItem[] = isParts ? (((card.data as { items?: DecisionItem[] })?.items) ?? []) : [];
  const [partsChoice, setPartsChoice] = useState<Record<string, { choice: Choice; lcsc?: string }>>({});
  const isHardStop = card.kind === "hard_stop";
  const hardStopCondition = isHardStop ? hardStopConditionOf(card) : null;
  const needsReason = isHardStop && !!(card.data as { needs_reason?: boolean } | undefined)?.needs_reason;
  const approveBlocked = needsReason && !reason.trim();
  const isIntake = card.kind === "intake";
  // The turn summary is a system card whose whole content is structured data (`summaryCard`):
  // counts, what was drawn, what was changed, and the automatic decisions of an Auto run.
  const isTurnSummary = card.kind === "system" && card.title === "card.turn_summary";
  // Recovery notes arrive as codes (Rust `RecoveryNote`); the copy is looked up here so it follows the UI language.
  const recoveryNotes = card.kind === "system" && card.title === "system.recovered" ? recoveryNoteLines(t, (card.data as { report?: { notes?: unknown } } | undefined)?.report?.notes) : [];
  // One-time explanation on the first decision card (hard stop / question) of this machine.
  const firstDecision = (isHardStop || isQuestion) && !answered && !prefs.dismissedTips.firstDecisionCard;
  // Question cards: options are the non-"free" actions; "free" (when offered) becomes the "other" radio.
  // With no options at all the card is an open question: just a text field.
  const options = isQuestion ? card.actions.filter((a) => a.id !== "free") : [];
  const freeAction = isQuestion ? card.actions.find((a) => a.id === "free") : undefined;
  const openQuestion = isQuestion && options.length === 0;
  // Multi-select questions submit the chosen labels (plus "other" text) joined with "; " as free text.
  const multi = isQuestion && !openQuestion && !!(card.data as { multi?: boolean } | undefined)?.multi;
  const freeActionOrSynth: CardAction = freeAction ?? { id: "free", label_key: "card.answer_free", style: "secondary" };
  // Hard stops: the harness no longer offers "modify"; never render it even from older transcripts.
  // While the waiver form is open its own button records the decision: no duplicate in the footer.
  const visibleActions = isHardStop ? card.actions.filter((a) => a.id !== "modify") : isReview && waiveOpen ? card.actions.filter((a) => a.id !== "waive_selected") : card.actions;
  const waiveAction = isReview ? card.actions.find((a) => a.id === "waive_selected") : undefined;
  const answeredAction = card.actions.find((a) => a.id === card.answered?.action_id);
  const clip = (s: string) => (s.length > 140 ? `${s.slice(0, 139)}…` : s);
  const answeredLabel = card.auto
    ? t("card.autoDecided", { decision: card.auto.decision, reason: card.auto.reason })
    : card.answered?.action_id === "free" && card.answered.free_text
      ? t("card.answered", { action: clip(card.answered.free_text.trim()) })
      : t("card.answered", { action: labelOf(answeredAction ?? { id: "", label_key: card.answered?.action_id ?? "", style: "secondary" }) });
  const confirmQuestion = async () => {
    if (multi) {
      const labels = options.filter((o) => picks.has(o.id)).map(labelOf);
      if (picks.has(OTHER) && free.trim()) labels.push(free.trim());
      if (labels.length) await run(freeActionOrSynth, "click", labels.join("; "));
      return;
    }
    if (openQuestion) { if (freeAction && free.trim()) await run(freeAction, "click", free.trim()); return; }
    if (choice === null) return;
    if (choice === OTHER) { if (freeAction && free.trim()) await run(freeAction, "click", free.trim()); return; }
    const a = options.find((o) => o.id === choice);
    if (a) await run(a, "click");
  };
  const multiOk = [...picks].some((p) => p !== OTHER) || (picks.has(OTHER) && free.trim().length > 0);
  const canConfirm = (multi ? multiOk : openQuestion ? free.trim().length > 0 : choice !== null && (choice !== OTHER || free.trim().length > 0)) && !busy;
  const togglePick = (id: string) => setPicks((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Header: "kind · title" only when the title adds information; questions read just "The agent asks".
  // Every `CardKind` of `agent/api.ts` has a `card.kind.<kind>` entry in all four catalogues (the
  // i18n lint checks that family); a kind from a newer transcript keeps its id rather than a raw key.
  const kindLabel = hasKey(`card.kind.${card.kind}`) ? t(`card.kind.${card.kind}` as "card.kind.system") : card.kind;
  // System cards carry their parameters in `data` (step, reason, files, counts): the title template needs them.
  const titleText = card.kind === "system" ? safeT(t, card.title, flatParams(t, card.data)) : safeT(t, card.title);
  const headText = isQuestion ? t("card.question") : titleText === kindLabel || card.title === `card.${card.kind}` || card.title === `card.kind.${card.kind}` ? titleText : `${kindLabel} · ${titleText}`;
  const title = <span>{headText}{!expanded && answered ? <span className="muted"> · {answeredLabel}</span> : null}</span>;
  // Hard-stop actions are relabelled for humans: approve = accept this scope, abandon = stop the turn.
  const hardStopLabel = (a: CardAction) => (a.id === "approve" ? t("card.approveScope") : a.id === "abandon" ? t("card.abandon_turn") : labelOf(a));
  return (
    <div id={`card-${card.id}`} className={`card-slot ${pinned ? "pinned" : ""} ${card.kind === "hard_stop" && !answered ? "waiting" : ""}`}>
      <CardBox tone={tone} icon={card.kind === "hard_stop" ? "waiting" : card.kind === "question" ? "help" : card.kind === "plan_approval" ? "plan" : card.kind === "cost" ? "cost" : card.kind === "rollback" ? "rollback" : "info"}
        title={title}
        collapsed={!expanded}
        onToggle={() => setOpen(!expanded)}
        footer={answered ? (
          <div className="row muted copy-sm">
            <Icon name="done" className="icon-sm" />
            {answeredLabel}
          </div>
        ) : isQuestion ? (
          <div className="row card-actions">
            <span className="muted copy-sm">{openQuestion ? t("card.openHint") : multi ? (picks.size === 0 ? t("card.chooseMany") : t("card.pending")) : choice === null ? t("card.chooseOne") : t("card.pending")}</span>
            <span className="grow" />
            <Button variant="primary" loading={busy !== null} disabled={!canConfirm} onClick={() => void confirmQuestion()}>{openQuestion ? t("card.send") : t("card.confirm")}</Button>
          </div>
        ) : visibleActions.length ? (
          <div className="row card-actions">
            <span className="grow" />
            {visibleActions.map((a, i) => (
              <Button key={a.id} variant={isHardStop && a.id === "abandon" ? "secondary" : a.style} consent={!!a.consent} loading={busy === a.id} disabled={!!busy || (isHardStop && a.id === "approve" && approveBlocked)} autoFocus={i === 0 && a.style !== "destructive" && !(isHardStop && a.id === "approve")}
                onClick={() => void run(a, "click")}>
                {isHardStop ? hardStopLabel(a) : labelOf(a)}
              </Button>
            ))}
          </div>
        ) : undefined}>
        {firstDecision && <Callout tone="info" actions={<Button size="sm" variant="ghost" onClick={() => prefs.dismissTip("firstDecisionCard")}>{t("common.dontShowAgain")}</Button>}>{t(isHardStop ? "tips.firstHardStop" : "tips.firstQuestion")}</Callout>}
        {codeCopy && <Callout tone="warning">{codeCopy.title}{codeCopy.next ? ` ${codeCopy.next}` : ""}</Callout>}
        {isPlan && <PlanAuthority data={card.data} />}
        {isHardStop ? <HardStopBody card={card} /> : isIntake ? <IntakeBody data={card.data} /> : isTurnSummary ? <TurnSummaryBody data={card.data} /> : <Markdown text={card.body_md} />}
        {recoveryNotes.length > 0 && <ul className="copy-sm recovery-notes">{recoveryNotes.map((l, i) => <li key={i} className="selectable">{l}</li>)}</ul>}
        {isPlan && planQuestions.length > 0 && (
          <div className="plan-questions" role="group" aria-label={t("plan.openQuestions")}>
            <div className="hardstop-zone-label"><Icon name="help" className="icon-sm" /> {t("plan.openQuestions")}</div>
            {planQuestions.map((q, i) => (
              <div key={i} className="plan-question">
                <div className="copy-sm selectable">{q}</div>
                {answered
                  ? <div className="muted copy-sm selectable">{answeredQuestions?.[String(i)] ?? t("plan.openQuestions.left")}</div>
                  : <Input aria-label={q} placeholder={t("plan.openQuestions.placeholder")} value={planAnswers[String(i)] ?? ""} onChange={(e) => setPlanAnswers((prev) => ({ ...prev, [String(i)]: e.target.value }))} />}
              </div>
            ))}
            {!answered && planUnanswered > 0 && <div className="muted copy-sm">{t("plan.openQuestions.unanswered", { n: planUnanswered })}</div>}
          </div>
        )}
        {!requestAutoConfirm && (
          <AutoPolicyDialog open={!!autoConfirm} onClose={() => setAutoConfirm(null)}
            onConfirm={() => { const c = autoConfirm; setAutoConfirm(null); if (c) void runConfirmed(c.a, c.inputKind); }} />
        )}
        {isHardStop && !answered && needsReason && (
          <TextArea className="hardstop-reason" label={t("hardstop.reasonLabel")} placeholder={t("hardstop.reasonPlaceholder")} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required aria-required="true" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && reason.trim() && !busy) { e.preventDefault(); const approve = visibleActions.find((a) => a.id === "approve"); if (approve) void run(approve, "keyboard"); } }} />
        )}
        {isHardStop && !answered && hardStopCondition && REMEMBERABLE.has(hardStopCondition) && (
          <label className="question-option hardstop-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>{t("hardstop.rememberCondition", { condition: t(`hardstop.${hardStopCondition}.name` as "hardstop.scope_widen.name") })}</span>
          </label>
        )}
        {isReview && (
          <div className="review-findings" role="group" aria-label={t("card.review")}>
            {reviewRows.length === 0 && <span className="muted copy-sm">{t("empty.reviewClean")}</span>}
            {reviewRows.map((r) => {
              // A finding under a waiver says until when: from the row itself, or from what this card just recorded.
              const until = waived?.ids.includes(r.id) ? waived.until : r.waived_until;
              return (
                <div key={r.id} className="review-item">
                  <label className={`question-option review-row sev-${String(r.severity).toLowerCase()} ${reviewPicks.has(r.id) ? "checked" : ""}`}>
                    <input type="checkbox" checked={reviewPicks.has(r.id)} disabled={answered} onChange={() => toggleReview(r.id)} />
                    <span className="fs-mono review-code">{r.code}</span>
                    {/* The app's own title for the code, with the engine's own English sentence as
                        the hover text (untrusted input: an attribute value, never markup). */}
                    <span className="grow truncate" title={r.message}>{findingCopy(r.code, lang)?.title ?? r.message}</span>
                    <Badge tone="neutral">{t(FIX_COST_LABEL[fixCost(r)])}</Badge>
                    <span className="muted copy-sm">{r.origin === "advisory" ? t("side.confidence.advisory") : t("side.confidence.engine")}</span>
                  </label>
                  {until && <div className="muted copy-sm review-waived">{t("card.waiver.waivedUntil", { date: fmtDay(until) })}</div>}
                </div>
              );
            })}
            {/* What "Fix selected" will do with the ticks as they stand, before the click. */}
            {reviewPicks.size > 0 && <div className="muted copy-sm">{t("side.fixPlan", fixCostCounts(reviewRows.filter((r) => reviewPicks.has(r.id))))}</div>}
          </div>
        )}
        {isReview && waiveRefused && <ErrorBlock error={waiveRefused} />}
        {isReview && waiveOpen && !answered && waiveAction && (
          <WaiverForm count={reviewPicks.size} hasError={waiveSelectedErrors > 0} name={card.id} busy={!!busy} consent={!!waiveAction.consent}
            onCancel={() => { setWaiveOpen(false); setWaiveRefused(null); }}
            onSubmit={(reason, expires) => void runConfirmed(waiveAction, "click", undefined, { reason, expires })} />
        )}
        {openQuestion && !answered && (
          <TextArea label={t("card.freeText")} placeholder={t("card.openPlaceholder")} value={free} onChange={(e) => setFree(e.target.value)} rows={3} autoFocus
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canConfirm) { e.preventDefault(); void confirmQuestion(); } }} />
        )}
        {isQuestion && !openQuestion && !answered && multi && (
          <div className="question-options" role="group" aria-label={t("card.chooseMany")}>
            {options.map((o) => (
              <label key={o.id} className={`question-option ${picks.has(o.id) ? "checked" : ""}`}>
                <input type="checkbox" name={`q-${card.id}`} value={o.id} checked={picks.has(o.id)} onChange={() => togglePick(o.id)} />
                <span>{labelOf(o)}</span>
              </label>
            ))}
            <label className={`question-option ${picks.has(OTHER) ? "checked" : ""}`}>
              <input type="checkbox" name={`q-${card.id}`} value={OTHER} checked={picks.has(OTHER)} onChange={() => togglePick(OTHER)} />
              <span>{t("card.other")}</span>
            </label>
            {picks.has(OTHER) && <TextArea label={t("card.freeText")} value={free} onChange={(e) => setFree(e.target.value)} rows={2} autoFocus />}
          </div>
        )}
        {isQuestion && !openQuestion && !answered && !multi && (
          <div className="question-options" role="radiogroup" aria-label={t("card.chooseOne")}>
            {options.map((o) => (
              <label key={o.id} className={`question-option ${choice === o.id ? "checked" : ""}`}>
                <input type="radio" name={`q-${card.id}`} value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
                <span>{labelOf(o)}</span>
              </label>
            ))}
            {freeAction && (
              <label className={`question-option ${choice === OTHER ? "checked" : ""}`}>
                <input type="radio" name={`q-${card.id}`} value={OTHER} checked={choice === OTHER} onChange={() => setChoice(OTHER)} />
                <span>{t("card.other")}</span>
              </label>
            )}
            {choice === OTHER && <TextArea label={t("card.freeText")} value={free} onChange={(e) => setFree(e.target.value)} rows={2} autoFocus />}
          </div>
        )}
        {card.data != null && card.kind === "change" && <ChangeSummary data={card.data} />}
        {isParts && <PartsDecisionBody items={partsItems} choice={partsChoice} disabled={answered} onChange={(ref, v) => setPartsChoice((p) => ({ ...p, [ref]: v }))} />}
      </CardBox>
    </div>
  );
}

/**
 * Gate refusals the review card answers inline instead of as a toast: the code carries three-part
 * copy in every catalogue (`error.<CODE>.{title,why,next}`), and the raw engine message stays plain
 * text evidence in `ErrorBlock`. Anything else is not a waiver decision and travels on as an error.
 */
export const WAIVER_GATE_CODES = ["WAIVER_SEVERITY", "WAIVER_SCOPE"] as const;
export function waiverRefusal(e: unknown): IpcError | null {
  const err = e instanceof IpcFailure ? e.error : null;
  return err && (WAIVER_GATE_CODES as readonly string[]).includes(err.code) ? err : null;
}

const HARD_STOP_FIELDS: Record<string, string> = {
  components_added_max: "hardstop.field.components_added_max", components_deleted_max: "hardstop.field.components_deleted_max",
  sheets: "hardstop.field.sheets", nets_renamable: "hardstop.field.nets_renamable", structural: "hardstop.field.structural", wires_max: "hardstop.field.wires_max",
};
const HARD_STOP_CONDITIONS = new Set(["scope_widen", "structural", "net_risk", "unresolved", "interface", "budget", "external", "context", "refdes_conflict", "symbol_not_found", "scope", "environment", "provider_exhausted"]);

/**
 * The harness nests what it measured under `data.system` (`hardStopCard`); older transcripts and tests
 * carry the fields at the top level. Read both so the card never degrades to its intro sentence.
 */
export function hardStopPayload(card: Card): Record<string, unknown> {
  const d = (card.data ?? {}) as Record<string, unknown>;
  const sys = d.system;
  return sys && typeof sys === "object" && !Array.isArray(sys) ? { ...d, ...(sys as Record<string, unknown>) } : d;
}

/** Parses "field: requested > ceiling" / "field: a, b" strings the harness used before it sent structured entries. */
export function parseWidened(items: unknown): { field: string; requested: string; ceiling: string | null }[] {
  if (!Array.isArray(items)) return [];
  return items.map((w) => {
    if (w && typeof w === "object") {
      const o = w as { field?: unknown; requested?: unknown; ceiling?: unknown };
      return { field: String(o.field ?? ""), requested: fmtVal(o.requested), ceiling: o.ceiling === undefined || o.ceiling === null ? null : fmtVal(o.ceiling) || "" };
    }
    const str = String(w);
    const m = /^([a-z_]+):\s*(.+?)(?:\s*>\s*(.+))?$/.exec(str);
    if (!m) return { field: "", requested: str, ceiling: null };
    return { field: m[1], requested: m[2], ceiling: m[3] ?? null };
  });
}

/** Named-net risk entries as sentences; nameless entries are skipped rather than rendered as "Merged ,". */
export function netChangeLines(items: unknown, t: ReturnType<typeof useT>): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const c of items) {
    if (!c || typeof c !== "object") continue;
    const o = c as { kind?: string; name?: string; into?: string; sources?: { name?: string; named?: boolean }[]; names?: string[] };
    const srcs = (o.sources ?? []).map((x) => x.name ?? "").filter(Boolean);
    if (o.kind === "Merged") {
      const from = srcs.filter((n) => n !== o.into);
      if (!o.into && !from.length) continue;
      out.push(t("hardstop.change.merged", { from: from.join(" + ") || "?", into: o.into ?? "?" }));
    } else if (o.kind === "Split") {
      if (!o.name) continue;
      out.push(t("hardstop.change.split", { name: o.name, into: (o.names ?? srcs).join(", ") }));
    } else if (o.kind === "Renamed") {
      if (!o.name && !o.into) continue;
      out.push(t("hardstop.change.renamed", { from: o.name ?? "?", to: o.into ?? "?" }));
    }
  }
  return out;
}

function fmtVal(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function hardStopConditionOf(card: Card): string {
  const d = (card.data ?? {}) as { condition?: string };
  return typeof d.condition === "string" && HARD_STOP_CONDITIONS.has(d.condition) ? d.condition : (/^hard_stop\.([a-z_]+)$/.exec(card.title)?.[1] ?? "scope_widen");
}

/**
 * Human-readable hard stop in two zones: the system zone (what the engine / Rust measured:
 * condition, requested vs ceiling, net changes, ceiling source) and the agent zone (the
 * model's own note, clearly marked unverified). Never the raw JSON.
 */
function HardStopBody({ card }: { card: Card }) {
  const t = useT();
  const d = hardStopPayload(card) as { condition?: string; widened?: unknown; problems?: unknown; agent_note?: unknown; reason?: unknown; ceiling_source?: unknown; changes?: unknown; refdes?: unknown; tool?: unknown; step?: unknown; lib_id?: unknown; findings?: unknown; remediation?: unknown; limit?: unknown; used?: unknown };
  const changes = netChangeLines(d.changes, t);
  const condition = hardStopConditionOf(card);
  const introKey = (HARD_STOP_CONDITIONS.has(condition) ? `hardstop.${condition}.intro` : "hardstop.scope_widen.intro") as "hardstop.scope_widen.intro";
  const widened = parseWidened(d.widened);
  const problems = [
    ...(Array.isArray(d.problems) ? d.problems.map(String) : []),
    // refdes_conflict carries the offending designators; symbol_not_found the lib id.
    ...(Array.isArray(d.refdes) ? d.refdes.map(String) : []),
    ...(typeof d.lib_id === "string" ? [d.lib_id] : []),
    // unresolved carries the remaining integrity findings: code + location is what the human can act on.
    ...(Array.isArray(d.findings) ? (d.findings as { code?: unknown; location?: unknown }[]).map((f) => `${String(f.code ?? "")} ${typeof f.location === "string" ? f.location : ""}`.trim()) : []),
  ];
  const remediation = typeof d.remediation === "string" ? d.remediation : null;
  // budget: the numbers, and a way to raise the limit (agent settings) instead of only abandoning.
  const budgetRows = condition === "budget" ? budgetTable(d.limit, d.used) : [];
  const openAgentSettings = () => document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "agent" }));
  const tool = typeof d.tool === "string" ? d.tool : null;
  const step = typeof d.step === "string" ? d.step : null;
  const note = typeof d.agent_note === "string" ? d.agent_note : null;
  const reason = typeof d.reason === "string" && !widened.length && !problems.length ? d.reason : null;
  const ceilingSource = typeof d.ceiling_source === "string" ? d.ceiling_source : null;
  return (
    <div className="hardstop-body">
      <div className="hardstop-zone hardstop-zone-system" role="group" aria-label={t("hardstop.zone.system")}>
      <div className="hardstop-zone-label"><Icon name="info" className="icon-sm" /> {t("hardstop.zone.system")}</div>
      <p>{t(introKey)}</p>
      {widened.length > 0 && (
        <table className="hardstop-table">
          <tbody>
            {widened.map((w, i) => (
              <tr key={i}>
                <td className="hardstop-field">{w.field && HARD_STOP_FIELDS[w.field] ? t(HARD_STOP_FIELDS[w.field] as "hardstop.field.sheets") : w.field || "-"}</td>
                <td>{w.ceiling !== null ? t("hardstop.requestedVsCeiling", { requested: w.requested || "-", ceiling: w.ceiling || t("hardstop.notAllowed") }) : w.requested || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {changes.length > 0 && <ul className="hardstop-changes">{changes.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      {!widened.length && !changes.length && problems.length > 0 && <ul>{problems.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      {budgetRows.length > 0 && (
        <table className="hardstop-table">
          <tbody>
            {budgetRows.map((r) => (
              <tr key={r.key}><td className="hardstop-field">{t(r.label as "hardstop.budget.tokens")}</td><td>{t("hardstop.requestedVsCeiling", { requested: r.used, ceiling: r.limit })}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {condition === "budget" && <p><Button variant="secondary" onClick={openAgentSettings}>{t("hardstop.budget.openSettings")}</Button></p>}
      {reason && <p className="muted">{reason}</p>}
      {remediation && <p className="muted copy-sm">{remediation}</p>}
      {(tool || step) && <p className="muted copy-sm fs-mono">{[step, tool].filter(Boolean).join(" · ")}</p>}
      {ceilingSource && <p className="muted copy-sm">{t("hardstop.ceilingSource", { source: hasKey(`hardstop.ceiling.${ceilingSource}`) ? t(`hardstop.ceiling.${ceilingSource}` as "hardstop.ceiling.plan_ceiling") : ceilingSource })}</p>}
      </div>
      {note && (
        <div className="hardstop-zone hardstop-zone-agent" role="group" aria-label={t("hardstop.zone.agent")}>
          <div className="hardstop-zone-label"><Icon name="agent" className="icon-sm" /> {t("hardstop.zone.agent")} <span className="muted">· {t("hardstop.unverified")}</span></div>
          <div className="copy-sm hardstop-note">{note}</div>
        </div>
      )}
      {/* Neither of these cards offers an approval: budget is raised with `approve` removed, and the
          provider card's actions are retry / wait / switch / abandon. The approve hint would be a lie. */}
      {condition !== "budget" && condition !== "provider_exhausted" && <p className="muted copy-sm">{t("hardstop.approveHint")}</p>}
    </div>
  );
}

/** Budget hard stop: `{limit, used}` objects keyed by tokens / usd / tool_calls / applies / wall_ms into rows. */
function budgetTable(limit: unknown, used: unknown): { key: string; label: string; used: string; limit: string }[] {
  const L = (limit && typeof limit === "object" ? limit : {}) as Record<string, unknown>;
  const U = (used && typeof used === "object" ? used : {}) as Record<string, unknown>;
  const rows: { key: string; label: string; used: string; limit: string }[] = [];
  for (const k of ["tokens", "usd", "tool_calls", "applies", "wall_ms"]) {
    if (L[k] === undefined && U[k] === undefined) continue;
    const fmt = (v: unknown) => (typeof v === "number" ? (k === "usd" ? v.toFixed(2) : k === "wall_ms" ? fmtDuration(v) : String(v)) : "-");
    rows.push({ key: k, label: `hardstop.budget.${k}`, used: fmt(U[k]), limit: fmt(L[k]) });
  }
  if (!rows.length && typeof limit === "string") rows.push({ key: "limit", label: "hardstop.budget.limit", used: "-", limit });
  return rows;
}

/**
 * What adopting the plan authorises (agent-runtime §7 "authority summary on top"): sheets, component / wire budgets,
 * structural actions, rails and renamable nets, and every block with its sheet, its parts (package included) and the
 * acceptance the gate will measure it by. Read from the plan JSON the consent hash covers; the markdown below it is
 * prose. Every row restates what the plan declared — the card judges nothing itself (red line 6).
 */
export function PlanAuthority({ data }: { data: unknown }) {
  const t = useT();
  const plan = (data as { plan?: { sheets?: { file: string; create?: boolean }[]; envelope?: { budgets?: Record<string, unknown>; structural?: string[]; nets?: { rails?: string[]; renamable?: string[] } }; blocks?: { id: string; sheet: string; summary?: string; parts?: { ref_prefix?: string; lib_id?: string; mpn?: string; value?: string; footprint?: string }[]; acceptance?: unknown[] }[] } } | undefined)?.plan;
  if (!plan || !plan.envelope) return null;
  const b = plan.envelope.budgets ?? {};
  const num = (k: string) => (typeof b[k] === "number" ? String(b[k]) : "-");
  // The plan's own label (value, symbol, package): the package is part of what is signed off, and the
  // markdown body right below this table names the same parts — two spellings on one card read as two
  // different parts (real runs 17 and 18 showed neither the package nor the value here).
  const partLabel = (p: { ref_prefix?: string; lib_id?: string; mpn?: string; value?: string; footprint?: string }) => planPartLabel(p as PlanPart);
  return (
    <div className="plan-authority" role="group" aria-label={t("plan.authority.title")}>
      <div className="hardstop-zone-label"><Icon name="security" className="icon-sm" /> {t("plan.authority.title")}</div>
      <table className="hardstop-table">
        <tbody>
          <tr><td className="hardstop-field">{t("plan.authority.sheets")}</td><td className="fs-mono">{(plan.sheets ?? []).map((s) => `${s.file}${s.create ? "+" : ""}`).join(", ") || "-"}</td></tr>
          <tr><td className="hardstop-field">{t("plan.authority.budgets")}</td><td className="fs-mono">{t("plan.authority.budgetLine", { add: num("components_added"), del: num("components_deleted"), wires: num("wires_added") })}</td></tr>
          <tr><td className="hardstop-field">{t("plan.authority.structural")}</td><td className="fs-mono">{(plan.envelope.structural ?? []).join(", ") || t("plan.authority.none")}</td></tr>
          <tr><td className="hardstop-field">{t("plan.authority.rails")}</td><td className="fs-mono">{(plan.envelope.nets?.rails ?? []).join(", ") || "-"}{plan.envelope.nets?.renamable?.length ? ` · ${t("plan.authority.renamable", { nets: plan.envelope.nets.renamable.join(", ") })}` : ""}</td></tr>
        </tbody>
      </table>
      {(plan.blocks ?? []).length > 0 && (
        <ul className="plan-authority-blocks copy-sm">
          {(plan.blocks ?? []).map((blk) => {
            const rows = acceptanceRows({ acceptance: (blk.acceptance ?? []) as Acceptance[] });
            return (
              <li key={blk.id}>
                <span className="fs-mono">{blk.id}</span> · {blk.sheet} · {t("plan.authority.parts", { n: (blk.parts ?? []).length })}{blk.parts?.length ? <span className="muted"> — {blk.parts.map(partLabel).join(", ")}</span> : null}
                {/* What the block says it should end up as. A `text` row is a note the gate can neither pass
                    nor fail; a derived row was restated by the harness from the plan's own parts and nets. */}
                {rows.length > 0 && (
                  <details className="plan-authority-acceptance" open>
                    <summary className="muted copy-sm">{t("plan.authority.acceptance", { n: rows.length })}</summary>
                    <ul>
                      {rows.slice(0, ACCEPTANCE_ROWS_MAX).map((r, i) => (
                        <li key={i}>
                          <span className="fs-mono copy-sm selectable">{r.label}</span>
                          {r.derived ? <span className="muted copy-sm"> · {t("chat.acceptanceDerived")}</span> : null}
                          {r.type === "text" ? <span className="muted copy-sm"> · {t("chat.acceptanceNa.informational")}</span> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Parts decision: expected vs actual per field, then one choice per part (accept / alternate / DNP / no-part). */
function PartsDecisionBody({ items, choice, disabled, onChange }: { items: DecisionItem[]; choice: Record<string, { choice: Choice; lcsc?: string }>; disabled: boolean; onChange: (ref: string, v: { choice: Choice; lcsc?: string }) => void }) {
  const t = useT();
  const fmt = (v: unknown) => (v === undefined || v === null || v === "" ? "-" : typeof v === "boolean" ? (v ? t("common.yes") : t("common.no")) : String(v));
  return (
    <div className="parts-decision" role="group" aria-label={t("card.parts_decision")}>
      <p className="muted copy-sm">{t("card.parts_decision.intro")}</p>
      {items.map((it) => {
        const cur = choice[it.ref] ?? { choice: defaultChoice(it), lcsc: it.actual?.lcsc };
        const shown: Candidate | null = cur.choice === "alternate" ? (it.candidates.find((c) => c.lcsc === cur.lcsc) ?? it.candidates[0] ?? null) : it.actual;
        const diffs = new Set(diffFields(it.expected, shown));
        const fields = DECISION_FIELDS.filter((f) => it.expected[f] !== undefined || (shown && shown[f] !== undefined));
        // Verification belongs to `actual` (what the agent matched), not to a hand-picked alternate.
        const verifiedFields = shown && it.actual && shown.lcsc === it.actual.lcsc ? (it.verified_fields ?? []) : [];
        const datasheet = shown?.datasheet;
        const pick = (c: Choice) => onChange(it.ref, { choice: c, lcsc: c === "alternate" ? (cur.lcsc && it.candidates.some((x) => x.lcsc === cur.lcsc) ? cur.lcsc : it.candidates[0]?.lcsc) : it.actual?.lcsc });
        return (
          <div key={it.ref} className="pd-item">
            <div className="row pd-head"><span className="fs-mono pd-ref">{it.ref}</span>{it.note && <span className="muted copy-sm truncate">{it.note}</span>}</div>
            {/* One line per part saying what the table below actually is: catalogue values the
                agent read, not a datasheet comparison. A verified item names the fields a
                quote-checked datasheet fact confirmed. The datasheet link (http(s) only, opened
                through Rust) is the one click that turns the claim into something checkable. */}
            <div className="row pd-claim copy-sm">
              <Icon name={verifiedFields.length ? "done" : "warning"} className="icon-sm" />
              <span className="grow">{verifiedFields.length ? t("card.parts_decision.verified", { fields: verifiedFields.map((f) => t(`card.parts_decision.field.${f}` as "card.parts_decision.field.mpn")).join(", ") }) : t("card.parts_decision.claim")}</span>
              {datasheet && <a href={datasheet} rel="noreferrer noopener" className="nowrap" onClick={(e) => { e.preventDefault(); if (isTauri()) void call("open_url", { url: datasheet }).catch(() => undefined); else window.open(datasheet, "_blank", "noopener,noreferrer"); }}>{t("card.parts_decision.datasheet")}</a>}
            </div>
            <table className="pd-table">
              <thead><tr><th /><th>{t("card.parts_decision.expected")}</th><th>{t("card.parts_decision.actual")}</th></tr></thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f} className={diffs.has(f) ? "pd-diff" : ""}>
                    <td className="pd-field">{t(`card.parts_decision.field.${f}` as "card.parts_decision.field.mpn")}</td>
                    <td className="fs-mono">{fmt(it.expected[f])}</td>
                    <td className="fs-mono">{shown ? fmt(shown[f]) : <span className="muted">{t("card.parts_decision.none")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pd-choices" role="radiogroup" aria-label={it.ref}>
              {(["accept", "alternate", "review", "dnp", "no_part"] as Choice[]).map((c) => {
                const off = disabled || ((c === "accept" || c === "review") && !it.actual) || (c === "alternate" && it.candidates.length === 0);
                return (
                  <label key={c} className={`question-option ${cur.choice === c ? "checked" : ""} ${off ? "disabled" : ""}`}>
                    <input type="radio" name={`pd-${it.ref}`} value={c} checked={cur.choice === c} disabled={off} onChange={() => pick(c)} />
                    <span>{t(`card.parts_decision.${c}` as "card.parts_decision.accept")}</span>
                  </label>
                );
              })}
              {cur.choice === "alternate" && it.candidates.length > 0 && (
                <select className="pd-select fs-mono" aria-label={t("card.parts_decision.candidates")} value={cur.lcsc ?? it.candidates[0].lcsc} disabled={disabled} onChange={(e) => onChange(it.ref, { choice: "alternate", lcsc: e.target.value })}>
                  {it.candidates.map((c) => <option key={c.lcsc} value={c.lcsc}>{[c.lcsc, c.mpn, c.package, c.value].filter(Boolean).join(" · ")}</option>)}
                </select>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Intake card issued by the harness: one row per detected file with its kind and the suggested action. */
function IntakeBody({ data }: { data: unknown }) {
  const t = useT();
  const d = (data ?? {}) as { items?: { name?: string; kind?: string; action?: string; size?: number }[] };
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return null;
  return (
    <table className="intake-table">
      <thead><tr><th>{t("common.name")}</th><th>{t("intake.detected")}</th><th>{t("intake.action")}</th></tr></thead>
      <tbody>
        {items.map((it, i) => (
          <tr key={i}><td className="truncate intake-name">{String(it.name ?? "")}</td><td className="muted copy-sm">{safeT(t, `intake.kind.${String(it.kind ?? "unknown")}`)}</td><td className="muted copy-sm">{safeT(t, `intake.action.${String(it.action ?? "attach")}`)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function safeT(t: ReturnType<typeof useT>, key: string, params?: Record<string, string | number>): string {
  try { return t(key as "common.ok", params); } catch { return key; }
}

/**
 * The turn summary card (`summaryCard`, agent-runtime.md §7): counts, the parts the turn drew and
 * the fields it changed by name, the files it wrote, and — the reason this card exists at all —
 * the automatic decisions of an Auto run, each with its reason. Structured data only, no prose.
 */
function TurnSummaryBody({ data }: { data: unknown }) {
  const t = useT();
  const d = (data ?? {}) as { summary?: TurnSummary; auto_decisions?: unknown };
  const applied = d.summary?.applied;
  const decisions = (Array.isArray(d.auto_decisions) ? d.auto_decisions : []) as { step?: unknown; condition?: unknown; action?: unknown; detail?: unknown }[];
  const added = addedLine(applied?.created, t);
  const changed = changedLine(applied?.changed, t);
  const moved = movedLine(applied?.changed, t);
  const wrote = !!applied && (applied.components_added > 0 || applied.components_deleted > 0 || applied.wires_added > 0 || (applied.power_ports_added ?? 0) > 0 || (applied.components_moved ?? 0) > 0);
  const nets = netLines(applied?.nets, t);
  const acceptance = d.summary?.acceptance ?? [];
  return (
    <div className="turn-summary-body">
      {applied && wrote && (
        <div className="muted copy-sm fs-mono">
          {t("chat.summaryComponents", { add: applied.components_added, del: applied.components_deleted })}
          {(applied.power_ports_added ?? 0) > 0 ? ` · ${t("chat.summaryPowerPorts", { n: applied.power_ports_added ?? 0 })}` : ""}
          {` · ${t("chat.summaryWires", { n: applied.wires_added })}`}
        </div>
      )}
      {applied && !wrote && <div className="muted copy-sm">{t("card.summary.nothingWritten")}</div>}
      {added && <div><span className="copy-sm">{t("card.summary.added")}</span> <span className="muted copy-sm fs-mono selectable">{added}</span></div>}
      {changed && <div><span className="copy-sm">{t("card.summary.changed")}</span> <span className="muted copy-sm fs-mono selectable">{changed}</span></div>}
      {moved && <div><span className="copy-sm">{t("card.summary.moved")}</span> <span className="muted copy-sm fs-mono selectable">{moved}</span></div>}
      {nets.map((line, i) => <div key={i} className="muted copy-sm fs-mono selectable">{line}</div>)}
      {/* The plan's typed acceptance as the engine measured it at the gate step: a report, never a verdict
          of this card's own (red line 6). Each row is the assertion and what the engine found. */}
      {acceptance.length > 0 && (
        <div className="turn-summary-acceptance" role="group" aria-label={t("chat.summaryAcceptanceTitle")}>
          {/* Advisory rows (restated by the harness from the plan itself) are counted apart: they are shown, they never pass or fail the plan. */}
          <div className="hardstop-zone-label"><Icon name="findings" className="icon-sm" /> {t("chat.summaryAcceptanceTitle")} · {t("chat.summaryAcceptance", acceptanceTally(acceptance))}{acceptanceTally(acceptance).advisory > 0 ? ` · ${t("chat.summaryAcceptanceAdvisory", { n: acceptanceTally(acceptance).advisory })}` : ""}</div>
          <ul>
            {acceptance.slice(0, ACCEPTANCE_ROWS_MAX).map((r, i) => (
              <li key={i}>
                <span className="copy-sm">{t(`chat.acceptanceStatus.${r.status}` as "chat.acceptanceStatus.pass")}</span>{" "}
                <span className="fs-mono copy-sm selectable">{r.block} · {r.label}</span>
                {/* A row the harness restated from the plan's own parts and nets, not one the Architect wrote. */}
                {r.derived ? <span className="muted copy-sm"> · {t("chat.acceptanceDerived")}</span> : null}
                {r.detail ? <span className="muted copy-sm fs-mono selectable"> · {r.detail}</span> : null}
                {r.status === "na" && r.na_reason ? <span className="muted copy-sm"> · {t(`chat.acceptanceNa.${r.na_reason}` as "chat.acceptanceNa.informational")}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!applied?.sheets.length && (
        <div><span className="copy-sm">{t("card.summary.sheets")}</span> <span className="muted copy-sm fs-mono selectable">{applied.sheets.join(", ")}</span></div>
      )}
      {decisions.length > 0 && (
        <div className="turn-summary-auto" role="group" aria-label={t("chat.summaryAuto")}>
          <div className="hardstop-zone-label"><Icon name="agent" className="icon-sm" /> {t("chat.summaryAuto")}</div>
          <ul>
            {decisions.map((x, i) => (
              <li key={i}>
                <span className="fs-mono copy-sm">{t("card.summary.autoRow", { step: String(x.step ?? "-"), condition: String(x.condition ?? "-"), action: String(x.action ?? "-") })}</span>
                {typeof x.detail === "string" && x.detail ? <span className="muted copy-sm selectable"> — {x.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Card data as template parameters: scalars as they are, arrays joined, a `title` that is an i18n
 * key translated, and any `*_key` field translated with the card's other params — how a sentence
 * that reads differently in two cases (KiCad ERC ran / did not run) stays one translatable string
 * per case instead of English glued in by the harness.
 */
/** Recovery notes (`{code, ...params}`) to localised lines; a string is a note persisted by a build that still wrote prose. */
export function recoveryNoteLines(t: ReturnType<typeof useT>, notes: unknown): string[] {
  if (!Array.isArray(notes)) return [];
  const out: string[] = [];
  for (const n of notes) {
    if (typeof n === "string") { if (n) out.push(n); continue; }
    if (!n || typeof n !== "object") continue;
    const { code, ...params } = n as { code?: unknown } & Record<string, unknown>;
    const key = `recovery.note.${String(code)}`;
    out.push(hasKey(key) ? t(key as "recovery.note.step_needs_review", flatParams(t, params)) : t("recovery.note.unknown", { code: String(code) }));
  }
  return out;
}

function flatParams(t: ReturnType<typeof useT>, data: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (!data || typeof data !== "object") return out;
  const isKey = (v: string) => /^[a-z_]+(\.[a-z_]+)+$/.test(v);
  const nested: [string, string][] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v === "number") out[k] = v;
    else if (typeof v === "string") {
      if (k === "title" && isKey(v)) out[k] = safeT(t, v);
      else if (k.endsWith("_key") && isKey(v)) nested.push([k, v]);
      else out[k] = v;
    }
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "object" && x ? JSON.stringify(x) : String(x))).join(", ");
    else if (v === null || v === undefined) out[k] = "";
  }
  for (const [k, v] of nested) out[k] = safeT(t, v, out);
  return out;
}

function ChangeSummary({ data }: { data: unknown }) {
  const t = useT();
  const d = data as { counts?: { added?: number; deleted?: number; wires?: number; authored?: number }; net_lines?: string[]; net_diff_lines?: string[]; files?: string[] } | null;
  if (!d) return null;
  const lines = d.net_lines ?? d.net_diff_lines ?? [];
  return (
    <div className="change-summary fs-mono copy-sm">
      {d.counts && <div>{t("chat.summaryComponents", { add: d.counts.added ?? 0, del: d.counts.deleted ?? 0 })} · {t("chat.summaryWires", { n: d.counts.wires ?? 0 })}{typeof d.counts.authored === "number" ? ` · ${t("chat.ops", { n: d.counts.authored })}` : ""}</div>}
      {lines.map((l, i) => <div key={i} className={/^!|merge|split/i.test(l) ? "net-risk" : ""}>{l}</div>)}
      {d.files && <div className="muted">{d.files.join(", ")}</div>}
    </div>
  );
}
