// SPDX-License-Identifier: Apache-2.0
// Rust -> harness events between turns: a lock that goes away, an external change while nothing
// runs, and the BuildSession ending with a rollback (agent-runtime.md §4.2 / §4.3, crash-recovery.md §3).
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ handlers: [] as ((e: unknown) => void)[] }));
vi.mock("../../ipc/client", async () => {
  const m = (await import("../replay/fake-ipc")).fakeIpcModule();
  return { ...m, onAppEvent: async (h: (e: unknown) => void) => { hoisted.handlers.push(h); return () => undefined; } };
});

import { fakeIpc } from "../replay/fake-ipc";
import { createHarness } from "../index";
import type { Card, TurnEvent } from "../api";
import type { AppEvent, RecoveryReport } from "../../ipc/types";

const fire = (e: AppEvent) => { for (const h of hoisted.handlers) h(e); };
const sysKeys = (events: TurnEvent[]) => events.filter((e) => e.kind === "system").map((e) => (e as { text_key: string }).text_key);
const cardsOf = (events: TurnEvent[]) => events.filter((e) => e.kind === "card").map((e) => (e as { card: Card }).card);

async function attached(extra: Parameters<typeof fakeIpc.reset>[0] = {}) {
  fakeIpc.reset(extra);
  const h = createHarness();
  const events: TurnEvent[] = [];
  h.subscribe((e) => events.push(e));
  await h.attach("pk", "s");
  return { h, events };
}

describe("watcher events between turns", () => {
  beforeEach(() => { hoisted.handlers.length = 0; });

  it("lock detected then released: a card, then a release line, and the P7 flag is not left set", async () => {
    const { h, events } = await attached();
    fire({ kind: "lock_detected", project_key: "pk", file: "~root.kicad_sch.lck" });
    expect(cardsOf(events).map((c) => c.title)).toEqual(["system.lock_detected"]);
    fire({ kind: "lock_released", project_key: "pk", file: "~root.kicad_sch.lck" });
    expect(sysKeys(events)).toEqual(["system.lock_released"]);
    // Another project's lock is not ours.
    fire({ kind: "lock_released", project_key: "other", file: "x" });
    expect(sysKeys(events)).toEqual(["system.lock_released"]);
    expect(h.state().mode).toBe("plan");
  });

  it("an external change with no turn running files a neutral card plus the idle line, never 'this turn ended'", async () => {
    const { events } = await attached();
    fire({ kind: "fs_changed", project_key: "pk", files: ["root.kicad_sch"], external: true });
    const cards = cardsOf(events);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("system.external_change");
    expect((cards[0].data as { files: string[]; at: string }).files).toEqual(["root.kicad_sch"]);
    expect((cards[0].data as { at: string }).at).toMatch(/^\d{4}-/);
    expect(sysKeys(events)).toEqual(["system.external_change_idle"]);
    // Our own writes (external: false) are not reported at all.
    fire({ kind: "fs_changed", project_key: "pk", files: ["root.kicad_sch"], external: false });
    expect(cardsOf(events)).toHaveLength(1);
  });

  it("a rollback ends Build once: the command leaves Build and says so, the Rust event that follows adds nothing", async () => {
    const { h, events } = await attached({ commands: { rollback: () => ({ restored_files: ["root.kicad_sch"], removed_files: [], pre_rollback_checkpoint: null, now_turn: 1 }) } });
    await h.setMode("build", "consent-1");
    expect(h.state().mode).toBe("build");
    expect(h.state().build_session).toBe("bs-1");
    await h.rollbackBefore(1, "consent-2");
    expect(h.state().mode).toBe("plan");
    expect(h.state().build_session).toBeNull();
    expect(sysKeys(events).filter((k) => k.startsWith("system.session_expired"))).toEqual(["system.session_expired_rollback"]);
    expect(events.filter((e) => e.kind === "mode_changed").map((e) => (e as { mode: string }).mode)).toEqual(["build", "plan"]);
    // The watcher/command event for the same expiry arrives later: already handled.
    fire({ kind: "session_expired", project_key: "pk", reason: "rollback" });
    expect(sysKeys(events).filter((k) => k.startsWith("system.session_expired"))).toEqual(["system.session_expired_rollback"]);
    expect(h.state().mode).toBe("plan");
  });

  it("an expiry event while in Plan with no BuildSession is silent; one in Build names its reason", async () => {
    const { h, events } = await attached();
    fire({ kind: "session_expired", project_key: "pk", reason: "external_change" });
    expect(sysKeys(events)).toEqual([]);
    await h.setMode("build", "consent-1");
    fire({ kind: "session_expired", project_key: "pk", reason: "external_change" });
    expect(h.state().mode).toBe("plan");
    expect(sysKeys(events)).toEqual(["system.session_expired_external"]);
  });
});

describe("recovery card: keep the files and mark them", () => {
  beforeEach(() => { hoisted.handlers.length = 0; });

  it("appends done {recovered, kept} for every step under review through the ledger sidecar", async () => {
    const recovery: RecoveryReport = {
      scanned_at: "2026-09-06T01:02:03Z", turn: 3, phase_at_interrupt: "building-apply", cleaned: [], pending_card: null,
      steps: [
        { turn: 3, step: "s1", ledger_phase: "applied", verdict: "needs_review", files: [{ path: "root.kicad_sch", expected_sha: "a", actual_sha: "b", matches: false }] },
        { turn: 3, step: "s2", ledger_phase: "applied", verdict: "done_confirmed", files: [] },
      ],
      notes: [{ code: "step_needs_review" }],
    };
    const { h, events } = await attached({ commands: { project_info: () => ({ key: "pk", root: "/p", root_sheet: "root.kicad_sch", root_uuid: "u", name: "p", version: 20260306, sheets: [], config: {}, git: null, last_turn: 3, last_mode: "plan", policy_override: null, locked: false, recovery }) } });
    const card = cardsOf(events).find((c) => c.title === "system.recovered");
    expect(card).toBeTruthy();
    expect(card!.actions.map((a) => a.id)).toEqual(["rollback", "keep", "dismiss"]);
    await h.answerCard(card!.id, "keep");
    const ledger = fakeIpc.calls.filter((c) => c.name === "sidecar_write" && (c.args as { write: { kind: string } }).write.kind === "ledger").map((c) => (c.args as { write: unknown }).write);
    expect(ledger).toEqual([{ kind: "ledger", turn: 3, step: "s1", phase: "done", payload: { recovered: true, kept: true, files: [{ path: "root.kicad_sch", sha: "b" }] } }]);
    expect(sysKeys(events)).toContain("system.recovery_kept");
    // No grant was created: keeping is not a consent action.
    expect(fakeIpc.calls.some((c) => c.name === "grant_create")).toBe(false);
  });
});
