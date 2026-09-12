// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { canonicalOpName, normalizeOplist, closeAllowedOps, oplistWarnings } from "../tools/ops";
import { executeTool, type ToolContext } from "../tools/registry";
import { toolDef } from "../tools/manifest";

// The engine only knows the real vocabulary: an aliased name that reaches it comes back
// OP_UNKNOWN, which is exactly what `ops.template` used to do with the names below.
const TEMPLATES: Record<string, unknown> = {
  place_component: { op: "place_component", lib_id: "Device:R" },
  add_sheet_pin: { op: "add_sheet_pin", name: "VIN" },
};
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const req = (args as { request: { kind: string; op?: string } }).request;
    if (req.kind !== "ops_template") return { ok: true, data: {}, error: null, meta: {} };
    const t = TEMPLATES[String(req.op)];
    if (t) return { ok: true, data: t, error: null, meta: {} };
    return { ok: false, data: null, error: { code: "OP_UNKNOWN", message: String(req.op) }, meta: {} };
  }),
}));

function toolCtx(): ToolContext {
  return {
    projectKey: "pk", auth: () => ({ build_session: null, role: "lead" }), turn: 1, step: "s", role: "lead",
    skills: {} as ToolContext["skills"], plans: {} as ToolContext["plans"], selection: () => [],
    askCard: async () => ({ action_id: "approve" }),
    sheets: () => ["root.kicad_sch"], planState: () => "none", policy: () => "review",
    emitCard: () => undefined, emitFocus: () => undefined, onStatus: () => undefined,
    turnBegin: async () => ({}), ledger: async () => undefined, expectedMerges: () => [],
    unlockedGrant: () => undefined, vision: false,
  } as unknown as ToolContext;
}

describe("op-name aliases", () => {
  it("maps the recurring wrong names onto the vocabulary", () => {
    expect(canonicalOpName("add_decoupling")).toBe("place_decoupling");
    expect(canonicalOpName("Add Label")).toBe("add_net_label");
    expect(canonicalOpName("place_component")).toBe("place_component");
    expect(canonicalOpName("totally_unknown")).toBe("totally_unknown");
  });
  it("rewrites op names (and a `type` field) inside an op-list", () => {
    const o = normalizeOplist({ ops: [{ op: "add_decoupling", designator: "C3" }, { type: "add_gnd", at: "U1.20" }] }) as { ops: { op: string }[] };
    expect(o.ops.map((x) => x.op)).toEqual(["place_decoupling", "place_gnd"]);
  });
});

describe("label scope from the op name", () => {
  it("keeps the scope `add_global_label` / `add_hier_label` state, since only the name states it", () => {
    const o = normalizeOplist({ ops: [
      { op: "add_global_label", name: "SYS_ALERT", at: "U1.4" },
      { op: "add_hier_label", name: "VOUT", at: "U2.3" },
      { type: "Add Hierarchical Label", name: "EN", at: "U2.4" },
      { op: "add_net_label", name: "LOCAL_SIG", at: "U1.5" },
    ] }) as { ops: Record<string, unknown>[] };
    expect(o.ops.map((x) => x.op)).toEqual(["add_net_label", "add_net_label", "add_net_label", "add_net_label"]);
    expect(o.ops.map((x) => x.scope)).toEqual(["global", "hierarchical", "hierarchical", undefined]);
  });
  it("an explicit scope wins over the alias and the disagreement is noted", () => {
    const o = normalizeOplist({ ops: [{ op: "add_hier_label", name: "VOUT", at: "U2.3", scope: "global" }] }) as { ops: Record<string, unknown>[] };
    expect(o.ops[0].scope).toBe("global");
    expect(String(o.ops[0].note)).toContain("add_hier_label");
  });
  it("normalises the scope spellings the engine refuses", () => {
    const o = normalizeOplist({ ops: [
      { op: "add_net_label", name: "A", at: "U1.1", scope: "Hier" },
      { op: "route_net", from: "U1.1", to: "U1.2", scope: "GLOBAL" },
      { op: "add_hier_label", name: "B", at: "U1.3", scope: "hierarchical" },
    ] }) as { ops: Record<string, unknown>[] };
    expect(o.ops.map((x) => x.scope)).toEqual(["hierarchical", "global", "hierarchical"]);
    // an explicit scope that agrees with the alias is not a conflict
    expect(o.ops[2].note).toBeUndefined();
  });
  it("impliedScope only speaks for the names that state a scope", async () => {
    const { impliedScope } = await import("../tools/ops");
    expect(impliedScope("Add Global Label")).toBe("global");
    expect(impliedScope("add_hier_label")).toBe("hierarchical");
    expect(impliedScope("add_net_label")).toBeUndefined();
    expect(impliedScope("place_component")).toBeUndefined();
  });
});

describe("sheet envelope", () => {
  it("declares op sheets as an alias map", () => {
    const o = normalizeOplist({ ops: [{ op: "place_component", sheet: "a.kicad_sch" }], sheets: ["b.kicad_sch"] }) as { sheets: Record<string, string> };
    expect(o.sheets).toEqual({ "b.kicad_sch": "b.kicad_sch", "a.kicad_sch": "a.kicad_sch" });
  });
  // On the sheet-symbol ops `sheet` is a sheet symbol name, not a file: declaring it would put a symbol
  // name in the envelope the engine canonicalises as a path. Their routing key is `in_sheet`.
  it("never declares the `sheet` of a sheet-symbol op, and declares its `in_sheet`", () => {
    for (const op of ["add_sheet_pin", "delete_sheet_pin", "resize_sheet"]) {
      const o = normalizeOplist({ sheets: ["root.kicad_sch"], ops: [{ op, sheet: "CTRL", name: "SPI_CS" }] }) as { sheets: Record<string, string> };
      expect(o.sheets).toEqual({ "root.kicad_sch": "root.kicad_sch" });
    }
    const routed = normalizeOplist({ sheets: ["root.kicad_sch"], ops: [{ op: "add_sheet_pin", sheet: "CTRL", in_sheet: "power.kicad_sch", name: "SPI_CS" }] }) as { sheets: Record<string, string> };
    expect(routed.sheets).toEqual({ "root.kicad_sch": "root.kicad_sch", "power.kicad_sch": "power.kicad_sch" });
    // the op keeps its symbol name untouched
    expect((routed as unknown as { ops: Record<string, unknown>[] }).ops[0].sheet).toBe("CTRL");
    // an aliased op name is canonicalised before the routing key is read
    const aliased = normalizeOplist({ ops: [{ type: "Resize Sheet", sheet: "CTRL", size: [100, 100] }] }) as { sheets?: unknown };
    expect(aliased.sheets).toBeUndefined();
  });
});

describe("sheet paths the engine reports", () => {
  // The engine reports a finding with `file: "power.kicad_sch"` and `sheet: "/power/"`; run 18 turn 3
  // lost a dryrun_scratch to `PATH_OUT_OF_SCOPE /power/ is outside the project` because the Fixer wrote
  // the instance path back as the op's `sheet`.
  const project = ["ldo_board.kicad_sch", "power.kicad_sch"];
  it("maps an instance path onto its file and declares the file, not the path", () => {
    const o = normalizeOplist({ ops: [{ op: "set_component_transform", sheet: "/power/", uuid: "u", rotation: 0 }] }, project) as { ops: Record<string, unknown>[]; sheets: Record<string, string> };
    expect(o.ops[0].sheet).toBe("power.kicad_sch");
    expect(o.sheets).toEqual({ "power.kicad_sch": "power.kicad_sch" });
  });
  it("maps a bare sheet name and the root path, and leaves files and unknown names alone", () => {
    const ops = (sheet: string, sheets: readonly string[] = project) => (normalizeOplist({ ops: [{ op: "place_component", sheet }] }, sheets) as { ops: Record<string, unknown>[] }).ops[0].sheet;
    expect(ops("power")).toBe("power.kicad_sch");
    expect(ops("/")).toBe("ldo_board.kicad_sch");
    expect(ops("power.kicad_sch")).toBe("power.kicad_sch");
    // Unmappable: no such sheet, or two files with the same stem. The engine refuses it with its own error.
    expect(ops("/analog/")).toBe("/analog/");
    expect(ops("/power/", ["a/power.kicad_sch", "b/power.kicad_sch"])).toBe("/power/");
    // No project list (the hook path calls with one argument): nothing is rewritten.
    expect(ops("/power/", [])).toBe("/power/");
  });
  it("takes the instance path and the sheet-symbol names of a summary entry", async () => {
    const { resolveSheetRef } = await import("../tools/ops");
    const sheets = [{ file: "ldo_board.kicad_sch", instance_path: "/", names: [] }, { file: "power.kicad_sch", instance_path: "/power_stage/", names: ["PWR_STAGE"] }];
    expect(resolveSheetRef("/power_stage/", sheets)).toBe("power.kicad_sch");
    expect(resolveSheetRef("PWR_STAGE", sheets)).toBe("power.kicad_sch");
    expect(resolveSheetRef("power.kicad_sch", sheets)).toBeUndefined();
    expect(resolveSheetRef("/nope/", sheets)).toBeUndefined();
  });
  it("never rewrites the symbol name of a sheet-symbol op, only its in_sheet", () => {
    const o = normalizeOplist({ ops: [{ op: "add_sheet_pin", sheet: "power", in_sheet: "/power/", name: "SPI_CS" }] }, project) as { ops: Record<string, unknown>[] };
    expect(o.ops[0].sheet).toBe("power");
    expect(o.ops[0].in_sheet).toBe("power.kicad_sch");
  });
});

describe("net names", () => {
  it("drops the sheet slash from local net names", () => {
    const o = normalizeOplist({ ops: [{ op: "route_net", net: "/UART_TX" }, { op: "add_net_label", name: "/GPIO_PA1", at: "U1.2" }, { op: "place_power_port", net_name: "+3V3" }] }) as { ops: Record<string, unknown>[] };
    expect(o.ops[0].net).toBe("UART_TX"); expect(o.ops[1].name).toBe("GPIO_PA1"); expect(o.ops[2].net_name).toBe("+3V3");
  });
});

describe("closeAllowedOps", () => {
  it("closes macros over their expansion and the power family; empty stays unrestricted", async () => {
    const { closeAllowedOps } = await import("../tools/ops");
    expect(closeAllowedOps([])).toEqual([]);
    const c = closeAllowedOps(["place_component", "place_gnd", "connect_and_label"]);
    for (const o of ["place_power_port", "place_pwr_flag", "place_vcc", "route_net", "add_net_label", "add_wire"]) expect(c).toContain(o);
    expect(c.slice(0, 3)).toEqual(["place_component", "place_gnd", "connect_and_label"]);
    expect(closeAllowedOps(c)).toEqual(c);
    // a rail macro alone opens the whole power family (golden led_indicator hit a scope card on place_gnd)
    const m = closeAllowedOps(["place_led_indicator"]);
    for (const o of ["place_power_port", "place_gnd", "place_vcc", "place_pwr_flag"]) expect(m).toContain(o);
    // the harness's own repair ops ride along in every closed list (ercfix, title block)
    expect(closeAllowedOps(["set_component_parameters"])).toEqual(["set_component_parameters", "place_pwr_flag", "add_no_connect", "delete_object", "set_title_block"]);
  });
});

// F6: the op-list path canonicalised op names, but `ops.template` -- the one call whose whole
// purpose is to recover from not knowing the vocabulary -- passed the name through raw.
describe("ops.template canonicalises the op name", () => {
  it("returns the real template for the wrong-but-obvious names the runs used", async () => {
    const def = toolDef("ops.template")!;
    const ctx = toolCtx();
    for (const [wrong, right] of [["add_symbol", "place_component"], ["add_hierarchical_pin", "add_sheet_pin"], ["Add Symbol", "place_component"]] as const) {
      const r = await executeTool(def, { op: wrong }, ctx);
      expect(r.ok, `${wrong} -> ${right}`).toBe(true);
      expect((r.data as { op: string }).op).toBe(right);
    }
  });
  it("still fails for a name with no equivalent, so the engine's remediation is what recovers it", async () => {
    const r = await executeTool(toolDef("ops.template")!, { op: "create_root_schematic" }, toolCtx());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("OP_UNKNOWN");
  });
});

describe("closeAllowedOps power family", () => {
  it("a placement-only envelope gains the rail ops", () => {
    const out = closeAllowedOps(["place_array"]);
    for (const o of ["place_power_port", "place_gnd", "place_vcc", "place_pwr_flag"]) expect(out).toContain(o);
  });
  it("an envelope without placement does not gain rail ports", () => {
    const out = closeAllowedOps(["set_component_parameters"]);
    expect(out).not.toContain("place_gnd");
  });
});

// Two identical local labels 450 mil apart inside one group is how a real run drew a connection it
// should have drawn as a wire (LED_A on the resistor, LED_A on the LED). Legal, unreadable: a
// warning on the way back from ops.validate / sch.dryrun_scratch, never a refusal (red line 6).
describe("op-list drawing warnings", () => {
  const label = (name: string, at: unknown, group = "led", extra: Record<string, unknown> = {}) => ({ op: "add_net_label", name, at, group, ...extra });
  it("warns about a label pair standing in for a wire inside one group", () => {
    const w = oplistWarnings({ ops: [label("LED_A", [1000, 1000]), label("LED_A", [1450, 1000])] });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("LED_A");
    expect(w[0]).toContain("connect_and_label");
  });
  it("stays quiet where a label pair is the right drawing", () => {
    // Far apart: that pair is how the net crosses the sheet.
    expect(oplistWarnings({ ops: [label("SPI_SCK", [1000, 1000]), label("SPI_SCK", [4000, 3000])] })).toEqual([]);
    // Different groups, one name each, and global / hierarchical scope are all fine.
    expect(oplistWarnings({ ops: [label("UART_TX", "U1.2"), label("UART_TX", "J1.3", "conn")] })).toEqual([]);
    expect(oplistWarnings({ ops: [label("VBUS_SENSE", "U1.2"), label("VBUS_SENSE", "J1.3", "led", { scope: "global" })] })).toEqual([]);
    expect(oplistWarnings({ ops: [label("A", "U1.2"), label("B", "U1.3")] })).toEqual([]);
    expect(oplistWarnings(null)).toEqual([]);
  });
  it("warns on a pin-anchored pair in one group, where the pins are neighbours by construction", () => {
    expect(oplistWarnings({ ops: [label("LED_A", "R4.2"), label("LED_A", "D1.2")] })).toHaveLength(1);
  });
});
