// SPDX-License-Identifier: Apache-2.0
// M3 tool executors (web.fetch consent flow, facts.write checks, docs.pdf_text,
// parts.bom, parts.decision) against a fake IPC, plus the manifest gating.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { name: string; args: Record<string, unknown> }[] = [];
const approved = new Set<string>();
class Failure extends Error { constructor(public error: { code: string; message: string; evidence?: unknown }) { super(error.code); } }
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    switch (name) {
      case "web_fetch_text": {
        const origin = new URL(String(args.url)).origin;
        if (!approved.has(origin)) throw new Failure({ code: "CONSENT_REQUIRED", message: "needs consent", evidence: { origin } });
        return { sha256: "a".repeat(64), url: args.url, content_type: "text/html", size: 5, kind: "html", text: "hello", truncated: false, note: null, trust: "untrusted" };
      }
      case "fetch_origin_approve": approved.add(String(args.origin)); return null;
      case "pdf_text": return { sha256: args.sha256, total_pages: 2, pages: [{ n: 1, text: "VDD 1.7 to 3.6 V" }], missing_pages: [], truncated: false, hint: null, trust: "untrusted" };
      case "sidecar_write": {
        const w = args.write as { kind: string; facts?: { facts: { quote: string }[] } };
        if (w.kind === "facts" && w.facts?.facts.some((f) => f.quote === "not on page")) throw new Failure({ code: "FACT_QUOTE_MISMATCH", message: "quote not found" });
        return null;
      }
      case "parts_bom": return { lines: [], totals: { lines: 0, parts: 0, with_lcsc: 0, without_lcsc: 0 }, findings: [], lock_written: args.lock, drift: null, claim: true, note: "" };
      default: return null;
    }
  }),
}));

import { executeTool, type ToolContext } from "../tools/registry";
import { toolDef, toolTable } from "../tools/manifest";
import { applyPartsDecision, factsConfirm, normalizeDecisionItems, parseDecisions, partsDecisionCard, substitutedFindings } from "../tools/parts-decision";

function ctx(answer: { action_id: string; free_text?: string; consent_event_id?: string } = { action_id: "approve", consent_event_id: "ce-1" }): ToolContext & { cards: unknown[] } {
  const cards: unknown[] = [];
  return {
    cards,
    projectKey: "pk", auth: () => ({ build_session: null, role: "lead" }), turn: 1, step: "s", role: "lead",
    skills: {} as ToolContext["skills"], plans: {} as ToolContext["plans"], selection: () => [],
    askCard: async (make) => { cards.push(make(1)); return answer; },
    sheets: () => ["root.kicad_sch"], planState: () => "none", policy: () => "review", emitCard: () => undefined, emitFocus: () => undefined, onStatus: () => undefined,
    turnBegin: async () => ({}), ledger: async () => undefined, expectedMerges: () => [], unlockedGrant: () => undefined, vision: false,
  };
}

beforeEach(() => { calls.length = 0; approved.clear(); });

describe("manifest gating (per-tool capability, no M3 switch)", () => {
  it("web.fetch, docs.pdf_text, facts.write and parts.bom are in the lead table without any flag; web.search still needs the capability", () => {
    const names = toolTable("plan", "lead").map((t) => t.name);
    for (const n of ["web.fetch", "docs.pdf_text", "facts.write", "parts.bom", "parts.decision"]) expect(names, n).toContain(n);
    expect(names).not.toContain("web.search");
    expect(toolTable("plan", "lead", { webSearch: true }).map((t) => t.name)).toContain("web.search");
    expect(toolTable("plan", "facts").map((t) => t.name)).toContain("web.fetch");
  });
});

describe("web.fetch consent flow", () => {
  it("asks once for a new origin, approves with the real consent event and retries", async () => {
    const c = ctx();
    const r = await executeTool(toolDef("web.fetch")!, { url: "https://docs.example/ds.html" }, c);
    expect(r.ok).toBe(true);
    expect((r.data as { text: string }).text).toBe("hello");
    const card = c.cards[0] as { kind: string; data: { subtype: string; origin: string }; actions: { id: string; consent?: unknown }[] };
    expect(card.kind).toBe("provider_consent");
    expect(card.data.subtype).toBe("web_origin");
    expect(card.data.origin).toBe("https://docs.example");
    expect(card.actions[0].consent).toBeTruthy();
    const approve = calls.find((x) => x.name === "fetch_origin_approve");
    expect(approve?.args).toEqual({ origin: "https://docs.example", consent_event_id: "ce-1" });
    expect(calls.filter((x) => x.name === "web_fetch_text")).toHaveLength(2);
    // Second fetch from the same origin: no card.
    const r2 = await executeTool(toolDef("web.fetch")!, { url: "https://docs.example/other" }, c);
    expect(r2.ok).toBe(true);
    expect(c.cards).toHaveLength(1);
  });
  it("a declined origin fails without approving anything", async () => {
    const c = ctx({ action_id: "reject" });
    const r = await executeTool(toolDef("web.fetch")!, { url: "https://evil.example/x" }, c);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("CONSENT_DENIED");
    expect(calls.some((x) => x.name === "fetch_origin_approve")).toBe(false);
  });
  it("rejects non-http urls before touching the network", async () => {
    const r = await executeTool(toolDef("web.fetch")!, { url: "file:///etc/passwd" }, ctx());
    expect(r.error?.code).toBe("BAD_URL");
    expect(calls).toHaveLength(0);
  });
  it("web.search without the capability explains itself", async () => {
    const r = await executeTool(toolDef("web.search")!, { query: "x" }, ctx());
    expect(r.error?.code).toBe("TOOL_NOT_AVAILABLE");
  });
});

describe("facts.write / docs.pdf_text", () => {
  const sha = "b".repeat(64);
  it("rejects facts without page or quote, and without a source sha", async () => {
    const r = await executeTool(toolDef("facts.write")!, { mpn: "X", source: { sha256: sha }, facts: [{ key: "vdd", value: "3.3", quote: "VDD" }] }, ctx());
    expect(r.error?.code).toBe("FACT_PROVENANCE");
    const r2 = await executeTool(toolDef("facts.write")!, { mpn: "X", facts: [{ key: "vdd", value: "3.3", page: 1, quote: "VDD" }] }, ctx());
    expect(r2.error?.code).toBe("FACT_PROVENANCE");
    expect(calls.some((x) => x.name === "sidecar_write")).toBe(false);
  });
  it("writes a schema-2 payload and surfaces the Rust quote check", async () => {
    const ok = await executeTool(toolDef("facts.write")!, { mpn: "X", source: { sha256: sha, revision: "Rev 2" }, facts: [{ key: "vdd", value: "3.3", page: 1, quote: "VDD 1.7 to 3.6 V" }], pins: [{ number: "5", name: "VDD" }] }, ctx());
    expect(ok.ok).toBe(true);
    const w = calls.find((x) => x.name === "sidecar_write")!.args.write as { kind: string; mpn: string; facts: { source: { sha256: string }; pins: unknown[] } };
    expect(w.kind).toBe("facts");
    expect(w.facts.source.sha256).toBe(sha);
    expect(w.facts.pins).toHaveLength(1);
    const bad = await executeTool(toolDef("facts.write")!, { mpn: "X", source: { sha256: sha }, facts: [{ key: "k", value: "v", page: 1, quote: "not on page" }] }, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("FACT_QUOTE_MISMATCH");
  });
  it("docs.pdf_text passes the sha and filtered pages", async () => {
    const r = await executeTool(toolDef("docs.pdf_text")!, { sha256: sha, pages: [1, 0, -2, 2.5, 3] }, ctx());
    expect(r.ok).toBe(true);
    expect(calls[0]).toEqual({ name: "pdf_text", args: { sha256: sha, pages: [1, 3] } });
  });
});

describe("parts.bom / parts.decision", () => {
  it("parts.bom maps lock / against_lock", async () => {
    await executeTool(toolDef("parts.bom")!, { lock: true }, ctx());
    expect(calls[0]).toEqual({ name: "parts_bom", args: { project_key: "pk", lock: true, against_lock: null } });
    await executeTool(toolDef("parts.bom")!, { against_lock: true }, ctx());
    expect(calls[1].args.against_lock).toBe("bom.lock.json");
  });
  it("decision card answer becomes decisions + an op-list of properties / attributes", async () => {
    const items = [
      { ref: "C3", expected: { value: "100n", package: "0603", voltage: "50V" }, candidates: [{ lcsc: "C14663", mpn: "CL10B104KB8NNNC", value: "100nF", package: "0603", voltage: "50V" }], confidence: "low" },
      { ref: "U2", expected: { mpn: "AMS1117-3.3", package: "SOT-223" }, candidates: [], confidence: "none" },
      { ref: "R9", expected: { value: "4k7" }, candidates: [{ lcsc: "C1" }, { lcsc: "C2", value: "4.7k" }] },
    ];
    const c = ctx({ action_id: "apply", free_text: JSON.stringify({ decisions: [{ ref: "C3", choice: "accept" }, { ref: "U2", choice: "dnp" }, { ref: "R9", choice: "alternate", lcsc: "C2" }] }), consent_event_id: "ce-2" });
    const r = await executeTool(toolDef("parts.decision")!, { items, rationale: "low confidence" }, c);
    expect(r.ok).toBe(true);
    const d = r.data as { decisions: { ref: string; choice: string; lcsc?: string }[]; oplist: { ops: Record<string, unknown>[] } };
    expect(d.decisions.map((x) => x.choice)).toEqual(["accept", "dnp", "alternate"]);
    expect(d.oplist.ops[0]).toEqual({ op: "set_component_parameters", designator: "C3", parameters: { LCSC: "C14663", MPN: "CL10B104KB8NNNC" } });
    expect(d.oplist.ops[1]).toEqual({ op: "set_component_attributes", designator: "U2", dnp: true, in_bom: false });
    const alt = d.oplist.ops[2] as { parameters: Record<string, string> };
    expect(alt.parameters.LCSC).toBe("C2");
    expect(alt.parameters.Substitute).toBe("yes");
    expect(alt.parameters.SUBSTITUTED_PART).toContain("4k7");
    const card = c.cards[0] as { kind: string; actions: { id: string; consent?: unknown }[] };
    expect(card.kind).toBe("parts_decision");
    expect(card.actions.find((a) => a.id === "apply")?.consent).toBeTruthy();
  });
  it("defaults: the model's own confidence never preselects accept; only a datasheet fact does", () => {
    // `confidence: high` is the model's word about its own catalogue lookup: not enough.
    const items = normalizeDecisionItems([{ ref: "R1", expected: { value: "1k" }, actual: { lcsc: "C9", value: "1k" }, confidence: "high" }, { ref: "R2", expected: { value: "2k" } }]);
    expect(parseDecisions(items, undefined)).toEqual([{ ref: "R1", choice: "review", lcsc: "C9" }, { ref: "R2", choice: "no_part", lcsc: undefined }]);
    const reviewed = applyPartsDecision(partsDecisionCard(1, items), "apply");
    expect(reviewed.oplist.ops.map((o) => o.designator)).toEqual(["R2"]); // review writes nothing
    expect(reviewed.instruction).toContain("R1: needs a datasheet check");
    // The same item with a quote-verified datasheet fact behind it does preselect accept.
    const verified = normalizeDecisionItems([{ ref: "R1", expected: { value: "1k" }, actual: { lcsc: "C9", value: "1k" }, confidence: "high", verified_fields: ["value"] }]);
    expect(parseDecisions(verified, undefined)).toEqual([{ ref: "R1", choice: "accept", lcsc: "C9" }]);
    expect(applyPartsDecision(partsDecisionCard(1, verified), "apply").instruction).toContain("R1: accept C9");
    expect(applyPartsDecision(partsDecisionCard(1, items), "dismiss").oplist.ops).toHaveLength(0);
    expect(substitutedFindings({ findings: [{ code: "SUBSTITUTED_PART", refs: ["R9"], message: "m" }, { code: "OTHER" }] })).toHaveLength(1);
  });
  it("factsConfirm only trusts datasheet facts, and candidates keep an http(s) datasheet link", () => {
    const actual = { lcsc: "C6186", mpn: "AMS1117-3.3", value: "3.3V", package: "SOT-223", pins: 3 };
    const doc = { facts: [{ key: "value", value: " 3.3V ", page: 1, quote: "q" }, { key: "Package", value: "sot-223", page: 1, quote: "q" }, { key: "voltage", value: "12V", page: 1, quote: "q" }], pins: [{ number: "1", name: "GND" }, { number: "2", name: "OUT" }, { number: "3", name: "IN" }] };
    // Case and surrounding whitespace do not matter; a differently spelled value ("3.3 V") does —
    // a near-miss must not read as "the datasheet confirmed it".
    expect(factsConfirm(doc, actual)).toEqual(["value", "package", "pins"]);
    expect(factsConfirm({ facts: [{ key: "value", value: "3.3 V" }] }, actual)).toEqual([]);
    // A fact whose value disagrees confirms nothing; catalogue bookkeeping is never datasheet material.
    expect(factsConfirm({ facts: [{ key: "value", value: "5V" }, { key: "lcsc", value: "C6186" }] }, actual)).toEqual([]);
    expect(factsConfirm(null, actual)).toEqual([]);
    const [it0] = normalizeDecisionItems([{ ref: "U1", actual: { lcsc: "C6186", datasheet: "https://example.invalid/ds.pdf" }, candidates: [{ lcsc: "C1", datasheet: "javascript:alert(1)" }] }]);
    expect(it0.actual?.datasheet).toBe("https://example.invalid/ds.pdf");
    expect(it0.candidates.find((c) => c.lcsc === "C1")?.datasheet).toBeUndefined();
  });
});

describe("plan.write once per turn", () => {
  it("refuses the Lead's rewrite after the Architect wrote the plan in the same turn", async () => {
    const plans = { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) } as unknown as ToolContext["plans"];
    const plan = { schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", sheets: [{ file: "root.kicad_sch" }], net_naming: { rails: [] }, blocks: [{ id: "a", sheet: "root.kicad_sch", summary: "A", parts: [{ ref_prefix: "R", mpn: "RC0603FR-0710KL", value: "10k" }], nets_in: [], nets_out: [], acceptance: [] }], steps: [], envelope: { budgets: { components_added: 1 }, allowed_ops: [], structural: [] } };
    const arch = { ...ctx(), role: "architect", plans };
    const r1 = await executeTool(toolDef("plan.write")!, { plan }, arch);
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    const lead = { ...ctx(), role: "lead", plans };
    const r2 = await executeTool(toolDef("plan.write")!, { plan }, lead);
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("PLAN_ALREADY_WRITTEN");
    // A later turn may write again.
    const r3 = await executeTool(toolDef("plan.write")!, { plan }, { ...lead, turn: 2 });
    expect(r3.ok).toBe(true);
  });

  it("reports how many acceptance rows the harness derived, and drops the uncheckable warning once it did", async () => {
    const plans = { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) } as unknown as ToolContext["plans"];
    const block = { id: "a", sheet: "root.kicad_sch", summary: "A", parts: [{ ref_prefix: "R", mpn: "RC0603FR-0710KL", value: "10k" }], nets_in: [], nets_out: ["OUT"] };
    const base = { schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", sheets: [{ file: "root.kicad_sch" }], net_naming: { rails: [] }, steps: [], envelope: { budgets: { components_added: 1 }, allowed_ops: [], structural: [] } };
    // Prose acceptance only: one component_count and one net_has_pins row are restated from the block itself.
    const prose = await executeTool(toolDef("plan.write")!, { plan: { ...base, blocks: [{ ...block, acceptance: [{ type: "text", text: "R1 pulls OUT up." }] }] } }, { ...ctx(), role: "architect", plans });
    expect(prose.ok, JSON.stringify(prose)).toBe(true);
    const d = prose.data as { derived_acceptance?: number; derived_acceptance_note?: string; warnings?: unknown[] };
    expect(d.derived_acceptance).toBe(2);
    expect(d.derived_acceptance_note).toMatch(/component_count/);
    expect(d.warnings).toBeUndefined();
    // A block that declared a typed row of its own has nothing derived and nothing reported.
    const typed = await executeTool(toolDef("plan.write")!, { plan: { ...base, blocks: [{ ...block, acceptance: [{ type: "net_has_pins", net: "OUT", min: 2 }] }] } }, { ...ctx(), turn: 2, role: "architect", plans });
    expect((typed.data as { derived_acceptance?: number }).derived_acceptance).toBeUndefined();
  });

  it("warns about generic passives with no footprint without refusing the plan", async () => {
    const plans = { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) } as unknown as ToolContext["plans"];
    const base = { schema_version: 1, kind: "schematic", id: "p", version: 1, goal: "g", sheets: [{ file: "root.kicad_sch" }], net_naming: { rails: [] }, steps: [], envelope: { budgets: { components_added: 2 }, allowed_ops: [], structural: [] } };
    const parts = [{ ref_prefix: "C", lib_id: "Device:C", mpn: "CL10B104KB8NNNC", value: "100n" }, { ref_prefix: "R", lib_id: "Device:R", mpn: "RC0603FR-0710KL", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric" }];
    const block = { id: "a", sheet: "root.kicad_sch", summary: "A", parts, nets_in: [], nets_out: ["OUT"], acceptance: [{ type: "net_has_pins", net: "OUT", min: 2 }] };
    const r = await executeTool(toolDef("plan.write")!, { plan: { ...base, blocks: [block] } }, { ...ctx(), role: "architect", plans });
    // A warning, not an error: the draft is written and the card is shown either way.
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const w = (r.data as { warnings?: { code: string; parts?: string[] }[] }).warnings ?? [];
    const fp = w.find((x) => x.code === "PLAN_PART_FOOTPRINT_MISSING");
    expect(fp?.parts).toEqual(["a/C 100n: Device:C"]);
    // The resistor named its package, so it is not on the list.
    expect(fp?.parts?.some((x) => x.startsWith("a/R"))).toBe(false);
  });
});
