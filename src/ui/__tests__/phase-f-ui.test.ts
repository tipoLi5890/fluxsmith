// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { kindOf, makeItem, needsIntakeCard, suggestedAction, intakeMode } from "../chat/intake";
import { Lru, thumbKey } from "../thumbs";
import { forgetCondition, isRemembered, rememberCondition, rememberedConditions } from "../../agent/policy/remembered";
import { lintText } from "../../../scripts/design-lint.mjs";
import { splitFrontMatter, joinFrontMatter } from "../settings/SkillEditor";

describe("intake classification", () => {
  const defaults = { lib: "keep", pdf: "keep", sch: "reference", bom: "keep", image: "attach", project_zip: "ask" };
  it("maps extensions to kinds and defaults to actions", () => {
    expect(kindOf("LM317.pdf")).toBe("pdf");
    expect(kindOf("foo.kicad_sym")).toBe("lib");
    expect(kindOf("x.PRETTY")).toBe("lib");
    expect(kindOf("notes.docx")).toBe("unknown");
    expect(suggestedAction("pdf", defaults)).toBe("keep");
    expect(suggestedAction("project_zip", defaults)).toBe("attach");
    expect(suggestedAction("unknown", defaults)).toBe("ignore");
    expect(intakeMode("attach")).toBeNull();
    expect(intakeMode("reference")).toBe("reference");
  });
  it("single ordinary file skips the card; libraries, groups and multi-file drops use it", () => {
    expect(needsIntakeCard([makeItem({ name: "a.pdf" }, defaults)])).toBe(false);
    expect(needsIntakeCard([makeItem({ name: "a.kicad_sym" }, defaults)])).toBe(true);
    expect(needsIntakeCard([makeItem({ name: "a.pdf" }, defaults), makeItem({ name: "b.png" }, defaults)])).toBe(true);
    expect(needsIntakeCard([makeItem({ name: "R.kicad_mod", group: "Res.pretty" }, defaults)])).toBe(true);
  });
});

describe("thumbnail LRU", () => {
  it("evicts least recently used", () => {
    const l = new Lru<number>(2);
    l.set("a", 1); l.set("b", 2); l.get("a"); l.set("c", 3);
    expect(l.has("b")).toBe(false); expect(l.has("a")).toBe(true); expect(l.size).toBe(2);
    expect(thumbKey("p", "/", 3)).toBe("p|/|3");
  });
});

describe("remembered hard-stop conditions (OQ-17)", () => {
  it("is per session and only for rememberable conditions", () => {
    forgetCondition("s1");
    rememberCondition("s1", "interface");
    rememberCondition("s1", "budget");
    expect(isRemembered("s1", "interface")).toBe(true);
    expect(isRemembered("s1", "budget")).toBe(false);
    expect(isRemembered("s2", "interface")).toBe(false);
    expect(rememberedConditions("s1")).toEqual(["interface"]);
    forgetCondition("s1", "interface");
    expect(isRemembered("s1", "interface")).toBe(false);
  });
});

describe("design lint", () => {
  it("flags literals in css and style contexts, not ids or allowed lines", () => {
    expect(lintText("src/ui/x.css", ".a { color: #123456; }")).toHaveLength(1);
    expect(lintText("src/ui/x.css", ".a { background: rgba(0,0,0,.5); }")).toHaveLength(1);
    expect(lintText("src/ui/x.css", ".a { color: red; }")).toHaveLength(1);
    expect(lintText("src/ui/x.tsx", 'document.getElementById(`#card-${id}`)')).toHaveLength(0);
    expect(lintText("src/ui/x.tsx", 'style={{ color: "#fff" }}')).toHaveLength(1);
    expect(lintText("src/ui/x.css", ".a { color: #fff; } /* design-lint: allow */")).toHaveLength(0);
    expect(lintText("src/styles/tokens.css", "--fg: #000;")).toHaveLength(0);
  });
});

describe("skill editor front matter", () => {
  it("round-trips name/description/activation/roles and keeps unknown keys", () => {
    const src = "---\nname: house\ndescription: >-\n  Our rules\nactivation: auto\nroles: [lead, drafter]\norigin: agent\n---\n\n# house\n\n## Rules {#rules}\ntext\n";
    const s = splitFrontMatter(src);
    expect(s.fm).toEqual({ name: "house", description: "Our rules", activation: "auto", roles: "lead, drafter" });
    expect(s.extra).toEqual(["origin: agent"]);
    const out = joinFrontMatter(s.fm, s.extra, s.body);
    expect(out).toContain("roles: [lead, drafter]");
    expect(out).toContain("origin: agent");
    expect(out.endsWith("## Rules {#rules}\ntext\n")).toBe(true);
  });
});
