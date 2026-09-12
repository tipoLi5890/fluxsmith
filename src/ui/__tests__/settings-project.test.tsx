// SPDX-License-Identifier: Apache-2.0
// Project settings tab (docs/settings.md §6): a benign row writes one key through sidecar_write, a
// guarded row (rails / [[waiver]] / [check] / backup_depth) is confirmed by the human first and then
// written by project_config_apply against that consent event, and a refusal is shown under its row
// with the control left where the file has it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const config = {
  display_units: "mil",
  backup_depth: 3,
  rails: { names: ["GND"], mechanism: "power_port" },
  check: { fail_on: "error" },
  waiver: [{ code: "ERC_POWER_IN_UNDRIVEN", refs: ["J1"], reason: "external supply", granted: "2026-01-01T00:00:00Z" }],
};
/** Commands that must fail this run, by name, with the error the Rust side would return. */
const fail = new Map<string, { code: string; message: string }>();
const invoke = vi.fn(async (cmd: string, _args: unknown) => {
  const f = fail.get(cmd);
  if (f) throw { ...f, req_id: "r1" };
  if (cmd === "sidecar_read") return config;
  if (cmd === "consent_record") return { id: "consent-7" };
  if (cmd === "project_config_apply") return config;
  if (cmd === "db_query") return {};
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a: unknown) => invoke(c, a), Channel: class { onmessage: unknown } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null, save: async () => null }));

import { ProjectSettingsTab } from "../settings/SettingsDialog";

function mount(el: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, root };
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (el: Element | null | undefined) => { if (!el) throw new Error("missing element"); act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
/** The row whose label matches, as the settings dialog renders it. */
const row = (host: HTMLElement, label: string) => Array.from(host.querySelectorAll<HTMLElement>(".srow")).find((r) => (r.dataset.label ?? "").includes(label.toLowerCase()));
const setSelect = (el: HTMLSelectElement | null | undefined, value: string) => {
  if (!el) throw new Error("missing select");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const argsOf = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1] as Record<string, unknown>);
/** Press the dialog's consent button (armed after 500 ms of visibility; jsdom has no IntersectionObserver). */
async function confirmDialog(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button.btn-consent")).at(-1);
  click(btn);
  await flush();
}

async function mountTab(): Promise<HTMLElement> {
  const { host } = mount(<ProjectSettingsTab projectKey="pk" root="/p" />);
  await flush();
  return host;
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  invoke.mockClear();
  fail.clear();
  document.body.innerHTML = "";
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
});

describe("project settings tab", () => {
  it("a benign row writes only the key it changed, and never the whole config", async () => {
    const host = await mountTab();
    const units = row(host, "unit")?.querySelector<HTMLSelectElement>("select");
    setSelect(units, "mm");
    await flush();
    const writes = argsOf("sidecar_write");
    expect(writes.length).toBe(1);
    // A shallow one-key patch: Rust merges it, so rails / waiver / check never travel with it.
    expect((writes[0].write as { config: Record<string, unknown> }).config).toEqual({ display_units: "mm" });
    expect(argsOf("project_config_apply").length).toBe(0);
  });

  it("a guarded row writes nothing until the human confirms, then sends exactly that one key", async () => {
    const host = await mountTab();
    const failOn = row(host, "check")?.querySelector<HTMLSelectElement>("select");
    setSelect(failOn, "warning");
    await flush();
    expect(argsOf("sidecar_write").length).toBe(0);
    expect(argsOf("project_config_apply").length).toBe(0);
    expect(document.querySelector("[role='dialog']")).toBeTruthy();
    await confirmDialog();
    expect(argsOf("consent_record")[0].event).toMatchObject({ project_key: "pk", card_kind: "project_config", input_kind: "click" });
    expect(argsOf("project_config_apply")[0]).toMatchObject({ project_key: "pk", consent_event_id: "consent-7", edit: { op: "set", key: "check", value: { fail_on: "warning" } } });
    expect(argsOf("sidecar_write").length).toBe(0);
  });

  it("removing a waiver revokes one record by index and granted stamp", async () => {
    const host = await mountTab();
    const remove = row(host, "waiver")?.querySelector<HTMLButtonElement>("button");
    click(remove);
    await flush();
    expect(argsOf("project_config_apply").length).toBe(0);
    await confirmDialog();
    expect(argsOf("project_config_apply")[0].edit).toEqual({ op: "waiver_revoke", index: 0, granted: "2026-01-01T00:00:00Z" });
  });

  it("cancelling the confirm writes nothing", async () => {
    const host = await mountTab();
    setSelect(row(host, "check")?.querySelector<HTMLSelectElement>("select"), "warning");
    await flush();
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")).find((b) => !b.classList.contains("btn-consent") && !b.classList.contains("dialog-close"));
    click(cancel);
    await flush();
    expect(argsOf("project_config_apply").length).toBe(0);
    expect(argsOf("consent_record").length).toBe(0);
  });

  it("a refused write leaves the control where the file has it and shows the error under that row", async () => {
    fail.set("sidecar_write", { code: "POLICY_DENY_P1", message: "display_units changes require a policy card" });
    const host = await mountTab();
    const units = row(host, "unit")?.querySelector<HTMLSelectElement>("select");
    setSelect(units, "mm");
    await flush();
    expect(row(host, "unit")?.querySelector<HTMLSelectElement>("select")?.value).toBe("mil");
    expect(row(host, "unit")?.querySelector(".field-error")?.textContent ?? "").not.toBe("");
    // The failure belongs to its own row, not to the whole tab.
    expect(row(host, "waiver")?.querySelector(".field-error")).toBeFalsy();
  });

  it("a refused guarded write is reported under its row too", async () => {
    fail.set("project_config_apply", { code: "BAD_CONFIG", message: "the waiver list changed" });
    const host = await mountTab();
    click(row(host, "waiver")?.querySelector<HTMLButtonElement>("button"));
    await flush();
    await confirmDialog();
    expect(row(host, "waiver")?.querySelector(".field-error")?.textContent ?? "").not.toBe("");
    expect(document.querySelector("[role='dialog']")).toBeFalsy();
  });
});
