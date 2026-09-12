// SPDX-License-Identifier: Apache-2.0
// HookBus: mounts the P-series hooks on the loop protocol points. Order is
// fixed; the first deny wins. `inject` verdicts are collected and appended
// as a user message after the tool ran (agent-runtime.md §8.1 ④).

import { p0, p1, p10Wrap, p11, p12, p2, p3, p5, p6, p7, p8, p9, pDeprecated, pNoAsk, pOneD, pStatus, type P3Result } from "./hooks";
import { ALLOW, type HookVerdict, type ToolCallView, type ToolResultView, type TurnPolicyState } from "./types";
import { looksLikeInstruction } from "../util";

export type HookPoint = "BeforeToolCall" | "AfterToolCall" | "AfterModelCall" | "BeforeCompact" | "External";

export interface StepNets { nets_in: string[]; nets_out: string[]; rails: string[] }

export interface BusContext {
  state: TurnPolicyState;
  rails: string[];
  stepNets: StepNets;
}

export interface BeforeOutcome {
  verdict: HookVerdict;
  injections: string[];
}

export class HookBus {
  constructor(private readonly ctx: () => BusContext) {}

  before(call: ToolCallView): BeforeOutcome {
    const { state, rails } = this.ctx();
    const injections: string[] = [];
    const chain: (() => HookVerdict)[] = [
      () => pOneD(call),
      () => p0(state, call),
      () => pDeprecated(state, call),
      () => pStatus(state, call),
      () => pNoAsk(state, call),
      () => p6(state, call),
      () => p7(state, call),
      () => p1(state, call),
      () => p8(state, call),
      () => p2(state, call),
      () => p5(state, call),
      () => p12(state, call),
      () => p9(state, call, rails),
    ];
    for (const h of chain) {
      const v = h();
      if (v.kind === "deny") return { verdict: v, injections };
      if (v.kind === "inject") injections.push(v.text);
      if (v.kind === "retry_with") return { verdict: v, injections };
    }
    return { verdict: ALLOW, injections };
  }

  /** After a result: untrusted envelope (P10), P3/P11 classification for sch.plan. */
  after(result: ToolResultView, text: string): { text: string; verdict: HookVerdict; p3?: P3Result } {
    const { state, stepNets } = this.ctx();
    const flagged = looksLikeInstruction(text);
    const wrapped = p10Wrap(result.name, text, flagged);
    if (result.name === "sch.plan" && result.ok) {
      const r3 = p3(state, result, stepNets);
      if (r3.verdict.kind === "deny") return { text: wrapped, verdict: r3.verdict, p3: r3 };
      const v11 = p11(state, result);
      return { text: wrapped, verdict: v11, p3: r3 };
    }
    return { text: wrapped, verdict: ALLOW };
  }
}
