// SPDX-License-Identifier: Apache-2.0
// Deterministic ERC repairs (no model): the findings the engine reports with an anchor
// become the obvious op — a PWR_FLAG on an undriven rail, a no-connect on an unused IC
// pin, one copy of a duplicated label. Applied with `note: "ercfix"` (P12 whitelists it).

import type { Finding } from "./policy/types";

export const ERCFIX_NOTE = "ercfix";
export const ERCFIX_OPS = new Set(["place_pwr_flag", "add_no_connect", "delete_object"]);
/**
 * The codes `ercFixOps` below has an op for: a PWR_FLAG on an undriven rail, the deletion of a power
 * symbol that touches nothing, a no-connect on an unused IC pin. Whether a given row actually gets
 * one still depends on what the schematic says (`pwrFlagSource`, `IC_PREFIX`); the set answers the
 * weaker question the UI asks before the click — is this repair mechanical, or does it cost a model
 * round? (Duplicate labels are found by geometry, not by a code, so no code stands for them.)
 */
export const ERCFIX_CODES: ReadonlySet<string> = new Set(["ERC_POWER_IN_UNDRIVEN", "POWER_PORT_DANGLING", "PINMAP_UNCONNECTED"]);

export interface LabelRow { uuid?: string; name?: string; text?: string; at_mil?: [number, number]; x_mil?: number; y_mil?: number }

/** `REF.PIN` anchor of an ERC finding: the remediation ("place_pwr_flag at J1.1") wins, else refs[0]. */
export function anchorOf(f: Finding): string | null {
  const m = /\bat\s+([A-Za-z#]+\d+\.\S+)/.exec(f.remediation ?? "");
  if (m) return m[1];
  const r = (f.refs ?? []).find((x) => /^[A-Za-z]+\d+\.\S+$/.test(x));
  return r ?? null;
}

// Parts whose unused pins are legitimately left open: ICs, transistors, connectors and crystal cans. A
// passive or an LED with an open pin is a wiring error the no-connect must not paper over.
const IC_PREFIX = /^(U|IC|Q|J|Y)\d+$/i;

/** What `sch.component` says about a part on a finding's net (the fields the PWR_FLAG rule reads). */
export interface PartFacts { lib_id?: string; pins?: { number?: string; type?: string }[] }

// A PWR_FLAG is the engineer's assertion "this rail has a source ERC cannot see". It is only placed
// without a human when the schematic itself says where the source is: a connector pin (the supply
// comes in from outside the board) or a regulator/converter output pin the symbol did not type
// `power_out` (which is why ERC counted no driver). Anything else is left for the Fixer / the human.
const CONNECTOR_LIB = /(^|[/:_])conn(ector)?/i;
const SOURCE_LIB = /(^|[/:_])(regulator|converter|power_supply|battery)/i;
const SOURCE_PIN = /^(power_out|output|open_collector|open_emitter|tri_state)$/i;

const SINK_PIN = /^(passive|power_in|unspecified|free)$/i;
/** Ground-class rail names (leaf of the net name): GND, AGND, DGND, PGND, GND_ISO, VSS, VSSA... */
const GROUND_RAIL = /^(?:[adps]?gnd(?:[_a-z0-9]*)|vss[_a-z0-9]*|gndref)$/i;

/** Net name carried by an `erc:pwr:<net>` finding location, or null. */
function railOf(f: Finding): string | null {
  const m = /^erc:pwr:(.+)$/.exec(String(f.location ?? ""));
  if (!m) return null;
  const leaf = m[1].replace(/^.*\//, "");
  return leaf || null;
}

/**
 * The net member that justifies an automatic PWR_FLAG for `f`, or null when nothing does.
 *
 * Two grounds: (1) the schematic names the source (connector pin, regulator/converter output pin); (2) a
 * ground-class rail (GND / AGND / VSS ...) whose members are all sinks (passive / power_in, every member
 * known): ground is fed from outside any block the agent draws, KiCad flags it regardless, and no driver
 * conflict can arise now (a later real driver is reported by the engine and the Fixer removes the flag).
 * A supply rail with only sinks (an MCU VDD pin plus its capacitor) is left alone: that is a wiring gap
 * the human must see, not a flag to hide it.
 */
export function pwrFlagSource(f: Finding, parts: Record<string, PartFacts | undefined>): string | null {
  const refs = f.refs ?? [];
  const rail = railOf(f);
  // A supply rail that only feeds a regulator / converter input (plus its capacitors) is the block's own
  // input: it is fed from outside the drawing by construction, so the flag is placed. An upstream real
  // driver drawn later shows up as a power_out conflict and the Fixer removes the flag.
  const pinOf = (r: string) => {
    const dot = r.indexOf(".");
    const part = parts[dot > 0 ? r.slice(0, dot) : r];
    const pin = part ? (part.pins ?? []).find((p) => String(p.number ?? "") === (dot > 0 ? r.slice(dot + 1) : null)) : undefined;
    return { part, type: String(pin?.type ?? "") };
  };
  const converterInput = (r: string) => { const { part, type } = pinOf(r); return !!part && SOURCE_LIB.test(part.lib_id ?? "") && /^power_in$/i.test(type); };
  // Only when every other member is passive: an MCU supply pin on the same rail means a load whose source
  // is missing from the drawing, which must stay visible.
  const feedsConverterInput = refs.some(converterInput) && refs.every((r) => converterInput(r) || /^passive$/i.test(pinOf(r).type));
  let allSinks = refs.length > 0 && ((rail !== null && GROUND_RAIL.test(rail)) || feedsConverterInput);
  for (const r of refs) {
    const dot = r.indexOf(".");
    const ref = dot > 0 ? r.slice(0, dot) : r;
    const pinNo = dot > 0 ? r.slice(dot + 1) : null;
    const part = parts[ref];
    const pin = part ? (part.pins ?? []).find((p) => String(p.number ?? "") === pinNo) : undefined;
    if (!part || !pin || !SINK_PIN.test(String(pin.type ?? ""))) allSinks = false;
  }
  if (allSinks) return refs[0];
  for (const r of refs) {
    const dot = r.indexOf(".");
    const ref = dot > 0 ? r.slice(0, dot) : r;
    const pinNo = dot > 0 ? r.slice(dot + 1) : null;
    const part = parts[ref];
    if (!part) continue;
    const lib = part.lib_id ?? "";
    if (CONNECTOR_LIB.test(lib)) return r;
    if (SOURCE_LIB.test(lib)) {
      const pin = (part.pins ?? []).find((p) => String(p.number ?? "") === pinNo);
      if (pin && SOURCE_PIN.test(String(pin.type ?? ""))) return r;
    }
  }
  return null;
}

/**
 * `parts`: `sch.component` facts by reference for the members of the ERC findings. Without them no
 * PWR_FLAG is placed — the finding is left for the Fixer instead of guessing that a rail is driven.
 */
export function ercFixOps(findings: Finding[], labels: LabelRow[] = [], parts: Record<string, PartFacts | undefined> = {}): { protocol_version: 1; groups: Record<string, never>; ops: Record<string, unknown>[]; note: string } | null {
  const ops: Record<string, unknown>[] = [];
  const seenPins = new Set<string>();
  for (const f of findings) {
    if (f.code === "ERC_POWER_IN_UNDRIVEN") {
      const at = anchorOf(f);
      if (at && !seenPins.has(at) && pwrFlagSource(f, parts)) { seenPins.add(at); ops.push({ op: "place_pwr_flag", at }); }
    } else if (f.code === "POWER_PORT_DANGLING") {
      // A power symbol touching nothing: remove it (its uuid is in the location; power symbols are not counted as components).
      const uuid = /^erc:port_dangling:(.+)$/.exec(String(f.location ?? ""))?.[1];
      if (uuid && !seenPins.has(`del:${uuid}`)) { seenPins.add(`del:${uuid}`); ops.push({ op: "delete_object", uuid, kind: "power_port" }); }
    } else if (f.code === "PINMAP_UNCONNECTED") {
      const at = anchorOf(f);
      const ref = at?.split(".")[0] ?? "";
      if (at && IC_PREFIX.test(ref) && !seenPins.has(at)) { seenPins.add(at); ops.push({ op: "add_no_connect", pin: at }); }
    }
  }
  // Duplicate labels: same text at the same point — keep the first, delete the rest.
  const byKey = new Map<string, LabelRow[]>();
  for (const l of labels) {
    const text = l.name ?? l.text ?? "";
    const at = l.at_mil ?? (typeof l.x_mil === "number" && typeof l.y_mil === "number" ? [l.x_mil, l.y_mil] : null);
    if (!text || !at || !l.uuid) continue;
    const key = `${text}@${Math.round(at[0])},${Math.round(at[1])}`;
    const arr = byKey.get(key) ?? [];
    arr.push(l); byKey.set(key, arr);
  }
  for (const arr of byKey.values()) for (const dup of arr.slice(1)) ops.push({ op: "delete_object", uuid: dup.uuid, kind: "label" });
  if (ops.length === 0) return null;
  return { protocol_version: 1, groups: {}, ops, note: ERCFIX_NOTE };
}
