// SPDX-License-Identifier: Apache-2.0
// Staleness guard: a geometry response that arrives after a newer request must be dropped, plus the
// keyboard-only fallbacks (`Enter` opens the selected component, `[` / `]` cycle from the selection),
// the middle-button default suppression (Chromium autoscroll), the keymap-driven hand-off to the panel
// and the end of a drag whose release this window never saw.

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SETTINGS, useSettings } from "../state/settings";
import { emptySheet, type RenderSheet } from "./types";

type Deferred = { resolve: (v: unknown) => void };
const pending = new Map<string, Deferred[]>();

vi.mock("../ipc/client", () => ({
  isTauri: () => false,
  call: (_name: string, args: { request?: { sheet?: string } }) => {
    const sheet = args.request?.sheet ?? "";
    return new Promise((resolve) => {
      const list = pending.get(sheet) ?? [];
      list.push({ resolve });
      pending.set(sheet, list);
    });
  },
}));

function resolveSheet(sheet: string, rs?: RenderSheet): void {
  const data: RenderSheet = rs ?? { ...emptySheet(sheet), sheet_path: sheet };
  for (const d of pending.get(sheet) ?? []) d.resolve({ ok: true, data });
  pending.delete(sheet);
}

/** Two symbols stacked at the same point (the small one wins the first slot of the hit ladder). */
function stackedSheet(path: string): RenderSheet {
  const s = emptySheet(path);
  const sym = (reference: string, uuid: string, bbox: [[number, number], [number, number]]) => ({
    reference, value: "1k", uuid, lib_id: "Device:R", unit: 1, dnp: false, is_power: false,
    at: [200, 200] as [number, number], rotation: 0, mirror: "none" as const, shapes: [], texts: [], pins: [], bbox, unresolved: false,
  });
  s.symbols.push(sym("R1", "u1", [[0, 0], [400, 400]]));
  s.symbols.push(sym("R2", "u2", [[150, 150], [250, 250]]));
  return s;
}

describe("CanvasView fetch staleness", () => {
  it("shows the sheet of the latest request even when an older response lands later", async () => {
    // jsdom has no Canvas 2D: the frame exits early once `getContext` returns null.
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
    const { CanvasView } = await import("./CanvasView");
    const ready: string[] = [];
    const handle = React.createRef<import("./CanvasView").CanvasViewHandle>();
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root: Root | null = null;
    const render = (sheet: string) => (
      <CanvasView ref={handle} projectKey="p" sheet={sheet} selection={[]} onSelect={() => undefined} highlight={[]} follow={false} theme="light" grid={false} onReady={(s) => ready.push(s.sheet_path)} />
    );
    await act(async () => { root = createRoot(host); root.render(render("/a/")); });
    await act(async () => { root!.render(render("/b/")); });
    expect(pending.has("/a/")).toBe(true);
    expect(pending.has("/b/")).toBe(true);
    // B answers first, then the stale A response arrives
    await act(async () => { resolveSheet("/b/"); await Promise.resolve(); });
    await act(async () => { resolveSheet("/a/"); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(handle.current?.sheet()?.sheet_path).toBe("/b/");
    expect(ready).toEqual(["/b/"]);
    await act(async () => { root!.unmount(); });
  });
});

/** jsdom has no PointerEvent in every version; a MouseEvent of the same type is what React reads. */
function pointer(type: string, init: MouseEventInit & { pointerId?: number }): MouseEvent {
  const Ctor = (globalThis as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  return new Ctor(type, { bubbles: true, cancelable: true, ...init });
}

/** Mounts a canvas on `sheet` and resolves its geometry; returns the scene canvas and the handle. */
async function mountCanvas(rs?: RenderSheet, sheetPath = "/g/", panelKeys?: ReadonlySet<string>) {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
  const { CanvasView } = await import("./CanvasView");
  const handle = React.createRef<import("./CanvasView").CanvasViewHandle>();
  const selected: unknown[][] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root: Root | null = null;
  const el = (
    <CanvasView ref={handle} projectKey="p" sheet={sheetPath} selection={[]} onSelect={(refs) => selected.push(refs)} highlight={[]} follow={false} theme="light" grid={false} panelKeys={panelKeys} />
  );
  await act(async () => { root = createRoot(host); root.render(el); });
  await act(async () => { resolveSheet(sheetPath, rs ?? stackedSheet(sheetPath)); await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const canvas = host.querySelector("canvas.canvas-scene") as HTMLCanvasElement;
  return { canvas, handle, selected, unmount: async () => { await act(async () => { root!.unmount(); }); host.remove(); } };
}

describe("CanvasView pointer defaults", () => {
  it("cancels the middle button so Chromium never starts its autoscroll widget", async () => {
    const { canvas, unmount } = await mountCanvas();
    // Cancelling `pointerdown` suppresses the compatibility `mousedown` that starts autoscroll
    // (WebView2 on Windows); `auxclick` is the second half of the same gesture.
    const middle = pointer("pointerdown", { button: 1, clientX: 20, clientY: 20 });
    await act(async () => { canvas.dispatchEvent(middle); });
    expect(middle.defaultPrevented).toBe(true);
    const aux = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
    await act(async () => { canvas.dispatchEvent(aux); });
    expect(aux.defaultPrevented).toBe(true);
    // The left button keeps its default (focus, native selection handling).
    const left = pointer("pointerdown", { button: 0, clientX: 20, clientY: 20 });
    await act(async () => { canvas.dispatchEvent(left); });
    expect(left.defaultPrevented).toBe(false);
    await unmount();
  });
});

describe("CanvasView key hand-off", () => {
  it("cedes exactly the combos the panel owns, so a remap moves the hand-off with it", async () => {
    // Default keymap: the panel's `fitAll` is `Mod+Home`.
    const { canvas, handle, unmount } = await mountCanvas(undefined, "/h/", new Set(["Mod+Home", "F", "["]));
    const before = handle.current!.view();
    // The event bubbles to the panel, which fits through its command channel: not here as well.
    const ctrlHome = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home", ctrlKey: true });
    await act(async () => { canvas.dispatchEvent(ctrlHome); });
    expect(handle.current!.view()).toEqual(before);
    expect(ctrlHome.defaultPrevented).toBe(false); // not consumed here
    const metaHome = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home", metaKey: true });
    await act(async () => { canvas.dispatchEvent(metaHome); });
    expect(handle.current!.view()).toEqual(before);
    // Bare Home is not the panel's: the canvas' own fit answers it.
    const home = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" });
    await act(async () => { canvas.dispatchEvent(home); });
    expect(handle.current!.view()).not.toEqual(before);
    expect(home.defaultPrevented).toBe(true);
    await unmount();
  });

  it("hands over bare Home when the human remapped fitAll to it, and takes Mod+Home back", async () => {
    // The same keymap with `fitAll` moved to bare `Home`: the guard has to move with it, or the
    // canvas would fit here and the panel again (two fits), and Mod+Home would be dead everywhere.
    const { canvas, handle, unmount } = await mountCanvas(undefined, "/h2/", new Set(["Home"]));
    const before = handle.current!.view();
    const home = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" });
    await act(async () => { canvas.dispatchEvent(home); });
    expect(handle.current!.view()).toEqual(before);
    expect(home.defaultPrevented).toBe(false); // left to the panel
    const ctrlHome = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home", ctrlKey: true });
    await act(async () => { canvas.dispatchEvent(ctrlHome); });
    expect(handle.current!.view()).not.toEqual(before); // no longer bound in the panel: the canvas fits
    await unmount();
  });

  it("ends a drag whose release it never saw: lost capture, window blur, no button down", async () => {
    const { canvas, handle, unmount } = await mountCanvas(emptySheet("/p/"), "/p/");
    const start = handle.current!.view();
    const down = () => act(async () => { canvas.dispatchEvent(pointer("pointerdown", { button: 1, buttons: 4, clientX: 300, clientY: 300 })); });
    const move = (x: number, buttons: number) => act(async () => { canvas.dispatchEvent(pointer("pointermove", { buttons, clientX: x, clientY: 300 })); });
    // A middle-button drag pans, as it should.
    await down();
    await move(340, 4);
    const panned = handle.current!.view();
    expect(panned).not.toEqual(start);
    // The pointer capture is taken away (a dialog, another window): the drag is over even though no
    // pointerup ever arrived, so a later move with the button still reported down must not pan.
    await act(async () => { canvas.dispatchEvent(pointer("lostpointercapture", { buttons: 4, clientX: 340, clientY: 300 })); });
    await move(600, 4);
    expect(handle.current!.view()).toEqual(panned);
    // The window loses focus mid-drag: same rule.
    await down();
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    await move(700, 4);
    expect(handle.current!.view()).toEqual(panned);
    // The button came up outside the window: the first move that reports no button ends it.
    await down();
    await move(800, 0);
    await move(900, 0);
    expect(handle.current!.view()).toEqual(panned);
    await unmount();
  });
});

describe("canvas.drag_selects setting", () => {
  afterEach(() => { act(() => { useSettings.setState({ settings: DEFAULT_SETTINGS }); }); });

  it("off (default) pans an empty-space drag; on, the same drag rubber-bands and the view holds still", async () => {
    expect(DEFAULT_SETTINGS.agent.canvas_drag_selects).toBe(false); // the setting round-trips through the store
    const drag = async (canvas: HTMLCanvasElement) => {
      await act(async () => { canvas.dispatchEvent(pointer("pointerdown", { button: 0, buttons: 1, clientX: 600, clientY: 600 })); });
      // `buttons` as a real drag reports it: the left button is still down while the pointer moves.
      await act(async () => { canvas.dispatchEvent(pointer("pointermove", { button: 0, buttons: 1, clientX: 640, clientY: 650 })); });
      await act(async () => { canvas.dispatchEvent(pointer("pointerup", { button: 0, buttons: 0, clientX: 640, clientY: 650 })); });
    };
    const off = await mountCanvas(emptySheet("/d1/"), "/d1/");
    const beforeOff = off.handle.current!.view();
    await drag(off.canvas);
    expect(off.handle.current!.view()).not.toEqual(beforeOff); // panned
    await off.unmount();

    await act(async () => { useSettings.setState({ settings: { ...DEFAULT_SETTINGS, agent: { ...DEFAULT_SETTINGS.agent, canvas_drag_selects: true } } }); });
    expect(useSettings.getState().settings.agent.canvas_drag_selects).toBe(true);
    const on = await mountCanvas(emptySheet("/d2/"), "/d2/");
    const beforeOn = on.handle.current!.view();
    await drag(on.canvas);
    expect(on.handle.current!.view()).toEqual(beforeOn); // rubber band: the view never moves
    // The band reports the dragged region (an empty sheet has nothing in it).
    expect((on.selected.at(-1) as { kind: string }[])[0].kind).toBe("region");
    await on.unmount();
  });
});

describe("CanvasView keyboard fallbacks", () => {
  it("opens the single selected component with Enter and cycles the objects at the selection with ] / [", async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
    const { CanvasView } = await import("./CanvasView");
    const opened: string[] = [];
    const selected: string[][] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root: Root | null = null;
    const el = (
      <CanvasView
        projectKey="p"
        sheet="/k/"
        selection={[{ kind: "component", ref: "R1" }]}
        onSelect={(refs) => selected.push(refs.map((r) => (r.kind === "component" ? r.ref : r.kind)))}
        onOpen={(hit) => opened.push(hit.kind === "symbol" ? hit.reference : hit.kind)}
        highlight={[]}
        follow={false}
        theme="light"
        grid={false}
      />
    );
    await act(async () => { root = createRoot(host); root.render(el); });
    await act(async () => { resolveSheet("/k/", stackedSheet("/k/")); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const canvas = host.querySelector("canvas.canvas-scene")!;
    // Enter is the keyboard double-click: the detail of the one selected component.
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
    expect(opened).toEqual(["R1"]);
    // ] with no previous click: the objects stacked at the selection, smallest first.
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "]" })); });
    await act(async () => { canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "]" })); });
    expect(selected).toEqual([["R1"], ["R2"]]);
    await act(async () => { root!.unmount(); });
  });
});
