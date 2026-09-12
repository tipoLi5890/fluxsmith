// SPDX-License-Identifier: Apache-2.0
// Test/replay harness: builds a LeadLoop over the fake IPC and drives it with
// user messages until idle. Shared by replay.test.ts, injection.test.ts and
// scripts/replay.mjs (through the vitest runner). Not imported by the app.

import { LeadLoop } from "../lead";
import { SkillRegistry } from "../skills/registry";
import { Persistence } from "../persistence";
import type { TurnEvent, Card } from "../api";
import { FAKE_SETTINGS } from "./fake-ipc";

export interface HarnessOptions {
  answer?: (c: Card) => { action_id: string; grant?: string };
  settings?: unknown;
  mode?: "plan" | "build" | "review";
}

export interface Harness {
  lead: LeadLoop;
  events: TurnEvent[];
  run(text: string): Promise<void>;
}

export function makeHarness(opts: HarnessOptions = {}): Harness {
  const events: TurnEvent[] = [];
  const skills = new SkillRegistry({ list: async () => [], read: async () => "" });
  const lead = new LeadLoop({
    settings: () => (opts.settings ?? FAKE_SETTINGS) as never, projectKey: "pk", sessionId: "s", emit: (e) => events.push(e), skills, persistence: new Persistence("pk", "s"),
    plans: { read: async () => null, writeDraft: async () => ({ id: "p", version: 1 }), applyChange: async () => ({ id: "p", version: 2 }) },
    showCard: async (c) => (opts.answer ?? (() => ({ action_id: "modify" })))(c), selection: () => [], sheets: () => ["root.kicad_sch"],
  });
  if (opts.mode === "build") lead.setMode("build", "bs-1");
  return {
    lead, events,
    async run(text: string) {
      lead.enqueue({ message: { text, refs: [], attachments: [], session_id: "s" }, task: null, steer: false });
      for (let i = 0; i < 800 && (lead.running || (lead as unknown as { queue: unknown[] }).queue.length); i++) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
