// SPDX-License-Identifier: Apache-2.0
// Parts decision card (agent-runtime.md §5 "自動配料", M3): the human — never
// the agent — decides per unresolved part between accept / DNP / alternate /
// review / no-part. Expected and actual are both what the agent read out of the
// JLC/EasyEDA catalogue: a claim, not a datasheet comparison, so `accept` is
// preselected only where a quote-verified datasheet fact backs the value and
// `review` (write nothing) is the default. The answer is turned into an op-list the Lead applies through the
// normal write path (sch.apply in Build), so hooks, envelope and ledger all
// see it. `SUBSTITUTED_PART` / `Substitute_Of` properties mark substitutes
// permanently; `parts.bom` reports them as SUBSTITUTED_PART warnings.

import type { Card } from "../api";
import { canonicalJson, sha256Hex } from "../util";

export const DECISION_FIELDS = ["mpn", "value", "package", "voltage", "capacitance", "tolerance", "pins", "lcsc", "stock", "price_usd", "basic"] as const;
export type DecisionField = (typeof DECISION_FIELDS)[number];
/** `review` = do not bind yet; the values still have to be checked against the datasheet. */
export type Choice = "accept" | "dnp" | "alternate" | "no_part" | "review";
export const CHOICES: readonly Choice[] = ["accept", "alternate", "review", "dnp", "no_part"];

export type Spec = Partial<Record<DecisionField, string | number | boolean | null>>;
export interface Candidate extends Spec {
  lcsc: string;
  /** Datasheet URL from the catalogue row, when it carries one (shown as a link on the card). */
  datasheet?: string;
}
export interface DecisionItem {
  ref: string;
  expected: Spec;
  /** The best low-confidence match (accept binds it); null when nothing was found. */
  actual: Candidate | null;
  candidates: Candidate[];
  confidence: "high" | "low" | "none";
  note?: string;
  /**
   * A datasheet fact (`facts.write`, quote-verified) confirms a compared value of `actual`. Only
   * then may the card pre-select `accept`: `confidence` is the model's own word about its own
   * catalogue lookup, and pre-accepting on it made the model the decider (SPEC M3: the human is).
   */
  verified?: boolean;
  /** Which fields the datasheet facts confirmed (shown next to the claim warning). */
  verified_fields?: DecisionField[];
}
export interface Decision { ref: string; choice: Choice; lcsc?: string }

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(v) : null);

function spec(v: unknown): Spec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: Spec = {};
  for (const f of DECISION_FIELDS) {
    const x = o[f];
    if (x === undefined || x === null || x === "") continue;
    out[f] = typeof x === "number" || typeof x === "boolean" ? x : String(x);
  }
  return out;
}

function candidate(v: unknown): Candidate | null {
  const s = spec(v);
  const lcsc = str(s.lcsc);
  if (!lcsc) return null;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ds = str(o.datasheet ?? o.datasheet_url);
  // Only an absolute http(s) URL becomes a link; anything else is dropped rather than rendered.
  return { ...s, lcsc, ...(ds && /^https?:\/\//i.test(ds) ? { datasheet: ds } : {}) };
}

/** Coerce the model's `items` into DecisionItem[] (drops entries without a ref). */
export function normalizeDecisionItems(raw: unknown): DecisionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionItem[] = [];
  for (const r of raw) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const ref = str(o.ref ?? o.designator ?? o.reference);
    if (!ref) continue;
    const candidates = (Array.isArray(o.candidates) ? o.candidates : []).map(candidate).filter((c): c is Candidate => c !== null);
    const actual = candidate(o.actual) ?? candidates[0] ?? null;
    const c = String(o.confidence ?? "");
    const vf = Array.isArray(o.verified_fields) ? (o.verified_fields as unknown[]).filter((f): f is DecisionField => DECISION_FIELDS.includes(f as DecisionField)) : [];
    out.push({ ref, expected: spec(o.expected ?? o), actual, candidates: actual && !candidates.some((x) => x.lcsc === actual.lcsc) ? [actual, ...candidates] : candidates, confidence: c === "high" || c === "low" ? c : actual ? "low" : "none", note: str(o.note) ?? undefined, ...(o.verified === true || vf.length ? { verified: true } : {}), ...(vf.length ? { verified_fields: vf } : {}) });
  }
  return out;
}

/** Fields whose expected and actual values differ (shown as the diff in the card). */
export function diffFields(expected: Spec, actual: Spec | null): DecisionField[] {
  if (!actual) return [];
  return DECISION_FIELDS.filter((f) => expected[f] !== undefined && actual[f] !== undefined && !same(expected[f], actual[f]));
}

/** Whitespace/case-insensitive value comparison, used by the diff and by the facts check. */
const same = (a: unknown, b: unknown): boolean => String(a).trim().toLowerCase().replace(/\s+/g, " ") === String(b).trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The preselected choice. `accept` only when a datasheet fact confirms a compared value: the
 * catalogue row and the model's own `confidence` are a claim, and a card that pre-accepts a claim
 * is how an unverified part reaches the BOM without anyone looking at it. Anything else with a
 * candidate defaults to `review` (decide nothing, write nothing); with no candidate, `no_part`.
 */
export function defaultChoice(item: DecisionItem): Choice {
  if (!item.actual) return "no_part";
  if (item.confidence === "high" && item.verified) return "accept";
  return "review";
}

/**
 * Fields of `actual` that a `facts.write` document confirms. Facts are quote-verified against the
 * datasheet PDF in Rust (`facts.rs`), so this is the only evidence on the card that is not the
 * model's own claim. Catalogue bookkeeping (LCSC, stock, price, Basic) is never datasheet material.
 */
export function factsConfirm(doc: unknown, actual: Spec | null): DecisionField[] {
  if (!actual || !doc || typeof doc !== "object") return [];
  const d = doc as { facts?: unknown; pins?: unknown };
  const facts = Array.isArray(d.facts) ? (d.facts as Record<string, unknown>[]) : [];
  const key = (k: unknown) => String(k ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: DecisionField[] = [];
  for (const f of DECISION_FIELDS) {
    if (f === "lcsc" || f === "stock" || f === "price_usd" || f === "basic") continue;
    const v = actual[f];
    if (v === undefined || v === null || v === "") continue;
    if (f === "pins" && Array.isArray(d.pins) && d.pins.length > 0 && same(d.pins.length, v)) { out.push(f); continue; }
    if (facts.some((x) => key(x.key) === f && same(x.value, v))) out.push(f);
  }
  return out;
}

export function partsDecisionCard(turn: number, items: DecisionItem[], rationale = ""): Card {
  return {
    id: "",
    kind: "parts_decision",
    turn,
    title: "card.parts_decision",
    body_md: rationale,
    data: { subtype: "parts_decision", items },
    actions: [
      { id: "apply", label_key: "card.parts_decision_apply", style: "primary", consent: { grant_kind: "user_action", payload_sha256: sha256Hex(canonicalJson(items.map((i) => ({ ref: i.ref, expected: i.expected })))) } },
      { id: "dismiss", label_key: "card.dismiss", style: "secondary" },
    ],
  };
}

/** Parse the card answer (free_text JSON `{decisions:[{ref,choice,lcsc?}]}`); missing refs take the default. */
export function parseDecisions(items: DecisionItem[], free_text: string | undefined): Decision[] {
  let given: Decision[] = [];
  try {
    const p = free_text ? (JSON.parse(free_text) as { decisions?: unknown }) : null;
    const arr = Array.isArray(p) ? p : Array.isArray(p?.decisions) ? p!.decisions : [];
    given = (arr as unknown[]).map((d) => {
      const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
      const choice = String(o.choice ?? "") as Choice;
      return { ref: String(o.ref ?? ""), choice: CHOICES.includes(choice) ? choice : "no_part", lcsc: str(o.lcsc) ?? undefined };
    });
  } catch { given = []; }
  return items.map((it) => {
    const g = given.find((d) => d.ref === it.ref);
    if (!g) return { ref: it.ref, choice: defaultChoice(it), lcsc: it.actual?.lcsc };
    if (g.choice === "alternate") {
      const cand = it.candidates.find((c) => c.lcsc === g.lcsc) ?? it.candidates[0];
      return cand ? { ref: it.ref, choice: "alternate", lcsc: cand.lcsc } : { ref: it.ref, choice: "no_part" };
    }
    if (g.choice === "accept") return it.actual ? { ref: it.ref, choice: "accept", lcsc: it.actual.lcsc } : { ref: it.ref, choice: "no_part" };
    return { ref: it.ref, choice: g.choice };
  });
}

function expectedLabel(e: Spec): string {
  return [e.mpn, e.value, e.package].filter((x) => x !== undefined && x !== null && x !== "").map(String).join(" ") || "(unspecified)";
}

/**
 * Turn the answered card into decisions + the op-list that records them on the
 * symbols. Only `set_component_parameters` (properties) and
 * `set_component_attributes` (dnp) are used, so the ops fit the source-bom
 * envelope (`properties_changed.other`, `attributes_changed`).
 */
export function applyPartsDecision(cardOrData: Card | { items: DecisionItem[] }, action_id: string, free_text?: string): { decisions: Decision[]; oplist: { ops: Record<string, unknown>[] }; instruction: string } {
  const data = ("kind" in cardOrData ? (cardOrData.data as { items?: unknown }) : cardOrData) ?? {};
  const items = normalizeDecisionItems((data as { items?: unknown }).items ?? []);
  if (action_id !== "apply") return { decisions: [], oplist: { ops: [] }, instruction: "" };
  const decisions = parseDecisions(items, free_text);
  const ops: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const d of decisions) {
    const it = items.find((i) => i.ref === d.ref)!;
    switch (d.choice) {
      case "accept": {
        const c = it.candidates.find((x) => x.lcsc === d.lcsc) ?? it.actual;
        if (!c) break;
        ops.push({ op: "set_component_parameters", designator: d.ref, parameters: { LCSC: c.lcsc, ...(str(c.mpn) ? { MPN: String(c.mpn) } : {}) } });
        lines.push(`${d.ref}: accept ${c.lcsc}`);
        break;
      }
      case "alternate": {
        const c = it.candidates.find((x) => x.lcsc === d.lcsc);
        if (!c) break;
        const from = expectedLabel(it.expected);
        ops.push({ op: "set_component_parameters", designator: d.ref, parameters: { LCSC: c.lcsc, ...(str(c.mpn) ? { MPN: String(c.mpn) } : {}), Substitute: "yes", Substitute_Of: from, SUBSTITUTED_PART: `${from} -> ${str(c.mpn) ?? c.lcsc}` } });
        lines.push(`${d.ref}: substitute ${from} with ${str(c.mpn) ?? c.lcsc} (${c.lcsc})`);
        break;
      }
      case "dnp":
        ops.push({ op: "set_component_attributes", designator: d.ref, dnp: true, in_bom: false });
        lines.push(`${d.ref}: DNP`);
        break;
      case "no_part":
        ops.push({ op: "set_component_parameters", designator: d.ref, parameters: { Sourcing: "no-part" } });
        lines.push(`${d.ref}: no part (left unsourced)`);
        break;
      case "review":
        // Nothing is written: the human has not decided, the datasheet check comes first.
        lines.push(`${d.ref}: needs a datasheet check before any part is bound`);
        break;
    }
  }
  const instruction = ops.length
    ? `Apply the parts decisions the user made on the card (sch.apply with exactly these ops, then parts.bom {lock:true}): ${lines.join("; ")}. Op-list: ${JSON.stringify({ ops })}`
    : lines.length
      ? `The user bound no part on the card: ${lines.join("; ")}. Write nothing for these refs; verify them against the datasheet (parts.datasheet + docs.pdf_text + facts.write) and say so in the summary.`
      : "";
  return { decisions, oplist: { ops }, instruction };
}

/** SUBSTITUTED_PART warnings from a `parts.bom` result, in the Finding shape the review card lists. */
export function substitutedFindings(bom: unknown): { code: string; severity: string; message: string; refs: string[]; origin: "engine" }[] {
  const f = (bom as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(f)) return [];
  return f.filter((x) => (x as { code?: string }).code === "SUBSTITUTED_PART").map((x) => {
    const o = x as { message?: string; refs?: string[] };
    return { code: "SUBSTITUTED_PART", severity: "warning", message: o.message ?? "substituted part", refs: o.refs ?? [], origin: "engine" as const };
  });
}
