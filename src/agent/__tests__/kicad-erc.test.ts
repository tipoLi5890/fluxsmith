// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { emptyKicadErc, kicadErcResult, refOfItem } from "../kicad-erc";

/**
 * `kicad-cli` writes its ERC item descriptions in whatever language KiCad runs in, and the
 * environment cannot always force English (on macOS wxWidgets takes the UI language from the
 * system preferences and ignores `LC_ALL` / `LANG` — verified with KiCad 10.0.4). Every string
 * below is from a real run on `tests/conformance/fixtures/hier`, with its English twin.
 */
const ZH = {
  pin: "Symbol R3 接腳 2 [無源, 線]",
  power: "Symbol #PWR02 接腳 1 [電源輸入, 線]",
  global: "全域標籤 'GLB'",
  label: "標籤 '+3V3_LED'",
  wire: "線",
};
const EN = {
  pin: "Symbol R3 Pin 2 [Passive, Line]",
  power: "Symbol #PWR02 Pin 1 [Power input, Line]",
  global: "Global label 'GLB'",
  label: "Label '+3V3_LED'",
  wire: "Wire",
};

describe("refOfItem", () => {
  it("reads the same designator and pin out of a translated and an English description", () => {
    for (const d of [ZH, EN]) {
      expect(refOfItem(d.pin)).toBe("R3.2");
      expect(refOfItem(d.power)).toBe("#PWR02.1");
      expect(refOfItem(d.global)).toBeNull();
      expect(refOfItem(d.label)).toBeNull();
      expect(refOfItem(d.wire)).toBeNull();
    }
  });

  it("reads a pin number wherever the locale puts the word for pin", () => {
    expect(refOfItem("シンボル U12 ピン A3 [入力, 線]")).toBe("U12.A3");
    expect(refOfItem("Symbol U1 Pin 3 [VCC, Power input, Line]")).toBe("U1.3");
    expect(refOfItem("Bauteil U1 Pin 3 [VCC, Leistungseingang, Linie]")).toBe("U1.3");
  });

  it("never reads a pin name or a label name as a designator", () => {
    // The bracketed detail is cut off before anything is matched.
    expect(refOfItem("Wire [R1, Line]")).toBeNull();
    // A quoted name is not a bare token, so a label called R1 stays a label.
    expect(refOfItem("Label 'R1'")).toBeNull();
    // A symbol with no pin (no bracketed detail) keeps the bare designator.
    expect(refOfItem("Symbol R3")).toBe("R3");
  });
});

describe("kicadErcResult", () => {
  const violation = (d: typeof ZH) => ({
    type: "power_pin_not_driven",
    severity: "error",
    description: "Input Power pin not driven by any Output Power pins",
    sheet: "/child/",
    file: "hier_child.kicad_sch",
    at_mil: [1650, 2000],
    items: [{ description: d.pin, uuid: "u-1" }],
  });

  it("maps a report the same way in either locale, keeping the Rust side's sheet and anchor", () => {
    const rows = [ZH, EN].map((d) => kicadErcResult({ available: true, total: 1, violations: [violation(d)] }).rows[0]);
    expect(rows[0]).toMatchObject({
      code: "KICAD_POWER_PIN_NOT_DRIVEN",
      severity: "Error",
      refs: ["R3.2"],
      // Resolved from the designator against the parsed tree, not from KiCad's own sheet path.
      sheet: "/child/",
      file: "hier_child.kicad_sch",
      at_mil: [1650, 2000],
      location: "kicad:power_pin_not_driven:u-1",
      origin: "advisory",
    });
    expect(rows[1]).toMatchObject({ refs: ["R3.2"], sheet: "/child/", at_mil: [1650, 2000] });
    // The raw description stays in the message as untrusted text (red line 21).
    expect(rows[0].message).toContain(ZH.pin);
    expect(rows[1].message).toContain(EN.pin);
  });

  it("carries an anchor for a violation that names no component", () => {
    const res = kicadErcResult({
      available: true,
      total: 1,
      violations: [{ type: "multiple_net_names", severity: "warning", description: "two names", sheet: "/", at_mil: [2000, 2300], items: [{ description: ZH.global, uuid: "u-2" }] }],
    });
    expect(res.rows[0].refs).toBeUndefined();
    expect(res.rows[0].at_mil).toEqual([2000, 2300]);
    expect(res.warnings).toBe(1);
  });

  it("drops a malformed anchor rather than placing a marker at a guessed point", () => {
    const res = kicadErcResult({ available: true, total: 1, violations: [{ type: "x", severity: "warning", at_mil: ["a", null], items: [] }] });
    expect(res.rows[0].at_mil).toBeUndefined();
  });

  it("reports anything it cannot read as not available, never as a clean report", () => {
    expect(kicadErcResult(null).available).toBe(false);
    expect(kicadErcResult({ available: false, code: "KICAD_CLI_MISSING" }).note).toBe("KICAD_CLI_MISSING");
    expect(kicadErcResult({ available: true }).note).toBe("no report");
    expect(emptyKicadErc("timeout")).toEqual({ available: false, note: "timeout", errors: 0, warnings: 0, rows: [], total: 0 });
  });
});
