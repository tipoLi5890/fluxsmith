// SPDX-License-Identifier: Apache-2.0
// Canvas panel interaction: hover readout, keyboard walk, copy, context menu, follow-paused chip,
// and the no-innerHTML rule for everything that shows file content.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ref } from "../../agent/api";
import type { CanvasViewProps } from "../canvas-panel/canvas-slot";
import { describeHit, readoutParams } from "../canvas-panel/status-readout";
import { describeBox, describeLength, fmtMil } from "../canvas-panel/measure";
import { netOfHit } from "../../canvas/netpaths";
import { gridPitch } from "../../canvas/viewport";
import { UI_LANGS, t } from "../../i18n";
import { findingFocusBox, orderedFindings, selectionText } from "../canvas-panel/CanvasPanel";

let lastProps: CanvasViewProps | null = null;
vi.mock("../canvas-panel/canvas-slot", () => ({
  CanvasSlot: (props: CanvasViewProps) => { lastProps = props; return <div data-testid="slot" />; },
  CanvasPlaceholder: () => null,
}));
// The engine answers the panel's own requests: `net_map` for the status bar, and the project-wide
// `read` / `nets` the panel uses to find what this sheet does not have.
vi.mock("../../ipc/client", () => ({
  call: vi.fn(async (_cmd: string, args: { request?: { kind?: string } }) => {
    const kind = args?.request?.kind;
    if (kind === "read") return { ok: true, data: { symbols: [{ reference: "C9", value: "100n", sheet: "power.kicad_sch", instance_path: "/u1/u2/" }] } };
    if (kind === "nets") return { ok: true, data: { nets: [] } };
    return { ok: true, data: { sheet: "/", wires: { w1: "VOUT" }, labels: {}, pins: { "R1.1": "VIN" } } };
  }),
  isTauri: () => true,
}));

import { CanvasPanel } from "../canvas-panel/CanvasPanel";
import { createBridge, setHarnessFactory } from "../harness-bridge";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

describe("no DOM from file content", () => {
  it("canvas and canvas panel never use innerHTML / dangerouslySetInnerHTML", () => {
    const files = [...walk(join(__dirname, "../../canvas")), ...walk(join(__dirname, "../canvas-panel"))];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src.includes("innerHTML"), f).toBe(false);
      expect(src.includes("dangerouslySetInnerHTML"), f).toBe(false);
    }
  });
});

describe("status readout + measure", () => {
  it("describes hits with engine net names and formats sizes", () => {
    const map = { sheet: "/", wires: { w1: "VOUT" }, labels: { l1: "SDA" }, pins: { "R1.1": "VIN" } };
    expect(describeHit({ kind: "pin", reference: "R1", number: "1", name: "~", electrical: "passive", at: [0, 0] }, null, map).map((r) => r.key)).toEqual(["canvas.status.pin", "canvas.status.pinType", "canvas.status.net"]);
    expect(describeHit({ kind: "pin", reference: "R1", number: "2", name: "~", electrical: "passive", at: [0, 0] }, null, map)[2].key).toBe("canvas.status.noNet");
    expect(describeHit({ kind: "wire", uuid: "w1", is_bus: false, a: [0, 0], b: [1, 1] }, null, map)[0].params.name).toBe("VOUT");
    expect(describeHit({ kind: "wire", uuid: "w9", is_bus: true, a: [0, 0], b: [1, 1] }, null, map)[0].key).toBe("canvas.status.bus");
    expect(describeHit({ kind: "label", uuid: "l1", text: "SDA", label_kind: "global", bbox: [[0, 0], [1, 1]] }, null, map)).toHaveLength(1);
    expect(describeHit(null, null, map)).toEqual([]);
    // a sheet pin reads out its name, its direction and the net the engine map gives it
    const spMap = { ...map, sheet_pins: { sp1: "SDA" } };
    const sp: Extract<import("../../canvas/hittest").Hit, { kind: "sheet_pin" }> = { kind: "sheet_pin", uuid: "sp1", name: "VIN", shape: "input", side: "left", sheet_uuid: "sh1", sheet_name: "child", sheet_file: "child.kicad_sch", at: [0, 0] };
    expect(describeHit(sp, null, spMap).map((r) => r.key)).toEqual(["canvas.status.sheetPin", "canvas.status.net"]);
    expect(describeHit(sp, null, spMap)[0].params).toEqual({ name: "VIN", dir: "input" });
    expect(describeHit({ ...sp, uuid: "sp9" }, null, spMap)[1].key).toBe("canvas.status.noNet");
    expect(describeBox([[0, 0], [1200, 400]], "en")).toEqual({ w: "1,200", h: "400", wmm: "30.48", hmm: "10.16" });
    expect(describeLength([0, 0], [300, 400], "en")).toEqual({ len: "500", mm: "12.70" });
    expect(fmtMil(1234.6, "en")).toBe("1,235");
    expect(selectionText([{ kind: "component", ref: "R1" }, { kind: "net", name: "GND" }, { kind: "region", sheet: "/", bbox_mil: [[0, 0], [1, 1]] }] as Ref[])).toBe("R1, GND");
  });
  it("reads out the pin's electrical type, a symbol's unit / DNP, and a junction's net", () => {
    const map = { sheet: "/", wires: {}, labels: {}, pins: { "U1.7": "VCC" }, junctions: { j1: "GND" }, no_connects: { nc1: "unconnected-(U1-Pad9)" } };
    // a power pin: designator + type + net, in that order
    const pin = describeHit({ kind: "pin", reference: "U1", number: "7", name: "VCC", electrical: "power_in", at: [0, 0] }, null, map);
    expect(pin.map((r) => r.key)).toEqual(["canvas.status.pin", "canvas.status.pinType", "canvas.status.net"]);
    expect(pin[1].keyParams).toEqual({ type: "canvas.pinType.powerIn" });
    expect(readoutParams(pin[1], (k) => t(k, undefined, "en"))).toEqual({ type: "power input" });
    // a type the file spells its own way is read out verbatim, never dropped
    const odd = describeHit({ kind: "pin", reference: "U1", number: "8", name: "X", electrical: "weird_type", at: [0, 0] }, null, map);
    expect(odd[1].keyParams).toBeUndefined();
    expect(odd[1].params).toEqual({ type: "weird_type" });
    // DNP and unit come off the engine geometry of the hovered symbol
    const sheet = { sheet_path: "/", symbols: [
      { reference: "U1", uuid: "s-dnp", value: "STM32", lib_id: "MCU:U", unit: 2, dnp: true, texts: [] },
      { reference: "R1", uuid: "s-ok", value: "10k", lib_id: "Device:R", unit: 1, dnp: false, texts: [] },
    ] } as unknown as import("../../canvas/types").RenderSheet;
    const dnp = describeHit({ kind: "symbol", reference: "U1", uuid: "s-dnp", value: "STM32", lib_id: "MCU:U", bbox: [[0, 0], [1, 1]] }, sheet, map);
    expect(dnp.map((r) => r.key)).toEqual(["canvas.status.symbol", "canvas.status.unit", "canvas.status.dnp"]);
    const plain = describeHit({ kind: "symbol", reference: "R1", uuid: "s-ok", value: "10k", lib_id: "Device:R", bbox: [[0, 0], [1, 1]] }, sheet, map);
    expect(plain.map((r) => r.key)).toEqual(["canvas.status.symbol"]);
    // junction / no-connect name their net from the engine map (never inferred here)
    expect(describeHit({ kind: "junction", uuid: "j1", at: [0, 0] }, null, map).map((r) => r.key)).toEqual(["canvas.status.junction", "canvas.status.net"]);
    expect(describeHit({ kind: "junction", uuid: "j9", at: [0, 0] }, null, map).map((r) => r.key)).toEqual(["canvas.status.junction"]);
    expect(describeHit({ kind: "no_connect", uuid: "nc1", at: [0, 0] }, null, map)[1].params.name).toBe("unconnected-(U1-Pad9)");
    expect(netOfHit(map, { kind: "junction", uuid: "j1" })).toBe("GND");
    expect(netOfHit(map, { kind: "no_connect", uuid: "nc9" })).toBeNull();
  });
  it("gives the cursor readout in mil and mm in all four languages", () => {
    for (const l of UI_LANGS) {
      const s = t("canvas.status.cursor", { x: "1,000", y: "500", xmm: "25.40", ymm: "12.70" }, l);
      expect(s, l).toContain("mil");
      expect(s, l).toContain("mm");
      expect(s, l).toContain("25.40");
    }
  });
  it("orders findings top-left first and skips resolved / other sheets", () => {
    const sheet = { sheet_path: "/", file: "a.kicad_sch", symbols: [{ reference: "R1", bbox: [[100, 100], [200, 200]], pins: [{ number: "1", at: [50, 500] }] }, { reference: "R2", bbox: [[100, 0], [200, 50]], pins: [] }], labels: [], sheets: [] } as unknown as import("../../canvas/types").RenderSheet;
    const rows = [
      { code: "A", severity: "Error", message: "", refs: ["R1.1"], origin: "engine", turn: 1, resolved: false },
      { code: "B", severity: "Error", message: "", refs: ["R2"], origin: "engine", turn: 1, resolved: false },
      { code: "C", severity: "Error", message: "", refs: ["R1"], origin: "engine", turn: 1, resolved: true },
      { code: "D", severity: "Error", message: "", refs: ["R1"], sheet: "b.kicad_sch", origin: "engine", turn: 1, resolved: false },
    ] as import("../../agent/api").FindingRow[];
    expect(orderedFindings(sheet, rows, ["a.kicad_sch", "/"]).map((x) => x.f.code)).toEqual(["B", "A"]);
  });
  it("resolves a finding ref to its marker anchor, and to nothing when the finding has no position", () => {
    const sheet = { sheet_path: "/", file: "a.kicad_sch", symbols: [{ reference: "R1", bbox: [[100, 100], [200, 200]], pins: [{ number: "1", at: [50, 500] }] }], labels: [], sheets: [] } as unknown as import("../../canvas/types").RenderSheet;
    const rows = [
      { code: "ERC_W", severity: "Warning", message: "", location: "w1", at_mil: [500, 600], origin: "engine", turn: 1, resolved: false },
      { code: "SHEET", severity: "Info", message: "", origin: "advisory", turn: 1, resolved: false },
    ] as unknown as import("../../agent/api").FindingRow[];
    const ids = ["a.kicad_sch", "/"];
    expect(findingFocusBox(sheet, rows, [{ kind: "finding", code: "ERC_W", location: "w1" }], ids)).toEqual([[499, 599], [501, 601]]);
    // matched on the code alone when the ref carries no location
    expect(findingFocusBox(sheet, rows, [{ kind: "finding", code: "ERC_W" }], ids)).toEqual([[499, 599], [501, 601]]);
    expect(findingFocusBox(sheet, rows, [{ kind: "finding", code: "SHEET", location: "" }], ids)).toBeNull();
    expect(findingFocusBox(null, rows, [{ kind: "finding", code: "ERC_W" }], ids)).toBeNull();
    expect(findingFocusBox(sheet, rows, [{ kind: "component", ref: "R1" }], ids)).toBeNull();
  });
});

/** Panels mounted by a test, unmounted after it: the canvas listens on the document, so a leftover panel would answer too. */
const mounted: { unmount: () => void; container: HTMLElement }[] = [];
async function render(el: React.ReactElement): Promise<{ container: HTMLElement; rerender: (next: React.ReactElement) => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ unmount: () => root.unmount(), container });
  await act(async () => { root.render(el); });
  return { container, rerender: async (next) => { await act(async () => { root.render(next); }); } };
}
/** Let the panel's engine lookups and its 250 ms search debounce settle. */
async function settle(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
function key(el: Element, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}
function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function tab() {
  return { key: "k", path: "/p/x.kicad_pro", sheet: "/", sessionId: "s", info: { name: "x", root_uuid: "u", last_turn: 0, sheets: [{ file: "x.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }] } } as unknown as import("../../state/projects").ProjectTab;
}

describe("CanvasPanel", () => {
  beforeEach(() => { lastProps = null; setHarnessFactory(null); });
  afterEach(() => { act(() => { for (const m of mounted.splice(0)) { m.unmount(); m.container.remove(); } }); });
  it("reads out the hovered object in the status bar, walks findings with N, copies with Mod+C, shows follow-paused", async () => {
    const bridge = createBridge();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    expect(container.querySelector("[data-testid='slot']")).toBeTruthy();
    // hover a wire: status bar shows the engine net
    await act(async () => { lastProps!.onHover!({ hit: { kind: "wire", uuid: "w1", is_bus: false, a: [0, 0], b: [300, 400] }, screen: [1, 1], world: [123, 456] }); });
    expect(container.querySelector(".canvas-status")!.textContent).toContain("VOUT");
    expect(container.querySelector(".canvas-status")!.textContent).toContain("123");
    expect(lastProps!.hoverNet).toBe("VOUT");
    // hover away clears
    await act(async () => { lastProps!.onHover!(null); });
    expect(lastProps!.hoverNet).toBeNull();
    // selection + Mod+C copies the names
    await act(async () => { lastProps!.onSelect([{ kind: "component", ref: "R1", sheet: "/" }, { kind: "net", name: "GND" }]); });
    await act(async () => { key(container.querySelector(".canvas-panel")!, { key: "c", metaKey: true }); });
    expect(writeText).toHaveBeenCalledWith("R1, GND");
    // follow paused chip appears with a resume button that sends the command
    await act(async () => { lastProps!.onFollowPaused!(Date.now() + 20_000); });
    expect(container.querySelector(".canvas-follow-paused")).toBeTruthy();
    await act(async () => { click(container.querySelector(".canvas-follow-paused button")!); });
    expect(lastProps!.command?.kind).toBe("resume_follow");
    // no innerHTML anywhere in the rendered status bar: file strings are text nodes
    expect(container.querySelector(".canvas-status")!.innerHTML).not.toContain("<script");
  });
  it("context menu offers copy / zoom / sidebar / highlight net and marker hover reads the finding", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    await act(async () => { lastProps!.onContextMenu!({ kind: "wire", uuid: "w1", is_bus: false, a: [0, 0], b: [1, 1] }, [{ kind: "net", name: "VOUT" }], { x: 10, y: 10 }); });
    const items = Array.from(container.querySelectorAll("[role='menuitem'], .context-menu button, .menu-item")).map((el) => el.textContent ?? "");
    expect(items.join("|")).toMatch(/Highlight net/);
    expect(items.join("|")).toMatch(/Copy name/);
    expect(items.join("|")).toMatch(/Zoom to/);
    await act(async () => { lastProps!.onHover!({ hit: null, screen: [0, 0], world: [0, 0], marker: { at: [0, 0], severity: "error", findings: [{ code: "ERC_X", severity: "Error", message: "boom", origin: "engine", turn: 1, resolved: false }] } }); });
    expect(container.querySelector(".canvas-status")!.textContent).toContain("ERC_X");
    expect(container.querySelector(".canvas-status")!.textContent).toContain("boom");
  });
  it("passes the agent ghost preview through when the harness names the sheet by plan file", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    expect(container).toBeTruthy();
    await act(async () => { bridge.setState((s) => ({ ...s, ghost: { preview_id: "pv1", sheet: "x.kicad_sch", turn: 1 } })); });
    expect(lastProps!.ghost).toEqual({ preview_id: "pv1", sheet: "/" });
    await act(async () => { bridge.setState((s) => ({ ...s, ghost: { preview_id: "pv2", sheet: "other.kicad_sch", turn: 1 } })); });
    expect(lastProps!.ghost).toBeNull();
    // attention on another sheet hides the orb here; on this sheet it is passed without a sheet id
    await act(async () => { bridge.setState((s) => ({ ...s, attention: { seq: 1, turn: 1, role: "drafter", label: "Drafter", sheet: "x.kicad_sch", region_mil: [[0, 0], [10, 10]] } })); });
    expect(lastProps!.attention?.sheet).toBeUndefined();
    expect(lastProps!.attention?.label).toBe("Drafter");
    await act(async () => { bridge.setState((s) => ({ ...s, attention: { seq: 2, turn: 1, role: "drafter", label: "Drafter", sheet: "other.kicad_sch", region_mil: [[0, 0], [10, 10]] } })); });
    expect(lastProps!.attention).toBeNull();
  });
  it("does not steal keystrokes typed into the search box", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    await act(async () => { click(container.querySelector("button[aria-label='Search canvas'], button[aria-label*='earch']")!); });
    const input = container.querySelector<HTMLInputElement>(".canvas-search input");
    expect(input).toBeTruthy();
    const before = lastProps!.command;
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "f" });
    await act(async () => { input!.dispatchEvent(ev); });
    expect(ev.defaultPrevented).toBe(false);
    expect(lastProps!.command).toBe(before);
    const ev2 = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "n" });
    await act(async () => { input!.dispatchEvent(ev2); });
    expect(ev2.defaultPrevented).toBe(false);
    // from the panel itself `f` still frames the selection
    const ev3 = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "f" });
    await act(async () => { container.querySelector(".canvas-panel")!.dispatchEvent(ev3); });
    expect(lastProps!.command?.kind).toBe("focus_selection");
  });
  it("treats a sidebar click as a one-shot select + frame and keeps following the agent's focus", async () => {
    const bridge = createBridge();
    const ext: Ref[] = [{ kind: "component", ref: "R1", sheet: "/" }];
    // A freshly mounted panel (project switch) must not replay the previous click; a new seq does.
    const { container, rerender } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 1, refs: ext }} />);
    expect(container).toBeTruthy();
    expect(lastProps!.command?.kind).not.toBe("focus_refs");
    await rerender(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 2, refs: ext }} />);
    expect(lastProps!.command?.kind).toBe("focus_refs");
    expect(lastProps!.selection).toEqual(ext);
    const agentFocus: Ref[] = [{ kind: "component", ref: "U7" }];
    await act(async () => { bridge.setState((s) => ({ ...s, focus: agentFocus })); });
    // The panel hands the canvas explicit highlight groups: the agent's focus, and — separately —
    // what the turn drew and changed, so the two never overwrite each other.
    expect(lastProps!.highlight).toEqual([{ refs: agentFocus, kind: "focus" }]);
    await act(async () => { bridge.setState((s) => ({ ...s, turnChanges: { turn: 1, uuids: ["u-1"], refs: ["C4"], created: [], changed: [] } })); });
    // created (drawn this turn, addressed by uuid) and changed (edited, still addressed by designator)
    // are separate groups so the canvas can give them separate styles.
    expect(lastProps!.highlight).toEqual([
      { refs: agentFocus, kind: "focus" },
      { refs: [], kind: "created", uuids: ["u-1"] },
      { refs: [{ kind: "component", ref: "C4" }], kind: "changed" },
    ]);
  });

  it("counts the turn's changes on this sheet against the ones on other sheets", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    // Sheet A carries the created wire `u-here` and nothing named C9; C9 and `u-away` live on sheet B.
    const sheetA = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", uuid: "s1", bbox: [[0, 0], [10, 10]], is_power: false, pins: [] }], wires: [{ uuid: "u-here", a: [0, 0], b: [10, 0], is_bus: false }], bus_entries: [], labels: [], junctions: [], no_connects: [], sheets: [], text_boxes: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheetA); });
    await act(async () => { bridge.setState((s) => ({ ...s, turnChanges: { turn: 1, uuids: ["u-here", "u-away"], refs: ["R1", "C9"], created: [], changed: [] } })); });
    // two here (the wire + R1), two elsewhere (the other sheet's wire + C9)
    expect(container.querySelector(".canvas-status")!.textContent).toContain("2 changes on this sheet, 2 elsewhere");
  });

  it("shows the grid pitch only while the grid is drawn, and the cursor in mil and mm", async () => {
    const { useSettings } = await import("../../state/settings");
    const before = useSettings.getState().settings;
    expect(before.agent.canvas_grid).toBe(false); // the grid is off by default: nothing to read out
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    // the pitch doubles as the view zooms out; at 0.1 the canvas is on the 200 mil grid
    expect(gridPitch(0.1)).toBe(200);
    await act(async () => { lastProps!.onHover!({ hit: null, screen: [1, 1], world: [100, 200], pitch: gridPitch(0.1) }); });
    const off = container.querySelector(".canvas-status")!.textContent!;
    expect(off).not.toContain("Grid");
    expect(off).toContain("100, 200 mil (2.54, 5.08 mm)");
    // with the grid on, the pitch on screen is named
    await act(async () => { useSettings.setState({ settings: { ...before, agent: { ...before.agent, canvas_grid: true } } } as never); });
    expect(container.querySelector(".canvas-status")!.textContent).toContain("Grid 200 mil");
    useSettings.setState({ settings: before } as never);
  });

  it("hides the turn's change highlight when the toolbar toggle is off, and the toggle turns it back on", async () => {
    const { useSettings } = await import("../../state/settings");
    const before = useSettings.getState().settings;
    useSettings.setState({ settings: { ...before, agent: { ...before.agent, canvas_changes: false } } } as never);
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    await act(async () => { bridge.setState((s) => ({ ...s, turnChanges: { turn: 1, uuids: ["u-1"], refs: [], created: [], changed: [] } })); });
    expect(lastProps!.highlight).toEqual([]);
    const toggle = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Highlight this turn's changes")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { useSettings.setState({ settings: { ...before, agent: { ...before.agent, canvas_changes: true } } } as never); });
    expect(lastProps!.highlight).toEqual([{ refs: [], kind: "created", uuids: ["u-1"] }]);
    useSettings.setState({ settings: before } as never);
  });
  it("walks findings with N starting at the first, Shift+N from the last, framing refs explicitly", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const sheet = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", bbox: [[100, 100], [200, 200]], pins: [] }, { reference: "R2", bbox: [[100, 0], [200, 50]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheet); });
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [
      { code: "A", severity: "Error", message: "", refs: ["R1.1"], origin: "engine", turn: 1, resolved: false },
      { code: "B", severity: "Error", message: "", refs: ["R2"], origin: "engine", turn: 1, resolved: false },
    ] as import("../../agent/api").FindingRow[] })); });
    await act(async () => { key(container.querySelector(".canvas-panel")!, { key: "N", shiftKey: true }); });
    // reading order is B (top) then A; Shift+N from nothing lands on the last = A
    expect(lastProps!.command?.kind).toBe("focus_refs");
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R1", sheet: "/" }]);
    expect(lastProps!.selection.some((r) => r.kind === "finding" && r.code === "A")).toBe(true);
    await act(async () => { key(container.querySelector(".canvas-panel")!, { key: "n" }); });
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R2", sheet: "/" }]);
    // P2-15: the findings panel's next / previous buttons run the same walk, so the two never
    // disagree about which finding is current.
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:walk-finding", { detail: { dir: 1 } })); });
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R1", sheet: "/" }]);
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:walk-finding", { detail: { dir: -1 } })); });
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R2", sheet: "/" }]);
  });
  it("shows loading until the sheet arrives, an error with retry when the render fails, and an empty hint", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    expect(container.querySelector(".canvas-overlay-loading")).toBeTruthy();
    await act(async () => { lastProps!.onError!("ENGINE_PANIC: boom"); });
    expect(container.querySelector(".canvas-overlay-error")!.textContent).toContain("ENGINE_PANIC");
    const before = lastProps!.revision;
    await act(async () => { click(container.querySelector(".canvas-overlay-error button")!); });
    expect(lastProps!.revision).toBe((before ?? 0) + 1);
    expect(container.querySelector(".canvas-overlay-loading")).toBeTruthy();
    const empty = { sheet_path: "/", file: "x.kicad_sch", symbols: [], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(empty); });
    expect(container.querySelector(".canvas-overlay-loading")).toBeNull();
    expect(container.querySelector(".canvas-overlay-empty")).toBeTruthy();
    // read-only hint once
    const { useToasts } = await import("../../state/toasts");
    const n0 = useToasts.getState().toasts.length;
    await act(async () => { lastProps!.onGestureHint!("read_only_drag"); lastProps!.onGestureHint!("read_only_key"); });
    expect(useToasts.getState().toasts.length).toBe(n0 + 1);
  });
  it("a focus request naming another sheet switches to it first and frames once it is ready", async () => {
    const { useProjects } = await import("../../state/projects");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const two = tab();
    two.info.sheets = [{ file: "x.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 0 }, { file: "power.kicad_sch", instance_path: "/u1/u2/", names: ["Power"], paper: "A4", symbols: 3 }];
    const bridge = createBridge();
    const ext: Ref[] = [{ kind: "component", ref: "C3", sheet: "power.kicad_sch" }];
    const { container, rerender } = await render(<CanvasPanel tab={two} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    expect(container).toBeTruthy();
    // an earlier selection on this sheet must survive the sheet switch + prune
    await act(async () => { lastProps!.onSelect([{ kind: "component", ref: "R9", sheet: "/" }]); });
    await rerender(<CanvasPanel tab={two} bridge={bridge} revision={0} externalFocus={{ seq: 1, refs: ext }} />);
    expect(setSheet).toHaveBeenCalledWith("k", "/u1/u2/");
    expect(lastProps!.command?.kind).not.toBe("focus_refs");
    // the child sheet's geometry arrives: the pending refs are selected and framed, not pruned away
    const child = { sheet_path: "/Power/", file: "power.kicad_sch", symbols: [{ reference: "C3", bbox: [[0, 0], [100, 100]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(child); });
    expect(lastProps!.command?.kind).toBe("focus_refs");
    expect(lastProps!.selection).toEqual(ext);
    // a ref on this sheet frames immediately
    await rerender(<CanvasPanel tab={two} bridge={bridge} revision={0} externalFocus={{ seq: 2, refs: [{ kind: "component", ref: "R1", sheet: "x.kicad_sch" }] }} />);
    expect(lastProps!.command?.kind).toBe("focus_refs");
  });
  it("reads out a no-connect flag and shows k / n for search matches with Enter cycling", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    await act(async () => { lastProps!.onHover!({ hit: { kind: "no_connect", uuid: "n1", at: [100, 100] }, screen: [1, 1], world: [100, 100] }); });
    expect(container.querySelector(".canvas-status")!.textContent).toMatch(/No-connect/);
    const sheet = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", value: "10k", lib_id: "Device:R", bbox: [[0, 0], [100, 100]], pins: [] }, { reference: "R2", value: "10k", lib_id: "Device:R", bbox: [[200, 0], [300, 100]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheet); });
    await act(async () => { click(container.querySelector("button[aria-label*='earch']")!); });
    const input = container.querySelector<HTMLInputElement>(".canvas-search input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "10k");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".canvas-search-count")!.textContent).toBe("1 / 2");
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(lastProps!.command?.kind).toBe("focus_refs");
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R1" }]);
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R2" }]);
    expect(container.querySelector(".canvas-search-count")!.textContent).toBe("2 / 2");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".canvas-search-count")!.textContent).toMatch(/No match/);
  });
  it("frames a finding that names no component, counts the ones it cannot place, and pins the selected net with `", async () => {
    const bridge = createBridge();
    const { container, rerender } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const sheet = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", bbox: [[100, 100], [200, 200]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheet); });
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [
      { code: "ERC_W", severity: "Warning", message: "", location: "w1", at_mil: [500, 600], origin: "engine", turn: 1, resolved: false },
      { code: "SHEET_LEVEL", severity: "Info", message: "", origin: "advisory", turn: 1, resolved: false },
    ] as unknown as import("../../agent/api").FindingRow[] })); });
    const status = () => container.querySelector(".canvas-status")!.textContent ?? "";
    // P1-6: the canvas shows what the findings panel shows. Info is off by default (eeschema's ERC
    // dialog opens with Error + Warning), so the sheet-level note is neither drawn nor counted.
    expect(status()).toContain("1 findings on this sheet");
    expect(status()).not.toContain("without a position");
    await act(async () => { bridge.getState().setFindingFilter({ severities: { error: true, warning: true, info: true } }); });
    expect(status()).toContain("2 findings on this sheet");
    expect(status()).toContain("(1 without a position)");
    await act(async () => { bridge.getState().setFindingFilter({ severities: { error: true, warning: true, info: false } }); });
    expect(status()).toContain("1 findings on this sheet");
    // a sidebar click on the wire finding (no component refs) frames its marker anchor
    await rerender(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 1, refs: [{ kind: "finding", code: "ERC_W", location: "w1" }] }} />);
    expect(lastProps!.command?.kind).toBe("focus_refs");
    expect(lastProps!.command?.box).toEqual([[499, 599], [501, 601]]);
    // ` with nothing hovered pins the net of the selection
    await act(async () => { lastProps!.onSelect([{ kind: "net", name: "VOUT" }]); });
    await act(async () => { key(container.querySelector(".canvas-panel")!, { key: "`" }); });
    expect(lastProps!.hoverNet).toBe("VOUT");
    expect(status()).toContain("VOUT");
    await act(async () => { key(container.querySelector(".canvas-panel")!, { key: "`" }); });
    expect(lastProps!.hoverNet).toBeNull();
  });
  it("enters the instance the double-clicked sheet symbol stands for, not the first instance of its file", async () => {
    const { useProjects } = await import("../../state/projects");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const reused = tab();
    // One file, drawn twice on the root: the two symbols differ only by uuid, and so do the instances.
    reused.info.sheets = [
      { file: "root.kicad_sch", instance_path: "/r", names: [], paper: "A4", symbols: 2 },
      { file: "amp.kicad_sch", instance_path: "/r/a1", names: ["Left"], paper: "A4", symbols: 4 },
      { file: "amp.kicad_sch", instance_path: "/r/a2", names: ["Right"], paper: "A4", symbols: 4 },
    ];
    reused.sheet = "/r";
    const bridge = createBridge();
    await render(<CanvasPanel tab={reused} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const sheetHit = (uuid: string): import("../../canvas/hittest").Hit => ({ kind: "sheet", uuid, name: "amp", file: "amp.kicad_sch", bbox: [[0, 0], [100, 100]] });
    await act(async () => { lastProps!.onOpen!(sheetHit("a1"), []); });
    expect(setSheet).toHaveBeenLastCalledWith("k", "/r/a1");
    await act(async () => { lastProps!.onOpen!(sheetHit("a2"), []); });
    expect(setSheet).toHaveBeenLastCalledWith("k", "/r/a2");
    // A double-click that lands on a sheet pin (it sits on the symbol's border) enters the same instance.
    await act(async () => { lastProps!.onOpen!({ kind: "sheet_pin", uuid: "p1", name: "VIN", shape: "input", side: "left", sheet_uuid: "a2", sheet_name: "amp", sheet_file: "amp.kicad_sch", at: [0, 0] }, []); });
    expect(setSheet).toHaveBeenLastCalledWith("k", "/r/a2");
    // An unknown symbol uuid is not a sheet of this project: fall through to the detail, never guess.
    setSheet.mockClear();
    await act(async () => { lastProps!.onOpen!(sheetHit("nope"), [{ kind: "sheet", path: "/amp/" }]); });
    expect(setSheet).not.toHaveBeenCalled();
  });
  it("goes up one instance from a reused sheet, and offers no parent at the root", async () => {
    const { useProjects } = await import("../../state/projects");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const deep = tab();
    deep.info.sheets = [
      { file: "root.kicad_sch", instance_path: "/r", names: [], paper: "A4", symbols: 2 },
      { file: "amp.kicad_sch", instance_path: "/r/a1", names: ["Left"], paper: "A4", symbols: 4 },
      { file: "amp.kicad_sch", instance_path: "/r/a2", names: ["Right"], paper: "A4", symbols: 4 },
      { file: "filter.kicad_sch", instance_path: "/r/a2/f1", names: ["Right", "Filter"], paper: "A4", symbols: 3 },
    ];
    deep.sheet = "/r/a2/f1";
    const bridge = createBridge();
    const { container, rerender } = await render(<CanvasPanel tab={deep} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const parent = () => [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Parent sheet");
    await act(async () => { click(parent()!); });
    expect(setSheet).toHaveBeenLastCalledWith("k", "/r/a2");
    // The status bar names the instance, not the file: two instances of one file read differently.
    expect(container.querySelector(".canvas-status")!.textContent).toContain("Right / Filter");
    const root = { ...deep, sheet: "/r" } as typeof deep;
    await rerender(<CanvasPanel tab={root} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    expect(parent()).toBeUndefined();
  });
  it("frames a sidebar ref on the instance it names, even when another instance of the file comes first", async () => {
    const { useProjects } = await import("../../state/projects");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const reused = tab();
    reused.info.sheets = [
      { file: "root.kicad_sch", instance_path: "/r", names: [], paper: "A4", symbols: 2 },
      { file: "amp.kicad_sch", instance_path: "/r/a1", names: ["Left"], paper: "A4", symbols: 4 },
      { file: "amp.kicad_sch", instance_path: "/r/a2", names: ["Right"], paper: "A4", symbols: 4 },
    ];
    reused.sheet = "/r";
    const bridge = createBridge();
    const ext: Ref[] = [{ kind: "component", ref: "R7", sheet: "/r/a2" }];
    const { rerender } = await render(<CanvasPanel tab={reused} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    await rerender(<CanvasPanel tab={reused} bridge={bridge} revision={0} externalFocus={{ seq: 1, refs: ext }} />);
    expect(setSheet).toHaveBeenCalledWith("k", "/r/a2");
  });
  it("takes a chat ref chip to the sheet that has the part, and selects it there", async () => {
    const { useProjects } = await import("../../state/projects");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const two = tab();
    two.info.sheets = [{ file: "x.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 1 }, { file: "power.kicad_sch", instance_path: "/u1/u2/", names: ["Power"], paper: "A4", symbols: 3 }];
    const bridge = createBridge();
    await render(<CanvasPanel tab={two} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const here = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", bbox: [[0, 0], [100, 100]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(here); });
    // `[[ref:component:C9]]` in the chat: C9 is not on this sheet, so the panel asks the engine where it is.
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:focus-ref", { detail: { kind: "component", value: "C9" } })); });
    await settle();
    expect(setSheet).toHaveBeenCalledWith("k", "/u1/u2/");
    const child = { sheet_path: "/Power/", file: "power.kicad_sch", symbols: [{ reference: "C9", value: "100n", lib_id: "Device:C", bbox: [[0, 0], [100, 100]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(child); });
    expect(bridge.getState().selection).toEqual([{ kind: "component", ref: "C9", sheet: "/u1/u2/" }]);
    expect(lastProps!.command?.kind).toBe("focus_refs");
    // A chip naming something on this sheet stays here and selects it (no sheet switch, no text search).
    setSheet.mockClear();
    await act(async () => { lastProps!.onReady!(here); });
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:focus-ref", { detail: { kind: "component", value: "R1" } })); });
    await settle();
    expect(setSheet).not.toHaveBeenCalled();
    expect(bridge.getState().selection).toEqual([{ kind: "component", ref: "R1" }]);
  });
  it("answers the canvas keys without a click on the drawing, and not while the human is typing", async () => {
    const bridge = createBridge();
    await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const sheet = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", bbox: [[100, 100], [200, 200]], pins: [] }, { reference: "R2", bbox: [[100, 0], [200, 50]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheet); });
    await act(async () => { bridge.setState((s) => ({ ...s, findings: [
      { code: "A", severity: "Error", message: "", refs: ["R1"], origin: "engine", turn: 1, resolved: false },
      { code: "B", severity: "Error", message: "", refs: ["R2"], origin: "engine", turn: 1, resolved: false },
    ] as import("../../agent/api").FindingRow[] })); });
    // No pointer has touched the canvas: `N` still walks the findings (reading order puts R2 first).
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })); });
    expect(lastProps!.command?.kind).toBe("focus_refs");
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R2", sheet: "/" }]);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })); });
    expect(lastProps!.command?.refs).toEqual([{ kind: "component", ref: "R1", sheet: "/" }]);
    // The same key typed into a text field (the chat composer) belongs to the field.
    const composer = document.createElement("input");
    document.body.appendChild(composer);
    const before = lastProps!.command;
    await act(async () => { composer.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })); });
    expect(lastProps!.command).toBe(before);
    composer.remove();
  });
  it("offers the sheet that has it when the search finds nothing here", async () => {
    const { useProjects } = await import("../../state/projects");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const two = tab();
    two.info.sheets = [{ file: "x.kicad_sch", instance_path: "/", names: [], paper: "A4", symbols: 1 }, { file: "power.kicad_sch", instance_path: "/u1/u2/", names: ["Power"], paper: "A4", symbols: 3 }];
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={two} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const sheet = { sheet_path: "/", file: "x.kicad_sch", symbols: [{ reference: "R1", value: "10k", lib_id: "Device:R", bbox: [[0, 0], [100, 100]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheet); });
    await act(async () => { click(container.querySelector("button[aria-label*='earch']")!); });
    const input = container.querySelector<HTMLInputElement>(".canvas-search input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "C9");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".canvas-search-count")!.textContent).toMatch(/No match/);
    await settle(320); // the debounce, then the engine's project-wide answer
    const jump = container.querySelector<HTMLButtonElement>(".canvas-search-jump")!;
    expect(jump.textContent).toContain("Power");
    await act(async () => { click(jump); });
    expect(setSheet).toHaveBeenCalledWith("k", "/u1/u2/");
    // Once there, the part is selected and framed rather than only scrolled to.
    const child = { sheet_path: "/Power/", file: "power.kicad_sch", symbols: [{ reference: "C9", value: "100n", lib_id: "Device:C", bbox: [[0, 0], [100, 100]], pins: [] }], labels: [], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(child); });
    expect(bridge.getState().selection).toEqual([{ kind: "component", ref: "C9", sheet: "/u1/u2/" }]);
  });
  it("honours a remapped canvas shortcut from settings", async () => {
    const { useSettings } = await import("../../state/settings");
    const st = useSettings.getState();
    useSettings.setState({ settings: { ...st.settings, shortcuts: { ...st.settings.shortcuts, focusSelection: "G" } } } as never);
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const panel = container.querySelector(".canvas-panel")!;
    const before = lastProps!.command;
    await act(async () => { key(panel, { key: "f" }); });
    expect(lastProps!.command).toBe(before); // the old key no longer fires
    await act(async () => { key(panel, { key: "g" }); });
    expect(lastProps!.command?.kind).toBe("focus_selection");
    useSettings.setState({ settings: st.settings } as never);
  });
  it("moves the hand-off with a remapped fitAll and never answers a key the drawing already took", async () => {
    const { useSettings } = await import("../../state/settings");
    const st = useSettings.getState();
    // `fitAll` moved from `Mod+Home` to bare `Home`: the drawing has to be told, or both layers fit.
    useSettings.setState({ settings: { ...st.settings, shortcuts: { ...st.settings.shortcuts, fitAll: "Home" } } } as never);
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    expect([...(lastProps!.panelKeys ?? [])]).toContain("Home");
    expect([...(lastProps!.panelKeys ?? [])]).not.toContain("Mod+Home");
    const panel = container.querySelector(".canvas-panel")!;
    await act(async () => { key(panel, { key: "Home" }); });
    expect(lastProps!.command?.kind).toBe("fit");
    // The old combo is nobody's now, and the drawing keeps its own keys out of the panel's set.
    const before = lastProps!.command;
    await act(async () => { key(panel, { key: "Home", metaKey: true }); });
    expect(lastProps!.command).toBe(before);
    // A key the drawing consumed on the way up (it calls preventDefault) is not answered again here.
    const taken = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" });
    panel.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    await act(async () => { panel.dispatchEvent(taken); });
    expect(lastProps!.command).toBe(before);
    useSettings.setState({ settings: st.settings } as never);
  });
  it("cycles the stacked candidates with [ and ] without a click on the drawing", async () => {
    const bridge = createBridge();
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    // The drawing owns the stack of candidates; the key reaches it as a command, from the document.
    expect([...(lastProps!.panelKeys ?? [])]).toEqual(expect.arrayContaining(["[", "]"]));
    expect([...(lastProps!.panelKeys ?? [])]).not.toContain("Enter"); // openDetail stays with the drawing
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "]", bubbles: true })); });
    expect(lastProps!.command?.kind).toBe("cycle_next");
    await act(async () => { key(container.querySelector(".canvas-panel")!, { key: "[" }); });
    expect(lastProps!.command?.kind).toBe("cycle_prev");
  });
  it("leaves Mod+F to the app shell and copies only from inside the panel", async () => {
    const bridge = createBridge();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    const panel = container.querySelector(".canvas-panel")!;
    // Mod+F is a global shortcut: the shell dispatches `fs:canvas-search`, so the panel must not also
    // answer the keystroke (it would open the box twice over).
    await act(async () => { key(panel, { key: "f", metaKey: true }); });
    expect(container.querySelector(".canvas-search")).toBeNull();
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:canvas-search")); });
    expect(container.querySelector(".canvas-search")).toBeTruthy();
    // Mod+C outside the panel belongs to whatever has focus; inside it copies the selection.
    await act(async () => { lastProps!.onSelect([{ kind: "component", ref: "R1", sheet: "/" }]); });
    await act(async () => { key(document.body, { key: "c", metaKey: true }); });
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => { key(panel, { key: "c", metaKey: true }); });
    expect(writeText).toHaveBeenCalledWith("R1");
  });
  it("asks the engine where a net is instead of reading it off the drawn label text", async () => {
    const { useProjects } = await import("../../state/projects");
    const { call } = await import("../../ipc/client");
    const setSheet = vi.fn();
    useProjects.setState({ setSheet } as never);
    const bridge = createBridge();
    await render(<CanvasPanel tab={tab()} bridge={bridge} revision={0} externalFocus={{ seq: 0, refs: [] }} />);
    // The sheet draws a label reading SDA, but the engine's net_map (mocked above) puts no net of that
    // name here: membership is the engine's word, so the chip goes looking for the sheet that has it.
    const sheet = { sheet_path: "/", file: "x.kicad_sch", symbols: [], labels: [{ uuid: "l1", text: "SDA", kind: "local", bbox: [[0, 0], [10, 10]] }], sheets: [], wires: [], junctions: [] } as unknown as import("../../canvas/types").RenderSheet;
    await act(async () => { lastProps!.onReady!(sheet); });
    (call as unknown as { mockClear: () => void }).mockClear();
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:focus-ref", { detail: { kind: "net", value: "SDA" } })); });
    await settle();
    expect((call as unknown as { mock: { calls: [string, { request?: { kind?: string } }][] } }).mock.calls.some(([, a]) => a?.request?.kind === "nets")).toBe(true);
    // VOUT is on this sheet per the engine map (wire w1): no lookup, no sheet switch.
    (call as unknown as { mockClear: () => void }).mockClear();
    await act(async () => { document.dispatchEvent(new CustomEvent("fs:focus-ref", { detail: { kind: "net", value: "VOUT" } })); });
    await settle();
    expect((call as unknown as { mock: { calls: [string, { request?: { kind?: string } }][] } }).mock.calls.some(([, a]) => a?.request?.kind === "nets")).toBe(false);
    expect(setSheet).not.toHaveBeenCalled();
  });
});
