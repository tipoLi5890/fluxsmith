// SPDX-License-Identifier: Apache-2.0
// Typed acceptance evaluation (SPEC.md D-18, agent-runtime.md §2). A plan block declares what the
// drawn block must satisfy; the plan's gate step reports how each item stands.
//
// Red line 6: nothing here judges a circuit. Every verdict is read off engine results — net
// membership (`sch.net.members` / `net_map.pins`, both spelled `REF.PIN`), the `gate.run` findings,
// symbol positions and the symbol list (`sch.read`) and the net's own `flagged` bit (`sch.net`) — and
// an item the engine cannot answer is reported `na`, never guessed. The result is a report: a failed
// item never refuses a write and never becomes a hard stop.
//
// Two conventions the engine forces on this module:
//   - a block owns no refdes, so `ref_prefix` is satisfied when *some* component with that prefix
//     satisfies the item (a designator written into `ref_prefix`, "U1", is matched exactly);
//   - counts and distances are project-wide, because the engine attributes no object to a block.

import type { FindingLike } from "../findings";
import type { Acceptance, PlanBlock } from "./schema";

/**
 * `advisory` is the status of every row the harness itself restated from the plan (`deriveAcceptance`):
 * it is evaluated and shown like any other, but it never moves the verdict — a threshold the harness
 * wrote is not the engine's judgement of a circuit (red line 6).
 */
export type AcceptanceStatus = "pass" | "fail" | "na" | "advisory";

/** Why an item could not be evaluated; rendered from `chat.acceptanceNa.*` (never prose from here). */
export type AcceptanceNaReason = "informational" | "no_net_data" | "net_missing" | "no_position_data" | "no_symbol_data" | "unsupported";

/** One net as the engine reports it. `members` are `REF.PIN`; the rest is filled in when read. */
export interface AcceptanceNet {
  name: string;
  members: string[];
  /** Label texts on the net (`sch.net.labels`); absent = not read. */
  labels?: string[];
  /** The net carries at least one label (`net_map.labels`); absent = not read. */
  labeled?: boolean;
  /** A no-connect sits on the net (`sch.net.no_connect`); absent = not read. */
  no_connect?: boolean;
  /** A `PWR_FLAG` sits on the net (`sch.net.flagged` / `sch.nets[].flagged`); absent = not read. */
  flagged?: boolean;
}

/** One placed symbol, from `sch.read` (mil, engine coordinates). */
export interface AcceptanceSymbol { at_mil: [number, number]; value?: string }

/**
 * One power symbol as the engine lists it (`sch.read`): a power port or a PWR_FLAG. They carry a
 * reference and a value like any other symbol, but their pins are hidden from the netlist by
 * construction (`sch-net`: a symbol whose reference starts with `#` never appears in a net's
 * members), so nothing about them can be read off `nets`. The reference does not say which of the
 * two a symbol is (`place_pwr_flag` annotates out of the `#PWRnn` sequence too); `lib_id` and
 * `value` do, and `powerSymbolMatches` reads them.
 */
export interface AcceptancePowerSymbol { reference: string; value?: string; lib_id?: string }

export interface AcceptanceContext {
  /** Symbol origins by reference; only read when a block asks for `decoupling_near`. */
  symbols?: Record<string, AcceptanceSymbol>;
  /** Every `#PWR*` / `#FLG*` symbol in the project; only read when a block names such a prefix. */
  power?: AcceptancePowerSymbol[];
}

export interface AcceptanceResult {
  block: string;
  /** The acceptance type as the plan spelled it (`check_clean`, `text`, …). */
  type: string;
  status: AcceptanceStatus;
  /** The assertion restated in identifiers only (`pin_on_net U.2 = +3V3`); never localized prose. */
  label: string;
  /** What the engine actually reports (references, net names, counts); short and language-neutral. */
  detail?: string;
  na_reason?: AcceptanceNaReason;
  /** The row was restated from the plan's own declarations (`deriveAcceptance`), not written by the Architect. */
  derived?: boolean;
  /** What the engine answered for an `advisory` row: reported, never counted. */
  outcome?: "pass" | "fail" | "na";
}

/** Bound on what one turn summary carries (a long plan re-reports every block at every gate step). */
export const ACCEPTANCE_MAX = 200;
/** Sheets read per gate step; beyond it the items that need the rest report `na`. */
export const ACCEPTANCE_SHEETS_MAX = 8;
/** `sch.net` reads per gate step (only `no_connect` needs the per-net flag). */
export const ACCEPTANCE_NET_READS_MAX = 24;

// --------------------------------------------------------------------------- helpers

const up = (s: unknown): string => String(s ?? "").trim().toUpperCase();

/** `U1.2` -> `{ ref: "U1", pin: "2" }` (a pin number may be alphanumeric: `A1`, `PAD2`). */
export function splitMember(member: string): { ref: string; pin: string } | null {
  const i = member.lastIndexOf(".");
  return i > 0 && i < member.length - 1 ? { ref: member.slice(0, i), pin: member.slice(i + 1) } : null;
}

/** `U` matches U1 / U12 but not UART1; a prefix that already carries digits is a designator. */
export function refMatchesPrefix(reference: string, prefix: string): boolean {
  const p = up(prefix);
  const r = up(reference);
  if (!p || !r) return false;
  if (/\d/.test(p)) return r === p;
  return r.startsWith(p) && /^\d+$/.test(r.slice(p.length));
}

/** Net names are compared on their last path segment: the engine spells `/power/OUT`, plans say `OUT`. */
function netKey(name: string): string {
  const s = String(name ?? "").trim().replace(/^\/+/, "");
  const seg = s.split("/");
  return seg[seg.length - 1] || s;
}

/**
 * The net a plan name points at: exact name first, then the same last segment, then case-insensitively.
 * Several nets can carry one name (a local label repeated per sheet); the largest wins, ties by name.
 */
export function findNet(nets: readonly AcceptanceNet[], wanted: string): AcceptanceNet | null {
  const w = String(wanted ?? "").trim();
  if (!w) return null;
  const pools = [
    nets.filter((n) => n.name === w),
    nets.filter((n) => netKey(n.name) === netKey(w)),
    nets.filter((n) => netKey(n.name).toUpperCase() === netKey(w).toUpperCase()),
  ];
  for (const p of pools) {
    if (!p.length) continue;
    return [...p].sort((a, b) => b.members.length - a.members.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  }
  return null;
}

/** Every member of every net that sits on `<prefix>*.<pin>`, in engine order. */
function pinHits(nets: readonly AcceptanceNet[], prefix: string, pin: string): { ref: string; member: string; net: AcceptanceNet }[] {
  const want = String(pin ?? "").trim().toUpperCase();
  const out: { ref: string; member: string; net: AcceptanceNet }[] = [];
  for (const n of nets) for (const m of n.members) {
    const s = splitMember(m);
    if (s && s.pin.toUpperCase() === want && refMatchesPrefix(s.ref, prefix)) out.push({ ref: s.ref, member: m, net: n });
  }
  return out;
}

/**
 * A `#`-prefixed reference prefix (`#PWR`, `#FLG`): KiCad's power symbols. The engine keeps their
 * pins out of the netlist, so an item that names such a prefix is answered from `ctx.power` and the
 * net's own flags, never from `nets` membership.
 */
export function isPowerPrefix(prefix: string): boolean {
  return String(prefix ?? "").trim().startsWith("#");
}

/** A PWR_FLAG among the power symbols, as the engine spells it (value, or the library symbol). */
function isPwrFlag(s: AcceptancePowerSymbol): boolean {
  return up(s.value) === "PWR_FLAG" || /(^|:)PWR_FLAG$/i.test(String(s.lib_id ?? ""));
}

/**
 * What a `#`-prefixed acceptance prefix is asking about: the flags, the other power ports, or a
 * designator it spelled out.
 *
 * `#FLG` and `#PWR` are what a plan writes and what KiCad's own convention suggests, but they are
 * not what every flag is called: `place_pwr_flag` and `place_power_port` annotate out of one `#PWRnn`
 * sequence, so run 21's two PWR_FLAGs were `#PWR02` and `#PWR04` and `component_count #FLG >= 1`
 * read 0 over a sheet that had both. The reference seeds the symbol's uuid and is frozen (red line
 * 1), so the prefix is resolved by what the symbol *is* — its library symbol — and not by its name.
 * A prefix that carries digits is a designator the plan named exactly and is matched literally.
 */
export type PowerPrefixKind = "flag" | "port" | "other";
export function powerPrefixKind(prefix: string): PowerPrefixKind {
  const p = up(prefix);
  if (!p.startsWith("#") || /\d/.test(p)) return "other";
  const stem = p.slice(1).replace(/_/g, "");
  if (stem === "FLG" || stem === "FLAG" || stem === "PWRFLAG") return "flag";
  if (stem === "PWR" || stem === "PWRPORT" || stem === "POWER") return "port";
  return "other";
}

/** Does this power symbol answer for `prefix`? (`#FLG` = every PWR_FLAG; `#PWR` = every other port.) */
export function powerSymbolMatches(s: AcceptancePowerSymbol, prefix: string): boolean {
  switch (powerPrefixKind(prefix)) {
    case "flag": return isPwrFlag(s);
    // Every power symbol the engine writes is annotated `#PWRnn`, flags included, so the family
    // prefix is the whole set minus the flags — otherwise `#PWR >= 2` passes on two PWR_FLAGs.
    case "port": return !isPwrFlag(s) && refMatchesPrefix(s.reference, "#PWR");
    default: return refMatchesPrefix(s.reference, prefix);
  }
}

/** Every reference the netlist knows, power symbols (`#PWR01`) left out — they are anchors, not parts, and `ctx.power` carries them. */
export function referencesOf(nets: readonly AcceptanceNet[]): string[] {
  const out = new Set<string>();
  for (const n of nets) for (const m of n.members) {
    const s = splitMember(m);
    if (s && !s.ref.startsWith("#")) out.add(s.ref);
  }
  return [...out].sort();
}

/** `check_clean` codes: an exact code, or a `PREFIX_*` wildcard. */
function codeMatches(code: string, want: string): boolean {
  return want.endsWith("*") ? code.startsWith(want.slice(0, -1)) : code === want;
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]));
}

// --------------------------------------------------------------------------- evaluation

/**
 * One block's acceptance against the engine's own answers.
 *
 * `nets` is the netlist as the engine reported it, `findings` the unwaived rows of the final
 * `gate.run` (Error / Warning), `ctx` the extra reads a type needs. Results keep the plan's order.
 */
export function evaluateAcceptance(
  block: Pick<PlanBlock, "id" | "acceptance">,
  nets: readonly AcceptanceNet[],
  findings: readonly FindingLike[],
  ctx: AcceptanceContext = {},
): AcceptanceResult[] {
  const items = Array.isArray(block.acceptance) ? block.acceptance : [];
  return items.map((a) => advisoryIfDerived(evaluateItem(block.id, a as Acceptance & Record<string, unknown>, nets, findings, ctx)));
}

/**
 * A row the harness restated from the plan's own parts and nets is reported, never counted: its
 * threshold (`net_has_pins >= 2`, `component_count >= n`) is the harness's restatement, not something an
 * engineer wrote and not something the engine decided, so letting it fail a plan would make the harness
 * judge the circuit (red line 6). The engine's own answer travels along in `outcome`.
 */
function advisoryIfDerived(r: AcceptanceResult): AcceptanceResult {
  if (!r.derived || r.status === "advisory") return r;
  return { ...r, status: "advisory", outcome: r.status };
}

function evaluateItem(
  blockId: string,
  a: Acceptance & Record<string, unknown>,
  nets: readonly AcceptanceNet[],
  findings: readonly FindingLike[],
  ctx: AcceptanceContext,
): AcceptanceResult {
  const type = String(a?.type ?? "unknown");
  const base = { block: blockId, type, ...(a?.derived === true ? { derived: true } : {}) };
  const pass = (label: string, detail?: string): AcceptanceResult => ({ ...base, status: "pass", label, ...(detail ? { detail } : {}) });
  const fail = (label: string, detail?: string): AcceptanceResult => ({ ...base, status: "fail", label, ...(detail ? { detail } : {}) });
  const na = (label: string, reason: AcceptanceNaReason, detail?: string): AcceptanceResult => ({ ...base, status: "na", label, na_reason: reason, ...(detail ? { detail } : {}) });
  const noNets = nets.length === 0;

  switch (type) {
    // A sentence the Architect wrote: informational by construction (schema.ts), never a verdict.
    case "text":
      return na(`text ${String(a.text ?? "").slice(0, 120)}`.trim(), "informational");

    case "pin_on_net": {
      const prefix = up(a.ref_prefix);
      const pin = String(a.pin ?? "");
      const wanted = String(a.net ?? "");
      const label = `pin_on_net ${prefix}.${pin} = ${wanted}`;
      if (noNets) return na(label, "no_net_data");
      // `#FLG1.1` / `#PWR01.1`: a power symbol's pin is hidden from the netlist by construction, so
      // `nets` can never carry it — a real run failed `#FLG.1 = USB_5V` with "no #FLG*.1" over a
      // PWR_FLAG that was on the net. Two other engine facts answer it: the symbol list, and what
      // the engine reports about the net itself.
      if (isPowerPrefix(prefix)) {
        const power = ctx.power;
        if (!power) return na(label, "no_symbol_data");
        const found = power.filter((s) => powerSymbolMatches(s, prefix));
        if (!found.length) return fail(label, `no ${prefix}*`);
        const target = findNet(nets, wanted);
        if (!target) return fail(label, `no net ${wanted}`);
        // A PWR_FLAG names nothing: "a PWR_FLAG sits on this net" is the engine's own `flagged` bit.
        const flags = found.filter(isPwrFlag);
        if (flags.length) {
          if (target.flagged === undefined) return na(label, "no_net_data", flags[0].reference);
          return target.flagged ? pass(label, `${flags[0].reference} on ${target.name}`) : fail(label, `${target.name} not flagged`);
        }
        // A power port names the net it drives — that is the engine's driver ladder (a power pin
        // outranks every label), not an inference of ours — so the port whose value is that name is on it.
        const port = found.find((s) => netKey(String(s.value ?? "")).toUpperCase() === netKey(target.name).toUpperCase());
        if (port) return pass(label, `${port.reference} ${port.value ?? ""}`.trim());
        return fail(label, found.slice(0, 3).map((s) => `${s.reference} ${s.value ?? ""}`.trim()).join(", "));
      }
      const hits = pinHits(nets, prefix, pin);
      if (!hits.length) return fail(label, `no ${prefix}*.${pin}`);
      const net = findNet(nets, wanted);
      if (!net) return fail(label, `no net ${wanted}`);
      const on = hits.filter((h) => h.net === net);
      if (on.length) return pass(label, on.map((h) => h.member).slice(0, 3).join(", "));
      return fail(label, hits.slice(0, 3).map((h) => `${h.member} = ${h.net.name}`).join(", "));
    }

    case "net_has_pins": {
      const wanted = String(a.net ?? "");
      const min = Number(a.min ?? 0);
      const label = `net_has_pins ${wanted} >= ${min}`;
      if (noNets) return na(label, "no_net_data");
      const net = findNet(nets, wanted);
      if (!net) return fail(label, `no net ${wanted}`);
      const n = net.members.length;
      return n >= min ? pass(label, `${n}`) : fail(label, `${n}: ${net.members.slice(0, 4).join(", ")}`);
    }

    case "nets_disjoint": {
      const wanted = (Array.isArray(a.nets) ? a.nets : []).map((x) => String(x));
      const label = `nets_disjoint ${wanted.join(", ")}`;
      if (noNets) return na(label, "no_net_data");
      const found = wanted.map((w) => ({ w, net: findNet(nets, w) }));
      const present = found.filter((f) => f.net);
      const missing = found.filter((f) => !f.net).map((f) => f.w);
      // None of the names exists: the block draws none of them yet, and there is nothing to compare.
      if (!present.length) return na(label, "net_missing", missing.length ? `no net ${missing.join(", ")}` : undefined);
      // A missing name next to a present one is how a merge shows up in the netlist: the pins are
      // still there, under the other name.
      if (missing.length) return fail(label, `no net ${missing.join(", ")}`);
      if (present.length < 2) return na(label, "net_missing");
      for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
        const x = present[i].net!;
        const y = present[j].net!;
        if (x === y) return fail(label, `${present[i].w} = ${present[j].w} (${x.name})`);
        const shared = x.members.filter((m) => y.members.includes(m));
        if (shared.length) return fail(label, `${present[i].w} + ${present[j].w}: ${shared.slice(0, 3).join(", ")}`);
      }
      return pass(label, present.map((p) => `${p.net!.name} ${p.net!.members.length}`).join(", "));
    }

    case "component_count": {
      const prefix = up(a.prefix);
      const min = a.min === undefined ? null : Number(a.min);
      const max = a.max === undefined ? null : Number(a.max);
      const bounds = min !== null && max !== null ? `${min}..${max}` : min !== null ? `>= ${min}` : max !== null ? `<= ${max}` : "any";
      const label = `component_count ${prefix} ${bounds}`;
      // Grouping is a plan concept: the engine attributes no symbol to a block.
      if (a.in_group) return na(label, "unsupported", String(a.in_group));
      // Power symbols carry no netlist reference, so they are counted off the symbol list the gate
      // read (`sch.read`): `#FLG 1..1` read 0 over a PWR_FLAG that was placed on the sheet.
      if (isPowerPrefix(prefix)) {
        const power = ctx.power;
        if (!power) return na(label, "no_symbol_data");
        const refs = new Set(power.filter((s) => powerSymbolMatches(s, prefix)).map((s) => up(s.reference)));
        const okPower = (min === null || refs.size >= min) && (max === null || refs.size <= max);
        return okPower ? pass(label, `${refs.size}`) : fail(label, `${refs.size}`);
      }
      if (noNets) return na(label, "no_net_data");
      const n = referencesOf(nets).filter((r) => refMatchesPrefix(r, prefix)).length;
      const ok = (min === null || n >= min) && (max === null || n <= max);
      return ok ? pass(label, `${n}`) : fail(label, `${n}`);
    }

    case "check_clean": {
      const codes = (Array.isArray(a.codes) ? a.codes : []).map((x) => String(x));
      const label = `check_clean ${codes.join(", ")}`;
      const hitCounts = new Map<string, number>();
      for (const f of findings) if (codes.some((c) => codeMatches(f.code, c))) hitCounts.set(f.code, (hitCounts.get(f.code) ?? 0) + 1);
      if (!hitCounts.size) return pass(label);
      return fail(label, [...hitCounts].slice(0, 4).map(([c, n]) => (n > 1 ? `${c} x${n}` : c)).join(", "));
    }

    case "decoupling_near": {
      const prefix = up(a.ref_prefix);
      const pin = String(a.pin ?? "");
      const maxDist = Number(a.max_dist_mil ?? 0);
      const spec = a.spec ? ` ${String(a.spec)}` : "";
      const label = `decoupling_near ${prefix}.${pin} <= ${maxDist}mil${spec}`;
      if (noNets) return na(label, "no_net_data");
      const hits = pinHits(nets, prefix, pin);
      if (!hits.length) return fail(label, `no ${prefix}*.${pin}`);
      const symbols = ctx.symbols;
      if (!symbols) return na(label, "no_position_data");
      // Distance is measured between symbol origins: the engine hands out pin coordinates only per
      // component (`sch.component`), and the gate reads whole sheets (`sch.read`).
      let nearest: { d: number; line: string } | null = null;
      let noCaps: string | null = null;
      let noPosition = false;
      for (const h of hits) {
        const at = symbols[h.ref]?.at_mil;
        const caps = h.net.members.map(splitMember).filter((m): m is { ref: string; pin: string } => !!m && refMatchesPrefix(m.ref, "C"));
        if (!caps.length) { noCaps ??= `no C on ${h.net.name}`; continue; }
        if (!at) { noPosition = true; continue; }
        for (const c of caps) {
          const cat = symbols[c.ref]?.at_mil;
          if (!cat) { noPosition = true; continue; }
          const d = dist(at, cat);
          const line = `${c.ref}${symbols[c.ref]?.value ? ` ${symbols[c.ref]!.value}` : ""} ${d}mil`;
          if (d <= maxDist) return pass(label, line);
          if (!nearest || d < nearest.d) nearest = { d, line };
        }
      }
      if (nearest) return fail(label, nearest.line);
      if (noPosition) return na(label, "no_position_data");
      return fail(label, noCaps ?? undefined);
    }

    case "label_on_pin": {
      const prefix = up(a.ref_prefix);
      const pin = String(a.pin ?? "");
      const wanted = String(a.net ?? "");
      const label = `label_on_pin ${prefix}.${pin} = ${wanted}`;
      if (noNets) return na(label, "no_net_data");
      const net = findNet(nets, wanted);
      if (!net) return fail(label, `no net ${wanted}`);
      const on = pinHits(nets, prefix, pin).filter((h) => h.net === net);
      if (!on.length) return fail(label, `no ${prefix}*.${pin} on ${net.name}`);
      const labeled = net.labels ? net.labels.length > 0 : net.labeled;
      if (labeled === undefined) return na(label, "no_net_data", on[0].member);
      return labeled ? pass(label, on[0].member) : fail(label, `${on[0].member}: no label on ${net.name}`);
    }

    case "no_connect": {
      const prefix = up(a.ref_prefix);
      const pins = (Array.isArray(a.pins) ? a.pins : []).map((x) => String(x));
      const label = `no_connect ${prefix}.${pins.join(", ")}`;
      if (noNets) return na(label, "no_net_data");
      const missing: string[] = [];
      const wired: string[] = [];
      let unknown = false;
      for (const p of pins) {
        const hits = pinHits(nets, prefix, p);
        if (!hits.length) { missing.push(`${prefix}*.${p}`); continue; }
        if (hits.some((h) => h.net.no_connect === true)) continue;
        if (hits.every((h) => h.net.no_connect === undefined)) { unknown = true; continue; }
        wired.push(hits[0].member);
      }
      if (missing.length) return fail(label, `no ${missing.slice(0, 4).join(", ")}`);
      if (wired.length) return fail(label, wired.slice(0, 4).join(", "));
      if (unknown) return na(label, "no_net_data");
      return pass(label, `${pins.length}`);
    }

    default:
      return na(`${type}`, "unsupported");
  }
}

/**
 * Pass / fail / n-a counts of a set of results (the turn footer and `system.plan_done` show these).
 * Only rows the Architect wrote are counted: the harness-restated ones are tallied apart as `advisory`,
 * so nothing the harness authored can pass or fail a plan.
 */
export function acceptanceCounts(results: readonly AcceptanceResult[]): { passed: number; failed: number; na: number; advisory: number } {
  let passed = 0, failed = 0, na = 0, advisory = 0;
  for (const r of results) {
    if (r.status === "advisory") advisory++;
    else if (r.status === "pass") passed++;
    else if (r.status === "fail") failed++;
    else na++;
  }
  return { passed, failed, na, advisory };
}

/**
 * Overall verdict of a set of results (one block's, or the whole plan's). `unverified` is not a
 * pass: rows that are all `na` — `text` sentences, or types the engine could not answer — were
 * checked by nothing at all. A real run closed a plan on eleven `na` rows over a schematic with no
 * symbols in it, which read exactly like a clean pass. Red line 6 still holds: this only counts the
 * engine's own answers, it never judges a circuit.
 */
export type AcceptanceVerdict = "pass" | "fail" | "unverified";
export function acceptanceVerdict(counts: { passed: number; failed: number; na: number; advisory?: number }): AcceptanceVerdict {
  if (counts.failed > 0) return "fail";
  if (counts.passed > 0) return "pass";
  return "unverified";
}

/**
 * i18n key of the acceptance line on `system.plan_done`: the counts when the engine checked
 * something, otherwise a line that says nothing was verified. A plan that declared no acceptance at
 * all and one whose every row the engine could not answer are two different things to a human.
 */
export function acceptanceDoneKey(counts: { passed: number; failed: number; na: number; advisory?: number }): string {
  if (acceptanceVerdict(counts) !== "unverified") return "system.plan_done_acceptance";
  // Advisory rows were evaluated but count for nothing: a plan carrying only those has not been verified,
  // which is a different thing from a plan that declared no checkable acceptance at all.
  return counts.na > 0 || (counts.advisory ?? 0) > 0 ? "system.plan_done_acceptance_unverified" : "system.plan_done_acceptance_none";
}

/** Every net name an acceptance item points at (the gate reads only these in detail). */
export function acceptanceNetNames(blocks: readonly Pick<PlanBlock, "acceptance">[]): string[] {
  const out = new Set<string>();
  for (const b of blocks) for (const a of (b.acceptance ?? []) as (Acceptance & Record<string, unknown>)[]) {
    if (typeof a?.net === "string") out.add(a.net);
    if (Array.isArray(a?.nets)) for (const n of a.nets) if (typeof n === "string") out.add(n);
  }
  return [...out];
}

/** True when some block asks for a type that needs symbol positions (`sch.read`). */
export function acceptanceNeedsPositions(blocks: readonly Pick<PlanBlock, "acceptance">[]): boolean {
  return blocks.some((b) => (b.acceptance ?? []).some((a) => (a as { type?: string })?.type === "decoupling_near"));
}

/**
 * True when some block names a power prefix (`#PWR`, `#FLG`). Those rows are answered from the
 * symbol list and the nets' `flagged` bit, which the gate reads only when something asks for them.
 */
export function acceptanceNeedsPowerSymbols(blocks: readonly Pick<PlanBlock, "acceptance">[]): boolean {
  return blocks.some((b) => (b.acceptance ?? []).some((a) => {
    const x = a as { prefix?: unknown; ref_prefix?: unknown };
    return isPowerPrefix(String(x.prefix ?? "")) || isPowerPrefix(String(x.ref_prefix ?? ""));
  }));
}

/** The `<prefix>.<pin>` pairs a `no_connect` item names (their nets are read for the no-connect flag). */
export function acceptanceNoConnectPins(blocks: readonly Pick<PlanBlock, "acceptance">[]): { prefix: string; pin: string }[] {
  const out: { prefix: string; pin: string }[] = [];
  const seen = new Set<string>();
  for (const b of blocks) for (const a of (b.acceptance ?? []) as (Acceptance & Record<string, unknown>)[]) {
    if (a?.type !== "no_connect") continue;
    for (const p of (Array.isArray(a.pins) ? a.pins : [])) {
      const k = `${up(a.ref_prefix)}.${String(p)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ prefix: up(a.ref_prefix), pin: String(p) });
    }
  }
  return out;
}
