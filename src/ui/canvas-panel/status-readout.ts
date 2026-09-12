// SPDX-License-Identifier: Apache-2.0
// Text for the canvas status bar from a hit. Pure: returns i18n keys + params, the panel renders
// them as React text nodes, never as raw HTML. Net names come from the engine `net_map` only.

import type { Hit } from "../../canvas/hittest";
import type { MessageKey } from "../../i18n";
import type { NetMapResult } from "../../ipc/types";
import type { RenderSheet } from "../../canvas/types";

export interface Readout {
  key: MessageKey;
  params: Record<string, string | number>;
  /** Params whose value is itself a catalogue key (a localised enum name); resolved by `readoutParams`. */
  keyParams?: Record<string, MessageKey>;
}

/**
 * KiCad's pin electrical types, in the file's own spelling. A type the file spells some other way
 * has no key and is read out verbatim, like every other untrusted string.
 */
export const PIN_TYPE_KEYS: Record<string, MessageKey> = {
  input: "canvas.pinType.input",
  output: "canvas.pinType.output",
  bidirectional: "canvas.pinType.bidirectional",
  tri_state: "canvas.pinType.triState",
  passive: "canvas.pinType.passive",
  free: "canvas.pinType.free",
  unspecified: "canvas.pinType.unspecified",
  power_in: "canvas.pinType.powerIn",
  power_out: "canvas.pinType.powerOut",
  open_collector: "canvas.pinType.openCollector",
  open_emitter: "canvas.pinType.openEmitter",
  no_connect: "canvas.pinType.noConnect",
};

/** Params of a readout with its `keyParams` translated. The panel calls this before `t(r.key, ...)`. */
export function readoutParams(r: Readout, translate: (key: MessageKey) => string): Record<string, string | number> {
  if (!r.keyParams) return r.params;
  const out = { ...r.params };
  for (const [name, key] of Object.entries(r.keyParams)) out[name] = translate(key);
  return out;
}

function symbolOf(sheet: RenderSheet | null, uuid: string): RenderSheet["symbols"][number] | null {
  return sheet?.symbols.find((x) => x.uuid === uuid) ?? null;
}

function footprintOf(sheet: RenderSheet | null, reference: string): string | null {
  const s = sheet?.symbols.find((x) => x.reference === reference);
  const fp = s?.texts.find((t) => t.role === "footprint")?.text ?? "";
  return fp.trim() ? fp : null;
}

/**
 * One readout per hit kind, plus the lines an engineer checks before anything else: a symbol's
 * footprint, unit and DNP flag, and a pin's electrical type.
 */
export function describeHit(hit: Hit | null, sheet: RenderSheet | null, map: NetMapResult | null): Readout[] {
  if (!hit) return [];
  switch (hit.kind) {
    case "symbol": {
      const out: Readout[] = [{ key: "canvas.status.symbol", params: { ref: hit.reference, value: hit.value, lib: hit.lib_id } }];
      const fp = footprintOf(sheet, hit.reference);
      if (fp) out.push({ key: "canvas.status.footprint", params: { fp } });
      // Unit and DNP come from the engine geometry: a multi-unit part shows which unit this is, and
      // "do not populate" is the one field a reviewer must never miss.
      const sym = symbolOf(sheet, hit.uuid);
      if (sym && sym.unit > 1) out.push({ key: "canvas.status.unit", params: { n: sym.unit } });
      if (sym?.dnp) out.push({ key: "canvas.status.dnp", params: {} });
      return out;
    }
    case "pin": {
      const net = map?.pins[`${hit.reference}.${hit.number}`] ?? null;
      const out: Readout[] = [{ key: "canvas.status.pin", params: { ref: hit.reference, pin: hit.number, name: hit.name } }];
      out.push({ key: "canvas.status.pinType", params: { type: hit.electrical }, keyParams: PIN_TYPE_KEYS[hit.electrical] ? { type: PIN_TYPE_KEYS[hit.electrical] } : undefined });
      out.push(net ? { key: "canvas.status.net", params: { name: net } } : { key: "canvas.status.noNet", params: {} });
      return out;
    }
    case "wire": {
      const net = map?.wires[hit.uuid] ?? null;
      if (net) return [{ key: "canvas.status.net", params: { name: net } }];
      return [{ key: hit.is_bus ? "canvas.status.bus" : "canvas.status.wire", params: {} }];
    }
    case "label": {
      const key: MessageKey = hit.label_kind === "global" ? "canvas.status.label.global" : hit.label_kind === "hierarchical" ? "canvas.status.label.hierarchical" : "canvas.status.label.local";
      const out: Readout[] = [{ key, params: { text: hit.text } }];
      const net = map?.labels[hit.uuid] ?? null;
      if (net && net !== hit.text) out.push({ key: "canvas.status.net", params: { name: net } });
      return out;
    }
    case "sheet":
      return [{ key: "canvas.status.sheet", params: { name: hit.name, file: hit.file } }];
    case "sheet_pin": {
      // `shape` is the file's own direction enum (input / output / bidirectional / tri_state / passive):
      // shown as written, like any other file string.
      const net = map?.sheet_pins?.[hit.uuid] ?? null;
      const out: Readout[] = [{ key: "canvas.status.sheetPin", params: { name: hit.name, dir: hit.shape } }];
      out.push(net ? { key: "canvas.status.net", params: { name: net } } : { key: "canvas.status.noNet", params: {} });
      return out;
    }
    // A junction / no-connect flag names its net from the engine map — "Junction" on its own tells
    // an engineer nothing about what was joined.
    case "junction": {
      const net = map?.junctions?.[hit.uuid] ?? null;
      const out: Readout[] = [{ key: "canvas.status.junction", params: {} }];
      if (net) out.push({ key: "canvas.status.net", params: { name: net } });
      return out;
    }
    case "no_connect": {
      const net = map?.no_connects?.[hit.uuid] ?? null;
      const out: Readout[] = [{ key: "canvas.status.noConnect", params: {} }];
      if (net) out.push({ key: "canvas.status.net", params: { name: net } });
      return out;
    }
  }
}
