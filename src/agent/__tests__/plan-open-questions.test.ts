// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { applyOpenQuestionAnswers, normalizePlan, openQuestionPayload, parseOpenQuestionAnswers, planMarkdown, planView, OPEN_QUESTION_JOIN } from "../plans/schema";
import { catalogues, format, UI_LANGS } from "../../i18n";

const base = {
  id: "p1", version: 1, goal: "USB-C powered sensor board",
  constraints: ["single 4-layer board"],
  assumptions: ["3.3 V logic", "no battery"],
  open_questions: ["which USB-C receptacle?", "5 V rail needed on the header?"],
  sheets: [{ file: "root.kicad_sch" }],
  net_naming: { rails: ["GND", "+3V3"] },
  blocks: [{ id: "b1", sheet: "root.kicad_sch", summary: "power", parts: [{ ref_prefix: "U", lib_id: "Regulator_Linear:AMS1117-3.3", resolved: true }], nets_in: ["+3V3"], nets_out: ["GND"], acceptance: [] }],
  steps: [{ id: "s1", kind: "draft", block: "b1" }],
  envelope: { budgets: { components_added: 8, components_deleted: 0 }, allowed_ops: [] },
};
const progress = { done: new Set<string>(), skipped: new Set<string>(), current: null };

describe("plan open questions and assumptions", () => {
  it("normalises both lists and carries them onto the PlanView the panel renders", () => {
    const p = normalizePlan(base);
    const v = planView(p, progress);
    expect(v.assumptions).toEqual(["3.3 V logic", "no battery"]);
    expect(v.open_questions).toEqual(["which USB-C receptacle?", "5 V rail needed on the header?"]);
    expect(v.constraints).toEqual(["single 4-layer board"]);
  });

  it("keeps the open questions out of the markdown body (the card renders them as fields)", () => {
    const md = planMarkdown(normalizePlan(base), progress);
    expect(md).toContain("3.3 V logic");
    expect(md).not.toContain("which USB-C receptacle?");
  });
});

describe("plan card answer payload", () => {
  it("sends the answers keyed by question index, and nothing when none were typed", () => {
    expect(openQuestionPayload({})).toBe("");
    expect(openQuestionPayload({ "0": "   " })).toBe("");
    expect(openQuestionPayload({ "0": "  USB4085  ", "1": "" })).toBe('{"open_question_answers":{"0":"USB4085"}}');
    expect(parseOpenQuestionAnswers('{"open_question_answers":{"0":"USB4085"}}')).toEqual({ "0": "USB4085" });
  });

  it("reads back only its own shape (a waiver payload or prose is not an answer)", () => {
    expect(parseOpenQuestionAnswers(undefined)).toBeNull();
    expect(parseOpenQuestionAnswers("not json")).toBeNull();
    expect(parseOpenQuestionAnswers('["0","1"]')).toBeNull();
    expect(parseOpenQuestionAnswers('{"ids":["0"],"reason":"x"}')).toBeNull();
    expect(parseOpenQuestionAnswers('{"open_question_answers":{}}')).toBeNull();
  });
});

describe("adopting with answers", () => {
  it("appends each answered question to the constraints and closes it", () => {
    const p = normalizePlan(base);
    const next = applyOpenQuestionAnswers(p, { "1": "yes, 5 V on pin 2" });
    expect(next.open_questions).toEqual(["which USB-C receptacle?"]);
    expect(next.constraints).toEqual(["single 4-layer board", `5 V rail needed on the header?${OPEN_QUESTION_JOIN}yes, 5 V on pin 2`]);
    // The plan the card carries is never mutated: the approval sha is taken from the answered copy.
    expect(p.open_questions).toHaveLength(2);
    expect(p.constraints).toEqual(["single 4-layer board"]);
  });

  it("leaves the plan untouched when every answer is blank, and says so in all four languages", () => {
    const p = normalizePlan(base);
    expect(applyOpenQuestionAnswers(p, { "0": "  " })).toBe(p);
    for (const l of UI_LANGS) {
      const cat = catalogues[l] as Record<string, string>;
      expect(format(cat["system.plan_open_questions"], { n: 2 })).toContain("2");
      expect(format(cat["plan.openQuestions.unanswered"], { n: 2 })).toContain("2");
      expect(cat["plan.assumptions"]).toBeTruthy();
      expect(cat["plan.openQuestions"]).toBeTruthy();
    }
  });
});
