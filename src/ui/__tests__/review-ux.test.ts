// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { mergeFindings } from "../harness-bridge";
import { countsBySheet, DEFAULT_FINDING_FILTER, filterFindings, normalizeFindingFilter } from "../finding-filter";
import type { FindingRow } from "../../agent/api";
import { blockOfHit } from "../../canvas/blockof";
import { applyPlanPatch, normalizePlan } from "../../agent/plans/schema";
import { coerceEnvelope } from "../../agent/policy/hooks";
import { expiryDate, normalizeExpiry, parseWaivePayload, reasonOk, waiveBatch, waiveConsentSha, waivePayload, waivedIds, waiveReasonOrDefault, waiverRefs, withWaivedIds, WAIVE_REASON_DEFAULT, WAIVER_DEFAULT_DAYS, WAIVER_REASON_MIN } from "../../agent/review-waiver";
import { canonicalJson, sha256Hex } from "../../agent/util";
import type { IpcError } from "../../ipc/types";

describe("findings accumulate across turns", () => {
  it("merges by (code, location) and resolves what a full gate run no longer reports", () => {
    const a = mergeFindings([], [{ code: "ERC_POWER_IN_UNDRIVEN", severity: "Warning", message: "x", location: "erc:pwr:VBUS" }, { code: "LABEL_OVERLAP", severity: "Warning", message: "y", location: "labels:1:2" }], 3, true);
    expect(a.length).toBe(2);
    const b = mergeFindings(a, [{ code: "LABEL_OVERLAP", severity: "Warning", message: "y2", location: "labels:1:2" }], 4, true);
    expect(b.find((f) => f.code === "ERC_POWER_IN_UNDRIVEN")?.resolved).toBe(true);
    expect(b.find((f) => f.code === "LABEL_OVERLAP")?.message).toBe("y2");
    const c = mergeFindings(b, [{ code: "OFF_GRID", severity: "Warning", message: "z", location: "style:grid:9" }], 5, false);
    expect(c.length).toBe(3);
    expect(c.find((f) => f.code === "LABEL_OVERLAP")?.resolved).toBe(false); // partial batch resolves nothing
  });

  it("takes the waiver expiry from the engine, and falls back to the session-recorded one", () => {
    // A waived finding still arrives from a full gate run; the engine's expiry is what the row shows.
    const a = mergeFindings([], [{ code: "OFF_GRID", severity: "Warning", message: "x", location: "style:grid:9", waived: true, waived_until: "2099-01-01T00:00:00Z", waived_reason: "panel silk, on purpose" }], 3, true);
    expect(a[0].waived_until).toBe("2099-01-01T00:00:00Z");
    expect(a[0].waived_reason).toBe("panel silk, on purpose");
    expect(a[0].resolved).toBe(true); // waived rows are listed and greyed, never counted

    // The engine wins over what the session recorded when it says something.
    const session = [{ ...a[0], waived_until: "2027-01-01T00:00:00Z", waived_reason: "session" }];
    const b = mergeFindings(session, [{ code: "OFF_GRID", severity: "Warning", message: "x", location: "style:grid:9", waived: true, waived_until: "2099-01-01T00:00:00Z" }], 4, true);
    expect(b[0].waived_until).toBe("2099-01-01T00:00:00Z");

    // A batch that knows nothing about waivers (sch.plan, an apply report) keeps the recorded expiry.
    const c = mergeFindings(a, [{ code: "OFF_GRID", severity: "Warning", message: "x2", location: "style:grid:9" }], 5, false);
    expect(c[0].waived_until).toBe("2099-01-01T00:00:00Z");
    expect(c[0].message).toBe("x2");
    expect(c[0].resolved).toBe(true);

    // A full gate run that reports it without a waiver means the waiver is gone: the row reopens.
    const d = mergeFindings(a, [{ code: "OFF_GRID", severity: "Warning", message: "x", location: "style:grid:9" }], 6, true);
    expect(d[0].waived_until).toBeUndefined();
    expect(d[0].waived_reason).toBeUndefined();
    expect(d[0].resolved).toBe(false);
  });

  // A Build turn that fixed everything reports a clean gate, and a clean gate is an empty full batch
  // (`postTurnGate`). Without it the rows of the previous run stayed listed as open on the panel and
  // as canvas markers, over a schematic the engine now calls clean.
  it("resolves every row when a full batch is empty", () => {
    const a = mergeFindings([], [{ code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "x", location: "erc:pwr:VBUS" }, { code: "KICAD_ENDPOINT_OFF_GRID", severity: "Warning", message: "y", location: "kicad:endpoint_off_grid:bbb" }], 3, true);
    expect(a.filter((f) => f.resolved).length).toBe(0);
    const b = mergeFindings(a, [], 4, true);
    expect(b.length).toBe(2); // the rows stay listed, greyed
    expect(b.every((f) => f.resolved)).toBe(true);
  });

  it("carries the engine's sheet file onto the row", () => {
    const a = mergeFindings([], [{ code: "DANGLING_BUS", severity: "Error", message: "x", location: "wire:1", sheet: "/child/", file: "hier_child.kicad_sch" }], 1, true);
    expect(a[0].file).toBe("hier_child.kicad_sch");
  });

  // P1-8: `evidence` is what the check measured (`sch-write/src/gates.rs`); it used to stop at the
  // IPC boundary, so the row could say a net was undriven and never say which pins it counted.
  it("carries the engine's evidence onto the row, and keeps it when a later batch omits it", () => {
    const a = mergeFindings([], [{ code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "x", location: "erc:pwr:VBUS", evidence: { net: "VBUS", pins: 3 } }], 1, true);
    expect(a[0].evidence).toEqual({ net: "VBUS", pins: 3 });
    const b = mergeFindings(a, [{ code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "x2", location: "erc:pwr:VBUS" }], 2, false);
    expect(b[0].evidence).toEqual({ net: "VBUS", pins: 3 });
    // Anything that is not a key/value map is dropped rather than rendered.
    const c = mergeFindings([], [{ code: "OFF_GRID", severity: "Warning", message: "x", location: "g:1", evidence: ["not", "a", "map"] }], 1, true);
    expect(c[0].evidence).toBeUndefined();
  });
});

// P1-6 / P1-7: the findings filter is shared with the canvas, and severity is three toggles with
// Error + Warning on, as eeschema's ERC dialog opens.
describe("findings filter", () => {
  const rows = [
    { code: "ERC_A", severity: "Error", message: "e", origin: "engine", turn: 1, resolved: false, sheet: "/" },
    { code: "ERC_B", severity: "Warning", message: "w", origin: "engine", turn: 1, resolved: false, sheet: "/power/" },
    { code: "PAGE_UNDERUSED", severity: "Info", message: "i", origin: "engine", turn: 1, resolved: false, sheet: "/" },
    { code: "STYLE_HINT", severity: "Warning", message: "m", origin: "advisory", turn: 1, resolved: false, sheet: "/" },
  ] as FindingRow[];

  it("shows Error and Warning by default and leaves Info out of the markers", () => {
    expect(filterFindings(rows, DEFAULT_FINDING_FILTER).map((f) => f.code)).toEqual(["ERC_A", "ERC_B", "STYLE_HINT"]);
    const withInfo = filterFindings(rows, { ...DEFAULT_FINDING_FILTER, severities: { error: true, warning: true, info: true } });
    expect(withInfo.map((f) => f.code)).toContain("PAGE_UNDERUSED");
    const errorsOnly = filterFindings(rows, { ...DEFAULT_FINDING_FILTER, severities: { error: true, warning: false, info: false } });
    expect(errorsOnly.map((f) => f.code)).toEqual(["ERC_A"]);
  });

  it("narrows by origin bucket and by sheet, and counts what each sheet would list", () => {
    expect(filterFindings(rows, { ...DEFAULT_FINDING_FILTER, origin: "model" }).map((f) => f.code)).toEqual(["STYLE_HINT"]);
    expect(filterFindings(rows, { ...DEFAULT_FINDING_FILTER, sheet: "/power/" }).map((f) => f.code)).toEqual(["ERC_B"]);
    // The count is per sheet under the other filters, so an option never promises a hidden row.
    expect([...countsBySheet(rows, DEFAULT_FINDING_FILTER)]).toEqual([["/", 2], ["/power/", 1]]);
  });

  it("reads a stored filter defensively", () => {
    expect(normalizeFindingFilter(null)).toEqual(DEFAULT_FINDING_FILTER);
    expect(normalizeFindingFilter({ severities: { info: true }, origin: "kicad" })).toEqual({ severities: { error: true, warning: true, info: true }, origin: "kicad", sheet: "all" });
    expect(normalizeFindingFilter({ severities: { error: "yes" } }).severities.error).toBe(true);
  });
});

describe("waive consent payload", () => {
  const rows = [
    { code: "OFF_GRID", severity: "Warning", message: "x", location: "style:grid:9" },
    { code: "ERC_SINGLE_PIN_NET", severity: "Warning", message: "y", refs: ["R9.1", "R8.2"] },
  ];
  it("hashes the ticked rows, the reason and the expiry, in a canonical order", () => {
    const a = waiveBatch(rows, "panel silk, on purpose", "2026-12-01");
    // Refs sorted inside each row, rows sorted by code: the order the human clicked in is not a decision.
    expect(a).toEqual({
      findings: [{ code: "ERC_SINGLE_PIN_NET", refs: ["R8.2", "R9.1"] }, { code: "OFF_GRID", refs: ["style:grid:9"] }],
      reason: "panel silk, on purpose",
      expires: "2026-12-01T00:00:00Z",
    });
    expect(waiveConsentSha(a)).toBe(waiveConsentSha(waiveBatch([rows[1], rows[0]], "panel silk, on purpose", "2026-12-01")));
    // The canonical JSON is what Rust re-hashes (`commands.rs check_waiver_grant`).
    expect(canonicalJson(a)).toBe('{"expires":"2026-12-01T00:00:00Z","findings":[{"code":"ERC_SINGLE_PIN_NET","refs":["R8.2","R9.1"]},{"code":"OFF_GRID","refs":["style:grid:9"]}],"reason":"panel silk, on purpose"}');
    expect(waiveConsentSha(a)).toBe(sha256Hex(canonicalJson(a)));
  });
  it("changes when the selection, the reason or the expiry changes", () => {
    const base = waiveConsentSha(waiveBatch(rows, "panel silk, on purpose", "2026-12-01"));
    expect(waiveConsentSha(waiveBatch([rows[0]], "panel silk, on purpose", "2026-12-01"))).not.toBe(base);
    expect(waiveConsentSha(waiveBatch(rows, "something else entirely", "2026-12-01"))).not.toBe(base);
    expect(waiveConsentSha(waiveBatch(rows, "panel silk, on purpose", "2027-01-01"))).not.toBe(base);
  });
  it("records the default reason and no expiry the same way from either entry point", () => {
    // The findings panel waives one row; the card waives the same row in a selection of one.
    const panel = waiveBatch([rows[0]], "", null);
    const card = waiveBatch([rows[0]], "  ", undefined);
    expect(panel.reason).toBe(WAIVE_REASON_DEFAULT);
    expect(panel.expires).toBeNull();
    expect(waiveConsentSha(panel)).toBe(waiveConsentSha(card));
  });
});

describe("review card waiver payload", () => {
  it("stays the plain id array while no reason and no expiry were collected", () => {
    expect(waivePayload(["0", "2"])).toBe('["0","2"]');
    expect(waivePayload(["0"], "   ", null)).toBe('["0"]');
    expect(parseWaivePayload('["0","2"]')).toEqual({ ids: ["0", "2"], reason: "", expires: null });
  });
  it("carries the reason and the expiry, and reads the object shape back", () => {
    const p = waivePayload(["1"], "  external supply on J1  ", "2026-12-05");
    expect(JSON.parse(p)).toEqual({ ids: ["1"], reason: "external supply on J1", expires: "2026-12-05" });
    expect(parseWaivePayload(p)).toEqual({ ids: ["1"], reason: "external supply on J1", expires: "2026-12-05" });
    // A reason without an expiry (a warning) still travels; the engine then applies its own default.
    expect(parseWaivePayload(waivePayload(["1"], "known good pad"))).toEqual({ ids: ["1"], reason: "known good pad", expires: null });
  });
  it("refuses payloads that are not a selection", () => {
    expect(parseWaivePayload(undefined)).toBeNull();
    expect(parseWaivePayload("not json")).toBeNull();
    expect(parseWaivePayload('{"reason":"x"}')).toBeNull();
  });
  it("requires the 12-character reason only when the selection holds an Error", () => {
    expect(reasonOk("", false)).toBe(true);
    expect(reasonOk("short", false)).toBe(true);
    expect(reasonOk("short", true)).toBe(false);
    expect(reasonOk("x".repeat(WAIVER_REASON_MIN - 1), true)).toBe(false);
    expect(reasonOk(`  ${"x".repeat(WAIVER_REASON_MIN)}  `, true)).toBe(true);
  });
  it("offers 90 days by default and sends a picked day as the instant the record stores", () => {
    const from = new Date("2026-09-06T10:00:00Z");
    expect(expiryDate(WAIVER_DEFAULT_DAYS, from)).toBe("2026-12-05");
    expect(expiryDate(30, from)).toBe("2026-10-06");
    expect(normalizeExpiry("2026-12-05")).toBe("2026-12-05T00:00:00Z");
    expect(normalizeExpiry("")).toBeNull();
    expect(normalizeExpiry(null)).toBeNull();
    expect(normalizeExpiry("2026-12-05T08:00:00Z")).toBe("2026-12-05T08:00:00Z");
  });
  it("names what the waiver hides: the refs, else the location (never a blanket code)", () => {
    expect(waiverRefs({ refs: ["J1", "U2"], location: "erc:pwr:VBUS" })).toEqual(["J1", "U2"]);
    expect(waiverRefs({ refs: [], location: "erc:pwr:VBUS" })).toEqual(["erc:pwr:VBUS"]);
    expect(waiverRefs({})).toEqual([]);
  });
  it("records the same default reason from both places a human can waive", () => {
    expect(waiveReasonOrDefault("  ")).toBe(WAIVE_REASON_DEFAULT);
    expect(waiveReasonOrDefault(undefined)).toBe(WAIVE_REASON_DEFAULT);
    expect(waiveReasonOrDefault("  panel silk  ")).toBe("panel silk");
  });
  it("carries the ids a partially failed waive already recorded, so a retry cannot repeat them", () => {
    const refused: IpcError = { code: "WAIVER_SCOPE", message: "m", req_id: "r", evidence: { keep: 1 } };
    const e = withWaivedIds(refused, ["0", "2"]);
    expect((e.evidence as { keep: number }).keep).toBe(1);
    expect(waivedIds(e)).toEqual(["0", "2"]);
    // Read through the IpcFailure wrapper the card catches, too.
    expect(waivedIds({ error: e })).toEqual(["0", "2"]);
    // Nothing recorded: the refusal travels unchanged and names nothing.
    const bare: IpcError = { code: "WAIVER_SCOPE", message: "m", req_id: "r" };
    const none = withWaivedIds(bare, []);
    expect(none.evidence).toBeUndefined();
    expect(waivedIds(none)).toEqual([]);
    expect(waivedIds(new Error("boom"))).toEqual([]);
    expect(waivedIds(null)).toEqual([]);
  });
});

describe("canvas block lookup", () => {
  const blocks = [{ id: "power", sheet: "a.kicad_sch", step_id: "draft_power", region_mil: [[1000, 1000], [3000, 3000]] as [[number, number], [number, number]], summary: "p" }];
  it("finds the block whose region contains the symbol centre", () => {
    const hit = { kind: "symbol", reference: "U1", uuid: "u", value: "", lib_id: "", bbox: [[1500, 1500], [1700, 1900]] } as const;
    expect(blockOfHit(hit as never, blocks, "a.kicad_sch")?.id).toBe("power");
    expect(blockOfHit(hit as never, blocks, "b.kicad_sch")).toBeNull();
    expect(blockOfHit({ kind: "wire", uuid: "w", is_bus: false, a: [0, 0], b: [1, 1] } as never, blocks, null)).toBeNull();
  });
});

describe("plan edits", () => {
  it("patches goal, constraints and step summaries without touching the rest", () => {
    const p = normalizePlan({ sheets: ["s"], goal: "old", constraints: ["a"], blocks: [{ id: "b", sheet: "s", parts: ["r"] }], steps: [{ id: "s1", block: "b", kind: "draft", summary: "one" }] });
    const q = applyPlanPatch(p, { goal: "new", constraints: ["a", "b"], steps: [{ id: "s1", summary: "uno" }, { id: "nope", summary: "x" }] });
    expect(q.goal).toBe("new"); expect(q.constraints).toEqual(["a", "b"]); expect(q.steps[0].summary).toBe("uno"); expect(p.goal).toBe("old");
  });
});

describe("envelope coercion", () => {
  it("turns scalar junk in array fields into empty lists", () => {
    const e = coerceEnvelope({ sheets: "root.kicad_sch", structural: false, allowed_ops: "none", nets_renamable: 3, rails: null, interfaces: "" })!;
    expect(e.sheets).toEqual(["root.kicad_sch"]);
    expect(e.structural).toEqual([]); expect(e.allowed_ops).toEqual([]); expect(e.nets_renamable).toEqual([]); expect(e.rails).toEqual([]); expect(e.interfaces).toEqual([]);
  });
});
