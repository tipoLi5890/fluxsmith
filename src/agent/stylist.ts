// SPDX-License-Identifier: Apache-2.0
// Mechanical tidy-up after a block is applied: no model involved. Produces the
// op-list the harness applies with `note: "stylist"` (P12 whitelists exactly
// this shape): move the parts a finding names, re-lay the block when bodies
// overlap, rotate mis-oriented power ports by uuid, then frame the block with a
// rectangle and a title.
//
// Why the targeted moves exist: `arrange_group { only_unwired: true }` leaves
// every wired symbol where it is (the engine says so in a warning per part), so
// on a block that has already been wired the whole pass used to be a no-op —
// real run 19 answered TEXT_OVERLAP x2, FIELD_OVER_OWN_BODY, ROW_MISALIGNED x3
// and DECAP_FAR x2 with one arrange that moved nothing. A finding that names a
// part is answered with a `move_component` on that part instead, computed from
// the engine's own geometry (`StylistGeom`), and the re-lay is kept for the
// overlaps it was written for.

import type { Finding } from "./policy/types";

export const STYLIST_NOTE = "stylist";
export const STYLIST_OPS = new Set(["move_component", "set_component_transform", "arrange_group", "add_rectangle", "add_text", "set_title_block"]);
/** Codes answered by re-laying the whole block: bodies (not texts) sitting on each other. */
const ARRANGE_CODES = new Set(["GROUP_OVERLAP", "LABEL_OVERLAP", "SYMBOL_OVERLAP", "LABEL_OVER_BODY", "OFF_GRID"]);
/** Codes answered by moving the one part the finding names, when the pass knows where the parts are. */
const MOVE_CODES = new Set(["TEXT_OVERLAP", "FIELD_OVER_FIELD", "ROW_MISALIGNED", "DECAP_FAR"]);
/**
 * Codes this pass repairs that no `check.style` / `check.layout` run reports: `DECAP_FAR` is a
 * `delivery` finding (it needs the netlist), so run 21's stylist never saw the two the gate had
 * already found and C1 stayed 808 mil from the pin it decouples through the whole plan. The gate
 * step reads these families as well and hands them in.
 */
export const STYLIST_DELIVERY_CODES: ReadonlySet<string> = new Set(["DECAP_FAR"]);
/**
 * Every code this pass has an op for: the two sets above, the rotation and the title block. It is
 * what "the stylist repairs this" means to the finding triage; the pass itself still runs on the
 * findings of one block region, not on a code list.
 */
export const STYLIST_CODES: ReadonlySet<string> = new Set([...ARRANGE_CODES, ...MOVE_CODES, "POWER_PORT_ORIENTATION", "TITLE_BLOCK_EMPTY"]);

/** `arrange_group` cell size when the op names none (mirrors `sch-ops`: pitch_mil 600, pitch_y_mil 400). */
export const ARRANGE_PITCH_MIL = 600;
export const ARRANGE_PITCH_Y_MIL = 400;
/** How much wider each retry lays the block out; a repeat of the same pitch would be a replay, not an attempt. */
export const ARRANGE_PITCH_STEP_MIL = 100;

/** How far a text collision pushes the part that carries the offending text (mil). */
export const NUDGE_MIL = 100;
/** Where a far decoupling capacitor is put relative to the pin it decouples (mil, inside `DECAP_FAR`'s 500). */
export const DECAP_NEAR_MIL = 200;
/**
 * Fallback row tolerances, used only when a `ROW_MISALIGNED` finding carries no `target_*_mil` /
 * `delta_mil` evidence. The engine decides what is misaligned and by how much (`gates.rs`); these
 * numbers exist so an older finding without evidence still gets a move, never to re-judge one.
 */
const ROW_TOLERANCE_FALLBACK_MIL = 25;
const ROW_BAND_FALLBACK_MIL = 75;
/** The rings tried around the pin, nearest first; both stay inside the 300 mil a regulator's caps get. */
export const DECAP_RINGS_MIL: readonly number[] = [DECAP_NEAR_MIL, 300];
/** How close another part's origin may sit to the spot chosen for a decap before it counts as taken (mil). */
export const DECAP_CLEAR_MIL = 150;
/** How far from a symbol's origin a wire end still counts as attached to it, when no body box was read (mil). */
const WIRE_ATTACH_MIL = 200;
/** Longest frame caption (the block's own name, never a slice of its prompt). */
export const BLOCK_CAPTION_MAX = 40;

export type Box = [[number, number], [number, number]];

/**
 * Where the parts of the sheet actually are, read from the engine before the pass (`sch.read` gives
 * every symbol's origin, `sch.bbox` its body box). The harness never derives geometry itself: these
 * are the engine's own numbers, and without them the pass falls back to the re-lay it always did.
 */
export interface StylistGeom {
  /** Symbol origin (mil) by reference. */
  at: Record<string, [number, number]>;
  /** Symbol bounding box (mil) by reference. */
  box?: Record<string, Box>;
  /** Label anchor (mil) by label uuid. */
  labelAt?: Record<string, [number, number]>;
  /** Wire segments of the sheet (mil), as `sch.read` lists them; absent = not read. */
  wires?: { from: [number, number]; to: [number, number] }[];
}

export interface StylistInput {
  block: { id: string; name?: string; summary?: string };
  findings: Finding[];
  /** Bounding box of the objects the apply created (mil); null when unknown. */
  bboxMil: Box | null;
  /** The block's floorplan region (mil). */
  region: Box;
  /** Title to write into an empty title block (the sheet's file stem); omitted = leave it. */
  sheetTitle?: string;
  /** Current geometry of the sheet; omitted = only the re-lay and the rotations are available. */
  geom?: StylistGeom;
  /**
   * Retry number of this pass over the same region (0 = the first attempt). A later attempt lays the
   * block out on a wider pitch, so it is a different move and not a replay of the one that did not help.
   */
  attempt?: number;
}

/** Move attempts the harness makes inside one block region before it reports what is left. */
export const STYLIST_ROUNDS = 3;

/** How far outside its region a finding may sit and still count as the region's (mil). */
const REGION_SLACK_MIL = 200;

/** Whether a finding sits in this region. A finding without coordinates belongs to whatever asks. */
export function findingInRegion(f: Finding, region: Box): boolean {
  const at = (f as Finding & { at_mil?: [number, number] }).at_mil;
  if (!at) return true;
  return at[0] >= region[0][0] - REGION_SLACK_MIL && at[0] <= region[1][0] + REGION_SLACK_MIL
    && at[1] >= region[0][1] - REGION_SLACK_MIL && at[1] <= region[1][1] + REGION_SLACK_MIL;
}

const snap = (v: number, grid = 50) => Math.round(v / grid) * grid;

/** Uuid carried by a `style:power:<uuid>` / `style:<kind>:<uuid>` location. */
export function uuidOfLocation(location: string | undefined): string | null {
  const m = /^style:[a-z_]+:([0-9a-f-]{36})/i.exec(location ?? "");
  return m ? m[1] : null;
}

/** The label uuid a `textlabel:<symbol uuid>:<label uuid>` location carries (the text ran over that label). */
export function labelUuidOfLocation(location: string | undefined): string | null {
  const m = /^textlabel:[0-9a-f-]{36}:([0-9a-f-]{36})$/i.exec(location ?? "");
  return m ? m[1] : null;
}

/** `C7.1` -> `C7`; a bare designator is returned unchanged. */
export function designatorOf(ref: string): string {
  return String(ref ?? "").split(".")[0].trim();
}

/**
 * Desired rotation encoded in the finding (`rotation=<deg>` in remediation or a `want_rotation` field).
 *
 * `POWER_PORT_ORIENTATION` carries neither: the engine's remediation is the shape of the op
 * (`set_component_transform {uuid, rotation}`), so nothing parsed and the stylist emitted no op at all
 * — which is why six of them survived a whole run to delivery. The check only fires on a port whose
 * body sits on the wrong side of its own pin along y, and a port whose body is left or right of the pin
 * is excluded by the engine itself (`centre_y != pin.y`), so the only orientation it can be reporting
 * is the upside-down one and 0 (upright: rails up, GND down) is the repair.
 */
function wantedRotation(f: Finding): number | null {
  const extra = f as Finding & { want_rotation?: number };
  if (typeof extra.want_rotation === "number") return extra.want_rotation;
  const m = /rotation[=: ]+(\d{1,3})/i.exec(f.remediation ?? f.message ?? "");
  if (m) return Number(m[1]);
  return f.code === "POWER_PORT_ORIENTATION" ? 0 : null;
}

/** The frame caption: the block's own name, never the first 40 characters of the prompt that drew it. */
export function blockCaption(block: { id: string; name?: string; summary?: string }): string {
  const own = String(block.name ?? block.id ?? "").replace(/\s+/g, " ").trim();
  if (own) return own.slice(0, BLOCK_CAPTION_MAX);
  // No name at all: a summary is a sentence, so cut it at a word boundary instead of mid-word
  // ("Place and wire the complete USB-powered " was a real caption on a real sheet).
  const text = String(block.summary ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= BLOCK_CAPTION_MAX) return text;
  const cut = text.slice(0, BLOCK_CAPTION_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > BLOCK_CAPTION_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "");
}

const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** `move_component` to an absolute spot (`x_mil`/`y_mil` are the part's new position, not a delta). */
function moveTo(ref: string, to: [number, number], region: Box): Record<string, unknown> | null {
  const x = snap(to[0]);
  const y = snap(to[1]);
  // Never past the block's own region: the pass may only tidy inside what the approved plan declared.
  if (x < region[0][0] - REGION_SLACK_MIL || x > region[1][0] + REGION_SLACK_MIL) return null;
  if (y < region[0][1] - REGION_SLACK_MIL || y > region[1][1] + REGION_SLACK_MIL) return null;
  return { op: "move_component", designator: ref, x_mil: x, y_mil: y };
}

/**
 * The axis a part can be nudged along without skewing the wires attached to it (0 = x, 1 = y), or
 * null when the geometry does not say.
 *
 * A `move_component` carries the wire ends on the moved pins, so a move across a wire's own axis
 * rubber-bands that wire — run 21 shipped two `LONG_WIRE: diagonal wire` findings that way. The
 * engine now redraws such a segment as an L, and this keeps the pass from asking for the L in the
 * first place: when every orthogonal wire touching the part runs along one axis, that axis is the
 * free one. Two attached wires of different axes (or none) give no preference.
 */
export function wireAxis(ref: string, geom: StylistGeom): 0 | 1 | null {
  const at = geom.at[ref];
  const wires = geom.wires;
  if (!at || !wires?.length) return null;
  const box = geom.box?.[ref];
  const touches = (p: [number, number]): boolean => box
    ? p[0] >= box[0][0] - 50 && p[0] <= box[1][0] + 50 && p[1] >= box[0][1] - 50 && p[1] <= box[1][1] + 50
    : Math.abs(p[0] - at[0]) <= WIRE_ATTACH_MIL && Math.abs(p[1] - at[1]) <= WIRE_ATTACH_MIL;
  const axes = new Set<0 | 1>();
  for (const w of wires) {
    if (!isPoint(w?.from) || !isPoint(w?.to)) continue;
    if (!touches(w.from) && !touches(w.to)) continue;
    if (w.from[1] === w.to[1] && w.from[0] !== w.to[0]) axes.add(0);
    else if (w.from[0] === w.to[0] && w.from[1] !== w.to[1]) axes.add(1);
  }
  return axes.size === 1 ? [...axes][0] : null;
}

/** Is this spot free of every other part the pass knows about (origins and the boxes it read)? */
function spotIsFree(spot: [number, number], cap: string, geom: StylistGeom): boolean {
  for (const [ref, at] of Object.entries(geom.at)) {
    if (ref === cap) continue;
    if (Math.abs(at[0] - spot[0]) <= DECAP_CLEAR_MIL && Math.abs(at[1] - spot[1]) <= DECAP_CLEAR_MIL) return false;
  }
  for (const [ref, box] of Object.entries(geom.box ?? {})) {
    if (ref === cap) continue;
    if (spot[0] >= box[0][0] && spot[0] <= box[1][0] && spot[1] >= box[0][1] && spot[1] <= box[1][1]) return false;
  }
  return true;
}

/**
 * A free 50 mil grid spot for a far decoupling capacitor: on the pin's own free side, one of the
 * rings inside `DECAP_FAR`'s 500 mil, and inside the block region the approved plan declared.
 *
 * `away` is the direction from the part the pin belongs to towards the pin, so the sides are tried
 * outwards first — the side facing the part's body is where the cap would land on top of it. Null
 * when nothing is free: the caller then leaves the finding open instead of dropping it in silence.
 */
function decapSpot(pin: [number, number], cap: string, region: Box, geom: StylistGeom, away: [number, number] | null): [number, number] | null {
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const wa = wireAxis(cap, geom);
  const dot = (d: [number, number]) => (away ? d[0] * away[0] + d[1] * away[1] : 0);
  // Along the attached wire first (a move across it skews the wire), then outwards from the part.
  const ordered = [...dirs].sort((a, b) => {
    const alongA = wa === null ? 0 : (wa === 0 ? Math.abs(a[0]) : Math.abs(a[1])) ? 0 : 1;
    const alongB = wa === null ? 0 : (wa === 0 ? Math.abs(b[0]) : Math.abs(b[1])) ? 0 : 1;
    return alongA - alongB || dot(b) - dot(a);
  });
  for (const ring of DECAP_RINGS_MIL) {
    for (const d of ordered) {
      const spot: [number, number] = [snap(pin[0] + d[0] * ring), snap(pin[1] + d[1] * ring)];
      if (!spotIsFree(spot, cap, geom)) continue;
      if (!moveTo(cap, spot, region)) continue;
      return spot;
    }
  }
  return null;
}

/** Where the thing a text ran into sits: the second ref of the finding, or the label its location names. */
function blockerAt(f: Finding, refs: string[], geom: StylistGeom): [number, number] | null {
  for (const r of refs.slice(1)) {
    const at = geom.at[r];
    if (at) return at;
  }
  const label = labelUuidOfLocation(f.location);
  const at = label ? geom.labelAt?.[label] : undefined;
  return at ?? null;
}

/**
 * The pin a far decoupling capacitor belongs at, when the finding says which one.
 *
 * `DECAP_FAR` names the capacitor and its own pin, the rail and the distance, but not the power pin
 * it is far from, so the anchor is read from `evidence` when the engine supplies one
 * (`evidence.nearest_pin` as "U1.4", or `evidence.nearest_pin_at_mil`). Without it there is no
 * direction to move in and the finding is left for the Fixer, which can read the net itself.
 */
function decapAnchor(f: Finding, cap: string): string | [number, number] | null {
  const ev = (f.evidence ?? {}) as Record<string, unknown>;
  for (const k of ["nearest_pin", "power_pin", "pin"]) {
    const v = ev[k];
    if (typeof v === "string" && /^[^\s.]+\.[^\s.]+$/.test(v) && designatorOf(v) !== cap) return v;
  }
  for (const k of ["nearest_pin_at_mil", "power_pin_at_mil", "pin_at_mil"]) {
    if (isPoint(ev[k])) return ev[k] as [number, number];
  }
  const other = (f.refs ?? []).slice(1).find((r) => r.includes(".") && designatorOf(r) !== cap);
  return other ?? null;
}

/**
 * The coordinate of the pin the engine measured the distance to (`evidence.nearest_pin_at_mil`).
 * With it the pass can pick where the cap goes; without it, all it can do is hand the pin's name to
 * the engine and take a fixed offset from it.
 */
function decapPin(f: Finding): [number, number] | null {
  const ev = (f.evidence ?? {}) as Record<string, unknown>;
  for (const k of ["nearest_pin_at_mil", "power_pin_at_mil", "pin_at_mil"]) {
    if (isPoint(ev[k])) return ev[k] as [number, number];
  }
  return null;
}

/**
 * One `move_component` per finding that names a part, from the engine's own geometry. Parts already
 * moved in this pass are left alone: two moves of one part in one op-list is a fight, not a repair.
 */
function targetedMoves(findings: Finding[], region: Box, geom: StylistGeom): Record<string, unknown>[] {
  const ops: Record<string, unknown>[] = [];
  const moved = new Set<string>();
  // Rows first: they align a whole row to one baseline, so they must not be pre-empted by a nudge.
  // `ROW_MISALIGNED` carries the engine's own answer -- the line the row shares (`target_y_mil` or
  // `target_x_mil`, which also says which axis is the row's) and `delta_mil`, signed the way this
  // part has to move -- so the pass moves by that and does not re-derive the row or re-apply the
  // engine's tolerances. Findings without that evidence fall back to aligning bottom edges.
  const row: { ref: string; at: [number, number]; bottom: number }[] = [];
  for (const f of findings) {
    if (f.code !== "ROW_MISALIGNED") continue;
    const ref = designatorOf((f.refs ?? [])[0] ?? "");
    const at = geom.at[ref];
    if (!ref || !at || moved.has(ref) || row.some((r) => r.ref === ref)) continue;
    const ev = (f.evidence ?? {}) as Record<string, unknown>;
    const axis = typeof ev.target_y_mil === "number" ? 1 : typeof ev.target_x_mil === "number" ? 0 : -1;
    const delta = typeof ev.delta_mil === "number" ? ev.delta_mil : null;
    if (axis < 0 || delta === null) {
      const box = geom.box?.[ref];
      if (box) row.push({ ref, at, bottom: box[1][1] });
      continue;
    }
    if (delta === 0) continue;
    const to: [number, number] = axis === 1 ? [at[0], at[1] + delta] : [at[0] + delta, at[1]];
    const op = moveTo(ref, to, region);
    if (op) { ops.push(op); moved.add(ref); }
  }
  if (row.length >= 2) {
    // The engine measures bottom edges, so align bottoms (not origins: two parts of different heights
    // with the same origin still read as a broken row).
    const target = Math.min(...row.map((r) => r.bottom));
    for (const r of row) {
      const dy = target - r.bottom;
      if (Math.abs(dy) <= ROW_TOLERANCE_FALLBACK_MIL || Math.abs(dy) > ROW_BAND_FALLBACK_MIL) continue;
      const op = moveTo(r.ref, [r.at[0], r.at[1] + snap(dy)], region);
      if (op) { ops.push(op); moved.add(r.ref); }
    }
  }
  for (const f of findings) {
    if (f.code === "TEXT_OVERLAP" || f.code === "FIELD_OVER_FIELD") {
      const refs = (f.refs ?? []).map(designatorOf).filter(Boolean);
      const mover = refs[0];
      const from = mover ? geom.at[mover] : undefined;
      if (!mover || !from || moved.has(mover)) continue;
      const blocker = blockerAt(f, refs, geom);
      if (!blocker) continue;
      // Push along the axis the two are already separated on: that is the free direction, and 100 mil
      // is the clearance the layout rules ask for between a text and the next body. A wire attached
      // to the part overrides it: moving across a wire's own axis rubber-bands the wire into an L
      // (the engine redraws it, but a straight run is the better drawing).
      const d: [number, number] = [from[0] - blocker[0], from[1] - blocker[1]];
      const axis = wireAxis(mover, geom) ?? (Math.abs(d[0]) >= Math.abs(d[1]) ? 0 : 1);
      const sign = d[axis] >= 0 ? 1 : -1;
      const away = (s: number): [number, number] => (axis === 0 ? [from[0] + s * NUDGE_MIL, from[1]] : [from[0], from[1] + s * NUDGE_MIL]);
      const op = moveTo(mover, away(sign), region) ?? moveTo(mover, away(-sign), region);
      if (op) { ops.push(op); moved.add(mover); }
      continue;
    }
    if (f.code === "DECAP_FAR") {
      const cap = designatorOf((f.refs ?? [])[0] ?? "");
      if (!cap || moved.has(cap)) continue;
      const anchor = decapAnchor(f, cap);
      const point = decapPin(f);
      // The engine gives the pin's own coordinate (`nearest_pin_at_mil`), so the destination is
      // chosen here — a free grid spot on the pin's free side, inside the block region — instead of
      // being fixed at "200 mil below the pin", which is where the part it decouples usually is.
      if (point) {
        const owner = typeof anchor === "string" ? geom.at[designatorOf(anchor)] : undefined;
        const away: [number, number] | null = owner
          ? [Math.sign(point[0] - owner[0]), Math.sign(point[1] - owner[1])]
          : null;
        const spot: [number, number] | null = decapSpot(point, cap, region, geom, away);
        const op = spot ? moveTo(cap, spot, region) : null;
        // No free spot inside the region: the finding is left open on purpose, so the gate reports
        // it (`system.layout_unresolved`) rather than the pass quietly dropping the repair.
        if (op) { ops.push(op); moved.add(cap); }
        continue;
      }
      if (!anchor) continue;
      if (typeof anchor === "string") {
        // Only the pin's name is known: the engine resolves it, and the pin is a pin of a part in
        // this block, so the destination stays inside the region.
        ops.push({ op: "move_component", designator: cap, anchor, offset_mil: [0, DECAP_NEAR_MIL] });
        moved.add(cap);
        continue;
      }
      const op = moveTo(cap, [anchor[0], anchor[1] + DECAP_NEAR_MIL], region);
      if (op) { ops.push(op); moved.add(cap); }
    }
    // FIELD_OVER_OWN_BODY is deliberately absent: a move translates the part's field texts with the
    // part, so no move (and no rotation of a wired part) can clear it. It stays an unresolved finding
    // the user is told about until the engine can re-run its field autoplace.
  }
  return ops;
}

export function stylistOps(input: StylistInput): { protocol_version: number; groups: Record<string, unknown>; ops: Record<string, unknown>[]; note: string } | null {
  const ops: Record<string, unknown>[] = [];
  const { block, findings, bboxMil, region, geom } = input;
  const mine = findings.filter((f) => findingInRegion(f, region));
  // An empty title block is a delivery finding on every fresh sheet; the sheet name is a mechanical default.
  if (input.sheetTitle && findings.some((f) => f.code === "TITLE_BLOCK_EMPTY")) ops.push({ op: "set_title_block", title: input.sheetTitle });
  const moves = geom ? targetedMoves(mine, region, geom) : [];
  ops.push(...moves);
  // The re-lay answers the overlaps it was written for, and stands in for the targeted moves only when
  // the geometry needed to compute one was not available (an unwired first draft, where it works).
  const relay = mine.some((f) => ARRANGE_CODES.has(f.code)) || (!moves.length && mine.some((f) => MOVE_CODES.has(f.code)));
  if (relay) {
    const attempt = Math.max(0, input.attempt ?? 0);
    ops.push({
      op: "arrange_group", group: block.id, region_mil: region, only_unwired: true,
      // The first attempt keeps the engine's own defaults; each retry spreads the block a little wider.
      ...(attempt > 0 ? { pitch_mil: ARRANGE_PITCH_MIL + attempt * ARRANGE_PITCH_STEP_MIL, pitch_y_mil: ARRANGE_PITCH_Y_MIL + attempt * ARRANGE_PITCH_STEP_MIL } : {}),
    });
  }
  for (const f of mine) {
    if (f.code !== "POWER_PORT_ORIENTATION") continue;
    const uuid = uuidOfLocation(f.location);
    const rot = wantedRotation(f);
    if (uuid && rot !== null) ops.push({ op: "set_component_transform", uuid, rotation: rot });
  }
  if (bboxMil) {
    const [[x0, y0], [x1, y1]] = bboxMil;
    if (x1 > x0 && y1 > y0) {
      const start: [number, number] = [snap(x0 - 150), snap(y0 - 200)];
      const end: [number, number] = [snap(x1 + 150), snap(y1 + 150)];
      ops.push({ op: "add_rectangle", start, end, key: `frame:${block.id}` });
      const title = blockCaption(block);
      ops.push({ op: "add_text", text: title || block.id, at: [start[0] + 50, start[1] + 50], key: `title:${block.id}` });
    }
  }
  if (!ops.length) return null;
  return { protocol_version: 1, groups: {}, ops, note: STYLIST_NOTE };
}
