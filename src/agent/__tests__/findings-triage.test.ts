// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { bucketCounts, defaultFixSelection, findingBucket, findingLabels, fixCost, fixCostCounts, fixKind, isDefaultFixSelected, triageFixSelection, type FindingLike } from "../findings";
import { FINDING_CODES } from "../finding-codes";
import { catalogues, format, UI_LANGS } from "../../i18n";

const f = (o: Partial<FindingLike> & { code: string }): FindingLike => ({ severity: "Error", ...o });

describe("finding buckets", () => {
  it("separates the engine gate, kicad-cli's own ERC and the model's advisories", () => {
    expect(findingBucket(f({ code: "ERC_POWER_IN_UNDRIVEN" }))).toBe("engine");
    // The gate's own rows do not always carry an origin; absent means engine, as the UI row does.
    expect(findingBucket(f({ code: "DANGLING_WIRE", origin: undefined }))).toBe("engine");
    expect(findingBucket(f({ code: "KICAD_POWER_PIN_NOT_DRIVEN", origin: "advisory" }))).toBe("kicad");
    expect(findingBucket(f({ code: "REVIEW_DECOUPLING_FAR", origin: "advisory" }))).toBe("model");
  });

  it("counts each bucket apart so a header can never read zero errors over red rows", () => {
    const rows = [
      f({ code: "ERC_POWER_IN_UNDRIVEN", severity: "Warning" }),
      f({ code: "KICAD_POWER_PIN_NOT_DRIVEN", severity: "Error", origin: "advisory" }),
      f({ code: "KICAD_LIB_SYMBOL_MISMATCH", severity: "Warning", origin: "advisory" }),
      f({ code: "REVIEW_BULK_CAP", severity: "Warning", origin: "advisory" }),
      f({ code: "OFF_GRID", severity: "Info" }),
    ];
    const c = bucketCounts(rows);
    expect(c.engine).toEqual({ total: 2, errors: 0, warnings: 1 });
    expect(c.kicad).toEqual({ total: 2, errors: 1, warnings: 1 });
    expect(c.model).toEqual({ total: 1, errors: 0, warnings: 1 });
  });

  it("has a header line per bucket in all four languages", () => {
    for (const l of UI_LANGS) {
      const cat = catalogues[l] as Record<string, string>;
      expect(format(cat["side.findingsEngine"], { errors: 0, warnings: 2 })).toContain("2");
      expect(format(cat["side.findingsKicad"], { errors: 1, warnings: 0 })).toContain("1");
      expect(format(cat["side.findingsModel"], { n: 3 })).toContain("3");
      // Closed rows are two counts, never one: a repair changed the schematic, a waiver did not.
      expect(format(cat["side.findingsRepaired"], { n: 4 })).toContain("4");
      expect(format(cat["side.findingsWaived"], { n: 2 })).toContain("2");
    }
  });
});

describe("default fix selection", () => {
  it("is engine Error/Warning the fix path has a repair for", () => {
    expect(isDefaultFixSelected(f({ code: "ERC_POWER_IN_UNDRIVEN", severity: "Error" }))).toBe(true);
    expect(isDefaultFixSelected(f({ code: "OFF_GRID", severity: "Warning" }))).toBe(true);
    // Registered `who: "fixer"`, so the gate step already dispatches a Fixer for it without asking:
    // `/fix` starts from the same registry rather than from a second, narrower opinion.
    expect(isDefaultFixSelected(f({ code: "ERC_SINGLE_PIN_NET" }))).toBe(true);
    // Info is not a defect the fixer chases.
    expect(isDefaultFixSelected(f({ code: "OFF_GRID", severity: "Info" }))).toBe(false);
    // Repairs that are a librarian's or a human's call are listed, never pre-ticked.
    expect(isDefaultFixSelected(f({ code: "FOOTPRINT_MISSING" }))).toBe(false);
    expect(isDefaultFixSelected(f({ code: "ERC_PIN_TO_PIN" }))).toBe(false);
    expect(isDefaultFixSelected(f({ code: "PART_UNVERIFIED" }))).toBe(false);
    // Advisory rows (model or kicad-cli) never decide a write on their own.
    expect(isDefaultFixSelected(f({ code: "KICAD_POWER_PIN_NOT_DRIVEN", origin: "advisory" }))).toBe(false);
    expect(isDefaultFixSelected(f({ code: "REVIEW_X", origin: "advisory" }))).toBe(false);
    // Waived and resolved rows stay out of the counts and out of the selection.
    expect(isDefaultFixSelected(f({ code: "OFF_GRID", severity: "Warning", waived: true }))).toBe(false);
    expect(isDefaultFixSelected(f({ code: "OFF_GRID", severity: "Warning", waived_until: "2099-01-01T00:00:00Z" }))).toBe(false);
    expect(isDefaultFixSelected(f({ code: "OFF_GRID", severity: "Warning", resolved: true }))).toBe(false);
  });

  it("keeps the order of the rows it was given", () => {
    const rows = [f({ code: "FOOTPRINT_MISSING" }), f({ code: "OFF_GRID", severity: "Warning" }), f({ code: "ERC_POWER_IN_UNDRIVEN" })];
    expect(defaultFixSelection(rows).map((x) => x.code)).toEqual(["OFF_GRID", "ERC_POWER_IN_UNDRIVEN"]);
  });

  // The bug this invariant closes: the pre-tick predicate and the `/fix` triage were two different
  // lists (a set of "needs a human" codes vs. a family regex), so thirteen codes — DECAP_FAR and
  // NO_CONNECT_CONFLICT among them, both registered `who: "fixer"` — were ticked by default, sent
  // with the click and then dropped by `system.fix_not_fixable`.
  it("never pre-ticks a row the fix path would drop, for any code in the registry", () => {
    const rows = FINDING_CODES.map((code) => f({ code, severity: "Error" }));
    const fixable = new Set(triageFixSelection(rows).fixable.map((x) => x.code));
    for (const row of defaultFixSelection(rows)) expect(fixable.has(row.code)).toBe(true);
    // And the repairs the report named are in it: the regex used to block both.
    expect(fixable.has("DECAP_FAR")).toBe(true);
    expect(fixable.has("NO_CONNECT_CONFLICT")).toBe(true);
  });
});

describe("fix kind", () => {
  it("names the pass that owns the repair, deterministic ones before the model", () => {
    // `ercfix` writes the op-list itself: no model round.
    expect(fixKind("ERC_POWER_IN_UNDRIVEN")).toBe("mechanical");
    expect(fixKind("POWER_PORT_DANGLING")).toBe("mechanical");
    expect(fixKind("PINMAP_UNCONNECTED")).toBe("mechanical");
    // The stylist's own moves.
    expect(fixKind("ROW_MISALIGNED")).toBe("stylist");
    expect(fixKind("DECAP_FAR")).toBe("stylist");
    // Registered for a Fixer round.
    expect(fixKind("NO_CONNECT_CONFLICT")).toBe("fixer");
    expect(fixKind("DANGLING_ENDPOINT")).toBe("fixer");
    // A librarian's, a human's, or nobody's.
    expect(fixKind("FOOTPRINT_MISSING")).toBe("none");
    expect(fixKind("DUPLICATE_UUID")).toBe("none");
    expect(fixKind("SUBSTITUTED_PART")).toBe("none");
    expect(fixKind("KICAD_POWER_PIN_NOT_DRIVEN")).toBe("none");
  });

  it("costs a model round for everything but the ercfix codes, and counts the three", () => {
    // `/fix` runs ercfix and then Fixer rounds; the stylist belongs to a build step, so a
    // stylist-owned code costs a model round here too.
    expect(fixCost(f({ code: "ERC_POWER_IN_UNDRIVEN" }))).toBe("mechanical");
    expect(fixCost(f({ code: "ROW_MISALIGNED" }))).toBe("model");
    expect(fixCost(f({ code: "DANGLING_ENDPOINT" }))).toBe("model");
    expect(fixCost(f({ code: "FOOTPRINT_MISSING" }))).toBe("none");
    // An engine code is the only thing the fix path acts on: KiCad's own row has no repair of its own.
    expect(fixCost(f({ code: "KICAD_POWER_PIN_NOT_DRIVEN", origin: "advisory" }))).toBe("none");
    expect(fixCostCounts([
      f({ code: "ERC_POWER_IN_UNDRIVEN" }),
      f({ code: "PINMAP_UNCONNECTED" }),
      f({ code: "DECAP_FAR" }),
      f({ code: "FOOTPRINT_MISSING" }),
    ])).toEqual({ mechanical: 2, model: 1, none: 1 });
  });

  it("has the three badges and the plan line in all four languages", () => {
    for (const l of UI_LANGS) {
      const cat = catalogues[l] as Record<string, string>;
      for (const k of ["side.fixKind.mechanical", "side.fixKind.model", "side.fixKind.none"]) expect(cat[k]).toBeTruthy();
      const line = format(cat["side.fixPlan"], { mechanical: 2, model: 1, none: 3 });
      expect(line).toContain("2");
      expect(line).toContain("1");
      expect(line).toContain("3");
    }
  });
});

describe("fix triage", () => {
  it("routes a KiCad row onto the engine finding on the same object and drops the rest by name", () => {
    const engine = f({ code: "ERC_POWER_IN_UNDRIVEN", location: "erc:pwr:VBUS", refs: ["U1.5"], sheet: "/" });
    const sameObject = f({ code: "KICAD_POWER_PIN_NOT_DRIVEN", origin: "advisory", location: "kicad:a", refs: ["U1.5"], sheet: "/" });
    const otherObject = f({ code: "KICAD_LIB_SYMBOL_ISSUES", origin: "advisory", location: "kicad:b", refs: ["U9"] });
    const advisory = f({ code: "REVIEW_BULK_CAP", origin: "advisory", location: "rev:1", severity: "Warning" });
    const t = triageFixSelection([engine, sameObject, otherObject, advisory]);
    expect(t.fixable).toEqual([engine]);
    expect(t.routed).toEqual([{ row: sameObject, into: engine }]);
    expect(t.dropped).toEqual([otherObject, advisory]);
  });

  it("does not route across sheets when both rows say which sheet they sit on", () => {
    const engine = f({ code: "ERC_POWER_IN_UNDRIVEN", refs: ["U1.5"], sheet: "/" });
    const elsewhere = f({ code: "KICAD_POWER_PIN_NOT_DRIVEN", origin: "advisory", refs: ["U1.5"], sheet: "/power/" });
    expect(triageFixSelection([engine, elsewhere]).dropped).toEqual([elsewhere]);
  });

  it("leaves engine codes the fixer has no repair for in the dropped list", () => {
    const unknown = f({ code: "SOMETHING_NEW", severity: "Error" });
    const t = triageFixSelection([unknown]);
    expect(t.fixable).toEqual([]);
    expect(t.dropped).toEqual([unknown]);
  });

  it("names dropped rows by code and location, capped", () => {
    expect(findingLabels([f({ code: "A", location: "l1" }), f({ code: "B" })])).toBe("A l1, B");
    expect(findingLabels([f({ code: "A" }), f({ code: "B" }), f({ code: "C" })], 2)).toBe("A, B +1");
  });

  it("has a system line for every triage outcome in all four languages", () => {
    for (const l of UI_LANGS) {
      const cat = catalogues[l] as Record<string, string>;
      expect(format(cat["system.fix_not_fixable"], { n: 2, codes: "KICAD_X kicad:b" })).toContain("KICAD_X kicad:b");
      expect(format(cat["system.fix_routed"], { n: 1, codes: "KICAD_Y" })).toContain("KICAD_Y");
      expect(format(cat["system.fix_other_sheets"], { sheet: "root.kicad_sch", n: 1, sheets: "power.kicad_sch" })).toContain("power.kicad_sch");
    }
  });
});
