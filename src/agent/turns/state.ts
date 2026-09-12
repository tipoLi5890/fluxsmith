// SPDX-License-Identifier: Apache-2.0
// Turn records (workspace-format.md §3) and their lifecycle.

import type { Envelope, Mode, TurnKind } from "../../ipc/types";
import type { ApplyWarning, ChangedField, CreatedObject, KicadTurnResult, NetSummary, Ref, TurnSummary } from "../api";
import { ACCEPTANCE_MAX, type AcceptanceResult } from "../plans/acceptance";
import { extractNetChanges } from "../policy/hooks";
import type { AutoDecision } from "../auto-policy";

export type TurnStatus = "received" | "running" | "stopping" | "done" | "stopped" | "hard_stopped" | "abandoned" | "summarized" | "rolled_back" | "failed";

export interface ApplyRecord {
  run_id: string;
  target: string;
  /** Every file the engine actually wrote (`targets[]`): an op can reach further than the target
   * (a global `rename_net`, a sheet pin seeded in a child), and the summary must say so. */
  targets?: string[];
  expanded_sha256: string | null;
  net_diff: unknown;
  /** `added` counts BOM components only; power ports / PWR_FLAGs are net anchors and are counted apart.
   * `moved`: parts whose pose this apply changed (from the engine's `changed[].field === "at"`). */
  counts: { added: number; deleted: number; wires: number; power_ports?: number; moved?: number };
  /** What this apply drew (`per_op[].created`), in op order. */
  created?: CreatedObject[];
  /** Fields this apply replaced on objects that already existed (`per_op[].changed`). */
  changed?: ChangedField[];
  /** What the engine warned about while applying (`per_op[].warnings`), code and sentence. */
  warnings?: ApplyWarning[];
}

export interface TurnRecord {
  turn: number;
  task: number;
  message: string;
  refs: Ref[];
  mode: Mode;
  kind: TurnKind | null;
  headline: string;
  envelope: Envelope | null;
  plan_ref: string | null;
  plan_step: string | null;
  tools: { name: string; ok: boolean; bytes: number; ms: number }[];
  applies: ApplyRecord[];
  findings: unknown[];
  wall_active_ms: number;
  wall_waiting_ms: number;
  cost: { tokens: number; usd: number; input: number; cache_creation: number; cache_read: number; output: number };
  status: TurnStatus;
  /** Why the turn stopped: the human, a steer, or a stop-class hard stop (`auto-policy.ts`). */
  stop_reason?: "user" | "steered" | "budget" | "environment" | "provider_exhausted" | "context_exhausted";
  side_questions: string[];
  auto_decisions: AutoDecision[];
  checkpoint: number | null;
  started_at: string;
  ended_at?: string;
  context?: { used_before: number; used_after: number; compactions: { id: string; level: number; range: [number, number]; reclaimed: number }[] };
  external?: boolean;
  /** KiCad's own ERC after this turn's writes (advisory, `kicad_advisory`); absent = it was not asked. */
  kicad?: KicadTurnResult;
  /** Unwaived engine Errors the plan's gate step left behind (it reports them, it never blocks). */
  gate_errors_left?: number;
  /** How the plan's typed acceptance stood at this turn's gate step (engine results only). */
  acceptance?: AcceptanceResult[];
  /** Lead loop generation the turn started in; a force-stopped turn's late calls are refused (`LeadLoop.zombie`). */
  gen?: number;
  /** `turn_begin` succeeded in Rust for this turn (so `turn_end` must be sent). */
  began_in_rust?: boolean;
}

export function newTurnRecord(turn: number, task: number, message: string, refs: Ref[], mode: Mode, started_at: string): TurnRecord {
  return { turn, task, message, refs, mode, kind: null, headline: "", envelope: null, plan_ref: null, plan_step: null, tools: [], applies: [], findings: [], wall_active_ms: 0, wall_waiting_ms: 0, cost: { tokens: 0, usd: 0, input: 0, cache_creation: 0, cache_read: 0, output: 0 }, status: "received", side_questions: [], auto_decisions: [], checkpoint: null, started_at };
}

/** Named-net changes from the engine's net_diff of one or more applies (nameless auto nets are left out). */
export function netSummary(netDiffs: unknown[]): NetSummary {
  const out: NetSummary = { created: [], merged: [], split: [], renamed: [] };
  const push = (arr: string[], v: string | undefined) => { if (v && !arr.includes(v) && !/^(Net-\(|unconnected-\()/.test(v)) arr.push(v); };
  for (const nd of netDiffs) {
    for (const c of extractNetChanges({ net_diff: nd })) {
      if (c.kind === "Created") push(out.created, c.name);
      else if (c.kind === "Merged") { const from = (c.sources ?? []).map((x) => x.name).filter((n) => n && n !== c.into); push(out.merged, from.length && c.into ? `${from.join(" + ")} -> ${c.into}` : c.into ?? from.join(" + ")); }
      else if (c.kind === "Split") push(out.split, c.name);
      else if (c.kind === "Renamed") push(out.renamed, c.name && c.into ? `${c.name} -> ${c.into}` : c.into ?? c.name);
    }
  }
  return out;
}

/**
 * How much of what a turn drew and changed the summary keeps. Enough for the footer, the summary
 * card and the canvas highlight of a large block; a redraw of a whole sheet is reported by counts.
 */
export const SUMMARY_CREATED_MAX = 500;
export const SUMMARY_CHANGED_MAX = 200;
export const SUMMARY_WARNINGS_MAX = 200;

/** Everything the turn's applies created, in op order, deduplicated by uuid and bounded. */
export function turnCreated(applies: ApplyRecord[], max = SUMMARY_CREATED_MAX): CreatedObject[] {
  const out: CreatedObject[] = [];
  const seen = new Set<string>();
  for (const a of applies) for (const c of a.created ?? []) {
    if (seen.has(c.uuid) || out.length >= max) continue;
    seen.add(c.uuid);
    out.push(c);
  }
  return out;
}

/** Every field the turn's applies replaced, in op order; the last write to a field wins, bounded. */
export function turnChanged(applies: ApplyRecord[], max = SUMMARY_CHANGED_MAX): ChangedField[] {
  const out: ChangedField[] = [];
  const at = new Map<string, number>();
  for (const a of applies) for (const c of a.changed ?? []) {
    const k = `${c.sheet ?? ""}|${c.reference}|${c.field}`;
    const i = at.get(k);
    // A field written twice in one turn changed once, from the first before to the last after.
    if (i !== undefined) out[i] = { ...out[i], after: c.after };
    else if (out.length < max) { at.set(k, out.length); out.push(c); }
  }
  return out;
}

/**
 * Every warning the turn's applies carried, in op order, deduplicated on (code, message, sheet) so a
 * step re-run does not report the same nudge twice. Bounded like the other summary lists.
 */
export function turnWarnings(applies: ApplyRecord[], max = SUMMARY_WARNINGS_MAX): ApplyWarning[] {
  const out: ApplyWarning[] = [];
  const seen = new Set<string>();
  for (const a of applies) for (const w of a.warnings ?? []) {
    const k = `${w.code}|${w.message}|${w.sheet ?? ""}`;
    if (seen.has(k) || out.length >= max) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/** The files an apply wrote: the engine's `targets[]` when it reported them, else the target. */
export function applyFiles(a: ApplyRecord): string[] {
  return a.targets?.length ? a.targets : [a.target];
}

export function summaryOf(t: TurnRecord, duration_ms: number): TurnSummary {
  const added = t.applies.reduce((a, x) => a + x.counts.added, 0);
  const deleted = t.applies.reduce((a, x) => a + x.counts.deleted, 0);
  const wires = t.applies.reduce((a, x) => a + x.counts.wires, 0);
  const powerPorts = t.applies.reduce((a, x) => a + (x.counts.power_ports ?? 0), 0);
  const moved = t.applies.reduce((a, x) => a + (x.counts.moved ?? 0), 0);
  // A turn that finished with unwaived engine Errors is not a plain "done": the gate is a report, so
  // the step succeeded, but the human is owed the distinction (a plan step that ends silently "done"
  // over three engine Errors reads as a clean result).
  const done: TurnSummary["outcome"] = (t.gate_errors_left ?? 0) > 0 ? "done_with_findings" : "done";
  const outcome: TurnSummary["outcome"] = t.status === "rolled_back" ? "rolled_back" : t.status === "done" || t.status === "summarized" ? done : t.status === "running" || t.status === "received" ? "running" : t.status === "abandoned" || t.status === "stopped" || t.status === "stopping" || t.status === "hard_stopped" ? "stopped" : "failed";
  // What was drawn and changed is accumulated over every apply of the turn, not only the last one:
  // a Build step usually writes several op-lists and the human is owed all of them.
  const created = turnCreated(t.applies);
  const changed = turnChanged(t.applies);
  // What the engine did differently from what was authored: reported, never a verdict (red line 6).
  const warnings = turnWarnings(t.applies);
  return { turn: t.turn, kind: t.kind ?? "question", mode: t.mode, headline: t.headline, outcome, applied: { components_added: added, components_deleted: deleted, wires_added: wires, power_ports_added: powerPorts, components_moved: moved, sheets: [...new Set(t.applies.flatMap(applyFiles))], nets: netSummary(t.applies.map((a) => a.net_diff)), ...(created.length ? { created } : {}), ...(changed.length ? { changed } : {}), ...(warnings.length ? { warnings } : {}) }, ...(t.kicad ? { kicad: t.kicad } : {}), ...(t.acceptance?.length ? { acceptance: t.acceptance.slice(0, ACCEPTANCE_MAX) } : {}), cost_usd: t.cost.usd, tokens: t.cost.tokens, duration_ms, checkpoint: t.checkpoint ?? undefined };
}

/** Deterministic rollback-card content (agent-runtime.md §4.3): no model involved. */
export function rollbackImpact(turns: TurnRecord[], beforeTurn: number): { turns: number[]; added: number; deleted: number; moved: number; files: string[]; external: number[] } {
  const affected = turns.filter((t) => t.turn >= beforeTurn && t.applies.length > 0 || (t.turn >= beforeTurn && t.external));
  return {
    turns: affected.map((t) => t.turn),
    added: affected.reduce((a, t) => a + t.applies.reduce((b, x) => b + x.counts.added, 0), 0),
    deleted: affected.reduce((a, t) => a + t.applies.reduce((b, x) => b + x.counts.deleted, 0), 0),
    // A turn that only moved parts still undoes something: the card must not read as "0 added, 0 deleted".
    moved: affected.reduce((a, t) => a + t.applies.reduce((b, x) => b + (x.counts.moved ?? 0), 0), 0),
    files: [...new Set(affected.flatMap((t) => t.applies.flatMap(applyFiles)))],
    external: affected.filter((t) => t.external).map((t) => t.turn),
  };
}

/** Micro-edit fast path (agent-runtime.md §11): one deterministic pattern, no model. */
export function parseMicroEdit(text: string, selection: Ref[]): { reference: string; field: string; value: string } | null {
  const m = /^\s*(?:set\s+)?([A-Z]{1,4}\d{1,4})\s*(?:\.|\s)\s*(value|footprint|Value|Footprint)\s*(?:=|:|to)\s*("?)([^\s"]{1,32})\3\s*$/i.exec(text);
  if (m) return { reference: m[1].toUpperCase(), field: m[2].toLowerCase(), value: m[4] };
  // "請幫我把 C2 換成 10u" / "C2 改為 100nF" / "C2 を 10u にして" — a designator, a value, and only filler words around them.
  const cjk = /^(?<pre>.*?)\b(?<ref>[A-Z]{1,4}\d{1,4})\b(?<mid>.*?)(?<val>\d+(?:\.\d+)?\s?(?:[pnuµμmkKMRr]|meg)?(?:F|H|Ω|ohm|V|A|Hz)?)(?<post>[^\d]*)$/i.exec(text);
  if (cjk?.groups) {
    const filler = /^[\s，,。.!！、的值をにへ請请幫帮我把將将换換改成為为更設设定置修正變变更してくださいお願いしますにしてplease|setchangeupdatetheofvaluecapacitorresistor電容电容電阻电阻容量阻值改成改為換成换成]*$/i;
    const around = `${cjk.groups.pre} ${cjk.groups.mid} ${cjk.groups.post}`.replace(/\s+/g, "");
    if (filler.test(around) && /[換换改變变更設设置定にして]|set|change|update/i.test(text)) {
      return { reference: cjk.groups.ref.toUpperCase(), field: "value", value: cjk.groups.val.replace(/\s+/g, "") };
    }
  }
  if (selection.length === 1 && selection[0].kind === "component") {
    const s = /^\s*(?:value|footprint)?\s*(?:=|:|to)?\s*("?)([0-9][^\s"]{0,31})\1\s*$/i.exec(text);
    if (s) return { reference: selection[0].ref, field: "value", value: s[2] };
  }
  return null;
}
