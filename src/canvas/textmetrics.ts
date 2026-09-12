// SPDX-License-Identifier: Apache-2.0
// Text width in world mil for label flags and LOD decisions. `drawCommands` stays pure: the
// real `measureText` (when a Canvas exists) is injected through `DrawOptions.measure`; this
// module holds the headless estimate and the calibration against KiCad's stroke font.
//
// Calibration (kicad-cli 10.0.4 `sch export svg`, text size 1.27 mm = 50 mil; the hidden
// <text textLength> is KiCad's own advance width): VIN 3.227, BIDI 3.953, TRI 3.046,
// PASS 4.981, VOUT 4.920, HOUT 5.162, GND 4.074, HIN 3.469, LOCAL1 7.158, 10k 3.650,
// R1 2.683 mm -> capitals/digits average 0.93 x size per glyph (I/1 narrower), lowercase
// ~0.78 x size. KiCad renders text 4/3 taller than `size` (SVG font-size 1.6933 for 1.27).

export type MeasureFn = (text: string, sizeMil: number, mono: boolean, bold: boolean) => number;

/** KiCad glyph height is 4/3 of the nominal text size (SVG font-size 1.6933 mm for size 1.27 mm). */
export const KICAD_FONT_SCALE = 4 / 3;

const NARROW = new Set([..."iIl1.,:;'|!jt "]);

function isWide(cp: number): boolean {
  // CJK Unified, extensions A, compatibility, Hiragana/Katakana, Hangul, fullwidth forms
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd);
}

/** Headless estimate of KiCad's advance width (mil). Wide (CJK) glyphs count 1.2 x size. */
export function estimateWidthMil(text: string, sizeMil: number, mono = false): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isWide(cp)) w += 1.2;
    else if (mono) w += 0.86;
    else if (NARROW.has(ch)) w += 0.45;
    else if (ch >= "a" && ch <= "z") w += 0.78;
    else w += 0.93;
  }
  return w * sizeMil;
}

/**
 * Build a `MeasureFn` on a real 2D context (an offscreen canvas): widths are measured at a
 * 100 px reference font and scaled to the requested size, memoised per font/text. `k`
 * calibrates the browser font's advance to KiCad's stroke font so flags stay the same size
 * across fonts (Geist at 4/3 x size measures ~0.9 x size per capital vs KiCad's 0.93).
 */
export function makeMeasure(ctx: CanvasRenderingContext2D | null, fonts: { sans: string; mono: string }, k = 1.03): MeasureFn {
  if (!ctx || typeof ctx.measureText !== "function") return (text, size, mono) => estimateWidthMil(text, size, mono);
  const cache = new Map<string, number>();
  const REF = 100;
  return (text, sizeMil, mono, bold) => {
    const font = `${bold ? "600 " : "400 "}${REF}px ${mono ? fonts.mono : fonts.sans}`;
    const key = `${font}|${text}`;
    let px = cache.get(key);
    if (px === undefined) {
      if (ctx.font !== font) ctx.font = font;
      px = ctx.measureText(text).width;
      if (!(px > 0)) return estimateWidthMil(text, sizeMil, mono);
      if (cache.size > 4096) cache.clear();
      cache.set(key, px);
    }
    return (px / REF) * sizeMil * KICAD_FONT_SCALE * k;
  };
}
