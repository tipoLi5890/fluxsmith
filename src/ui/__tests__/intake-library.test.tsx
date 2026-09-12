// SPDX-License-Identifier: Apache-2.0
// "Add to project symbol library" on the intake card: the action the human needs so a dropped
// `.kicad_sym` / `.pretty` is not a dead end (the agent can only propose it). It must be offered
// for libraries only, never preselected, and it must go through consent + a `lib_import` grant
// before Rust copies anything.
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "consent_record") return { id: "consent-9" };
    if (cmd === "grant_create") return { id: "grant-9", kind: "lib_import", expires_at: "" };
    if (cmd === "lib_register") return { nickname: "MyParts", written: ["lib/MyParts.kicad_sym"], reused: [], registered: ["sym-lib-table"], symbols: ["MyParts:A", "MyParts:B"], lib_dir: "lib" };
    return null;
  },
  Channel: class { onmessage: unknown },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { actionsFor, libNickname, makeItem, registerLibrary, suggestedAction, intakeMode } from "../chat/intake";
import { IntakeDialog } from "../chat/IntakeDialog";

const item = (name: string, path?: string, group?: string) => ({ ...makeItem({ name, path, group }, {}), action: "attach" as const });

describe("intake: add to project symbol library", () => {
  it("offers the action for libraries only and never as the suggested default", () => {
    expect(actionsFor(item("MyParts.kicad_sym", "/drop/MyParts.kicad_sym"))).toContain("library");
    expect(actionsFor(item("R_0603.kicad_mod", "/drop/MyParts.pretty/R_0603.kicad_mod", "MyParts.pretty"))).toContain("library");
    expect(actionsFor(item("ds.pdf", "/drop/ds.pdf"))).not.toContain("library");
    // A `.pretty` dropped without a path on disk cannot be copied: no action offered.
    expect(actionsFor({ ...item("R_0603.kicad_mod", undefined, "MyParts.pretty"), path: null })).not.toContain("library");
    expect(suggestedAction("lib", {})).toBe("attach");
    expect(suggestedAction("lib", { lib: "keep" })).toBe("keep");
    // The library rows are also kept in the project, so their attachment mode is `keep`.
    expect(intakeMode("library")).toBe("keep");
    expect(libNickname("/drop/My Parts.kicad_sym")).toBe("My_Parts");
    expect(libNickname("MyParts.pretty")).toBe("MyParts");
  });

  it("records consent, mints a lib_import grant and hands Rust the path", async () => {
    calls.length = 0;
    const out = await registerLibrary("p1", [item("MyParts.kicad_sym", "/drop/MyParts.kicad_sym")]);
    expect(out).toEqual({ nickname: "MyParts", symbols: 2 });
    expect(calls.map((c) => c.cmd)).toEqual(["consent_record", "grant_create", "lib_register"]);
    const consent = calls[0].args.event as { card_kind: string; input_kind: string; payload_sha256: string };
    expect(consent.card_kind).toBe("lib_import");
    expect(consent.input_kind).toBe("click");
    const grant = calls[1].args.request as { kind: string; consent_event_id: string; payload_sha256: string };
    expect(grant.kind).toBe("lib_import");
    expect(grant.consent_event_id).toBe("consent-9");
    expect(grant.payload_sha256).toBe(consent.payload_sha256);
    expect(calls[2].args).toEqual({ project_key: "p1", request: { nickname: "MyParts", path: "/drop/MyParts.kicad_sym" }, auth: { grant: "grant-9" } });
  });

  it("registers a .pretty group by its folder", async () => {
    calls.length = 0;
    const rows = [item("R_0603.kicad_mod", "/drop/MyParts.pretty/R_0603.kicad_mod", "MyParts.pretty"), item("C_0603.kicad_mod", "/drop/MyParts.pretty/C_0603.kicad_mod", "MyParts.pretty")];
    await registerLibrary("p1", rows);
    expect((calls[2].args as { request: unknown }).request).toEqual({ nickname: "MyParts", pretty_path: "/drop/MyParts.pretty" });
  });

  it("refuses a library with no path instead of pretending", async () => {
    await expect(registerLibrary("p1", [{ ...item("MyParts.kicad_sym"), path: null, file: null }])).rejects.toThrow("LIB_IMPORT_NEEDS_PATH");
  });

  it("the dialog shows the option on a .kicad_sym row", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const items = [item("MyParts.kicad_sym", "/drop/MyParts.kicad_sym"), item("ds.pdf", "/drop/ds.pdf")];
    act(() => { createRoot(host).render(<IntakeDialog items={items} onApply={async () => {}} onClose={() => {}} />); });
    const selects = host.querySelectorAll("select");
    expect(selects).toHaveLength(2);
    expect([...selects[0].options].map((o) => o.value)).toEqual(["attach", "keep", "reference", "ignore", "library"]);
    expect([...selects[1].options].map((o) => o.value)).toEqual(["attach", "keep", "reference", "ignore"]);
  });
});
