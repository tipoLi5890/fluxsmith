// SPDX-License-Identifier: Apache-2.0
// What a Fixer dispatch is for, and what the brief it produces says.
//
// Real run 19 dispatched the Fixer twice in the gate step of one turn. Both dispatches carried
// `phase: "pre_apply"` — the call site's constant, not the findings' phase — and
// `Original OpList: {"protocol_version":1,"groups":{},"ops":[]}`, which is truthy and so passed every
// guard on the way. The findings (TEXT_OVERLAP x2, FIELD_OVER_OWN_BODY, ROW_MISALIGNED x3,
// DECAP_FAR x2) are all registered for `post_apply`, and nothing was repaired.
import { describe, it, expect } from "vitest";
import { fixerDispatch } from "../lead";
import { FIXER_MAP } from "../fixer-map";
import { drafterBrief, fixerBrief, postApplyRule } from "../subagents/roles";
import { TOOL_DEFS } from "../tools/manifest";
import { LEAD_CORE_RULES, ROLE_SYSTEM } from "../prompts/system";
import type { Envelope } from "../../ipc/types";
import type { Finding } from "../policy/types";

const f = (code: string, extra: Partial<Finding> = {}): Finding => ({ code, severity: "Warning", message: `${code} happened`, ...extra });

describe("fixer dispatch", () => {
  it("takes the phase from the findings, not from the call site", () => {
    const post = [f("TEXT_OVERLAP"), f("ROW_MISALIGNED"), f("DECAP_FAR")];
    // Every one of these is post-apply only, however the caller asked.
    expect(post.every((x) => FIXER_MAP[x.code]?.phases.includes("post_apply"))).toBe(true);
    expect(fixerDispatch(post, "pre_apply", false)?.phase).toBe("post_apply");
    expect(fixerDispatch(post, "pre_apply", true)?.phase).toBe("post_apply");
    // A code registered for both keeps the phase the caller is actually in.
    expect(fixerDispatch([f("DANGLING_ENDPOINT")], "pre_apply", true)?.phase).toBe("pre_apply");
    // Synthetic findings the map does not know (an invalid op-list) stay a pre-apply rewrite.
    expect(fixerDispatch([f("OPLIST_INVALID", { severity: "Error" })], "pre_apply", true)?.phase).toBe("pre_apply");
  });

  it("never briefs a pre-apply repair with no op-list, and drops findings no Fixer may repair", () => {
    // A pre-apply rewrite of nothing is nothing: with no ops the repair is about the sheet, whatever
    // the code. No dispatch this harness makes can reach the Fixer as pre_apply with an empty list.
    for (const code of ["OPLIST_INVALID", "TEXT_OVERLAP", "ERC_POWER_IN_UNDRIVEN", "DANGLING_ENDPOINT"]) {
      expect(fixerDispatch([f(code)], "pre_apply", false)?.phase ?? "post_apply").toBe("post_apply");
    }
    // `who: "librarian"` / `"lead"` / `"none"` rows never reach the Fixer...
    expect(fixerDispatch([f("UNRESOLVED_LIB_ID"), f("ERC_PIN_TO_PIN")], "pre_apply", true)).toBeNull();
    // ...but they no longer poison a batch that also holds something repairable.
    const mixed = fixerDispatch([f("ERC_PIN_TO_PIN"), f("ROW_MISALIGNED")], "pre_apply", false);
    expect(mixed?.findings.map((x) => x.code)).toEqual(["ROW_MISALIGNED"]);
    expect(mixed?.phase).toBe("post_apply");
  });

  it("briefs a post-apply repair with the sheet's state and the findings, not an empty op-list", () => {
    const findings = [f("DECAP_FAR", { refs: ["C9.1"], file: "power.kicad_sch", remediation: "place the cap at the pin it decouples" })];
    const b = fixerBrief({ protocol_version: 1, groups: {}, ops: [] }, findings, "power.kicad_sch", "post_apply", ["schematic-authoring#layout"], "symbols: 14, rails: +3V3, GND");
    expect(b.brief).not.toMatch(/Original OpList/);
    expect(b.brief).not.toMatch(/"ops":\[\]/);
    expect(b.brief).toMatch(/post_apply/);
    expect(b.brief).toMatch(/already on the sheet/);
    expect(b.brief).toMatch(/sch\.dryrun_scratch/);
    // The structured rows carry what the repair needs to address the object: file, refs, remediation.
    expect(b.brief).toMatch(/"file":"power\.kicad_sch"/);
    expect(b.brief).toMatch(/"refs":\["C9\.1"\]/);
    expect(b.brief).toMatch(/place the cap at the pin it decouples/);
    // The sheet state travels as untrusted evidence, never as part of the instruction.
    expect(b.untrusted).toMatch(/sch\.summary:/);
    expect(b.brief).not.toMatch(/symbols: 14/);
  });

  it("still hands a pre-apply repair the op-list it must rewrite", () => {
    const oplist = { protocol_version: 1, groups: {}, ops: [{ op: "place_component", designator: "R1" }] };
    const b = fixerBrief(oplist, [f("DANGLING_ENDPOINT", { severity: "Error" })], "root.kicad_sch", "pre_apply", []);
    expect(b.brief).toMatch(/Original OpList: \{"protocol_version":1/);
    expect(b.brief).toMatch(/Pre-apply: rewrite the op-list/);
    expect(b.brief).not.toMatch(/already on the sheet/);
  });
});

// Run 20's wiring step. The brief said "no deletions" while its own allowed_ops listed `delete_object`,
// which is the only op that clears a stale no-connect; the two budgets are different and the line now
// says so. And the rule that a block needs one typed acceptance row lived only in the Architect's role
// system prompt, so a Lead writing the plan itself (which is what run 20 did) never saw it.
describe("briefs and tool descriptions that a real run read wrong", () => {
  const envelope = (allowed_ops: string[]): Envelope => ({
    sheets: ["power.kicad_sch"], allowed_ops, components_added_max: 4, components_deleted_max: 0, wires_max: null,
    structural: [], nets_renamable: [], properties_changed_max: 8, components_moved_max: 8, refs_editable: [], rails: ["GND"], interfaces: [], instance_designators: {}, source: "plan:p@1",
  });
  const brief = (allowed_ops: string[]): string => drafterBrief({
    block: { id: "wiring", sheet: "power.kicad_sch", summary: "connect the blocks", parts: [], nets_in: [], nets_out: [], acceptance: [] },
    target: "power.kicad_sch", envelope: envelope(allowed_ops), lease: [], region_mil: [[800, 800], [3950, 4000]],
    group: "wiring", origin_mil: [800, 800], rails: ["GND"], conventions: [], summary: "",
  }).brief;

  it("tells the Drafter which deletions its envelope actually forbids", () => {
    const withDelete = brief(["add_net_label", "delete_object"]);
    expect(withDelete).toContain("no component deletions");
    expect(withDelete).toMatch(/delete_object may still remove a loose wire, label, junction, no_connect or text/);
    // Nothing to explain when the op is not on the list.
    expect(brief(["add_net_label"])).toContain("no component deletions.");
    expect(brief(["add_net_label"])).not.toMatch(/delete_object may still/);
    // An empty allowed_ops means every op is allowed (hooks.p2), so the note belongs there too.
    expect(brief([])).toMatch(/delete_object may still/);
  });

  // A duplicated local label that is not a rail used to fire RAIL_SCOPE_SPLIT and send the Fixer to
  // the rails section, whose only answer is a power port. The non-rail split is its own code now.
  it("routes a non-rail scope split to the scope section and a rail split to the rails section", () => {
    expect(FIXER_MAP.RAIL_SCOPE_SPLIT).toEqual({ phases: ["post_apply"], section: "net-naming#rails", who: "fixer" });
    expect(FIXER_MAP.LABEL_SCOPE_SPLIT).toEqual({ phases: ["post_apply"], section: "net-naming#scope", who: "fixer" });
    const rule = postApplyRule([f("LABEL_SCOPE_SPLIT")]);
    expect(rule).toMatch(/rename_net one side with `sheet`/);
    expect(rule).not.toMatch(/place_power_port/);
    expect(postApplyRule([f("RAIL_SCOPE_SPLIT")])).toMatch(/place_power_port/);
  });

  it("puts the typed-acceptance rule where a self-planning Lead reads it, not only in the Architect's role", () => {
    // `plan.write` is a Lead tool as well as an Architect tool, and run 20's Lead wrote the plan itself:
    // it dispatched no Architect, so ROLE_SYSTEM.architect (which carries the rule) was never sent.
    expect(TOOL_DEFS.find((d) => d.name === "plan.write")!.agents).toContain("lead");
    expect(ROLE_SYSTEM.architect).toMatch(/at least one typed row the engine can check/);
    expect(LEAD_CORE_RULES).toMatch(/at least one typed acceptance row the engine can check/);
    expect(LEAD_CORE_RULES).toMatch(/the gate can neither pass nor fail it/);
  });
});
