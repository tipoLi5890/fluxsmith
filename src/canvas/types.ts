// SPDX-License-Identifier: Apache-2.0
// Mirror of `crates/sch-geom/src/render.rs` (`RenderSheet`). All coordinates
// are world mil, +Y down. Strings inside are untrusted file content and must
// only reach the screen through the Canvas text API.

export type Mil = [number, number];
export type Box = [Mil, Mil];

export interface RStroke {
  width_mil: number;
  style: "default" | "solid" | "dash" | "dot" | "dash_dot" | "dash_dot_dot" | string;
}

export type Fill = "none" | "outline" | "background" | "color" | string;

export type RShape =
  | { kind: "polyline"; pts: Mil[]; stroke: RStroke; fill: Fill }
  | { kind: "rectangle"; a: Mil; b: Mil; stroke: RStroke; fill: Fill }
  | { kind: "circle"; center: Mil; radius_mil: number; stroke: RStroke; fill: Fill }
  | { kind: "arc"; start: Mil; mid: Mil; end: Mil; center: Mil; radius_mil: number; stroke: RStroke; fill: Fill };

export interface RText {
  text: string;
  at: Mil;
  rotation: number;
  size_mil: number;
  justify_h: "left" | "center" | "right";
  justify_v: "top" | "center" | "bottom";
  bold: boolean;
  italic: boolean;
  hide: boolean;
  role: "reference" | "value" | "footprint" | "datasheet" | "user" | "text" | "lib_text" | "sheet_name" | "sheet_file";
  name?: string;
}

export interface RPin {
  number: string;
  name: string;
  electrical: string;
  shape: string;
  at: Mil;
  end: Mil;
  dir: Mil;
  length_mil: number;
  hide: boolean;
  name_hidden: boolean;
  number_hidden: boolean;
  name_size_mil: number;
  number_size_mil: number;
  name_offset_mil: number;
}

export interface RSymbol {
  reference: string;
  value: string;
  uuid: string;
  lib_id: string;
  unit: number;
  dnp: boolean;
  is_power: boolean;
  at: Mil;
  rotation: number;
  mirror: "none" | "x" | "y";
  shapes: RShape[];
  pins: RPin[];
  texts: RText[];
  bbox: Box;
  unresolved: boolean;
}

export interface RWire { uuid: string; a: Mil; b: Mil; is_bus: boolean; stroke: RStroke }
export interface RJunction { uuid: string; at: Mil; diameter_mil: number }
export interface RPoint { uuid: string; at: Mil }
export interface RSegment { uuid: string; a: Mil; b: Mil; stroke: RStroke }

export interface RLabel {
  uuid: string;
  text: string;
  kind: "local" | "global" | "hierarchical" | "netclass";
  shape: "input" | "output" | "bidirectional" | "tri_state" | "passive" | string;
  at: Mil;
  rotation: number;
  size_mil: number;
  justify_h: string;
  justify_v: string;
  bbox: Box;
}

export interface RSheetPin {
  uuid: string;
  name: string;
  shape: string;
  at: Mil;
  rotation: number;
  side: "left" | "right" | "top" | "bottom";
  size_mil: number;
}

export interface RSheetSymbol {
  uuid: string;
  name: string;
  file: string;
  at: Mil;
  size: Mil;
  stroke: RStroke;
  fill: Fill;
  pins: RSheetPin[];
  texts: RText[];
  bbox: Box;
}

export interface RTextBox { uuid: string; text: RText; a: Mil; b: Mil; stroke: RStroke; fill: Fill }
export interface RBox { uuid: string; bbox: Box }

export interface RenderSheet {
  sheet_path: string;
  file: string;
  paper: string;
  paper_mm: [number, number];
  title_block: Record<string, string>;
  symbols: RSymbol[];
  wires: RWire[];
  junctions: RJunction[];
  no_connects: RPoint[];
  bus_entries: RSegment[];
  labels: RLabel[];
  sheets: RSheetSymbol[];
  texts: RText[];
  text_boxes: RTextBox[];
  graphics: RShape[];
  images: RBox[];
  bbox: Box;
}

export const MM_TO_MIL = 1 / 0.0254;

export function emptySheet(sheet_path = "/"): RenderSheet {
  return {
    sheet_path, file: "", paper: "A4", paper_mm: [297, 210], title_block: {}, symbols: [], wires: [], junctions: [],
    no_connects: [], bus_entries: [], labels: [], sheets: [], texts: [], text_boxes: [], graphics: [], images: [],
    bbox: [[0, 0], [297 * MM_TO_MIL, 210 * MM_TO_MIL]],
  };
}
