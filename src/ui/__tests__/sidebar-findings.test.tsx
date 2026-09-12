// SPDX-License-Identifier: Apache-2.0
// Findings sidebar <-> canvas sync: a finding picked on the canvas (marker click, `N` / `Shift+N`)
// is scrolled to and marked here, and a row click hands the canvas a ref it can actually frame.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingRow, Ref } from "../../agent/api";

const ipcCalls: { name: string; args: unknown }[] = [];
vi.mock("../../ipc/client", () => ({ call: vi.fn(async (name: string, args: unknown) => { ipcCalls.push({ name, args }); return {}; }), isTauri: () => false }));
// The export goes through the OS save dialog (S tier); the path is the human's, never the model's.
const saved: unknown[] = [];
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async (o: unknown) => { saved.push(o); return "/tmp/findings.md"; }) }));

import { Sidebar } from "../sidebar/Sidebar";
import { createBridge, setHarnessFactory } from "../harness-bridge";
import { usePrefs } from "../../state/prefs";
import { findingCopy, fmtDay, t } from "../../i18n";
import { expiryDate, WAIVE_REASON_DEFAULT, WAIVER_DEFAULT_DAYS } from "../../agent/review-waiver";

function tab() {
  return { key: "k", path: "/p/x.kicad_pro", sheet: "/", sessionId: "s", info: { name: "x", root: "/p", root_uuid: "u", last_turn: 0, sheets: [{ file: "x.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }, { file: "power.kicad_sch", instance_path: "/u1", names: ["Power"], paper: "A4", symbols: 0 }] } } as unknown as import("../../state/projects").ProjectTab;
}

const rows = [
  { code: "ERC_A", severity: "Error", message: "pin conflict", refs: ["R1.1"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
  { code: "ERC_B", severity: "Warning", message: "no position", location: "w1", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
] as FindingRow[];

// One row per bucket (`src/agent/findings.ts`): a `KICAD_*` row carries `origin: "advisory"` like a
// model row, so only the bucket tells them apart.
const buckets = [
  { code: "ERC_A", severity: "Warning", message: "engine row", refs: ["R1.1"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
  { code: "KICAD_PIN_NOT_CONNECTED", severity: "Warning", message: "oracle row", refs: ["U1.3"], sheet: "x.kicad_sch", origin: "advisory", turn: 1, resolved: false },
  { code: "STYLE_HINT", severity: "Warning", message: "model row", location: "a1", sheet: "x.kicad_sch", origin: "advisory", turn: 1, resolved: false },
] as FindingRow[];

async function render(el: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(el); });
  return container;
}

describe("Findings sidebar", () => {
  beforeEach(() => { setHarnessFactory(null); usePrefs.setState({ sidebarTab: "findings", findingFilter: {} }); ipcCalls.length = 0; saved.length = 0; });

  it("scrolls to and marks the finding selected on the canvas", async () => {
    const scrolls: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolls.push(this.id); };
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: rows })); });
    expect(container.querySelectorAll(".finding").length).toBe(2);
    expect(container.querySelector(".finding.selected")).toBeNull();
    // the canvas selects the finding it just marked / walked to
    await act(async () => { bridge.setState((s) => ({ ...s, selection: [{ kind: "finding", code: "ERC_B", location: "w1" } as Ref] })); });
    const marked = container.querySelector(".finding.selected");
    expect(marked?.textContent).toContain("ERC_B");
    expect(scrolls).toContain("finding-ERC_B|w1");
    // a marker click that carries no location still marks the row (matched on the code)
    await act(async () => { bridge.setState((s) => ({ ...s, selection: [{ kind: "finding", code: "ERC_A" } as Ref] })); });
    expect(container.querySelector(".finding.selected")?.textContent).toContain("ERC_A");
  });

  it("hands the canvas a finding ref carrying the sheet, plus component refs when the finding has them", async () => {
    const focused: Ref[][] = [];
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={(r) => focused.push(r)} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: rows })); });
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".finding-main"));
    const byCode = (code: string) => buttons.find((b) => b.textContent?.includes(code))!;
    await act(async () => { byCode("ERC_A").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(focused.pop()).toEqual([
      { kind: "component", ref: "R1", sheet: "x.kicad_sch" },
      { kind: "finding", code: "ERC_A", location: "R1.1", sheet: "x.kicad_sch" },
    ]);
    await act(async () => { byCode("ERC_B").dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(focused.pop()).toEqual([{ kind: "finding", code: "ERC_B", location: "w1", sheet: "x.kicad_sch" }]);
  });

  // A sheet-level check (`SHEET_NO_PINS`, `SHEET_CHILD_EMPTY`) carries the sheet's *name* in `refs`
  // where a component check carries designators. Mapping every ref to a component asked the canvas to
  // frame a part called "Power" that exists nowhere.
  it("reads a ref that is not a designator as the sheet it names", async () => {
    const focused: Ref[][] = [];
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={(r) => focused.push(r)} />);
    const sheetRow = [{ code: "SHEET_NO_PINS", severity: "Warning", message: "sheet Power has no pins", refs: ["Power"], location: "sheetpins:u1", sheet: "/", origin: "engine", turn: 1, resolved: false }] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: sheetRow })); });
    const button = container.querySelector<HTMLButtonElement>(".finding-main")!;
    await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(focused.pop()).toEqual([
      { kind: "sheet", path: "/Power/" },
      { kind: "finding", code: "SHEET_NO_PINS", location: "sheetpins:u1", sheet: "/" },
    ]);
  });

  // The header used to add waived rows to "resolved", which read as if they had been fixed.
  it("counts repaired and waived rows apart in the header", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const mixed = [
      { code: "ERC_A", severity: "Error", message: "open", refs: ["R1.1"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
      { code: "ERC_FIXED", severity: "Warning", message: "repaired", location: "w1", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: true },
      { code: "OFF_GRID", severity: "Warning", message: "lived with", location: "style:grid:9", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: true, waived: true, waived_until: "2099-01-01T00:00:00Z", waived_reason: "panel silk, on purpose" },
    ] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: mixed })); });
    const head = container.querySelector<HTMLElement>(".findings-head")!;
    expect(head.textContent).toContain(t("side.findingsRepaired", { n: 1 }));
    expect(head.textContent).toContain(t("side.findingsWaived", { n: 1 }));
    // The waiver says until when and why, the way eeschema shows an exclusion's comment.
    const waivedRow = [...container.querySelectorAll<HTMLElement>(".finding")].find((el) => el.textContent?.includes("OFF_GRID"))!;
    expect(waivedRow.textContent).toContain(t("card.waiver.waivedUntil", { date: fmtDay("2099-01-01T00:00:00Z") }));
    expect(waivedRow.textContent).toContain(t("side.waivedReason", { reason: "panel silk, on purpose" }));
  });

  it("labels each row with its bucket and offers the waiver on the two that inspected the file", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: buckets })); });
    const row = (code: string) => [...container.querySelectorAll<HTMLElement>(".finding")].find((el) => el.textContent?.includes(code))!;
    expect(row("ERC_A").textContent).toContain(t("side.confidence.engine"));
    // The KiCad row is the oracle's own second opinion, not a suggestion.
    expect(row("KICAD_PIN_NOT_CONNECTED").textContent).toContain(t("side.confidence.kicad"));
    expect(row("KICAD_PIN_NOT_CONNECTED").textContent).not.toContain(t("side.confidence.advisory"));
    expect(row("STYLE_HINT").textContent).toContain(t("side.confidence.advisory"));
    const waive = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t("empty.reviewCleanAction"));
    expect(waive(row("ERC_A"))).toBeTruthy();
    expect(waive(row("KICAD_PIN_NOT_CONNECTED"))).toBeTruthy();
    // A model advisory is a suggestion: there is no verdict to waive.
    expect(waive(row("STYLE_HINT"))).toBeUndefined();
  });

  it("filters by bucket, so the KiCad rows are not mixed into the model's suggestions", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: buckets })); });
    const strip = container.querySelector<HTMLElement>(`[aria-label="${t("side.originFilter")}"]`)!;
    const pick = async (label: string) => {
      const b = [...strip.querySelectorAll<HTMLButtonElement>("button")].find((x) => x.textContent?.trim() === label)!;
      await act(async () => { b.click(); });
    };
    const codes = () => [...container.querySelectorAll<HTMLElement>(".finding .badge.fs-mono")].map((b) => b.textContent);
    await pick(t("side.confidence.kicad"));
    expect(codes()).toEqual(["KICAD_PIN_NOT_CONNECTED"]);
    await pick(t("side.confidence.advisory"));
    expect(codes()).toEqual(["STYLE_HINT"]);
    await pick(t("side.confidence.engine"));
    expect(codes()).toEqual(["ERC_A"]);
    await pick(t("side.origin.all"));
    expect(codes().length).toBe(3);
  });

  it("filters by sheet, and offers the filter only when the rows name more than one", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    // One sheet in the rows: nothing to choose between.
    await act(async () => { bridge.setState((s) => ({ ...s, findings: rows })); });
    expect(container.querySelector<HTMLSelectElement>(`select[aria-label="${t("side.sheetFilter")}"]`)).toBeNull();
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [...rows, { code: "ERC_C", severity: "Warning", message: "on the child sheet", location: "w2", sheet: "/Power/", origin: "engine", turn: 1, resolved: false } as FindingRow] })); });
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${t("side.sheetFilter")}"]`)!;
    expect(select).not.toBeNull();
    // The option reads like the sheet tree (the instance's names path), not the raw finding string,
    // and says how many rows choosing it would list (P2-15).
    expect([...select.options].map((o) => o.textContent)).toEqual([t("side.allSheets"), "Power (1)", "x.kicad_sch (2)"]);
    // Rows carry two badges (code + fix cost); count the code badge only.
    const codes = () => [...container.querySelectorAll<HTMLElement>(".finding .badge.fs-mono")].map((b) => b.textContent);
    expect(codes().length).toBe(3);
    await act(async () => { select.value = "/Power/"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(codes()).toEqual(["ERC_C"]);
  });

  // `/fix` runs the deterministic `ercfix` op-list and then up to two Fixer rounds (a model call
  // each), and leaves everything else listed. The row says which of the three it is before the
  // click; rows used to be pre-ticked and then dropped by `system.fix_not_fixable` after it.
  it("says on every row what its repair costs, and sums the ticked ones above the list", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const mixed = [
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "VBUS has no driver", refs: ["U1.5"], location: "erc:pwr:VBUS", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
      { code: "DECAP_FAR", severity: "Warning", message: "C3 is 700 mil from U1.4", refs: ["C3"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
      { code: "FOOTPRINT_MISSING", severity: "Warning", message: "R7 has no footprint", refs: ["R7"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
      { code: "KICAD_PIN_NOT_CONNECTED", severity: "Warning", message: "oracle row", refs: ["U1.3"], sheet: "x.kicad_sch", origin: "advisory", turn: 1, resolved: false },
    ] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: mixed })); });
    const row = (code: string) => [...container.querySelectorAll<HTMLElement>(".finding")].find((el) => el.textContent?.includes(code))!;
    expect(row("ERC_POWER_IN_UNDRIVEN").textContent).toContain(t("side.fixKind.mechanical"));
    // The Fixer is registered for DECAP_FAR; reaching it costs a model round.
    expect(row("DECAP_FAR").textContent).toContain(t("side.fixKind.model"));
    // A footprint choice is the librarian's, and a KiCad code is not one the fix path can act on.
    expect(row("FOOTPRINT_MISSING").textContent).toContain(t("side.fixKind.none"));
    expect(row("KICAD_PIN_NOT_CONNECTED").textContent).toContain(t("side.fixKind.none"));
    // Ticked by default: the two with a repair, and only those — the same predicate the triage uses.
    const box = (code: string) => row(code).querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(box("ERC_POWER_IN_UNDRIVEN").checked).toBe(true);
    expect(box("DECAP_FAR").checked).toBe(true);
    expect(box("FOOTPRINT_MISSING").checked).toBe(false);
    expect(container.textContent).toContain(t("side.fixPlan", { mechanical: 1, model: 1, none: 0 }));
    await act(async () => { box("FOOTPRINT_MISSING").click(); });
    expect(container.textContent).toContain(t("side.fixPlan", { mechanical: 1, model: 1, none: 1 }));
  });

  // A `/review` that replaces the rows with the same number of different ones used to keep the old
  // ticks (the default selection was keyed on `rows.length`), so the Fix button carried a selection
  // of rows that were no longer listed.
  it("recomputes the default ticks when a review replaces the rows with as many different ones", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const before = [
      { code: "ERC_POWER_IN_UNDRIVEN", severity: "Error", message: "VBUS has no driver", location: "erc:1", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
      { code: "OFF_GRID", severity: "Warning", message: "R1.1 off grid", location: "g:1", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false },
    ] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: before })); });
    const fixButton = () => container.querySelector<HTMLButtonElement>(".findings-head .btn-primary")!;
    expect(fixButton().textContent).toBe(t("side.fixSelected", { n: 2 }));
    const after = [
      { code: "FOOTPRINT_MISSING", severity: "Warning", message: "R7 has no footprint", location: "d:1", sheet: "x.kicad_sch", origin: "engine", turn: 2, resolved: false },
      { code: "PART_UNVERIFIED", severity: "Warning", message: "converted claim", location: "d:2", sheet: "x.kicad_sch", origin: "engine", turn: 2, resolved: false },
    ] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: after })); });
    expect(container.querySelectorAll(".finding").length).toBe(2);
    expect(fixButton().textContent).toBe(t("side.fixSelected", { n: 0 }));
    expect(fixButton().disabled).toBe(true);
  });

  it("exports the listed rows through the save dialog, as the Markdown report by default", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: rows })); });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === t("side.exportFindings"))!;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
    expect(saved).toEqual([{ defaultPath: "findings.md" }]);
    const call = ipcCalls.find((c) => c.name === "export_file")!;
    expect(call).toBeTruthy();
    const args = call.args as { kind: string; out_path: string; payload: { project: string; findings: { code: string }[] } };
    expect(args.kind).toBe("findings");
    expect(args.out_path).toBe("/tmp/findings.md");
    expect(args.payload.project).toBe("x");
    expect(args.payload.findings.map((f) => f.code)).toEqual(["ERC_A", "ERC_B"]);
  });

  // The row leads with the app's own title for the code (red line 6: it names what the check looked
  // at, it does not judge the circuit); the code stays as the monospace tag beside it, and the
  // engine's own English sentence is untrusted text one click away.
  it("shows the title first and the code as a tag, with detail, remedy and the engine message on expand", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const known = [{ code: "OFF_GRID", severity: "Warning", message: "pin R1.1 at (1,2) is off the 50 mil connection grid", refs: ["R1.1"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false }] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: known })); });
    const row = container.querySelector<HTMLElement>(".finding")!;
    const copy = findingCopy("OFF_GRID")!;
    expect(row.querySelector(".finding-title")?.textContent).toBe(copy.title);
    expect(row.querySelector(".badge")?.textContent).toBe("OFF_GRID");
    // Collapsed: no explanation, no engine sentence.
    expect(row.textContent).not.toContain(copy.detail);
    expect(row.textContent).not.toContain(known[0].message);
    const expand = [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === t("side.findingDetail"))!;
    expect(expand).toBeTruthy();
    await act(async () => { expand.click(); });
    expect(row.textContent).toContain(copy.detail);
    expect(row.textContent).toContain(copy.remedy);
    expect(row.textContent).toContain(known[0].message);
  });

  // A code with no entry (a model advisory) keeps the engine's message as its primary line: the UI
  // never invents a title for a code it does not know.
  it("leaves an unknown code reading exactly as before", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: buckets })); });
    const row = [...container.querySelectorAll<HTMLElement>(".finding")].find((el) => el.textContent?.includes("STYLE_HINT"))!;
    expect(findingCopy("STYLE_HINT")).toBeNull();
    expect(row.querySelector(".finding-title")?.textContent).toBe("model row");
  });

  it("exports the English title beside the code, whatever the interface language", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [{ code: "OFF_GRID", severity: "Warning", message: "off grid", refs: ["R1.1"], sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false } as FindingRow, ...rows] })); });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === t("side.exportFindings"))!;
    await act(async () => { button.click(); });
    const args = ipcCalls.find((c) => c.name === "export_file")!.args as { payload: { findings: { code: string; title?: string }[] } };
    expect(args.payload.findings.find((f) => f.code === "OFF_GRID")?.title).toBe(findingCopy("OFF_GRID", "en")!.title);
    // A code with no entry carries no title field at all.
    expect(args.payload.findings.find((f) => f.code === "ERC_A")).not.toHaveProperty("title");
  });

  // P1-7: eeschema's ERC dialog opens with Error and Warning on and exclusions off, and the two are
  // read together; the panel used to offer one severity at a time (All / Error / Warning / Info).
  it("shows Error and Warning by default, toggles each severity, and remembers it per project", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const info = { code: "PAGE_UNDERUSED", severity: "Info", message: "info row", location: "p1", sheet: "x.kicad_sch", origin: "engine", turn: 1, resolved: false } as FindingRow;
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [...rows, info] })); });
    const codes = () => [...container.querySelectorAll<HTMLElement>(".finding .badge.fs-mono")].map((b) => b.textContent);
    expect(codes()).toEqual(["ERC_A", "ERC_B"]);
    const strip = container.querySelector<HTMLElement>(`[aria-label="${t("side.severityFilter")}"]`)!;
    const toggle = (label: string) => [...strip.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
    expect(toggle(t("side.severity.error")).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(t("side.severity.info")).getAttribute("aria-pressed")).toBe("false");
    // Info on: the note joins the two, it does not replace them.
    await act(async () => { toggle(t("side.severity.info")).click(); });
    expect(codes()).toEqual(["ERC_A", "ERC_B", "PAGE_UNDERUSED"]);
    // Error off: warnings and notes stay listed.
    await act(async () => { toggle(t("side.severity.error")).click(); });
    expect(codes()).toEqual(["ERC_B", "PAGE_UNDERUSED"]);
    // The canvas reads the same filter (P1-6), and the choice is remembered for this project.
    expect(bridge.getState().findingFilter.severities).toEqual({ error: false, warning: true, info: true });
    await act(async () => { bridge.setState((s) => ({ ...s, state: { ...s.state, project_key: "k" } })); toggle(t("side.severity.error")).click(); });
    expect(usePrefs.getState().findingFilter.k?.severities).toEqual({ error: true, warning: true, info: true });
  });

  // P2-15: the same walk as the canvas `N` / `Shift+N`, for a human who is reading the list.
  it("walks to the next and previous finding through the canvas command", async () => {
    const walks: number[] = [];
    const h = (e: Event) => walks.push(Number((e as CustomEvent<{ dir?: number }>).detail?.dir));
    document.addEventListener("fs:walk-finding", h);
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: rows })); });
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label)!;
    await act(async () => { button(t("side.nextFinding")).click(); });
    await act(async () => { button(t("side.prevFinding")).click(); });
    document.removeEventListener("fs:walk-finding", h);
    expect(walks).toEqual([1, -1]);
  });

  // P1-8: what the check measured travels with the row; without it a finding says a net is undriven
  // and never says which pins it counted.
  it("lists the engine's evidence under an expanded row, as plain key/value text", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const withEvidence = [{ ...rows[0], evidence: { net: "VBUS", pins: 3 } }] as FindingRow[];
    await act(async () => { bridge.setState((s) => ({ ...s, findings: withEvidence })); });
    const row = container.querySelector<HTMLElement>(".finding")!;
    expect(row.querySelector(".finding-evidence")).toBeNull();
    const expand = [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === t("side.findingDetail"))!;
    await act(async () => { expand.click(); });
    const dl = row.querySelector<HTMLElement>(".finding-evidence")!;
    expect(dl).not.toBeNull();
    expect([...dl.querySelectorAll("dt")].map((x) => x.textContent)).toEqual(["net", "pins"]);
    expect([...dl.querySelectorAll("dd")].map((x) => x.textContent)).toEqual(["VBUS", "3"]);
    // Untrusted engine data: text nodes, never markup (red line 18).
    expect(dl.innerHTML).not.toContain("<script");
  });

  // P1-10: the report is read outside the app, so it carries what the check measured and the usual
  // fix in English, plus the evidence and the waiver reason.
  it("exports detail, remedy, evidence and the waiver reason beside the title", async () => {
    const bridge = createBridge();
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    const row = { code: "OFF_GRID", severity: "Warning", message: "off grid", refs: ["R1.1"], sheet: "x.kicad_sch", file: "x.kicad_sch", origin: "engine", turn: 1, resolved: false, evidence: { at_mil: "1,2" }, waived_reason: "panel silk, on purpose", waived_until: "2099-01-01T00:00:00Z" } as FindingRow;
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [row] })); });
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === t("side.exportFindings"))!;
    await act(async () => { button.click(); });
    const args = ipcCalls.find((c) => c.name === "export_file")!.args as { payload: { findings: Record<string, unknown>[] } };
    const exported = args.payload.findings[0];
    const copy = findingCopy("OFF_GRID", "en")!;
    expect(exported.title).toBe(copy.title);
    expect(exported.detail).toBe(copy.detail);
    expect(exported.remedy).toBe(copy.remedy);
    expect(exported.evidence).toEqual({ at_mil: "1,2" });
    expect(exported.waived_reason).toBe("panel silk, on purpose");
    expect(exported.file).toBe("x.kicad_sch");
  });

  it("waives through the same form the review card uses: a reason and an expiry, never one click", async () => {
    const waived: unknown[][] = [];
    const bridge = createBridge();
    bridge.setState((s) => ({ ...s, waiveFinding: async (...a: unknown[]) => { waived.push(a); } } as never));
    const container = await render(<Sidebar tab={tab()} bridge={bridge} onFocus={() => undefined} />);
    await act(async () => { bridge.setState((s) => ({ ...s, findings: rows })); });
    // Nothing is recorded by the button itself: it opens the form.
    // Errors are waivable too now (the form demands a reason); this case exercises the Warning row, whose
    // default reason is enough to record.
    const row = [...container.querySelectorAll<HTMLElement>(".finding")].find((r) => r.textContent?.includes("ERC_B"))!;
    expect(row).toBeTruthy();
    const waive = [...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t("empty.reviewCleanAction"))!;
    expect(waive).toBeTruthy();
    await act(async () => { waive.click(); });
    expect(waived.length).toBe(0);
    const form = container.querySelector<HTMLElement>(".review-waiver")!;
    expect(form).not.toBeNull();
    // The same fields as the card: a reason, the three shortcuts and the date.
    expect(form.querySelectorAll("input[type=radio]").length).toBe(3);
    const date = form.querySelector<HTMLInputElement>("input[type=date]")!;
    expect(date.value).toBe(expiryDate(WAIVER_DEFAULT_DAYS));
    const record = [...form.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === t("card.waiver.record"))!;
    await act(async () => { record.click(); });
    // The reason was left empty on a Warning: the record carries the shared default, not a UI string.
    expect(waived.length).toBe(1);
    expect(waived[0][0]).toEqual({ code: "ERC_B", refs: ["w1"], severity: "Warning", location: "w1" });
    expect(waived[0][1]).toBe(WAIVE_REASON_DEFAULT);
    expect(waived[0][3]).toBe(expiryDate(WAIVER_DEFAULT_DAYS));
    expect(container.querySelector(".review-waiver")).toBeNull();
  });
});
