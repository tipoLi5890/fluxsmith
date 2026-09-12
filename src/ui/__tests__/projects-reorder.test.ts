// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { useProjects } from "../../state/projects";
import type { ProjectTab } from "../../state/projects";

const tab = (key: string): ProjectTab => ({ key, info: { key, root: `/${key}`, root_sheet: `${key}.kicad_sch`, root_uuid: key, name: key, version: 1, sheets: [], config: {}, git: null, locked: false } as never, sheet: "/", needsYou: false, running: false, sessionId: null });

describe("project tab order", () => {
  it("moves a tab to a new index and ignores out-of-range moves", () => {
    useProjects.setState({ tabs: [tab("a"), tab("b"), tab("c")], activeKey: "a" });
    useProjects.getState().reorder(0, 2);
    expect(useProjects.getState().tabs.map((t) => t.key)).toEqual(["b", "c", "a"]);
    useProjects.getState().reorder(2, 0);
    expect(useProjects.getState().tabs.map((t) => t.key)).toEqual(["a", "b", "c"]);
    useProjects.getState().reorder(5, 0);
    expect(useProjects.getState().tabs.map((t) => t.key)).toEqual(["a", "b", "c"]);
  });
});
