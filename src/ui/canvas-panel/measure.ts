// SPDX-License-Identifier: Apache-2.0
// Number formatting for the canvas status bar (mil with a mm equivalent). Pure.

import type { Box } from "../../canvas/types";

export const MIL_TO_MM = 0.0254;

export function fmtMil(v: number, lang?: string): string {
  return new Intl.NumberFormat(lang || undefined, { maximumFractionDigits: 0 }).format(Math.round(v));
}

export function fmtMm(mil: number, lang?: string): string {
  return new Intl.NumberFormat(lang || undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(mil * MIL_TO_MM);
}

/** Width / height of a world box in mil and mm. */
export function describeBox(box: Box, lang?: string): { w: string; h: string; wmm: string; hmm: string } {
  const w = Math.abs(box[1][0] - box[0][0]);
  const h = Math.abs(box[1][1] - box[0][1]);
  return { w: fmtMil(w, lang), h: fmtMil(h, lang), wmm: fmtMm(w, lang), hmm: fmtMm(h, lang) };
}

/** Length of a segment in mil and mm. */
export function describeLength(a: [number, number], b: [number, number], lang?: string): { len: string; mm: string } {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { len: fmtMil(len, lang), mm: fmtMm(len, lang) };
}
