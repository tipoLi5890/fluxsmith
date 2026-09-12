// SPDX-License-Identifier: Apache-2.0
// Canvas 2D drawing of a `RenderSheet`, following eeschema drawing rules
// (pin stubs, label flags, junction dots, dashed buses, sheet symbols) with the
// KiCad palette from `--fs-canvas-*`. Two stages: `drawCommands()` is pure
// (testable in Node; text metrics are injected) and `paint()` executes commands
// on a context. Untrusted strings only ever reach `fillText`; no DOM is produced.
//
// Geometry ratios marked "kicad-cli 10.0.4" were read from `sch export svg` of a
// calibration sheet (AMS1117 + Conn_01x04 + every label shape), see
// docs/reviews/2026-09-03-canvas-fidelity.md.

import type { Mil, RLabel, RPin, RShape, RSheetSymbol, RSymbol, RText, RenderSheet } from "./types";
import { MM_TO_MIL } from "./types";
import { gridPitch, type ViewState } from "./viewport";
import type { Box } from "./types";
import { estimateWidthMil, KICAD_FONT_SCALE, type MeasureFn } from "./textmetrics";

/** Colour roles; mapped to CSS variables (`--fs-canvas-*`) at paint time. */
export type ColorRole =
  | "wire" | "bus" | "body" | "body_fill" | "pin" | "pin_text" | "reference" | "value" | "field" | "text"
  | "label" | "global_label" | "hier_label" | "sheet" | "sheet_fill" | "sheet_text" | "junction" | "noconnect"
  | "frame" | "grid" | "dnp" | "unresolved" | "paper"
  | "hover" | "finding_error" | "finding_warning" | "finding_info";

/** Owning sheet object (symbol / wire / label / ...) so `paint` can skip not-yet-revealed objects. */
interface Owned { uuid?: string }

export type Cmd =
  | ({ op: "path"; pts: Mil[]; close: boolean; stroke: ColorRole | null; fill: ColorRole | null; width: number; dash?: number[] } & Owned)
  | ({ op: "circle"; c: Mil; r: number; stroke: ColorRole | null; fill: ColorRole | null; width: number } & Owned)
  | ({ op: "arc"; c: Mil; r: number; a0: number; a1: number; ccw: boolean; stroke: ColorRole; width: number } & Owned)
  | ({ op: "text"; text: string; at: Mil; size: number; rotation: 0 | 90; hAlign: CanvasTextAlign; vAlign: CanvasTextBaseline; color: ColorRole; bold: boolean; italic: boolean; mono: boolean } & Owned);

/** Level of detail: `boxes` draws symbols as filled boxes without pins/text (far zoom). */
export type LodTier = "full" | "text-off" | "boxes";

export interface DrawOptions {
  /** Draw hidden property texts (developer density). */
  showHidden?: boolean;
  /** Draw the paper frame and title block. */
  frame?: boolean;
  /** Text width in mil (label flag length); defaults to the headless estimate. */
  measure?: MeasureFn;
  /** Level of detail (default `full`; `text-off` is decided at paint time by `minTextPx`). */
  lod?: LodTier;
}

/** LOD tier for a view scale: 50 mil (the smallest common text) under 4 px hides text, under 2 px boxes. */
export function lodTier(scale: number): LodTier {
  const px = 50 * scale * KICAD_FONT_SCALE;
  return px < 2 ? "boxes" : px < 4 ? "text-off" : "full";
}

const DEFAULT_LINE = 6; // mil, eeschema default line width
const WIRE_WIDTH = 6;
const BUS_WIDTH = 12;
/** eeschema `DEFAULT_NOCONNECT_SIZE` = 48 mil across. */
const NOCONNECT_HALF = 24;
/** DNP cross: twice the default line width. */
const DNP_WIDTH = 12;
// Pin text (kicad-cli 10.0.4, size 50 mil): the number baseline sits 0.2 x size above a
// horizontal stub (hidden text y = stub - 0.254 mm), a name *inside* the body starts exactly
// `pin_names offset` past the stub end with its baseline 0.5 x size below the pin line; with
// `offset 0` the name takes the number's place above the stub and the number moves below it
// (glyph top 0.24 x size under the line, baseline ~1.25 x size below).
const PIN_NUM_BASELINE = 0.2;
const PIN_BELOW_BASELINE = 1.25;
const PIN_NAME_INSIDE_BASELINE = 0.5;

function ptsOfBox(a: Mil, b: Mil): Mil[] {
  return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
}

function strokeWidth(w: number): number {
  return w > 0 ? w : DEFAULT_LINE;
}

function fillRole(fill: string, body: ColorRole = "body", bg: ColorRole = "body_fill"): ColorRole | null {
  switch (fill) {
    case "outline":
      return body;
    case "background":
    case "color":
      return bg;
    default:
      return null;
  }
}

/** eeschema dash patterns are line-width multiples: dash 12 w, gap 3 w, dot 1 w. */
function dashFor(style: string, width = DEFAULT_LINE): number[] | undefined {
  const w = width > 0 ? width : DEFAULT_LINE;
  switch (style) {
    case "dash":
      return [12 * w, 3 * w];
    case "dot":
      return [w, 3 * w];
    case "dash_dot":
      return [12 * w, 3 * w, w, 3 * w];
    case "dash_dot_dot":
      return [12 * w, 3 * w, w, 3 * w, w, 3 * w];
    default:
      return undefined;
  }
}

export function shapeCmds(s: RShape, bodyRole: ColorRole, out: Cmd[]): void {
  switch (s.kind) {
    case "polyline": {
      const close = s.pts.length > 2 && s.pts[0][0] === s.pts[s.pts.length - 1][0] && s.pts[0][1] === s.pts[s.pts.length - 1][1];
      out.push({ op: "path", pts: s.pts, close, stroke: bodyRole, fill: s.fill === "none" ? null : fillRole(s.fill, bodyRole), width: strokeWidth(s.stroke.width_mil), dash: dashFor(s.stroke.style, s.stroke.width_mil) });
      break;
    }
    case "rectangle":
      out.push({ op: "path", pts: ptsOfBox(s.a, s.b), close: true, stroke: bodyRole, fill: fillRole(s.fill, bodyRole), width: strokeWidth(s.stroke.width_mil), dash: dashFor(s.stroke.style, s.stroke.width_mil) });
      break;
    case "circle":
      out.push({ op: "circle", c: s.center, r: s.radius_mil, stroke: bodyRole, fill: fillRole(s.fill, bodyRole), width: strokeWidth(s.stroke.width_mil) });
      break;
    case "arc": {
      if (s.radius_mil <= 0) {
        out.push({ op: "path", pts: [s.start, s.mid, s.end], close: false, stroke: bodyRole, fill: null, width: strokeWidth(s.stroke.width_mil) });
        break;
      }
      const a0 = Math.atan2(s.start[1] - s.center[1], s.start[0] - s.center[0]);
      const am = Math.atan2(s.mid[1] - s.center[1], s.mid[0] - s.center[0]);
      const a1 = Math.atan2(s.end[1] - s.center[1], s.end[0] - s.center[0]);
      // choose the sweep direction that passes through `mid`
      const cwSweep = norm(a1 - a0);
      const cwMid = norm(am - a0);
      const ccw = !(cwMid <= cwSweep);
      out.push({ op: "arc", c: s.center, r: s.radius_mil, a0, a1, ccw, stroke: bodyRole, width: strokeWidth(s.stroke.width_mil) });
      break;
    }
  }
}

function norm(a: number): number {
  let r = a % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r;
}

/** eeschema text rules: 180/270 are drawn as 0/90 with mirrored justification. */
export function textCmd(t: RText, color: ColorRole, mono = false): Cmd {
  const rot = ((Math.round(t.rotation) % 360) + 360) % 360;
  let hAlign: CanvasTextAlign = t.justify_h === "left" ? "left" : t.justify_h === "right" ? "right" : "center";
  let vAlign: CanvasTextBaseline = t.justify_v === "top" ? "top" : t.justify_v === "bottom" ? "bottom" : "middle";
  let rotation: 0 | 90 = 0;
  if (rot === 90 || rot === 270) rotation = 90;
  if (rot === 180 || rot === 270) {
    hAlign = hAlign === "left" ? "right" : hAlign === "right" ? "left" : "center";
    vAlign = vAlign === "top" ? "bottom" : vAlign === "bottom" ? "top" : "middle";
  }
  return { op: "text", text: t.text, at: t.at, size: t.size_mil, rotation, hAlign, vAlign, color, bold: t.bold, italic: t.italic, mono };
}

export function pinCmds(p: RPin, sym: RSymbol, out: Cmd[]): void {
  if (p.hide) return;
  const width = DEFAULT_LINE;
  const [dx, dy] = p.dir;
  // stub
  let stubStart: Mil = p.at;
  // eeschema LIB_PIN: external decorations are half the pin-number text size (25 mil for the default 50);
  // the clock triangle inside the body is half the pin-name size.
  const ext = Math.max(6, (p.number_size_mil || 50) / 2);
  const inner = Math.max(6, (p.name_size_mil || 50) / 2);
  if (p.shape === "inverted" || p.shape === "inverted_clock" || p.shape === "output_low") {
    const r = ext;
    out.push({ op: "circle", c: [p.end[0] - dx * r, p.end[1] - dy * r], r, stroke: "pin", fill: null, width });
    stubStart = p.at;
    out.push({ op: "path", pts: [stubStart, [p.end[0] - dx * 2 * r, p.end[1] - dy * 2 * r]], close: false, stroke: "pin", fill: null, width });
  } else if (p.length_mil > 0) {
    out.push({ op: "path", pts: [p.at, p.end], close: false, stroke: "pin", fill: null, width });
  }
  if (p.shape === "clock" || p.shape === "inverted_clock" || p.shape === "clock_low" || p.shape === "edge_clock_high") {
    // clock triangle drawn inside the body at the stub end
    const s = inner;
    const px = -dy, py = dx;
    out.push({ op: "path", pts: [[p.end[0] + px * s, p.end[1] + py * s], [p.end[0] + dx * s, p.end[1] + dy * s], [p.end[0] - px * s, p.end[1] - py * s]], close: false, stroke: "pin", fill: null, width });
  }
  if (p.shape === "input_low" || p.shape === "clock_low") {
    const s = ext;
    const px = -dy, py = dx;
    out.push({ op: "path", pts: [[p.end[0] - dx * 2 * s, p.end[1] - dy * 2 * s], [p.end[0] - px * 2 * s, p.end[1] - py * 2 * s], p.end], close: false, stroke: "pin", fill: null, width });
  }
  if (p.shape === "non_logic") {
    const s = ext;
    out.push({ op: "path", pts: [[p.end[0] - s, p.end[1] - s], [p.end[0] + s, p.end[1] + s]], close: false, stroke: "pin", fill: null, width });
    out.push({ op: "path", pts: [[p.end[0] - s, p.end[1] + s], [p.end[0] + s, p.end[1] - s]], close: false, stroke: "pin", fill: null, width });
  }
  if (p.length_mil <= 0 && sym.is_power) return;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const mx = (p.at[0] + p.end[0]) / 2;
  const my = (p.at[1] + p.end[1]) / 2;
  // "Above" a horizontal stub is -y; for a vertical stub the same side is -x (text reads upward).
  const above = (o: number): Mil => (horizontal ? [mx, my - o] : [mx - o, my]);
  const rot: 0 | 90 = horizontal ? 0 : 90;
  const numberText = (at: Mil, size: number): Cmd => ({ op: "text", text: p.number, at, size, rotation: rot, hAlign: "center", vAlign: "alphabetic", color: "pin_text", bold: false, italic: false, mono: true });
  const showNumber = !p.number_hidden && p.number !== "";
  const showName = !p.name_hidden && p.name !== "" && p.name !== "~";
  if (p.name_offset_mil > 0) {
    // names inside the body (kicad-cli: `VI` hidden text at stub end + 0.508 mm, baseline +0.5 x size)
    if (showNumber) out.push(numberText(above(PIN_NUM_BASELINE * p.number_size_mil), p.number_size_mil));
    if (showName) {
      const size = p.name_size_mil;
      const at: Mil = horizontal
        ? [p.end[0] + dx * p.name_offset_mil, p.end[1] + PIN_NAME_INSIDE_BASELINE * size]
        : [p.end[0] + PIN_NAME_INSIDE_BASELINE * size, p.end[1] + dy * p.name_offset_mil];
      // reading away from the pin: for a stub pointing +x the name is left-aligned at its end, etc.
      const hAlign: CanvasTextAlign = horizontal ? (dx > 0 ? "left" : "right") : (dy < 0 ? "left" : "right");
      out.push({ op: "text", text: p.name, at, size, rotation: rot, hAlign, vAlign: "alphabetic", color: "pin_text", bold: false, italic: false, mono: true });
    }
  } else {
    // names outside: the name sits above the stub, the number below it (kicad-cli, `pin_names (offset 0)`)
    if (showName) out.push({ op: "text", text: p.name, at: above(PIN_NUM_BASELINE * p.name_size_mil), size: p.name_size_mil, rotation: rot, hAlign: "center", vAlign: "alphabetic", color: "pin_text", bold: false, italic: false, mono: true });
    if (showNumber) out.push(numberText(above(-PIN_BELOW_BASELINE * p.number_size_mil), p.number_size_mil));
  }
}

export function symbolCmds(s: RSymbol, opts: DrawOptions, out: Cmd[]): void {
  const bodyRole: ColorRole = s.unresolved ? "unresolved" : "body";
  if (s.unresolved) {
    // question box at the anchor
    const h = 50;
    out.push({ op: "path", pts: ptsOfBox([s.at[0] - h, s.at[1] - h], [s.at[0] + h, s.at[1] + h]), close: true, stroke: "unresolved", fill: null, width: DEFAULT_LINE, dash: [8, 8] });
    out.push({ op: "text", text: "?", at: s.at, size: 60, rotation: 0, hAlign: "center", vAlign: "middle", color: "unresolved", bold: true, italic: false, mono: true });
  }
  for (const sh of s.shapes) shapeCmds(sh, bodyRole, out);
  for (const p of s.pins) pinCmds(p, s, out);
  for (const t of s.texts) {
    if (t.hide && !opts.showHidden) continue;
    if (t.role === "lib_text") {
      out.push(textCmd(t, "text"));
      continue;
    }
    const color: ColorRole = t.role === "reference" ? "reference" : t.role === "value" ? "value" : "field";
    if (t.hide) {
      out.push(textCmd({ ...t, italic: true }, color));
    } else {
      out.push(textCmd(t, color, t.role === "reference"));
    }
  }
  if (s.dnp) {
    const [a, b] = s.bbox;
    out.push({ op: "path", pts: [a, b], close: false, stroke: "dnp", fill: null, width: DNP_WIDTH });
    out.push({ op: "path", pts: [[a[0], b[1]], [b[0], a[1]]], close: false, stroke: "dnp", fill: null, width: DNP_WIDTH });
  }
}

/** Rotate a local (+X along the label direction, +Y down) point by the label rotation about `at`. */
function rotAbout(at: Mil, local: Mil, rotation: number): Mil {
  const r = ((Math.round(rotation) % 360) + 360) % 360;
  const [x, y] = local;
  let rx = x, ry = y;
  // eeschema: rotation 0 reads to the right, 90 reads up, 180 left, 270 down
  if (r === 90) { rx = y; ry = -x; }
  else if (r === 180) { rx = -x; ry = -y; }
  else if (r === 270) { rx = -y; ry = x; }
  return [at[0] + rx, at[1] + ry];
}

/** Unit vector along the reading direction of an eeschema rotation. */
function alongOf(rot: number): Mil {
  return rot === 90 ? [0, -1] : rot === 180 ? [-1, 0] : rot === 270 ? [0, 1] : [1, 0];
}

/**
 * Text of a label / sheet pin. eeschema never draws text upside down: 180/270 are drawn as
 * 0/90 with the anchor at the text *end*, so the "up" side of the glyphs is always -y for
 * horizontal and -x for vertical text, whatever the rotation. `along` is the distance from
 * `at` along the reading direction to where the text starts/ends; `up` shifts the baseline
 * toward the glyph side (positive = above the anchor line).
 */
function flagText(text: string, at: Mil, rot: number, along: number, up: number, size: number, color: ColorRole): Cmd {
  const r = ((Math.round(rot) % 360) + 360) % 360;
  const a = alongOf(r);
  const vertical = r === 90 || r === 270;
  const ux = vertical ? -1 : 0, uy = vertical ? 0 : -1;
  const pos: Mil = [at[0] + a[0] * along + ux * up, at[1] + a[1] * along + uy * up];
  const hAlign: CanvasTextAlign = r === 180 || r === 270 ? "right" : "left";
  return { op: "text", text, at: pos, size, rotation: vertical ? 90 : 0, hAlign, vAlign: "alphabetic", color, bold: false, italic: false, mono: true };
}

/**
 * Hierarchical label / sheet pin flag in local coordinates (anchor at the origin, reading
 * along +X, size `s`): a 1 x 1 size box whose ends are pointed per shape. kicad-cli 10.0.4:
 * input `(0,0) (s/2,-s/2) (s,-s/2) (s,s/2) (s/2,s/2)`, output flat at the anchor with the point
 * at `s`, bidirectional/tri_state a diamond, passive/unspecified a plain box.
 */
export function hierFlagPts(shape: string, s: number): Mil[] {
  switch (shape) {
    case "input":
      return [[0, 0], [s / 2, -s / 2], [s, -s / 2], [s, s / 2], [s / 2, s / 2]];
    case "output":
      return [[0, -s / 2], [s / 2, -s / 2], [s, 0], [s / 2, s / 2], [0, s / 2]];
    case "bidirectional":
    case "tri_state":
      return [[0, 0], [s / 2, -s / 2], [s, 0], [s / 2, s / 2]];
    default:
      return [[0, -s / 2], [s, -s / 2], [s, s / 2], [0, s / 2]];
  }
}

// Global label flag (kicad-cli 10.0.4, size 50 mil): the flag is 2 x size tall (half = size),
// a pointed end is inset 0.875 x size, text starts 0.375 x size after a flat end and
// 1.125 x size after a pointed one, and the baseline sits 0.07 x size below the anchor line.
const GLOBAL_HALF = 1.0;
const GLOBAL_TIP = 0.875;
const GLOBAL_FLAT_MARGIN = 0.5;
const GLOBAL_TIP_MARGIN = 0.25;
const GLOBAL_TEXT_FLAT = 0.375;
const GLOBAL_BASELINE = -0.07;
// Local label: baseline 0.275 x size above the anchor, text starting 0.2 x size along.
const LOCAL_ALONG = 0.2;
const LOCAL_UP = 0.275;
// Hierarchical label: text starts 0.15 x size after the 1 x size flag, baseline on the anchor line.
const HIER_TEXT_ALONG = 1.15;

export function labelCmds(l: RLabel, out: Cmd[], measure?: MeasureFn): void {
  const size = l.size_mil;
  const textLen = (measure ?? estimateWidthMil)(l.text, size, true, false);
  const rot = ((Math.round(l.rotation) % 360) + 360) % 360;
  if (l.kind === "local") {
    out.push(flagText(l.text, l.at, rot, LOCAL_ALONG * size, LOCAL_UP * size, size, "label"));
    return;
  }
  const role: ColorRole = l.kind === "global" ? "global_label" : "hier_label";
  if (l.kind === "global" || l.kind === "netclass") {
    const half = GLOBAL_HALF * size;
    const tip = GLOBAL_TIP * size;
    const pointIn = l.shape === "input" || l.shape === "bidirectional" || l.shape === "tri_state";
    const pointOut = l.shape === "output" || l.shape === "bidirectional" || l.shape === "tri_state";
    // box from x0 to x1 (flat parts), with the points beyond
    const x0 = pointIn ? tip : 0;
    const x1 = x0 + textLen + (pointIn ? GLOBAL_TIP_MARGIN : GLOBAL_FLAT_MARGIN) * size + (pointOut ? GLOBAL_TIP_MARGIN : GLOBAL_FLAT_MARGIN) * size;
    const local: Mil[] = [];
    if (pointIn) local.push([0, 0], [x0, -half]); else local.push([0, -half]);
    local.push([x1, -half]);
    if (pointOut) local.push([x1 + tip, 0]);
    local.push([x1, half]);
    if (pointIn) local.push([x0, half]); else local.push([0, half]);
    out.push({ op: "path", pts: local.map((p) => rotAbout(l.at, p, rot)), close: true, stroke: role, fill: null, width: DEFAULT_LINE });
    const along = pointIn ? tip + GLOBAL_TIP_MARGIN * size : GLOBAL_TEXT_FLAT * size;
    out.push(flagText(l.text, l.at, rot, along, GLOBAL_BASELINE * size, size, role));
    return;
  }
  out.push({ op: "path", pts: hierFlagPts(l.shape, size).map((p) => rotAbout(l.at, p, rot)), close: true, stroke: role, fill: null, width: DEFAULT_LINE });
  out.push(flagText(l.text, l.at, rot, HIER_TEXT_ALONG * size, 0, size, role));
}

export function sheetSymbolCmds(sh: RSheetSymbol, out: Cmd[]): void {
  const b: Mil = [sh.at[0] + sh.size[0], sh.at[1] + sh.size[1]];
  out.push({ op: "path", pts: ptsOfBox(sh.at, b), close: true, stroke: "sheet", fill: sh.fill === "none" ? null : "sheet_fill", width: strokeWidth(sh.stroke.width_mil) });
  for (const t of sh.texts) {
    if (t.hide) continue;
    out.push(textCmd(t, "sheet_text", t.role === "sheet_file"));
  }
  for (const p of sh.pins) {
    const s = p.size_mil;
    // Same flag as a hierarchical label, reading into the sheet (eeschema: SCH_SHEET_PIN is a SCH_HIERLABEL).
    const rot = p.side === "left" ? 0 : p.side === "right" ? 180 : p.side === "top" ? 270 : 90;
    out.push({ op: "path", pts: hierFlagPts(p.shape, s).map((q) => rotAbout(p.at, q, rot)), close: true, stroke: "hier_label", fill: null, width: DEFAULT_LINE });
    out.push(flagText(p.name, p.at, rot, HIER_TEXT_ALONG * s, 0, s, "hier_label"));
  }
}

export function frameCmds(sheet: RenderSheet, out: Cmd[]): void {
  const w = sheet.paper_mm[0] * MM_TO_MIL;
  const h = sheet.paper_mm[1] * MM_TO_MIL;
  const m = 10 * MM_TO_MIL;
  out.push({ op: "path", pts: ptsOfBox([0, 0], [w, h]), close: true, stroke: "frame", fill: "paper", width: 4 });
  out.push({ op: "path", pts: ptsOfBox([m, m], [w - m, h - m]), close: true, stroke: "frame", fill: null, width: 4 });
  // title block: bottom-right box with fields
  const tbw = 120 * MM_TO_MIL;
  const tbh = 30 * MM_TO_MIL;
  const x0 = w - m - tbw;
  const y0 = h - m - tbh;
  out.push({ op: "path", pts: ptsOfBox([x0, y0], [w - m, h - m]), close: true, stroke: "frame", fill: null, width: 4 });
  const rows: Array<[string, string]> = [
    ["title", sheet.title_block.title ?? ""],
    ["date", sheet.title_block.date ?? ""],
    ["rev", sheet.title_block.rev ?? ""],
    ["company", sheet.title_block.company ?? ""],
  ];
  let y = y0 + 4 * MM_TO_MIL;
  for (const [k, v] of rows) {
    const line = v ? `${k}: ${v}` : `${k}:`;
    out.push({ op: "text", text: line, at: [x0 + 2 * MM_TO_MIL, y], size: 50, rotation: 0, hAlign: "left", vAlign: "middle", color: "frame", bold: k === "title", italic: false, mono: false });
    y += 5.5 * MM_TO_MIL;
  }
  out.push({ op: "text", text: `${sheet.paper}  ${sheet.sheet_path}`, at: [x0 + 2 * MM_TO_MIL, y], size: 45, rotation: 0, hAlign: "left", vAlign: "middle", color: "frame", bold: false, italic: false, mono: true });
}

/** Pure: everything to draw for one sheet, in z-order (frame, sheets, graphics, wires, symbols, labels, junctions). */
export function drawCommands(sheet: RenderSheet, opts: DrawOptions = {}): Cmd[] {
  const out: Cmd[] = [];
  // Tag every command emitted for one sheet object with that object's uuid (reveal / ghost skip sets).
  const tag = (uuid: string, from: number) => { for (let i = from; i < out.length; i++) out[i].uuid = uuid; };
  const boxes = opts.lod === "boxes";
  if (opts.frame !== false) frameCmds(sheet, out);
  for (const sh of sheet.sheets) { const n = out.length; sheetSymbolCmds(sh, out); tag(sh.uuid, n); }
  for (const g of sheet.graphics) shapeCmds(g, "text", out);
  for (const tb of sheet.text_boxes) {
    const n = out.length;
    out.push({ op: "path", pts: ptsOfBox(tb.a, tb.b), close: true, stroke: "text", fill: fillRole(tb.fill, "text", "body_fill"), width: strokeWidth(tb.stroke.width_mil), dash: dashFor(tb.stroke.style, tb.stroke.width_mil) });
    const pad = 20;
    out.push(textCmd({ ...tb.text, at: [tb.a[0] + pad, tb.a[1] + pad] }, "text"));
    tag(tb.uuid, n);
  }
  for (const im of sheet.images) {
    out.push({ op: "path", pts: ptsOfBox(im.bbox[0], im.bbox[1]), close: true, stroke: "frame", fill: null, width: DEFAULT_LINE, dash: [8, 8], uuid: im.uuid });
  }
  for (const w of sheet.wires) {
    const width = w.stroke.width_mil > 0 ? w.stroke.width_mil : w.is_bus ? BUS_WIDTH : WIRE_WIDTH;
    out.push({ op: "path", pts: [w.a, w.b], close: false, stroke: w.is_bus ? "bus" : "wire", fill: null, width, dash: dashFor(w.stroke.style, width), uuid: w.uuid });
  }
  for (const e of sheet.bus_entries) {
    // eeschema draws bus entries on the wire layer at wire width
    out.push({ op: "path", pts: [e.a, e.b], close: false, stroke: "wire", fill: null, width: e.stroke.width_mil > 0 ? e.stroke.width_mil : WIRE_WIDTH, uuid: e.uuid });
  }
  for (const s of sheet.symbols) {
    const n = out.length;
    if (boxes) out.push({ op: "path", pts: ptsOfBox(s.bbox[0], s.bbox[1]), close: true, stroke: null, fill: s.unresolved ? "unresolved" : "body", width: 0 });
    else symbolCmds(s, opts, out);
    tag(s.uuid, n);
  }
  for (const t of sheet.texts) {
    if (t.hide && !opts.showHidden) continue;
    out.push(textCmd(t, "text"));
  }
  if (!boxes) for (const l of sheet.labels) { const n = out.length; labelCmds(l, out, opts.measure); tag(l.uuid, n); }
  for (const j of sheet.junctions) out.push({ op: "circle", c: j.at, r: j.diameter_mil / 2, stroke: null, fill: "junction", width: 0, uuid: j.uuid });
  for (const nc of sheet.no_connects) {
    const s = NOCONNECT_HALF;
    out.push({ op: "path", pts: [[nc.at[0] - s, nc.at[1] - s], [nc.at[0] + s, nc.at[1] + s]], close: false, stroke: "noconnect", fill: null, width: DEFAULT_LINE, uuid: nc.uuid });
    out.push({ op: "path", pts: [[nc.at[0] - s, nc.at[1] + s], [nc.at[0] + s, nc.at[1] - s]], close: false, stroke: "noconnect", fill: null, width: DEFAULT_LINE, uuid: nc.uuid });
  }
  return out;
}

/**
 * Conservative world-space bounds of every command, 4 floats each (minX, minY, maxX, maxY),
 * for viewport culling. Text bounds cover both rotations; strokes are widened by their width.
 */
export function cmdBounds(cmds: Cmd[]): Float64Array {
  const b = new Float64Array(cmds.length * 4);
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let pad = 0;
    switch (c.op) {
      case "path":
        for (const p of c.pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
        pad = c.width / 2;
        break;
      case "circle":
      case "arc":
        x0 = c.c[0] - c.r; x1 = c.c[0] + c.r; y0 = c.c[1] - c.r; y1 = c.c[1] + c.r;
        pad = c.width / 2;
        break;
      case "text": {
        // glyph height ~ size; advance ~ 0.8 * size per grapheme-ish unit; cover any anchor/rotation
        const ext = c.size * KICAD_FONT_SCALE * Math.max(1, 0.95 * c.text.length) + c.size * KICAD_FONT_SCALE;
        x0 = c.at[0] - ext; x1 = c.at[0] + ext; y0 = c.at[1] - ext; y1 = c.at[1] + ext;
        break;
      }
    }
    if (x0 === Infinity) { x0 = x1 = y0 = y1 = 0; }
    b[i * 4] = x0 - pad; b[i * 4 + 1] = y0 - pad; b[i * 4 + 2] = x1 + pad; b[i * 4 + 3] = y1 + pad;
  }
  return b;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

export const TOKEN_NAMES = [
  "--fs-canvas-bg", "--fs-canvas-paper", "--fs-canvas-frame", "--fs-canvas-grid", "--fs-canvas-wire", "--fs-canvas-bus",
  "--fs-canvas-body", "--fs-canvas-body-fill", "--fs-canvas-pin", "--fs-canvas-pin-text", "--fs-canvas-reference", "--fs-canvas-value",
  "--fs-canvas-field", "--fs-canvas-text", "--fs-canvas-label", "--fs-canvas-global-label", "--fs-canvas-hier-label", "--fs-canvas-sheet",
  "--fs-canvas-sheet-fill", "--fs-canvas-sheet-text", "--fs-canvas-junction", "--fs-canvas-noconnect", "--fs-canvas-dnp",
  "--fs-canvas-unresolved", "--fs-canvas-selection", "--fs-canvas-focus", "--fs-canvas-created", "--fs-canvas-changed", "--fs-canvas-finding",
  "--fs-canvas-finding-error", "--fs-canvas-finding-warning", "--fs-canvas-finding-info", "--fs-canvas-hover",
] as const;

/**
 * Headless fallback only (Node tests, thumbnails before the DOM has tokens). The source of
 * truth is `src/styles/tokens.css` (`--fs-canvas-*`, KiCad palette); `readTokens` overrides
 * every entry defined there.
 */
export function defaultTokens(theme: "light" | "dark"): Record<string, string> {
  const dark = theme === "dark";
  const ink = dark ? "#e8e8e8" : "#111111";
  const mid = dark ? "#9a9a9a" : "#6b6b6b";
  const faint = dark ? "#3a3a3a" : "#d4d4d4";
  return {
    "--fs-canvas-bg": dark ? "#0a0a0a" : "#fafafa",
    "--fs-canvas-paper": dark ? "#111111" : "#ffffff",
    "--fs-canvas-frame": mid,
    "--fs-canvas-grid": faint,
    "--fs-canvas-wire": ink,
    "--fs-canvas-bus": ink,
    "--fs-canvas-body": ink,
    "--fs-canvas-body-fill": dark ? "#1c1c1c" : "#f0f0f0",
    "--fs-canvas-pin": ink,
    "--fs-canvas-pin-text": mid,
    "--fs-canvas-reference": ink,
    "--fs-canvas-value": mid,
    "--fs-canvas-field": mid,
    "--fs-canvas-text": ink,
    "--fs-canvas-label": ink,
    "--fs-canvas-global-label": ink,
    "--fs-canvas-hier-label": ink,
    "--fs-canvas-sheet": ink,
    "--fs-canvas-sheet-fill": dark ? "#161616" : "#f5f5f5",
    "--fs-canvas-sheet-text": mid,
    "--fs-canvas-junction": ink,
    "--fs-canvas-noconnect": mid,
    "--fs-canvas-dnp": dark ? "#c0c0c0" : "#444444",
    "--fs-canvas-unresolved": mid,
    "--fs-canvas-selection": dark ? "#ffffff" : "#000000",
    "--fs-canvas-focus": dark ? "#bdbdbd" : "#555555",
    "--fs-canvas-created": dark ? "#d0d0d0" : "#3a3a3a",
    "--fs-canvas-changed": dark ? "#ffffff" : "#000000",
    "--fs-canvas-finding": dark ? "#f0f0f0" : "#1a1a1a",
    "--fs-canvas-finding-error": dark ? "#f0f0f0" : "#1a1a1a",
    "--fs-canvas-finding-warning": mid,
    "--fs-canvas-finding-info": mid,
    "--fs-canvas-hover": ink,
  };
}

/** Read the design-system tokens from an element's computed style, falling back to defaults. */
export function readTokens(el: Element | null, theme: "light" | "dark"): Record<string, string> {
  const out = defaultTokens(theme);
  if (!el || typeof getComputedStyle !== "function") return out;
  const cs = getComputedStyle(el);
  for (const name of TOKEN_NAMES) {
    const v = cs.getPropertyValue(name).trim();
    if (v) out[name] = v;
  }
  return out;
}

const ROLE_TOKEN: Record<ColorRole, string> = {
  wire: "--fs-canvas-wire", bus: "--fs-canvas-bus", body: "--fs-canvas-body", body_fill: "--fs-canvas-body-fill", pin: "--fs-canvas-pin",
  pin_text: "--fs-canvas-pin-text", reference: "--fs-canvas-reference", value: "--fs-canvas-value", field: "--fs-canvas-field", text: "--fs-canvas-text",
  label: "--fs-canvas-label", global_label: "--fs-canvas-global-label", hier_label: "--fs-canvas-hier-label", sheet: "--fs-canvas-sheet",
  sheet_fill: "--fs-canvas-sheet-fill", sheet_text: "--fs-canvas-sheet-text", junction: "--fs-canvas-junction", noconnect: "--fs-canvas-noconnect",
  frame: "--fs-canvas-frame", grid: "--fs-canvas-grid", dnp: "--fs-canvas-dnp", unresolved: "--fs-canvas-unresolved", paper: "--fs-canvas-paper",
  hover: "--fs-canvas-hover", finding_error: "--fs-canvas-finding-error", finding_warning: "--fs-canvas-finding-warning", finding_info: "--fs-canvas-finding-info",
};

export const FONT_SANS = '"Geist", "Geist Sans", system-ui, -apple-system, "Segoe UI", "PingFang TC", "Hiragino Sans", "Noto Sans CJK TC", sans-serif';
export const FONT_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK TC", monospace';

export interface PaintOptions {
  grid: boolean;
  tokens: Record<string, string>;
  /** Skip text below this many CSS px of glyph height (default 4). */
  minTextPx?: number;
  /** Device pixel ratio of the context (already applied via `setTransform`): thin axis-aligned strokes snap to device pixels. */
  dpr?: number;
  /** Global opacity for the whole pass (ghost preview layer). */
  alpha?: number;
  /** Draw every stroke/fill in this colour instead of the role colours (ghost preview layer). */
  monochrome?: string;
  /** World box currently on screen: commands whose `bounds` miss it are not drawn (needs `bounds`). */
  visible?: Box;
  /** `cmdBounds(cmds)` for the same command list (pairs with `visible`). */
  bounds?: Float64Array;
  /** Owning-object uuids to leave out (staged reveal, ghost layer). */
  skip?: ReadonlySet<string>;
  /** Skip every text command outright (thumbnails). */
  skipText?: boolean;
  /** Filled by `paint` when given: how many commands were drawn / culled (perf HUD). */
  stats?: { drawn: number; culled: number };
}

interface GridTile { key: string; pattern: CanvasPattern | null }
let gridTile: GridTile | null = null;

/**
 * Dotted grid. One cached `createPattern` tile per (pitch, colour, dpr) and a single
 * `fillRect`; without `createPattern` (jsdom) a single path of rects.
 */
export function paintGrid(ctx: CanvasRenderingContext2D, v: ViewState, w: number, h: number, color: string, dpr = 1): void {
  const pitch = gridPitch(v.scale);
  const step = pitch * v.scale;
  const ox = ((-v.x * v.scale) % step + step) % step;
  const oy = ((-v.y * v.scale) % step + step) % step;
  const key = `${step.toFixed(3)}|${color}|${dpr}`;
  const canPattern = typeof document !== "undefined" && typeof ctx.createPattern === "function" && typeof DOMMatrix !== "undefined";
  if (canPattern) {
    if (!gridTile || gridTile.key !== key) {
      const tile = document.createElement("canvas");
      const px = Math.max(1, Math.round(step * dpr));
      tile.width = px; tile.height = px;
      const tctx = tile.getContext("2d");
      let pattern: CanvasPattern | null = null;
      if (tctx) {
        tctx.fillStyle = color;
        tctx.fillRect(0, 0, Math.max(1, Math.round(dpr)), Math.max(1, Math.round(dpr)));
        pattern = ctx.createPattern(tile, "repeat");
      }
      gridTile = { key, pattern };
    }
    const pattern = gridTile.pattern;
    if (pattern) {
      // The tile is `step*dpr` device px; scale it back to CSS px and shift by the fractional offset.
      pattern.setTransform(new DOMMatrix().translate(ox - 0.5, oy - 0.5).scale(1 / dpr));
      ctx.save();
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
      return;
    }
  }
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let x = ox; x <= w; x += step) {
    for (let y = oy; y <= h; y += step) ctx.rect(x - 0.5, y - 0.5, 1, 1);
  }
  ctx.fill();
  ctx.restore();
}

/**
 * Execute draw commands on a context already scaled for devicePixelRatio. Canvas state is
 * shadowed locally and only written on change (the context is never read back), so a sheet
 * of thousands of same-style wires costs one `strokeStyle`/`lineWidth`/`setLineDash` each.
 */
export function paint(ctx: CanvasRenderingContext2D, cmds: Cmd[], v: ViewState, opts: PaintOptions): void {
  const alpha = opts.alpha !== undefined && opts.alpha < 1;
  if (alpha) { ctx.save(); ctx.globalAlpha = opts.alpha as number; }
  const tokens = opts.tokens;
  const mono = opts.monochrome;
  const color = (r: ColorRole) => mono ?? tokens[ROLE_TOKEN[r]];
  const minTextPx = opts.minTextPx ?? 4;
  const minLine = 0.75;
  const dpr = opts.dpr && opts.dpr > 0 ? opts.dpr : 1;
  const sc = v.scale, vx = v.x, vy = v.y;
  // Strokes up to 2 device px are rounded to whole device pixels and, when odd, axis-aligned
  // two-point paths (wires, pin stubs) are snapped to pixel centres so they stay crisp.
  const crispWidth = (lw: number): number => {
    const dev = lw * dpr;
    if (dev > 2) return lw;
    return Math.max(1, Math.round(dev)) / dpr;
  };
  const snap = (val: number, lw: number): number => (Math.round(lw * dpr) % 2 === 1 ? (Math.floor(val * dpr) + 0.5) / dpr : Math.round(val * dpr) / dpr);
  const vis = opts.visible && opts.bounds && opts.bounds.length === cmds.length * 4 ? opts.visible : null;
  const bounds = opts.bounds;
  const skip = opts.skip;
  const skipText = opts.skipText === true;
  let drawn = 0, culled = 0;
  // shadow state: never read from ctx (test doubles return functions for every property)
  let curStroke: string | undefined, curFill: string | undefined, curWidth = -1, curDash = "";
  let curFont: string | undefined, curAlign: CanvasTextAlign | undefined, curBase: CanvasTextBaseline | undefined;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const strokeWith = (col: string, width: number, dash: number[] | undefined) => {
    if (col !== curStroke) { ctx.strokeStyle = col; curStroke = col; }
    const lw = crispWidth(Math.max(minLine, width * sc));
    if (lw !== curWidth) { ctx.lineWidth = lw; curWidth = lw; }
    let dk = "";
    // dashes shorter than 2 px are moire, not a style: draw solid
    const useDash = dash && dash[0] * sc >= 2 ? dash : undefined;
    if (useDash) { for (const d of useDash) dk += `${d * sc},`; }
    if (dk !== curDash) { ctx.setLineDash(useDash ? useDash.map((d) => d * sc) : []); curDash = dk; }
    ctx.stroke();
  };
  const fillWith = (col: string) => {
    if (col !== curFill) { ctx.fillStyle = col; curFill = col; }
    ctx.fill();
  };
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (skip && c.uuid !== undefined && skip.has(c.uuid)) continue;
    if (vis && bounds) {
      const j = i * 4;
      if (bounds[j + 2] < vis[0][0] || bounds[j] > vis[1][0] || bounds[j + 3] < vis[0][1] || bounds[j + 1] > vis[1][1]) { culled++; continue; }
    }
    switch (c.op) {
      case "path": {
        const pts = c.pts;
        if (pts.length === 0) break;
        drawn++;
        ctx.beginPath();
        if (pts.length === 2 && c.stroke && !c.fill && (pts[0][0] === pts[1][0] || pts[0][1] === pts[1][1])) {
          const lw = crispWidth(Math.max(minLine, c.width * sc));
          if (lw * dpr <= 2) {
            const ax = (pts[0][0] - vx) * sc, ay = (pts[0][1] - vy) * sc, bx = (pts[1][0] - vx) * sc, by = (pts[1][1] - vy) * sc;
            if (ax === bx) { const x = snap(ax, lw); ctx.moveTo(x, ay); ctx.lineTo(x, by); }
            else { const y = snap(ay, lw); ctx.moveTo(ax, y); ctx.lineTo(bx, y); }
            strokeWith(color(c.stroke), c.width, c.dash);
            break;
          }
        }
        {
          // Rectangles and other axis-aligned outlines share the wires' pixel snapping (same rule, per vertex).
          const lwR = c.stroke ? crispWidth(Math.max(minLine, c.width * sc)) : 0;
          const axisAligned = lwR > 0 && lwR * dpr <= 2 && pts.length <= 6 && pts.every((q, k) => k === 0 || q[0] === pts[k - 1][0] || q[1] === pts[k - 1][1]);
          const px = (x: number) => (axisAligned ? snap((x - vx) * sc, lwR) : (x - vx) * sc);
          const py = (y: number) => (axisAligned ? snap((y - vy) * sc, lwR) : (y - vy) * sc);
          ctx.moveTo(px(pts[0][0]), py(pts[0][1]));
          for (let k = 1; k < pts.length; k++) ctx.lineTo(px(pts[k][0]), py(pts[k][1]));
        }
        if (c.close) ctx.closePath();
        if (c.fill) fillWith(color(c.fill));
        if (c.stroke) strokeWith(color(c.stroke), c.width, c.dash);
        break;
      }
      case "circle": {
        drawn++;
        ctx.beginPath();
        // a junction dot never vanishes: at least 1.5 px radius
        ctx.arc((c.c[0] - vx) * sc, (c.c[1] - vy) * sc, Math.max(c.fill === "junction" ? 1.5 : 0.5, c.r * sc), 0, Math.PI * 2);
        if (c.fill) fillWith(color(c.fill));
        if (c.stroke) strokeWith(color(c.stroke), c.width, undefined);
        break;
      }
      case "arc": {
        drawn++;
        ctx.beginPath();
        ctx.arc((c.c[0] - vx) * sc, (c.c[1] - vy) * sc, Math.max(0.5, c.r * sc), c.a0, c.a1, c.ccw);
        strokeWith(color(c.stroke), c.width, undefined);
        break;
      }
      case "text": {
        if (skipText) break;
        // KiCad glyphs are 4/3 of the nominal size (SVG font-size 1.6933 mm for size 1.27 mm)
        const px = c.size * sc * KICAD_FONT_SCALE;
        if (px < minTextPx) break;
        drawn++;
        const font = `${c.italic ? "italic " : ""}${c.bold ? "600 " : "400 "}${px.toFixed(2)}px ${c.mono ? FONT_MONO : FONT_SANS}`;
        if (font !== curFont) { ctx.font = font; curFont = font; }
        if (c.hAlign !== curAlign) { ctx.textAlign = c.hAlign; curAlign = c.hAlign; }
        if (c.vAlign !== curBase) { ctx.textBaseline = c.vAlign; curBase = c.vAlign; }
        const col = color(c.color);
        if (col !== curFill) { ctx.fillStyle = col; curFill = col; }
        const sx = (c.at[0] - vx) * sc, sy = (c.at[1] - vy) * sc;
        // KiCad text: "\n" starts a new line (advance 1.3 glyph heights); ~{X} is an overbar (active-low), drawn
        // as the bare text with a stroke above the span.
        const lines = textLines(c.text);
        const advance = px * 1.3;
        const drawLine = (t: string, x: number, y: number) => {
          const bar = overbar(t);
          ctx.fillText(bar.text, x, y);
          if (bar.from >= 0) {
            const pre = ctx.measureText(bar.text.slice(0, bar.from)).width;
            const w = ctx.measureText(bar.text.slice(bar.from, bar.to)).width;
            const start = c.hAlign === "center" ? x - ctx.measureText(bar.text).width / 2 : c.hAlign === "right" || c.hAlign === "end" ? x - ctx.measureText(bar.text).width : x;
            const yb = y - px * 0.95;
            ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, px * 0.08); ctx.beginPath(); ctx.moveTo(start + pre, yb); ctx.lineTo(start + pre + w, yb); ctx.stroke(); ctx.restore();
          }
        };
        if (c.rotation === 90) {
          // font/align/fill were set before `save`, so `restore` leaves the shadow state valid
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(-Math.PI / 2);
          lines.forEach((t, i) => drawLine(t, 0, i * advance));
          ctx.restore();
        } else {
          lines.forEach((t, i) => drawLine(t, sx, sy + i * advance));
        }
        break;
      }
    }
  }
  if (curDash !== "") ctx.setLineDash([]);
  if (opts.stats) { opts.stats.drawn = drawn; opts.stats.culled = culled; }
  if (alpha) ctx.restore();
}


/** KiCad multi-line text: literal "\\n" in the file and real newlines both break lines. */
export function textLines(text: string): string[] {
  const parts = text.split(/\r?\n|\\n/);
  return parts.length ? parts : [text];
}

/** `~{ABC}` (KiCad overbar markup) → bare text plus the [from, to) span to overline; from = -1 when none. */
export function overbar(text: string): { text: string; from: number; to: number } {
  const m = /~\{([^}]*)\}/.exec(text);
  if (!m) return { text, from: -1, to: -1 };
  const before = text.slice(0, m.index);
  const inner = m[1];
  const after = text.slice(m.index + m[0].length).replace(/~\{([^}]*)\}/g, "$1");
  return { text: before + inner + after, from: before.length, to: before.length + inner.length };
}
