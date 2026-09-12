// SPDX-License-Identifier: Apache-2.0
// Card construction. Cards are UI objects delivered only through
// `TurnEvent{kind:"card"}`; the model receives structured tool results, never
// card text. Titles/bodies here are keys or sanitised text the UI renders as
// text nodes (no HTML).

import type { Card, CardAction, CardKind } from "./api";
import { localId, sha256Hex, canonicalJson } from "./util";

export function action(id: string, label_key: string, style: CardAction["style"] = "secondary", consent?: CardAction["consent"]): CardAction {
  return consent ? { id, label_key, style, consent } : { id, label_key, style };
}

export function payloadSha(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

export function makeCard(kind: CardKind, turn: number, title: string, body_md: string, actions: CardAction[], data?: unknown): Card {
  const card: Card = { id: localId("card"), kind, turn, title, body_md: sanitizeMarkdown(body_md), actions };
  if (data !== undefined) card.data = data;
  return card;
}

/** Hard-stop card (agent-runtime.md §7): system section is deterministic, agent section is marked unverified. */
export function hardStopCard(turn: number, condition: string, system: Record<string, unknown>, agentNote: string | undefined, grantKind: string, bindSha?: string): Card {
  // `bindSha` is what the approval unlocks, when the caller can name it: a `scope` card passes the
  // sha of the exact widened envelope (`envelopeSha`), which is the same string Rust's `begin_turn`
  // requires the grant to carry. Without it the sha only identifies the card, which is why a scope
  // approval used to be spendable on any later widening in the turn.
  const sha = bindSha ?? payloadSha({ condition, system });
  const needsReason = condition === "net_risk" || condition === "structural";
  const body = [
    "### system",
    "```json",
    JSON.stringify(system, null, 2),
    "```",
    agentNote ? `### agent (unverified)\n${agentNote}` : "",
  ].filter(Boolean).join("\n");
  return makeCard("hard_stop", turn, `hard_stop.${condition}`, body, [
    action("modify", "card.modify_instruction", "primary"),
    action("approve", "card.approve", "secondary", { grant_kind: grantKind, payload_sha256: sha }),
    action("abandon", "card.abandon_turn", "destructive"),
  ], { condition, system, needs_reason: needsReason, payload_sha256: sha });
}

/**
 * Provider hard stop (`ui-states.md` §A(P) "needs waiting" / "needs handling"): quota, rate limit or
 * sign-in. Nothing here is a permission the human can grant, so there is no `approve`; the plan is
 * paused at this step and the actions are about the provider — retry now, wait and continue later,
 * switch provider (the card view opens the Models settings), or abandon the turn.
 */
export function providerStopCard(turn: number, system: Record<string, unknown>): Card {
  const body = ["### system", "```json", JSON.stringify(system, null, 2), "```"].join("\n");
  return makeCard("hard_stop", turn, "hard_stop.provider_exhausted", body, [
    action("retry_now", "card.retry_now", "primary"),
    action("wait", "card.wait_later", "secondary"),
    action("switch_provider", "card.switch_provider", "secondary"),
    action("abandon", "card.abandon_turn", "destructive"),
  ], { condition: "provider_exhausted", system });
}

export function questionCard(turn: number, question: string, options: string[] | undefined, allowFree: boolean, def: string | undefined): Card {
  const actions: CardAction[] = (options ?? []).map((o, i) => action(`opt:${i}`, o, i === 0 ? "primary" : "secondary"));
  if (allowFree || actions.length === 0) actions.push(action("free", "card.answer_free", "secondary"));
  return makeCard("question", turn, "card.question", question, actions, { options, allow_free_text: allowFree, default: def });
}

/**
 * FR-611 question card (`ui-states.md` H `INSTANCE_REFS_REQUIRED`): a sheet file that is
 * instantiated more than once carries parts without a reference for every instance path. The body
 * is identifiers only (the UI adds the localised copy from `error.INSTANCE_REFS_REQUIRED.*`), and
 * neither option is a consent event.
 */
export function instanceRefsCard(turn: number, d: { sheet: string; instances: number; paths: string[]; refs: string[]; deletions_available: number }): Card {
  const body = ["```json", JSON.stringify({ sheet: d.sheet, instances: d.instances, instance_paths: d.paths, parts: d.refs }, null, 2), "```"].join("\n");
  return makeCard("question", turn, "card.instance_refs", body, [
    action("all", "card.instance_all", "primary"),
    action("this_only", "card.instance_this_only", "secondary"),
  ], { code: "INSTANCE_REFS_REQUIRED", ...d });
}

export function changeCard(turn: number, request: unknown, counts: { authored: number; expanded: number; added?: number; deleted?: number; wires?: number }, netDiffLines: string[], preview: unknown): Card {
  const sha = payloadSha(request);
  return makeCard("change", turn, "card.change", netDiffLines.map((l) => `! ${l}`).join("\n"), [
    action("apply", "card.apply", "primary", { grant_kind: "user_action", payload_sha256: sha }),
    action("skip", "card.skip_step", "secondary"),
    action("modify", "card.modify_instruction", "secondary"),
  ], { request, counts, net_diff_lines: netDiffLines, preview, payload_sha256: sha });
}

export function planCard(turn: number, plan: unknown, summary: Record<string, unknown>, diffFromPrev?: unknown, body_md = ""): Card {
  const sha = payloadSha(plan);
  return makeCard("plan_approval", turn, "card.plan", body_md, [
    action("adopt", "card.run_plan_review", "primary", { grant_kind: "policy", payload_sha256: sha }),
    action("adopt_auto", "card.run_plan_auto", "secondary", { grant_kind: "policy", payload_sha256: sha }),
    action("discuss", "card.discuss_plan", "secondary"),
  ], { plan, summary, diff: diffFromPrev, payload_sha256: sha });
}

export function systemCard(turn: number, text_key: string, params: Record<string, unknown>, actions: CardAction[] = []): Card {
  return makeCard("system", turn, text_key, "", actions, params);
}

/**
 * What a rollback did. The action restores the one-shot snapshot of the files
 * the rollback overwrote (D-34): offered only while that snapshot exists, and
 * single use (restoring consumes it). It is not a redo — the reverted turns
 * stay reverted, only the files come back.
 */
export function rollbackDoneCard(turn: number, data: { turn: number; before_turn: number; files: string[]; removed: string[]; pre_rollback: number | null }): Card {
  const actions = data.pre_rollback == null ? [] : [action("restore_pre_rollback", "card.restore_pre_rollback", "secondary", { grant_kind: "rollback", payload_sha256: payloadSha({ pre_rollback: data.pre_rollback }) })];
  return systemCard(turn, "system.rollback_done", data, actions);
}

export function summaryCard(turn: number, summary: unknown, autoDecisions: unknown[], wasQuestion: boolean): Card {
  const actions = [action("rollback", "card.rollback_before_turn", "destructive", { grant_kind: "rollback", payload_sha256: payloadSha({ turn }) })];
  if (wasQuestion) actions.push(action("do_it", "card.do_this", "primary"));
  return makeCard("system", turn, "card.turn_summary", "", actions, { summary, auto_decisions: autoDecisions });
}

/** Strip raw HTML and button-like markup from model prose (SECURITY.md rendering rule). */
export function sanitizeMarkdown(md: string): string {
  return md
    .replace(/<(script|style|iframe|object|embed|svg)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(script|style|iframe|object|embed|button|form|input|svg)[^>]*>/gi, "")
    .replace(/<[^>]+(class|style|role|onclick|href)\s*=[^>]*>/gi, "")
    .replace(/<\/?(div|span|a)[^>]*>/gi, "");
}
