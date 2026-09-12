// SPDX-License-Identifier: Apache-2.0
// One-line renderings of what a turn did, from the engine's own report: what it drew, what it
// changed, and the named-net changes. Pure functions over `TurnSummary.applied`, shared by the turn
// footer (StreamView) and the turn summary card (CardView); nothing here judges the circuit.

import type { AcceptanceResult, ChangedField, CreatedObject, Ref } from "../../agent/api";
import type { MessageKey, useT } from "../../i18n";

type T = ReturnType<typeof useT>;

/** How many drawn / changed objects a line names before it collapses the rest into "+n". */
export const FOOTER_ITEMS_MAX = 8;

/** One name inside a summary line: the text as printed, and the object it names (null when it names none). */
export interface NamedItem { text: string; ref: Ref | null }
/**
 * A summary line split around its names, so each name can be rendered as a reference chip while the
 * catalogue keeps owning the wording around them. `flattenLine` prints the same line as plain text.
 */
export interface NamedLine { lead: string; tail: string; items: NamedItem[]; more: number }

/** Splits a catalogue template around its `{items}` slot; a control character no catalogue contains. */
const SLOT = "\u0000";

function namedLine(key: MessageKey, t: T, items: NamedItem[], max: number): NamedLine | null {
  if (!items.length) return null;
  const [lead, tail] = t(key, { items: SLOT }).split(SLOT);
  return { lead: lead ?? "", tail: tail ?? "", items: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** The line as one string, for callers that render text rather than chips. */
export function flattenLine(line: NamedLine | null): string | null {
  if (!line) return null;
  const shown = line.items.map((i) => i.text).join(", ");
  return `${line.lead}${line.more > 0 ? `${shown} +${line.more}` : shown}${line.tail}`;
}

/**
 * What the turn drew, named: "R7 1k, C4 100n, +3V3 port". Only objects that carry a name of their
 * own (parts and power ports); wires, junctions and labels are reported by count and by the net
 * lines. Values are the engine's, printed as they are — nothing is derived here. Each name carries
 * the ref it stands for (with the sheet the engine reported), so the chat can point the canvas at it.
 */
export function addedItems(created: CreatedObject[] | undefined, t: T, max = FOOTER_ITEMS_MAX): NamedLine | null {
  const items: NamedItem[] = [];
  for (const c of created ?? []) {
    if (c.kind === "symbol" && c.reference) items.push({ text: c.value ? `${c.reference} ${c.value}` : c.reference, ref: { kind: "component", ref: c.reference, sheet: c.sheet } });
    // A power port is a net anchor: the thing to look at on the canvas is the net it names.
    else if (c.kind === "power_port" && c.name) items.push({ text: t("chat.addedPort", { name: c.name }), ref: { kind: "net", name: c.name, sheet: c.sheet } });
  }
  return namedLine("chat.summaryAdded", t, items, max);
}

/**
 * What the turn changed on parts that were already there: "R1 Value 1k → 2k2". The before value is
 * the engine's (`per_op[].changed`); a field that had no value before is shown as a plain set.
 */
export function changedItems(changed: ChangedField[] | undefined, t: T, max = FOOTER_ITEMS_MAX): NamedLine | null {
  // A pose change is a move, listed on its own line by `movedItems`.
  const items: NamedItem[] = (changed ?? []).filter((c) => !isMove(c)).map((c) => ({
    text: c.before
      ? t("chat.changedField", { ref: c.reference, field: c.field, before: c.before, after: c.after })
      : t("chat.changedFieldNew", { ref: c.reference, field: c.field, after: c.after }),
    ref: { kind: "component", ref: c.reference, sheet: c.sheet } as Ref,
  }));
  return namedLine("chat.summaryChanged", t, items, max);
}

/** The engine reports a move or rotation as a change of the part's pose (`field: "at"`, before/after in mil). */
export function isMove(c: ChangedField): boolean {
  return c.field === "at";
}

/**
 * The existing parts the turn moved or re-posed: "Moved: R1, C2". Each part once, whatever the number of
 * moves; the poses themselves stay in the engine's report (a footer that printed coordinates said nothing
 * a human reads). Each name carries the ref, so the chat can point the canvas at the part.
 */
export function movedItems(changed: ChangedField[] | undefined, t: T, max = FOOTER_ITEMS_MAX): NamedLine | null {
  const items: NamedItem[] = [];
  for (const c of changed ?? []) {
    if (!isMove(c) || items.some((i) => i.text === c.reference)) continue;
    items.push({ text: c.reference, ref: { kind: "component", ref: c.reference, sheet: c.sheet } });
  }
  return namedLine("chat.summaryMoved", t, items, max);
}

export function addedLine(created: CreatedObject[] | undefined, t: T, max = FOOTER_ITEMS_MAX): string | null {
  return flattenLine(addedItems(created, t, max));
}

export function changedLine(changed: ChangedField[] | undefined, t: T, max = FOOTER_ITEMS_MAX): string | null {
  return flattenLine(changedItems(changed, t, max));
}

export function movedLine(changed: ChangedField[] | undefined, t: T, max = FOOTER_ITEMS_MAX): string | null {
  return flattenLine(movedItems(changed, t, max));
}

/** Acceptance rows the turn summary card lists before it stops (a long plan re-reports every block). */
export const ACCEPTANCE_ROWS_MAX = 24;

/**
 * Pass / fail / n-a totals of the plan acceptance a turn reported (the engine measured them). Rows the
 * harness restated from the plan itself are `advisory`: shown, tallied apart, never pass or fail.
 */
export function acceptanceTally(results: AcceptanceResult[] | undefined): { pass: number; fail: number; na: number; advisory: number } {
  const out = { pass: 0, fail: 0, na: 0, advisory: 0 };
  for (const r of results ?? []) {
    if (r.status === "advisory") out.advisory++;
    else if (r.status === "pass") out.pass++;
    else if (r.status === "fail") out.fail++;
    else out.na++;
  }
  return out;
}

/**
 * The acceptance items that did not hold, as "block · assertion · what the engine found". The
 * assertion and the evidence are the engine's own identifiers; only the separators are ours.
 */
export function acceptanceFailedLines(results: AcceptanceResult[] | undefined, max = FOOTER_ITEMS_MAX): string[] {
  return (results ?? [])
    .filter((r) => r.status === "fail")
    .slice(0, max)
    .map((r) => `${r.block} · ${r.label}${r.detail ? ` · ${r.detail}` : ""}`);
}

/** One short line per kind of named-net change; names beyond `max` collapse into "+n". */
export function netLines(nets: { created: string[]; merged: string[]; split: string[]; renamed: string[] } | undefined, t: T, max = 6): string[] {
  if (!nets) return [];
  const list = (xs: string[]) => (xs.length > max ? `${xs.slice(0, max).join(", ")} +${xs.length - max}` : xs.join(", "));
  const out: string[] = [];
  if (nets.created.length) out.push(t("chat.summaryNetsCreated", { n: nets.created.length, names: list(nets.created) }));
  if (nets.merged.length) out.push(t("chat.summaryNetsMerged", { names: list(nets.merged) }));
  if (nets.split.length) out.push(t("chat.summaryNetsSplit", { names: list(nets.split) }));
  if (nets.renamed.length) out.push(t("chat.summaryNetsRenamed", { names: list(nets.renamed) }));
  return out;
}
