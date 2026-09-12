// SPDX-License-Identifier: Apache-2.0
// One place that turns a `FindingRow` into a `finding` chat ref and back. The sidebar, the canvas
// marker click and the `N` / `Shift+N` walk must agree on the identity of a finding, otherwise a
// click in one place highlights nothing in the other. Pure: no React, no engine calls.

import type { FindingRow, Ref } from "./api";

/**
 * Location a finding ref carries: the row's own location, else its refs joined, so two findings with
 * the same code on different parts stay distinct.
 */
export function findingLocation(f: FindingRow): string {
  return f.location ?? f.refs?.join(",") ?? "";
}

/** Chat ref for a finding row. `sheet` is carried so the canvas can switch sheets before framing it. */
export function findingRef(f: FindingRow): Ref {
  const r: Extract<Ref, { kind: "finding" }> = { kind: "finding", code: f.code, location: findingLocation(f) };
  if (f.sheet) r.sheet = f.sheet;
  return r;
}

/**
 * What a designator looks like on a schematic (`R1`, `U12`, `#PWR01`). A finding's `refs` are
 * designators for every component-level check, but the sheet-level ones (`SHEET_NO_PINS`,
 * `SHEET_CHILD_EMPTY`) put the sheet's *name* there instead, and a name is not a designator.
 */
const DESIGNATOR = /^[A-Z#]+[0-9]+/;

/**
 * The instance path of a child sheet named `name` under the sheet a finding sits on. The engine puts
 * the instance names path in `sheet` (`/`, `/Power/`); the child hangs under it. A `sheet` that is
 * not an instance path (a file name) is left alone — a path nothing can resolve is better than one
 * this function invented.
 */
export function findingSheetPath(parent: string | undefined, name: string): string {
  if (!parent || !parent.startsWith("/")) return name;
  return `${parent.endsWith("/") ? parent : `${parent}/`}${name}/`;
}

/**
 * What the canvas is asked to frame for a finding row: the objects its `refs` name, then the finding
 * itself. A ref shaped like a designator is a component (its pin suffix dropped: `R1.2` is on `R1`);
 * anything else is the name of a sheet, so a sheet-level finding no longer asks the canvas to
 * highlight a component called "Power" that exists nowhere.
 */
export function findingFocusRefs(f: FindingRow): Ref[] {
  const refs: Ref[] = (f.refs ?? []).map((r) => {
    const name = r.split(".")[0];
    return DESIGNATOR.test(name)
      ? { kind: "component", ref: name, ...(f.sheet ? { sheet: f.sheet } : {}) }
      : { kind: "sheet", path: findingSheetPath(f.sheet, r) };
  });
  return [...refs, findingRef(f)];
}

/** Does the ref name this finding row? A ref without a location matches on the code alone. */
export function findingMatches(r: { code: string; location?: string }, f: FindingRow): boolean {
  if (r.code !== f.code) return false;
  if (!r.location) return true;
  return r.location === findingLocation(f) || r.location === (f.location ?? "");
}
