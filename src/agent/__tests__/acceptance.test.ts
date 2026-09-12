// SPDX-License-Identifier: Apache-2.0
// Typed acceptance (SPEC.md D-18): every verdict is read off engine data handed in — net membership,
// gate findings, symbol positions — and an item the engine cannot answer is "na", never a guess.
import { describe, expect, it } from "vitest";
import { acceptanceCounts, acceptanceDoneKey, acceptanceNeedsPositions, acceptanceNeedsPowerSymbols, acceptanceNoConnectPins, acceptanceVerdict, evaluateAcceptance, findNet, powerPrefixKind, refMatchesPrefix, splitMember, type AcceptanceNet, type AcceptancePowerSymbol } from "../plans/acceptance";
import type { Acceptance, PlanBlock } from "../plans/schema";

/** An LDO block as the engine reports it: a rail with two caps, a ground, one no-connect pin. */
const NETS: AcceptanceNet[] = [
  { name: "+3V3", members: ["C1.1", "C2.1", "U1.2"], labeled: true, no_connect: false },
  { name: "GND", members: ["#PWR01.1", "C1.2", "C2.2", "U1.3"], labeled: true },
  { name: "VBUS", members: ["J1.1", "U1.1"], labeled: false },
  { name: "unconnected-(U1-Pad5)", members: ["U1.5"], no_connect: true },
  { name: "unconnected-(U1-Pad6)", members: ["U1.6"] },
];

const SYMBOLS = {
  U1: { at_mil: [1000, 1000] as [number, number], value: "AMS1117-3.3" },
  C1: { at_mil: [1100, 1000] as [number, number], value: "100n" },
  C2: { at_mil: [2000, 1000] as [number, number], value: "10u" },
  J1: { at_mil: [500, 1000] as [number, number] },
};

function run(item: unknown, nets: AcceptanceNet[] = NETS, findings: { code: string; severity: string }[] = [], ctx = {}) {
  const block = { id: "ldo", acceptance: [item as Acceptance] } as Pick<PlanBlock, "id" | "acceptance">;
  return evaluateAcceptance(block, nets, findings, ctx)[0];
}

describe("acceptance helpers", () => {
  it("splits members and matches ref prefixes without swallowing lookalikes", () => {
    expect(splitMember("U1.2")).toEqual({ ref: "U1", pin: "2" });
    expect(splitMember("U1.A1")).toEqual({ ref: "U1", pin: "A1" });
    expect(splitMember("U1")).toBeNull();
    expect(refMatchesPrefix("U1", "U")).toBe(true);
    expect(refMatchesPrefix("UART1", "U")).toBe(false);
    expect(refMatchesPrefix("U1", "U1")).toBe(true);
    expect(refMatchesPrefix("U2", "U1")).toBe(false);
  });

  it("resolves a plan net name against the engine's spelling", () => {
    const nets: AcceptanceNet[] = [{ name: "/power/OUT", members: ["U1.3"] }, { name: "GND", members: ["U1.1"] }];
    expect(findNet(nets, "OUT")?.name).toBe("/power/OUT");
    expect(findNet(nets, "gnd")?.name).toBe("GND");
    expect(findNet(nets, "VBUS")).toBeNull();
  });
});

describe("evaluateAcceptance", () => {
  it("text items are informational, never a verdict", () => {
    const r = run({ type: "text", text: "keep the loop area small" });
    expect(r.status).toBe("na");
    expect(r.na_reason).toBe("informational");
  });

  it("pin_on_net: passes on membership, fails with the net the pin is actually on", () => {
    expect(run({ type: "pin_on_net", ref_prefix: "U", pin: "2", net: "+3V3" })).toMatchObject({ status: "pass", detail: "U1.2" });
    expect(run({ type: "pin_on_net", ref_prefix: "U", pin: "3", net: "+3V3" })).toMatchObject({ status: "fail", detail: "U1.3 = GND" });
    expect(run({ type: "pin_on_net", ref_prefix: "U", pin: "2", net: "+5V" })).toMatchObject({ status: "fail", detail: "no net +5V" });
    expect(run({ type: "pin_on_net", ref_prefix: "Q", pin: "2", net: "+3V3" })).toMatchObject({ status: "fail", detail: "no Q*.2" });
    expect(run({ type: "pin_on_net", ref_prefix: "U", pin: "2", net: "+3V3" }, [])).toMatchObject({ status: "na", na_reason: "no_net_data" });
  });

  it("net_has_pins counts the engine's members", () => {
    expect(run({ type: "net_has_pins", net: "+3V3", min: 3 })).toMatchObject({ status: "pass", detail: "3" });
    expect(run({ type: "net_has_pins", net: "+3V3", min: 4 }).status).toBe("fail");
    expect(run({ type: "net_has_pins", net: "SDA", min: 2 })).toMatchObject({ status: "fail", detail: "no net SDA" });
  });

  it("nets_disjoint: separate nets pass, a merged or vanished name fails, unknown names are n/a", () => {
    expect(run({ type: "nets_disjoint", nets: ["+3V3", "GND"] }).status).toBe("pass");
    // The same net under two spellings is exactly what a merge looks like in the netlist.
    expect(run({ type: "nets_disjoint", nets: ["+3V3", "/+3V3"] })).toMatchObject({ status: "fail" });
    expect(run({ type: "nets_disjoint", nets: ["+3V3", "SDA"] })).toMatchObject({ status: "fail", detail: "no net SDA" });
    expect(run({ type: "nets_disjoint", nets: ["SDA", "SCL"] })).toMatchObject({ status: "na", na_reason: "net_missing" });
  });

  it("component_count counts references from the netlist and leaves grouping to the plan", () => {
    expect(run({ type: "component_count", prefix: "C", min: 2 })).toMatchObject({ status: "pass", detail: "2" });
    expect(run({ type: "component_count", prefix: "C", min: 3 })).toMatchObject({ status: "fail", detail: "2" });
    expect(run({ type: "component_count", prefix: "C", max: 1 }).status).toBe("fail");
    expect(run({ type: "component_count", prefix: "C", min: 1, in_group: "ldo" })).toMatchObject({ status: "na", na_reason: "unsupported" });
  });

  it("check_clean reads the gate findings, exact codes and PREFIX_* wildcards", () => {
    const findings = [
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Error" },
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Error" },
      { code: "FOOTPRINT_MISSING", severity: "Warning" },
    ];
    expect(run({ type: "check_clean", codes: ["ERC_POWER_IN_UNDRIVEN"] }, NETS, []).status).toBe("pass");
    expect(run({ type: "check_clean", codes: ["ERC_POWER_IN_UNDRIVEN"] }, NETS, findings)).toMatchObject({ status: "fail", detail: "ERC_POWER_IN_UNDRIVEN x2" });
    expect(run({ type: "check_clean", codes: ["ERC_*"] }, NETS, findings).status).toBe("fail");
    expect(run({ type: "check_clean", codes: ["DANGLING_ENDPOINT"] }, NETS, findings).status).toBe("pass");
  });

  it("decoupling_near measures the engine's symbol positions, and says so when it has none", () => {
    const near = { type: "decoupling_near", ref_prefix: "U", pin: "2", max_dist_mil: 300, spec: "100n" };
    expect(run(near, NETS, [], { symbols: SYMBOLS })).toMatchObject({ status: "pass", detail: "C1 100n 100mil" });
    expect(run({ ...near, max_dist_mil: 50 }, NETS, [], { symbols: SYMBOLS })).toMatchObject({ status: "fail", detail: "C1 100n 100mil" });
    expect(run(near, NETS, [], {})).toMatchObject({ status: "na", na_reason: "no_position_data" });
    // A pin on a rail with no capacitor at all fails on the netlist alone.
    expect(run({ ...near, pin: "1" }, NETS, [], { symbols: SYMBOLS })).toMatchObject({ status: "fail", detail: "no C on VBUS" });
  });

  it("label_on_pin needs both the membership and a label the engine saw", () => {
    expect(run({ type: "label_on_pin", ref_prefix: "U", pin: "2", net: "+3V3" })).toMatchObject({ status: "pass", detail: "U1.2" });
    expect(run({ type: "label_on_pin", ref_prefix: "U", pin: "1", net: "VBUS" }).status).toBe("fail");
    expect(run({ type: "label_on_pin", ref_prefix: "U", pin: "3", net: "+3V3" })).toMatchObject({ status: "fail", detail: "no U*.3 on +3V3" });
    const unread: AcceptanceNet[] = [{ name: "+3V3", members: ["U1.2"] }];
    expect(run({ type: "label_on_pin", ref_prefix: "U", pin: "2", net: "+3V3" }, unread)).toMatchObject({ status: "na", na_reason: "no_net_data" });
  });

  it("no_connect reads the engine's per-net flag, and never guesses when it was not read", () => {
    expect(run({ type: "no_connect", ref_prefix: "U", pins: ["5"] })).toMatchObject({ status: "pass" });
    expect(run({ type: "no_connect", ref_prefix: "U", pins: ["2"] })).toMatchObject({ status: "fail", detail: "U1.2" });
    expect(run({ type: "no_connect", ref_prefix: "U", pins: ["9"] })).toMatchObject({ status: "fail", detail: "no U*.9" });
    expect(run({ type: "no_connect", ref_prefix: "U", pins: ["6"] })).toMatchObject({ status: "na", na_reason: "no_net_data" });
  });

  it("an unknown type is reported, not silently dropped", () => {
    expect(run({ type: "smoke_test" })).toMatchObject({ status: "na", na_reason: "unsupported" });
  });

  it("keeps the plan's order and tallies the block", () => {
    const block = {
      id: "ldo",
      acceptance: [
        { type: "net_has_pins", net: "+3V3", min: 3 },
        { type: "net_has_pins", net: "+3V3", min: 9 },
        { type: "text", text: "note" },
      ] as unknown as Acceptance[],
    };
    const rs = evaluateAcceptance(block, NETS, []);
    expect(rs.map((r) => r.status)).toEqual(["pass", "fail", "na"]);
    expect(rs.every((r) => r.block === "ldo")).toBe(true);
    expect(acceptanceCounts(rs)).toEqual({ passed: 1, failed: 1, na: 1, advisory: 0 });
  });

  // Red line 6: `net_has_pins >= 2` on every exported net is the harness restating the plan, not an
  // engineer's threshold and not the engine's judgement. Such a row is evaluated and shown, and it can
  // neither fail nor pass the plan.
  it("rows the harness derived are advisory: reported with their label, never part of the verdict", () => {
    const block = {
      id: "led",
      acceptance: [
        { type: "net_has_pins", net: "VBUS", min: 2 },
        { type: "net_has_pins", net: "unconnected-(U1-Pad6)", min: 2, derived: true },
        { type: "component_count", prefix: "C", min: 2, derived: true },
      ] as unknown as Acceptance[],
    };
    const rs = evaluateAcceptance(block, NETS, []);
    expect(rs.map((r) => r.status)).toEqual(["pass", "advisory", "advisory"]);
    // The engine's own answer for each advisory row travels along, so the card can still show it.
    expect(rs[1]).toMatchObject({ derived: true, outcome: "fail", label: "net_has_pins unconnected-(U1-Pad6) >= 2" });
    expect(rs[2]).toMatchObject({ derived: true, outcome: "pass" });
    const counts = acceptanceCounts(rs);
    expect(counts).toEqual({ passed: 1, failed: 0, na: 0, advisory: 2 });
    // A derived row that did not hold does not make the plan fail; a plan carrying only derived rows is
    // unverified, not passed and not "nothing declared".
    expect(acceptanceVerdict(counts)).toBe("pass");
    const onlyDerived = acceptanceCounts(rs.slice(1));
    expect(acceptanceVerdict(onlyDerived)).toBe("unverified");
    expect(acceptanceDoneKey(onlyDerived)).toBe("system.plan_done_acceptance_unverified");
  });

  it("declares the extra engine reads its types need", () => {
    const blocks = [{ acceptance: [{ type: "decoupling_near", ref_prefix: "U", pin: "2", max_dist_mil: 300, spec: "100n" }, { type: "no_connect", ref_prefix: "U", pins: ["5", "6"] }] as unknown as Acceptance[] }];
    expect(acceptanceNeedsPositions(blocks)).toBe(true);
    expect(acceptanceNeedsPositions([{ acceptance: [] }])).toBe(false);
    expect(acceptanceNoConnectPins(blocks)).toEqual([{ prefix: "U", pin: "5" }, { prefix: "U", pin: "6" }]);
    expect(acceptanceNeedsPowerSymbols(blocks)).toBe(false);
    expect(acceptanceNeedsPowerSymbols([{ acceptance: [{ type: "component_count", prefix: "#FLG", min: 1 }] as unknown as Acceptance[] }])).toBe(true);
    expect(acceptanceNeedsPowerSymbols([{ acceptance: [{ type: "pin_on_net", ref_prefix: "#PWR", pin: "1", net: "GND" }] as unknown as Acceptance[] }])).toBe(true);
  });

  // Real run 19: a PWR_FLAG sat on USB_5V and the gate still reported `component_count #FLG 1..1 -> 0`
  // and `pin_on_net #FLG.1 = USB_5V -> no #FLG*.1`, because the engine hides a power symbol's pin from
  // the netlist. Those rows are answered from the engine's symbol list and the net's own `flagged` bit.
  describe("power symbols", () => {
    const PWR_NETS: AcceptanceNet[] = [
      { name: "USB_5V", members: ["C1.1", "J1.1", "U1.3"], flagged: true },
      { name: "+3V3", members: ["C2.1", "U1.2"], flagged: false },
      { name: "GND", members: ["C1.2", "C2.2", "U1.1"], flagged: false },
    ];
    const POWER: AcceptancePowerSymbol[] = [
      { reference: "#FLG1", value: "PWR_FLAG", lib_id: "power:PWR_FLAG" },
      { reference: "#PWR01", value: "GND", lib_id: "power:GND" },
      { reference: "#PWR02", value: "+3V3", lib_id: "power:+3V3" },
    ];
    const ctx = { power: POWER };

    it("component_count counts the power symbols the engine listed, not netlist references", () => {
      expect(run({ type: "component_count", prefix: "#FLG", min: 1, max: 1 }, PWR_NETS, [], ctx)).toMatchObject({ status: "pass", detail: "1" });
      expect(run({ type: "component_count", prefix: "#PWR", min: 2, max: 2 }, PWR_NETS, [], ctx)).toMatchObject({ status: "pass", detail: "2" });
      expect(run({ type: "component_count", prefix: "#PWR", min: 3 }, PWR_NETS, [], ctx)).toMatchObject({ status: "fail", detail: "2" });
      // Ordinary prefixes keep reading the netlist, and power references never leak into their count.
      expect(run({ type: "component_count", prefix: "C", min: 2, max: 2 }, PWR_NETS, [], ctx)).toMatchObject({ status: "pass", detail: "2" });
    });

    it("component_count reports na when no symbol list was read", () => {
      expect(run({ type: "component_count", prefix: "#FLG", min: 1 }, PWR_NETS, [], {})).toMatchObject({ status: "na", na_reason: "no_symbol_data" });
    });

    it("pin_on_net #FLG asks the engine whether the net is flagged", () => {
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "USB_5V" }, PWR_NETS, [], ctx)).toMatchObject({ status: "pass", detail: "#FLG1 on USB_5V" });
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "+3V3" }, PWR_NETS, [], ctx)).toMatchObject({ status: "fail", detail: "+3V3 not flagged" });
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "VBUS" }, PWR_NETS, [], ctx)).toMatchObject({ status: "fail", detail: "no net VBUS" });
      // The flag was never read: the row says so instead of guessing either way.
      const unread: AcceptanceNet[] = [{ name: "USB_5V", members: ["J1.1"] }];
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "USB_5V" }, unread, [], ctx)).toMatchObject({ status: "na", na_reason: "no_net_data" });
      // No PWR_FLAG placed at all, and no symbol list read at all.
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "USB_5V" }, PWR_NETS, [], { power: [POWER[1]] })).toMatchObject({ status: "fail", detail: "no #FLG*" });
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "USB_5V" }, PWR_NETS, [], {})).toMatchObject({ status: "na", na_reason: "no_symbol_data" });
    });

    it("pin_on_net #PWR resolves the port through the net it names", () => {
      expect(run({ type: "pin_on_net", ref_prefix: "#PWR", pin: "1", net: "GND" }, PWR_NETS, [], ctx)).toMatchObject({ status: "pass", detail: "#PWR01 GND" });
      expect(run({ type: "pin_on_net", ref_prefix: "#PWR", pin: "1", net: "USB_5V" }, PWR_NETS, [], ctx)).toMatchObject({ status: "fail", detail: "#PWR01 GND, #PWR02 +3V3" });
    });

    // Real run 21: `component_count #FLG >= 1` read 0 on a sheet carrying two PWR_FLAGs, because
    // `place_pwr_flag` annotates out of the same `#PWRnn` sequence as every other power port, so the
    // flags were `#PWR02` and `#PWR04`. The reference seeds the symbol's uuid and cannot be changed
    // (red line 1), so the prefix is resolved by what the symbol is.
    it("resolves #FLG / #PWR by the library symbol, not by the annotated reference", () => {
      const ANNOTATED: AcceptancePowerSymbol[] = [
        { reference: "#PWR07", value: "PWR_FLAG", lib_id: "power:PWR_FLAG" },
        { reference: "#PWR08", value: "PWR_FLAG", lib_id: "power:PWR_FLAG" },
        { reference: "#PWR01", value: "GND", lib_id: "power:GND" },
        { reference: "#PWR02", value: "+3V3", lib_id: "power:+3V3" },
      ];
      const c = { power: ANNOTATED };
      expect(run({ type: "component_count", prefix: "#FLG", min: 1 }, PWR_NETS, [], c)).toMatchObject({ status: "pass", detail: "2" });
      // `#PWR` is the ports, flags excluded: two PWR_FLAGs must not pass "two power ports".
      expect(run({ type: "component_count", prefix: "#PWR", min: 2, max: 2 }, PWR_NETS, [], c)).toMatchObject({ status: "pass", detail: "2" });
      expect(run({ type: "component_count", prefix: "#PWR", min: 4 }, PWR_NETS, [], c)).toMatchObject({ status: "fail", detail: "2" });
      // `pin_on_net #FLG.1` goes on reading the net's own `flagged` bit, through the same resolution.
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "USB_5V" }, PWR_NETS, [], c)).toMatchObject({ status: "pass", detail: "#PWR07 on USB_5V" });
      expect(run({ type: "pin_on_net", ref_prefix: "#FLG", pin: "1", net: "+3V3" }, PWR_NETS, [], c)).toMatchObject({ status: "fail", detail: "+3V3 not flagged" });
      // A designator the plan spelled out in full is still matched literally.
      expect(run({ type: "component_count", prefix: "#PWR07", min: 1, max: 1 }, PWR_NETS, [], c)).toMatchObject({ status: "pass", detail: "1" });
      expect(powerPrefixKind("#FLG")).toBe("flag");
      expect(powerPrefixKind("#PWR")).toBe("port");
      expect(powerPrefixKind("#PWR07")).toBe("other");
      expect(powerPrefixKind("C")).toBe("other");
    });
  });

  it("all-na rows are unverified, not done: a text-only plan on an empty schematic never passes", () => {
    // Exactly the shape a real run closed on: eleven informational rows, nothing else, no symbols.
    const block = { id: "ldo", acceptance: Array.from({ length: 11 }, (_, i) => ({ type: "text", text: `note ${i}` })) as unknown as Acceptance[] };
    const rs = evaluateAcceptance(block, [], []);
    expect(rs.every((r) => r.status === "na" && r.na_reason === "informational")).toBe(true);
    const counts = acceptanceCounts(rs);
    expect(counts).toEqual({ passed: 0, failed: 0, na: 11, advisory: 0 });
    expect(acceptanceVerdict(counts)).toBe("unverified");
    expect(acceptanceDoneKey(counts)).toBe("system.plan_done_acceptance_unverified");
    // A plan that declared no acceptance at all reads differently from one whose rows nothing could answer.
    expect(acceptanceVerdict({ passed: 0, failed: 0, na: 0 })).toBe("unverified");
    expect(acceptanceDoneKey({ passed: 0, failed: 0, na: 0 })).toBe("system.plan_done_acceptance_none");
    // One engine answer of either kind is enough to make the verdict a real one.
    expect(acceptanceVerdict({ passed: 3, failed: 0, na: 9 })).toBe("pass");
    expect(acceptanceVerdict({ passed: 3, failed: 1, na: 9 })).toBe("fail");
    expect(acceptanceDoneKey({ passed: 0, failed: 1, na: 9 })).toBe("system.plan_done_acceptance");
  });
});
