// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Card } from "../../agent/api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => { throw new Error("no tauri"); }, Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { CardView, parseWidened, waiverRefusal } from "../chat/CardView";
import { hardStopCard, instanceRefsCard, planCard, providerStopCard } from "../../agent/cards";
import { IpcFailure } from "../../ipc/client";
import { errorCopy, fmtDay, t, UI_LANGS } from "../../i18n";
import { expiryDate, WAIVER_DEFAULT_DAYS } from "../../agent/review-waiver";

function mount(el: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
  return host;
}

/** React tracks the DOM value: set it through the prototype setter so the change event is seen. */
function setValue(el: HTMLTextAreaElement | HTMLInputElement, v: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

type ReviewRow = { id: string; code: string; severity: string; message: string; origin?: string; selected?: boolean; waived_until?: string };
function reviewCard(findings: ReviewRow[]): Card {
  return { id: "rv1", kind: "review", turn: 7, title: "card.review", body_md: "1 error · 1 warning", data: { findings }, actions: [
    { id: "fix_selected", label_key: "card.fix_selected", style: "primary", consent: { grant_kind: "user_action", payload_sha256: "sha1" } },
    { id: "waive_selected", label_key: "card.waive_selected", style: "secondary", consent: { grant_kind: "waiver", payload_sha256: "sha2" } },
    { id: "dismiss", label_key: "card.dismiss", style: "secondary" },
  ] };
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 600)); });
const byText = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;

describe("CardView", () => {
  it("recovery card: notes are codes rendered in the UI language, and the keep action is a button", async () => {
    const answers: unknown[] = [];
    const card: Card = {
      id: "rc1", kind: "system", turn: 3, title: "system.recovered", body_md: "- turn 3 step s1: `root.kicad_sch` differs from the recorded sha",
      data: { turn: 3, phase: "building-apply", cleaned: 0, confirmed: 0, review: 1, report: { notes: [{ code: "step_needs_review" }, { code: "rollback_interrupted", before_turn: 2 }, { code: "from_a_newer_build" }, "an old prose note"] } },
      actions: [
        { id: "rollback", label_key: "card.rollback_before_turn", style: "destructive", consent: { grant_kind: "rollback", payload_sha256: "x" } },
        { id: "keep", label_key: "card.keep_files", style: "secondary" },
        { id: "dismiss", label_key: "card.dismiss", style: "secondary" },
      ],
    };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    const text = host.textContent ?? "";
    // Codes become the catalogue copy (with parameters); an unknown code and an old prose note still show.
    expect(text).toContain(t("recovery.note.step_needs_review"));
    expect(text).toContain(t("recovery.note.rollback_interrupted", { before_turn: 2 }));
    expect(text).toContain(t("recovery.note.unknown", { code: "from_a_newer_build" }));
    expect(text).toContain("an old prose note");
    expect(text).not.toContain("recovery.note.");
    // The four catalogues all have the note copy.
    for (const l of UI_LANGS) expect(t("recovery.note.step_needs_review", undefined, l)).not.toContain("recovery.note");
    const keep = byText(host, t("card.keep_files"));
    expect(keep).toBeTruthy();
    await act(async () => { keep.click(); });
    await settle();
    expect(answers).toEqual([["rc1", "keep", undefined, undefined]]);
  });

  it("FR-611: the instance question shows the code's copy and the two options, and answers with the action id", async () => {
    const answers: unknown[] = [];
    const card = instanceRefsCard(4, { sheet: "amp.kicad_sch", instances: 2, paths: ["/r/a", "/r/b"], refs: ["R1", "C1"], deletions_available: 0 });
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    const text = host.textContent ?? "";
    // Localised explanation from the error catalogue, identifiers from the card body.
    expect(text).toContain(errorCopy("INSTANCE_REFS_REQUIRED")!.title);
    expect(text).toContain(errorCopy("INSTANCE_REFS_REQUIRED")!.next);
    expect(text).toContain("amp.kicad_sch");
    expect(text).toContain("/r/b");
    const options = [...host.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(options.map((o) => o.value)).toEqual(["all", "this_only"]);
    // No consent event: a question grants nothing.
    expect(card.actions.some((a) => a.consent)).toBe(false);
    await act(async () => { options[1].click(); });
    const confirm = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === t("card.confirm")) as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    expect(answers[0]).toEqual([card.id, "this_only", undefined, undefined]);
  });

  it("renders an open question (no options) as a text field with a send button", async () => {
    const answers: unknown[] = [];
    const card: Card = { id: "q1", kind: "question", turn: 1, title: "card.question", body_md: "Which MCU?", actions: [{ id: "free", label_key: "card.answer_free", style: "secondary" }], data: { options: [] } };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    expect(host.querySelector("input[type=radio]")).toBeNull();
    const ta = host.querySelector<HTMLTextAreaElement>("textarea");
    expect(ta).not.toBeNull();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Send" || b.textContent?.trim() === "送出") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "ATtiny85 please");
      ta!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.click(); });
    expect(answers[0]).toEqual(["q1", "free", "ATtiny85 please", undefined]);
  });

  it("echoes the typed answer, clipped, once answered", () => {
    const long = "x".repeat(200);
    const card: Card = { id: "q2", kind: "question", turn: 1, title: "card.question", body_md: "?", actions: [{ id: "free", label_key: "card.answer_free", style: "secondary" }], answered: { action_id: "free", at: "now", free_text: long } };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => {}} />);
    expect(host.textContent).toContain("x".repeat(139) + "…");
    expect(host.textContent).not.toContain("x".repeat(140));
    // header shows just the question label, not "kind · title"
    expect(host.textContent).not.toMatch(/Question · /);
  });

  it("renders a hard stop as a table of requested vs ceiling, never raw JSON, and hides modify", () => {
    const card: Card = { id: "h1", kind: "hard_stop", turn: 2, title: "hard_stop.scope_widen", body_md: "```json\n{\"widened\":[]}\n```", actions: [
      { id: "modify", label_key: "card.modify_instruction", style: "primary" },
      { id: "approve", label_key: "card.approve", style: "secondary", consent: { grant_kind: "scope", payload_sha256: "sha" } },
      { id: "abandon", label_key: "card.abandon_turn", style: "destructive" },
    ], data: { condition: "scope_widen", widened: [{ field: "components_added_max", requested: 12, ceiling: 0 }, "sheets: waet.kicad_sch"], agent_note: "needs the whole board" } };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => {}} />);
    const text = host.textContent ?? "";
    expect(text).not.toContain("{\"widened\"");
    expect(host.querySelectorAll(".hardstop-table tr").length).toBe(2);
    expect(text).toContain("12");
    expect(text).toContain("needs the whole board");
    const labels = [...host.querySelectorAll(".card-actions button")].map((b) => b.textContent?.trim());
    expect(labels.some((l) => /Modify|修改/.test(l ?? ""))).toBe(false);
    expect(labels.length).toBe(2);
  });

  it("parseWidened accepts structured and legacy string entries", () => {
    expect(parseWidened(["components_added_max: 12 > 0", { field: "sheets", requested: ["a"], ceiling: ["b"] }, "nets_renamable: A, B"])).toEqual([
      { field: "components_added_max", requested: "12", ceiling: "0" },
      { field: "sheets", requested: "a", ceiling: "b" },
      { field: "nets_renamable", requested: "A, B", ceiling: null },
    ]);
  });

  it("renders string-valued widened rows (sheets / nets) and marks an empty ceiling as not allowed", () => {
    const card: Card = { id: "h2", kind: "hard_stop", turn: 3, title: "hard_stop.scope_widen", body_md: "", actions: [
      { id: "approve", label_key: "card.approve", style: "primary", consent: { grant_kind: "scope", payload_sha256: "x" } },
      { id: "abandon", label_key: "card.abandon_turn", style: "secondary" },
    ], data: { condition: "scope_widen", widened: [{ field: "sheets", requested: "testt.kicad_sch", ceiling: "root.kicad_sch" }, { field: "nets_renamable", requested: "VCC_3V3, GND", ceiling: "" }] } };
    const host = mount(<CardView projectKey="p1" onAnswer={async () => undefined} card={card} />);
    const text = host.textContent ?? "";
    expect(text).toContain("testt.kicad_sch");
    expect(text).toContain("root.kicad_sch");
    expect(text).toContain("VCC_3V3, GND");
    expect(host.querySelectorAll(".hardstop-table tr").length).toBe(2);
  });

  it("multi-select questions submit the chosen labels joined with '; '", async () => {
    const answers: unknown[] = [];
    const card: Card = { id: "q3", kind: "question", turn: 1, title: "card.question", body_md: "Interfaces?", data: { multi: true, options: ["UART", "I2C", "SPI"] },
      actions: [{ id: "opt:0", label_key: "card.option", label: "UART", style: "primary" }, { id: "opt:1", label_key: "card.option", label: "I2C", style: "secondary" }, { id: "opt:2", label_key: "card.option", label: "SPI", style: "secondary" }, { id: "free", label_key: "card.answer_free", style: "secondary" }] };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    const boxes = host.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(boxes.length).toBe(4); // three options + other
    expect(host.querySelector("input[type=radio]")).toBeNull();
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Confirm" || b.textContent?.trim() === "確認") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await act(async () => { boxes[0].click(); });
    await act(async () => { boxes[2].click(); });
    expect(btn.disabled).toBe(false);
    await act(async () => { btn.click(); });
    expect(answers[0]).toEqual(["q3", "free", "UART; SPI", undefined]);
  });

  it("reads the harness card shape (payload under data.system): net names, refdes, tool are visible", async () => {
    const card = hardStopCard(4, "net_risk", { tool: "sch.apply", reason: "named net risk", changes: [{ kind: "Merged", into: "VBUS", named: true, sources: [{ name: "+3V3", named: true }, { name: "VBUS", named: true }] }] }, undefined, "net_risk");
    const answers: unknown[][] = [];
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    const text = host.textContent ?? "";
    expect(text).toContain("+3V3");
    expect(text).toContain("VBUS");
    expect(text).toContain("sch.apply");
    expect(text).not.toContain("\"changes\"");
    // net_risk needs a reason: approve is disabled until one is typed, then the reason travels as free text
    const approve = [...host.querySelectorAll<HTMLButtonElement>(".card-actions button")].find((b) => !/Abandon|放棄|放弃|中止/.test(b.textContent ?? ""))!;
    expect(approve.disabled).toBe(true);
    const ta = host.querySelector<HTMLTextAreaElement>(".hardstop-reason textarea, textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(ta, "rails are the same supply");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // consent buttons arm 500 ms after they are visible
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(approve.disabled).toBe(false);
    await act(async () => { approve.click(); });
    expect(answers[0]?.[1]).toBe("approve");
    expect(answers[0]?.[2]).toBe("rails are the same supply");
    // scope_widen through the same constructor keeps the table
    const scope = hardStopCard(5, "scope_widen", { widened: [{ field: "components_added_max", requested: "12", ceiling: "4" }], ceiling_source: "plan" }, undefined, "scope");
    const host2 = mount(<CardView projectKey="p" card={scope} onAnswer={async () => {}} />);
    expect(host2.querySelectorAll(".hardstop-table tr").length).toBe(1);
    expect(host2.textContent).toContain("12");
    // refdes_conflict has its own title and lists the designators
    const rc = hardStopCard(6, "refdes_conflict", { tool: "sch.apply", reason: "designator conflict", refdes: ["R7", "R8"] }, undefined, "refdes");
    const host3 = mount(<CardView projectKey="p" card={rc} onAnswer={async () => {}} />);
    expect(host3.textContent).toContain("R7");
    expect(host3.textContent).not.toContain("hard_stop.refdes_conflict");
  });
  it("collects a reason and an expiry before an Error is waived, and sends both with the selection", async () => {
    const answers: unknown[][] = [];
    const card = reviewCard([
      { id: "0", code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "VBUS has no driver", origin: "engine", selected: true },
      { id: "1", code: "OFF_GRID", severity: "Warning", message: "R3 off grid", origin: "engine", selected: false },
    ]);
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    await settle();
    await act(async () => { byText(host, t("card.waive_selected")).click(); });
    // The first click only opens the form: nothing is waived before the reason and the expiry are there.
    expect(answers.length).toBe(0);
    const form = host.querySelector<HTMLElement>(".review-waiver")!;
    expect(form).not.toBeNull();
    const record = byText(form, t("card.waiver.record"));
    expect(record.disabled).toBe(true);
    const ta = form.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { setValue(ta, "too short"); });
    expect(record.disabled).toBe(true);
    expect(host.textContent).toContain(t("card.waiver.reasonMore", { n: 3 }));
    await act(async () => { setValue(ta, "external supply on J1, PWR_FLAG placed"); });
    expect(host.textContent).toContain(t("card.waiver.reasonEnough"));
    // 90 days by default; the shortcuts fill the date field.
    const date = form.querySelector<HTMLInputElement>("input[type=date]")!;
    expect(date.value).toBe(expiryDate(WAIVER_DEFAULT_DAYS));
    const radios = [...form.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.length).toBe(3);
    await act(async () => { radios[0].click(); });
    expect(date.value).toBe(expiryDate(30));
    await act(async () => { radios[1].click(); });
    await settle();
    expect(record.disabled).toBe(false);
    await act(async () => { record.click(); });
    expect(answers.length).toBe(1);
    const [id, action, freeText] = answers[0] as [string, string, string];
    expect(id).toBe("rv1");
    expect(action).toBe("waive_selected");
    expect(JSON.parse(freeText)).toEqual({ ids: ["0"], reason: "external supply on J1, PWR_FLAG placed", expires: expiryDate(WAIVER_DEFAULT_DAYS) });
    // The row now says until when it is waived.
    expect(host.textContent).toContain(t("card.waiver.waivedUntil", { date: fmtDay(expiryDate(WAIVER_DEFAULT_DAYS)) }));
  });

  it("waives a warning selection without a reason (the field stays optional)", async () => {
    const answers: unknown[][] = [];
    const card = reviewCard([{ id: "0", code: "OFF_GRID", severity: "Warning", message: "R3 off grid", origin: "engine", selected: true }]);
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    await settle();
    await act(async () => { byText(host, t("card.waive_selected")).click(); });
    const form = host.querySelector<HTMLElement>(".review-waiver")!;
    expect(host.textContent).toContain(t("card.waiver.reasonOptionalHint"));
    const record = byText(form, t("card.waiver.record"));
    await settle();
    expect(record.disabled).toBe(false);
    await act(async () => { record.click(); });
    expect(JSON.parse((answers[0] as [string, string, string])[2])).toEqual({ ids: ["0"], expires: expiryDate(WAIVER_DEFAULT_DAYS) });
  });

  it("answers a refused waiver on the card, in the user's language, and keeps the selection", async () => {
    const { useToasts } = await import("../../state/toasts");
    const before = useToasts.getState().toasts.length;
    const card = reviewCard([{ id: "0", code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "VBUS has no driver", origin: "engine", selected: true }]);
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => {
      throw new IpcFailure({ code: "WAIVER_SEVERITY", message: "<b>an Error</b> is waived only with an expiry and a written reason", req_id: "r1" });
    }} />);
    await settle();
    await act(async () => { byText(host, t("card.waive_selected")).click(); });
    const form = host.querySelector<HTMLElement>(".review-waiver")!;
    await act(async () => { setValue(form.querySelector<HTMLTextAreaElement>("textarea")!, "keeping this one for now"); });
    await settle();
    await act(async () => { byText(form, t("card.waiver.record")).click(); });
    const text = host.textContent ?? "";
    expect(text).toContain(errorCopy("WAIVER_SEVERITY")!.title);
    // The engine message is untrusted evidence: plain text, never markup.
    expect(text).toContain("<b>an Error</b> is waived only");
    expect(host.querySelector("b")).toBeNull();
    // The selection and the form survive so the human can correct the waiver and retry.
    expect(host.querySelector<HTMLInputElement>(".review-row input[type=checkbox]")!.checked).toBe(true);
    expect(host.querySelector(".review-waiver")).not.toBeNull();
    expect(useToasts.getState().toasts.length).toBe(before);
  });

  it("drops the findings a partial waive already recorded, so the retry cannot waive them twice", async () => {
    const sent: string[][] = [];
    const card = reviewCard([
      { id: "0", code: "OFF_GRID", severity: "Warning", message: "R3 off grid", origin: "engine", selected: true },
      { id: "1", code: "LABEL_OVERLAP", severity: "Warning", message: "labels overlap", origin: "engine", selected: true },
    ]);
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (_id, _action, freeText) => {
      const ids = JSON.parse(freeText as string).ids as string[];
      sent.push(ids);
      if (sent.length === 1) {
        // "0" went in, "1" was refused: the refusal names what is already recorded.
        throw new IpcFailure({ code: "WAIVER_SCOPE", message: "no refs", req_id: "r1", evidence: { waived_ids: ["0"] } });
      }
    }} />);
    await settle();
    await act(async () => { byText(host, t("card.waive_selected")).click(); });
    const form = host.querySelector<HTMLElement>(".review-waiver")!;
    await act(async () => { setValue(form.querySelector<HTMLTextAreaElement>("textarea")!, "silk on the panel edge"); });
    await settle();
    await act(async () => { byText(form, t("card.waiver.record")).click(); });
    expect(sent[0]).toEqual(["0", "1"]);
    // The recorded one is unchecked and says until when; the refused one is still selected.
    const boxes = [...host.querySelectorAll<HTMLInputElement>(".review-row input[type=checkbox]")];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    expect(host.textContent).toContain(t("card.waiver.waivedUntil", { date: fmtDay(expiryDate(WAIVER_DEFAULT_DAYS)) }));
    // The retry sends only what is still open.
    await act(async () => { byText(host.querySelector<HTMLElement>(".review-waiver")!, t("card.waiver.record")).click(); });
    expect(sent[1]).toEqual(["1"]);
  });

  it("maps the waiver gate codes to card copy in all four languages; other failures stay toasts", () => {
    for (const code of ["WAIVER_SEVERITY", "WAIVER_SCOPE"]) {
      expect(waiverRefusal(new IpcFailure({ code, message: "m", req_id: "r" }))?.code).toBe(code);
      for (const l of UI_LANGS) expect(errorCopy(code, l)?.title.length, `${l}:${code}`).toBeGreaterThan(0);
    }
    expect(waiverRefusal(new IpcFailure({ code: "DISK_FULL", message: "m", req_id: "r" }))).toBeNull();
    expect(waiverRefusal(new Error("WAIVER_SCOPE: not an IpcFailure"))).toBeNull();
  });

  it("shows an existing waiver on a finding row as a date in the app locale", () => {
    const card = reviewCard([{ id: "0", code: "OFF_GRID", severity: "Warning", message: "R3 off grid", origin: "engine", waived_until: "2027-01-01T00:00:00Z" }]);
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => {}} />);
    expect(host.textContent).toContain(t("card.waiver.waivedUntil", { date: fmtDay("2027-01-01T00:00:00Z") }));
    expect(host.textContent).not.toContain("2027-01-01T00:00:00Z");
  });

  // Before the click, the card says of each row what "Fix selected" will do with it — a
  // deterministic `ercfix` op-list, a Fixer round (a model call), or nothing — and sums the ticked
  // ones. Rows used to be pre-ticked and then dropped by `system.fix_not_fixable` after the click.
  it("review card: every row carries what its repair costs, and the ticks are summed above the button", async () => {
    const card = reviewCard([
      { id: "0", code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "VBUS has no driver", origin: "engine", selected: true },
      { id: "1", code: "DECAP_FAR", severity: "Warning", message: "C3 is 700 mil from U1.4", origin: "engine", selected: true },
      { id: "2", code: "PART_UNVERIFIED", severity: "Warning", message: "converted claim", origin: "engine" },
    ]);
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => {}} />);
    const row = (code: string) => [...host.querySelectorAll<HTMLElement>(".review-item")].find((el) => el.textContent?.includes(code))!;
    expect(row("ERC_POWER_IN_UNDRIVEN").textContent).toContain(t("side.fixKind.mechanical"));
    // The stylist and the Fixer both know DECAP_FAR; `/fix` reaches it through a Fixer round.
    expect(row("DECAP_FAR").textContent).toContain(t("side.fixKind.model"));
    // A converted part's claim needs a datasheet, so it is neither ticked nor promised a repair.
    expect(row("PART_UNVERIFIED").textContent).toContain(t("side.fixKind.none"));
    expect(host.textContent).toContain(t("side.fixPlan", { mechanical: 1, model: 1, none: 0 }));
    // Ticking the row with no repair says so in the same line, rather than after the click.
    const boxes = [...host.querySelectorAll<HTMLInputElement>(".review-row input[type=checkbox]")];
    await act(async () => { boxes[2].click(); });
    expect(host.textContent).toContain(t("side.fixPlan", { mechanical: 1, model: 1, none: 1 }));
  });

  it("plan card: open questions get an answer field each, and adopting carries the answers", async () => {
    const answers: unknown[] = [];
    const card = planCard(3, { id: "p1", version: 1, goal: "g", constraints: [], open_questions: ["which USB-C receptacle?", "5 V on the header?"], envelope: { budgets: { components_added: 8 } }, sheets: [{ file: "root.kicad_sch" }] }, { steps: 1 }, undefined, "**g**");
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (...a) => { answers.push(a); }} />);
    expect(host.textContent).toContain(t("plan.openQuestions"));
    expect(host.textContent).toContain("which USB-C receptacle?");
    const fields = [...host.querySelectorAll<HTMLInputElement>(".plan-question input")];
    expect(fields.length).toBe(2);
    // Nothing typed yet: a plain-text note, not a blocker (adopt stays enabled).
    expect(host.textContent).toContain(t("plan.openQuestions.unanswered", { n: 2 }));
    await act(async () => { setValue(fields[1], "yes, pin 2"); });
    expect(host.textContent).toContain(t("plan.openQuestions.unanswered", { n: 1 }));
    await settle();
    const adopt = byText(host, t("card.run_plan_review"));
    expect(adopt.disabled).toBe(false);
    await act(async () => { adopt.click(); });
    expect(answers[0]).toEqual([card.id, "adopt", '{"open_question_answers":{"1":"yes, pin 2"}}', undefined]);
  });

  it("plan card: an answered card shows what was answered and what was left to the agent", () => {
    const card = planCard(3, { id: "p1", version: 1, goal: "g", constraints: [], open_questions: ["which USB-C receptacle?", "5 V on the header?"], envelope: { budgets: {} }, sheets: [] }, { steps: 1 }, undefined, "**g**");
    card.answered = { action_id: "adopt", at: "2026-09-06T00:00:00Z", free_text: '{"open_question_answers":{"0":"USB4085"}}' };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => {}} />);
    // Answered cards start collapsed: open it to read the record.
    act(() => { host.querySelector<HTMLButtonElement>(".card button")!.click(); });
    expect(host.textContent).toContain("USB4085");
    expect(host.textContent).toContain(t("plan.openQuestions.left"));
    expect(host.querySelectorAll(".plan-question input").length).toBe(0);
  });

  it("surfaces a failed answer instead of swallowing it and re-enables the button", async () => {
    const card: Card = { id: "h9", kind: "hard_stop", turn: 1, title: "hard_stop.budget", body_md: "", actions: [{ id: "approve", label_key: "card.approve", style: "primary" }, { id: "abandon", label_key: "card.abandon_turn", style: "destructive" }], data: { condition: "budget", system: {} } };
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async () => { throw new Error("CONSENT_REQUIRED"); }} />);
    const btn = host.querySelector<HTMLButtonElement>(".card-actions button")!;
    await act(async () => { btn.click(); });
    const { useToasts } = await import("../../state/toasts");
    expect(useToasts.getState().toasts.some((x) => x.tone === "error")).toBe(true);
    expect(btn.disabled).toBe(false);
  });

  it("the provider hard stop offers retry / wait / switch / abandon, and switching opens the Models settings", async () => {
    const card = providerStopCard(4, { step: "s2", reason: "provider unavailable: PROVIDER_RATE_LIMIT" });
    expect(card.actions.map((a) => a.id)).toEqual(["retry_now", "wait", "switch_provider", "abandon"]);
    const answered: string[] = [];
    const host = mount(<CardView projectKey="p" card={card} onAnswer={async (_id, action) => { answered.push(action); }} />);
    // No approval is offered: nothing here is a permission the human can grant.
    expect(host.textContent).not.toContain(t("hardstop.approveHint"));
    expect(host.textContent).toContain(t("hardstop.provider_exhausted.intro"));
    let opened: string | null = null;
    const listen = (e: Event) => { opened = String((e as CustomEvent).detail); };
    document.addEventListener("fs:open-settings", listen);
    await act(async () => { byText(host, t("card.switch_provider")).click(); });
    document.removeEventListener("fs:open-settings", listen);
    expect(opened).toBe("models");
    expect(answered).toEqual(["switch_provider"]);
  });
});
