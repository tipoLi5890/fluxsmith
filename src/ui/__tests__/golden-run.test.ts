// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSETS, aggregate, changedProblems, copyFixture, editContractProblems, ercCounts, lineDiff, parseArgs, projectKey, quantile, runScore, splitTaskMessages, summaryMarkdown, turnChanges, untouchedLinesProblems } from "../../../scripts/golden-run.mjs";

describe("golden-run helpers", () => {
  it("parses argv forms", () => {
    expect(parseArgs(["--tasks", "a,b", "--n=2", "--clean"], { n: "1" })).toEqual({ tasks: "a,b", n: "2", clean: true });
  });
  it("splits task.md into one message per --- block and drops headings", () => {
    expect(splitTaskMessages("# t\n\nAdd an LED.\nTo GND.\n\n---\n\nChange R1 to 2k2.\n")).toEqual(["Add an LED. To GND.", "Change R1 to 2k2."]);
    expect(splitTaskMessages("# t\n\nOnly one.\n")).toEqual(["Only one."]);
  });
  it("copies a fixture project and reads the root uuid like fluxsmith-cli new", () => {
    const fx = mkdtempSync(join(tmpdir(), "fx-"));
    const dir = mkdtempSync(join(tmpdir(), "run-"));
    writeFileSync(join(fx, "b.kicad_pro"), "{}");
    writeFileSync(join(fx, "b.kicad_sch"), '(kicad_sch (version 20250114) (uuid "0b7c4d5e-1111-4222-8333-944455556666"))');
    const created = copyFixture(fx, dir);
    // The root uuid is rewritten to a fresh one so repeated runs do not collide in the app's project identity.
    expect(created?.root_uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(created?.root_uuid).not.toBe("0b7c4d5e-1111-4222-8333-944455556666");
    expect(created?.project).toBe(join(dir, "b.kicad_pro"));
    expect(created?.root).toBe(join(dir, "b.kicad_sch"));
    const sch = readFileSync(join(dir, "b.kicad_sch"), "utf8");
    expect(sch).toContain(`(uuid "${created?.root_uuid}")`);
    expect(sch).not.toContain("0b7c4d5e-1111-4222-8333-944455556666");
    expect(copyFixture(mkdtempSync(join(tmpdir(), "empty-")), dir)).toBeNull();
  });
  // The edit contract (P2-13): what the engine reported under `applies[].changed`, and that nothing else
  // in the file moved.
  it("asserts expected.changed against the engine's report, with * for a model-picked designator", () => {
    const reported = [{ reference: "R1", field: "Value", before: "1k", after: "2k2", turn: 2 }];
    expect(changedProblems([{ ref: "R1", field: "Value", before: "1k", after: "2k2" }], reported)).toEqual([]);
    expect(changedProblems([{ ref: "R*", field: "Value", after: "2k2" }], reported)).toEqual([]);
    expect(changedProblems([{ ref: "C1", field: "Value", after: "100n" }], reported)).toEqual(["changed C1 Value * -> 100n: not reported by the engine"]);
    expect(changedProblems([{ ref: "R1", field: "Value", before: "4k7", after: "2k2" }], reported)).toHaveLength(1);
    expect(changedProblems(undefined, reported)).toEqual([]);
  });
  it("diffs lines by longest common subsequence", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual({ removed: ["b"], added: ["x", "d"] });
    expect(lineDiff(["a"], ["a"])).toEqual({ removed: [], added: [] });
  });
  it("accepts only the lines the expected changes explain, after undoing the root-uuid rewrite", () => {
    const fixture = '(kicad_sch (uuid "old-uuid")\n  (symbol (property "Reference" "R1")\n    (property "Value" "1k")\n  )\n  (path "/old-uuid")\n)';
    const edited = '(kicad_sch (uuid "new-uuid")\n  (symbol (property "Reference" "R1")\n    (property "Value" "2k2")\n  )\n  (path "/new-uuid")\n)';
    const change = [{ ref: "R1", field: "Value", before: "1k", after: "2k2" }];
    expect(untouchedLinesProblems(fixture, edited, change, { output_uuid: "new-uuid", fixture_uuid: "old-uuid" })).toEqual([]);
    // Without the uuid pair the rewritten uuid lines count as changes.
    expect(untouchedLinesProblems(fixture, edited, change).length).toBeGreaterThan(0);
    const titled = edited.replace("\n)", '\n  (title_block (title "led_board"))\n)');
    const problems = untouchedLinesProblems(fixture, titled, change, { output_uuid: "new-uuid", fixture_uuid: "old-uuid" });
    expect(problems).toEqual(['untouched_lines: line added or rewritten: (title_block (title "led_board"))']);
    // A different value than expected is not explained either.
    expect(untouchedLinesProblems(fixture, edited.replace("2k2", "4k7"), change, { output_uuid: "new-uuid", fixture_uuid: "old-uuid" })).toHaveLength(1);
  });
  it("reads the turn records of a project run", () => {
    const dir = mkdtempSync(join(tmpdir(), "proj-"));
    mkdirSync(join(dir, ".fluxsmith", "turns", "2"), { recursive: true });
    mkdirSync(join(dir, ".fluxsmith", "turns", "10"), { recursive: true });
    writeFileSync(join(dir, ".fluxsmith", "turns", "10", "turn.json"), JSON.stringify({ applies: [{ changed: [{ reference: "C1", field: "Value", before: "", after: "100n" }] }] }));
    writeFileSync(join(dir, ".fluxsmith", "turns", "2", "turn.json"), JSON.stringify({ applies: [{ changed: [{ reference: "R1", field: "Value", before: "1k", after: "2k2" }] }, { changed: [] }] }));
    expect(turnChanges(dir).map((c) => `${c.turn}:${c.reference}`)).toEqual(["2:R1", "10:C1"]);
    expect(turnChanges(mkdtempSync(join(tmpdir(), "empty-")))).toEqual([]);
    expect(editContractProblems({ changed: [{ ref: "R1", field: "Value", after: "2k2" }] }, dir, null)).toEqual([]);
    expect(editContractProblems({ changed: [{ ref: "U1", field: "Value", after: "x" }] }, dir, null)).toHaveLength(1);
  });
  it("derives the project key like Rust", () => {
    expect(projectKey("u", "/p")).toHaveLength(32);
    expect(projectKey("u", "/p")).toBe(projectKey("u", "/p"));
    expect(projectKey("u", "/p")).not.toBe(projectKey("v", "/p"));
  });
  it("counts ERC by severity", () => {
    const c = ercCounts({ sheets: [{ violations: [{ severity: "error", type: "pin_not_connected" }, { severity: "warning", type: "x" }, { severity: "error", type: "x", excluded: true }] }] });
    expect(c).toEqual({ errors: 1, warnings: 1, allowed: 0, by_type: { pin_not_connected: 1, x: 1 } });
  });
  it("scores from score or ok", () => {
    expect(runScore({ ok: true })).toBe(1);
    expect(runScore({ ok: false, score: 0.6 })).toBe(0.6);
    expect(runScore(null)).toBe(0);
  });
  it("aggregates runs and weights tasks", () => {
    const r = aggregate([
      { task: "a", ok: true, score: 1, tokens: 10, cost_usd: 0.1, decision_cards: 1, skipped_steps: 0, erc_errors: 0, erc_warnings: 2, problems: [] },
      { task: "a", ok: false, score: 0.5, tokens: 10, cost_usd: 0.1, decision_cards: 0, skipped_steps: 1, erc_errors: 1, erc_warnings: 0, problems: ["net X: missing"] },
      { task: "b", ok: false, score: 0, tokens: 5, cost_usd: 0.05, problems: ["unexpected component"] },
    ], { a: 1, b: 1.5 });
    expect(r.per_task.a.runs).toBe(2);
    expect(r.per_task.a.score).toBe(0.75);
    expect(r.per_task.a.ok).toBe(1);
    expect(r.per_task.a.erc_errors).toBe(1);
    expect(r.weighted).toBeCloseTo((0.75 * 1 + 0 * 1.5) / 2.5, 6);
    expect(summaryMarkdown({ recorded_at: "t", model_id: "m", weighted: r.weighted, cost_usd: 0.25, per_task: r.per_task })).toContain("| a | 1/2 | 0.75 |");
  });
  it("quantiles by nearest rank", () => {
    expect(quantile([], 0.5)).toBe(0);
    expect(quantile([3, 1, 2], 0.5)).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(quantile([5], 0.9)).toBe(5);
  });
  it("reports N=3 pass/N, card median/p90, hard stops and 0/N tasks", () => {
    const r = aggregate([
      { task: "a", ok: true, score: 1, decision_cards: 1, hard_stops: 0 },
      { task: "a", ok: true, score: 1, decision_cards: 4, hard_stops: 1 },
      { task: "a", ok: false, score: 0.5, decision_cards: 2, hard_stops: 0, timed_out: true },
      { task: "b", ok: false, score: 0, decision_cards: 0 },
      { task: "b", ok: false, score: 0, decision_cards: 0 },
      { task: "b", ok: false, score: 0.2, decision_cards: 6, hard_stops: 3 },
    ], { b: 1.5 });
    expect(r.per_task.a.pass).toBe(2);
    expect(r.per_task.a.pass_rate).toBeCloseTo(2 / 3, 6);
    expect(r.per_task.a.decision_cards_median).toBe(2);
    expect(r.per_task.a.decision_cards_p90).toBe(4);
    expect(r.per_task.a.hard_stops).toBe(1);
    expect(r.per_task.a.timeouts).toBe(1);
    expect(r.per_task.a.zero).toBe(false);
    expect(r.per_task.b.zero).toBe(true);
    expect(r.per_task.b.weight).toBe(1.5);
    expect(r.zero_tasks).toEqual(["b"]);
    expect(r.hard_stops).toBe(4);
    expect(r.weighted_pass_rate).toBeCloseTo((2 / 3) / 2.5, 6);
    expect(r.decision_cards_median).toBe(1);
    expect(r.decision_cards_p90).toBe(6);
    const md = summaryMarkdown({ recorded_at: "t", model_id: "m", weighted: r.weighted, cost_usd: 0, per_task: r.per_task, weighted_pass_rate: r.weighted_pass_rate, decision_cards_median: r.decision_cards_median, decision_cards_p90: r.decision_cards_p90, hard_stops: r.hard_stops, zero_tasks: r.zero_tasks, timed_out: [{ task: "a", run: 2, project: "/p/a-2" }] });
    expect(md).toContain("| a | 2/3 | 0.83 |");
    expect(md).toContain("hard stops 4");
    expect(md).toContain("0/N tasks: b");
    expect(md).toContain("/p/a-2/.fluxsmith/turns");
  });
  it("knows the nightly subset", () => {
    expect(SUBSETS.nightly).toEqual(["rc_lowpass", "decoupling_3v3", "ldo_3v3"]);
  });
});

describe("golden-run erc_allowed_types", () => {
  it("counts allowed violation types apart from errors and warnings", () => {
    const report = { sheets: [{ violations: [
      { severity: "error", type: "power_pin_not_driven" },
      { severity: "error", type: "pin_not_connected" },
      { severity: "warning", type: "isolated_pin_label" },
      { severity: "error", type: "pin_to_pin", excluded: true },
    ] }] };
    const c = ercCounts(report, ["power_pin_not_driven"]);
    expect(c).toMatchObject({ errors: 1, warnings: 1, allowed: 1 });
    expect(c.by_type).toEqual({ power_pin_not_driven: 1, pin_not_connected: 1, isolated_pin_label: 1 });
    expect(ercCounts(report).errors).toBe(2);
  });
});
