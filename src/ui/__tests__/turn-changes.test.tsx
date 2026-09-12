// SPDX-License-Identifier: Apache-2.0
// What the turn changed has to be readable after the fact: the bridge accumulates every apply of
// the turn (not only the last), the footer names the parts that were drawn and the fields that were
// replaced, in every UI language, and the turn summary card carries the same lists plus the
// automatic decisions of an Auto run.
import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { TurnGroupView } from "../chat/StreamView";
import { addedLine, changedLine, movedLine } from "../chat/turn-lines";
import { CardView } from "../chat/CardView";
import { accumulateChanges, createBridge, reduceEvent, type BridgeState, type TurnBlock } from "../harness-bridge";
import { summaryCard } from "../../agent/cards";
import { rollbackImpact, summaryOf, newTurnRecord, turnChanged, turnCreated, type ApplyRecord } from "../../agent/turns/state";
import { setLang, t as translate, UI_LANGS } from "../../i18n";
import type { ChangedField, CreatedObject } from "../../agent/api";

const R7: CreatedObject = { uuid: "u-r7", kind: "symbol", reference: "R7", value: "1k", sheet: "root.kicad_sch" };
const C4: CreatedObject = { uuid: "u-c4", kind: "symbol", reference: "C4", value: "100n", sheet: "root.kicad_sch" };
const PORT: CreatedObject = { uuid: "u-p", kind: "power_port", reference: "#PWR012", name: "+3V3", sheet: "root.kicad_sch" };
const WIRE: CreatedObject = { uuid: "u-w", kind: "wire", sheet: "root.kicad_sch" };
const R1: ChangedField = { reference: "R1", field: "Value", before: "1k", after: "2k2", sheet: "root.kicad_sch" };

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

afterEach(() => { setLang("en"); document.body.innerHTML = ""; });

describe("bridge accumulation", () => {
  it("keeps every apply of the turn, not only the last one", () => {
    let s = createBridge().getState() as BridgeState;
    const apply = (e: Parameters<typeof reduceEvent>[1]) => { s = { ...s, ...reduceEvent(s, e) }; };
    apply({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
    const counts = { added: 1, deleted: 0, wires: 0 };
    apply({ kind: "applied", turn: 1, run_id: "a", target: "root.kicad_sch", counts, net_diff: null, created: [R7, WIRE], changed: [] });
    apply({ kind: "applied", turn: 1, run_id: "b", target: "root.kicad_sch", counts, net_diff: null, created: [C4, PORT], changed: [R1] });
    expect(s.turnChanges?.uuids).toEqual(["u-r7", "u-w", "u-c4", "u-p"]);
    expect(s.turnChanges?.refs).toEqual(["R1"]);
    expect(s.turnChanges?.created.map((c) => c.uuid)).toEqual(["u-r7", "u-w", "u-c4", "u-p"]);
    // The one-shot reveal still belongs to the last run only.
    expect(s.lastApplied?.run_id).toBe("b");
    // A new turn drops the previous turn's highlight set.
    apply({ kind: "turn_started", turn: 2, turn_kind: "instruction", mode: "build", headline: "h2", envelope: null });
    expect(s.turnChanges).toBeNull();
  });

  it("never lists the same object twice and folds a field written twice into one change", () => {
    const once = accumulateChanges(null, 1, [R7, R7], [R1]);
    expect(once.uuids).toEqual(["u-r7"]);
    const twice = accumulateChanges(once, 1, [], [{ ...R1, before: "2k2", after: "3k3" }]);
    expect(twice.changed).toEqual([{ ...R1, after: "3k3" }]);
    expect(twice.refs).toEqual(["R1"]);
    // A different turn number starts a fresh set rather than merging two turns.
    expect(accumulateChanges(twice, 2, [C4], []).uuids).toEqual(["u-c4"]);
  });

  it("summarises the turn from all of its applies", () => {
    const rec = newTurnRecord(1, 1, "add the divider", [], "build", "now");
    const mk = (created: CreatedObject[], changed: ChangedField[]): ApplyRecord => ({ run_id: "r", target: "root.kicad_sch", expanded_sha256: null, net_diff: null, counts: { added: created.length, deleted: 0, wires: 0 }, created, changed });
    rec.applies.push(mk([R7], []), mk([C4, PORT], [R1]));
    const s = summaryOf(rec, 10);
    expect(s.applied.created?.map((c) => c.reference)).toEqual(["R7", "C4", "#PWR012"]);
    expect(s.applied.changed).toEqual([R1]);
    expect(turnCreated([], 10)).toEqual([]);
    expect(turnChanged(rec.applies, 0)).toEqual([]);
  });
});

describe("footer lines", () => {
  const T = translate as unknown as Parameters<typeof addedLine>[1];
  it("names the parts that were drawn and the fields that were replaced", () => {
    setLang("en");
    expect(addedLine([R7, C4, PORT, WIRE], T)).toBe("Added: R7 1k, C4 100n, +3V3 port");
    expect(changedLine([R1], T)).toBe("Changed: R1 Value 1k → 2k2");
    // A field with no previous value is a plain set, not "changed from nothing".
    expect(changedLine([{ reference: "R1", field: "MPN", before: "", after: "RC0402" }], T)).toBe("Changed: R1 MPN → RC0402");
    // Objects with no name of their own (wires) are left to the counts.
    expect(addedLine([WIRE], T)).toBeNull();
    expect(addedLine(undefined, T)).toBeNull();
    expect(changedLine([], T)).toBeNull();
  });

  it("collapses a long list", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...R7, uuid: `u${i}`, reference: `R${i}` }));
    expect(addedLine(many, T, 3)).toBe("Added: R0 1k, R1 1k, R2 1k +8");
  });

  it("reads in all four UI languages, with the same values", () => {
    for (const lang of UI_LANGS) {
      setLang(lang);
      const added = addedLine([R7, PORT], T)!;
      const changed = changedLine([R1], T)!;
      expect(added).toContain("R7 1k");
      expect(added).toContain("+3V3");
      expect(changed).toContain("1k → 2k2");
      // Every catalogue has its own wording; none falls back to the raw key.
      expect(added.startsWith("chat.")).toBe(false);
      expect(changed.startsWith("chat.")).toBe(false);
    }
    setLang("zh-Hans");
    expect(addedLine([PORT], T)).toBe("新增：+3V3 电源符号");
    setLang("ja");
    expect(changedLine([R1], T)).toBe("変更：R1 Value 1k → 2k2");
  });

  // P0-2: a move is reported by the engine as a pose change (`field: "at"`); the footer names the
  // parts once each on their own line, and keeps them out of the "Changed" line.
  it("names the parts that were moved, once each, in every language", () => {
    const moves: ChangedField[] = [
      { reference: "R1", field: "at", before: "(100,200,0)", after: "(300,200,0)", sheet: "root.kicad_sch" },
      { reference: "R1", field: "at", before: "(300,200,0)", after: "(300,200,90)", sheet: "root.kicad_sch" },
      { reference: "C2", field: "at", before: "(100,400,0)", after: "(300,400,0)", sheet: "root.kicad_sch" },
    ];
    setLang("en");
    expect(movedLine(moves, T)).toBe("Moved: R1, C2");
    expect(changedLine(moves, T)).toBeNull();
    expect(changedLine([...moves, R1], T)).toBe("Changed: R1 Value 1k → 2k2");
    expect(movedLine([R1], T)).toBeNull();
    for (const lang of UI_LANGS) {
      setLang(lang);
      const line = movedLine(moves, T)!;
      expect(line).toContain("R1, C2");
      expect(line.startsWith("chat.")).toBe(false);
    }
    // The turn summary carries the move count, so a move-only turn is not "0 added, 0 deleted".
    const rec = newTurnRecord(1, 1, "move the regulator block", [], "build", "now");
    rec.applies.push({ run_id: "r", target: "root.kicad_sch", expanded_sha256: null, net_diff: null, counts: { added: 0, deleted: 0, wires: 0, moved: 2 }, created: [], changed: moves });
    expect(summaryOf(rec, 10).applied.components_moved).toBe(2);
    expect(rollbackImpact([rec], 1).moved).toBe(2);
  });
});

function block(created: CreatedObject[], changed: ChangedField[]): TurnBlock {
  let s = createBridge().getState() as BridgeState;
  const apply = (e: Parameters<typeof reduceEvent>[1]) => { s = { ...s, ...reduceEvent(s, e) }; };
  apply({ kind: "turn_started", turn: 1, turn_kind: "instruction", mode: "build", headline: "h", envelope: null });
  apply({ kind: "turn_ended", summary: { turn: 1, kind: "instruction", mode: "build", headline: "h", outcome: "done", applied: { components_added: created.length, components_deleted: 0, wires_added: 2, power_ports_added: 0, sheets: ["root.kicad_sch"], created, changed }, cost_usd: 0, tokens: 0, duration_ms: 10, checkpoint: 1 } });
  return s.turns[0];
}

describe("turn footer", () => {
  it("shows what was added and what changed, by name", () => {
    const host = mount(<TurnGroupView block={block([R7, C4, PORT], [R1])} cards={{}} projectKey="pk" density="compact" isCurrent={false} onAnswer={async () => undefined} onRollback={() => undefined} onContinue={() => undefined} onSaveRule={() => undefined} retrying={null} />);
    const text = host.textContent ?? "";
    expect(text).toContain("Added: R7 1k, C4 100n, +3V3 port");
    expect(text).toContain("Changed: R1 Value 1k → 2k2");
  });

  it("makes every name a chip that points the canvas at that object", () => {
    const C7: CreatedObject = { uuid: "u-c7", kind: "symbol", reference: "C7", value: "100n", sheet: "power.kicad_sch" };
    const host = mount(<TurnGroupView block={block([R7, C7, PORT], [R1])} cards={{}} projectKey="pk" density="compact" isCurrent={false} onAnswer={async () => undefined} onRollback={() => undefined} onContinue={() => undefined} onSaveRule={() => undefined} retrying={null} />);
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    document.addEventListener("fs:focus-ref", h);
    const chips = [...host.querySelectorAll<HTMLButtonElement>(".turn-changes button.ref-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["R7 1k", "C7 100n", "+3V3 port", "R1 Value 1k → 2k2"]);
    act(() => { chips[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    document.removeEventListener("fs:focus-ref", h);
    expect(seen[0]).toMatchObject({ kind: "component", value: "C7" });
    // The engine said which sheet drew it: the chip carries that, so the canvas can go there.
    expect((seen[0] as { ref: { sheet: string } }).ref.sheet).toBe("power.kicad_sch");
    // The line still reads as one sentence around the chips.
    expect(host.querySelector(".turn-changes")!.textContent).toContain("Added: R7 1k, C7 100n, +3V3 port");
  });

  it("says nothing about either when the turn drew nothing nameable", () => {
    const text = mount(<TurnGroupView block={block([], [])} cards={{}} projectKey="pk" density="compact" isCurrent={false} onAnswer={async () => undefined} onRollback={() => undefined} onContinue={() => undefined} onSaveRule={() => undefined} retrying={null} />).textContent ?? "";
    expect(text).not.toContain("Added:");
    expect(text).not.toContain("Changed:");
  });
});

describe("turn summary card", () => {
  it("renders the counts, the lists, the sheets and the auto decisions with their reasons", () => {
    const rec = newTurnRecord(3, 1, "run the plan", [], "build", "now");
    rec.applies.push({ run_id: "r", target: "root.kicad_sch", expanded_sha256: null, net_diff: null, counts: { added: 2, deleted: 0, wires: 4, power_ports: 1 }, created: [R7, PORT], changed: [R1] });
    rec.status = "done";
    rec.kind = "instruction";
    const card = summaryCard(3, summaryOf(rec, 10), [{ step: "s2", condition: "scope_widen", action: "skipped", detail: "components_added 9 > 6" }], false);
    const text = mount(<CardView card={card} projectKey="pk" onAnswer={async () => undefined} />).textContent ?? "";
    expect(text).toContain("Turn summary");
    expect(text).toContain("Components +2 / −0");
    expect(text).toContain("Added: R7 1k, +3V3 port");
    expect(text).toContain("Changed: R1 Value 1k → 2k2");
    expect(text).toContain("Sheets written");
    expect(text).toContain("root.kicad_sch");
    expect(text).toContain("Auto decisions");
    expect(text).toContain("s2 · scope_widen · skipped");
    expect(text).toContain("components_added 9 > 6");
  });

  it("says a turn wrote nothing instead of showing an empty change list", () => {
    const rec = newTurnRecord(4, 1, "what is R1?", [], "build", "now");
    rec.status = "done";
    rec.kind = "question";
    const card = summaryCard(4, summaryOf(rec, 10), [], true);
    const text = mount(<CardView card={card} projectKey="pk" onAnswer={async () => undefined} />).textContent ?? "";
    expect(text).toContain("This turn wrote nothing");
    expect(text).not.toContain("Added:");
  });
});
