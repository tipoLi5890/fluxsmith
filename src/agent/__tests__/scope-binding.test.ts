// SPDX-License-Identifier: Apache-2.0
// Security review 2026-09-06: what a `scope` approval is bound to, and the sheet references that
// decide which file an op lands on. Every case here is a red-line 13/21 property, not a preference.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEnvelope, envelopeSha } from "../util";
import { hardStopCard } from "../cards";
import { resolveSheetRef } from "../tools/ops";
import { qualifyPlanStructural, normalizePlan } from "../plans/schema";
import type { Envelope } from "../../ipc/types";

// `new URL(dynamic, import.meta.url)` is rewritten by Vite's asset handling; resolve by hand.
const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(resolve(HERE, "../../..", "tests/fixtures/envelope-canonical.json"), "utf8")) as {
  envelope: Envelope;
  canonical_json: string;
  sha256: string;
};

describe("canonical envelope (P1-2)", () => {
  // The same string has to come out of Rust's `Envelope::canonical_json`; the Rust half of this
  // check is `session::tests::canonical_envelope_matches_the_shared_fixture`, over the same file.
  it("matches the fixture both sides are pinned to", () => {
    expect(canonicalEnvelope(fixture.envelope)).toBe(fixture.canonical_json);
    expect(envelopeSha(fixture.envelope)).toBe(fixture.sha256);
  });

  it("ignores properties Rust would drop, and depends on every one it keeps", () => {
    const withExtra = { ...fixture.envelope, note: "ignored", _internal: 1 };
    expect(canonicalEnvelope(withExtra)).toBe(fixture.canonical_json);
    for (const patch of [
      { sheets: ["other.kicad_sch"] },
      { allowed_ops: ["delete_component"] },
      { components_added_max: 13 },
      { components_deleted_max: 1 },
      { wires_max: 41 },
      { structural: ["delete_sheet:power.kicad_sch"] },
      { nets_renamable: [] },
      { rails: [] },
      { interfaces: [] },
      { instance_designators: {} },
      { source: "session_ceiling" },
    ]) {
      expect(envelopeSha({ ...fixture.envelope, ...patch })).not.toBe(fixture.sha256);
    }
  });

  it("orders instance_designators keys, so two spellings of one envelope hash alike", () => {
    const a = { ...fixture.envelope, instance_designators: { "/power/": ["C1", "U2"], "/": ["R1"] } };
    const b = { ...fixture.envelope, instance_designators: { "/": ["R1"], "/power/": ["C1", "U2"] } };
    expect(envelopeSha(a)).toBe(envelopeSha(b));
  });
});

describe("hard-stop card binding (P1-2)", () => {
  it("a scope card carries the sha of the envelope it is asking for", () => {
    const card = hardStopCard(3, "scope_widen", { widened: ["components_added_max: 40 > 12"] }, undefined, "scope", envelopeSha(fixture.envelope));
    const approve = card.actions.find((a) => a.id === "approve");
    // The consent event and the Rust grant are both recorded over this value (`src/agent/index.ts`),
    // and `begin_turn` refuses to widen for a grant that names a different envelope.
    expect(approve?.consent?.payload_sha256).toBe(fixture.sha256);
    expect((card.data as { payload_sha256: string }).payload_sha256).toBe(fixture.sha256);
  });

  it("cards with nothing to bind still identify themselves", () => {
    const a = hardStopCard(1, "budget", { exhausted: "tokens" }, undefined, "scope");
    const b = hardStopCard(1, "budget", { exhausted: "cost" }, undefined, "scope");
    expect((a.data as { payload_sha256: string }).payload_sha256).not.toBe((b.data as { payload_sha256: string }).payload_sha256);
  });
});

describe("resolveSheetRef (P2-3)", () => {
  const sheets = [
    { file: "root.kicad_sch", instance_path: "/", names: [] },
    { file: "analog.kicad_sch", instance_path: "/analog/", names: ["power"] },
    { file: "power.kicad_sch", instance_path: "/power_rails/", names: ["Power Rails"] },
  ];

  it("a sheet-symbol name never captures a ref a real file answers to", () => {
    // `names` is the Sheetname property out of the .kicad_sch: untrusted (red line 21). A symbol on
    // analog.kicad_sch called "power" must not route {"sheet": "power"} away from power.kicad_sch.
    expect(resolveSheetRef("power", sheets)).toBe("power.kicad_sch");
  });

  it("still resolves instance paths and unambiguous sheet names", () => {
    expect(resolveSheetRef("/analog/", sheets)).toBe("analog.kicad_sch");
    expect(resolveSheetRef("/", sheets)).toBe("root.kicad_sch");
    expect(resolveSheetRef("Power Rails", sheets)).toBe("power.kicad_sch");
  });

  it("leaves an ambiguous or unknown ref to the engine", () => {
    const ambiguous = [
      { file: "a.kicad_sch", names: ["shared"] },
      { file: "b.kicad_sch", names: ["shared"] },
    ];
    expect(resolveSheetRef("shared", ambiguous)).toBeUndefined();
    expect(resolveSheetRef("nothing", sheets)).toBeUndefined();
    // Already a file of the project: nothing to resolve.
    expect(resolveSheetRef("power.kicad_sch", sheets)).toBeUndefined();
  });
});

describe("plan structural qualification (P2-6)", () => {
  it("spells a bare verb over the plan's own sheets", () => {
    expect(qualifyPlanStructural(["delete_sheet"], ["a.kicad_sch", "b.kicad_sch"], [])).toEqual(["delete_sheet:a.kicad_sch", "delete_sheet:b.kicad_sch"]);
  });

  it("drops a bare verb a plan with no sheets could only have meant globally", () => {
    expect(qualifyPlanStructural(["delete_sheet", "add_sheet"], [], [])).toEqual([]);
  });

  it("leaves the verbs that have no file form alone", () => {
    // `structural_key` in session.rs emits a bare `delete_sheet_pin` / `resize_sheet`, so a
    // qualified ceiling entry for them would match the op nothing.
    expect(qualifyPlanStructural(["delete_sheet_pin", "resize_sheet"], ["a.kicad_sch"], [])).toEqual(["delete_sheet_pin", "resize_sheet"]);
  });

  it("normalising a plan leaves no unqualified structural entry behind", () => {
    const plan = normalizePlan({
      id: "p1",
      sheets: [{ file: "power.kicad_sch", create: true }, { file: "root.kicad_sch" }],
      envelope: { structural: ["delete_sheet", "create_sheet:power.kicad_sch"] },
    });
    expect(plan.envelope.structural).toContain("delete_sheet:power.kicad_sch");
    expect(plan.envelope.structural).toContain("create_sheet:power.kicad_sch");
    expect(plan.envelope.structural.some((x) => !x.includes(":"))).toBe(false);
  });
});
