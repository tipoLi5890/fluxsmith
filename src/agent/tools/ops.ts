// SPDX-License-Identifier: Apache-2.0
// Op vocabulary of opspec v1 (mirror of `crates/sch-ops` CORE_OPS / MACRO_OPS;
// `fluxsmith-cli capabilities` is the source of truth). Used to validate the
// `allowed_ops` a turn declares and to teach the model the exact names.
export const CORE_OPS = [
  "place_component", "delete_component", "delete_object", "move_component", "set_component_transform",
  "set_component_parameters", "set_component_attributes", "add_wire", "route_net", "add_junction", "add_no_connect",
  "add_net_label", "place_power_port", "place_gnd", "place_vcc", "rename_net", "add_bus", "add_bus_entry", "add_text",
  "add_rectangle", "add_text_box", "add_sheet", "add_sheet_pin", "delete_sheet_pin", "resize_sheet", "set_title_block",
] as const;
export const MACRO_OPS = [
  "place_divider", "place_decoupling", "place_pullup", "place_led_indicator", "place_rc_filter", "place_crystal",
  "place_array", "connect_and_label", "place_pwr_flag", "terminate_unused_unit", "arrange_group",
] as const;
export const ALL_OPS: readonly string[] = [...CORE_OPS, ...MACRO_OPS];
export const PROTOCOL_VERSION = 1;

export function isKnownOp(name: string): boolean {
  return ALL_OPS.includes(name);
}

/**
 * The three ops whose `sheet` field names a hierarchical sheet *symbol* (its `Sheetname` property), not a
 * sheet file: the engine routes them to a file with `in_sheet` instead (mirror of the `sheet_symbol_op`
 * branch in `crates/sch-ops`). Wherever the harness reads the sheet *file* of an op it must use
 * `opSheetRef`, never `op.sheet`.
 */
export const SHEET_SYMBOL_OPS: ReadonlySet<string> = new Set(["add_sheet_pin", "delete_sheet_pin", "resize_sheet"]);

/**
 * The envelope routing key (a sheet file, or its alias in the `sheets` envelope) an op names, or undefined
 * when the op lands on the apply target: `sheet` for every ordinary op, `in_sheet` for the sheet-symbol ops.
 */
export function opSheetRef(op: Record<string, unknown> | null | undefined): string | undefined {
  if (!op || typeof op !== "object") return undefined;
  const v = SHEET_SYMBOL_OPS.has(String(op.op ?? "")) ? op.in_sheet : op.sheet;
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Core ops a macro may expand into (the engine checks the *expanded* op-list against
 * `allowed_ops`, so an envelope that allows `place_gnd` must also allow `place_power_port`).
 * Conservative: lists every core op the macro can emit in any branch.
 */
const MACRO_EXPANSION: Record<string, readonly string[]> = {
  place_divider: ["place_component", "add_net_label", "route_net", "add_wire", "add_junction", "place_power_port"],
  place_decoupling: ["place_component", "add_net_label", "route_net", "add_wire", "add_junction", "place_power_port"],
  place_pullup: ["place_component", "add_net_label", "route_net", "add_wire", "add_junction", "place_power_port"],
  place_led_indicator: ["place_component", "add_net_label", "route_net", "add_wire", "add_junction", "place_power_port"],
  place_rc_filter: ["place_component", "add_net_label", "route_net", "add_wire", "add_junction", "place_power_port"],
  place_crystal: ["place_component", "add_net_label", "route_net", "add_wire", "add_junction", "place_power_port"],
  place_array: ["place_component", "add_net_label", "place_power_port"],
  connect_and_label: ["add_net_label", "route_net", "add_wire", "add_junction"],
  place_pwr_flag: ["place_power_port"],
  place_gnd: ["place_power_port"],
  place_vcc: ["place_power_port"],
  terminate_unused_unit: ["add_no_connect", "place_component", "place_power_port"],
  arrange_group: ["move_component"],
};
/** Allowing any one power-port spelling allows the family (a rail always needs its flag and its port). */
const POWER_FAMILY = ["place_power_port", "place_gnd", "place_vcc", "place_pwr_flag"] as const;

/**
 * Close an `allowed_ops` list under macro expansion and the power-port family. An empty list
 * (unrestricted) stays empty. Idempotent; order-stable (input order, then additions).
 */
export function closeAllowedOps(allowed: readonly string[]): string[] {
  if (!allowed.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (o: string) => { if (!seen.has(o)) { seen.add(o); out.push(o); } };
  for (const o of allowed) push(o);
  for (const o of allowed) for (const e of MACRO_EXPANSION[o] ?? []) push(e);
  // The family closes over the expanded list too: a macro that emits place_power_port (every rail macro) lets
  // the model also spell it place_gnd / place_vcc / place_pwr_flag without a scope card.
  if (out.some((o) => (POWER_FAMILY as readonly string[]).includes(o))) for (const o of POWER_FAMILY) push(o);
  // Anything that places parts needs rails to finish the circuit: an envelope that allows a placement op (or a
  // placement macro such as place_array, whose expansion carries no rail) also allows the power family. The
  // component budget still bounds the turn; power symbols never count against it. Without this a model that
  // declared only `place_array` found place_gnd refused and gave up on the whole task (golden resistor_array).
  if (out.some((o) => o.startsWith("place_") && !(POWER_FAMILY as readonly string[]).includes(o))) for (const o of POWER_FAMILY) push(o);
  // The harness's own repairs after a writing turn (ercfix flags / no-connects / duplicate-label deletes, the
  // title block) must be inside every effective envelope, or Rust and P2 refuse the harness's own call.
  for (const o of HARNESS_OPS) push(o);
  return out;
}

/** Ops the harness itself applies (ercfix, title block); never widen component budgets. */
export const HARNESS_OPS = ["place_pwr_flag", "add_no_connect", "delete_object", "set_title_block"] as const;

/** Fill `protocol_version` when a drafter forgot it (the engine requires it). */
export function withProtocol(oplist: unknown, sheets?: readonly KnownSheet[]): unknown {
  return normalizeOplist(oplist, sheets);
}

/**
 * A sheet the project has, as the engine's own summary reports it: the file, the instance path it is
 * placed at (`/power/`) and the sheet-symbol names that reach it. A bare string is just the file.
 */
export type KnownSheet = string | { file: string; instance_path?: string | null; names?: readonly string[] | null };

const sheetFileOf = (s: KnownSheet): string => (typeof s === "string" ? s : String(s?.file ?? ""));
/** `power.kicad_sch` / `/power/` / `sheets/power` -> `power`; the last non-empty path segment, unsuffixed. */
function sheetStem(v: string): string {
  const seg = v.split("/").filter(Boolean);
  return (seg[seg.length - 1] ?? "").replace(/\.kicad_sch$/i, "").toLowerCase();
}

/**
 * The project file an op's `sheet` / `in_sheet` names, when it is not already one.
 *
 * The engine reports findings with `file: "power.kicad_sch"` *and* `sheet: "/power/"` (the instance
 * path), and models copy the instance path straight into the op they write back — real run 18 turn 3
 * lost a whole `dryrun_scratch` to `PATH_OUT_OF_SCOPE /power/ is outside the project`. An instance
 * path, a sheet-symbol name or a bare stem is mapped onto the file the engine summary pairs it with;
 * anything ambiguous or unknown is returned undefined and left for the engine to refuse, because a
 * guess here would silently write to the wrong sheet.
 *
 * The order is by trust, not by convenience. A file and an instance path are structure the engine
 * computed; `names` is the `Sheetname` property, free text out of the `.kicad_sch` (red line 21), so
 * it only routes an op when it is unambiguous *and* no file of its own is called that — a sheet
 * symbol named `power` drawn on `analog.kicad_sch` must not capture `{"sheet": "power"}` from the
 * project's real `power.kicad_sch`.
 */
export function resolveSheetRef(ref: string, sheets: readonly KnownSheet[] = []): string | undefined {
  const v = String(ref ?? "").trim();
  if (!v || !sheets.length) return undefined;
  const files = sheets.map(sheetFileOf).filter(Boolean);
  if (files.includes(v)) return undefined;
  // The root sheet is the engine's `/`, and the summary lists it first.
  if (v === "/") return files[0];
  // 1. Instance path: the engine's own address for a sheet placement.
  for (const s of sheets) {
    if (typeof s === "string") continue;
    const path = String(s.instance_path ?? "").trim();
    if (path && (path === v || path.replace(/\/+$/, "") === v.replace(/\/+$/, ""))) return sheetFileOf(s);
  }
  const stem = sheetStem(v);
  if (!stem) return undefined;
  // 2. A project file with that stem always wins over a sheet-symbol name that spells it.
  const byFile = files.filter((f) => sheetStem(f) === stem);
  if (byFile.length === 1) return byFile[0] !== v ? byFile[0] : undefined;
  if (byFile.length > 1) return undefined;
  // 3. Untrusted `Sheetname`: only when exactly one sheet in the project carries it.
  const byName = [...new Set(sheets.filter((s) => typeof s !== "string" && (s.names ?? []).some((n) => String(n) === v)).map(sheetFileOf).filter(Boolean))];
  return byName.length === 1 ? byName[0] : undefined;
}

/**
 * Repair the recurring shape mistakes before the engine sees the op-list:
 * a bare array becomes {ops}, `groups` given as an array becomes a map keyed
 * by id/name, a group without `origin_mil` gets the region's min corner (or
 * [0,0]), numeric strings become numbers, {x,y} points become [x,y].
 *
 * `sheets` is the project's own sheet list (files, instance paths, sheet-symbol names) when the caller
 * has it: an op routed to `/power/` is then routed to `power.kicad_sch` instead (`resolveSheetRef`).
 */
export function normalizeOplist(input: unknown, sheets: readonly KnownSheet[] = []): unknown {
  if (Array.isArray(input)) input = { ops: input };
  if (!input || typeof input !== "object") return input;
  const o = { ...(coercePoints(input) as Record<string, unknown>) };
  if (o.ops === undefined && Array.isArray(o.operations)) o.ops = o.operations;
  const pv = o.protocol_version;
  o.protocol_version = typeof pv === "number" ? pv : PROTOCOL_VERSION;
  if (Array.isArray(o.groups)) {
    const m: Record<string, unknown> = {};
    for (const g of o.groups as Record<string, unknown>[]) { const id = String(g.id ?? g.name ?? g.group ?? `g${Object.keys(m).length + 1}`); m[id] = g; }
    o.groups = m;
  }
  if (o.groups && typeof o.groups === "object") {
    const gm = { ...(o.groups as Record<string, Record<string, unknown>>) };
    for (const [k, g0] of Object.entries(gm)) {
      const g = { ...(g0 ?? {}) };
      if (g.origin_mil === undefined && g.origin !== undefined) g.origin_mil = g.origin;
      if (g.region_mil === undefined && g.region !== undefined) g.region_mil = g.region;
      if (!Array.isArray(g.origin_mil)) {
        const r = g.region_mil as number[][] | undefined;
        g.origin_mil = Array.isArray(r) && Array.isArray(r[0]) ? [r[0][0], r[0][1]] : [0, 0];
      }
      gm[k] = g;
    }
    o.groups = gm;
  }
  if (Array.isArray(o.ops)) {
    o.ops = (o.ops as Record<string, unknown>[]).map((op) => {
      const p = { ...op };
      const authored = typeof p.op === "string" ? p.op : typeof p.type === "string" ? (p.type as string) : "";
      if (typeof p.op === "string") p.op = canonicalOpName(p.op);
      else if (typeof p.type === "string" && p.op === undefined) { p.op = canonicalOpName(p.type as string); delete p.type; }
      if (SCOPED_OPS.has(String(p.op)) && typeof p.scope === "string") p.scope = canonicalScope(p.scope);
      // `add_global_label` / `add_hier_label` are `add_net_label` with a scope: the authored name is the
      // only place that scope was stated, so dropping the name without setting `scope` would silently make
      // the label local (the engine defaults to Scope::Local) and a cross-sheet interface would never join.
      const implied = impliedScope(authored);
      if (implied && p.op === "add_net_label") {
        const explicit = typeof p.scope === "string" ? p.scope : "";
        // An explicit scope is the author's word and wins; the disagreement rides along as a note so it is
        // visible in ops.expand instead of being resolved in silence.
        if (!explicit) p.scope = implied;
        else if (explicit !== implied) p.note = `${p.note ? `${String(p.note)}; ` : ""}scope "${explicit}" kept over the ${authored} alias`;
      }
      for (const k of ["x_mil", "y_mil", "rotation", "unit", "spacing_mil", "pitch_mil", "count", "offset"]) {
        const v = p[k];
        if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) p[k] = Number(v);
      }
      if (Array.isArray(p.x_mil) && p.y_mil === undefined && (p.x_mil as unknown[]).length === 2) { const [x, y] = p.x_mil as number[]; p.x_mil = x; p.y_mil = y; }
      if (Array.isArray(p.at_mil) && p.x_mil === undefined) { const [x, y] = p.at_mil as number[]; p.x_mil = x; p.y_mil = y; delete p.at_mil; }
      if (typeof p.unit === "number" && !Number.isInteger(p.unit)) p.unit = Math.round(p.unit as number);
      // Engine net names carry no sheet prefix in ops: "/UART_TX" (as sch.nets prints local nets) is "UART_TX".
      for (const k of ["net", "net_name", "power_net", "gnd_net", "old_name", "new_name"]) {
        const v = p[k];
        if (typeof v === "string" && /^\/[^/]+$/.test(v)) p[k] = v.slice(1);
      }
      if ((p.op === "add_net_label" || p.op === "connect_and_label" || p.op === "route_net") && typeof p.name === "string" && /^\/[^/]+$/.test(p.name)) p.name = p.name.slice(1);
      // Only the routing field is remapped: `sheet` on a sheet-symbol op is the symbol's own name, a
      // required field, and never a file (SHEET_SYMBOL_OPS).
      const route = SHEET_SYMBOL_OPS.has(String(p.op)) ? "in_sheet" : "sheet";
      if (typeof p[route] === "string") {
        const file = resolveSheetRef(p[route] as string, sheets);
        if (file) p[route] = file;
      }
      return p;
    });
  }
  // An op that routes to another file needs that alias declared in the `sheets` envelope (alias -> file);
  // declare it for them, and turn an array of files into the map the engine expects. Runs after the op
  // names are canonical, because the routing field differs per op: `sheet` normally, `in_sheet` for the
  // sheet-symbol ops, whose `sheet` is a sheet symbol name and never a file (see SHEET_SYMBOL_OPS).
  if (Array.isArray(o.ops)) {
    const declared: Record<string, string> = {};
    if (Array.isArray(o.sheets)) for (const f of o.sheets as unknown[]) if (typeof f === "string" && f) declared[f] = f;
    else if (o.sheets && typeof o.sheets === "object") for (const [k, v] of Object.entries(o.sheets as unknown as Record<string, unknown>)) declared[k] = typeof v === "string" ? v : k;
    let touched = Array.isArray(o.sheets);
    for (const op of o.ops as Record<string, unknown>[]) {
      const sh = opSheetRef(op);
      if (sh && !(sh in declared)) { declared[sh] = sh; touched = true; }
    }
    if (touched) o.sheets = declared;
  }
  return o;
}

/** Wrong-but-obvious op names the models keep producing, mapped to the real vocabulary. */
const OP_ALIASES: Record<string, string> = {
  add_decoupling: "place_decoupling", decoupling: "place_decoupling", add_decoupling_cap: "place_decoupling",
  add_power_port: "place_power_port", power_port: "place_power_port", add_power: "place_power_port",
  add_gnd: "place_gnd", gnd: "place_gnd", ground: "place_gnd", add_ground: "place_gnd",
  add_vcc: "place_vcc", vcc: "place_vcc",
  add_component: "place_component", place_symbol: "place_component", add_symbol: "place_component", component: "place_component",
  add_label: "add_net_label", place_label: "add_net_label", place_net_label: "add_net_label", label: "add_net_label", net_label: "add_net_label",
  add_global_label: "add_net_label", place_global_label: "add_net_label", global_label: "add_net_label",
  add_hier_label: "add_net_label", add_hierarchical_label: "add_net_label", place_hier_label: "add_net_label",
  hier_label: "add_net_label", hierarchical_label: "add_net_label",
  wire: "add_wire", add_wires: "add_wire", route: "route_net", connect: "route_net",
  junction: "add_junction", no_connect: "add_no_connect", add_nc: "add_no_connect",
  add_pwr_flag: "place_pwr_flag", pwr_flag: "place_pwr_flag",
  add_led: "place_led_indicator", place_led: "place_led_indicator", led_indicator: "place_led_indicator",
  add_crystal: "place_crystal", crystal: "place_crystal",
  remove_component: "delete_component", delete_symbol: "delete_component",
  set_parameters: "set_component_parameters", set_component_params: "set_component_parameters", set_value: "set_component_parameters",
  set_symbol_value: "set_component_parameters", set_symbol_footprint: "set_component_parameters", set_footprint: "set_component_parameters",
  set_attributes: "set_component_attributes",
  add_hierarchical_pin: "add_sheet_pin", add_hier_pin: "add_sheet_pin", add_sheet_pins: "add_sheet_pin",
  create_hierarchical_sheet: "add_sheet", add_hierarchical_sheet: "add_sheet", create_sheet: "add_sheet",
  text: "add_text", rectangle: "add_rectangle", add_rect: "add_rectangle", title_block: "set_title_block",
};
export function canonicalOpName(name: string): string {
  const n = normalizedName(name);
  if ((ALL_OPS as readonly string[]).includes(n)) return n;
  return OP_ALIASES[n] ?? name;
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Aliases of `add_net_label` whose name carries the label scope. `add_global_label` and
 * `add_hier_label` are not ops (opspec v1 has one label op with a `scope` field), but they are
 * what the models write, what several remediation texts used to name, and what a human reading
 * a KiCad menu expects — so the name is mapped and the scope it states is kept.
 */
const ALIAS_SCOPE: Record<string, "global" | "hierarchical"> = {
  add_global_label: "global", place_global_label: "global", global_label: "global",
  add_hier_label: "hierarchical", add_hierarchical_label: "hierarchical", place_hier_label: "hierarchical",
  hier_label: "hierarchical", hierarchical_label: "hierarchical",
};

/** The label scope an authored op name implies, or undefined when the name says nothing about scope. */
export function impliedScope(name: string): "global" | "hierarchical" | undefined {
  return ALIAS_SCOPE[normalizedName(name)];
}

/** Ops that take a label `scope` (the engine accepts local/global/hierarchical, exactly). */
const SCOPED_OPS: ReadonlySet<string> = new Set(["add_net_label", "route_net", "connect_and_label", "rename_net"]);
/** Spellings of `scope` the engine refuses, mapped onto the three it accepts. */
export function canonicalScope(scope: string): string {
  const s = normalizedName(scope);
  if (s === "hier" || s === "hierarchy" || s === "hierarchic" || s === "hier_label" || s === "hierarchical_label") return "hierarchical";
  if (s === "glob" || s === "global_label") return "global";
  if (s === "sheet" || s === "sheet_local" || s === "local_label") return "local";
  return s;
}

const POINT_KEYS = new Set(["origin_mil", "at", "start", "end", "size", "pitch"]);
const BOX_KEYS = new Set(["region_mil", "between"]);
/** Models often write points as {x, y} or boxes as {x0,y0,x1,y1}; the engine wants arrays. */
export function coercePoints(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(coercePoints);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (POINT_KEYS.has(k) && val && typeof val === "object" && !Array.isArray(val) && "x" in (val as object) && "y" in (val as object)) {
      const p = val as { x: number; y: number }; out[k] = [p.x, p.y]; continue;
    }
    if (BOX_KEYS.has(k) && val && typeof val === "object" && !Array.isArray(val)) {
      const b = val as Record<string, number>;
      if ("x0" in b) { out[k] = [[b.x0, b.y0], [b.x1, b.y1]]; continue; }
      if ("min" in b || "max" in b) { const mn = b.min as unknown as number[]; const mx = b.max as unknown as number[]; out[k] = [mn, mx]; continue; }
    }
    if (BOX_KEYS.has(k) && Array.isArray(val) && val.length === 4 && val.every((n) => typeof n === "number")) { out[k] = [[val[0], val[1]], [val[2], val[3]]]; continue; }
    out[k] = coercePoints(val);
  }
  return out;
}

/** How far apart two pins may be and still be joined with a wire instead of a pair of labels (mil). */
export const LABEL_PAIR_MIL = 500;

/**
 * Advisory warnings the harness can read off an op-list without the engine (`ops.validate` and
 * `sch.dryrun_scratch` append them to their result). Warnings only: nothing here refuses an op-list,
 * because the verdict on a circuit is the engine's alone (red line 6).
 *
 * Today there is one rule. Two identical local labels inside one group are how a Drafter draws a
 * connection it should have drawn as a wire — a real run left `LED_A` on the resistor and `LED_A` on
 * the LED 450 mil apart, which is a legal net and an unreadable schematic. A label pair is for a net
 * that crosses the sheet; two pins this close in one block are joined with `connect_and_label`.
 */
export function oplistWarnings(oplist: unknown): string[] {
  const ops = (oplist as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return [];
  // group -> label name -> the `at` values it was placed on.
  const seen = new Map<string, Map<string, unknown[]>>();
  for (const raw of ops) {
    const op = raw as Record<string, unknown> | null;
    if (!op || canonicalOpName(String(op.op ?? "")) !== "add_net_label") continue;
    const scope = canonicalScope(String(op.scope ?? "local"));
    if (scope !== "local") continue; // a global / hierarchical pair is exactly how a net crosses a sheet
    const name = String(op.name ?? op.net ?? op.text ?? "").trim();
    const group = String(op.group ?? "");
    if (!name || !group) continue;
    const byName = seen.get(group) ?? new Map<string, unknown[]>();
    byName.set(name, [...(byName.get(name) ?? []), op.at]);
    seen.set(group, byName);
  }
  const out: string[] = [];
  for (const [group, byName] of seen) {
    for (const [name, ats] of byName) {
      if (ats.length < 2) continue;
      // Points are compared; a pin reference ("R1.2") carries no coordinate, and two pins in one
      // group are near each other by construction, so those are reported without a distance.
      const pts = ats.filter((a): a is [number, number] => Array.isArray(a) && a.length === 2 && a.every((n) => typeof n === "number"));
      if (pts.length === ats.length && !pts.some((a, i) => pts.slice(i + 1).some((b) => Math.abs(a[0] - b[0]) <= LABEL_PAIR_MIL && Math.abs(a[1] - b[1]) <= LABEL_PAIR_MIL))) continue;
      out.push(`${ats.length} local labels named ${name} in group ${group}: two pins this close are joined with connect_and_label (a wire); a label pair is for a net that leaves the block`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural envelope entries
// ---------------------------------------------------------------------------

/**
 * A structural envelope entry is a verb, optionally qualified by the sheet file it acts on:
 * `create_sheet:power.kicad_sch`, `add_sheet:power.kicad_sch`, `delete_component`. The ceiling
 * always writes the qualified form (the file is the whole point of the bound); a model writing its
 * own `turn.begin` declaration often writes the bare verb, because the file is already in `sheets`
 * and in the human's message.
 */
export function structuralParts(entry: string): { verb: string; file: string | null } {
  const i = String(entry ?? "").indexOf(":");
  return i < 0 ? { verb: String(entry ?? "").trim(), file: null } : { verb: entry.slice(0, i).trim(), file: entry.slice(i + 1).trim() || null };
}

/**
 * The ceiling entries one requested structural entry is satisfied by, or `[]` when the ceiling does
 * not permit it. A bare verb is satisfied by every qualified ceiling entry with the same verb — the
 * ceiling is the non-model bound, so anything inside it is already permitted and a declaration that
 * omits the file has simply not narrowed by file (red line 13: the model's own under-declaration is
 * not a human decision). A qualified entry is satisfied by the same verb on the same file, compared
 * the way Rust's `sheet_matches` compares them ([sheetMatches]): by project-relative path, so
 * `power.kicad_sch` does not cover `sub/power.kicad_sch`.
 *
 * Returning the *ceiling's* entries (never the request) is what keeps this from widening anything:
 * the effective envelope only ever holds strings the ceiling itself carries.
 */
export function structuralSatisfiedBy(ceiling: readonly string[], entry: string): string[] {
  if (ceiling.includes(entry)) return [entry];
  const want = structuralParts(entry);
  if (!want.verb) return [];
  return ceiling.filter((c) => {
    const have = structuralParts(c);
    if (have.verb !== want.verb) return false;
    if (want.file === null) return true;
    if (have.file === null) return true;
    return sheetMatches(have.file, want.file);
  });
}

/**
 * Project-relative path segments of a sheet reference, with the `.kicad_sch` suffix off the last one:
 * `power`, `power.kicad_sch` and the instance path `/power/` all give `["power"]`, while
 * `sub/power.kicad_sch` gives `["sub", "power"]`. Mirrors `sheet_segments` in `src-tauri/src/session.rs`.
 */
function sheetSegments(v: string): string[] {
  const seg = String(v ?? "").split(/[\\/]/).filter(Boolean);
  if (seg.length) seg[seg.length - 1] = seg[seg.length - 1].replace(/\.kicad_sch$/, "");
  return seg;
}

/**
 * Do two sheet references name the same file? Mirrors Rust `sheet_matches` (`src-tauri/src/session.rs`),
 * the second check every envelope decision goes through, so the hook and Rust agree: once either side
 * carries a directory the whole project-relative path has to match — comparing stems alone let an
 * envelope that approved `power.kicad_sch` authorise a write to `sub/power.kicad_sch`, a different
 * file the human never saw. Two bare entries compare by stem (`power` is `power.kicad_sch`).
 */
export function sheetMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const x = sheetSegments(a);
  const y = sheetSegments(b);
  if (!x.length || !y.length) return false;
  if (x.length > 1 || y.length > 1) return x.length === y.length && x.every((s, i) => s === y[i]);
  return x[0] === y[0];
}

/** Is this structural entry inside the ceiling at all? */
export function structuralAllowed(ceiling: readonly string[], entry: string): boolean {
  return structuralSatisfiedBy(ceiling, entry).length > 0;
}

/**
 * Rewrite a declaration's structural entries into the ceiling's own spelling: a bare `create_sheet`
 * becomes the ceiling's `create_sheet:power.kicad_sch` (plus its `add_sheet:` twin, which is the
 * same action under the other name). Entries the ceiling does not carry are kept verbatim so
 * `intersectEnvelope` still reports them as a widening. Order-stable, deduplicated.
 */
export function qualifyStructural(entries: readonly string[], ceiling: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (x: string) => { if (x && !seen.has(x)) { seen.add(x); out.push(x); } };
  for (const e of entries) {
    const hits = structuralSatisfiedBy(ceiling, e);
    if (hits.length) for (const h of hits) push(h); else push(e);
  }
  return out;
}
