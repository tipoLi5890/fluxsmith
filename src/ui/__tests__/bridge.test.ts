// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createBridge, setHarnessFactory } from "../harness-bridge";
import type { HarnessApi, HarnessState, Ref, TurnEvent } from "../../agent/api";

function fakeHarness() {
  const subs = new Set<(e: TurnEvent) => void>();
  let st: HarnessState = { project_key: null, session_id: null, mode: "plan", policy: "review", running: false, current_turn: null, build_session: null, plan_ref: null, turns: [], cards: [], context: null };
  const calls: string[] = [];
  const selections: Ref[][] = [];
  const h: HarnessApi = {
    async attach(p, s) { st = { ...st, project_key: p, session_id: s }; },
    async detach() { /* */ },
    state: () => st,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    async setMode(mode, cid) { calls.push(`setMode:${mode}:${cid ?? ""}`); st = { ...st, mode }; },
    async setPolicy(policy) { st = { ...st, policy }; },
    async send() { st = { ...st, running: true, current_turn: 1 }; },
    async stop() { /* */ },
    async answerCard(id, a, _f, cid) { calls.push(`answer:${id}:${a}:${cid ?? ""}`); },
    async rollbackBefore() { /* */ }, async restorePreRollback() { /* */ },
    async compact() { /* */ },
    setSelection(refs) { selections.push(refs); },
    async setLeadModel(id) { calls.push(`model:${id}`); },
    leadModel() { return null; }, async setThinkingLevel() { /* */ }, thinkingLevel() { return "medium" as const; }, replay() { return []; }, plan() { return null; }, async editPlan() { /* */ }, async requestFix() { /* */ }, async waiveFinding() { /* */ },
  };
  return { h, emit: (e: TurnEvent) => subs.forEach((s) => s(e)), calls, selections };
}

describe("harness bridge", () => {
  it("reduces TurnEvents into turn blocks, phases, cards and pending card", async () => {
    const { h, emit } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    expect(bridge.getState().ready).toBe(true);
    emit({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "Add caps", envelope: null });
    emit({ kind: "phase", turn: 1, role: "lead", phase: "exploring" });
    emit({ kind: "activity", turn: 1, line: { id: "a1", role: "lead", phase: "exploring", label: "sch.read", started_at: new Date().toISOString() } });
    emit({ kind: "phase", turn: 1, role: "lead", phase: "waiting" });
    emit({ kind: "card", card: { id: "c1", kind: "hard_stop", turn: 1, title: "net risk", body_md: "x", actions: [{ id: "approve", label_key: "card.approve", style: "primary", consent: { grant_kind: "net_risk", payload_sha256: "abc" } }] } });
    const s = bridge.getState();
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].phases.map((p) => p.phase)).toEqual(["exploring", "waiting"]);
    expect(s.turns[0].phases[0].ended_at).toBeTruthy();
    expect(s.turns[0].phases[0].activities).toHaveLength(1);
    expect(s.pendingCardId).toBe("c1");
    emit({ kind: "card_answered", card_id: "c1", action_id: "approve" });
    expect(bridge.getState().pendingCardId).toBeNull();
    emit({ kind: "turn_ended", summary: { turn: 1, kind: "instruction", mode: "build", headline: "Add caps", outcome: "done", applied: { components_added: 4, components_deleted: 0, wires_added: 8, sheets: ["root"] }, cost_usd: 0.1, tokens: 1000, duration_ms: 5000, checkpoint: 1 } });
    expect(bridge.getState().turns[0].summary?.applied.components_added).toBe(4);
    expect(bridge.getState().turns[0].phases[1].ended_at).toBeTruthy();
  });
  it("never creates two groups for one turn: pending user messages attach on turn_started, reused numbers merge", async () => {
    const { h, emit } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    const msg = (text: string) => ({ text, refs: [], attachments: [], session_id: "s1" });
    await bridge.getState().send(msg("hello"));
    expect(bridge.getState().pending).toHaveLength(1);
    expect(bridge.getState().turns).toHaveLength(0);
    emit({ kind: "turn_started", turn: 1, turn_kind: "question", mode: "plan", headline: "hi", envelope: null });
    expect(bridge.getState().pending).toHaveLength(0);
    emit({ kind: "turn_ended", summary: { turn: 1, kind: "question", mode: "plan", headline: "hi", outcome: "done", applied: { components_added: 0, components_deleted: 0, wires_added: 0, sheets: [] }, cost_usd: 0, tokens: 10, duration_ms: 100 } });
    // The harness reuses turn 1 (the previous turn never advanced the counter).
    await bridge.getState().send(msg("again"));
    emit({ kind: "turn_started", turn: 1, turn_kind: "question", mode: "plan", headline: "again", envelope: null });
    const turns = bridge.getState().turns;
    expect(turns.map((t) => t.turn)).toEqual([1]);
    expect(turns[0].messages.filter((m) => m.kind === "user").map((m) => m.text)).toEqual(["hello", "again"]);
    expect(turns[0].summary).toBeUndefined();
    // Events for turn 2 arriving before its turn_started still land in exactly one group.
    emit({ kind: "assistant_delta", turn: 2, message_id: "m2", delta: "wor" });
    emit({ kind: "activity", turn: 2, line: { id: "a2", role: "lead", phase: "exploring", label: "sch.read", started_at: new Date().toISOString() } });
    emit({ kind: "turn_started", turn: 2, turn_kind: "instruction", mode: "build", headline: "do", envelope: null });
    emit({ kind: "turn_ended", summary: { turn: 2, kind: "instruction", mode: "build", headline: "do", outcome: "done", applied: { components_added: 1, components_deleted: 0, wires_added: 0, sheets: ["root"] }, cost_usd: 0, tokens: 10, duration_ms: 100 } });
    const t2 = bridge.getState().turns;
    expect(t2.map((t) => t.turn)).toEqual([1, 2]);
    expect(t2[1].messages.find((m) => m.id === "m2")?.text).toBe("wor");
    expect(t2[1].phases.flatMap((p) => p.activities)).toHaveLength(1);
    expect(t2[1].summary?.outcome).toBe("done");
  });
  it("resets per-session state on detach and restores findings from the transcript on attach", async () => {
    const { h, emit } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    emit({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "a", envelope: null });
    emit({ kind: "findings", turn: 1, findings: [{ code: "ERC_X", severity: "Error", message: "m", origin: "engine", turn: 1, resolved: false }] });
    emit({ kind: "focus", refs: [{ kind: "component", ref: "R1" }] });
    expect(bridge.getState().findings).toHaveLength(1);
    await bridge.getState().detach();
    expect(bridge.getState().findings).toEqual([]);
    expect(bridge.getState().focus).toEqual([]);
    expect(bridge.getState().events).toEqual([]);
    // a transcript replay that carries findings restores them
    h.replay = () => [{ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "a", envelope: null }, { kind: "findings", turn: 1, findings: [{ code: "ERC_Y", severity: "Warning", message: "w", origin: "engine", turn: 1, resolved: false }] }];
    await bridge.getState().attach("p1", "s2");
    expect(bridge.getState().findings.map((f) => f.code)).toEqual(["ERC_Y"]);
  });
  it("keeps a recorded free text when a later card_answered event for the same card has none", async () => {
    const { h, emit } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    emit({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "a", envelope: null });
    emit({ kind: "card", card: { id: "q1", kind: "question", turn: 1, title: "card.question", body_md: "?", actions: [{ id: "free", label_key: "card.answer_free", style: "secondary" }] } });
    emit({ kind: "card_answered", card_id: "q1", action_id: "free", free_text: "ATtiny85" });
    emit({ kind: "card_answered", card_id: "q1", action_id: "free" });
    expect(bridge.getState().cards.q1.answered?.free_text).toBe("ATtiny85");
    // replayed applies rebuild the footer data
    h.replay = () => [{ kind: "turn_started", turn: 2, turn_kind: "instruction", mode: "build", headline: "b", envelope: null }, { kind: "applied", turn: 2, run_id: "r2", target: "root.kicad_sch", counts: { added: 2, deleted: 0, wires: 1 }, net_diff: { changes: [] } }];
    await bridge.getState().attach("p1", "s2");
    expect(bridge.getState().turns.find((t) => t.turn === 2)?.applied.length).toBe(1);
  });
  it("drops the pending bubble and rethrows when send fails, and surfaces answerCard failures", async () => {
    const { h } = fakeHarness();
    h.send = async () => { throw new Error("SEND_BOOM"); };
    h.answerCard = async () => { throw new Error("CONSENT_REQUIRED"); };
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    await expect(bridge.getState().send({ text: "hi", refs: [], attachments: [], session_id: "s1" })).rejects.toThrow("SEND_BOOM");
    expect(bridge.getState().pending).toEqual([]);
    expect(bridge.getState().turns.some((t) => t.error)).toBe(true);
    await expect(bridge.getState().answerCard("c1", "approve")).rejects.toThrow("CONSENT_REQUIRED");
  });
  it("marks turns reverted on rollback", async () => {
    const { h, emit } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    emit({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "a", envelope: null });
    emit({ kind: "turn_started", turn: 2, turn_kind: "instruction", mode: "build", headline: "b", envelope: null });
    await bridge.getState().rollbackBefore(2, "consent-1");
    expect(bridge.getState().turns.map((t) => !!t.rolled_back)).toEqual([false, true]);
  });
});

import { describe as d3, it as it3, expect as e3 } from "vitest";
import { createBridge as mk3, reduceEvent as red3, type BridgeState as BS3 } from "../harness-bridge";
d3("turn body order", () => {
  it3("keeps arrival order: a card asked before the final prose stays before it", () => {
    let s = mk3().getState() as BS3;
    const apply = (e: Parameters<typeof red3>[1]) => { s = { ...s, ...red3(s, e) }; };
    apply({ kind: "turn_started", turn: 1, turn_kind: "question", mode: "plan", headline: "h", envelope: null });
    apply({ kind: "activity", turn: 1, line: { id: "a1", role: "lead", phase: "exploring", label: "sch.read", started_at: "t" } });
    apply({ kind: "card", card: { id: "c1", kind: "question", turn: 1, title: "card.question", body_md: "?", actions: [{ id: "opt:0", label_key: "card.option", label: "A", style: "primary" }] } });
    apply({ kind: "assistant_done", turn: 1, message_id: "m1", text: "final" });
    const kinds = s.turns[0].items.map((i) => `${i.kind}:${i.id}`);
    e3(kinds).toEqual(["activity:a1", "card:c1", "message:m1"]);
  });
});

d3("plan cards wait for the stream", () => {
  it3("holds a plan_approval card while the turn runs and releases it (last) on turn_ended", () => {
    let s = mk3().getState() as BS3;
    const apply = (e: Parameters<typeof red3>[1]) => { s = { ...s, ...red3(s, e) }; };
    apply({ kind: "turn_started", turn: 2, turn_kind: "instruction", mode: "plan", headline: "h", envelope: null });
    apply({ kind: "card", card: { id: "p1", kind: "plan_approval", turn: 2, title: "card.plan", body_md: "plan", data: { plan: {} }, actions: [{ id: "adopt", label_key: "card.run_plan_review", style: "primary" }] } });
    apply({ kind: "assistant_done", turn: 2, message_id: "m2", text: "summary" });
    e3(s.turns[0].items.map((i) => `${i.kind}:${i.id}`)).toEqual(["message:m2"]);
    e3(s.cards.p1).toBeTruthy();
    e3(s.pendingCardId).toBeNull(); // held: not yet something the user can answer
    apply({ kind: "turn_ended", summary: { turn: 2, kind: "instruction", mode: "plan", headline: "h", outcome: "done", applied: { components_added: 0, components_deleted: 0, wires_added: 0, sheets: [] }, cost_usd: 0, tokens: 0, duration_ms: 1 } });
    e3(s.turns[0].items.map((i) => `${i.kind}:${i.id}`)).toEqual(["message:m2", "card:p1"]);
    e3(s.turns[0].heldCards ?? []).toEqual([]);
    e3(s.pendingCardId).toBe("p1");
  });
});

d3("live stream details", () => {
  it3("keeps started_at/detail when a tool line completes, nests subagent children, and tracks the ghost preview", () => {
    let s = mk3().getState() as BS3;
    const apply = (e: Parameters<typeof red3>[1]) => { s = { ...s, ...red3(s, e) }; };
    apply({ kind: "turn_started", turn: 3, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
    apply({ kind: "activity", turn: 3, line: { id: "t1", role: "lead", phase: "exploring", label: "sch.read", detail: "sheet=a", started_at: "2026-01-01T00:00:00.000Z", kind: "tool" } });
    apply({ kind: "activity", turn: 3, line: { id: "t1", role: "lead", phase: "exploring", label: "sch.read", started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:02.000Z", ok: true, bytes: 10 } });
    const t1 = s.turns[0].phases.flatMap((p) => p.activities).find((a) => a.id === "t1")!;
    e3(t1.detail).toBe("sheet=a");
    e3(t1.ended_at).toBe("2026-01-01T00:00:02.000Z");
    apply({ kind: "activity", turn: 3, line: { id: "sub1", role: "drafter", phase: "building", label: "drafter", started_at: "t", kind: "subagent" } });
    apply({ kind: "activity", turn: 3, line: { id: "sub1:c1", role: "drafter", phase: "exploring", label: "sch.pins", started_at: "t", kind: "tool", parent_id: "sub1" } });
    apply({ kind: "activity", turn: 3, line: { id: "sub1:think", role: "drafter", phase: "thinking", label: "thinking", started_at: "t", kind: "thinking", tokens: 12, parent_id: "sub1" } });
    apply({ kind: "activity", turn: 3, line: { id: "sub1:think", role: "drafter", phase: "thinking", label: "thinking", started_at: "t", kind: "thinking", tokens: 40, parent_id: "sub1" } });
    const acts = s.turns[0].phases.flatMap((p) => p.activities);
    e3(acts.filter((a) => a.parent_id === "sub1").map((a) => a.id)).toEqual(["sub1:c1", "sub1:think"]);
    e3(acts.find((a) => a.id === "sub1:think")!.tokens).toBe(40);
    // child lines are not separate chronology items
    e3(s.turns[0].items.map((i) => i.id)).toEqual(["t1", "sub1"]);
    apply({ kind: "phase", turn: 3, role: "drafter", phase: "building", detail: "power" });
    e3(s.currentPhase).toEqual({ phase: "building", role: "drafter", detail: "power" });
    apply({ kind: "preview", turn: 3, preview_id: "abc", sheet: "a.kicad_sch" });
    e3(s.ghost).toEqual({ preview_id: "abc", sheet: "a.kicad_sch", turn: 3 });
    apply({ kind: "applied", turn: 3, run_id: "r", target: "a.kicad_sch", counts: { added: 1, deleted: 0, wires: 0 }, net_diff: null, created: [{ uuid: "u", kind: "symbol" }] });
    e3(s.ghost).toBeNull();
    apply({ kind: "activity", turn: 3, line: { id: "r1", role: "lead", phase: "waiting", label: "provider.retry", detail: "rate_limit 2/3 in 4s", started_at: "t" } });
    e3(s.retrying).toEqual({ i: 2, n: 3 });
  });
});

describe("bridge selection", () => {
  it("mirrors the canvas selection so the sidebar can sync to it", async () => {
    const { h } = fakeHarness();
    setHarnessFactory(() => h);
    const b = createBridge();
    await b.getState().attach("p", "s");
    b.getState().setSelection([{ kind: "component", ref: "R1" }]);
    expect(b.getState().selection).toEqual([{ kind: "component", ref: "R1" }]);
    b.getState().setSelection([]);
    expect(b.getState().selection).toEqual([]);
  });
});

describe("canvas selection attached to the next message", () => {
  const sel: Ref[] = [{ kind: "component", ref: "U1" }];
  const ended = { kind: "turn_ended", summary: { turn: 1, kind: "instruction", mode: "plan", headline: "", outcome: "done", applied: { components_added: 0, components_deleted: 0, wires_added: 0, sheets: [] }, cost_usd: 0, tokens: 0, duration_ms: 1, checkpoint: 1 } } as TurnEvent;

  it("dismissing the pill takes the selection away from the harness and gives it back after the turn", async () => {
    const { h, emit, selections } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    bridge.getState().setSelection(sel);
    expect(selections.pop()).toEqual(sel);
    expect(bridge.getState().selectionSkipped).toBe(false);
    // Dismissed: the harness holds nothing, while the canvas keeps its highlight.
    bridge.getState().skipSelectionOnce();
    expect(selections.pop()).toEqual([]);
    expect(bridge.getState().selection).toEqual(sel);
    expect(bridge.getState().selectionSkipped).toBe(true);
    // One turn later the selection is back: the skip was for that message only.
    emit(ended);
    expect(selections.pop()).toEqual(sel);
    expect(bridge.getState().selectionSkipped).toBe(false);
  });

  it("keeps the skip while a message is still waiting for its turn", async () => {
    const { h, emit, selections } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    bridge.getState().setSelection(sel);
    bridge.getState().skipSelectionOnce();
    // One message is running, a second was typed while it ran: the end of the first turn must not
    // hand the selection back under the message that has not been read yet.
    await bridge.getState().send({ text: "first", refs: [], attachments: [], session_id: "s1" });
    emit({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "plan", headline: "first", envelope: null });
    await bridge.getState().send({ text: "second", refs: [], attachments: [], session_id: "s1" });
    expect(bridge.getState().pending).toHaveLength(1);
    selections.length = 0;
    emit(ended);
    expect(selections).toEqual([]);
    expect(bridge.getState().selectionSkipped).toBe(true);
  });

  it("a new canvas selection ends the skip", async () => {
    const { h } = fakeHarness();
    setHarnessFactory(() => h);
    const bridge = createBridge();
    await bridge.getState().attach("p1", "s1");
    bridge.getState().skipSelectionOnce();
    bridge.getState().setSelection(sel);
    expect(bridge.getState().selectionSkipped).toBe(false);
  });
});

import { netSummary } from "../../agent/turns/state";
import { appliedRefs, netLines } from "../chat/StreamView";
d3("turn footer nets", () => {
  it3("summarises engine net_diff into named-net lines and skips auto nets", () => {
    const nets = netSummary([
      { changes: [{ kind: "Created", name: "UART_TX" }, { kind: "Created", name: "Net-(R1-Pad1)" }, { kind: "Merged", into: "VBUS", sources: [{ name: "+5V", named: true }, { name: "VBUS", named: true }] }, { kind: "Renamed", name: "OLD", into: "NEW" }] },
      { changes: [{ kind: "Split", name: "GND" }, { kind: "Created", name: "UART_TX" }] },
    ]);
    e3(nets).toEqual({ created: ["UART_TX"], merged: ["+5V -> VBUS"], split: ["GND"], renamed: ["OLD -> NEW"] });
    const t = ((k: string, p?: Record<string, unknown>) => `${k}:${JSON.stringify(p ?? {})}`) as unknown as Parameters<typeof netLines>[1];
    e3(netLines(nets, t).length).toBe(4);
    e3(netLines(undefined, t)).toEqual([]);
    const block = { applied: [{ run_id: "r", target: "root.kicad_sch", counts: { added: 1, deleted: 0, wires: 0 }, focus: [{ kind: "component", ref: "R1" }] }], summary: { applied: { sheets: ["root.kicad_sch"] } } } as unknown as Parameters<typeof appliedRefs>[0];
    e3(appliedRefs(block)).toEqual([{ kind: "component", ref: "R1" }]);
    const noFocus = { applied: [{ run_id: "r", target: "root.kicad_sch", counts: { added: 1, deleted: 0, wires: 0 } }], summary: { applied: { sheets: ["root.kicad_sch"] } } } as unknown as Parameters<typeof appliedRefs>[0];
    e3(appliedRefs(noFocus)).toEqual([{ kind: "sheet", path: "root.kicad_sch" }]);
  });
});
