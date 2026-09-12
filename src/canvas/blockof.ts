// SPDX-License-Identifier: Apache-2.0
// Which plan block a canvas hit belongs to: the floorplan region that contains the symbol's
// bounding-box centre (pure; used by the canvas context menu's "redraw this block").

import type { Hit } from "./hittest";

export interface BlockInfo { id: string; sheet: string; step_id: string | null; region_mil: [[number, number], [number, number]] | null; summary: string }

export function blockOfHit(hit: Hit | null, blocks: BlockInfo[], sheetFile: string | null): BlockInfo | null {
  if (!hit || hit.kind !== "symbol") return null;
  const cx = (hit.bbox[0][0] + hit.bbox[1][0]) / 2;
  const cy = (hit.bbox[0][1] + hit.bbox[1][1]) / 2;
  for (const b of blocks) {
    if (!b.region_mil) continue;
    if (sheetFile && b.sheet && b.sheet !== sheetFile) continue;
    const [[x0, y0], [x1, y1]] = b.region_mil;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) return b;
  }
  return null;
}
