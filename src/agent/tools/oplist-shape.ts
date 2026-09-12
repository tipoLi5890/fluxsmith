// SPDX-License-Identifier: Apache-2.0
// Envelope repair for an op-list argument, ahead of `normalizeOplist` (`ops.ts`), which
// canonicalises what is *inside* a well-shaped list. This file only fixes the outer shape:
// the wrapper a model puts the list under, a bare array of ops, and ops buried in the group
// entries. Nothing here judges an op or a circuit (red line 6); an op-list this cannot repair
// still goes to the engine and is refused there, with `oplistShapeRemediation` as the answer.
//
// Real run 21: three of the Fixer's first `ops.validate` calls died on
// `OPLIST_SCHEMA invalid op-list at '.': missing field 'ops'` over
// `{"groups":[{"id":"fix_decap_c1","ops":[...]}],"protocol_version":"1.0"}` — every op was
// inside a group entry and the top level carried none. Each of those cost a full round trip
// to discover a shape the harness already knew.

import { PROTOCOL_VERSION } from "./ops";

/** The one shape the engine accepts, quoted verbatim in the remediation and in the role prefix. */
export const OPLIST_MINIMAL_SHAPE = `{"protocol_version":1,"groups":{},"ops":[…]}`;

/** How deep a wrapper chain is unwrapped (`{"output":{"oplist":{…}}}` is the realistic worst case). */
const UNWRAP_MAX = 3;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An entry that reads as an op: an object naming its op (`op`, or the `type` alias `ops.ts` maps). */
function isOpLike(v: unknown): boolean {
  return isRecord(v) && (typeof v.op === "string" || typeof v.type === "string");
}

/** Does this value read as the op-list itself rather than as something wrapped around one? */
export function looksLikeOplist(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && v.every(isOpLike);
  if (!isRecord(v)) return false;
  return Array.isArray(v.ops) || Array.isArray(v.operations) || v.groups !== undefined || v.protocol_version !== undefined;
}

/**
 * Ops the group entries carry, lifted to one flat top-level array, and the group definitions with
 * their `ops` removed. Each lifted op keeps the group it was written under (`group`), which is the
 * field the engine reads for group-local coordinates, so nothing about the authored intent is lost.
 * Returns null when no group entry carries ops.
 */
function hoistGroupOps(groups: unknown): { groups: Record<string, unknown>; ops: unknown[] } | null {
  const entries: [string, unknown][] = Array.isArray(groups)
    ? groups.map((g, i) => [String((isRecord(g) && (g.id ?? g.name ?? g.group)) ?? `g${i + 1}`), g])
    : isRecord(groups) ? Object.entries(groups) : [];
  if (!entries.length) return null;
  const out: Record<string, unknown> = {};
  const ops: unknown[] = [];
  let found = false;
  for (const [key, g0] of entries) {
    if (!isRecord(g0)) { out[key] = g0; continue; }
    const { ops: nested, ...rest } = g0;
    if (Array.isArray(nested)) {
      found = true;
      for (const op of nested) ops.push(isRecord(op) && op.group === undefined ? { ...op, group: key } : op);
    }
    out[key] = rest;
  }
  return found ? { groups: out, ops } : null;
}

/**
 * The op-list inside a chain of single-key wrappers (`{"output":{"oplist":{…}}}`), or undefined when
 * there is none: only a wrapper with exactly one key is followed, and only down to an op-list, so
 * `{"note":"I could not do it"}` is never mistaken for one.
 */
function unwrap(v: unknown, depth: number): unknown | undefined {
  if (looksLikeOplist(v)) return v;
  if (depth <= 0 || !isRecord(v)) return undefined;
  const keys = Object.keys(v);
  return keys.length === 1 ? unwrap(v[keys[0]], depth - 1) : undefined;
}

/**
 * Repair the outer shape of an op-list argument: unwrap a single-key wrapper whose value is an
 * op-list, take a bare array as `ops`, and lift ops written inside the group entries to the top
 * level. Anything already well-shaped is returned unchanged (structurally; the value is copied).
 */
export function reshapeOplist(input: unknown): unknown {
  const v = unwrap(input, UNWRAP_MAX) ?? input;
  if (Array.isArray(v)) return { protocol_version: PROTOCOL_VERSION, groups: {}, ops: v };
  if (!isRecord(v)) return v;
  const o = { ...v };
  if (!Array.isArray(o.ops) && !Array.isArray(o.operations)) {
    const hoisted = hoistGroupOps(o.groups);
    if (hoisted) { o.groups = hoisted.groups; o.ops = hoisted.ops; }
  }
  return o;
}

/** The top-level keys of what was received, quoted back so the model can see what it actually sent. */
function receivedShape(v: unknown): string {
  if (Array.isArray(v)) return `an array of ${v.length} entries`;
  if (v === null || v === undefined) return String(v);
  if (!isRecord(v)) return typeof v;
  const keys = Object.keys(v).slice(0, 12).map((k) => k.slice(0, 40));
  return keys.length ? `an object with top-level keys ${keys.map((k) => `"${k}"`).join(", ")}` : "an empty object";
}

/**
 * What to answer when the engine still refuses the shape: the exact minimal list, the two mistakes
 * that produce `missing field 'ops'`, and the keys that actually arrived. Deterministic text — it
 * goes into the transcript and therefore into the cache prefix of the next call.
 */
export function oplistShapeRemediation(received: unknown): string {
  return `an op-list is exactly ${OPLIST_MINIMAL_SHAPE}: "ops" is one flat array at the top level (never inside a group entry) and "groups" is an object keyed by group id (never an array); an op names its group with a "group" field. Received ${receivedShape(received)}.`;
}
