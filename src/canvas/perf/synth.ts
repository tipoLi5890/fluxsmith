// SPDX-License-Identifier: Apache-2.0
// Deterministic synthetic sheet for perf tests (S-E7 profile: 1,000 symbols / 5,000 wires).
// Pure: no DOM, no fs. Generated at test time, never committed as JSON.

import type { Mil, RPin, RShape, RSymbol, RText, RenderSheet } from "../types";
import { MM_TO_MIL } from "../types";

export interface SynthOptions {
  components?: number;
  wires?: number;
  junctions?: number;
  labels?: number;
  seed?: number;
}

/** Small deterministic LCG (Numerical Recipes constants). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function uuidOf(prefix: string, i: number): string {
  const h = i.toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${h}`;
}

/** Resistor-like two-pin body: rectangle + two 100 mil stubs + reference/value texts. */
function passive(i: number, at: Mil, rng: () => number): RSymbol {
  const [x, y] = at;
  const rect: RShape = { kind: "rectangle", a: [x - 40, y - 100], b: [x + 40, y + 100], stroke: { width_mil: 0, style: "default" }, fill: "background" };
  const pins: RPin[] = [
    { number: "1", name: "~", electrical: "passive", shape: "line", at: [x, y - 200], end: [x, y - 100], dir: [0, 1], length_mil: 100, hide: false, name_hidden: false, number_hidden: false, name_size_mil: 50, number_size_mil: 50, name_offset_mil: 0 },
    { number: "2", name: "~", electrical: "passive", shape: "line", at: [x, y + 200], end: [x, y + 100], dir: [0, -1], length_mil: 100, hide: false, name_hidden: false, number_hidden: false, name_size_mil: 50, number_size_mil: 50, name_offset_mil: 0 },
  ];
  const value = `${Math.round(rng() * 99) + 1}k`;
  const texts: RText[] = [
    { text: `R${i + 1}`, at: [x + 60, y - 30], rotation: 0, size_mil: 50, justify_h: "left", justify_v: "center", bold: false, italic: false, hide: false, role: "reference" },
    { text: value, at: [x + 60, y + 30], rotation: 0, size_mil: 50, justify_h: "left", justify_v: "center", bold: false, italic: false, hide: false, role: "value" },
    { text: "Resistor_SMD:R_0402", at: [x, y], rotation: 0, size_mil: 50, justify_h: "center", justify_v: "center", bold: false, italic: false, hide: true, role: "footprint" },
  ];
  return {
    reference: `R${i + 1}`, value, uuid: uuidOf("aaaaaaaa", i), lib_id: "Device:R", unit: 1, dnp: false, is_power: false, at, rotation: 0, mirror: "none",
    shapes: [rect], pins, texts, bbox: [[x - 40, y - 200], [x + 40, y + 200]], unresolved: false,
  };
}

/**
 * Tile `components` passives on a 1000 mil grid inside an A1 paper, connect neighbours with
 * `wires` two-point segments, drop `junctions` at wire meets and `labels` on a subset of
 * pins. Same options + seed always give the same sheet.
 */
export function synthSheet(o: SynthOptions = {}): RenderSheet {
  const nComp = o.components ?? 1000;
  const nWires = o.wires ?? 5000;
  const nJunc = o.junctions ?? 1200;
  const nLabels = o.labels ?? 300;
  const rng = lcg(o.seed ?? 42);
  const paper: [number, number] = [841, 594];
  const cols = Math.max(1, Math.ceil(Math.sqrt(nComp * (paper[0] / paper[1]))));
  const pitch = 1000;
  const origin: Mil = [1500, 1500];
  const symbols: RSymbol[] = [];
  for (let i = 0; i < nComp; i++) {
    const cx = origin[0] + (i % cols) * pitch;
    const cy = origin[1] + Math.floor(i / cols) * pitch;
    symbols.push(passive(i, [cx, cy], rng));
  }
  const wires: RenderSheet["wires"] = [];
  for (let i = 0; i < nWires; i++) {
    const s = symbols[i % symbols.length];
    const from: Mil = i % 2 === 0 ? s.pins[1].at : s.pins[0].at;
    const len = 100 + Math.round(rng() * 6) * 100;
    const horizontal = rng() < 0.5;
    const to: Mil = horizontal ? [from[0] + len, from[1]] : [from[0], from[1] + (i % 2 === 0 ? len : -len)];
    wires.push({ uuid: uuidOf("bbbbbbbb", i), a: from, b: to, is_bus: i % 25 === 0, stroke: { width_mil: 0, style: i % 25 === 0 ? "dash" : "default" } });
  }
  const junctions: RenderSheet["junctions"] = [];
  for (let i = 0; i < nJunc; i++) {
    const w = wires[(i * 4) % Math.max(1, wires.length)];
    if (w) junctions.push({ uuid: uuidOf("cccccccc", i), at: w.b, diameter_mil: 36 });
  }
  const labels: RenderSheet["labels"] = [];
  for (let i = 0; i < nLabels; i++) {
    const s = symbols[(i * 10) % Math.max(1, symbols.length)];
    if (!s) break;
    const at = s.pins[0].at;
    const global = i % 3 === 0;
    const text = global ? `GLB_${i}` : `NET_${i}`;
    labels.push({ uuid: uuidOf("dddddddd", i), text, kind: global ? "global" : "local", shape: global ? "input" : "passive", at, rotation: 0, size_mil: 50, justify_h: "left", justify_v: "bottom", bbox: [[at[0], at[1] - 70], [at[0] + 50 * text.length * 0.8, at[1]]] });
  }
  const maxX = origin[0] + cols * pitch + 500;
  const maxY = origin[1] + Math.ceil(nComp / cols) * pitch + 500;
  return {
    sheet_path: "/", file: "synth.kicad_sch", paper: "A1", paper_mm: paper, title_block: { title: "synth" },
    symbols, wires, junctions, no_connects: [], bus_entries: [], labels, sheets: [], texts: [], text_boxes: [], graphics: [], images: [],
    bbox: [[0, 0], [Math.max(maxX, paper[0] * MM_TO_MIL), Math.max(maxY, paper[1] * MM_TO_MIL)]],
  };
}
