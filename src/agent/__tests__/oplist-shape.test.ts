// SPDX-License-Identifier: Apache-2.0
// Real run 21: three of the Fixer's first `ops.validate` calls came back
// `OPLIST_SCHEMA invalid op-list at '.': missing field 'ops'` — every op was inside a `groups`
// entry and the top level carried none. The shape is repaired on the way in, and a shape the
// repair cannot reach is answered with the shape itself instead of "fix the field named above".
import { describe, it, expect, vi } from "vitest";
import { OPLIST_MINIMAL_SHAPE, oplistShapeRemediation, reshapeOplist } from "../tools/oplist-shape";
import { executeTool, type ToolContext } from "../tools/registry";
import { toolDef } from "../tools/manifest";

/** What the engine saw, and what it answers: an op-list without a top-level `ops` is refused. */
const seen: unknown[] = [];
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (_name: string, args: Record<string, unknown>) => {
    const req = (args as { request: { kind: string; oplist?: unknown } }).request;
    seen.push(req.oplist);
    const ops = (req.oplist as { ops?: unknown } | null)?.ops;
    if (!Array.isArray(ops)) {
      return { ok: false, data: null, error: { code: "OPLIST_SCHEMA", message: "invalid op-list at `.`: missing field `ops`", remediation: "fix the field named in the message" }, meta: {} };
    }
    return { ok: true, data: { ok: true, errors: [] }, error: null, meta: {} };
  }),
}));

function toolCtx(): ToolContext {
  return {
    projectKey: "pk", auth: () => ({ build_session: null, role: "fixer" }), turn: 1, step: "s", role: "fixer",
    skills: {} as ToolContext["skills"], plans: {} as ToolContext["plans"], selection: () => [],
    askCard: async () => ({ action_id: "approve" }),
    sheets: () => ["power.kicad_sch"], planState: () => "none", policy: () => "review",
    emitCard: () => undefined, emitFocus: () => undefined, onStatus: () => undefined,
    turnBegin: async () => ({}), ledger: async () => undefined, expectedMerges: () => [],
    unlockedGrant: () => undefined, vision: false,
  } as unknown as ToolContext;
}

const MOVE = { op: "move_component", designator: "C1", x_mil: 5350, y_mil: 2600 };

describe("op-list shape repair", () => {
  it("lifts ops out of the group entries and keeps the group each was written under", () => {
    // The exact argument fixer-sub-2a sent (run 21, turn 9).
    const o = reshapeOplist({ groups: [{ id: "fix_decap_c1", ops: [MOVE] }], protocol_version: "1.0" }) as { ops: Record<string, unknown>[]; groups: Record<string, unknown> };
    expect(o.ops).toEqual([{ ...MOVE, group: "fix_decap_c1" }]);
    expect(Object.keys(o.groups)).toEqual(["fix_decap_c1"]);
    expect((o.groups.fix_decap_c1 as { ops?: unknown }).ops).toBeUndefined();
    // A group written as a map, and one that names itself with `name` (fixer-sub-2e).
    const named = reshapeOplist({ groups: [{ name: "repair_power_findings", ops: [MOVE] }] }) as { ops: Record<string, unknown>[] };
    expect(named.ops[0].group).toBe("repair_power_findings");
    const asMap = reshapeOplist({ protocol_version: 1, groups: { fix: { origin_mil: [0, 0], ops: [MOVE] } } }) as { ops: Record<string, unknown>[] };
    expect(asMap.ops).toEqual([{ ...MOVE, group: "fix" }]);
    // An op that already names its group keeps the name it chose.
    const own = reshapeOplist({ groups: [{ id: "a", ops: [{ ...MOVE, group: "b" }] }] }) as { ops: Record<string, unknown>[] };
    expect(own.ops[0].group).toBe("b");
  });

  it("unwraps a single-key wrapper and takes a bare array as the ops", () => {
    expect(reshapeOplist({ oplist: { protocol_version: 1, ops: [MOVE] } })).toMatchObject({ ops: [MOVE] });
    expect(reshapeOplist({ output: { op_list: { ops: [MOVE] } } })).toMatchObject({ ops: [MOVE] });
    expect(reshapeOplist([MOVE])).toEqual({ protocol_version: 1, groups: {}, ops: [MOVE] });
    // A well-shaped list is not a wrapper, however few keys it has.
    expect(reshapeOplist({ ops: [MOVE] })).toEqual({ ops: [MOVE] });
    expect(reshapeOplist({ groups: {}, ops: [MOVE] })).toEqual({ groups: {}, ops: [MOVE] });
    // Nothing that reads as an op-list inside: left alone for the engine to refuse.
    expect(reshapeOplist({ note: "I could not do it" })).toEqual({ note: "I could not do it" });
    expect(reshapeOplist(null)).toBeNull();
  });

  it("the remediation shows the shape and quotes the keys that arrived", () => {
    const r = oplistShapeRemediation({ groups: [], protocol_version: "1.0" });
    expect(r).toContain(OPLIST_MINIMAL_SHAPE);
    expect(r).toContain(`"groups"`);
    expect(r).toContain(`"protocol_version"`);
    expect(oplistShapeRemediation([1, 2])).toContain("an array of 2 entries");
  });

  it("ops.validate repairs the run 21 shape before the engine sees it", async () => {
    seen.length = 0;
    const r = await executeTool(toolDef("ops.validate")!, { oplist: { groups: [{ id: "fix_decap_c1", ops: [MOVE] }], protocol_version: "1.0" } }, toolCtx());
    expect(r.ok).toBe(true);
    const sent = seen[0] as { protocol_version: number; ops: unknown[]; groups: Record<string, unknown> };
    expect(sent.protocol_version).toBe(1);
    expect(sent.ops).toHaveLength(1);
    expect(sent.groups.fix_decap_c1).toMatchObject({ origin_mil: [0, 0] });
  });

  it("a shape it cannot repair comes back with the shape, not with the engine's field hint", async () => {
    seen.length = 0;
    const r = await executeTool(toolDef("ops.validate")!, { oplist: { protocol_version: 1, note: "no ops" } }, toolCtx());
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("OPLIST_SCHEMA");
    expect(r.error?.remediation).toContain(OPLIST_MINIMAL_SHAPE);
    expect(r.error?.remediation).toContain(`"note"`);
  });
});
