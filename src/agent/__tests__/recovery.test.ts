// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/client", () => ({
  call: vi.fn(async () => null),
  netFetch: vi.fn(),
  onAppEvent: vi.fn(async () => () => undefined),
  IpcFailure: class extends Error { constructor(public error: { code: string; message: string; req_id: string }) { super(error.message); } },
}));

import { dryrunCutoff, ledgerApplied, ledgerIntended, pendingCardFile } from "../lead";
import { pendingResumeCard, recoveryCards } from "../index";
import { hardStopCard } from "../cards";
import type { PendingCardFile, ProjectInfo, RecoveryReport } from "../../ipc/types";

const project = (recovery: RecoveryReport | null): ProjectInfo => ({ key: "pk", root: "/p", root_sheet: "/p/p.kicad_sch", root_uuid: "u", name: "p", version: 20260306, sheets: [], config: {}, git: null, last_turn: 3, last_mode: "plan", policy_override: null, locked: false, recovery });

describe("ledger payloads (crash-recovery.md §3)", () => {
  it("intended lists every target path from target + sheets envelope with unknown shas", () => {
    const p = ledgerIntended({ target: "a.kicad_sch", oplist: { sheets: { pwr: "b.kicad_sch", root: "a.kicad_sch" }, ops: [] } });
    expect(p.targets).toEqual([{ path: "a.kicad_sch", sha_before: null }, { path: "b.kicad_sch", sha_before: null }]);
    expect(p.ops_sha256).toHaveLength(64);
  });
  it("applied carries the engine's sha_before / sha_after per target", () => {
    const p = ledgerApplied({ targets: [{ path: "a.kicad_sch", sha_before: "x", sha_after: "y", created: false }, { nope: 1 }] }, "run-9");
    expect(p).toEqual({ run_id: "run-9", targets: [{ path: "a.kicad_sch", sha_before: "x", sha_after: "y", created: false }] });
  });
});

describe("pending_card.json", () => {
  it("stores the card, step, condition, grant kind and op-list sha but no grant / consent ids", () => {
    const card = hardStopCard(4, "net_risk", { oplist: { ops: [{ op: "add_wire" }] } }, "note", "approves");
    const f = pendingCardFile(card, "s2");
    expect(f.turn).toBe(4);
    expect(f.step).toBe("s2");
    expect(f.condition).toBe("net_risk");
    expect(f.grant_kind).toBe("approves");
    expect(f.oplist_sha256).toHaveLength(64);
    expect((f.card as { id: string }).id).toBe(card.id);
    expect(JSON.stringify(f)).not.toMatch(/consent_event_id|grant_id/);
  });
  it("re-issues as a system card with a fresh id, re-run / rollback / dismiss and the original body", () => {
    const orig = hardStopCard(4, "net_risk", {}, "the note", "approves");
    const pc: PendingCardFile = { turn: 4, step: "s2", condition: "net_risk", grant_kind: "approves", card: orig, oplist_sha256: null, written_at: "t" };
    const c = pendingResumeCard(pc);
    expect(c.kind).toBe("system");
    expect(c.title).toBe("system.recovered_pending_card");
    expect(c.id).not.toBe(orig.id);
    expect(c.actions.map((a) => a.id)).toEqual(["resume_turn", "rollback", "dismiss"]);
    expect(c.actions.find((a) => a.id === "rollback")?.consent?.grant_kind).toBe("rollback");
    expect(c.actions.find((a) => a.id === "resume_turn")?.consent).toBeUndefined();
    // the re-issued card renders from `data.pending` (never the original raw JSON body)
    expect(c.body_md).toBe("");
    expect((c.data as { pending: PendingCardFile }).pending).toBe(pc);
  });
});

describe("recovery report -> system.recovered card", () => {
  const report = (steps: RecoveryReport["steps"], cleaned: RecoveryReport["cleaned"] = []): RecoveryReport => ({ scanned_at: "2026-08-30T00:00:00Z", turn: 3, phase_at_interrupt: "building-apply", cleaned, steps, pending_card: null, notes: [] });
  it("is silent without a report", () => {
    expect(recoveryCards(project(null))).toEqual([]);
  });
  it("lists cleaned items and confirmed steps; rollback only when a step needs review", () => {
    const ok = recoveryCards(project(report([{ turn: 3, step: "s1", ledger_phase: "applied", verdict: "done_confirmed", files: [{ path: "p.kicad_sch", expected_sha: "a", actual_sha: "a", matches: true }] }], [{ kind: "temp_file", path: ".p.kicad_sch.fluxsmith-tmp-1" }])));
    expect(ok).toHaveLength(1);
    expect(ok[0].title).toBe("system.recovered");
    expect(ok[0].actions.map((a) => a.id)).toEqual(["dismiss"]);
    expect(ok[0].body_md).toContain("fluxsmith-tmp-1");
    expect(ok[0].body_md).toContain("files match");
    const bad = recoveryCards(project(report([{ turn: 3, step: "s1", ledger_phase: "applied", verdict: "needs_review", files: [{ path: "p.kicad_sch", expected_sha: "a", actual_sha: "b", matches: false }] }])));
    // "Keep the files and mark them" is the second way out of a sha mismatch (crash-recovery.md §3); no consent, it grants nothing.
    expect(bad[0].actions.map((a) => a.id)).toEqual(["rollback", "keep", "dismiss"]);
    expect(bad[0].actions.find((a) => a.id === "keep")?.consent).toBeUndefined();
    expect(bad[0].actions[0].consent?.grant_kind).toBe("rollback");
    expect((bad[0].data as { review: number }).review).toBe(1);
  });
  it("builds the card once per scan and re-emits the same card on later attaches until answered", () => {
    const shown = new Set<string>();
    const p = project(report([], [{ kind: "stage", path: ".fluxsmith/stage/1" }]));
    const first = recoveryCards(p, shown);
    expect(first).toHaveLength(1);
    // a session switch re-attaches: the same card (same id) comes back, not a duplicate
    const again = recoveryCards(p, shown);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(first[0].id);
    first[0].answered = { action_id: "dismiss", at: "2026-08-31T00:00:00Z" };
    expect(recoveryCards(p, shown)).toHaveLength(0);
  });
});

describe("drafter dry-run cutoff", () => {
  it("stops on two identical consecutive op-lists and on the per-draft limit", () => {
    const st = { count: 0, lastSha: null as string | null };
    expect(dryrunCutoff(st, { ops: [1] })).toBeNull();
    expect(dryrunCutoff(st, { ops: [2] })).toBeNull();
    expect(dryrunCutoff(st, { ops: [2] })?.code).toBe("DRYRUN_REPEATED");
    const st2 = { count: 0, lastSha: null as string | null };
    let last: { code: string } | null = null;
    for (let i = 0; i < 7; i++) last = dryrunCutoff(st2, { ops: [i] });
    expect(last?.code).toBe("DRYRUN_LIMIT");
  });
});
