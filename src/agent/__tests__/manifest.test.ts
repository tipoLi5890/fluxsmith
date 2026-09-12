// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { renderToolTable, TOOL_DEFS, toolTable } from "../tools/manifest";
import { estimateTokens } from "../context/tokens";
import type { Role } from "../api";

const ROLES: Role[] = ["lead", "architect", "librarian", "drafter", "fixer", "reviewer", "explainer", "sourcer", "facts"];

describe("tool manifest", () => {
  it("every tool has phase, parallel, idempotency, tier, description ≤ 300 chars", () => {
    for (const t of TOOL_DEFS) {
      expect(t.phase, t.name).toBeTruthy();
      expect(["safe", "serial"]).toContain(t.parallel);
      expect(["natural", "key", "none"]).toContain(t.idempotency);
      expect(["R", "C", "D", "S", "H"]).toContain(t.tier);
      expect(t.description.length, t.name).toBeLessThanOrEqual(300);
      expect(/[^\x00-\x7f]/.test(t.description) && !/[≤→]/.test(t.description), `${t.name} non-ascii`).toBe(false);
    }
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no D tool outside lead/build; sourcer only parts.convert", () => {
    for (const mode of ["plan", "review"] as const) for (const role of ROLES) {
      expect(toolTable(mode, role, { m3: true }).filter((t) => t.tier === "D")).toHaveLength(0);
    }
    for (const role of ROLES.filter((r) => r !== "lead")) {
      const d = toolTable("build", role, { m3: true }).filter((t) => t.tier === "D").map((t) => t.name);
      expect(d.every((n) => role === "sourcer" && n === "parts.convert"), `${role}: ${d.join(",")}`).toBe(true);
    }
    expect(toolTable("build", "lead").some((t) => t.name === "sch.apply")).toBe(true);
  });

  it("build mode web.* only for librarian/facts/architect", () => {
    for (const role of ROLES) {
      const web = toolTable("build", role, { m3: true, webSearch: true }).filter((t) => t.name.startsWith("web."));
      expect(web.length > 0).toBe(["librarian", "facts", "architect"].includes(role));
    }
  });

  it("table is sorted and byte-stable; whole description budget ≤ 20k tokens", () => {
    const a = JSON.stringify(renderToolTable(toolTable("build", "lead")));
    const b = JSON.stringify(renderToolTable(toolTable("build", "lead")));
    expect(a).toBe(b);
    const names = toolTable("build", "lead").map((t) => t.name);
    expect([...names].sort()).toEqual(names);
    expect(estimateTokens(JSON.stringify(renderToolTable([...TOOL_DEFS])))).toBeLessThan(20_000);
  });

  it("turn.ledger is harness-only: no role in any mode can write ledger phases", () => {
    for (const role of ROLES) for (const mode of ["plan", "build", "review"] as const) expect(toolTable(mode, role).some((t) => t.name === "turn.ledger"), `${mode}/${role}`).toBe(false);
    expect(TOOL_DEFS.some((t) => t.name === "turn.ledger")).toBe(true);
  });
  it("request_approval is never in a table (hook-raised only)", () => {
    for (const role of ROLES) for (const mode of ["plan", "build", "review"] as const) expect(toolTable(mode, role).some((t) => t.name === "request_approval")).toBe(false);
  });
});
