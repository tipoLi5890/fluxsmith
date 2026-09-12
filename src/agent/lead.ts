// SPDX-License-Identifier: Apache-2.0
// LeadLoop: one user message → one turn (agent-runtime.md §4). Wraps the pi
// loop with turn.begin, the hook bus, hard-stop cards, subagent dispatch,
// step execution for approved plans, budget/context accounting and TurnEvents.

import { deny } from "./policy/types";
import { effectiveLead } from "./models/catalog";
import { ALL_OPS, closeAllowedOps, isKnownOp, oplistWarnings, qualifyStructural, SHEET_SYMBOL_OPS } from "./tools/ops";
import { call, IpcFailure } from "../ipc/client";
import type { Auth, Envelope, Mode, PendingCardFile, Policy, Settings, TurnKind, ProviderConfig } from "../ipc/types";
import type { ActivityLine, ApplyWarning, Card, ChangedField, ContextUsage, CreatedObject, KicadTurnResult, Phase, Ref, Role, ThinkingLevel, TurnEvent, UserMessage } from "./api";
import { applyWarnings, connectionFindings, warningTally } from "./apply-warnings";
import { adjudicate, AutoSkipTracker, dependentSkips, type AutoDecision, type HardStopCondition } from "./auto-policy";
import { BudgetLedger, planLimits, turnLimits, type UsageSample } from "./budget";
import { hardStopCard, providerStopCard, instanceRefsCard, questionCard, summaryCard, systemCard, changeCard, makeCard, payloadSha, sanitizeMarkdown } from "./cards";
import { assemble, markerText, type AssembledRequest, type HMessage } from "./context/assembler";
import { ceilingTokens, compactL2, compactL3, deterministicBlock, dropThinking, hasThinking, historyTokens, needCompaction, pruneL1, targetTokens, usageOf, validateBlock, type CompactionBlock, type ProtectedSet } from "./context/compaction";
import { promptTokensTotal } from "./context/tokens";
import { detectReplyLanguage } from "./lang";
import { COMPACTION_CALL_TIMEOUT_MS, KICAD_ADVISORY_TIMEOUT_MS, TURN_BEGIN_ARGS_MAX_CHARS, DRAFTER_CONCURRENCY_DEFAULT, DRAFTER_CONCURRENCY_DEGRADED, DRYRUN_MAX_PER_DRAFT, SESSION_CEILING_COMPONENTS_ADDED_DEFAULT, TOOL_PARALLEL_MAX_DEFAULT } from "./limits";
import { Persistence, usageToRecord } from "./persistence";
import { buildModel, bindTools, fromAssistant, makeStreamFn, prewarmCache, runLoop, Semaphore, toPiMessages, toolResultBlocks, type AgentEvent, type Model, type Api, type StreamFn, type ToolBinding, type AfterToolCallContext, type BeforeToolCallContext, decodeToolName } from "./pi-adapter";
import { designatorOf, findingInRegion, stylistOps, STYLIST_DELIVERY_CODES, STYLIST_NOTE, STYLIST_ROUNDS, type Box, type StylistGeom } from "./stylist";
import { DRAFT_OPS, PLAN_SCHEMA_HINT, defaultRegion, interfacePins, intersectEnvelope, planSnapshotText, planStructural, planView, scaffoldOrder, sessionCeiling, sheetInterfaces, stepEnvelope, type DesignPlan, type PlanBlock, type PlanStep } from "./plans/schema";
import { ACCEPTANCE_MAX, ACCEPTANCE_NET_READS_MAX, ACCEPTANCE_SHEETS_MAX, acceptanceCounts, acceptanceDoneKey, acceptanceNeedsPositions, acceptanceNeedsPowerSymbols, acceptanceNoConnectPins, evaluateAcceptance, refMatchesPrefix, splitMember, type AcceptanceContext, type AcceptanceNet, type AcceptancePowerSymbol, type AcceptanceResult, type AcceptanceSymbol } from "./plans/acceptance";
import { HookBus } from "./policy/bus";
import { p4, recordAppliedSeeds, recordFixAttempt, extractNetChanges, coerceEnvelope, saysDoNotAsk, selfNarrowedDeny, sheetMatches, hookCallArgs, inspectOplist, envelopeAdvisory, oplistDigest } from "./policy/hooks";
import { denyResult, isWaived, newTurnPolicyState, type Finding, type HookVerdict, type TurnPolicyState } from "./policy/types";
import { COMPACTION_INSTRUCTION, LEAD_CORE_RULES, DRAWING_CONVENTIONS } from "./prompts/system";
import { namedDesignators, narrowEnvelopeByRefs, refsBlock, type ResolvedRef } from "./refs";
import { SkillRegistry } from "./skills/registry";
import { ARCHITECT, DRAFTER, FACTS, FIXER, LIBRARIAN, REVIEWER, SOURCER, architectBrief, drafterBrief, fixerBrief, instanceRefsBrief, reviewerBrief, loadFactsForParts, type OpListOut } from "./subagents/roles";
import { ercFixOps, type LabelRow, type PartFacts } from "./ercfix";
import { emptyKicadErc, kicadErcResult, type KicadErcResult } from "./kicad-erc";
import { conflictsFromMessage, planRenumber, renumberOplist } from "./refdes";
import { runSubagent } from "./subagents/runner";
import { capFor, executeTool, IdempotencyCache, resultText, type PlanStore, type ToolContext, type ToolResult } from "./tools/registry";
import { isDTier, MANIFEST_VERSION, toolDef, toolTable, type ToolDef } from "./tools/manifest";
import { applyFiles, newTurnRecord, parseMicroEdit, summaryOf, type TurnRecord } from "./turns/state";
import { canonicalJson, envelopeSha, localId, looksLikeInstruction, nowIso, sha256Hex } from "./util";
import { effectiveRates } from "./models/rates";
import { isRemembered, REMEMBERABLE } from "./policy/remembered";
import { planCard } from "./cards";
import { defaultFixSelection, findingLabels, triageFixSelection } from "./findings";
import { FIXER_MAP, fixerDispatchable } from "./fixer-map";
import { planMarkdown } from "./plans/schema";
import { WorkflowRunner, type RunnerHost, type RunResult } from "./workflows/runner";
import { ADOPT_EXISTING, BUILTIN_WORKFLOWS, DATASHEET_FIRST, DESIGN_REVIEW, SOURCE_BOM } from "./workflows/builtins";
import { needsWorkflowConsent, parseWorkflowYaml, type WorkflowDef } from "./workflows/schema";

/**
 * What a Fixer dispatch is actually for: the findings it may repair and the phase they belong to,
 * or null when there is nothing to dispatch.
 *
 * Both halves used to be wrong at once. The phase came from the call site rather than from the
 * findings, so the gate step briefed a Fixer with `phase: "pre_apply"` for TEXT_OVERLAP /
 * ROW_MISALIGNED / DECAP_FAR — codes `FIXER_MAP` registers for `post_apply` only — and the op-list
 * it handed over was `{"ops":[]}`, which is truthy and therefore passed every guard. The Fixer was
 * told to rewrite an op-list that did not exist and answered with nothing, twice, in the same turn
 * (real run 19). A pre-apply repair rewrites the op-list it is given, so with no ops the only
 * possible phase is `post_apply`; codes no Fixer may touch (`who !== "fixer"`) are dropped from the
 * brief instead of poisoning the whole batch.
 */
export function fixerDispatch(findings: Finding[], requested: "pre_apply" | "post_apply", hasOps: boolean): { phase: "pre_apply" | "post_apply"; findings: Finding[] } | null {
  const keep = findings.filter((f) => { const m = FIXER_MAP[f.code]; return !m || m.who === "fixer"; });
  if (!keep.length) return null;
  const known = keep.map((f) => FIXER_MAP[f.code]).filter((m): m is { phases: ("pre_apply" | "post_apply")[]; section: string | null; who: "fixer" | "lead" | "librarian" | "none" } => !!m);
  // Codes the map does not register: the harness's own synthetic ones (OPLIST_INVALID,
  // NET_MERGE_RISK), which always come with the op-list they are about, and the engine codes a
  // family regex selected for `/fix` or the gate step, which are about the sheet as it stands.
  if (!known.length) return { phase: hasOps ? requested : "post_apply", findings: keep };
  const registered = (p: "pre_apply" | "post_apply") => known.every((m) => m.phases.includes(p));
  const order: ("pre_apply" | "post_apply")[] = hasOps ? (requested === "pre_apply" ? ["pre_apply", "post_apply"] : ["post_apply", "pre_apply"]) : ["post_apply"];
  for (const p of order) if (registered(p)) return { phase: p, findings: keep };
  return null;
}

export interface LeadDeps {
  settings: () => Settings;
  projectKey: string;
  sessionId: string;
  emit: (e: TurnEvent) => void;
  skills: SkillRegistry;
  persistence: Persistence;
  plans: PlanStore;
  /** Card lifecycle: show, then resolve when the UI answers. */
  showCard: (c: Card) => Promise<{ action_id: string; free_text?: string; consent_event_id?: string; grant?: string }>;
  /** Drop the resolver of a card the turn abandoned (Stop while waiting); optional for tests. */
  dismissCard?: (cardId: string) => void;
  selection: () => Ref[];
  sheets: () => string[];
  now?: () => number;
  /** Open a BuildSession mid-turn (workflow `phase.requires_consent`); returns false when refused. */
  enterBuild?: (consent_event_id: string) => Promise<boolean>;
}

export interface Queued { message: UserMessage; task: number | null; steer: boolean }

interface StepOutcome {
  ok: boolean; skipped?: AutoDecision; applied: boolean; reason?: string;
  /** Unwaived engine Errors the plan's gate step left behind (the gate reports, it never blocks). */
  errorsLeft?: number;
  /** `stepFail` already emitted `system.auto_step_skipped` for this outcome: the runner must not repeat it. */
  reported?: boolean;
}

export class LeadLoop {
  history: HMessage[] = [];
  turns: TurnRecord[] = [];
  mode: Mode = "plan";
  policy: Policy = "review";
  buildSession: string | null = null;
  plan: DesignPlan | null = null;
  planApproved = false;
  planStepsDone = new Set<string>();
  planStepsSkipped = new Set<string>();
  /** Last acceptance verdict per block, from the plan's gate step (engine results only, red line 6). */
  private planAcceptance = new Map<string, AcceptanceResult[]>();
  /** Why a step was skipped or failed (shown in the plan panel). */
  stepNotes = new Map<string, string>();
  private autoSkipsWarned = new Set<number>();
  running = false;
  currentTurn: TurnRecord | null = null;
  private stopRequested = false;
  /**
   * A stop-class hard stop (budget / environment / provider / context, `auto-policy.ts`) raised by
   * the step named here. It is never laundered into a skip: the step stays open, the plan pauses at
   * it, and `resume` records that the human answered "retry now" on the card.
   */
  private planStop: { step: string; condition: HardStopCondition; reason: string; resume: boolean } | null = null;
  private abort: AbortController | null = null;
  private policyState: TurnPolicyState | null = null;
  private pendingHardStop: { card: Card; condition: string } | null = null;
  /** Findings selected for the next `/fix` turn (set by the review card / findings panel). */
  pendingFix: Finding[] | null = null;
  /** Sheet file `/review <sheet>` narrowed this turn to; null while a review is project-wide. */
  private reviewScope: string | null = null;
  private planDenied: { verdict: Extract<HookVerdict, { kind: "deny" }>; expected: { into: string; sources_unnamed_only: boolean }[]; ops_sha256?: string | null } | null = null;
  private expectedMerges: { into: string; sources_unnamed_only: boolean }[] = [];
  private unlocked = new Map<string, string>();
  /** Reason the human typed on a net-risk / structural card, per grant id (goes into the waived record). */
  private grantReasons = new Map<string, string>();
  /** Take a grant once: Rust grants are single-use, so every alias of the same grant is dropped together. */
  private takeGrant(key: string): string | undefined {
    const g = this.unlocked.get(key);
    if (!g) return undefined;
    for (const [k, v] of [...this.unlocked]) if (v === g) this.unlocked.delete(k);
    return g;
  }
  private idem = new IdempotencyCache();
  private queue: Queued[] = [];
  private taskCounter = 0;
  private toolTableFrozen: ToolDef[] | null = null;
  private model: Model<Api> | null = null;
  private providerCfg: ProviderConfig | null = null;
  private streamFn: StreamFn | null = null;
  private lastPromptTokens = 0;
  private lastCompactionTurn: number | null = null;
  private planBudget: BudgetLedger | null = null;
  /** `meta.ops_sha256` of the last successful sch.plan: a net-risk approval is bound to exactly that op-list. */
  private lastPlanOpsSha: string | null = null;
  /** P3 notes of the last sch.plan (expected merges, renamed nets) for the Ask change card. */
  private lastPlanNotes: string[] = [];
  private turnBudget: BudgetLedger | null = null;
  private autoTracker: AutoSkipTracker | null = null;
  private rateLimited = false;
  private l0: string | null = null;
  private selectionRefs: Ref[] = [];
  private stepPhase: "draft" | "verify" | "apply" | null = null;
  /** FR-611: sheet files a question card was already raised for (one per session, not per turn). */
  private instanceRefsAsked = new Set<string>();
  /** Answer of that card, waiting for the `/instances` turn it enqueued. */
  private pendingInstanceRefs: { sheet: string; paths: string[]; refs: string[] } | null = null;
  /** `sch.summary` instance paths per sheet file, for this turn (invalidated when the turn starts). */
  private instancePaths = new Map<string, string[]>();

  constructor(private d: LeadDeps) {}

  // ---------------------------------------------------------------------------
  // Model / session
  // ---------------------------------------------------------------------------

  private leadProvider(): { provider: ProviderConfig; model: string } | null {
    return effectiveLead(this.d.settings());
  }

  /** `models_by_role["<role>_fallback"]`: the model a second attempt switches to, when configured. */
  private fallbackModel(role: Role): { provider: ProviderConfig; model: string } | null {
    const s = this.d.settings();
    const id = (s.models_by_role as Record<string, string | undefined>)[`${role}_fallback`];
    if (!id) return null;
    const [pid, ...rest] = id.split("/");
    const provider = s.providers.find((p) => p.id === pid && p.enabled);
    if (!provider) return null;
    return { provider, model: rest.join("/") || provider.models[0] };
  }

  private roleModel(role: Role): { provider: ProviderConfig; model: string } | null {
    const s = this.d.settings();
    const id = s.models_by_role[role] ?? s.models_by_role.lead;
    if (!id) return this.leadProvider();
    const [pid, ...rest] = id.split("/");
    const provider = s.providers.find((p) => p.id === pid && p.enabled);
    if (!provider) return this.leadProvider();
    return { provider, model: rest.join("/") || provider.models[0] };
  }

  /** Authoritative session state for the model (never in the system prompt: it changes). */
  private stateBlock(): string {
    const writes = this.mode === "build" && !!this.buildSession;
    return [
      "<state trust=\"harness\">",
      `mode: ${this.mode}`,
      `approval_policy: ${this.effectivePolicy()}`,
      `writes: ${writes ? "allowed (Build session open; D tools such as sch.apply are available to you after turn.begin kind=instruction)" : "not allowed (for a design request write the plan with plan.write; adopting the plan card is how the human enters Build)"}`,
      `plan: ${this.plan ? `${this.plan.id}@${this.plan.version} ${this.planApproved ? "approved" : "draft"}` : "none (incremental edits within the session ceiling)"}`,
      "</state>",
    ].join("\n");
  }

  /** The Rust BuildSession is gone (idle/absolute timeout): fall back to Plan and offer re-entry. */
  /** A harness-path `turn_begin` refusal (lock, expired session, bad envelope) is shown, never swallowed into a bare "stopped". */
  private reportBeginFailure(e: unknown, t: TurnRecord): void {
    const f = e instanceof IpcFailure ? e.error : { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" };
    this.d.emit({ kind: "error", turn: t.turn, error: f });
    if (f.code === "SESSION_EXPIRED" || f.code === "NO_BUILD_SESSION") this.onBuildExpired(t.turn);
  }

  onBuildExpired(turn: number): void {
    this.buildSession = null;
    if (this.mode === "build") { this.mode = "plan"; this.d.emit({ kind: "mode_changed", mode: "plan", by: "suggestion" }); }
    this.d.emit({ kind: "card", card: systemCard(turn, "system.build_expired", {}, [{ id: "enter_build", label_key: "card.enter_build", style: "primary", consent: { grant_kind: "user_action", payload_sha256: "enter_build" } }, { id: "dismiss", label_key: "card.dismiss", style: "secondary" }]) });
  }

  /** Drop the built model so the next turn rebuilds it from settings (model switch). */
  resetModel(): void {
    this.model = null;
    this.providerCfg = null;
    this.streamFn = null;
    this.lastBreakpoints = {};
  }

  /** Current plan with progress for the UI. */
  planView(): import("./api").PlanView | null {
    return this.plan ? planView(this.plan, { done: this.planStepsDone, skipped: this.planStepsSkipped, current: this.nextStep()?.id ?? null, notes: this.stepNotes }) : null;
  }

  /** Provider + model the next turn would use, or null. */
  currentLead(): { provider: ProviderConfig; model: string } | null {
    return this.leadProvider();
  }

  /** LeadSession-frozen items: model, tool table, L0 snapshot. */
  ensureSession(): boolean {
    if (this.model) return true;
    const lp = this.leadProvider();
    if (!lp) { this.d.emit({ kind: "system", text_key: "system.no_provider", severity: "error" }); return false; }
    this.providerCfg = lp.provider;
    this.model = buildModel({ provider: lp.provider, modelId: lp.model });
    this.streamFn = makeStreamFn({
      onRetry: (attempt, cls, wait) => { if (cls === "rate_limit") this.rateLimited = true; this.d.emit({ kind: "activity", turn: this.currentTurn?.turn ?? 0, line: { id: localId("act"), role: "lead", phase: "waiting", label: "provider.retry", detail: `${cls} ${attempt}/3 in ${Math.round(wait / 1000)}s`, started_at: nowIso() } }); },
      onUsage: (u, model, latency) => this.onUsage(u, model, "lead", latency ?? 0),
      breakpoints: () => this.lastBreakpoints,
      role: "lead",
      cacheKey: this.cacheKey("lead"),
    });
    this.l0 = this.d.skills.l0();
    return true;
  }

  /**
   * `prompt_cache_key` for the OpenAI-compatible / Codex APIs: they have no explicit breakpoints and
   * route their implicit prefix cache by this key, so every call of one role in one session must send
   * the same string. Deterministic by construction (session id + role, no clock, no counter);
   * Anthropic ignores it and uses the A/B/C/D breakpoints instead.
   */
  private cacheKey(role: Role): string {
    return `fluxsmith.${this.d.sessionId}.${role}`;
  }

  private lastBreakpoints: AssembledRequest["breakpoints"] = {};
  /**
   * Did the last `guarded` call end in a hard stop that was already put to the human (a card under
   * Review) or adjudicated (an auto decision under Auto)? Callers that turn a refused call into a step
   * failure read it right after the call, so the failure is reported exactly once: never twice, and never
   * (the ENVELOPE_SHEET_UNDECLARED redraw, which raises no card of its own) not at all.
   */
  private guardCarded = false;
  /** Reply language of the current turn; subagents write human-facing text in it. */
  private turnLang = "en";

  private table(): ToolDef[] {
    if (this.toolTableFrozen) return this.toolTableFrozen;
    const p = this.providerCfg;
    return toolTable(this.mode, "lead", { vision: p?.vision ?? false, webSearch: false, m3: false });
  }

  setMode(mode: Mode, buildSession: string | null): void {
    this.mode = mode;
    this.buildSession = buildSession;
    this.toolTableFrozen = mode === "build" ? toolTable("build", "lead", { vision: this.providerCfg?.vision ?? false, m3: false }) : null;
    this.history.push({ role: "user", content: [{ type: "text", text: markerText(mode, this.policy, this.planRef()) }], meta: { turn: this.turns.length, task: this.taskCounter, kind: "marker" } });
    this.d.emit({ kind: "mode_changed", mode, by: "user" });
    // Entering Build: warm the provider-side cache with the frozen prefix once per BuildSession (best effort, never throws).
    if (mode === "build" && buildSession && this.model && this.prewarmedSession !== buildSession) {
      this.prewarmedSession = buildSession;
      try {
        const req = this.assembleRequest();
        void prewarmCache({ model: this.model, system: req.system, tools: req.tools, history: toPiMessages(req.messages), breakpoints: () => this.lastBreakpoints, cacheKey: this.cacheKey("lead") });
      } catch { /* prewarm is advisory */ }
    }
  }
  private prewarmedSession: string | null = null;

  setPolicy(policy: Policy): void {
    this.policy = policy;
    this.history.push({ role: "user", content: [{ type: "text", text: markerText(this.mode, policy, this.planRef()) }], meta: { turn: this.turns.length, task: this.taskCounter, kind: "marker" } });
    this.d.emit({ kind: "policy_changed", policy });
  }

  setSelection(refs: Ref[]): void { this.selectionRefs = refs; }

  planRef(): string | null { return this.plan ? `${this.plan.id}@${this.plan.version}` : null; }

  private effectivePolicy(): Policy {
    return this.policy === "auto" && (this.mode !== "build" || !this.planApproved) ? "review" : this.policy;
  }

  // ---------------------------------------------------------------------------
  // Usage / budget / context
  // ---------------------------------------------------------------------------

  private onUsage(u: UsageSample, model: string, role: Role, latencyMs = 0): void {
    const rates = this.providerCfg ? (effectiveRates(this.providerCfg, model)?.rates ?? null) : null;
    this.planBudget?.addUsage(u, rates);
    this.turnBudget?.addUsage(u, rates);
    const t = this.currentTurn;
    if (t) {
      t.cost.input += u.input; t.cost.cache_creation += u.cacheWrite; t.cost.cache_read += u.cacheRead; t.cost.output += u.output;
      t.cost.tokens += u.input + u.cacheWrite + u.cacheRead + u.output;
      if (rates) t.cost.usd += (u.input * rates[0] + u.cacheWrite * rates[1] + u.cacheRead * rates[2] + u.output * rates[3]) / 1e6;
      void this.d.persistence.recordModelCall(usageToRecord(u, { plan_id: this.plan?.id ?? null, plan_version: this.plan?.version ?? null, turn: t.turn, step: this.policyState?.step ?? "s0", role, model, cost_usd: rates ? (u.input * rates[0] + u.cacheWrite * rates[1] + u.cacheRead * rates[2] + u.output * rates[3]) / 1e6 : 0, latency_ms: Math.round(latencyMs), retry_of: null })).catch(() => undefined);
      // Same numbers as the `model_calls` row above, per role: the stream shows cost / cache hit
      // per role live and the cost report agrees with it. `null` cost = no rate for this model.
      this.d.emit({ kind: "usage", turn: t.turn, role, input: u.input, cache_read: u.cacheRead, cache_creation: u.cacheWrite, output: u.output, cost_usd: rates ? (u.input * rates[0] + u.cacheWrite * rates[1] + u.cacheRead * rates[2] + u.output * rates[3]) / 1e6 : null });
      const hit = u.cacheRead / Math.max(1, u.input + u.cacheWrite + u.cacheRead);
      void this.d.persistence.metric("cache_hit_ratio", hit, { role }).catch(() => undefined);
      if (role === "lead") this.lastPromptTokens = promptTokensTotal(this.providerCfg?.kind ?? "openai", u);
      this.emitBudget();
      this.emitContext();
    }
  }

  private emitBudget(): void {
    const t = this.currentTurn;
    if (!t) return;
    const b = this.d.settings().agent.budget_enabled ? (this.planBudget ?? this.turnBudget) : null;
    if (!b) {
      // Budgets off (the default): the UI still needs real usage as it accrues, otherwise it can
      // only show its own thinking-character estimate. Same event, no limits, never a warning.
      this.d.emit({ kind: "budget", turn: t.turn, used: { tokens: t.cost.tokens, usd: t.cost.usd, tool_calls: t.tools.length, wall_ms: t.wall_active_ms }, limits: { tokens: null, usd: null, tool_calls: null, wall_ms: null }, warn: false });
      return;
    }
    this.d.emit({ kind: "budget", turn: t.turn, used: { tokens: b.used.tokens, usd: b.used.usd, tool_calls: b.used.tool_calls, wall_ms: b.used.wall_ms }, limits: { tokens: b.limits.tokens, usd: b.limits.usd, tool_calls: b.limits.tool_calls, wall_ms: b.limits.wall_ms }, warn: b.warn() });
  }

  private window() {
    return { ctx_window: this.providerCfg?.context_window ?? 128_000, reserve_output: this.d.settings().context.reserve_output_tokens };
  }

  private usedEstimate(): number {
    return Math.max(this.lastPromptTokens, historyTokens(this.history) + 4000);
  }

  contextUsage(): ContextUsage {
    return usageOf(this.usedEstimate(), this.window(), this.d.settings().context);
  }

  private emitContext(): void { this.d.emit({ kind: "context", usage: this.contextUsage() }); }

  private protectedSet(): ProtectedSet {
    return { currentTurn: this.currentTurn?.turn ?? this.turns.length, currentTask: this.taskCounter, keepRecentTasks: this.d.settings().context.keep_recent_tasks, hardStopTurn: this.pendingHardStop ? (this.currentTurn?.turn ?? null) : null };
  }

  /**
   * True once a model call of the current turn has been sent: from then on the provider has seen a
   * prefix of `history`, and rewriting any message below that boundary (pruneL1, compactL3) invalidates
   * the cache from the rewritten message on. Reset at every turn boundary.
   */
  private sentInTurn = false;

  /** Compaction at a boundary (never mid-apply). L1 → L2 → L3. */
  async compact(level: 1 | 2 | 3 = 2, forced = false): Promise<void> {
    // caching-strategy.md §3: history is append-only and is rewritten only at a compaction boundary.
    // Inside a turn the provider has already seen the messages pruneL1 / compactL3 would rewrite, so a
    // mid-turn compaction throws away the whole cached prefix. Only a real context overflow may do it
    // (`forced`), and it is recorded so a cache-ratio drop can be traced back to it.
    if (this.sentInTurn) {
      if (!forced) { void this.d.persistence.metric("compaction_skipped_mid_turn", 1, { level }).catch(() => undefined); return; }
      void this.d.persistence.metric("compaction_mid_turn_forced", 1, { level }).catch(() => undefined);
    }
    const target = targetTokens(this.window());
    const p = this.protectedSet();
    const before = historyTokens(this.history);
    let reclaimed = 0;
    let usedLevel: 1 | 2 | 3 = 1;
    const l1 = pruneL1(this.history, p, target);
    this.history = l1.history; reclaimed += l1.reclaimed;
    if ((level >= 2 && (forced || historyTokens(this.history) > target))) {
      usedLevel = 2;
      const block = await this.buildCompactionBlock(p);
      let fresh = "";
      try { fresh = resultText(await this.engineDirect({ kind: "summary", sheet: null }), capFor("sch.summary")); } catch { fresh = "(sch.summary unavailable)"; }
      const l2 = compactL2(this.history, p, block, fresh);
      this.history = l2.history; reclaimed += l2.reclaimed;
      const sha = sha256Hex(canonicalJson(block));
      const keepTurns = [p.currentTurn, ...(p.hardStopTurn === null ? [] : [p.hardStopTurn])];
      await this.d.persistence.compaction(2, l2.range[0], l2.range[1], reclaimed, sha, { turns: keepTurns, min_task: p.currentTask - p.keepRecentTasks }, l2.blocks).catch(() => undefined);
      this.d.emit({ kind: "system", text_key: "system.compacted", params: { level: 2, from: l2.range[0], to: l2.range[1], reclaimed }, severity: "info" });
    }
    if (level >= 3 || historyTokens(this.history) > ceilingTokens(this.window())) {
      usedLevel = 3;
      const l3 = compactL3(this.history, p, target);
      this.history = l3.history; reclaimed += l3.reclaimed;
    }
    this.lastCompactionTurn = this.currentTurn?.turn ?? this.turns.length;
    if (this.currentTurn) (this.currentTurn.context ??= { used_before: before, used_after: 0, compactions: [] }).compactions.push({ id: localId("cmp"), level: usedLevel, range: [0, this.turns.length], reclaimed });
    this.lastPromptTokens = 0;
    this.d.emit({ kind: "context", usage: { ...this.contextUsage(), last_compaction: { level: usedLevel, reclaimed, at: nowIso() } } });
  }

  /** L2 block: model side-call reusing the Lead prefix; deterministic fallback from turn records. */
  private async buildCompactionBlock(p: ProtectedSet): Promise<CompactionBlock> {
    const covered = this.turns.filter((t) => t.turn < p.currentTurn && t.task <= p.currentTask - p.keepRecentTasks);
    const det = deterministicBlock(
      covered.map((t) => ({ n: t.turn, headline: t.headline, outcome: t.status, changes: { components_added: t.applies.reduce((a, x) => a + x.counts.added, 0), components_deleted: t.applies.reduce((a, x) => a + x.counts.deleted, 0) }, open_findings: [] })),
      this.plan ? { id: this.plan.id, version: this.plan.version, steps_done: [...this.planStepsDone], current: this.nextStep()?.id ?? null } : null,
      {}, this.plan?.net_naming.rails ?? [], covered.flatMap((t) => t.auto_decisions.map((d) => ({ turn: t.turn, kind: d.condition, result: d.action, note: d.detail }))), [],
    );
    if (!this.model || !this.streamFn || covered.length === 0) return det;
    try {
      const req = this.assembleRequest();
      const range = this.history.filter((m) => covered.some((t) => t.turn === m.meta.turn));
      // Per-turn cap (not only per message): a retired 15-step run must fit one side-call.
      const perTurn = Math.max(1500, Math.floor(COMPACTION_RANGE_CHARS / Math.max(1, covered.length)));
      const used = new Map<number, number>();
      const text = range.map((m) => {
        const budget = perTurn - (used.get(m.meta.turn) ?? 0);
        if (budget <= 0) return "";
        const body = m.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n").slice(0, Math.min(4000, budget));
        used.set(m.meta.turn, (used.get(m.meta.turn) ?? 0) + body.length);
        return `${m.role}: ${body}`;
      }).filter(Boolean).join("\n---\n");
      const prompt = toPiMessages([{ role: "user", content: [{ type: "text", text: `${COMPACTION_INSTRUCTION}\nTurns to cover: ${covered.map((t) => t.turn).join(", ")}\n<range>\n${text}\n</range>` }], meta: { turn: 0, task: 0, kind: "user" } }]);
      let out = "";
      // The side-call reuses the Lead's *system* prefix but nothing else of its context: no tool table and a
      // marker-only history. It therefore gets its own cache shard (`prompt_cache_key` role "compaction") and
      // no Lead breakpoints — the Lead's message indices point into a history this payload does not have, and
      // sharing the Lead's key would make every compaction evict the Lead's own prefix (caching-strategy §2).
      await runLoop({ system: req.system, tools: bindTools([], new Semaphore(1)), history: toPiMessages(req.messages.filter((m) => m.meta.kind === "marker" || m.meta.kind === "plan_snapshot")), prompt, model: this.model, streamFn: makeStreamFn({ onUsage: (u, m, l) => this.onUsage(u, m, "compaction", l ?? 0), breakpoints: () => ({}), role: "compaction", cacheKey: this.cacheKey("compaction") }), signal: AbortSignal.any([this.abort?.signal ?? new AbortController().signal, AbortSignal.timeout(COMPACTION_CALL_TIMEOUT_MS)]), hooks: {}, onEvent: (e) => { if (e.type === "message_end" && e.message.role === "assistant") out = e.message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(""); } });
      const parsed = JSON.parse(out.replace(/```(json)?/g, "").trim()) as CompactionBlock;
      const problems = validateBlock(parsed, covered.map((t) => t.turn));
      if (problems.length === 0) return parsed;
      void this.d.persistence.metric("compaction_fallback", 1, { reason: "invalid_block", problems: problems.slice(0, 3).join("; ") }).catch(() => undefined);
    } catch (e) {
      // The side-call failed (window overflow, provider error): the deterministic block loses decisions and open findings.
      void this.d.persistence.metric("compaction_fallback", 1, { reason: String(e).slice(0, 120) }).catch(() => undefined);
    }
    return det;
  }

  // ---------------------------------------------------------------------------
  // Assembly
  // ---------------------------------------------------------------------------

  private assembleRequest(): AssembledRequest {
    const req = assemble({
      toolTable: this.table(), coreRules: LEAD_CORE_RULES, skillsL0: this.l0 ?? "", planSnapshot: this.plan && this.planApproved ? { id: this.plan.id, version: this.plan.version, text: planSnapshotText(this.plan) } : null,
      mode: this.mode, policy: this.effectivePolicy(), history: this.history.filter((m) => m.meta.kind !== "marker" && m.meta.kind !== "plan_snapshot"), systemMarkers: false,
    });
    this.lastBreakpoints = req.breakpoints;
    return req;
  }

  // ---------------------------------------------------------------------------
  // Turn entry
  // ---------------------------------------------------------------------------

  enqueue(q: Queued): void { this.queue.push(q); void this.pump(); }

  private turnGen = 0;
  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.running = true;
    const gen = ++this.turnGen;
    const startedTurn = this.turns.length + 1;
    try { await this.runTurn(next); } finally {
      // A force-finished zombie (watchdog / force stop) that settles later must not touch the live turn:
      // forceFinish bumped the generation, so this branch belongs to that turn only while it is current.
      if (this.turnGen === gen) {
        this.running = false;
        // `turn_ended` fired while `running` was still true; publish the idle state so the UI never keeps a stale composer.
        this.d.emit({ kind: "phase", turn: this.turns[this.turns.length - 1]?.turn ?? startedTurn, role: "lead", phase: this.stopRequested ? "stopped" : "done" });
      }
    }
    if (this.queue.length) void this.pump();
  }

  async stop(force = false): Promise<void> {
    this.queue.length = 0;
    if (!this.running) return; // nothing to stop: never leave a stale "stopping" state behind
    this.stopRequested = true;
    const t = this.currentTurn;
    if (t) t.status = "stopping";
    this.abort?.abort();
    // Force: the user already waited through one stop; end the turn now instead of arming another watchdog.
    if (force) { if (t && !t.ended_at) this.forceFinish(t, Date.now()); return; }
    // Watchdog: a provider stream or subagent that ignores the abort must not leave the turn
    // "stopping" forever (the queue, and with it the next plan step, would never run).
    const startedAt = Date.now();
    setTimeout(() => { if (this.running && this.currentTurn === t && t && !t.ended_at) this.forceFinish(t, startedAt); }, 15_000);
  }

  /** Resolve until no turn is running (used before adopting a plan so the running turn can end on its own). */
  async waitIdle(maxMs = 120_000): Promise<void> {
    const t0 = Date.now();
    while (this.running && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 200));
  }

  private forceFinish(t: TurnRecord, started: number): void {
    t.status = "abandoned"; t.stop_reason = "user";
    this.finishTurn(t, started);
    this.turnGen++; // the awaited runTurn is now a zombie: its completion must not clear `running` for the next turn
    this.running = false;
    this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: "stopped" });
    this.d.emit({ kind: "system", text_key: "system.turn_forced_end", params: { turn: t.turn }, severity: "warning" });
    if (this.queue.length) void this.pump();
  }

  /**
   * Re-open a step for `/redo`: only a skipped step, or a done step whose every turn was rolled
   * back (re-running an applied draft would place the block twice). Dependants that were skipped
   * only because of this step are re-opened too.
   */
  private reopenStep(id: string): { ok: true; step: PlanStep } | { ok: false; reason: string } {
    const step = this.plan?.steps.find((x) => x.id === id);
    if (!step) return { ok: false, reason: `unknown step ${id}` };
    const wasSkipped = this.planStepsSkipped.has(id);
    const applied = this.planStepsDone.has(id) && this.turns.some((t) => t.plan_step === id && t.status !== "rolled_back" && t.applies.length > 0);
    if (!wasSkipped && !this.planStepsDone.has(id)) return { ok: false, reason: `step ${id} is still pending` };
    if (applied) return { ok: false, reason: "step applied; roll back first" };
    const dependants = dependentSkips(this.plan!.steps, new Set([id])).filter((d) => this.planStepsSkipped.has(d) && /dependency/i.test(this.stepNotes.get(d) ?? ""));
    this.planStepsSkipped.delete(id); this.planStepsDone.delete(id); this.stepNotes.delete(id);
    for (const d of dependants) { this.planStepsSkipped.delete(d); this.stepNotes.delete(d); }
    if (wasSkipped && this.autoTracker) { this.autoTracker.skipped = Math.max(0, this.autoTracker.skipped - 1); this.autoTracker.consecutive = 0; }
    if (this.plan) this.plan.display.status = "in_progress";
    return { ok: true, step };
  }

  private nextStep(): PlanStep | null {
    if (!this.plan) return null;
    for (const s of this.plan.steps) {
      if (this.planStepsDone.has(s.id) || this.planStepsSkipped.has(s.id)) continue;
      // A skipped step (Auto) satisfies its dependants; otherwise one skip would end the whole plan.
      if ((s.depends_on ?? []).every((d) => this.planStepsDone.has(d) || this.planStepsSkipped.has(d))) return s;
    }
    return null;
  }

  private async engineDirect(request: Parameters<typeof executeTool>[1] extends never ? never : import("../ipc/types").EngineRequest, grant?: string): Promise<ToolResult> {
    const auth: Auth = { build_session: this.buildSession, role: "lead" };
    if (grant) auth.grant = grant;
    try {
      const resp = await call("engine_request", { project_key: this.d.projectKey, request, auth });
      return resp.ok ? { ok: true, data: resp.data, meta: { bytes: 0, run_id: resp.meta.run_id, ops_sha256: resp.meta.ops_sha256 }, trust: "untrusted" } : { ok: false, error: { code: resp.error?.code ?? "ENGINE", message: resp.error?.message ?? "", remediation: resp.error?.remediation, evidence: resp.error?.evidence }, meta: { bytes: 0 }, trust: "untrusted" };
    } catch (e) {
      const f = e instanceof IpcFailure ? e.error : { code: "IPC_TRANSPORT", message: String(e) };
      return { ok: false, error: { code: f.code, message: f.message }, meta: { bytes: 0 }, trust: "untrusted" };
    }
  }

  private async runTurn(q: Queued): Promise<void> {
    if (!this.ensureSession()) return;
    // Turn numbers are Rust's (project-wide, persisted): checkpoints, rollback and the
    // ledger are keyed by them, so the harness must not invent its own sequence.
    const pinfo = await call("project_info", { project_key: this.d.projectKey }).catch(() => null);
    const turnNo = (pinfo?.last_turn ?? this.turns[this.turns.length - 1]?.turn ?? 0) + 1;
    const last = this.turns[this.turns.length - 1];
    if (last && last.turn === turnNo && last.kind === null) this.turns.pop(); // a turn that never reached turn.begin did not consume the number
    const task = q.task ?? ++this.taskCounter;
    const t = newTurnRecord(turnNo, task, q.message.text, q.message.refs, this.mode, nowIso());
    this.currentTurn = t;
    this.turns.push(t);
    t.gen = this.turnGen;
    this.stopRequested = false;
    this.abort = new AbortController();
    this.pendingHardStop = null; this.planDenied = null; this.expectedMerges = []; this.unlocked.clear(); this.idem.clear(); this.instancePaths.clear();
    const s = this.d.settings();
    if (s.agent.budget_enabled) {
      this.turnBudget = new BudgetLedger(turnLimits(s.agent.budget_defaults), s.agent.budget_defaults.warn_pct);
      if (!this.planBudget) this.planBudget = new BudgetLedger(planLimits(s.agent.budget_defaults), s.agent.budget_defaults.warn_pct);
    } else {
      this.turnBudget = null;
      this.planBudget = null;
    }
    const state = newTurnPolicyState(turnNo, this.mode, this.effectivePolicy(), "lead", this.buildSession);
    // The human's own words, for `pNoAsk`: "make reasonable assumptions and do not ask me questions"
    // has to bind the loop, not only the system prompt.
    state.userText = q.message.text;
    if (s.agent.budget_enabled) state.budgetExhausted = this.planBudget?.exhausted() ?? null;
    state.rulesUnconfirmed = false;
    this.policyState = state;
    // A change KiCad made since the previous turn goes in front of this turn's message, the way the
    // rollback marker does: the model reads it before it plans anything on the old designators.
    this.flushExternalMarker(turnNo, task);
    t.status = "running";
    const started = this.d.now?.() ?? Date.now();
    this.turnBudget?.startActive(started);
    this.d.emit({ kind: "phase", turn: turnNo, role: "lead", phase: "thinking" });

    // Slash commands
    const text = q.message.text.trim();
    if (text === "/compact") { await this.compact(2, true); t.kind = "question"; t.headline = "compact"; t.status = "done"; this.finishTurn(t, started); return; }
    // `/review` reviews the project; `/review <sheet>` (file, stem or instance path) narrows it to
    // one sheet, the same argument shape as `/workflow <id>`.
    const rv = /^\/review(?:\s+(.+?))?\s*$/i.exec(text);
    if (rv) { await this.runReviewTurn(t, state, started, rv[1] ?? null); return; }
    if (text === "/fix") { await this.runFixTurn(t, state, started); return; }
    if (text === "/instances") { await this.runInstanceRefsTurn(t, state, started); return; }
    const wf = /^\/workflow\s+(\S+)\s*$/i.exec(text);
    if (wf) { await this.runWorkflowTurn(t, state, started, wf[1]); return; }

    // Micro-edit fast path (no model)
    const micro = parseMicroEdit(text, [...q.message.refs, ...this.selectionRefs]);
    if (micro && this.mode === "build" && this.buildSession) {
      await this.runMicroEdit(t, micro, started);
      return;
    }

    // Plan-step execution: "/run" or "continue" with an approved plan in Build
    if (/^\/(run|continue|next)\b/i.test(text) && !(this.mode === "build" && this.buildSession && this.planApproved && this.plan)) {
      const reason = this.mode !== "build" ? "mode is not build" : !this.buildSession ? "no build session" : !this.plan ? "no plan" : "plan not approved";
      this.d.emit({ kind: "system", text_key: "system.run_unavailable", params: { reason }, severity: "warning" });
    }
    if (this.mode === "build" && this.buildSession && this.planApproved && this.plan && (/^\/(run|continue|next|redo|skip)\b/i.test(text) || q.task !== null)) {
      const cmd = /^\/(run|continue|next|redo|skip)\b\s*(\S+)?/i.exec(text);
      const verb = cmd?.[1]?.toLowerCase() ?? "continue";
      const wanted = cmd?.[2]?.trim() || null;
      let step: PlanStep | null = null;
      if (verb === "skip" && wanted) {
        const target = this.plan.steps.find((x) => x.id === wanted);
        if (target && !this.planStepsDone.has(target.id)) { this.planStepsSkipped.add(target.id); this.stepNotes.set(target.id, "skipped by the user"); this.d.emit({ kind: "system", text_key: "system.step_skipped_by_user", params: { step: target.id }, severity: "info" }); }
        step = this.nextStep();
      } else if (verb === "redo" && wanted) {
        const r = this.reopenStep(wanted);
        if (!r.ok) { this.d.emit({ kind: "system", text_key: "system.run_unavailable", params: { reason: r.reason }, severity: "warning" }); t.kind = "question"; t.headline = `redo ${wanted}`; t.status = "done"; this.finishTurn(t, started); return; }
        step = r.step;
      } else {
        // `/continue <id>` targets that step when it is still open and its dependencies are met.
        const target = wanted ? this.plan.steps.find((x) => x.id === wanted) : undefined;
        const open = target && !this.planStepsDone.has(target.id) && !this.planStepsSkipped.has(target.id) && (target.depends_on ?? []).every((d) => this.planStepsDone.has(d) || this.planStepsSkipped.has(d));
        step = open ? target! : this.nextStep();
      }
      if (!step) { t.kind = "question"; t.headline = "plan complete"; t.status = "done"; this.finishTurn(t, started); return; }
      // A step boundary is a legal compaction point: a long plan run must not grow the history unchecked.
      const needStep = needCompaction(this.usedEstimate(), turnNo, { settings: s.context, window: this.window(), lastCompactionTurn: this.lastCompactionTurn });
      if (needStep !== "none") await this.compact(needStep === "auto" ? 1 : 2, needStep === "precheck");
      await this.runPlanStepTurn(t, step, started);
      return;
    }

    // Pre-compaction check at the turn boundary
    const need = needCompaction(this.usedEstimate(), turnNo, { settings: s.context, window: this.window(), lastCompactionTurn: this.lastCompactionTurn });
    if (need !== "none") await this.compact(need === "auto" ? 1 : 2, need === "precheck");

    await this.runModelTurn(t, q, started);
  }

  // ---------------------------------------------------------------------------
  // Model-driven turn
  // ---------------------------------------------------------------------------

  private async resolveRefs(refs: Ref[]): Promise<ResolvedRef[]> {
    if (!refs.length) return [];
    const r = await this.engineDirect({ kind: "resolve", refs });
    const detail = (r.ok ? (r.data as { resolved?: { ref: Ref; resolved: boolean; detail?: unknown }[] })?.resolved : undefined) ?? [];
    return refs.map((ref, i) => ({ ref, resolved: detail[i]?.resolved ?? false, trust: "untrusted", detail: detail[i]?.detail }));
  }

  private async runModelTurn(t: TurnRecord, q: Queued, started: number): Promise<void> {
    const state = this.policyState!;
    const lang = detectReplyLanguage(q.message.text, this.d.settings().language);
    this.turnLang = lang;
    const resolved = await this.resolveRefs([...q.message.refs, ...(this.d.settings().agent.chat_attach_selection ? this.selectionRefs : [])]);
    let summary = "";
    const sum = await this.engineDirect({ kind: "summary", sheet: null });
    if (sum.ok) summary = resultText(sum, capFor("sch.summary"));
    if (sum.ok) { const d = sum.data as { refdes?: Record<string, { used: [number, number][]; next: number }> }; if (d.refdes) for (const [prefix, v] of Object.entries(d.refdes)) state.occupied[prefix] = v.used.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)); }
    const userText = [
      q.message.text,
      q.message.attachments.length ? `<attachments>\n${q.message.attachments.map((a) => `${a.kind} ${a.sha256.slice(0, 12)} "${a.label}" ${a.size} bytes`).join("\n")}\n</attachments>` : "",
      refsBlock(resolved),
      `<reply_language>${lang}</reply_language>`,
      this.stateBlock(),
      summary ? `<untrusted source="sch.summary">\n${summary}\n</untrusted>` : "",
    ].filter(Boolean).join("\n\n");
    const userMsg: HMessage = { role: "user", content: [{ type: "text", text: userText }], meta: { turn: t.turn, task: t.task, kind: "user" } };
    this.history.push(userMsg);
    await this.d.persistence.appendMessage(userMsg).catch(() => undefined);

    const req = this.assembleRequest();
    const sem = new Semaphore(this.d.settings().advanced.tool_parallel_max || TOOL_PARALLEL_MAX_DEFAULT);
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    const bindings: ToolBinding[] = this.table().map((def) => this.binding(def, ctx, bus, t));
    const tools = bindTools(bindings, sem);
    const history = toPiMessages(req.messages.slice(0, -1));
    const prompt = toPiMessages([req.messages[req.messages.length - 1]]);
    let messageId = localId("msg");
    let firstToken = false;
    let sawOutput = false;
    let overflowed = false; // PROVIDER_CONTEXT_OVERFLOW from the provider: compact once and resend
    let degenerate = false; // the model looped on tool-call arguments: nudge once with the exact field list
    let thinkingRejected = false; // the provider refused the replayed reasoning of an earlier turn: drop it once and resend
    const onEvent = (e: AgentEvent) => {
      if (e.type === "message_start" && e.message.role === "assistant") { messageId = localId("msg"); firstToken = false; }
      if (e.type === "tool_execution_start") sawOutput = true;
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        if (!firstToken) { firstToken = true; this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: "thinking" }); }
        this.d.emit({ kind: "assistant_delta", turn: t.turn, message_id: messageId, delta: e.assistantMessageEvent.delta });
      }
      if (e.type === "message_end" && e.message.role === "assistant") {
        this.endProgress(t, `think-${t.turn}`);
        const m = e.message;
        const h = fromAssistant(m, t.turn, t.task);
        const text = h.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        // An error / aborted message with no text and no tool call is not a conversation turn: strict providers
        // reject an empty assistant message on the next call, so it is recorded in the turn, not in the history.
        const empty = !text.trim() && (h.role !== "assistant" || h.toolCalls.length === 0);
        if (!(empty && (m.stopReason === "error" || m.stopReason === "aborted"))) {
          this.history.push(h);
          void this.d.persistence.appendMessage(h).catch(() => undefined);
        }
        if (text) { sawOutput = true; this.d.emit({ kind: "assistant_done", turn: t.turn, message_id: messageId, text: sanitizeMarkdown(text) }); }
        if (m.stopReason === "error") {
          const code = (m.errorMessage ?? "PROVIDER_ERROR").split(":")[0];
          if (code === "PROVIDER_CONTEXT_OVERFLOW") overflowed = true;
          if (code === "PROVIDER_BAD_REQUEST" && /PROVIDER_DEGENERATE_OUTPUT/.test(m.errorMessage ?? "")) degenerate = true;
          // Replayed reasoning the provider no longer accepts (a signature it cannot verify, a reasoning item
          // whose pair a compaction removed): only when an earlier turn still carries thinking to drop.
          if (code === "PROVIDER_BAD_REQUEST" && /thinking|reasoning|signature|encrypted/i.test(m.errorMessage ?? "") && this.history.some((x) => hasThinking(x) && x.meta.turn !== t.turn)) thinkingRejected = true;
          this.d.emit({ kind: "error", turn: t.turn, error: { code, message: m.errorMessage ?? "", req_id: "" } });
        }
        // The model hit the output cap: a tool call cut in half is a broken call, not a finished reply.
        if (m.stopReason === "length") this.d.emit({ kind: "system", text_key: "system.output_truncated", severity: "warning" });
      }
      if (e.type === "message_update" && e.assistantMessageEvent.type === "thinking_delta") {
        this.progress(t, "lead", `think-${t.turn}`, e.assistantMessageEvent.delta.length);
      }
      if (e.type === "tool_execution_start") {
        const toolName = decodeToolName(e.toolName);
        const def = toolDef(toolName);
        const att = attentionOf(toolName, (e.args ?? {}) as Record<string, unknown>);
        if (att) this.d.emit({ kind: "attention", turn: t.turn, role: "lead", label: att.label, refs: att.refs, region_mil: att.region_mil });
        this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: (def?.phase ?? "exploring") as Phase });
        const line: ActivityLine = { id: e.toolCallId, role: "lead", phase: (def?.phase ?? "exploring") as Phase, label: toolName, detail: argsSummary(e.args), started_at: nowIso(), kind: "tool" };
        this.openLines.set(line.id, line);
        this.d.emit({ kind: "activity", turn: t.turn, line });
      }
      if (e.type === "tool_execution_end") {
        const toolName = decodeToolName(e.toolName);
        // History keeps the blocks the provider was actually sent (pi's toolResult message carries
        // `result.content`, nothing else). Storing `JSON.stringify(result)` — the whole AgentToolResult
        // with its local `details` — replayed a different string on every later call and broke the cache
        // prefix from the turn's first tool call onwards (caching-strategy.md: history is append-only).
        const blocks = toolResultBlocks(e.result);
        const resText = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
        const h: HMessage = { role: "toolResult", toolCallId: e.toolCallId, toolName, content: blocks, isError: e.isError, meta: { turn: t.turn, task: t.task, kind: toolName === "sch.summary" ? "sch_summary" : toolName === "turn.begin" ? "turn_begin" : "tool" } };
        this.history.push(h);
        // `paired` means every call of that message has a result, not just this one (parallel tool calls).
        for (const m of this.history) if (m.role === "assistant" && m.toolCalls.some((c) => c.id === e.toolCallId)) m.meta.paired = m.toolCalls.every((c) => this.history.some((r) => r.role === "toolResult" && r.toolCallId === c.id));
        void this.d.persistence.appendMessage(h).catch(() => undefined);
        const open = this.openLines.get(e.toolCallId);
        this.openLines.delete(e.toolCallId);
        const started = open?.started_at ?? nowIso();
        t.tools.push({ name: toolName, ok: !e.isError, bytes: resText.length, ms: Math.max(0, Date.now() - new Date(started).getTime()) });
        this.d.emit({ kind: "activity", turn: t.turn, line: { ...(open ?? { id: e.toolCallId, role: "lead" as Role, phase: (toolDef(toolName)?.phase ?? "exploring") as Phase, label: toolName, started_at: started }), ended_at: nowIso(), ok: !e.isError, bytes: resText.length } });
      }
    };
    const before = async (c: BeforeToolCallContext) => this.beforeHook(c, bus, state, t);
    const after = async (c: AfterToolCallContext) => this.afterHook(c, bus, state, t, ctx);
    try {
      const tl = this.d.settings().agent.thinking_level;
      const reasoning = tl === "off" || !tl ? undefined : (tl as "minimal" | "low" | "medium" | "high");
      // From here the provider has seen a prefix of `history`: no compaction below it until the turn ends.
      this.sentInTurn = true;
      await runLoop({ system: req.system, tools, history, prompt, model: this.model!, streamFn: this.streamFn!, signal: this.abort!.signal, reasoning, hooks: { before, after, shouldStop: () => this.stopRequested || state.budgetExhausted !== null, steering: async () => this.takeSteering(t) }, onEvent });
      if (degenerate && !this.stopRequested) {
        degenerate = false;
        this.d.emit({ kind: "system", text_key: "system.degenerate_output", severity: "warning" });
        this.steer("Your last tool call was cut off: its arguments kept growing with invented fields (a repetition loop). Call the tool again using only the fields in its schema; for turn.begin that is kind, headline, plan_step and envelope {sheets, allowed_ops, components_added_max, components_deleted_max, structural, nets_renamable}.");
        await runLoop({ system: req.system, tools, history: toPiMessages(this.assembleRequest().messages), prompt: [], model: this.model!, streamFn: this.streamFn!, signal: this.abort!.signal, reasoning, hooks: { before, after, shouldStop: () => this.stopRequested || state.budgetExhausted !== null, steering: async () => this.takeSteering(t) }, onEvent });
      }
      if (overflowed && !this.stopRequested) {
        // provider-resilience.md §1: an overflow the estimate missed is compacted once and the request resent.
        overflowed = false;
        this.d.emit({ kind: "system", text_key: "system.context_overflow_compact", severity: "info" });
        await this.compact(2, true);
        await runLoop({ system: req.system, tools, history: toPiMessages(this.assembleRequest().messages), prompt: [], model: this.model!, streamFn: this.streamFn!, signal: this.abort!.signal, reasoning, hooks: { before, after, shouldStop: () => this.stopRequested || state.budgetExhausted !== null, steering: async () => this.takeSteering(t) }, onEvent });
      }
      if (thinkingRejected && !this.stopRequested) {
        // The provider rejected the reasoning blocks replayed from earlier turns. Dropping them is a rewrite
        // of messages it has seen, so it happens once, here, at what is in effect a compaction boundary, and
        // is recorded like a forced mid-turn compaction so a cache-ratio drop can be traced to it. The DB keeps
        // the originals; the current turn's thinking is untouched.
        thinkingRejected = false;
        const dropped = dropThinking(this.history, t.turn);
        this.history = dropped.history;
        void this.d.persistence.metric("thinking_dropped_on_reject", 1, { turn: t.turn, blocks: dropped.dropped }).catch(() => undefined);
        await runLoop({ system: req.system, tools, history: toPiMessages(this.assembleRequest().messages), prompt: [], model: this.model!, streamFn: this.streamFn!, signal: this.abort!.signal, reasoning, hooks: { before, after, shouldStop: () => this.stopRequested || state.budgetExhausted !== null, steering: async () => this.takeSteering(t) }, onEvent });
      }
      if (!sawOutput && !this.stopRequested) {
        // Some models answer a bare greeting with nothing at all: nudge once, then tell the user.
        this.steer("You produced no text and no tool call. Reply to the user now in their language (call turn.begin with kind=question first if you have not).");
        await runLoop({ system: req.system, tools, history: toPiMessages(this.assembleRequest().messages), prompt: [], model: this.model!, streamFn: this.streamFn!, signal: this.abort!.signal, hooks: { before, after, shouldStop: () => this.stopRequested || state.budgetExhausted !== null, steering: async () => this.takeSteering(t) }, onEvent });
        if (!sawOutput) this.d.emit({ kind: "system", text_key: "system.empty_reply", severity: "warning" });
      }
      // Plan mode: a design request must end in a plan card or an ask_user card, never in prose questions
      // ("please confirm A and B") that the UI cannot answer. Nudge once.
      // A denied call is not a plan card: `pNoAsk` refuses ask_user when the user said not to ask, and a
      // turn that ended on that denial in prose still owes the human a plan.
      const usedPlanTools = t.tools.some((x) => x.ok && (x.name === "plan.write" || x.name === "ask_user" || x.name === "suggest_mode"));
      // Also when the Lead never declared the turn (a real run ended after one denied lookup with "turn.begin is
      // unavailable"): the nudge names the tool that is available.
      if (!this.stopRequested && this.mode === "plan" && (state.kind === "instruction" || !state.began) && !this.planApproved && !usedPlanTools && sawOutput) {
        this.steer(!state.began
          ? "You ended a design request in Plan mode without declaring the turn. turn.begin is available: call turn.begin { kind: \"instruction\", headline } now, then dispatch the architect or call plan.write with the complete DesignPlan, and finish with a two-line summary."
          // Pointing at ask_user in a turn where the user said not to ask would only earn a second denial.
          : saysDoNotAsk(state.userText ?? "")
            ? "You ended a design request in Plan mode without a plan, and this turn may raise no question card. Decide every open point with the most common option, record each one in the plan's assumptions[], then call plan.write with the complete DesignPlan (sheets with file names, blocks with parts, steps, envelope budgets) and finish with a two-line summary."
            : "You ended a design request in Plan mode without a plan. Do not ask questions in prose: if a decision truly needs the human, call ask_user (single or multi-select with a sensible default) now; otherwise decide with the most common option, then call plan.write with the complete DesignPlan (sheets with file names, blocks with parts, steps, envelope budgets) and finish with a two-line summary.");
        // Same assembler as the first call: markers filtered, plan snapshot in place, so the cache prefix matches.
        await runLoop({ system: req.system, tools, history: toPiMessages(this.assembleRequest().messages), prompt: [], model: this.model!, streamFn: this.streamFn!, signal: this.abort!.signal, reasoning, hooks: { before, after, shouldStop: () => this.stopRequested || state.budgetExhausted !== null, steering: async () => this.takeSteering(t) }, onEvent });
      }
    } catch (e) {
      this.d.emit({ kind: "error", turn: t.turn, error: { code: "LOOP_FAILED", message: String(e), req_id: "" } });
      t.status = "abandoned";
    }
    // unpaired tool_use → user_stopped results (§8.1 ⑤); checked per call, so a message whose first call
    // completed but whose second was cut off still gets a result for the second.
    for (const m of this.history) if (m.role === "assistant" && m.meta.turn === t.turn && m.toolCalls.length) {
      for (const tc of m.toolCalls) if (!this.history.some((r) => r.role === "toolResult" && r.toolCallId === tc.id)) this.history.push({ role: "toolResult", toolCallId: tc.id, toolName: tc.name, content: [{ type: "text", text: JSON.stringify({ is_error: true, reason: this.stopRequested ? "user_stopped" : "stream_broken" }) }], isError: true, meta: { turn: t.turn, task: t.task, kind: "tool" } });
      m.meta.paired = true;
    }
    if (t.applies.length) await this.postTurnGate(t, { ctx, bus, state });
    if (t.status === "running") {
      const applyAttempts = t.tools.filter((x) => x.name === "sch.apply" || x.name === "sch.apply_waived");
      const allRefused = applyAttempts.length > 0 && applyAttempts.every((x) => !x.ok);
      t.status = this.stopRequested ? "stopped" : allRefused ? "failed" : "done";
    }
    if (this.stopRequested) t.stop_reason = "user";
    this.finishTurn(t, started);
    // A model-driven turn that worked on a plan step completes that step; under Auto the plan
    // keeps going by itself (the harness-driven step runner takes the next one).
    if (t.plan_step && t.kind === "instruction" && t.status === "summarized" && this.plan && this.planApproved && !this.stopRequested) {
      this.planStepsDone.add(t.plan_step);
      this.persistProgress();
      const next = this.nextStep();
      if (!next) {
        this.plan.display.status = this.planStepsSkipped.size ? "done_with_skips" : "done";
        this.d.emit({ kind: "card", card: systemCard(t.turn, "system.plan_done", { skipped: [...this.planStepsSkipped], status: this.plan.display.status, ...this.openFindingCounts() }, this.planStepsSkipped.size ? [{ id: "redo_skipped", label_key: "card.redo_skipped", style: "primary" }, { id: "dismiss", label_key: "card.dismiss", style: "secondary" }] : []) });
      } else if (this.effectivePolicy() === "auto" && this.d.settings().agent.continuous_run && this.mode === "build" && this.buildSession) {
        // Each step is its own task: `keep_recent_tasks` then protects only the last steps and compaction can retire the rest.
        this.enqueue({ message: { text: `/continue ${next.id}`, refs: [], attachments: [], session_id: this.d.sessionId }, task: null, steer: false });
      }
    }
  }

  private steering: HMessage[] = [];
  private async takeSteering(t: TurnRecord): Promise<import("./pi-adapter").AgentMessage[]> {
    if (!this.steering.length) return [];
    const msgs = this.steering.splice(0);
    for (const m of msgs) { m.meta.turn = t.turn; m.meta.task = t.task; this.history.push(m); }
    return toPiMessages(msgs);
  }

  steer(text: string): void {
    this.steering.push({ role: "user", content: [{ type: "text", text: `<steering>${text}</steering>` }], meta: { turn: 0, task: 0, kind: "injection" } });
    if (this.currentTurn) this.currentTurn.stop_reason = "steered";
  }

  private rails(): string[] { return this.plan?.net_naming.rails ?? this.policyState?.envelope?.rails ?? []; }
  private stepNets(): { nets_in: string[]; nets_out: string[]; rails: string[] } {
    const step = this.plan ? this.plan.steps.find((s) => s.id === this.policyState?.step) : undefined;
    const block = step?.block ? this.plan?.blocks.find((b) => b.id === step.block) : undefined;
    return { nets_in: block?.nets_in ?? [], nets_out: block?.nets_out ?? (step?.nets ?? []), rails: this.rails() };
  }

  private toolContext(state: TurnPolicyState, t: TurnRecord, role: Role): ToolContext {
    return {
      projectKey: this.d.projectKey,
      auth: () => ({ build_session: this.buildSession, role }),
      turn: t.turn, step: state.step, role,
      skills: this.d.skills, plans: this.d.plans,
      selection: () => this.selectionRefs,
      sheets: () => this.d.sheets(),
      planState: () => (this.plan ? (this.planApproved ? "approved" : "draft") : "none"),
      policy: () => this.effectivePolicy(),
      emitCard: (make) => { const card = make(t.turn); if (!card.id) card.id = localId("card"); this.d.emit({ kind: "card", card }); },
      askCard: async (make) => {
        const card = make(t.turn);
        card.id = card.id || localId("card");
        return this.askCard(card, state, t);
      },
      emitFocus: (refs) => this.d.emit({ kind: "focus", refs }),
      onStatus: (text) => this.d.emit({ kind: "status", turn: t.turn, text }),
      turnBegin: (args) => this.turnBegin(args, state, t),
      ledger: (step, phase, payload) => this.d.persistence.ledger(t.turn, step, phase as "intended", payload),
      expectedMerges: () => this.expectedMerges,
      unlockedGrant: (sha) => this.takeGrant(sha),
      grantReason: (grant) => this.grantReasons.get(grant),
      m3: false, vision: this.providerCfg?.vision ?? false,
    };
  }

  /** H-tier card with policy handling (Auto takes defaults / skips). */
  private async askCard(card: Card, state: TurnPolicyState, t: TurnRecord): Promise<{ action_id: string; free_text?: string; grant?: string; consent_event_id?: string }> {
    if (this.zombie(t)) return { action_id: "ignored" }; // a force-stopped turn never shows a card (and never stops the live turn)
    if (this.effectivePolicy() === "auto" && card.kind === "question") {
      const def = (card.data as { default?: string } | undefined)?.default;
      const dec = adjudicate({ condition: "ask_user", step: state.step, mode: this.mode, hasDefault: def !== undefined });
      if (dec) { t.auto_decisions.push(dec); card.auto = { decision: dec.action, reason: dec.detail ?? "" }; this.d.emit({ kind: "card", card }); return { action_id: dec.action === "default_answer" ? "default" : "skip", free_text: def }; }
    }
    this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: "waiting" });
    this.turnBudget?.stopActive(this.d.now?.() ?? Date.now());
    const waitStart = this.d.now?.() ?? Date.now();
    // Stop while a card is up (or already requested): the card resolves as "abandon" instead of waiting forever.
    if (this.stopping) { card.auto = { decision: "abandon", reason: "user_stopped" }; this.d.emit({ kind: "card", card }); return { action_id: "abandon" }; }
    this.d.emit({ kind: "card", card });
    // crash-recovery.md §3 "waiting": persist the card so a restart can re-issue it (no grant / consent ids).
    await this.d.persistence.pendingCard(t.turn, pendingCardFile(card, state.step)).catch(() => undefined);
    const signal = this.abort?.signal;
    const abandoned = new Promise<{ action_id: string; free_text?: string; grant?: string; consent_event_id?: string }>((resolve) => {
      if (!signal) return;
      if (signal.aborted) resolve({ action_id: "abandon" });
      else signal.addEventListener("abort", () => resolve({ action_id: "abandon" }), { once: true });
    });
    const r = await Promise.race([this.d.showCard(card), abandoned]);
    // Abort won: the card is dead; drop its resolver so a late click cannot create an unconsumed grant.
    if (this.abort?.signal.aborted) this.d.dismissCard?.(card.id);
    await this.d.persistence.pendingCard(t.turn, null).catch(() => undefined);
    t.wall_waiting_ms += (this.d.now?.() ?? Date.now()) - waitStart;
    this.turnBudget?.startActive(this.d.now?.() ?? Date.now());
    this.d.emit({ kind: "card_answered", card_id: card.id, action_id: r.action_id, ...(r.free_text ? { free_text: r.free_text } : {}) });
    return r;
  }

  private async turnBegin(args: Record<string, unknown>, state: TurnPolicyState, t: TurnRecord): Promise<unknown> {
    // A degenerate model output (repeated invented fields) once produced a multi-kilobyte declaration:
    // refuse it with a precise hint instead of parsing it.
    if (this.zombie(t)) throw new Error("the turn was force-stopped by the user; this declaration is ignored");
    const size = JSON.stringify(args).length;
    if (size > TURN_BEGIN_ARGS_MAX_CHARS) throw new Error(`turn.begin arguments are ${size} characters; declare only kind, headline, plan_step and envelope {sheets, allowed_ops, components_added_max, components_deleted_max, structural, nets_renamable}`);
    const kind = args.kind as TurnKind;
    const headline = String(args.headline ?? "");
    const planStep = typeof args.plan_step === "string" ? args.plan_step : null;
    const humanNamedSheets: string[] = [];
    let ceiling: Envelope;
    if (this.plan && this.planApproved && planStep) {
      const step = this.plan.steps.find((s) => s.id === planStep);
      if (step) {
        // The approved plan is the human's approval: the whole plan's budgets are the ceiling,
        // the step only narrows sheets/structural. Per-step counting caused constant scope cards.
        const pb = this.plan.envelope.budgets;
        ceiling = { ...stepEnvelope(this.plan, step), components_added_max: pb.components_added, components_deleted_max: pb.components_deleted, wires_max: pb.wires_added || null };
        state.step = planStep;
      } else {
        // Unknown step id: use the whole plan's envelope rather than a zero ceiling.
        const pb = this.plan.envelope.budgets;
        ceiling = { ...sessionCeiling(pb.components_added, this.d.sheets(), this.rails()), components_deleted_max: pb.components_deleted, wires_max: pb.wires_added || null, allowed_ops: this.plan.envelope.allowed_ops, structural: this.plan.envelope.structural, nets_renamable: this.plan.envelope.nets.renamable, source: `plan:${this.plan.id}@${this.plan.version}` };
        this.d.emit({ kind: "system", text_key: "system.plan_step_unknown", params: { step: planStep }, severity: "warning" });
      }
    } else if (this.plan && this.planApproved) {
      const pb = this.plan.envelope.budgets;
      ceiling = { ...sessionCeiling(pb.components_added, this.d.sheets(), this.rails()), components_deleted_max: pb.components_deleted, wires_max: pb.wires_added || null, allowed_ops: this.plan.envelope.allowed_ops, structural: this.plan.envelope.structural, nets_renamable: this.plan.envelope.nets.renamable, source: `plan:${this.plan.id}@${this.plan.version}` };
    } else {
      // The parts the human's own message names ("change R2 and C3") size the edit budget and become
      // `refs_editable`: human-authored scope, like the sheet files below, never the model's.
      const named = namedDesignators(t.message, t.refs);
      ceiling = sessionCeiling(this.d.settings().agent.session_ceiling_components_added || SESSION_CEILING_COMPONENTS_ADDED_DEFAULT, this.d.sheets(), this.rails(), named);
      // Sheet files the human literally named in this turn's message ("file power.kicad_sch") are
      // human-authored scope, not model-authored: creating exactly those sheets is not a widen.
      const existing = this.d.sheets();
      for (const f of new Set(t.message.match(/[\w.-]+\.kicad_sch/g) ?? [])) {
        humanNamedSheets.push(f);
        if (!ceiling.sheets.includes(f)) ceiling.sheets.push(f);
        if (!existing.includes(f)) for (const k of [`create_sheet:${f}`, `add_sheet:${f}`]) if (!ceiling.structural.includes(k)) ceiling.structural.push(k);
      }
    }
    if (this.plan && this.planApproved) {
      // The approved plan implies creating its sheets; plan sheets that already exist are just in scope.
      const existing = this.d.sheets();
      ceiling.structural = Array.from(new Set([...ceiling.structural, ...planStructural(this.plan, existing)]));
      for (const sh of this.plan.sheets) if (!ceiling.sheets.includes(sh.file)) ceiling.sheets.push(sh.file);
    }
    // Rust deserialises Vec<String>: never let an undefined sheet/op slip through.
    for (const k of ["sheets", "allowed_ops", "structural", "nets_renamable", "rails", "interfaces"] as const) ceiling[k] = (Array.isArray(ceiling[k]) ? (ceiling[k] as unknown[]) : []).filter((x): x is string => typeof x === "string" && x.length > 0);
    // Envelopes only matter for Build instructions; anything else is ignored rather than rejected.
    const wantsEnvelope = kind === "instruction" && this.mode === "build";
    const coerced = wantsEnvelope && args.envelope !== undefined ? coerceEnvelope(args.envelope) : null;
    if (wantsEnvelope && args.envelope !== undefined && !coerced) {
      throw new Error("ENVELOPE_SCHEMA: envelope must be an object {sheets: string[], allowed_ops: string[], components_added_max: number, components_deleted_max: number, structural: string[], nets_renamable: string[]}.");
    }
    const decl0 = coerced ? ({ ...(coerced as unknown as Partial<Envelope>) }) : null;
    if (decl0) {
      // "/" or the root sheet's display name mean the root file.
      const rootRel = this.d.sheets()[0];
      if (rootRel && Array.isArray(decl0.sheets)) decl0.sheets = decl0.sheets.map((x) => (x === "/" || x === "root" || x === "" ? rootRel : x));
      // Renaming applies to nets that exist; names the model intends to *create* are not a widening.
      if (Array.isArray(decl0.nets_renamable) && decl0.nets_renamable.length) {
        const existing = new Set<string>();
        try {
          const r = await this.engineDirect({ kind: "nets", sheet: null, limit: 2000 });
          for (const n of ((r.data as { nets?: { name: string }[] })?.nets ?? [])) existing.add(n.name);
        } catch { /* no nets yet */ }
        // The nets list is instance-qualified (`/MIDROOT` on the root, `/power/NET_X` on a child sheet)
        // while the envelope entry is the label text Rust compares `old_name` against, so a name is
        // kept when any sheet carries it; which sheet's label the rename means is the engine's call
        // (a local label is per sheet, and rename_net asks for `sheet` when several sheets have it).
        const bare = new Set(Array.from(existing, bareNetName));
        decl0.nets_renamable = decl0.nets_renamable.filter((n) => existing.has(n) || bare.has(n));
      }
    }
    if (decl0 && Array.isArray(decl0.sheets)) {
      const existing = this.d.sheets();
      const st = new Set<string>();
      // Free-text structural entries ("create hierarchical sheet power.kicad_sch with two pins") name the file: canonicalise.
      for (const x of decl0.structural ?? []) {
        if (/^(create_sheet|add_sheet|delete_sheet|remove_sheet|rename_sheet|delete_component|remove_component):/.test(x)) { st.add(x); continue; }
        const f = /([\w.-]+\.kicad_sch)/.exec(x)?.[1];
        if (f && /creat|add|new|hierarch/i.test(x)) { st.add(`create_sheet:${f}`); continue; }
        st.add(x);
      }
      for (const f of decl0.sheets) if (!existing.includes(f) && ceiling.structural.includes(`create_sheet:${f}`)) { st.add(`create_sheet:${f}`); st.add(`add_sheet:${f}`); }
      for (const x of [...st]) { const m = /^create_sheet:(.+)$/.exec(x); if (m) st.add(`add_sheet:${m[1]}`); }
      // A bare verb ("create_sheet") is the ceiling's own file-qualified entry when the ceiling has one:
      // rewrite it here, so the declaration the human may later approve (`widenedEnv`) and the one Rust
      // is told carry the file, not a verb that matches nothing.
      decl0.structural = qualifyStructural(Array.from(st), ceiling.structural);
    }
    // Sheets the human named in the message are in scope whether or not the model declared them
    // (the declaration is the model's; the message is the human's).
    if (decl0 && humanNamedSheets.length) {
      const existing = this.d.sheets();
      decl0.sheets = Array.isArray(decl0.sheets) ? decl0.sheets : [];
      decl0.structural = Array.isArray(decl0.structural) ? decl0.structural : [];
      for (const f of humanNamedSheets) {
        if (!decl0.sheets.some((x) => sheetMatches(f, x))) decl0.sheets.push(f);
        if (!existing.includes(f)) for (const k of [`create_sheet:${f}`, `add_sheet:${f}`]) if (!decl0.structural.includes(k)) decl0.structural.push(k);
      }
    }
    const decl = decl0;
    // Undeclared budgets mean "as much as the ceiling allows", never zero (a model that names its budget
    // fields wrongly must not open a turn it cannot write in).
    if (decl) {
      const d = decl as unknown as Record<string, unknown>;
      if (typeof d.components_added_max !== "number") d.components_added_max = ceiling.components_added_max;
      if (typeof d.components_deleted_max !== "number") d.components_deleted_max = 0;
    }
    const unknownOps = (decl?.allowed_ops ?? []).filter((o) => !isKnownOp(o));
    if (unknownOps.length) {
      throw new Error(`OP_UNKNOWN: ${unknownOps.join(", ")} is not an op. Valid ops: ${ALL_OPS.join(", ")}. Call turn.begin again with real op names (a value change is set_component_parameters).`);
    }
    // Envelopes are closed under macro expansion: the engine validates the expanded op-list, so
    // "place_gnd" without "place_power_port" would hard-stop every GND symbol.
    ceiling.allowed_ops = closeAllowedOps(ceiling.allowed_ops);
    if (decl?.allowed_ops) decl.allowed_ops = closeAllowedOps(decl.allowed_ops);
    const { env, widened } = intersectEnvelope(ceiling, decl);
    // Under an approved plan step the plan is the bound and the step's own wording names parts it
    // draws; only an incremental turn is confined to the parts the human's message named.
    const narrowed = narrowEnvelopeByRefs(env, t.refs, this.plan && this.planApproved && planStep ? "" : t.message);
    let info: { turn: number; effective_envelope: Envelope; ceiling_source: string; checkpoint_pending: boolean };
    try {
      info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind, headline, plan_step: planStep, envelope: narrowed, inherit_from_turn: typeof args.inherit_from_turn === "number" ? args.inherit_from_turn : null, mode: this.mode, redeclare: !!state.beganOnce } });
    } catch (e) {
      const f = e instanceof IpcFailure ? e.error : { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" };
      if (f.code === "SESSION_EXPIRED" || f.code === "NO_BUILD_SESSION") this.onBuildExpired(t.turn);
      throw new Error(`${f.code}: ${f.message}`);
    }
    state.began = true; t.began_in_rust = true; state.beganOnce = true; state.kind = kind; state.envelope = info.effective_envelope;
    // The bound the declaration was intersected with, kept for the rest of the turn: a later refusal that
    // this ceiling would not have raised is the model narrowing itself, not a decision for the human.
    state.ceiling = ceiling;
    t.kind = kind; t.headline = headline; t.envelope = info.effective_envelope; t.plan_ref = this.planRef(); t.plan_step = planStep;
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: kind, mode: this.mode, headline, envelope: info.effective_envelope });
    if (widened.length && kind === "instruction" && this.mode === "build" && this.effectivePolicy() === "auto") {
      // Auto never asks for scope: the declaration is clamped to the ceiling (the plan totals or the
      // session ceiling, both enforced again in Rust) and the model is told what it actually got.
      this.d.emit({ kind: "system", text_key: "system.auto_clamped", params: { detail: widened.join("; ") }, severity: "info" });
      t.auto_decisions.push({ step: state.step, condition: "scope_widen", action: "skipped", detail: `clamped: ${widened.join("; ")}` } as AutoDecision);
    } else if (widened.length && kind === "instruction" && this.mode === "build") {
      // Structured for the card: { field, requested, ceiling }.
      const structured = widened.map((w) => {
        const m = /^([a-z_]+): (.*)$/.exec(w);
        const field = m?.[1] ?? "envelope"; const rest = m?.[2] ?? w;
        const num = /^(\d+) > (\d+)$/.exec(rest);
        return num ? { field, requested: num[1], ceiling: num[2] } : { field, requested: rest, ceiling: String((ceiling as unknown as Record<string, unknown>)[field] ?? "") };
      });
      // The envelope the card is *about*, built before the card so the approval can be bound to it:
      // its canonical sha is what the consent event and the Rust grant carry, and `turn_begin` only
      // widens for a grant that names this exact envelope (red line 13: one consent, one action).
      const widenedEnv: Envelope | null = decl
        ? { ...ceiling, ...decl, sheets: decl.sheets ?? ceiling.sheets, allowed_ops: decl.allowed_ops ?? ceiling.allowed_ops, structural: decl.structural ?? ceiling.structural, nets_renamable: decl.nets_renamable ?? ceiling.nets_renamable, components_added_max: decl.components_added_max ?? ceiling.components_added_max, components_deleted_max: decl.components_deleted_max ?? ceiling.components_deleted_max, source: "approved_scope" }
        : null;
      const card = hardStopCard(t.turn, "scope_widen", { widened: structured, ceiling_source: info.ceiling_source, headline }, undefined, "scope", widenedEnv ? envelopeSha(widenedEnv) : undefined);
      card.actions = card.actions.filter((a) => a.id !== "modify");
      const r = await this.askCard(card, state, t);
      if (r.action_id === "approve" && r.grant && widenedEnv) {
        // The human approved this exact declaration: re-run turn_begin unclamped with the scope grant.
        try {
          info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind, headline, plan_step: planStep, envelope: widenedEnv, inherit_from_turn: null, mode: this.mode, grant: r.grant, redeclare: true } });
        } catch (e) {
          const f = e instanceof IpcFailure ? e.error : { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" };
          throw new Error(`${f.code}: ${f.message}`);
        }
        state.envelope = info.effective_envelope; t.envelope = info.effective_envelope;
        this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: kind, mode: this.mode, headline, envelope: info.effective_envelope });
      } else {
        if (r.action_id === "abandon") { this.stopRequested = true; t.status = "abandoned"; }
        // Let the model declare again within the ceiling instead of dead-ending on P0.
        state.began = false;
        throw new Error(`scope_widen: declaration exceeds the ceiling (${widened.join("; ")}); the user chose ${r.action_id}. Call turn.begin again with an envelope inside the ceiling (or split the work into several turns).`);
      }
    }
    const eff = info.effective_envelope;
    const clamped = widened.length && this.effectivePolicy() === "auto" ? { clamped_to_ceiling: widened } : {};
    return {
      ...clamped,
      turn: info.turn,
      mode: this.mode,
      writes: this.mode === "build" && !!this.buildSession ? "allowed" : "not_allowed",
      effective_envelope: { ...eff, allowed_ops: eff.allowed_ops.length ? eff.allowed_ops : [...ALL_OPS] },
      note: eff.allowed_ops.length ? undefined : "allowed_ops was unrestricted: every opspec op is permitted within the counts above",
      ceiling_source: info.ceiling_source,
    };
  }

  private binding(def: ToolDef, ctx: ToolContext, _bus: HookBus, t: TurnRecord): ToolBinding {
    return {
      name: def.name, description: def.description, parameters: def.parameters, parallel: def.parallel === "safe",
      execute: async (id, args, signal) => {
        const state = this.policyState!;
        this.turnBudget?.addToolCall(); this.planBudget?.addToolCall();
        const key = def.idempotency === "key" ? this.idem.key(def.name, args, t.turn, state.step) : null;
        if (key) { const cached = this.idem.get(key); if (cached) return { text: resultText(cached, capFor(def.name)), isError: !cached.ok }; }
        let r: ToolResult;
        if ((def.name === "sch.apply" || def.name === "sch.apply_waived") && !(await this.recordIntent(args, t, state))) return { text: JSON.stringify({ is_error: true, code: "LEDGER_FAILED", reason: "the write-ahead record could not be written (disk full or .fluxsmith not writable); nothing was applied" }), isError: true };
        if (def.name === "agent.dispatch") r = await this.dispatch(args, t, signal);
        else r = await executeTool(def, args, ctx);
        if (key) this.idem.set(key, r);
        if (def.name === "sch.apply" || def.name === "sch.apply_waived") await this.recordApply(def.name, args, r, t, state, id);
        if (def.name === "sch.plan" && r.ok) this.lastPlanOpsSha = r.meta.ops_sha256 ?? null;
        // Rust is the second envelope check; when it refuses, the human gets the same
        // scope / structural card as a P2 denial instead of a bare error string.
        if ((def.name === "sch.apply" || def.name === "sch.apply_waived") && !r.ok && r.error && /^(ENVELOPE_|SCOPE_WIDEN)/.test(r.error.code)) {
          const structural = /deleted|structural/i.test(r.error.message);
          const hs = await this.hardStop(deny("P2", r.error.message, { remediation: "narrow the op-list to the envelope, or the user widens the scope", hard_stop: structural ? "structural" : "scope_widen", card_payload: { code: r.error.code, evidence: r.error.evidence, problems: problemsFromEvidence(r.error.code, r.error.evidence) } }) as Extract<HookVerdict, { kind: "deny" }>, state, t, def.name);
          if (hs?.block) return { text: hs.reason ?? JSON.stringify({ is_error: true, reason: r.error.message }), isError: true };
        }
        const text = resultText(r, capFor(def.name));
        return { text, isError: !r.ok, images: r.images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })), details: { run_id: r.meta.run_id } };
      },
    };
  }

  /** Ledger `intended` (write-ahead, before the engine call; crash-recovery.md §3). */
  /** The write-ahead `intended` record; a write must not proceed without it (recovery would have nothing to adjudicate). */
  private async recordIntent(args: Record<string, unknown>, t: TurnRecord, state: TurnPolicyState): Promise<boolean> {
    try { await this.d.persistence.ledger(t.turn, state.step, "intended", ledgerIntended(args)); return true; } catch { return false; }
  }

  private async recordApply(name: string, args: Record<string, unknown>, r: ToolResult, t: TurnRecord, state: TurnPolicyState, id: string): Promise<void> {
    const oplist = args.oplist;
    if (!r.ok) { await this.d.persistence.ledger(t.turn, state.step, "failed", { error: r.error }).catch(() => undefined); return; }
    if ((r.data as { applied?: boolean } | undefined)?.applied === false) { await this.d.persistence.ledger(t.turn, state.step, "failed", { refusal: (r.data as { refusal?: string }).refusal ?? null }).catch(() => undefined); return; }
    recordAppliedSeeds(state, oplist);
    this.turnBudget?.addApply(); this.planBudget?.addApply();
    const data = (r.data ?? {}) as { counts?: { added?: number; deleted?: number; wires?: number }; net_diff?: unknown; run_id?: string; expanded_sha256?: string };
    const c = (data.counts ?? {}) as Record<string, number | undefined>;
    // The engine counts a power port / PWR_FLAG as a component (`components_added`), but the envelope
    // does not (hooks.ts `ADD_COMPONENT_COUNT`, Rust `check_envelope`): a net anchor is not a part.
    // `per_op[].created` says which of them were power ports, so the footer can report them apart.
    const perOp = ((data as { per_op?: { created?: CreatedObject[]; changed?: ChangedField[]; warnings?: string[] }[] }).per_op ?? []);
    const created = perOp.flatMap((p) => p.created ?? []);
    // What the op-list replaced on parts that already existed (`set_component_parameters`): the
    // engine reports the before value, so the footer can say "R1 Value 1k -> 2k2" instead of a count.
    const changed = perOp.flatMap((p) => p.changed ?? []);
    // What the engine did differently from what the op-list authored (a nudged placement, a route
    // drawn across a foreign pin). Nothing read these before, so an unintended connection was
    // reported only inside a tool result the human never sees.
    const warnings = applyWarnings(perOp, String(args.target ?? ""));
    const powerPorts = created.filter((x) => x.kind === "power_port").length;
    // Parts this apply moved or re-posed: the engine reports each as a `changed` pose (`field: "at"`),
    // so a "move the block" turn no longer summarises as zeros.
    const moved = new Set(changed.filter((x) => x.field === "at").map((x) => x.reference)).size;
    const counts = { added: Math.max(0, (c.added ?? c.components_added ?? 0) - powerPorts), deleted: c.deleted ?? c.components_deleted ?? 0, wires: c.wires ?? c.wires_added ?? 0, power_ports: powerPorts, moved };
    this.writeSeq += 1;
    // The turn summary lists every file the engine wrote, not only the target: an op can reach
    // further than its own routing (a global rename_net, a sheet pin seeded in a child sheet).
    const written = ((data as { targets?: { path?: unknown }[] }).targets ?? []).map((x) => String(x.path ?? "")).filter(Boolean);
    t.applies.push({ run_id: data.run_id ?? r.meta.run_id ?? id, target: String(args.target), targets: written, expanded_sha256: data.expanded_sha256 ?? null, net_diff: data.net_diff, counts, ...(created.length ? { created } : {}), ...(changed.length ? { changed } : {}), ...(warnings.length ? { warnings } : {}) });
    await this.d.persistence.ledger(t.turn, state.step, "applied", ledgerApplied(data, data.run_id ?? r.meta.run_id)).catch(() => undefined);
    await this.d.persistence.journal({ kind: name, turn: t.turn, step: state.step, run_id: data.run_id, note: `turn ${t.turn}: ${t.message.slice(0, 80)}` }).catch(() => undefined);
    // The txn is committed and bookkept: `done` closes the step (a crash after this point leaves nothing to adjudicate).
    await this.d.persistence.ledger(t.turn, state.step, "done", { run_id: data.run_id ?? r.meta.run_id }).catch(() => undefined);
    this.expectedMerges = [];
    this.planDenied = null;
    this.d.emit({ kind: "applied", turn: t.turn, run_id: data.run_id ?? r.meta.run_id ?? id, target: String(args.target), counts, net_diff: data.net_diff, focus: extractFocus(data as { focus?: unknown }), created, changed });
    this.reportApplyWarnings(t, warnings, data.run_id ?? r.meta.run_id ?? id);
  }

  /**
   * Engine warnings of one apply, on their way to the human: one compact line in the stream (the
   * codes and how many of each), the full list on the turn summary, and a findings row for the two
   * codes that mean a wire may have joined something nobody asked to join. The rows are suggestions
   * (`origin: "advisory"`), never a verdict -- only `sch-check` / `sch-net` decide that (red line 6).
   */
  private reportApplyWarnings(t: TurnRecord, warnings: ApplyWarning[], runId: string): void {
    if (!warnings.length) return;
    this.d.emit({ kind: "system", text_key: "system.apply_warnings", params: { n: warnings.length, codes: warningTally(warnings) }, severity: "warning" });
    const rows = connectionFindings(warnings, runId);
    if (!rows.length) return;
    this.pushFindings(t, rows);
    this.d.emit({ kind: "findings", turn: t.turn, findings: rows });
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  private async beforeHook(c: BeforeToolCallContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<{ block: boolean; reason?: string } | undefined> {
    const siblings = c.assistantMessage.content.filter((x) => x.type === "toolCall").map((x) => ({ name: (x as { name: string }).name }));
    const index = c.assistantMessage.content.filter((x) => x.type === "toolCall").findIndex((x) => (x as { id: string }).id === c.toolCall.id);
    // The hooks judge the op-list dispatch will send, not the one the model typed: the registry normalises
    // it (sheet refs, alias op names) on the way in, and P2 used to refuse `sheet: "/"` as a scope widen
    // while the very same call would have been routed to the root file.
    const args = hookCallArgs((c.args ?? {}) as Record<string, unknown>, this.d.sheets());
    // checkpoint before first D (P8 is asserted after we create it)
    if (isDTier(c.toolCall.name) && !state.checkpointed && state.mode === "build" && state.kind === "instruction") {
      try { const cp = await call("checkpoint_create", { project_key: this.d.projectKey, turn: t.turn, kind: "turn" }); state.checkpointed = true; t.checkpoint = cp.turn; } catch (e) { return { block: true, reason: JSON.stringify(denyResult({ kind: "deny", policy_id: "P8", reason: `checkpoint failed: ${String(e)}` })) }; }
    }
    // Ask policy: change card before every apply
    if (this.effectivePolicy() === "ask" && (c.toolCall.name === "sch.apply" || c.toolCall.name === "sch.apply_waived")) {
      const insp = inspectOplist(args.oplist, []);
      const card = changeCard(t.turn, { tool: c.toolCall.name, target: args.target }, { authored: insp.ops.length, expanded: 0, added: insp.components_added, deleted: insp.components_deleted, wires: insp.wires_added }, this.lastPlanNotes, null);
      const r = await this.askCard(card, state, t);
      if (r.action_id !== "apply") return { block: true, reason: JSON.stringify({ is_error: true, policy_id: "ask", reason: `user chose ${r.action_id}` }) };
    }
    // pending P3/P11 deny from the last sch.plan blocks the apply unless unlocked
    if ((c.toolCall.name === "sch.apply") && this.planDenied) {
      return this.hardStop(this.boundDenied(), state, t, c.toolCall.name);
    }
    const { verdict, injections } = bus.before({ id: c.toolCall.id, name: c.toolCall.name, args, role: "lead", index, siblings });
    for (const inj of injections) { this.steering.push({ role: "user", content: [{ type: "text", text: `<policy_injection>${inj}</policy_injection>` }], meta: { turn: t.turn, task: t.task, kind: "injection" } }); await this.d.persistence.ledger(t.turn, state.step, "injected", { text: inj }).catch(() => undefined); }
    if (verdict.kind === "retry_with") return { block: true, reason: JSON.stringify({ is_error: true, policy_id: verdict.policy_id, reason: verdict.text, retry: true }) };
    if (verdict.kind === "deny") {
      void this.d.persistence.ledger(t.turn, state.step, "denied", { tool: c.toolCall.name, policy_id: verdict.policy_id, reason: verdict.reason.slice(0, 500), hard_stop: verdict.hard_stop ?? null, path: "model" }).catch(() => undefined);
      if (verdict.hard_stop) {
        const narrow = verdict.policy_id === "P2" ? selfNarrowedDeny(state, { id: c.toolCall.id, name: c.toolCall.name, args, role: "lead", index, siblings }) : null;
        if (narrow) return this.tooNarrow(verdict, narrow, state, t, c.toolCall.name);
        return this.hardStop(verdict, state, t, c.toolCall.name);
      }
      // A refused call the model must fix itself is still worth one visible line to the engineer.
      this.d.emit({ kind: "system", text_key: "system.tool_denied", params: { tool: c.toolCall.name, reason: verdict.reason.slice(0, 160) }, severity: "info" });
      return { block: true, reason: JSON.stringify(denyResult(verdict)) };
    }
    return undefined;
  }

  /**
   * A P2 refusal the *ceiling* would not have raised: the model's own `turn.begin` was narrower than the
   * bound the human set (an approved plan step, or the session ceiling Rust froze). Red line 13 puts the
   * human's decision in that bound; what the model declared inside it is the model's bookkeeping, so
   * asking the engineer to approve `route_net` on a ceiling whose `allowed_ops` is unrestricted asks them
   * to decide something they already decided. No card here:
   *
   * - Auto never asks, so the turn envelope is widened to the ceiling for exactly what this call needed
   *   and re-declared in Rust (which re-checks it against its own ceiling); the call then proceeds.
   * - Ask / Review get a tool error naming the ops to add, and the model re-declares `turn.begin` itself
   *   (the redeclare path) before retrying. A card is still raised for anything outside the ceiling,
   *   because that is a real widening — `selfNarrowedDeny` returns null for it.
   */
  private async tooNarrow(v: Extract<HookVerdict, { kind: "deny" }>, narrow: { problems: string[]; missing_ops: string[] }, state: TurnPolicyState, t: TurnRecord, tool: string): Promise<{ block: boolean; reason?: string } | undefined> {
    const ceiling = state.ceiling;
    const env = state.envelope;
    const detail = narrow.missing_ops.length ? narrow.missing_ops.join(", ") : narrow.problems.join("; ");
    this.d.emit({ kind: "system", text_key: "system.turn_scope_narrow", params: { tool, detail }, severity: "info" });
    if (this.effectivePolicy() === "auto" && ceiling && env && state.kind) {
      const widened: Envelope = {
        ...env,
        allowed_ops: [...new Set([...env.allowed_ops, ...narrow.missing_ops])],
        sheets: [...new Set([...env.sheets, ...ceiling.sheets])],
        structural: [...new Set([...env.structural, ...ceiling.structural])],
        nets_renamable: [...new Set([...env.nets_renamable, ...ceiling.nets_renamable])],
        components_added_max: Math.max(env.components_added_max, ceiling.components_added_max),
        components_deleted_max: Math.max(env.components_deleted_max, ceiling.components_deleted_max),
        wires_max: ceiling.wires_max === null ? null : Math.max(env.wires_max ?? 0, ceiling.wires_max),
      };
      try {
        const info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: state.kind, headline: t.headline, plan_step: t.plan_step, envelope: widened, inherit_from_turn: null, mode: this.mode, redeclare: true } });
        state.envelope = info.effective_envelope; t.envelope = info.effective_envelope;
        t.auto_decisions.push({ step: state.step, condition: "scope_widen", action: "skipped", detail: `turn envelope widened to the ceiling: ${detail}` } as AutoDecision);
        return undefined; // the same call proceeds inside the ceiling
      } catch { /* Rust refused the redeclare: fall through to the tool error below */ }
    }
    return { block: true, reason: JSON.stringify({
      is_error: true,
      code: "TURN_ENVELOPE_TOO_NARROW",
      policy_id: v.policy_id,
      reason: v.reason,
      remediation: narrow.missing_ops.length
        ? `your turn.begin declaration did not list ${narrow.missing_ops.join(", ")}, but this turn's ceiling allows ${narrow.missing_ops.length === 1 ? "it" : "them"}. Call turn.begin again with the same headline and the same envelope plus ${narrow.missing_ops.join(", ")} in allowed_ops, then retry this call unchanged.`
        : "your turn.begin declaration is narrower than this turn's ceiling. Call turn.begin again with an envelope that covers this op-list (the ceiling allows it), then retry this call unchanged.",
      ceiling: ceiling ? { sheets: ceiling.sheets, allowed_ops: ceiling.allowed_ops.length ? ceiling.allowed_ops : "unrestricted", components_added_max: ceiling.components_added_max, structural: ceiling.structural } : null,
    }) };
  }

  /** Hard stop: card (or Auto adjudication). Approval unlocks exactly this call once. */
  private async hardStop(v: Extract<HookVerdict, { kind: "deny" }>, state: TurnPolicyState, t: TurnRecord, tool: string): Promise<{ block: boolean; reason?: string } | undefined> {
    const condition = v.hard_stop ?? "scope_widen";
    if (this.zombie(t)) return { block: true, reason: JSON.stringify(denyResult(v)) };
    // Rust consumes a "scope" grant on turn_begin redeclare, which is how a structural / scope approval is honoured.
    const grantKind = condition === "net_risk" ? "net_risk" : condition === "interface" ? "interface" : condition === "unresolved" ? "unresolved" : "scope";
    if (this.effectivePolicy() === "auto") {
      const cond: HardStopCondition = condition === "net_risk" ? "net_risk_b" : (condition as HardStopCondition);
      const dec = adjudicate({ condition: cond, step: state.step, mode: this.mode, retried: true });
      if (dec && dec.action !== "stop") {
        t.auto_decisions.push(dec);
        // Only a step that has not applied anything yet is "skipped"; a denied tidy-up apply after the main apply
        // leaves the step done. s0 = no plan step (model turn): nothing to mark.
        if (state.step !== "s0" && t.applies.length === 0) this.planStepsSkipped.add(state.step);
        const pause = this.autoTracker?.record(dec) ?? false;
        // Auto stays Auto (author's decision): only report the accumulated skips; the human can switch policy themselves.
        if (pause && !this.autoSkipsWarned.has(t.turn)) { this.autoSkipsWarned.add(t.turn); this.d.emit({ kind: "system", text_key: "system.auto_skips", params: { decisions: this.autoTracker?.skipped ?? t.auto_decisions.length }, severity: "warning" }); }
        return { block: true, reason: JSON.stringify({ ...denyResult(v), auto: dec.action }) };
      }
    }
    if (this.pendingHardStop) return { block: true, reason: JSON.stringify(denyResult(v)) };
    // OQ-17: the human ticked "don't ask again for this condition" in this session (never budget/environment stops).
    if (REMEMBERABLE.has(condition) && isRemembered(this.d.sessionId, condition)) {
      t.auto_decisions.push({ condition: condition as AutoDecision["condition"], action: "remembered", detail: "remembered_in_session", step: state.step });
      return undefined;
    }
    // A P2 (envelope) card asks the human to widen the turn to one specific envelope; build it now so
    // the card, the consent event and the grant all carry that envelope's canonical sha. Rust refuses
    // a scope grant that names anything else, so an unspent approval cannot be reused for a second,
    // different widening later in the same turn.
    const p2Widened = v.policy_id === "P2" && (condition === "scope_widen" || condition === "structural") && state.envelope && state.kind
      ? { env: widenEnvelope(state.envelope, v.card_payload ?? {}), kind: state.kind }
      : null;
    const card = hardStopCard(t.turn, condition, { tool, reason: v.reason, ...(v.card_payload ?? {}) }, undefined, grantKind, p2Widened ? envelopeSha(p2Widened.env) : undefined);
    this.pendingHardStop = { card, condition };
    t.status = "hard_stopped";
    const r = await this.askCard(card, state, t);
    this.pendingHardStop = null;
    t.status = "running";
    if (r.action_id === "approve" && r.grant) {
      const bindSha = (card.data as { payload_sha256: string }).payload_sha256;
      // A `scope` grant is takeable only under the payload it was issued for: keying it on the
      // condition class as well left an unspent approval standing for any other scope action in the
      // turn. The classes stay for the grants Rust binds by their own payload (`net_risk`).
      if (grantKind !== "scope") this.unlocked.set(grantKind, r.grant);
      this.unlocked.set(bindSha, r.grant);
      if (r.free_text?.trim()) this.grantReasons.set(r.grant, r.free_text.trim());
      this.planDenied = null;
      state.unlocked.set(grantKind, r.grant);
      // A P2 (envelope) approval is honoured the same way as a widened turn.begin: redeclare the turn in
      // Rust with the widened envelope and the scope grant, otherwise Rust's own envelope check refuses the
      // very call the human just approved and a second card appears.
      if (p2Widened) {
        try {
          const info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: p2Widened.kind, headline: t.headline, plan_step: t.plan_step, envelope: p2Widened.env, inherit_from_turn: null, mode: this.mode, grant: r.grant, redeclare: true } });
          state.envelope = info.effective_envelope; t.envelope = info.effective_envelope;
          this.takeGrant(bindSha); // the redeclare consumed it
        } catch (e) {
          const f = e instanceof IpcFailure ? e.error : { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" };
          return { block: true, reason: JSON.stringify({ ...denyResult(v), user: "approve", redeclare_failed: `${f.code}: ${f.message}` }) };
        }
      }
      // Approved: the very same call proceeds; for net_risk the registry applies it waived with this grant.
      return undefined;
    }
    if (r.action_id === "abandon") { this.stopRequested = true; t.status = "abandoned"; this.abort?.abort(); }
    return { block: true, reason: JSON.stringify({ ...denyResult(v), user: r.action_id, modified_instruction: r.free_text }) };
  }

  private async afterHook(c: AfterToolCallContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord, ctx: ToolContext): Promise<{ content?: { type: "text"; text: string }[]; isError?: boolean } | undefined> {
    const name = c.toolCall.name;
    const text = c.result.content.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("");
    const ok = !c.isError;
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    const after = bus.after({ name, args: (c.args ?? {}) as Record<string, unknown>, ok, data }, text);
    let out = after.text;
    if (name === "sch.plan" && ok) {
      if (after.p3) { this.expectedMerges = after.p3.expected_merges; this.lastPlanNotes = after.p3.notes ?? []; }
      if (after.verdict.kind === "deny") {
        this.planDenied = { verdict: after.verdict, expected: after.p3?.expected_merges ?? [], ops_sha256: this.lastPlanOpsSha };
        out += `\n${JSON.stringify({ policy_id: after.verdict.policy_id, reason: after.verdict.reason, hard_stop: after.verdict.hard_stop })}`;
      } else if (after.p3?.notes.length) out += `\n${JSON.stringify({ expected_merges: after.p3.expected_merges, notes: after.p3.notes })}`;
    }
    // P4: integrity ERROR → Fixer
    if (ok && (name === "sch.plan" || name.startsWith("check.") || name === "gate.run")) {
      const findings = extractFindings(data);
      // Review / question turns: what the Lead checked is what the findings panel shows.
      if (name !== "sch.plan") { this.pushFindings(t, findings); if (name === "gate.run") this.noteGate(findings); this.d.emit({ kind: "findings", turn: t.turn, findings, full: name === "gate.run" }); }
      const phase = name === "sch.plan" ? "pre_apply" : "post_apply";
      const dec = p4(state, findings, phase, fixerDispatchable);
      if (dec.kind === "fix") {
        const fixable = dec.findings.filter((f) => fixerDispatchable(f.code) && (FIXER_MAP[f.code]?.phases.includes(phase) ?? false));
        if (fixable.length && phase === "pre_apply" && (c.args as { oplist?: unknown })?.oplist) {
          recordFixAttempt(state, phase, dec.findings);
          const rep = await this.runFixer((c.args as { oplist: unknown }).oplist, fixable, String((c.args as { target?: string }).target ?? ""), phase, t, ctx);
          if (rep) out += `\n${JSON.stringify({ fixer_replacement: rep, note: "the Fixer produced a replacement op-list; re-run sch.plan with it" })}`;
          else out += `\n${JSON.stringify({ fixer: "failed", note: "fix it yourself or stop" })}`;
        } else if (fixable.length === 0 && dec.findings.some((f) => FIXER_MAP[f.code]?.who === "librarian")) {
          out += `\n${JSON.stringify({ hint: "unresolved symbols: dispatch the librarian to find alternatives; changing parts is a hard stop" })}`;
        } else if (fixable.length === 0 && dec.findings.some((f) => FIXER_MAP[f.code]?.who === "lead")) {
          out += `\n${JSON.stringify({ hint: "designator conflict: re-allocate leases and re-dispatch the drafter (P5)" })}`;
        } else {
          recordFixAttempt(state, phase, dec.findings);
          out += `\n${JSON.stringify({ hint: "fix the ERROR findings and re-run sch.plan (attempt " + dec.attempt + "/2)" })}`;
        }
      } else if (dec.kind === "hard_stop") {
        const r = await this.hardStop({ kind: "deny", policy_id: "P4", reason: dec.reason, hard_stop: "unresolved", card_payload: { findings: dec.findings.map((f) => ({ code: f.code, location: f.location })) } }, state, t, name);
        if (r?.block) out += `\n${r.reason ?? ""}`;
      }
      if (name === "sch.plan" && findings.length) { this.pushFindings(t, findings); this.d.emit({ kind: "findings", turn: t.turn, findings }); }
    }
    return { content: [{ type: "text", text: out }] };
  }

  // ---------------------------------------------------------------------------
  // Subagents
  // ---------------------------------------------------------------------------

  /** Tool lines still running, by tool-call id: completion keeps their start time and args summary. */
  private openLines = new Map<string, ActivityLine>();
  /** Thinking / streaming progress lines: chars received so far and the last emit time (throttled). */
  private progressLines = new Map<string, { chars: number; started_at: string; last: number; role: Role; parent_id?: string }>();
  /** Child tool calls seen per subagent line (capped so a chatty drafter does not flood the stream). */
  private subChildren = new Map<string, number>();

  /** Accumulate streamed characters into a throttled "thinking" activity line (no text is shown, only ~tokens). */
  private progress(t: TurnRecord, role: Role, id: string, chars: number, parent_id?: string): void {
    const now = Date.now();
    const p = this.progressLines.get(id) ?? { chars: 0, started_at: nowIso(), last: 0, role, parent_id };
    p.chars += chars;
    this.progressLines.set(id, p);
    if (now - p.last < 250) return;
    p.last = now;
    this.d.emit({ kind: "activity", turn: t.turn, line: { id, role, phase: "thinking", label: "thinking", started_at: p.started_at, kind: "thinking", tokens: Math.round(p.chars / 4), parent_id } });
  }
  private endProgress(t: TurnRecord, id: string, ok = true): void {
    const p = this.progressLines.get(id);
    if (!p) return;
    this.progressLines.delete(id);
    this.d.emit({ kind: "activity", turn: t.turn, line: { id, role: p.role, phase: "thinking", label: "thinking", started_at: p.started_at, ended_at: nowIso(), ok, kind: "thinking", tokens: Math.round(p.chars / 4), parent_id: p.parent_id } });
  }

  /** Subagent stream → nested activity lines under the subagent's own line. */
  private subagentEvent(e: import("./pi-adapter").AgentEvent, role: Role, parentId: string, t: TurnRecord): void {
    const thinkId = `${parentId}:think`;
    if (e.type === "message_update" && (e.assistantMessageEvent.type === "thinking_delta" || e.assistantMessageEvent.type === "text_delta")) {
      this.progress(t, role, thinkId, e.assistantMessageEvent.delta.length, parentId);
      return;
    }
    if (e.type === "message_end") { this.endProgress(t, thinkId); return; }
    if (e.type === "tool_execution_start") {
      const n = (this.subChildren.get(parentId) ?? 0) + 1;
      this.subChildren.set(parentId, n);
      if (n > SUBAGENT_CHILD_LINES_MAX) {
        if (n === SUBAGENT_CHILD_LINES_MAX + 1) this.d.emit({ kind: "activity", turn: t.turn, line: { id: `${parentId}:more`, role, phase: "exploring", label: "…", detail: "more calls not listed", started_at: nowIso(), ended_at: nowIso(), ok: true, kind: "tool", parent_id: parentId } });
        return;
      }
      const toolName = decodeToolName(e.toolName);
      const def = toolDef(toolName);
      const att = attentionOf(toolName, (e.args ?? {}) as Record<string, unknown>);
      if (att) this.d.emit({ kind: "attention", turn: t.turn, role, label: att.label, refs: att.refs, region_mil: att.region_mil });
      const line: ActivityLine = { id: `${parentId}:${e.toolCallId}`, role, phase: (def?.phase ?? "exploring") as Phase, label: toolName, detail: argsSummary(e.args), started_at: nowIso(), kind: "tool", parent_id: parentId };
      this.openLines.set(line.id, line);
      this.d.emit({ kind: "activity", turn: t.turn, line });
      return;
    }
    if (e.type === "tool_execution_end") {
      const id = `${parentId}:${e.toolCallId}`;
      const open = this.openLines.get(id);
      if (!open) return;
      this.openLines.delete(id);
      const resText = typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? null);
      this.d.emit({ kind: "activity", turn: t.turn, line: { ...open, ended_at: nowIso(), ok: !e.isError, bytes: resText.length } });
    }
  }

  private sem = new Semaphore(TOOL_PARALLEL_MAX_DEFAULT);
  private leaderStarted: { promise: Promise<void>; resolve: () => void } | null = null;
  private roleSems = new Map<Role, Semaphore>();
  /** `nets` read at the start of a wiring step, reused by executeStep (one engine round-trip instead of two). */
  private wiringNets: { step: string; result: ToolResult } | null = null;
  /** Consecutive plan steps skipped for the identical reason; two in a row pause the plan. */
  private repeatedSkip: { reason: string; count: number } | null = null;

  private drafterConcurrency(): number {
    if (this.rateLimited) return 1;
    const p = this.providerCfg;
    const s = this.d.settings().advanced.drafter_concurrency;
    if (p && (p.build_capable === "degraded" || /localhost|127\.0\.0\.1/.test(p.base_url))) return Math.min(s || DRAFTER_CONCURRENCY_DEGRADED, DRAFTER_CONCURRENCY_DEGRADED);
    return s || DRAFTER_CONCURRENCY_DEFAULT;
  }

  private subagentBinding(role: Role, state: TurnPolicyState, t: TurnRecord, bus: HookBus, dryruns: DryrunState = { count: 0, lastSha: null, accepted: new Set<string>() }): (def: ToolDef) => ToolBinding {
    const ctx = this.toolContext(state, t, role);
    return (def) => ({
      name: def.name, description: def.description, parameters: def.parameters, parallel: def.parallel === "safe",
      execute: async (_id, args) => {
        this.turnBudget?.addToolCall(); this.planBudget?.addToolCall();
        if (def.name === "sch.dryrun_scratch") {
          const stop = dryrunCutoff(dryruns, args.oplist);
          if (stop) return { text: JSON.stringify(stop), isError: true };
        }
        const { verdict } = bus.before({ id: _id, name: def.name, args, role, index: 0, siblings: [{ name: def.name }] });
        if (verdict.kind === "deny") return { text: JSON.stringify(denyResult(verdict)), isError: true };
        const r = await executeTool(def, args, ctx);
        const text = resultText(r, capFor(def.name));
        let wrapped = bus.after({ name: def.name, args, ok: r.ok, data: r.data }, text).text;
        // A dry run that passed is the op-list's receipt: the digest goes back with the result and the
        // final answer has to match one of them (F4 — a Drafter dry-ran with sheet "ldo_board" and then
        // answered with "power", and only sch.apply found out).
        if (def.name === "sch.dryrun_scratch" && r.ok && (r.data as { ok?: boolean } | null)?.ok !== false) {
          const digest = oplistDigest(args.oplist);
          dryruns.accepted.add(digest);
          wrapped += `\n${JSON.stringify({ oplist_sha256: digest, note: "answer with exactly this op-list; a final op-list that matches no accepted dry run is rejected" })}`;
        }
        // Advisory envelope check (F2): the binding check is at sch.apply, which is two model rounds too late.
        if (def.name === "ops.validate" || def.name === "sch.dryrun_scratch") {
          const warnings = envelopeAdvisory(state.envelope, args.oplist, String(args.target ?? ""), this.rails());
          if (warnings.length) wrapped += `\n${JSON.stringify({ envelope_warnings: warnings, note: "advisory: sch.apply enforces this and will refuse the op-list as it stands" })}`;
          // Drawing advice, never a refusal: the op-list is legal, it just reads badly (red line 6).
          const style = oplistWarnings(args.oplist);
          if (style.length) wrapped += `\n${JSON.stringify({ drawing_warnings: style, note: "advisory: the op-list applies as it stands; redraw it this way only if you agree" })}`;
        }
        return { text: wrapped, isError: !r.ok, images: r.images?.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) };
      },
    });
  }

  private async dispatch(args: Record<string, unknown>, t: TurnRecord, signal?: AbortSignal): Promise<ToolResult> {
    if (this.stopping) return this.stoppedResult();
    if (typeof args.brief === "string") {
      const langName = ({ "zh-Hant": "Traditional Chinese (繁體中文)", "zh-Hans": "Simplified Chinese (简体中文)", ja: "Japanese (日本語)", en: "English" } as Record<string, string>)[this.turnLang] ?? this.turnLang;
      args = { ...args, brief: `${args.brief}\n\nLanguage: write every human-facing string (goal, summaries, constraints, acceptance.check, narrative, notes) in ${langName}; keep identifiers, lib_ids, net names and JSON keys as they are.` };
    }
    if (args.role === "facts" && !(t.refs.some((r) => r.kind === "attachment") || (typeof args.brief === "string" && /sha256|attachment/i.test(args.brief)))) {
      return { ok: false, error: { code: "FACTS_NEEDS_SOURCE", message: "the Facts agent only extracts from a datasheet PDF held in the attachment store", remediation: "call parts.datasheet {lcsc or mpn} first (it downloads the vendor PDF and returns its sha256), then dispatch facts again with that sha256 in the brief; if the download is unavailable, continue with the library pin data, mark the facts as unaudited and keep going. Never ask the user to attach a file." }, meta: { bytes: 0 }, trust: "untrusted" };
    }
    const role = String(args.role) as Role;
    const state = this.policyState!;
    const attempt = typeof args.attempt === "number" ? args.attempt : 0;
    const rm = (attempt > 0 ? this.fallbackModel(role) : null) ?? this.roleModel(role);
    if (!rm) return { ok: false, error: { code: "PROVIDER_MISSING", message: `no model configured for ${role}` }, meta: { bytes: 0 }, trust: "untrusted" };
    // Escalated retry: one thinking level up (tools/system stay byte-identical, so the cache prefix survives).
    const baseLevel = this.d.settings().agent.thinking_level;
    const reasoning = attempt > 0 ? bumpThinking(baseLevel as ThinkingLevel) : (baseLevel === "off" || !baseLevel ? undefined : (baseLevel as Exclude<ThinkingLevel, "off">));
    const spec = { architect: ARCHITECT, librarian: LIBRARIAN, drafter: DRAFTER, fixer: FIXER, reviewer: REVIEWER, sourcer: SOURCER, facts: FACTS }[role as "architect"];
    if (!spec) return { ok: false, error: { code: "ROLE_UNKNOWN", message: String(role) }, meta: { bytes: 0 }, trust: "untrusted" };
    const subState = newTurnPolicyState(t.turn, this.mode, this.effectivePolicy(), role, null);
    subState.began = true; subState.kind = "instruction"; subState.step = state.step; subState.envelope = state.envelope;
    subState.userText = state.userText; // "do not ask" binds the Architect's ask_user too (pNoAsk)
    const bus = new HookBus(() => ({ state: subState, rails: this.rails(), stepNets: this.stepNets() }));
    const model = buildModel({ provider: rm.provider, modelId: rm.model });
    const streamFn = makeStreamFn({ onUsage: (u, m, l) => this.onUsage(u, m, role, l ?? 0), onRetry: (_a, cls) => { if (cls === "rate_limit") this.rateLimited = true; }, role, cacheKey: this.cacheKey(role) });
    let brief = String(args.brief ?? "");
    let untrusted = "";
    if (role === "drafter" && args.block) {
      let block = this.plan?.blocks.find((b) => b.id === args.block) ?? { id: String(args.block), sheet: String(args.target ?? ""), summary: brief, parts: [], nets_in: [], nets_out: [], acceptance: [] };
      const env = state.envelope ?? sessionCeiling(SESSION_CEILING_COMPONENTS_ADDED_DEFAULT, this.d.sheets(), this.rails());
      block = { ...block, parts: block.parts.map((p) => { const q = { ...(p as unknown as Record<string, unknown>) }; delete q.refdes; delete q.ref; delete q.designator; delete q.reference; return q as unknown as typeof p; }) };
      const facts = await loadFactsForParts(block.parts as { mpn?: string; lcsc?: string; lib_id?: string }[], () => call("sidecar_read", { project_key: this.d.projectKey, kind: "facts" }));
      const target = String(args.target ?? block.sheet);
      // FR-611: on a reused sheet every op needs an instance_designators map; the concrete paths come
      // from the step's `sch.summary` (plan path) or from one lookup here (model-driven turns).
      const instance_paths = Array.isArray(args.instance_paths) ? (args.instance_paths as string[]) : await this.instancePathsFor(target);
      const b = drafterBrief({ facts, block, instance_paths, target, interfaces: this.plan ? sheetInterfaces(this.plan, target) : [], envelope: env, lease: (args.lease as { prefix: string; ranges: [number, number][] }[]) ?? [], region_mil: (args.region_mil as [[number, number], [number, number]]) ?? [[0, 0], [4000, 3000]], group: String(args.group ?? block.id), origin_mil: (args.origin_mil as [number, number]) ?? [1000, 1000], rails: this.rails(), conventions: this.plan?.conventions?.length ? this.plan.conventions : DEFAULT_CONVENTIONS(this.rails()), summary: "", instruction: brief });
      brief = b.brief; untrusted = b.untrusted;
      subState.leases = (args.lease as { prefix: string; ranges: [number, number][] }[]) ?? [];
    }
    // The hint goes on `brief` — what `runSubagent` is handed below; `args.brief` is only the input.
    if (role === "drafter" && /^wire nets/.test(String(args.brief ?? ""))) {
      brief = `${brief}\nThis is a wiring step: absolute coordinates are fine; if you add no groups, return {"groups":{"wiring":{"origin_mil":[0,0]}},"ops":[...],"refdes_used":[]}.`;
    }
    if (role === "architect") {
      const ceiling = this.d.settings().agent.session_ceiling_components_added || SESSION_CEILING_COMPONENTS_ADDED_DEFAULT;
      const b = architectBrief(String(args.brief ?? ""), this.plan?.constraints ?? [], typeof args.summary === "string" ? args.summary : "", "", { components_added: ceiling });
      brief = `${b.brief}\nSchema: ${PLAN_SCHEMA_HINT}`; untrusted = b.untrusted;
    }
    if (role === "reviewer") {
      const b = reviewerBrief(String(args.scope ?? args.brief ?? "the whole schematic"), typeof args.summary === "string" ? args.summary : "", this.plan ? planSnapshotText(this.plan) : null);
      brief = args.brief && String(args.brief) !== String(args.scope ?? "") ? `${b.brief}\nContext: ${String(args.brief)}` : b.brief; untrusted = b.untrusted;
    }
    if (role === "fixer") {
      // `args.oplist` used to gate this whole branch, and `{"ops":[]}` is truthy: a post-apply repair
      // arrived as a bare "fix N findings" line whenever the caller had no op-list at all.
      const b = fixerBrief(args.oplist ?? null, (args.findings as Finding[]) ?? [], String(args.target ?? ""), args.phase === "post_apply" ? "post_apply" : "pre_apply", Array.isArray(args.sections) ? (args.sections as string[]) : [], typeof args.summary === "string" ? args.summary : "");
      brief = b.brief; untrusted = b.untrusted;
    }
    const conc = role === "drafter" ? this.drafterConcurrency() : 1;
    // One semaphore per role for the whole loop (a per-dispatch semaphore limits nothing).
    let roleSem = this.roleSems.get(role);
    if (!roleSem || roleSem.limit !== conc) { roleSem = new Semaphore(conc); this.roleSems.set(role, roleSem); }
    const release = await roleSem.acquire();
    // parallel drafters: wait for the first to start streaming (cache rule)
    let waitForLeader: Promise<void> | undefined;
    let onFirstToken: (() => void) | undefined;
    if (role === "drafter") {
      if (!this.leaderStarted) { let resolve = () => undefined as void; const promise = new Promise<void>((r) => { resolve = r; }); this.leaderStarted = { promise, resolve }; onFirstToken = () => this.leaderStarted?.resolve(); }
      else waitForLeader = this.leaderStarted.promise;
    }
    const line: ActivityLine = { id: localId("sub"), role, phase: (role === "fixer" ? "building" : role === "reviewer" ? "reviewing" : role === "drafter" ? "building" : "designing") as Phase, label: `${role}`, detail: brief.slice(0, 80), started_at: nowIso(), kind: "subagent" };
    this.d.emit({ kind: "activity", turn: t.turn, line });
    const ac = new AbortController();
    signal?.addEventListener("abort", () => ac.abort(), { once: true });
    this.abort?.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const planBefore = this.plan ? { id: this.plan.id, version: this.plan.version } : null;
    try {
      // One dry-run ledger per dispatch, shared by the tool binding (which records the digests a dry run
      // accepted) and the output validator (which requires the final op-list to be one of them).
      const dryruns: DryrunState = { count: 0, lastSha: null, accepted: new Set<string>() };
      const validate = role === "drafter" ? (v: unknown) => [...spec.validate(v), ...dryRunContract(dryruns, v)] : spec.validate;
      const out = await runSubagent<unknown>({ role, mode: this.mode, model, streamFn, brief, untrusted, reasoning, bind: this.subagentBinding(role, subState, t, bus, dryruns), sem: this.sem, signal: ac.signal, waitForLeader, onFirstToken, vision: rm.provider.vision,
        onEvent: (e) => this.subagentEvent(e, role, line.id, t),
        before: async (name, a, siblings, id) => { const v = bus.before({ id, name, args: a, role, index: 0, siblings }); return v.verdict.kind === "deny" ? { block: true, reason: JSON.stringify(denyResult(v.verdict)) } : undefined; } }, spec.tools, validate);
      // Keep the full subagent transcript in the project sidecar (.fluxsmith/turns/<n>/subagents/) for debugging.
      void call("sidecar_write", { project_key: this.d.projectKey, write: { kind: "subagent", turn: t.turn, role, id: line.id.replace(/[^A-Za-z0-9_-]/g, "_"), transcript: { brief, untrusted: untrusted.slice(0, 20000), ok: out.ok, error: out.error ?? null, raw: out.raw, narrative: out.narrative, messages: out.messages } } }).catch(() => undefined);
      // Advisory roles (sourcer, librarian, reviewer, explainer, facts) may answer in prose: the text is the deliverable.
      if (!out.ok && /no JSON object/.test(out.error ?? "") && !["drafter", "fixer", "architect"].includes(role) && out.raw.trim()) {
        this.d.emit({ kind: "activity", turn: t.turn, line: { ...line, ended_at: nowIso(), ok: true } });
        return { ok: true, data: { role, output: null, narrative: out.raw.slice(0, 6000), note: "the subagent answered in prose" }, meta: { bytes: 0 }, trust: "untrusted" };
      }
      // An Architect that wrote its plan through plan.write and then answered in prose did its job:
      // the plan (not the final text) is the deliverable.
      if (!out.ok && role === "architect" && this.plan && (this.plan.id !== planBefore?.id || this.plan.version !== planBefore?.version || !planBefore)) {
        this.d.emit({ kind: "activity", turn: t.turn, line: { ...line, ended_at: nowIso(), ok: true } });
        return { ok: true, data: { role, output: this.plan, narrative: out.raw.slice(0, 2000), note: "plan written via plan.write; the plan card is shown to the human" }, meta: { bytes: 0 }, trust: "untrusted" };
      }
      this.d.emit({ kind: "activity", turn: t.turn, line: { ...line, ended_at: nowIso(), ok: out.ok } });
      if (!out.ok) return { ok: false, error: { code: "SUBAGENT_FAILED", message: out.error ?? "unknown", evidence: out.raw.slice(0, 2000) }, meta: { bytes: 0 }, trust: "untrusted" };
      const parsed = out.parsed as { ops?: unknown[]; groups?: Record<string, unknown> } | null;
      // Drafters return `{groups, ops}`; hand the lead a complete OpList so it never re-assembles one without the groups.
      const oplist = parsed && Array.isArray(parsed.ops) ? { protocol_version: 1, groups: parsed.groups ?? {}, ops: parsed.ops } : undefined;
      return { ok: true, data: { role, output: out.parsed, ...(oplist ? { oplist } : {}), narrative: out.narrative.slice(0, 2000) }, meta: { bytes: 0 }, trust: "untrusted" };
    } finally {
      release();
      if (role === "drafter") { this.leaderStarted?.resolve(); this.leaderStarted = null; }
    }
  }

  private async runFixer(oplist: unknown, findings: Finding[], target: string, phase: "pre_apply" | "post_apply", t: TurnRecord, _ctx: ToolContext): Promise<unknown | null> {
    const hasOps = Array.isArray((oplist as { ops?: unknown[] } | null)?.ops) && ((oplist as { ops: unknown[] }).ops.length > 0);
    const dispatchable = fixerDispatch(findings, phase, hasOps);
    if (!dispatchable) {
      // Refused, not silently dispatched: a pre-apply Fixer with an empty op-list has nothing to
      // rewrite, and findings no Fixer may repair are the human's or the Librarian's.
      this.d.emit({ kind: "status", turn: t.turn, text: `fixer skipped: ${findings.map((f) => f.code).join(", ").slice(0, 120)} cannot be repaired ${hasOps ? "in this phase" : "without an op-list"}` });
      return null;
    }
    findings = dispatchable.findings;
    phase = dispatchable.phase;
    const sections = [...new Set(findings.map((f) => FIXER_MAP[f.code]?.section).filter((s): s is string => !!s))];
    const line = { id: localId("fix"), role: "fixer" as Role, phase: "building" as Phase, label: "fixer", detail: findings.map((f) => f.code).join(","), started_at: nowIso() };
    this.d.emit({ kind: "activity", turn: t.turn, line });
    // A post-apply repair is about what is on the sheet now, so it is briefed with the sheet's own
    // state (the engine's summary) instead of an op-list that has already been applied.
    const summary = phase === "post_apply" ? await this.summaryText(target || null).catch(() => "") : "";
    const r = await this.dispatch({ role: "fixer", brief: `fix ${findings.length} findings`, oplist, findings, target, phase, sections, summary }, t);
    this.d.emit({ kind: "activity", turn: t.turn, line: { ...line, ended_at: nowIso(), ok: r.ok } });
    if (!r.ok) return null;
    const out = (r.data as { output: unknown }).output;
    // "Nothing I can repair with the ops I am allowed" is a valid answer; applying it is not.
    if (Array.isArray((out as { ops?: unknown[] } | null)?.ops) && !(out as { ops: unknown[] }).ops.length) return null;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Harness-driven plan step (continuous execution)
  // ---------------------------------------------------------------------------

  private async runPlanStepTurn(t: TurnRecord, step: PlanStep, started: number): Promise<void> {
    const state = this.policyState!;
    const plan = this.plan!;
    this.autoTracker ??= new AutoSkipTracker(plan.steps.length);
    state.step = step.id;
    t.plan_step = step.id;
    const budgetHit = this.d.settings().agent.budget_enabled ? ((this.planBudget?.exhausted() ?? null)) : null;
    if (budgetHit) { state.budgetExhausted = budgetHit; const card = hardStopCard(t.turn, "budget", { exhausted: budgetHit, limit: this.planBudget?.limits, used: this.planBudget?.used }, undefined, "scope"); card.actions = card.actions.filter((a) => a.id !== "approve"); await this.askCard(card, state, t); t.status = "stopped"; t.stop_reason = "budget"; if (this.plan) this.plan.display.status = "paused"; this.finishTurn(t, started); this.persistProgress(); return; }
    const env = stepEnvelope(plan, step);
    env.structural = Array.from(new Set([...env.structural, ...planStructural(plan, this.d.sheets())]));
    if (step.kind === "wiring") {
      // The wiring step may rename the labels the blocks left unmatched (single-member nets) — but
      // only the ones on its own sheet: a local label names a net inside its sheet, so a same-named
      // label on another sheet is a different net that this step has no business renaming.
      const stepSheet = env.sheets.length === 1 ? env.sheets[0] : null;
      const nr = await this.engineDirect({ kind: "nets", sheet: stepSheet, limit: 2000 }).catch(() => null);
      this.wiringNets = nr ? { step: step.id, result: nr } : null;
      const nets = ((nr?.ok ? (nr.data as { nets?: { name: string; members?: unknown[]; named?: boolean }[] }).nets : []) ?? []);
      env.nets_renamable = Array.from(new Set([...env.nets_renamable, ...nets.filter((n) => netMemberCount(n) <= 1).flatMap((n) => [n.name, n.name.replace(/^\//, ""), bareNetName(n.name)])]));
      // Cross-block connections are labels, never wires: wires between blocks are the clutter the
      // user complained about. The wiring step therefore gets no add_wire / route_net at all.
      // The three layout ops are for the harness's own stylist pass after the wiring (it re-lays and
      // rotates inside the plan's block regions and adds nothing); the brief still tells the model not
      // to move parts.
      env.allowed_ops = Array.from(new Set([...(env.allowed_ops.length ? env.allowed_ops : DRAFT_OPS), "rename_net", "add_no_connect", "place_pwr_flag", "add_net_label", "place_power_port", "place_gnd", "delete_object", "move_component", "set_component_transform", "arrange_group"])).filter((o) => o !== "add_wire" && o !== "route_net" && o !== "connect_and_label");
    }
    if (step.kind === "gate") {
      // `set_title_block` is the harness's own post-turn repair (`HARNESS_OPS`): a step that does not
      // declare it has P2 refuse the fill the engine's `TITLE_BLOCK_EMPTY` finding asked for.
      env.allowed_ops = Array.from(new Set([...(env.allowed_ops.length ? env.allowed_ops : DRAFT_OPS), "add_no_connect", "place_pwr_flag", "add_net_label", "rename_net", "move_component", "set_component_transform", "arrange_group", "add_rectangle", "add_text", "delete_object", "set_title_block"])).filter((o) => o !== "add_wire" && o !== "route_net" && o !== "connect_and_label");
      // The gate checks and repairs the whole project (`gate.run` is project-wide, and so are its ERC
      // fixes and the title-block fill), so it declares every sheet the approved plan owns — not only
      // its block's. Still a declaration: Rust intersects it with the session ceiling.
      env.sheets = Array.from(new Set([...env.sheets, ...plan.sheets.map((s) => s.file)]));
    }
    if (step.kind === "draft") env.allowed_ops = env.allowed_ops.length ? Array.from(new Set([...env.allowed_ops, "move_component", "set_component_transform", "arrange_group", "add_rectangle", "add_text"])) : [];
    for (const k of ["sheets", "allowed_ops", "structural", "nets_renamable", "rails", "interfaces"] as const) env[k] = (Array.isArray(env[k]) ? (env[k] as unknown[]) : []).filter((x): x is string => typeof x === "string" && x.length > 0);
    const info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: "instruction", headline: `step ${step.id}${step.block ? ` (${step.block})` : ""}`, plan_step: step.id, envelope: env, inherit_from_turn: null, mode: "build" } }).catch((e: unknown) => { this.reportBeginFailure(e, t); return null; });
    if (!info) { t.status = "abandoned"; this.finishTurn(t, started); return; }
    if (plan.display.status === "approved" || plan.display.status === "paused") plan.display.status = "in_progress";
    state.began = true; t.began_in_rust = true; state.kind = "instruction"; state.envelope = info.effective_envelope;
    t.kind = "instruction"; t.headline = `step ${step.id}`; t.envelope = info.effective_envelope; t.plan_ref = this.planRef();
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: "instruction", mode: "build", headline: t.headline, envelope: info.effective_envelope });
    let outcome = await this.executeStep(step, t, state);
    if (outcome.ok) this.planStepsDone.add(step.id);
    // A full-project gate after every draft step repeats what the plan's own gate step (and the per-step checks)
    // already measure; run it for wiring / gate steps and for the last step of the plan.
    // The gate step reports on the whole project, so its post-turn pass runs even when its own fix
    // rounds wrote nothing: the title-block fill of the plan's last step belongs there.
    if ((outcome.applied || step.kind === "gate") && (step.kind !== "draft" || !this.nextStep())) await this.postTurnGate(t);
    // A stop-class hard stop on this step (`stepFail`): the step is not skipped, not carded again,
    // and the plan does not move on — it pauses here with its progress kept.
    const stop = this.planStop && this.planStop.step === step.id ? this.planStop : null;
    if (outcome.skipped) { t.auto_decisions.push(outcome.skipped); this.planStepsSkipped.add(step.id); this.stepNotes.set(step.id, outcome.skipped.detail ?? outcome.reason ?? outcome.skipped.condition); }
    else if (stop) { /* paused below: nothing to skip, nothing to ask */ }
    else if (!outcome.ok && this.effectivePolicy() === "auto" && !this.stopRequested) {
      // Auto never leaves a step half-open: an unrecoverable step is recorded as skipped and the plan goes on.
      this.planStepsSkipped.add(step.id);
      this.stepNotes.set(step.id, (outcome.reason ?? "step failed").slice(0, 300));
      // One skip, one line: `stepFail` reports the skips it adjudicated itself (`reported`), and this
      // branch reports the rest. Both used to fire for the same skip.
      if (!outcome.reported) this.d.emit({ kind: "system", text_key: "system.auto_step_skipped", params: { step: step.id, reason: (outcome.reason ?? "step failed").slice(0, 300) }, severity: "warning" });
      const dec: AutoDecision = { step: step.id, condition: "unresolved", action: "skipped", detail: outcome.reason ?? "step failed" };
      // The skip belongs on the turn record, not only in the message stream: `summaryOf` reads
      // `auto_decisions` for the summary card, and a turn without one reports itself as a plain "done"
      // (real run 17, turn 3: a step whose only apply the engine refused ended as `done`, applies []).
      // `hardStop` records its own decision when it adjudicated one; do not count the same skip twice.
      if (!t.auto_decisions.some((d) => d.step === step.id && d.action === "skipped")) t.auto_decisions.push(dec);
      if ((this.autoTracker?.record(dec) ?? false) && !this.autoSkipsWarned.has(t.turn)) { this.autoSkipsWarned.add(t.turn); this.d.emit({ kind: "system", text_key: "system.auto_skips", params: { decisions: this.autoTracker?.skipped ?? t.auto_decisions.length + 1 }, severity: "warning" }); }
      outcome = { ...outcome, skipped: dec };
    } else if (!outcome.ok && !this.stopRequested) {
      // Review / Ask policy: a failed step is a decision for the human, never a silent stall.
      this.stepNotes.set(step.id, (outcome.reason ?? "step failed").slice(0, 300));
      this.d.emit({ kind: "card", card: systemCard(t.turn, "system.step_failed", { step: step.id, reason: (outcome.reason ?? "step failed").slice(0, 300) }, [{ id: "retry", label_key: "card.retry_step", style: "primary" }, { id: "skip", label_key: "card.skip_step", style: "secondary" }, { id: "stop", label_key: "card.stop_plan", style: "destructive" }]) });
    }
    // A step that ended without a single successful apply wrote nothing, and a draft step draws by
    // definition: whichever way it got there (the drafter answered with no ops, every apply was refused,
    // the step was skipped), reporting the turn as "done" reads as a success to the user and to the steps
    // after it, so it says "failed" instead. The plan itself is unaffected: an Auto skip still carries it
    // on below.
    const wroteNothing = t.applies.length === 0 && (!outcome.ok || step.kind === "draft");
    const wroteNothingWhy = (outcome.reason ?? outcome.skipped?.detail ?? (outcome.ok ? "the step applied no ops" : "step failed")).slice(0, 300);
    if (wroteNothing) this.d.emit({ kind: "system", text_key: "system.step_wrote_nothing", params: { step: step.id, reason: wroteNothingWhy }, severity: "warning" });
    t.status = t.status === "running"
      ? this.stopRequested ? "stopped"
        : stop ? "stopped"
          : wroteNothing && (outcome.ok || outcome.skipped) ? "failed"
            : outcome.ok || outcome.skipped ? "done" : "hard_stopped"
      : t.status;
    if (t.status === "hard_stopped") t.status = "abandoned";
    this.finishTurn(t, started);
    // Paused, not finished: the status travels with the progress the line below persists.
    if (stop && !stop.resume && this.plan) this.plan.display.status = "paused";
    this.persistProgress();
    if (stop) {
      this.planStop = null;
      if (stop.resume && !this.stopRequested) {
        // The human answered "retry now": the step is still open, so `/continue <id>` picks it up again.
        this.enqueue({ message: { text: `/continue ${step.id}`, refs: [], attachments: [], session_id: this.d.sessionId }, task: null, steer: false });
        return;
      }
      this.d.emit({ kind: "system", text_key: "system.plan_paused", params: { step: step.id, reason: stop.reason }, severity: "warning" });
      return;
    }
    // The same skip reason twice in a row is a condition the plan cannot work around: carrying on would
    // skip every remaining step for the same cause and pay for a full draft each time. Pause instead —
    // the remaining steps stay open and `/continue` resumes once the cause is gone.
    const skipReason = outcome.skipped ? (outcome.skipped.detail ?? outcome.reason ?? outcome.skipped.condition).slice(0, 300) : null;
    this.repeatedSkip = skipReason && this.repeatedSkip?.reason === skipReason ? { reason: skipReason, count: this.repeatedSkip.count + 1 } : skipReason ? { reason: skipReason, count: 1 } : null;
    if ((this.repeatedSkip?.count ?? 0) >= 2) {
      if (this.plan) this.plan.display.status = "paused";
      this.persistProgress();
      this.d.emit({ kind: "system", text_key: "system.plan_paused", params: { step: step.id, reason: this.repeatedSkip!.reason }, severity: "warning" });
      this.repeatedSkip = null;
      return;
    }
    const next = this.nextStep();
    if (next && this.d.settings().agent.continuous_run && !this.stopRequested && (outcome.ok || outcome.skipped)) {
      if (this.d.settings().advanced.step_throttle) return;
      // Each step is its own task: `keep_recent_tasks` then protects only the last steps and compaction can retire the rest.
        this.enqueue({ message: { text: `/continue ${next.id}`, refs: [], attachments: [], session_id: this.d.sessionId }, task: null, steer: false });
    } else if (!next && this.plan) {
      this.plan.display.status = this.planStepsSkipped.size ? "done_with_skips" : "done";
      this.d.emit({ kind: "card", card: systemCard(t.turn, "system.plan_done", { skipped: [...this.planStepsSkipped], status: this.plan.display.status, ...this.openFindingCounts() }, this.planStepsSkipped.size ? [{ id: "redo_skipped", label_key: "card.redo_skipped", style: "primary" }, { id: "dismiss", label_key: "card.dismiss", style: "secondary" }] : []) });
    }
  }

  /** draft → verify → apply → post for one step. Deterministic allocation; Drafter draws; Lead-harness verifies. */
  private async executeStep(step: PlanStep, t: TurnRecord, state: TurnPolicyState): Promise<StepOutcome> {
    const plan = this.plan!;
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    const block = step.block ? plan.blocks.find((b) => b.id === step.block) : undefined;
    const target = block?.sheet ?? plan.sheets[0].file;
    if (step.kind === "scaffold") {
      for (const sh of scaffoldOrder(plan)) {
        const inst = sh.instances?.[0];
        // A sheet is born with the plan's interface pins for it (and, from the engine, one hierarchical
        // label per pin inside the child): a sheet symbol with no pins leaves every cross-sheet net of the
        // plan with no way across, and adding pins later is a structural op the drafting steps do not have.
        const pins = interfacePins(plan, sh.file);
        const perSide = Math.max(pins.filter((p) => p.side === "left").length, pins.filter((p) => p.side === "right").length);
        const res = await this.guarded("sheet.create", { file: sh.file, name: inst?.name ?? sh.file.replace(/\.kicad_sch$/, ""), at_mil: inst?.at_mil ?? [1000, 1000], size_mil: [2000, Math.max(1500, (perSide + 1) * SHEET_PIN_PITCH_MIL)], pins, paper: sh.paper ?? null, parent: sh.parent ?? null }, ctx, bus, state, t);
        if (!res.ok) return { ok: false, applied: false, reason: res.error?.message };
      }
      return { ok: true, applied: true };
    }
    if (step.kind === "gate") {
      const out = await this.gateStepRounds(target, ctx, bus, state, t);
      // The gate is the last step of the plan and therefore the last chance to tidy: the same mechanical
      // pass runs over every block region of the sheet, so a layout finding the drafting and wiring steps
      // left behind is either fixed here or reported, never shipped in silence.
      // `delivery: true`: `DECAP_FAR` is a delivery finding, so the per-step passes never saw it and
      // a capacitor 800 mil from the pin it decouples travelled untouched to the user (run 21).
      const tidy = await this.stylistPass(target, this.blockRegionsOn(target), { bboxMil: null }, ctx, bus, state, t, { delivery: true });
      this.reportUnresolvedLayout(step.id, tidy.unresolved, t);
      // The plan's verdict is not only the engine's: ask KiCad itself once the rounds are over (and
      // every write of them is committed), so `system.plan_done` reports what KiCad says too.
      this.noteKicad(t, await this.kicadErc());
      return tidy.applied ? { ...out, applied: true } : out;
    }
    if (step.kind === "intent_snapshot") { const r = await this.guarded("intent.snapshot", { note: `plan ${plan.id}@${plan.version} done` }, ctx, bus, state, t); return { ok: r.ok, applied: r.ok }; }
    // allocation
    this.stepPhase = "draft";
    let sum = await this.engineDirect({ kind: "summary", sheet: null });
    // A step cannot draw into a file that does not exist. Without this check every drafter of the plan
    // rediscovered the same missing sheet at apply time and was skipped: runs 14 and 15 burnt nine full
    // drafts (~200k tokens) on one absent file. The engine summary is the only source of truth here.
    const missing = missingStepSheets(summarySheetFiles(sum.ok ? sum.data : null), [target, ...(state.envelope?.sheets ?? [])]);
    if (missing.length) {
      const scaffolded = await this.scaffoldMissingSheets(missing, plan, ctx, bus, state, t);
      if (!scaffolded.ok) return this.stepPause(`sheet ${missing.join(", ")} does not exist and cannot be created from the plan${scaffolded.reason ? `: ${scaffolded.reason}` : " (no sheets[] entry declares it)"}`, state, t);
      sum = await this.engineDirect({ kind: "summary", sheet: null });
      const still = missingStepSheets(summarySheetFiles(sum.ok ? sum.data : null), [target]);
      if (still.length) return this.stepPause(`sheet ${still.join(", ")} still does not exist after the scaffold`, state, t);
    }
    const summary = sum.ok ? resultText(sum, capFor("sch.summary")) : "";
    const refdes = (sum.ok ? (sum.data as { refdes?: Record<string, { used: [number, number][]; next: number }> }).refdes : undefined) ?? {};
    // Lease the block's prefixes plus the usual suspects, so a Drafter never lacks a designator range.
    const prefixes = [...new Set([...(block ? block.parts.map((p) => p.ref_prefix).filter((x): x is string => typeof x === "string" && !!x) : []), "R", "C", "D", "J", "U", "SW", "Y", "L", "Q", "F", "TP"])];
    const lease = prefixes.map((prefix) => { const next = refdes[prefix]?.next ?? 1; return { prefix, ranges: [[next, next + 24]] as [number, number][] }; });
    state.leases = lease;
    for (const [prefix, v] of Object.entries(refdes)) state.occupied[prefix] = v.used.flatMap(([lo, hi]) => Array.from({ length: Math.min(hi - lo + 1, 5000) }, (_, i) => lo + i));
    const fp = plan.floorplan[target]?.find((g) => g.group === (block?.id ?? step.id)) ?? defaultRegion(plan, block?.id ?? step.id, target);
    const origin = fp.origin_mil;
    const extent = fp.extent_mil;
    const region: [[number, number], [number, number]] = [[origin[0], origin[1]], [origin[0] + extent[0], origin[1] + extent[1]]];
    if (step.kind === "draft" && !block) return this.stepFail("unresolved", `step ${step.id} names no block; nothing to draw`, state, t);
    // resolve: every block part gets a real lib_id before the Drafter sees it (KiCad libraries first,
    // then JLC/LCSC sourcing → parts.convert). Unresolvable parts are reported, not invented.
    this.stepPhase = "draft";
    // A draft step never renames nets: rails are fixed by the plan and renames belong to the wiring step.
    if (step.kind === "draft" && state.envelope) state.envelope = { ...state.envelope, allowed_ops: (state.envelope.allowed_ops.length ? state.envelope.allowed_ops : DRAFT_OPS).filter((o) => o !== "rename_net") };
    if (block && step.kind !== "wiring") await this.resolveBlockParts(block, ctx, bus, state, t);
    let brief = block?.summary ?? step.id;
    if (step.kind === "wiring") {
      // Reconcile what the blocks actually produced: single-member nets are labels that matched nothing.
      // runPlanStepTurn already read the nets for this step's envelope: reuse that result.
      const nr = this.wiringNets?.step === step.id ? this.wiringNets.result : await this.engineDirect({ kind: "nets", sheet: target, limit: 2000 });
      const nets = ((nr.ok ? (nr.data as { nets?: { name: string; members?: unknown[]; named?: boolean }[] }).nets : []) ?? []);
      const lonely = nets.filter((n) => netMemberCount(n) <= 1 && n.named !== false).map((n) => n.name.replace(/^\//, ""));
      const wanted = step.nets ?? [];
      const erc = await this.engineDirect({ kind: "check", family: "erc", sheet: null }).catch(() => null);
      const ercLines = erc?.ok ? extractFindings(erc.data).slice(0, 40).map((f) => `${f.code}: ${f.message ?? ""}`).join("\n") : "";
      brief = `wire nets ${wanted.join(", ") || "(see below)"} between the existing blocks using labels ONLY (add_net_label on pins, power ports for rails; add_wire and route_net are not available in this step and a wire between blocks is a defect); no new components except power ports and PWR_FLAG.\nThese labels currently connect to a single pin (they matched nothing in another block): ${lonely.join(", ") || "none"}.${ercLines ? `\nERC-lite findings to resolve (unconnected pins, undriven rails, single-pin nets):\n${ercLines}` : ""} Line them up: rename_net one side to the other block's name when they are the same signal (e.g. UART_TX_MCU -> UART_TX); a local label is renamed on this sheet only (a same-named label on another sheet is a different net), a global or rail name is renamed project-wide, and a name spelled as both needs an explicit "scope". add_net_label on unlabeled pins that should join a net, place_pwr_flag on each rail only connectors drive, add_no_connect on every unused IC pin. Read sch.nets and sch.component before deciding; do not move parts.`;
      state.envelope = { ...state.envelope!, nets_renamable: Array.from(new Set([...(state.envelope?.nets_renamable ?? []), ...lonely, ...lonely.map(bareNetName)])) };
    }
    this.d.emit({ kind: "phase", turn: t.turn, role: "drafter", phase: "building", detail: block?.id ?? step.id });
    this.d.emit({ kind: "attention", turn: t.turn, role: "drafter", label: `Drafter · ${block?.id ?? step.id}`, region_mil: region, sheet: target });
    // The Drafter's dispatch args stay the same for every redraft of this step: only `attempt` and the
    // hint appended to the brief change, so the role prefix (system + tools) and the brief's structure hold.
    const draftArgs: Record<string, unknown> = { role: "drafter", brief, block: block?.id ?? step.id, target, group: block?.id ?? step.id, origin_mil: origin, region_mil: region, lease, summary, instance_paths: sheetInstancePaths(sum.data, target) };
    const draft = await this.dispatch(draftArgs, t);
    let draftRes = draft;
    if (!draftRes.ok && this.stopping) return { ok: false, applied: false, reason: "user stopped" };
    if (!draftRes.ok) {
      // A provider that is out of quota, rate-limited for long or unauthenticated will fail every step the same
      // way: the plan pauses on a provider hard stop instead of skipping block after block (and re-billing each).
      const msg = String(draftRes.error?.message ?? draftRes.error?.code ?? "");
      if (/PROVIDER_(RATE_LIMIT|QUOTA|AUTH)\b/.test(msg)) return this.stepFail("provider_exhausted", `provider unavailable: ${msg.slice(0, 200)}`, state, t);
      // A transient subagent failure (bad JSON, provider error) gets one escalated retry; the reason rides
      // along, so the second attempt fixes what was wrong instead of repeating the same answer.
      this.d.emit({ kind: "status", turn: t.turn, text: `drafter failed (${msg.slice(0, 120)}); retrying` });
      draftRes = await this.dispatch({ ...draftArgs, attempt: 1, brief: `${brief}\n${failedAttemptHint(msg)}` }, t);
      if (!draftRes.ok) return this.stepFail("unresolved", `drafter failed: ${draftRes.error?.message}`, state, t);
    }
    // A block draft lives on its own sheet; wiring / scaffold steps legitimately name several sheets (interfaces).
    const foldSheet = step.kind === "draft" ? target : undefined;
    let oplist = sanitizeDraft((draftRes.data as { output: OpListOut }).output, (n) => this.d.emit({ kind: "status", turn: t.turn, text: n }), foldSheet);
    // A block with parts must produce placements; an empty draft is a failure, retried once with the reason spelled out.
    const placesSomething = (o: OpListOut) => (o.ops ?? []).some((op) => /^(place_|add_)/.test(String((op as { op?: string }).op ?? "")));
    if (block && step.kind === "draft" && !placesSomething(oplist)) {
      const narrative = String((draftRes.data as { narrative?: string }).narrative ?? "").slice(0, 600);
      this.d.emit({ kind: "status", turn: t.turn, text: `drafter returned no placements; retrying (${narrative.slice(0, 120)})` });
      const again = await this.dispatch({ ...draftArgs, attempt: 1, brief: `${brief}\nYour previous answer contained no placement ops (${narrative || "no reason given"}). Draft the whole block now: an empty ops array is a failed answer. Every entry in Parts must appear as place_component (or a macro such as place_decoupling) with labels on its pins; lib_ids in Parts are already resolved — use them verbatim. If Parts is empty, decide the parts yourself from the block summary (lib.search / lib.resolve for the KiCad lib_id) and place them. Do not stop to ask.` }, t);
      if (!again.ok || !placesSomething((again.data as { output: OpListOut }).output)) return this.stepFail("unresolved", `drafter produced no placements: ${narrative || again.error?.message || "empty op-list"}`, state, t);
      oplist = sanitizeDraft((again.data as { output: OpListOut }).output, undefined, foldSheet);
    }
    // verify (serial)
    this.stepPhase = "verify";
    let relaxLayout = false;
    let previewId: string | null = null;
    // One redraw per step when the engine cannot find a sheet symbol the draft named (see redrawAfterSheetNotFound).
    let sheetRedrawn = false;
    for (let attempt = 0; ; attempt++) {
      const v = await this.guarded("ops.validate", { oplist }, ctx, bus, state, t);
      if (!v.ok || (v.data as { ok?: boolean })?.ok === false) {
        const errs = (v.data as { errors?: unknown[] })?.errors ?? v.error;
        const rep = attempt < 2 ? await this.runFixer(oplist, [{ code: "OPLIST_INVALID", severity: "Error", message: JSON.stringify(errs).slice(0, 500), remediation: "fix the op-list" }], target, "pre_apply", t, ctx) : null;
        if (!rep) return this.stepFail("unresolved", "op-list invalid", state, t);
        oplist = sanitizeDraft(rep as OpListOut, undefined, foldSheet); continue;
      }
      this.d.emit({ kind: "attention", turn: t.turn, role: "lead", label: "verifying", region_mil: region, sheet: target });
      const plan = await this.guarded("sch.plan", { oplist, target }, ctx, bus, state, t);
      // The dry run already knows the sheet symbol does not exist: redraw here instead of paying for an apply.
      const snfPlan = sheetNotFoundDetail(plan);
      if (snfPlan) {
        if (sheetRedrawn) return this.stepFail("unresolved", `SHEET_NOT_FOUND: ${snfPlan}`, state, t);
        sheetRedrawn = true;
        const rd = await this.redrawAfterSheetNotFound(snfPlan, target, draftArgs, foldSheet, t);
        if (!rd) return this.stepFail("unresolved", `SHEET_NOT_FOUND: ${snfPlan}`, state, t);
        oplist = rd; continue;
      }
      if (!plan.ok) return this.stepFail("unresolved", plan.error?.message ?? "sch.plan failed", state, t);
      previewId = String((plan.data as { preview?: { id?: string } })?.preview?.id ?? "") || null;
      const findings = extractFindings(plan.data);
      const dec = p4(state, findings, "pre_apply", fixerDispatchable);
      if (dec.kind === "clean") break;
      if (dec.kind === "fix") {
        recordFixAttempt(state, "pre_apply", dec.findings);
        const rep = await this.runFixer(oplist, dec.findings, target, "pre_apply", t, ctx);
        if (!rep) return this.stepFail("unresolved", "fixer failed", state, t);
        oplist = sanitizeDraft(rep as OpListOut, undefined, foldSheet); continue;
      }
      // Fix attempts exhausted. Under Auto, purely cosmetic leftovers (overlapping labels/texts, a
      // stacked power port) must not cost the whole block: draw it and report the findings.
      const layoutOnly = findings.filter((f) => f.severity === "Error").every((f) => LAYOUT_CODES.has(f.code));
      if (layoutOnly && findings.some((f) => f.severity === "Error") && this.effectivePolicy() === "auto") {
        this.d.emit({ kind: "status", turn: t.turn, text: `layout warnings remain (${findings.filter((f) => f.severity === "Error").map((f) => f.code).join(", ")}); drawing the block anyway` });
        relaxLayout = true;
        break;
      }
      return this.stepFail("unresolved", dec.reason, state, t);
    }
    // A net-risk denial (two named nets would merge) is almost always a mislabeled pin in the draft:
    // let the Fixer separate them before the hard stop / Auto skip.
    for (let attempt = 0; this.planDenied && attempt < 2; attempt++) {
      const reason = this.planDenied.verdict.reason;
      this.d.emit({ kind: "status", turn: t.turn, text: `net risk in the draft, asking the Fixer: ${reason.slice(0, 160)}` });
      const rep = await this.runFixer(oplist, [{ code: "NET_MERGE_RISK", severity: "Error", message: reason, remediation: "this op-list joins two named nets (a rail and a signal, or two signals): a label or power port sits on the wrong pin, or a pin carries two names. Remove or rename the offending label so every signal keeps its own net; never connect a signal label to a rail." }], target, "pre_apply", t, ctx);
      if (!rep) break;
      const v = await this.guarded("ops.validate", { oplist: rep }, ctx, bus, state, t);
      if (!v.ok || (v.data as { ok?: boolean })?.ok === false) break;
      this.planDenied = null;
      const p2 = await this.guarded("sch.plan", { oplist: rep, target }, ctx, bus, state, t);
      if (!p2.ok) break;
      const f2 = extractFindings(p2.data);
      if (p4(state, f2, "pre_apply", fixerDispatchable).kind !== "clean") break;
      oplist = sanitizeDraft(rep as OpListOut, undefined, foldSheet);
    }
    if (this.planDenied) {
      const r = await this.hardStop(this.boundDenied(), state, t, "sch.apply");
      if (r?.block) return this.stepFail(this.planDenied.verdict.hard_stop === "net_risk" ? "net_risk_b" : "interface", this.planDenied.verdict.reason, state, t, true);
    }
    // apply
    this.stepPhase = "apply";
    // Peek only: the registry takes (and thereby consumes) the grant when it sends the waived apply.
    const grant = this.unlocked.get("net_risk");
    const applyTool = grant ? "sch.apply_waived" : "sch.apply";
    if (previewId) this.d.emit({ kind: "preview", turn: t.turn, preview_id: previewId, sheet: target });
    this.d.emit({ kind: "attention", turn: t.turn, role: "lead", label: "applying", region_mil: region, sheet: target });
    let applied = await this.guarded(applyTool, { oplist, target, expected_merges: this.expectedMerges, note: `step ${step.id}`, reason: grant ? "approved net risk" : undefined, ...(relaxLayout ? { strict_layout: false } : {}) }, ctx, bus, state, t);
    if (!applied.ok && applied.error?.code === "P5") {
      // Lease conflict on the harness path: renumber deterministically instead of asking a model.
      const fixed = await this.retryAfterLease(oplist, applied.error.message, target, ctx, bus, state, t, { brief, block, origin, region, lease, summary });
      if (!fixed.ok) return this.stepFail("unresolved", fixed.reason, state, t);
      oplist = fixed.oplist;
      applied = fixed.applied;
    }
    // The draft named a sheet symbol the engine does not know (a file name instead of the symbol name is the
    // usual cause): one redraw with the engine's list of the real names, then the normal failure path.
    const snfApply = sheetNotFoundDetail(applied);
    if (snfApply && !sheetRedrawn) {
      sheetRedrawn = true;
      const fixed = await this.retryAfterRedraw("SHEET_NOT_FOUND", snfApply, sheetNotFoundHint(snfApply, target), "system.sheet_redraw", target, ctx, bus, state, t, draftArgs, foldSheet, `step ${step.id} sheet redraft`);
      if (!fixed.ok) return this.stepFail("unresolved", fixed.reason, state, t, fixed.carded);
      oplist = fixed.oplist;
      applied = fixed.applied;
    }
    // ENVELOPE_SHEET_UNDECLARED: the draft would write a file outside this step's approved sheets (an
    // add_sheet_pin whose child file is out of scope is the usual cause — it seeds a hierarchical label
    // inside the child). Same one-shot redraw as SHEET_NOT_FOUND, carrying the engine's own remediation;
    // the envelope stays exactly what the approved plan derived, so the redraw has to fit inside it.
    const esdApply = envelopeSheetDetail(applied);
    if (esdApply && !sheetRedrawn) {
      sheetRedrawn = true;
      const allowed = state.envelope?.sheets ?? [target];
      const fixed = await this.retryAfterRedraw("ENVELOPE_SHEET_UNDECLARED", esdApply.detail, envelopeSheetHint(esdApply.detail, esdApply.remediation, target, allowed), "system.sheet_scope_redraw", target, ctx, bus, state, t, draftArgs, foldSheet, `step ${step.id} sheet-scope redraft`);
      // The redraw is the harness's own one-shot repair and raises no card of its own (`guarded` skips the
      // card for ENVELOPE_SHEET_UNDECLARED for exactly that reason). When the second attempt fails too there
      // is nothing left to repair, so the step failure must be carded (Review) / adjudicated (Auto) like any
      // other — it used to claim it had already been carded and vanished into a silent skip.
      if (!fixed.ok) return this.stepFail("scope_widen", fixed.reason, state, t, fixed.carded);
      oplist = fixed.oplist;
      applied = fixed.applied;
    }
    if (!applied.ok) return this.stepFail("scope_widen", applied.error?.message ?? "apply refused", state, t, true);
    // The engine answers a refused write with ok + {applied:false, refusal}; that is a failed step, not a success.
    const ad = (applied.data ?? {}) as { applied?: boolean; refusal?: string | null };
    if (ad.applied === false) {
      const why = ad.refusal ?? "apply refused";
      this.d.emit({ kind: "status", turn: t.turn, text: `apply refused: ${why.slice(0, 200)}` });
      if (/^layout:/.test(why) && this.effectivePolicy() === "auto" && !relaxLayout) {
        // Auto ships the block with its layout findings instead of stopping: recorded as an auto decision
        // and reported, so the human knows which block needs a tidy-up in Review.
        t.auto_decisions.push({ step: step.id, condition: "unresolved", action: "layout_relaxed", detail: why.slice(0, 200) });
        this.d.emit({ kind: "system", text_key: "system.layout_relaxed", params: { step: step.id, detail: why.slice(0, 160) }, severity: "warning" });
        const again = await this.guarded(applyTool, { oplist, target, expected_merges: this.expectedMerges, note: `step ${step.id} (layout relaxed)`, reason: grant ? "approved net risk" : undefined, strict_layout: false }, ctx, bus, state, t);
        const ad2 = (again.data ?? {}) as { applied?: boolean; refusal?: string | null };
        if (!again.ok || ad2.applied === false) return this.stepFail("unresolved", ad2.refusal ?? again.error?.message ?? why, state, t);
      } else {
        return this.stepFail(/net/.test(why) ? "net_risk_b" : "unresolved", why, state, t);
      }
    }
    // post
    const post = await this.guarded("check.integrity", { sheet: target }, ctx, bus, state, t);
    const pf = extractFindings(post.data);
    // Stylist pass (mechanical, no model): tidy rows / power-port orientation, then frame + title the block.
    // A wiring step gets it too. It used to be draft-only, so every layout finding the wiring itself
    // raised (six upside-down power ports in one real run) travelled untouched through the gate step to
    // delivery; the pass is bounded by the plan's own block regions and adds no component.
    {
      const drafted = block && step.kind === "draft";
      const regions = drafted ? [{ id: block.id, summary: block.summary, region }] : this.blockRegionsOn(target);
      const bbox = drafted ? (((applied.data ?? {}) as { bbox_mil?: Box | null }).bbox_mil ?? null) : null;
      const frame = drafted ? { bboxMil: bbox, sheetTitle: target.replace(/^.*\//, "").replace(/\.kicad_sch$/, "") } : { bboxMil: null };
      const tidy = await this.stylistPass(target, regions, frame, ctx, bus, state, t);
      // Leftover style/layout findings get one Fixer round (move / rotate / arrange only).
      const left = tidy.unresolved.filter((f) => fixerDispatchable(f.code));
      if (left.length && !state.styleFixed) {
        state.styleFixed = true;
        const rep = await this.runFixer({ protocol_version: 1, groups: {}, ops: [] }, left, target, "post_apply", t, ctx);
        if (rep) await this.harnessApply({ oplist: rep, target, expected_merges: [], note: `step ${step.id} style-fix` }, ctx, bus, state, t);
        this.reportUnresolvedLayout(step.id, (await this.styleFindings(target, ctx, bus, state, t)).filter((f) => LAYOUT_CODES.has(f.code) && regions.some((r) => findingInRegion(f, r.region))), t);
      } else {
        this.reportUnresolvedLayout(step.id, tidy.unresolved, t);
      }
    }
    const pdec = p4(state, pf, "post_apply", fixerDispatchable);
    if (pdec.kind === "fix") {
      recordFixAttempt(state, "post_apply", pdec.findings);
      const rep = await this.runFixer(oplist, pdec.findings, target, "post_apply", t, ctx);
      if (rep) await this.guarded("sch.apply", { oplist: rep, target, expected_merges: [], note: `step ${step.id} post-fix` }, ctx, bus, state, t);
    } else if (pdec.kind === "hard_stop") {
      return { ...(await this.stepFail("unresolved", pdec.reason, state, t)), applied: true };
    }
    if (step.kind === "wiring") {
      const erc = await this.guarded("check.erc", { sheet: target }, ctx, bus, state, t);
      await this.runErcFix(target, extractFindings(erc.data), ctx, bus, state, t);
    }
    this.stepPhase = null;
    return { ok: true, applied: true };
  }

  /**
   * P5 on the harness path: the Drafter used designators outside its lease. Refresh the occupied
   * table, move the conflicting designators to the next free numbers everywhere in the op-list and
   * apply again; if nothing could be renumbered, re-dispatch the Drafter once with the conflict.
   */
  private async retryAfterLease(oplist: OpListOut, message: string, target: string, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord, redo: { brief: string; block: DesignPlan["blocks"][number] | undefined; origin: [number, number]; region: [[number, number], [number, number]]; lease: { prefix: string; ranges: [number, number][] }[]; summary: string }): Promise<{ ok: true; oplist: OpListOut; applied: ToolResult } | { ok: false; reason: string }> {
    const sum = await this.engineDirect({ kind: "summary", sheet: null });
    const refdes = (sum.ok ? (sum.data as { refdes?: Record<string, { used: [number, number][]; next: number }> }).refdes : undefined) ?? {};
    for (const [prefix, v] of Object.entries(refdes)) state.occupied[prefix] = v.used.flatMap(([lo, hi]) => Array.from({ length: Math.min(hi - lo + 1, 5000) }, (_, i) => lo + i));
    const conflicts = conflictsFromMessage(message);
    const taken: Record<string, number[]> = {};
    for (const op of (oplist.ops ?? []) as Record<string, unknown>[]) { const m = /^([A-Za-z]+)(\d+)$/.exec(String(op.designator ?? "")); if (m) (taken[m[1]] ??= []).push(Number(m[2])); }
    const map = planRenumber(conflicts, state.occupied, taken);
    const { oplist: renumbered, changed } = renumberOplist(oplist, map);
    if (changed > 0) {
      for (const [prefix, ns] of Object.entries(taken)) { const hi = Math.max(...ns, ...(state.occupied[prefix] ?? [0])); const l = state.leases.find((x) => x.prefix === prefix); if (l) l.ranges = [[Math.min(...ns), hi + 24]]; else state.leases.push({ prefix, ranges: [[1, hi + 24]] }); }
      for (const to of Object.values(map)) { const m = /^([A-Za-z]+)(\d+)$/.exec(to); if (m) { const l = state.leases.find((x) => x.prefix === m[1]); const n = Number(m[2]); if (l && !l.ranges.some(([lo, hi]) => n >= lo && n <= hi)) l.ranges.push([n, n + 24]); } }
      this.d.emit({ kind: "status", turn: t.turn, text: `lease conflict: renumbered ${Object.entries(map).map(([a, b]) => `${a}->${b}`).join(", ")}` });
      const v = await this.guarded("ops.validate", { oplist: renumbered }, ctx, bus, state, t);
      if (v.ok && (v.data as { ok?: boolean })?.ok !== false) {
        const p = await this.guarded("sch.plan", { oplist: renumbered, target }, ctx, bus, state, t);
        if (p.ok) {
          const a = await this.guarded("sch.apply", { oplist: renumbered, target, expected_merges: this.expectedMerges, note: "lease renumber" }, ctx, bus, state, t);
          if (a.ok) return { ok: true, oplist: renumbered, applied: a };
        }
      }
    }
    // Nothing to renumber (or the renumbered list failed): one more Drafter attempt with the conflict spelled out.
    const again = await this.dispatch({ role: "drafter", attempt: 1, brief: `${redo.brief}\nYour previous op-list used designators outside your lease (${message.slice(0, 200)}). Use only leased, free numbers: ${JSON.stringify(state.leases)}.`, block: redo.block?.id, target, group: redo.block?.id, origin_mil: redo.origin, region_mil: redo.region, lease: state.leases, summary: redo.summary }, t);
    if (!again.ok) return { ok: false, reason: `lease conflict: ${message.slice(0, 200)}` };
    const o2 = sanitizeDraft((again.data as { output: OpListOut }).output, undefined, redo.block ? target : undefined);
    const v2 = await this.guarded("ops.validate", { oplist: o2 }, ctx, bus, state, t);
    if (!v2.ok || (v2.data as { ok?: boolean })?.ok === false) return { ok: false, reason: "lease conflict: redraft invalid" };
    const p2 = await this.guarded("sch.plan", { oplist: o2, target }, ctx, bus, state, t);
    if (!p2.ok) return { ok: false, reason: `lease conflict: ${p2.error?.message ?? "plan failed"}` };
    const a2 = await this.guarded("sch.apply", { oplist: o2, target, expected_merges: this.expectedMerges, note: "lease redraft" }, ctx, bus, state, t);
    if (!a2.ok) return { ok: false, reason: `lease conflict: ${a2.error?.message ?? "apply refused"}` };
    return { ok: true, oplist: o2, applied: a2 };
  }

  /**
   * SHEET_NOT_FOUND: the op-list addressed a hierarchical sheet symbol that the target sheet does not
   * carry (the Drafter usually writes the sheet's file name where the symbol name belongs). The engine
   * message lists the names that do exist, so the Drafter is dispatched once more with the same brief
   * plus that message; one redraw per step, on the escalated-retry path like every other redraft.
   * Returns the sanitised op-list, or null when the redraw itself failed.
   */
  private async redrawAfterSheetNotFound(detail: string, target: string, draftArgs: Record<string, unknown>, foldSheet: string | undefined, t: TurnRecord): Promise<OpListOut | null> {
    return this.redrawWithHint("SHEET_NOT_FOUND", detail, sheetNotFoundHint(detail, target), "system.sheet_redraw", draftArgs, foldSheet, t);
  }

  /**
   * One redraw of the current step: the same Drafter dispatch with `hint` appended to the brief, announced
   * to the user with `textKey`. The envelope is never touched — the hint tells the Drafter what the engine
   * refused, and the approved plan still bounds what the redraw may write.
   */
  private async redrawWithHint(code: string, detail: string, hint: string, textKey: string, draftArgs: Record<string, unknown>, foldSheet: string | undefined, t: TurnRecord): Promise<OpListOut | null> {
    this.d.emit({ kind: "status", turn: t.turn, text: `redrawing after ${code}: ${detail.slice(0, 120)}` });
    this.d.emit({ kind: "system", text_key: textKey, params: { detail: detail.slice(0, 160) }, severity: "info" });
    const again = await this.dispatch({ ...draftArgs, attempt: 1, brief: `${String(draftArgs.brief ?? "")}\n${hint}` }, t);
    if (!again.ok) return null;
    return sanitizeDraft((again.data as { output: OpListOut }).output, undefined, foldSheet);
  }

  /** A redraw taken through validate -> plan -> apply (used after a refused apply). */
  private async retryAfterRedraw(code: string, detail: string, hint: string, textKey: string, target: string, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord, draftArgs: Record<string, unknown>, foldSheet: string | undefined, note: string): Promise<{ ok: true; oplist: OpListOut; applied: ToolResult } | { ok: false; reason: string; carded: boolean }> {
    const fail = (why: string, carded = false) => ({ ok: false as const, reason: `${code}: ${why}`, carded });
    const o2 = await this.redrawWithHint(code, detail, hint, textKey, draftArgs, foldSheet, t);
    if (!o2) return fail(detail);
    const v2 = await this.guarded("ops.validate", { oplist: o2 }, ctx, bus, state, t);
    if (!v2.ok || (v2.data as { ok?: boolean })?.ok === false) return fail("redraft invalid");
    const p2 = await this.guarded("sch.plan", { oplist: o2, target }, ctx, bus, state, t);
    if (!p2.ok) return fail(p2.error?.message ?? "plan failed", this.guardCarded);
    const a2 = await this.guarded("sch.apply", { oplist: o2, target, expected_merges: this.expectedMerges, note }, ctx, bus, state, t);
    if (!a2.ok) return fail(a2.error?.message ?? "apply refused", this.guardCarded);
    return { ok: true, oplist: o2, applied: a2 };
  }

  /**
   * The sheet file `/review <arg>` names: the project-relative file, its stem, or the instance path
   * (`/power/`). Null when the argument matches no sheet of this project.
   */
  private resolveSheetArg(arg: string): string | null {
    const raw = arg.trim();
    if (!raw) return null;
    const bare = raw.replace(/^\/+/, "").replace(/\/+$/, "");
    const files = this.d.sheets();
    return files.find((f) => f === raw || f === bare) ?? files.find((f) => sheetMatches(f, bare)) ?? null;
  }

  /**
   * Is this finding on the sheet the review was narrowed to? A row that names no sheet is a
   * project-level one (the library audit, the project check) and stays in: the engine gate is
   * project-wide by construction, and this filter only decides what the card lists — never a
   * verdict (red line 6). The same rule the engine's own `check { sheet }` applies to its rows.
   */
  private onReviewScope(f: Finding): boolean {
    const scope = this.reviewScope;
    if (!scope) return true;
    if (!f.sheet) return true;
    const file = typeof f.file === "string" && f.file ? f.file : this.sheetFileFor([f.sheet]);
    return file ? sheetMatches(file, scope) : true;
  }

  /**
   * `/review`: the built-in review sequence (engine checks first, then the Reviewer's judgement),
   * ending in a review card whose checkboxes drive `/fix`. Read-only; works in every mode.
   * `/review <sheet>` narrows the per-sheet engine checks, the Reviewer's brief and the card to one
   * sheet; `gate.run` and `project.check` still run project-wide (see `onReviewScope`).
   */
  private async runReviewTurn(t: TurnRecord, state: TurnPolicyState, started: number, scopeArg: string | null = null): Promise<void> {
    const scope = scopeArg ? this.resolveSheetArg(scopeArg) : null;
    if (scopeArg && !scope) this.d.emit({ kind: "system", text_key: "system.review_scope_unknown", params: { arg: scopeArg.slice(0, 80), sheets: this.d.sheets().join(", ") }, severity: "warning" });
    this.reviewScope = scope;
    t.kind = "question"; t.headline = scope ? `review ${scope}` : "review";
    // The harness declares this turn itself: `/review` runs no model turn, so nothing would call
    // `turn.begin`, and P0a would then deny every C-tier check the review is made of (the card would
    // report a clean project because nothing ran). A question turn writes nothing: P0b still refuses
    // every D tool, in every mode.
    state.began = true; state.kind = "question";
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: "question", mode: this.mode, headline: t.headline, envelope: null });
    this.d.emit({ kind: "phase", turn: t.turn, role: "reviewer", phase: "reviewing" });
    // Single path: the built-in `design-review` workflow runs through the interpreter.
    const run = await this.runWorkflow(DESIGN_REVIEW, t, state);
    const engine = run.findings.filter((f) => this.onReviewScope(f));
    const rev = run.results.review as { output?: { findings?: unknown[] } | null } | undefined;
    const advisory = (Array.isArray(rev?.output?.findings) ? rev!.output!.findings : []).filter((f): f is Finding & { origin?: string } => !!f && typeof (f as Finding).code === "string").map((f) => ({ ...f, severity: (f as Finding).severity ?? "Info", origin: "advisory" } as Finding));
    // KiCad's own ERC (kicad-cli, advisory second opinion per red line 8): a harness call, never a model claim.
    // Its rows carry a KICAD_ prefix and the advisory origin; when kicad-cli is absent the review says so.
    // Same helper as the post-turn gate: one bounded run, rows carrying sheet / refs / location.
    const kicad = await this.kicadErc();
    this.noteKicad(t, { ...kicad, rows: [] }, [], false); // the rows go out with the review's own findings batch below
    const kicadRows: (Finding & { origin: string })[] = kicad.rows.filter((f) => this.onReviewScope(f));
    const reviewerFailed = !!(run.results.review as { error?: unknown } | undefined)?.error || (rev?.output === undefined && !run.stopped);
    if (reviewerFailed) this.d.emit({ kind: "system", text_key: "system.reviewer_failed", params: { reason: String(((run.results.review as { error?: { message?: string } } | undefined)?.error?.message) ?? "no output").slice(0, 160) }, severity: "warning" });
    this.reviewCard(t, "card.review", engine, kicadRows, { advisory, kicadNote: kicad.available ? "" : (kicad.note ?? "unavailable"), reviewerFailed, scoped: !!scope });
    this.reviewScope = null;
    t.status = run.stopped === "aborted" ? "stopped" : "done";
    this.finishTurn(t, started);
  }

  /**
   * The review card: the engine's rows, KiCad's own ERC rows and (after `/review`) the Reviewer's
   * advisories, each row tickable for `/fix`. Emitted by `/review` and again at the end of a `/fix`
   * turn that moved the gate counts (`card.review_after_fix`, no model call), so a fix always ends
   * with a verdict rather than a count. Every number here comes from the engine gate or kicad-cli.
   */
  private reviewCard(t: TurnRecord, title: "card.review" | "card.review_after_fix", engine: Finding[], kicadRows: (Finding & { origin: string })[], o: { advisory?: Finding[]; kicadNote?: string; reviewerFailed?: boolean; scoped?: boolean }): void {
    const advisory = o.advisory ?? [];
    // Advisory (model) findings never carry Error weight: the verdict counts are the engine's alone.
    const all = [...engine.map((f) => ({ ...f, origin: "engine" })), ...advisory.map((f) => ({ ...f, severity: f.severity === "Error" ? "Warning" : f.severity, origin: "advisory" })), ...kicadRows];
    this.pushFindings(t, all);
    // A scoped review reports only part of the project: a full batch would resolve every row it left out.
    this.d.emit({ kind: "findings", turn: t.turn, findings: all, full: !o.scoped });
    // A finding a live project waiver covers is still listed (with its expiry) but out of the counts.
    const open = engine.filter((f) => !isWaived(f));
    const errors = open.filter((f) => f.severity === "Error").length;
    const warnings = open.filter((f) => f.severity === "Warning").length;
    const kicadErrors = kicadRows.filter((f) => f.severity === "Error").length;
    const kicadNote = o.kicadNote ?? "";
    const kicadPart = kicadNote ? ` · kicad-cli: ${kicadNote}` : kicadRows.length || !kicadNote ? ` · kicad ERC ${kicadErrors} error / ${kicadRows.length - kicadErrors} warning` : "";
    const advisoryPart = title === "card.review" ? (o.reviewerFailed ? " · reviewer did not run" : ` · ${advisory.length} advisory`) : "";
    const scopePart = this.reviewScope ? ` · ${this.reviewScope}` : "";
    const body = `${errors} error · ${warnings} warning${advisoryPart}${kicadPart}${scopePart}`;
    const preselected = new Set<(typeof all)[number]>(defaultFixSelection(all));
    const card = makeCard("review", t.turn, title, body, [
      { id: "fix_selected", label_key: "card.fix_selected", style: "primary", consent: { grant_kind: "user_action", payload_sha256: sha256Hex(`enter_build:${this.d.projectKey}`) } },
      // Waiving is a consented, recorded decision (a waiver card without consent used to be a silent no-op).
      // The sha here is only the card's declaration: the answer's own consent event hashes the rows the
      // human actually ticked plus the reason (`waiveConsentSha`), and Rust checks the grant against it.
      { id: "waive_selected", label_key: "card.waive_selected", style: "secondary", consent: { grant_kind: "waiver", payload_sha256: sha256Hex(`waive:${this.d.projectKey}:${t.turn}`) } },
      { id: "dismiss", label_key: "card.dismiss", style: "secondary" },
      // Pre-selected for "fix": `defaultFixSelection` (findings.ts), the same predicate the findings
      // panel uses, so the two entry points into "fix selected" never start from different rows.
    ], { findings: all.map((f, i) => ({ ...f, id: String(i), selected: preselected.has(f) })), errors, warnings, advisory: advisory.length, ...(this.reviewScope ? { sheet: this.reviewScope } : {}) });
    this.d.emit({ kind: "card", card });
  }

  // ---------------------------------------------------------------------------
  // Workflow interpreter (agent-runtime.md §9): non-verify flows only
  // ---------------------------------------------------------------------------

  /** Workflows the interpreter may run; the plan-driven ones live in `executeStep`. */
  static readonly RUNNER_WORKFLOWS: readonly WorkflowDef[] = [DESIGN_REVIEW, ADOPT_EXISTING, DATASHEET_FIRST, SOURCE_BOM];

  /** `/workflow <id>`: a built-in interpreter workflow or a trusted pack's `workflow.yaml` (`id` from the file). */
  private async runWorkflowTurn(t: TurnRecord, state: TurnPolicyState, started: number, id: string): Promise<void> {
    t.kind = "instruction"; t.headline = `workflow ${id}`;
    const fail = (reason: string) => { this.d.emit({ kind: "system", text_key: "workflow.unavailable", params: { id, reason }, severity: "warning" }); t.kind = "question"; t.status = "done"; this.finishTurn(t, started); };
    let def = LeadLoop.RUNNER_WORKFLOWS.find((w) => w.id === id) ?? null;
    if (!def && BUILTIN_WORKFLOWS.some((w) => w.id === id)) { fail("this workflow runs from the plan (/continue), not the interpreter"); return; }
    if (!def) {
      const found = await this.packWorkflow(id);
      if (!found.def) { fail(found.reason ?? "not found"); return; }
      def = found.def;
    }
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: "instruction", mode: this.mode, headline: t.headline, envelope: null });
    this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: def.mode === "build" ? "building" : "exploring" });
    if (def.mode === "build" && this.mode === "build" && this.buildSession && !state.began) {
      const ok = await this.beginWorkflowTurn(def, t, state);
      if (!ok) { t.status = "abandoned"; this.finishTurn(t, started); return; }
    }
    const run = await this.runWorkflow(def, t, state);
    if (run.findings.length) { this.pushFindings(t, run.findings as Finding[]); this.d.emit({ kind: "findings", turn: t.turn, findings: run.findings, full: false }); }
    if (run.applies) await this.postTurnGate(t);
    this.d.emit({ kind: "system", text_key: run.ok ? "workflow.done" : "workflow.stopped", params: { id: def.id, applies: run.applies, reason: run.stopped ?? "" }, severity: run.ok ? "info" : "warning" });
    t.status = run.stopped === "aborted" || this.stopRequested ? "stopped" : run.ok ? "done" : "abandoned";
    this.finishTurn(t, started);
  }

  /** Find `id` among trusted packs' workflow files; `mode: build` files also need the `trust_workflows` consent. */
  private async packWorkflow(id: string): Promise<{ def: WorkflowDef | null; reason?: string }> {
    let reason = "not found";
    for (const w of this.d.skills.workflows()) {
      if (!w.trusted) continue;
      let text: string;
      try { text = await this.d.skills.readWorkflow(w.pack, w.path); } catch (e) { reason = String(e); continue; }
      const parsed = parseWorkflowYaml(text);
      if (!parsed.def) { if (new RegExp(`\\bid:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) reason = `lint: ${parsed.errors.join("; ")}`; continue; }
      if (parsed.def.id !== id) continue;
      if (needsWorkflowConsent(parsed.def) && !w.workflows_trusted) return { def: null, reason: `pack ${w.pack}: workflows not trusted (settings > skills)` };
      return { def: parsed.def };
    }
    return { def: null, reason };
  }

  /** `turn_begin` for an interpreter-driven Build turn: envelope from `limits`, ops limited to what BOM binding needs. */
  private async beginWorkflowTurn(def: WorkflowDef, t: TurnRecord, state: TurnPolicyState): Promise<boolean> {
    const base = sessionCeiling(this.d.settings().agent.session_ceiling_components_added || SESSION_CEILING_COMPONENTS_ADDED_DEFAULT, this.d.sheets(), this.rails());
    // A BOM-binding workflow writes a few fields on every fitted part, one apply per part: its own
    // `limits.max_applies` (loaded from the definition, never from the model) bounds the edits.
    const properties = Math.max(base.properties_changed_max, (def.limits?.max_applies ?? 0) * 4);
    const env = { ...base, properties_changed_max: properties, allowed_ops: def.id === "source-bom" ? ["set_component_parameters", "set_component_attributes"] : [] as string[] };
    try {
      const info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: "instruction", headline: t.headline, plan_step: null, envelope: env, inherit_from_turn: null, mode: "build" } });
      state.began = true; t.began_in_rust = true; state.kind = "instruction"; state.envelope = info.effective_envelope; t.envelope = info.effective_envelope;
      return true;
    } catch (e) { this.d.emit({ kind: "error", turn: t.turn, error: { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" } }); return false; }
  }

  private async runWorkflow(def: WorkflowDef, t: TurnRecord, state: TurnPolicyState): Promise<RunResult> {
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    const host = this.workflowHost(def, t, state, ctx, bus);
    return new WorkflowRunner(host, def).run();
  }

  /** Every node maps to a Lead facility the model-driven path already uses (same hooks, ledger, cards). */
  private workflowHost(def: WorkflowDef, t: TurnRecord, state: TurnPolicyState, ctx: ToolContext, bus: HookBus): RunnerHost {
    return {
      turn: t.turn,
      mode: () => this.mode,
      policy: () => this.effectivePolicy(),
      tool: (name, args) => this.guarded(name, this.scopedToolArgs(name, args), ctx, bus, state, t),
      agent: async (role, args, tools) => {
        const item = args.item as Record<string, unknown> | undefined;
        const brief = [String(args.brief ?? ""), item ? `Item: ${JSON.stringify(item).slice(0, 1500)}` : "", role === "sourcer" ? "Return {\"candidates\":[...], \"items\":[{\"ref\", \"expected\":{mpn,value,package}, \"actual\":{...}, \"candidates\":[{lcsc,mpn,package,stock,price_usd}], \"confidence\":\"high|low\"}]} so the decision card can render it." : ""].filter(Boolean).join("\n");
        // `/review <sheet>`: the Reviewer is told which sheet it is reviewing and sees that sheet's summary.
        const a: Record<string, unknown> = { role, brief, ...(role === "reviewer" ? { scope: this.reviewScope ? `sheet ${this.reviewScope}` : "the whole schematic", summary: await this.summaryText(this.reviewScope) } : {}), ...(role === "architect" ? { summary: await this.summaryText() } : {}), ...(tools ? { tools } : {}) };
        return this.dispatch(a, t);
      },
      askCard: (card) => { card.id = card.id || localId("card"); return this.askCard(card, state, t); },
      checkpoint: async () => {
        if (state.checkpointed) return true;
        try { const cp = await call("checkpoint_create", { project_key: this.d.projectKey, turn: t.turn, kind: "turn" }); state.checkpointed = true; t.checkpoint = cp.turn; return true; } catch { return false; }
      },
      items: (selector) => this.workflowItems(selector, ctx, bus, state, t),
      enterBuild: async (consent) => {
        if (!this.d.enterBuild) return false;
        const ok = await this.d.enterBuild(consent);
        if (!ok || !this.buildSession) return false;
        return state.began ? true : this.beginWorkflowTurn(def, t, state);
      },
      proposePlan: async () => {
        if (!this.plan) return false;
        this.d.emit({ kind: "card", card: planCard(t.turn, this.plan, { steps: this.plan.steps.length, title: this.plan.goal, id: this.plan.id, version: this.plan.version }, undefined, planMarkdown(this.plan)) });
        return true;
      },
      status: (text) => this.d.emit({ kind: "status", turn: t.turn, text }),
      addApply: () => { this.turnBudget?.addApply(); this.planBudget?.addApply(); },
      extractFindings,
      signal: this.abort?.signal,
    };
  }

  private async summaryText(sheet: string | null = null): Promise<string> {
    const sum = await this.engineDirect({ kind: "summary", sheet }).catch(() => null);
    return sum?.ok ? resultText(sum, capFor("sch.summary")) : "";
  }

  /**
   * `/review <sheet>`: the review workflow's per-sheet checks are run on that sheet (the engine's
   * `check { sheet }` keeps the rows that sit on it, plus the ones that name no sheet). `gate.run`,
   * `project.check` and `diff.nets` have no sheet parameter — connectivity, the library audit and a
   * net diff are project-wide by construction and are not narrowed here (red line 6: the verdict
   * stays the engine's); their rows are filtered for the card by `onReviewScope`.
   */
  private scopedToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!this.reviewScope || !name.startsWith("check.") || args.sheet !== undefined) return args;
    return { ...args, sheet: this.reviewScope };
  }

  /** `foreach.items` selectors (schema-validated: path + optional equality filter). */
  private async workflowItems(selector: string, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<unknown[]> {
    const m = /^([a-z_.]+)(?:\[([a-z_]+)="?([a-z0-9_.-]+)"?\])?$/i.exec(selector);
    if (!m) return [];
    const filter = (arr: unknown[]) => (m[2] ? arr.filter((x) => x && typeof x === "object" && String((x as Record<string, unknown>)[m[2]]) === m[3]) : arr);
    switch (m[1]) {
      case "plan.sheets": return filter((this.plan?.sheets ?? []) as unknown[]);
      case "plan.blocks": return filter((this.plan?.blocks ?? []) as unknown[]);
      case "plan.steps": return filter((this.plan?.steps ?? []) as unknown[]);
      case "plan.parts": {
        const parts = (this.plan?.blocks ?? []).flatMap((b) => b.parts.map((p) => ({ ...(p as unknown as Record<string, unknown>), block: b.id, sheet: b.sheet, critical: !!(p.lcsc || (p as { critical?: boolean }).critical) })));
        return filter(parts as unknown[]);
      }
      case "findings": return filter((this.pendingFix ?? t.findings).map((f) => ({ ...(f as unknown as Record<string, unknown>), selected: true })) as unknown[]);
      case "components": {
        const r = await this.guarded("parts.bom", { lock: false }, ctx, bus, state, t);
        const lines = ((r.ok ? (r.data as { lines?: Record<string, unknown>[] }).lines : []) ?? []);
        const sheet = this.d.sheets()[0] ?? "";
        return filter(lines.flatMap((l) => ((l.refs as string[]) ?? []).map((ref) => ({ ...(l as Record<string, unknown>), ref, sheet, fitted: l.dnp !== true }))));
      }
      default: return [];
    }
  }

  // ---------------------------------------------------------------------------
  // FR-611 multi-instance sheets
  // ---------------------------------------------------------------------------

  /** Instance paths of one sheet file, from `sch.summary` (cached for the turn); [] when it is not reused. */
  private async instancePathsFor(file: string): Promise<string[]> {
    if (!file || this.d.sheets().length < 2) return [];
    const hit = this.instancePaths.get(file);
    if (hit) return hit;
    const sum = await this.engineDirect({ kind: "summary", sheet: null }).catch(() => null);
    const paths = sum?.ok ? sheetInstancePaths(sum.data, file) : [];
    this.instancePaths.set(file, paths);
    return paths;
  }

  /**
   * FR-611: a sheet file instantiated more than once whose parts lack a reference for some instance
   * path is a question for the human ("this instance only / all instances"), never an auto-fix
   * (`FIXER_MAP` who: "none"). A plan that declared `instances` already answered it, so no card is
   * raised then. The card never blocks the turn: it is answered later through `answerInstanceRefs`.
   */
  private async instanceRefsCards(t: TurnRecord, findings: Finding[]): Promise<void> {
    if (this.mode !== "build") return;
    for (const f of findings.filter((x) => x.code === "INSTANCE_REFS_REQUIRED")) {
      const facts = instanceRefsFacts(f);
      const named = facts.file ? this.d.sheets().find((x) => sheetMatches(x, facts.file as string)) ?? facts.file : null;
      const file = named ?? this.sheetFileFor([f.sheet]);
      if (!file || this.instanceRefsAsked.has(file)) continue;
      if (planDeclaresInstances(this.plan, file)) continue;
      const paths = await this.instancePathsFor(file);
      this.instanceRefsAsked.add(file);
      const card = instanceRefsCard(t.turn, {
        sheet: file,
        instances: Math.max(facts.instances, paths.length),
        paths,
        refs: (f.refs ?? []).slice(0, INSTANCE_REFS_PARTS_LISTED),
        deletions_available: this.policyState?.envelope?.components_deleted_max ?? 0,
      });
      // Auto answers question cards from their default; this one has none, so the frozen table skips it.
      const dec = this.effectivePolicy() === "auto" ? adjudicate({ condition: "ask_user", step: this.policyState?.step ?? t.plan_step ?? "", mode: this.mode, hasDefault: false }) : null;
      if (dec) { t.auto_decisions.push(dec); card.auto = { decision: dec.action, reason: dec.detail ?? "" }; }
      this.d.emit({ kind: "card", card });
    }
  }

  /**
   * Answer of the FR-611 card (routed by `index.ts` `answerCard`; a question is never a consent
   * event and grants nothing). "This instance only" keeps the file as it is; "all instances" opens
   * a Build turn that re-places the affected parts.
   */
  answerInstanceRefs(d: { sheet?: unknown; paths?: unknown; refs?: unknown }, scope: "all" | "this"): void {
    const sheet = typeof d.sheet === "string" ? d.sheet : "";
    if (!sheet) return;
    if (scope === "this") {
      this.d.emit({ kind: "system", text_key: "system.instance_refs_this_only", params: { sheet }, severity: "info" });
      return;
    }
    const str = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    this.pendingInstanceRefs = { sheet, paths: str(d.paths), refs: str(d.refs) };
    this.enqueue({ message: { text: "/instances", refs: [], attachments: [], session_id: this.d.sessionId }, task: null, steer: false });
  }

  /**
   * FR-611 "all instances": no op adds a missing instance-path entry to a symbol that is already
   * placed (`set_component_parameters.instance_designators` only rewrites entries that exist), so
   * the affected parts are deleted and placed again with the full map. That is a D action inside
   * the turn envelope: Build only, and it needs a deletion budget — the no-plan session ceiling
   * freezes deletions at 0 in Rust, and then annotating in KiCad is the only route left.
   */
  private async runInstanceRefsTurn(t: TurnRecord, state: TurnPolicyState, started: number): Promise<void> {
    const req = this.pendingInstanceRefs;
    this.pendingInstanceRefs = null;
    t.kind = "instruction";
    t.headline = req ? `instance references on ${req.sheet}` : "instance references";
    if (!req || !req.refs.length || req.paths.length < 2) { t.status = "done"; this.finishTurn(t, started); return; }
    if (this.mode !== "build" || !this.buildSession) {
      this.d.emit({ kind: "system", text_key: "system.run_unavailable", params: { reason: this.mode !== "build" ? "mode is not build" : "no build session" }, severity: "warning" });
      t.status = "done"; this.finishTurn(t, started); return;
    }
    const ceiling = this.d.settings().agent.session_ceiling_components_added || SESSION_CEILING_COMPONENTS_ADDED_DEFAULT;
    const env: Envelope = { ...sessionCeiling(ceiling, this.d.sheets(), this.rails()), sheets: [req.sheet], allowed_ops: ["delete_component", "place_component"], components_added_max: Math.max(req.refs.length, 1), components_deleted_max: req.refs.length };
    let info: { turn: number; effective_envelope: Envelope } | null = null;
    try { info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: "instruction", headline: t.headline, plan_step: null, envelope: env, inherit_from_turn: null, mode: "build" } }); }
    catch (e) { this.reportBeginFailure(e, t); }
    if (!info) { t.status = "abandoned"; this.finishTurn(t, started); return; }
    state.began = true; t.began_in_rust = true; state.kind = "instruction"; state.envelope = info.effective_envelope; t.envelope = info.effective_envelope;
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: "instruction", mode: "build", headline: t.headline, envelope: info.effective_envelope });
    if (info.effective_envelope.components_deleted_max < req.refs.length) {
      this.d.emit({ kind: "system", text_key: "system.instance_refs_no_budget", params: { sheet: req.sheet, needed: req.refs.length, available: info.effective_envelope.components_deleted_max }, severity: "warning" });
      t.status = "done"; this.finishTurn(t, started); return;
    }
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    this.d.emit({ kind: "phase", turn: t.turn, role: "drafter", phase: "building" });
    const r = await this.dispatch({ role: "drafter", brief: instanceRefsBrief(req), target: req.sheet }, t);
    const out = r.ok ? (r.data as { output?: OpListOut }).output : null;
    let ok = false;
    if (out) {
      const oplist = sanitizeDraft(out);
      const v = await this.guarded("ops.validate", { oplist }, ctx, bus, state, t);
      if (v.ok && (v.data as { ok?: boolean })?.ok !== false) {
        const p = await this.guarded("sch.plan", { oplist, target: req.sheet }, ctx, bus, state, t);
        if (p.ok && !this.planDenied) {
          const a = await this.guarded("sch.apply", { oplist, target: req.sheet, expected_merges: [], note: t.headline }, ctx, bus, state, t);
          ok = a.ok && (a.data as { applied?: boolean })?.applied !== false;
        }
      }
    }
    this.d.emit({ kind: "system", text_key: ok ? "system.instance_refs_done" : "system.instance_refs_failed", params: { sheet: req.sheet, parts: req.refs.length }, severity: ok ? "info" : "warning" });
    if (ok) await this.postTurnGate(t);
    t.status = "done";
    this.finishTurn(t, started);
  }

  /** `/fix`: repair `pendingFix` (ercfix, then Fixer rounds, then a gate run). Build only. */
  private async runFixTurn(t: TurnRecord, state: TurnPolicyState, started: number): Promise<void> {
    const findings = this.pendingFix ?? [];
    this.pendingFix = null;
    // Where the gate stood when this turn started (from the review / gate run that produced the
    // selection): the closing review card is only worth a card when these numbers moved.
    const before = this.lastGate ? { ...this.lastGate } : null;
    t.kind = "instruction"; t.headline = "fix findings";
    if (this.mode !== "build" || !this.buildSession) {
      this.d.emit({ kind: "system", text_key: "system.run_unavailable", params: { reason: this.mode !== "build" ? "mode is not build" : "no build session" }, severity: "warning" });
      t.status = "done"; this.finishTurn(t, started); return;
    }
    // What of the selection this turn can act on. A `KICAD_*` row is folded into the engine finding
    // on the same object when the selection holds one; everything else the fix path has no repair
    // for is named in the stream instead of disappearing between the card and the turn.
    const triage = triageFixSelection(findings);
    const target = this.sheetFileFor(triage.fixable.map((f) => f.sheet)) ?? this.d.sheets()[0] ?? "";
    const env = { ...sessionCeiling(this.d.settings().agent.session_ceiling_components_added || SESSION_CEILING_COMPONENTS_ADDED_DEFAULT, this.d.sheets(), this.rails()), allowed_ops: [] as string[] };
    let info: { turn: number; effective_envelope: Envelope; ceiling_source: string; checkpoint_pending: boolean } | null = null;
    try { info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: "instruction", headline: t.headline, plan_step: null, envelope: env, inherit_from_turn: null, mode: "build" } }); } catch (e) { this.d.emit({ kind: "error", turn: t.turn, error: { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" } }); }
    if (!info) { t.status = "abandoned"; this.finishTurn(t, started); return; }
    state.began = true; t.began_in_rust = true; state.kind = "instruction"; state.envelope = info.effective_envelope; t.envelope = info.effective_envelope;
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: "instruction", mode: this.mode, headline: t.headline, envelope: info.effective_envelope });
    this.d.emit({ kind: "phase", turn: t.turn, role: "fixer", phase: "building" });
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    // The fix path applies to one target file: findings that resolve to another sheet are left for a
    // second `/fix` and said so, rather than being silently dropped on the floor.
    const elsewhere = triage.fixable.filter((f) => (this.sheetFileFor([f.sheet]) ?? target) !== target);
    const attempted = triage.fixable.filter((f) => !elsewhere.includes(f));
    let fixable = attempted.slice();
    if (triage.routed.length) this.d.emit({ kind: "system", text_key: "system.fix_routed", params: { n: triage.routed.length, codes: findingLabels(triage.routed.map((r) => r.row)) }, severity: "info" });
    if (triage.dropped.length) this.d.emit({ kind: "system", text_key: "system.fix_not_fixable", params: { n: triage.dropped.length, codes: findingLabels(triage.dropped) }, severity: "warning" });
    if (elsewhere.length) this.d.emit({ kind: "system", text_key: "system.fix_other_sheets", params: { sheet: target, n: elsewhere.length, sheets: [...new Set(elsewhere.map((f) => this.sheetFileFor([f.sheet]) ?? f.sheet ?? "?"))].join(", ") }, severity: "warning" });
    let applied = false;
    if (fixable.length && await this.runErcFix(target, fixable, ctx, bus, state, t)) applied = true;
    for (let round = 0; round < 2 && fixable.length; round++) {
      const g = await this.guarded("gate.run", {}, ctx, bus, state, t);
      const now = extractFindings(g.data);
      const keys = new Set(fixable.map((f) => `${f.code}|${f.location ?? ""}`));
      fixable = now.filter((f) => keys.has(`${f.code}|${f.location ?? ""}`));
      if (!fixable.length) break;
      const rep = await this.runFixer({ protocol_version: 1, groups: {}, ops: [] }, fixable, target, "pre_apply", t, ctx);
      if (!rep) break;
      const a = await this.guarded("sch.apply", { oplist: rep, target, expected_merges: [], note: `fix findings round ${round + 1}` }, ctx, bus, state, t);
      if (!a.ok || (a.data as { applied?: boolean })?.applied === false) break;
      applied = true;
    }
    const g = await this.guarded("gate.run", {}, ctx, bus, state, t);
    const remaining = extractFindings(g.data);
    const left = attempted.filter((x) => remaining.some((f) => f.code === x.code && (f.location ?? "") === (x.location ?? "")));
    // The line names the sheet the repairs went to (`sheetFileFor` picked it by plurality) and what of
    // the selection is still open, so the human is not left guessing which file this turn touched.
    this.d.emit({ kind: "system", text_key: "system.fix_done", params: { fixed: Math.max(0, attempted.length - left.length), remaining: remaining.length, sheet: target, codes: left.length ? findingLabels(left) : "-" }, severity: "info" });
    // A fix turn closes with the same verdict card `/review` ends on, built from this turn's engine
    // gate and KiCad ERC (no model call), whenever the gate counts moved.
    const post = applied ? await this.postTurnGate(t) : null;
    if (post && (!before || before.errors !== this.lastGate?.errors || before.warnings !== this.lastGate?.warnings)) {
      const kicadRows = (post.kicad?.rows ?? []) as (Finding & { origin: string })[];
      this.reviewCard(t, "card.review_after_fix", post.findings, kicadRows, { kicadNote: post.kicad && !post.kicad.available ? (post.kicad.note ?? "unavailable") : "" });
    }
    t.status = "done";
    this.finishTurn(t, started);
  }

  private async runErcFix(target: string, findings: Finding[], ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<boolean> {
    // Findings carry the sheet file they live on; the repair is applied per file. Using the last apply's
    // target for everything deleted the dangling sheet pins on the root sheet and left the child's
    // hierarchical labels untouched (they were on another file), in a real run.
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
      const file = typeof f.file === "string" && f.file ? f.file : target;
      const list = byFile.get(file) ?? [];
      list.push(f);
      byFile.set(file, list);
    }
    // A PWR_FLAG asserts that a rail has a source ERC cannot see, so it is never placed on a guess:
    // ask the engine what the members of the undriven nets are, and place one only where the
    // schematic itself names the source (a connector pin, a regulator output). Findings left without
    // a flag stay in the list and go to the Fixer with the existing hint.
    const parts = await this.partFacts(findings);
    let any = false;
    for (const [file, list] of byFile) {
      const rd = await this.engineDirect({ kind: "read", sheet: file, limit: 4000 }).catch(() => null);
      const labels = ((rd?.ok ? (rd.data as { labels?: LabelRow[] }).labels : []) ?? []);
      const ops = ercFixOps(list, labels, parts);
      if (!ops) continue;
      const a = await this.harnessApply({ oplist: ops, target: file, expected_merges: [], note: ops.note }, ctx, bus, state, t);
      const ok = a.ok && (a.data as { applied?: boolean })?.applied !== false;
      this.d.emit({ kind: "status", turn: t.turn, text: ok ? `ercfix: ${ops.ops.map((o) => String(o.op)).join(", ")}` : `ercfix refused: ${a.error?.message ?? (a.data as { refusal?: string })?.refusal ?? "unknown"}` });
      // Every automatic PWR_FLAG is named in the stream: it is an engineering assertion, not bookkeeping.
      const flags = ok ? ops.ops.filter((o) => o.op === "place_pwr_flag").map((o) => String(o.at)) : [];
      if (flags.length) this.d.emit({ kind: "system", text_key: "system.pwr_flag_auto", params: { pins: flags.join(", ") }, severity: "info" });
      any = any || ok;
    }
    return any;
  }

  /** `sch.component` facts (lib_id, pin types) for the parts an ERC finding's net touches. */
  private async partFacts(findings: Finding[]): Promise<Record<string, PartFacts>> {
    const refs = new Set<string>();
    for (const f of findings) if (f.code === "ERC_POWER_IN_UNDRIVEN") for (const r of f.refs ?? []) { const ref = r.split(".")[0]; if (ref && !ref.startsWith("#")) refs.add(ref); }
    const out: Record<string, PartFacts> = {};
    for (const ref of [...refs].slice(0, 24)) {
      const r = await this.engineDirect({ kind: "component", reference: ref, unit: null }).catch(() => null);
      if (!r?.ok) continue;
      const d = r.data as { lib_id?: unknown; pins?: unknown };
      out[ref] = { lib_id: typeof d.lib_id === "string" ? d.lib_id : undefined, pins: Array.isArray(d.pins) ? (d.pins as { number?: string; type?: string }[]) : [] };
    }
    return out;
  }

  /**
   * The floorplan regions of the plan's blocks on `target`. This is the union a wiring / gate step's
   * stylist pass may tidy: every rectangle in it comes from the approved plan, so the pass can never
   * reach a part the plan did not put there.
   */
  private blockRegionsOn(target: string): { id: string; summary?: string; region: Box }[] {
    const plan = this.plan;
    if (!plan) return [];
    const out: { id: string; summary?: string; region: Box }[] = [];
    for (const b of plan.blocks) {
      if (b.sheet !== target) continue;
      const fp = plan.floorplan[target]?.find((g) => g.group === b.id) ?? defaultRegion(plan, b.id, target);
      const [ox, oy] = fp.origin_mil;
      const [w, h] = fp.extent_mil;
      out.push({ id: b.id, summary: b.summary, region: [[ox, oy], [ox + w, oy + h]] });
    }
    return out;
  }

  /**
   * Mechanical tidy-up of the given block regions: no model, no new component, nothing outside a region
   * the approved plan declared. Up to `STYLIST_ROUNDS` attempts, each recomputed from the engine's own
   * `check.style` / `check.layout` findings (red line 6: the verdict is never the harness's) and laid out
   * a little wider than the one before, so a retry is a new attempt and not a replay of what did not help.
   * Returns what is still open in those regions, for the caller to report — a text collision that survives
   * three moves is the user's to see, not the harness's to hide (it used to be applied and forgotten).
   */
  private async stylistPass(target: string, regions: { id: string; summary?: string; region: Box }[], frame: { bboxMil: Box | null; sheetTitle?: string }, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord, opts: { delivery?: boolean } = {}): Promise<{ applied: boolean; unresolved: Finding[] }> {
    if (!regions.length) return { applied: false, unresolved: [] };
    const mine = (f: Finding) => LAYOUT_CODES.has(f.code) || (!!opts.delivery && STYLIST_DELIVERY_CODES.has(f.code));
    const open = (fs: Finding[]) => fs.filter((f) => mine(f) && regions.some((r) => findingInRegion(f, r.region)));
    let findings = await this.styleFindings(target, ctx, bus, state, t, opts);
    let applied = false;
    let fingerprint = layoutFingerprint(open(findings));
    for (let attempt = 0; attempt < STYLIST_ROUNDS; attempt++) {
      const ops: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      // Where the parts are right now, from the engine (never derived here): without it the pass can
      // only ask for a re-lay, and `arrange_group` skips every wired symbol — which is how a wired
      // block used to answer six layout findings with an op-list that moved nothing.
      const geom = await this.sheetGeom(target, findings);
      for (const r of regions) {
        // Framing and the title block belong to the block's own first pass; a retry only moves things.
        const so = stylistOps({
          block: { id: r.id, summary: r.summary }, findings, region: r.region, attempt, geom,
          bboxMil: attempt === 0 ? frame.bboxMil : null,
          ...(attempt === 0 && frame.sheetTitle ? { sheetTitle: frame.sheetTitle } : {}),
        });
        // Several regions on one sheet can ask for the same op (the sheet's title block): send it once.
        for (const op of so?.ops ?? []) { const k = canonicalJson(op); if (!seen.has(k)) { seen.add(k); ops.push(op); } }
      }
      if (!ops.length) break;
      this.d.emit({ kind: "attention", turn: t.turn, role: "lead", label: "tidying", region_mil: regions[0].region, sheet: target });
      const a = await this.harnessApply({ oplist: { protocol_version: 1, groups: {}, ops, note: STYLIST_NOTE }, target, expected_merges: [], note: STYLIST_NOTE }, ctx, bus, state, t);
      const ad = (a.data ?? {}) as { applied?: boolean; refusal?: string | null };
      if (!a.ok || ad.applied === false) {
        this.d.emit({ kind: "status", turn: t.turn, text: `tidy skipped: ${(ad.refusal ?? a.error?.message ?? "refused").slice(0, 120)}` });
        break;
      }
      applied = true;
      this.d.emit({ kind: "status", turn: t.turn, text: `tidied ${regions.map((r) => r.id).join(", ")}: ${ops.map((o) => String(o.op)).join(", ")}` });
      findings = await this.styleFindings(target, ctx, bus, state, t, opts);
      const next = layoutFingerprint(open(findings));
      // A round that changed nothing and had nothing to escalate (no re-lay) would repeat itself verbatim.
      if (next === fingerprint && !ops.some((o) => o.op === "arrange_group")) break;
      fingerprint = next;
    }
    return { applied, unresolved: open(findings) };
  }

  /**
   * Layout findings the stylist could not clear. The old policy shipped them in silence ("at most one
   * move attempt, then apply anyway"); they are reported instead, so what the user is handed and what
   * the schematic actually looks like agree.
   */
  private reportUnresolvedLayout(step: string, unresolved: Finding[], t: TurnRecord): void {
    if (!unresolved.length) return;
    // On the turn as well as in the stream: a draft step runs no full gate of its own, so without this
    // the message would name findings the findings panel never received.
    this.pushFindings(t, unresolved);
    this.d.emit({ kind: "findings", turn: t.turn, findings: unresolved });
    this.d.emit({ kind: "system", text_key: "system.layout_unresolved", params: { step, n: unresolved.length, codes: findingLabels(unresolved) }, severity: "warning" });
  }

  /**
   * The sheet's current geometry for the stylist: every symbol's origin and label anchor (`read`),
   * plus the body boxes of the parts the findings name (`bbox`). Two read-only engine calls, no
   * judgement of any kind — the numbers are the engine's, the harness only arranges them by
   * reference. A failed call yields no geometry, and the pass falls back to the re-lay.
   */
  private async sheetGeom(target: string, findings: Finding[]): Promise<StylistGeom | undefined> {
    const refs = [...new Set(findings.flatMap((f) => (f.refs ?? []).map(designatorOf)).filter(Boolean))];
    const r = await this.engineDirect({ kind: "read", sheet: target || null, limit: 2000 }).catch(() => null);
    if (!r?.ok) return undefined;
    const d = (r.data ?? {}) as { symbols?: { reference?: unknown; x_mil?: unknown; y_mil?: unknown }[]; labels?: { uuid?: unknown; x_mil?: unknown; y_mil?: unknown }[]; wires?: { from?: unknown; to?: unknown }[] };
    const at: Record<string, [number, number]> = {};
    for (const s of d.symbols ?? []) {
      if (typeof s?.reference !== "string" || typeof s.x_mil !== "number" || typeof s.y_mil !== "number") continue;
      at[s.reference] = [s.x_mil, s.y_mil];
    }
    const labelAt: Record<string, [number, number]> = {};
    for (const l of d.labels ?? []) {
      if (typeof l?.uuid !== "string" || typeof l.x_mil !== "number" || typeof l.y_mil !== "number") continue;
      labelAt[l.uuid] = [l.x_mil, l.y_mil];
    }
    const box: Record<string, Box> = {};
    if (refs.length) {
      const b = await this.engineDirect({ kind: "bbox", refs }).catch(() => null);
      for (const it of ((b?.ok ? (b.data as { items?: { ref?: unknown; bbox_mil?: unknown }[] }).items : []) ?? [])) {
        if (typeof it?.ref === "string" && Array.isArray(it.bbox_mil)) box[it.ref] = it.bbox_mil as Box;
      }
    }
    // The wires the sheet carries: a move drags the ends on the moved pins along, so the pass needs
    // them to nudge a wired part along its wire's own axis instead of across it.
    const isPt = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number");
    const wires: { from: [number, number]; to: [number, number] }[] = [];
    for (const w of d.wires ?? []) if (isPt(w?.from) && isPt(w?.to)) wires.push({ from: w.from, to: w.to });
    return { at, box, labelAt, wires };
  }

  /**
   * `check.style` + `check.layout` findings on one sheet (tolerant: a missing family is just empty).
   * `delivery` adds the codes the stylist repairs that only the delivery family reports (`DECAP_FAR`,
   * which needs the netlist): the gate step asks for them, the per-step passes do not pay for them.
   */
  private async styleFindings(target: string, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord, opts: { delivery?: boolean } = {}): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const fam of ["check.style", "check.layout"]) {
      if (!toolDef(fam)) continue;
      const r = await this.guarded(fam, { sheet: target }, ctx, bus, state, t);
      if (r.ok) out.push(...extractFindings(r.data));
    }
    if (opts.delivery && toolDef("gate.run")) {
      // `DECAP_FAR` needs the netlist, so no per-family check reports it: `gate.run` is where the
      // delivery family lives. Only the codes this pass has an op for, and only on this sheet — the
      // rest of the gate's report is the gate's to make, not the stylist's to carry around.
      const r = await this.guarded("gate.run", {}, ctx, bus, state, t);
      if (r.ok) out.push(...extractFindings(r.data).filter((f) => STYLIST_DELIVERY_CODES.has(f.code) && !isWaived(f) && (!f.file || !target || f.file === target)));
    }
    return out;
  }

  /** Librarian/Sourcer pass of the harness-driven step: fill `lib_id`/`footprint`/`resolved` on the block parts. */
  /** lib_ids the project resolved earlier in this session: the same part in a later block costs no engine call. */
  private resolvedLibIds = new Set<string>();
  private async resolveBlockParts(block: DesignPlan["blocks"][number], ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<void> {
    const partsEnabled = !!this.d.settings().parts?.enabled;
    for (const p0 of block.parts) {
      const p = p0 as unknown as Record<string, unknown>;
      // `resolved: true` from the Architect is a claim; verify every lib_id against the index.
      const lib = typeof p.lib_id === "string" ? p.lib_id : "";
      if (lib) {
        if (this.resolvedLibIds.has(lib)) { p.resolved = true; continue; }
        const r = await this.engineDirect({ kind: "lib_resolve", lib_id: lib });
        if (r.ok && (r.data as { state?: string }).state !== "none") { p.resolved = true; this.resolvedLibIds.add(lib); continue; }
        // The model often drops the nickname or misspells it: look the symbol name up in the index.
        const tail = lib.includes(":") ? lib.slice(lib.lastIndexOf(":") + 1) : lib;
        const sr = await this.engineDirect({ kind: "lib_search", query: tail, limit: 8 });
        const rows = sr.ok ? ((sr.data as { results?: { lib_id: string; name: string }[] }).results ?? []).filter((x) => x.name.toLowerCase() === tail.toLowerCase()) : [];
        if (rows.length === 1) {
          // The index is global (it also lists the shared parts library); the *project* must be able to
          // resolve the id, otherwise the apply fails with SYMBOL_NOT_FOUND. A shared-library hit that the
          // project cannot see yet is imported through parts.convert (served from the cache).
          const chk = await this.engineDirect({ kind: "lib_resolve", lib_id: rows[0].lib_id });
          if (chk.ok && (chk.data as { state?: string }).state !== "none") { p.lib_id = rows[0].lib_id; p.resolved = true; this.d.emit({ kind: "status", turn: t.turn, text: `${String(p.ref_prefix ?? "")}: ${lib} -> ${rows[0].lib_id}` }); continue; }
          const nick = rows[0].lib_id.split(":")[0];
          if (partsEnabled && (nick === "jlc" || nick === "fluxsmith-parts" || nick === String(this.d.settings().parts?.lib_nickname ?? "jlc"))) {
            try {
              const cached = (await call("db_query", { query: { kind: "parts_cache_list", query: rows[0].name } })) as { lcsc: string; mpn: string }[];
              const hit = Array.isArray(cached) ? cached.find((r) => r.mpn.toLowerCase() === rows[0].name.toLowerCase()) ?? cached[0] : undefined;
              if (hit) { p.lcsc = hit.lcsc; }
            } catch { /* fall through to the catalogue */ }
          }
        }
      }
      if (!partsEnabled) continue;
      let lcsc = [p.lcsc, p.LCSC, p.lcsc_id].find((v) => typeof v === "string" && /^C\d+$/i.test(v as string)) as string | undefined;
      if (!lcsc) {
        // Only specific parts go to LCSC: an MPN, or a non-generic lib_id that the KiCad libraries lack.
        // Generic passives/connectors stay with KiCad symbols (the Drafter picks Device:R etc.).
        const libTail = lib.includes(":") ? lib.slice(lib.lastIndexOf(":") + 1) : lib;
        const generic = !lib || /^(Device|Connector_Generic|Switch|Jumper|Mechanical|power):/.test(lib);
        const q = [p.mpn, p.part_number, generic ? undefined : libTail].find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;
        if (!q) continue;
        // Shared parts library first: a part fetched for any earlier project needs no network.
        try {
          const cached = (await call("db_query", { query: { kind: "parts_cache_list", query: q } })) as { lcsc: string; mpn: string }[];
          const exact = Array.isArray(cached) ? cached.find((r) => r.mpn.toLowerCase() === q.toLowerCase()) ?? (cached.length === 1 ? cached[0] : undefined) : undefined;
          if (exact) { lcsc = exact.lcsc; this.d.emit({ kind: "status", turn: t.turn, text: `${String(p.ref_prefix ?? "")}: ${q} found in the shared parts library (${exact.lcsc})` }); }
        } catch { /* cache unavailable: fall through to the catalogue */ }
      }
      if (!lcsc) {
        const libTail = lib.includes(":") ? lib.slice(lib.lastIndexOf(":") + 1) : lib;
        const generic = !lib || /^(Device|Connector_Generic|Switch|Jumper|Mechanical|power):/.test(lib);
        const q = [p.mpn, p.part_number, generic ? undefined : libTail].find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;
        if (!q) continue;
        const sr = await this.guarded("parts.search", { query: q, in_stock: true, limit: 5 }, ctx, bus, state, t);
        const hits = sr.ok ? ((sr.data as { results?: { lcsc: string; basic?: boolean; stock?: number }[] }).results ?? []) : [];
        const pick = hits.find((h) => h.basic) ?? hits[0];
        if (!pick) continue;
        lcsc = pick.lcsc;
      }
      const cv = await this.guarded("parts.convert", { lcsc }, ctx, bus, state, t);
      if (cv.ok) {
        const d = cv.data as { lib_id?: string; footprint?: string };
        if (d.lib_id) { p.lib_id = d.lib_id; p.footprint = d.footprint ?? p.footprint; p.resolved = true; p.claim = true; p.lcsc = lcsc; }
        this.d.emit({ kind: "status", turn: t.turn, text: `${String(p.ref_prefix ?? "")}: LCSC ${lcsc} -> ${d.lib_id ?? "?"}` });
      }
    }
    if (this.plan) void call("sidecar_write", { project_key: this.d.projectKey, write: { kind: "plan", plan: this.plan } }).catch(() => undefined);
  }

  /**
   * Create the sheet files a step needs but the project does not have, using the plan's own `sheets[]`
   * entry (the same `sheet.create` the scaffold step runs, with the same interface pins). A file the
   * plan does not declare is not invented here — the plan decides what exists.
   */
  private async scaffoldMissingSheets(missing: string[], plan: DesignPlan, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<{ ok: boolean; reason?: string }> {
    const declared = missing.map((m) => plan.sheets.find((s) => sheetMatches(s.file, m))).filter((s): s is DesignPlan["sheets"][number] => !!s);
    if (declared.length !== missing.length) return { ok: false };
    // Creating a file the approved plan declares is inside the plan whichever step discovers it missing —
    // but only a scaffold step's envelope carries the structural entries (`stepEnvelope`), and the ones
    // `runPlanStepTurn` adds are keyed on the app's cached sheet list, which can disagree with the engine
    // summary this repair is driven by. Add exactly the entries for the files being created (both
    // spellings: the hooks say `create_sheet:`, Rust says `add_sheet:`), so P2 lets the plan's own repair
    // through instead of turning it into a structural hard stop, and put the step's envelope back after.
    const envBefore = state.envelope;
    if (envBefore) {
      const want = declared.flatMap((sh) => [`create_sheet:${sh.file}`, `add_sheet:${sh.file}`]).filter((x) => !envBefore.structural.includes(x));
      if (want.length) state.envelope = { ...envBefore, structural: [...envBefore.structural, ...want] };
    }
    try {
      return await this.createPlanSheets(declared, plan, ctx, bus, state, t);
    } finally {
      if (envBefore) state.envelope = envBefore;
    }
  }

  /** The `sheet.create` calls themselves; the envelope they run under is `scaffoldMissingSheets`'s business. */
  private async createPlanSheets(declared: DesignPlan["sheets"], plan: DesignPlan, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<{ ok: boolean; reason?: string }> {
    for (const sh of declared) {
      const inst = sh.instances?.[0];
      const pins = interfacePins(plan, sh.file);
      const perSide = Math.max(pins.filter((p) => p.side === "left").length, pins.filter((p) => p.side === "right").length);
      const res = await this.guarded("sheet.create", { file: sh.file, name: inst?.name ?? sh.file.replace(/\.kicad_sch$/, ""), at_mil: inst?.at_mil ?? [1000, 1000], size_mil: [2000, Math.max(1500, (perSide + 1) * SHEET_PIN_PITCH_MIL)], pins, paper: sh.paper ?? null, parent: sh.parent ?? null }, ctx, bus, state, t);
      if (!res.ok) return { ok: false, reason: res.error?.message };
      this.d.emit({ kind: "status", turn: t.turn, text: `created missing sheet ${sh.file}` });
    }
    return { ok: true };
  }

  /**
   * Pause the plan on this step instead of skipping it. A precondition no later step can satisfy either
   * (a sheet file that is not there) would otherwise fail every remaining step, re-billing a full draft
   * each time. The step stays open, so `/continue` resumes here once the cause is fixed; the pause is
   * reported once through the `stop` path in `runPlanStepTurn` (`system.plan_paused`).
   */
  private stepPause(reason: string, state: TurnPolicyState, t: TurnRecord): StepOutcome {
    this.planStop = { step: state.step, condition: "unresolved", reason: reason.slice(0, 300), resume: false };
    this.stepNotes.set(state.step, reason.slice(0, 300));
    this.d.emit({ kind: "status", turn: t.turn, text: reason.slice(0, 200) });
    // A pause ends the run: the human has to do something about the cause, so it gets a card of its own and
    // not only the status line and the `system.plan_paused` message that follow it. The card asks nothing
    // (it is emitted, never awaited), so an Auto run is not blocked by it.
    this.d.emit({ kind: "card", card: systemCard(t.turn, "system.plan_paused", { step: state.step, reason: reason.slice(0, 300) }, [{ id: "dismiss", label_key: "card.dismiss", style: "secondary" }]) });
    return { ok: false, applied: false, reason };
  }

  private async stepFail(condition: HardStopCondition, reason: string, state: TurnPolicyState, t: TurnRecord, alreadyCarded = false): Promise<StepOutcome> {
    // A step that failed because the user stopped is not a hard stop: no card, no Auto adjudication.
    if (this.stopping || this.zombie(t)) return { ok: false, applied: false, reason };
    // Adjudicated as `stop` (budget, environment, provider, context): never a skip, under any policy.
    // Auto means "do not ask", not "carry on without a provider" — with the condition still true the
    // remaining steps would each fail, be skipped, and the plan would report itself done. Instead the
    // plan pauses here: the step stays open, so a later `/continue` resumes at it.
    const stopClass = adjudicate({ condition, step: state.step, mode: this.mode, retried: true })?.action === "stop";
    if (stopClass) {
      this.planStop = { step: state.step, condition, reason: reason.slice(0, 300), resume: false };
      // Every stop-class condition is a `stop_reason` (the runtime check is what narrows it here).
      t.stop_reason = condition as NonNullable<TurnRecord["stop_reason"]>;
      this.stepNotes.set(state.step, reason.slice(0, 300));
    }
    if (!stopClass && this.effectivePolicy() === "auto" && alreadyCarded) {
      // hardStop already adjudicated and recorded this decision (auto_decisions, tracker, skipped set): report
      // it once here and hand it back as the step's skip, so `runPlanStepTurn` does not emit a second
      // `system.auto_step_skipped` for the very same skip.
      this.d.emit({ kind: "system", text_key: "system.auto_step_skipped", params: { step: state.step, reason: reason.slice(0, 300) }, severity: "warning" });
      this.stepNotes.set(state.step, reason.slice(0, 300));
      return { ok: false, applied: false, reason, reported: true };
    }
    if (!stopClass && this.effectivePolicy() === "auto") {
      const dec = adjudicate({ condition, step: state.step, mode: this.mode, retried: true });
      if (dec && dec.action !== "stop") {
        const pause = this.autoTracker?.record(dec) ?? false;
        this.d.emit({ kind: "system", text_key: "system.auto_step_skipped", params: { step: state.step, reason: reason.slice(0, 300) }, severity: "warning" });
        if (pause && !this.autoSkipsWarned.has(t.turn)) { this.autoSkipsWarned.add(t.turn); this.d.emit({ kind: "system", text_key: "system.auto_skips", params: { decisions: this.autoTracker?.skipped ?? t.auto_decisions.length }, severity: "warning" }); }
        this.stepNotes.set(state.step, reason.slice(0, 300));
        return { ok: false, applied: false, skipped: { ...dec, detail: reason } };
      }
    }
    if (!alreadyCarded) {
      const card = condition === "provider_exhausted"
        ? providerStopCard(t.turn, { reason, step: state.step })
        : hardStopCard(t.turn, condition.replace(/_a$|_b$/, ""), { reason, step: state.step }, undefined, "unresolved");
      const r = await this.askCard(card, state, t);
      if (r.action_id === "abandon") { this.stopRequested = true; t.status = "abandoned"; }
      // "Retry now" on a provider stop: the step is still open, so the runner re-queues it below.
      else if (stopClass && r.action_id === "retry_now" && this.planStop) this.planStop.resume = true;
    }
    return { ok: false, applied: false, reason };
  }

  /** Execute a tool through the hook bus (harness-driven path). */
  /** Counts of the newest full gate run (engine findings, never harness judgement); a clean gate reports zeros. */
  private lastGate: { errors: number; warnings: number } | null = null;
  private noteGate(findings: Finding[]): void {
    // Waived rows travel with the gate so the panel can show them, but the engine already left them
    // out of its verdict: they stay out of these counts too.
    const open = findings.filter((x) => !isWaived(x));
    this.lastGate = { errors: open.filter((x) => x.severity === "Error").length, warnings: open.filter((x) => x.severity === "Warning").length };
  }
  /** Last KiCad ERC run of this session, and the write it was run after (so one write is asked once). */
  private lastKicad: KicadTurnResult | null = null;
  private lastKicadRun: { seq: number; res: KicadErcResult } | null = null;
  /** Applies committed in this session; `kicadErc` reuses its result while it has not moved. */
  private writeSeq = 0;
  /**
   * Params of `system.plan_done`: the engine's open findings, what KiCad's own ERC said (or
   * `system.plan_done_kicad_missing` when it did not run — never silence, which would read as clean)
   * and how the plan's typed acceptance stands (`system.plan_done_acceptance`; the plan may have
   * declared none the engine can answer).
   */
  private openFindingCounts(): { errors: number; warnings: number; kicad_errors: number; kicad_warnings: number; kicad_key: string; acceptance_passed: number; acceptance_failed: number; acceptance_na: number; acceptance_key: string } {
    const gate = this.lastGate ?? { errors: 0, warnings: 0 };
    const k = this.lastKicad;
    const a = acceptanceCounts([...this.planAcceptance.values()].flat());
    return {
      ...gate, kicad_errors: k?.errors ?? 0, kicad_warnings: k?.warnings ?? 0,
      kicad_key: k?.available ? "system.plan_done_kicad" : "system.plan_done_kicad_missing",
      acceptance_passed: a.passed, acceptance_failed: a.failed, acceptance_na: a.na,
      acceptance_key: acceptanceDoneKey(a),
    };
  }

  /** Record engine findings on the turn once per (code, location): a re-check reports the same finding again. */
  private pushFindings(t: TurnRecord, findings: Finding[]): void {
    const keyOf = (f: Finding) => `${f.code}|${f.location ?? ""}|${f.message ?? ""}`;
    const seen = new Set((t.findings as Finding[]).map(keyOf));
    for (const f of findings) { const k = keyOf(f); if (!seen.has(k)) { seen.add(k); t.findings.push(f); } }
  }

  /** The user pressed Stop (or the turn was aborted): every later harness step short-circuits with this result. */
  private stoppedResult(): ToolResult {
    return { ok: false, error: { code: "USER_STOPPED", message: "the user stopped the turn" }, meta: { bytes: 0 }, trust: "untrusted" };
  }
  private get stopping(): boolean { return this.stopRequested || !!this.abort?.signal.aborted; }

  /** The pending P3/P11 verdict with the op-list sha the refused sch.plan reported (the waiver is bound to it in Rust). */
  private boundDenied(): Extract<HookVerdict, { kind: "deny" }> {
    const v = this.planDenied!.verdict;
    const sha = this.planDenied!.ops_sha256;
    return sha ? { ...v, card_payload: { ...(v.card_payload ?? {}), ops_sha256: sha } } : v;
  }

  /** A turn force-stopped by the user (`forceFinish`) keeps running until its awaited call returns: nothing it does afterwards may touch tools. */
  private zombie(t: TurnRecord): boolean { return t.gen !== undefined && t.gen !== this.turnGen; }

  /** The harness's own op-list (ercfix, stylist, title block): hooks may trust its `kind` tags / replay exemptions. */
  private async harnessApply(args: Record<string, unknown>, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<ToolResult> {
    // Normalised before the sha is taken: `guarded` normalises again (idempotently), and the sha the hooks
    // compare against must be the one of the list they are handed, or `isHarnessList` stops recognising it.
    const a = hookCallArgs(args, this.d.sheets());
    state.harnessOplistSha = sha256Hex(canonicalJson(a.oplist));
    try { return await this.guarded("sch.apply", a, ctx, bus, state, t); } finally { state.harnessOplistSha = null; }
  }

  private async guarded(name: string, args: Record<string, unknown>, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<ToolResult> {
    if (this.zombie(t)) return { ok: false, error: { code: "TURN_FORCED_END", message: "the turn was force-stopped by the user; this call is ignored" }, meta: { bytes: 0 }, trust: "untrusted" };
    if (this.stopping) return this.stoppedResult();
    const def = toolDef(name)!;
    const id = localId("call");
    // Same normalisation as the model path (see `beforeHook`): hooks, Rust and the engine all inspect the
    // op-list in the form the registry will send it in.
    args = hookCallArgs(args, this.d.sheets());
    this.guardCarded = false;
    if (isDTier(name) && !state.checkpointed) {
      try { const cp = await call("checkpoint_create", { project_key: this.d.projectKey, turn: t.turn, kind: "turn" }); state.checkpointed = true; t.checkpoint = cp.turn; } catch (e) { return { ok: false, error: { code: "CHECKPOINT_FAILED", message: String(e) }, meta: { bytes: 0 }, trust: "untrusted" }; }
    }
    if (this.effectivePolicy() === "ask" && (name === "sch.apply" || name === "sch.apply_waived")) {
      const insp = inspectOplist(args.oplist, []);
      const card = changeCard(t.turn, { tool: name, target: args.target }, { authored: insp.ops.length, expanded: 0, added: insp.components_added, deleted: insp.components_deleted, wires: insp.wires_added }, this.lastPlanNotes, null);
      const r = await this.askCard(card, state, t);
      if (r.action_id !== "apply") return { ok: false, error: { code: "USER_SKIPPED", message: `user chose ${r.action_id}` }, meta: { bytes: 0 }, trust: "untrusted" };
    }
    const { verdict } = bus.before({ id, name, args, role: "lead", index: 0, siblings: [{ name }] });
    if (verdict.kind === "deny" && verdict.policy_id === "P9") {
      // Style injections are for the model-driven loop; on the harness path the Drafter already read
      // the skill and post-apply findings (RAIL_SCOPE_SPLIT ...) go to the Fixer, so P9 only reports.
      this.d.emit({ kind: "status", turn: t.turn, text: `style: ${verdict.reason.slice(0, 160)}` });
    } else if (verdict.kind === "deny") {
      void this.d.persistence.ledger(t.turn, state.step, "denied", { tool: name, policy_id: verdict.policy_id, reason: verdict.reason.slice(0, 500), hard_stop: verdict.hard_stop ?? null, path: "harness" }).catch(() => undefined);
      if (verdict.hard_stop) { const r = await this.hardStop(verdict, state, t, name); if (r?.block) { this.guardCarded = true; return { ok: false, error: { code: verdict.policy_id, message: verdict.reason }, meta: { bytes: 0 }, trust: "untrusted" }; } }
      else return { ok: false, error: { code: verdict.policy_id, message: verdict.reason }, meta: { bytes: 0 }, trust: "untrusted" };
    }
    if (verdict.kind === "retry_with" && verdict.policy_id !== "P9") return { ok: false, error: { code: verdict.policy_id, message: verdict.text }, meta: { bytes: 0 }, trust: "untrusted" };
    this.turnBudget?.addToolCall(); this.planBudget?.addToolCall();
    const att = attentionOf(name, args);
    if (att) this.d.emit({ kind: "attention", turn: t.turn, role: "lead", label: att.label, refs: att.refs, region_mil: att.region_mil });
    const line: ActivityLine = { id, role: "lead", phase: def.phase as Phase, label: name, detail: argsSummary(args), started_at: nowIso(), kind: "tool" };
    this.d.emit({ kind: "activity", turn: t.turn, line });
    if ((name === "sch.apply" || name === "sch.apply_waived") && !(await this.recordIntent(args, t, state))) return { ok: false, error: { code: "LEDGER_FAILED", message: "the write-ahead record could not be written; nothing was applied" }, meta: { bytes: 0 }, trust: "untrusted" };
    const r = await executeTool(def, args, ctx);
    const text = resultText(r, capFor(name));
    const after = bus.after({ name, args, ok: r.ok, data: r.data }, text);
    if (name === "sch.plan" && r.ok) {
      this.lastPlanOpsSha = r.meta.ops_sha256 ?? null;
      this.lastPlanNotes = after.p3?.notes ?? [];
      this.expectedMerges = after.p3?.expected_merges ?? [];
      this.planDenied = after.verdict.kind === "deny" ? { verdict: after.verdict, expected: this.expectedMerges, ops_sha256: this.lastPlanOpsSha } : null;
    }
    if (name === "sch.apply" || name === "sch.apply_waived") await this.recordApply(name, args, r, t, state, id);
    // Rust is the second envelope check. On the model path `binding()` turns its refusal into the same
    // scope / structural card a P2 denial raises; the harness path had no such branch, so a plan step
    // whose apply Rust refused was skipped with no card at all under Review. ENVELOPE_SHEET_UNDECLARED is
    // excluded on purpose: `executeStep` redraws that one by itself and a card there would ask the human
    // about something the harness fixes in the next round.
    if ((name === "sch.apply" || name === "sch.apply_waived") && !r.ok && r.error && /^(ENVELOPE_|SCOPE_WIDEN)/.test(r.error.code) && r.error.code !== "ENVELOPE_SHEET_UNDECLARED") {
      const structural = /deleted|structural/i.test(r.error.message);
      this.guardCarded = true;
      await this.hardStop(deny("P2", r.error.message, { remediation: "narrow the op-list to the envelope, or the user widens the scope", hard_stop: structural ? "structural" : "scope_widen", card_payload: { code: r.error.code, evidence: r.error.evidence, problems: problemsFromEvidence(r.error.code, r.error.evidence) } }) as Extract<HookVerdict, { kind: "deny" }>, state, t, name);
    }
    if (r.ok && (name === "gate.run" || name.startsWith("check."))) { const f = extractFindings(r.data); this.pushFindings(t, f); if (name === "gate.run") this.noteGate(f); this.d.emit({ kind: "findings", turn: t.turn, findings: f, full: name === "gate.run" }); }
    this.d.emit({ kind: "activity", turn: t.turn, line: { ...line, ended_at: nowIso(), ok: r.ok, bytes: text.length } });
    t.tools.push({ name, ok: r.ok, bytes: text.length, ms: Math.max(0, Date.now() - new Date(line.started_at).getTime()) });
    // Harness-driven calls are recorded for the model as a compact header: the full body lives in the sidecar
    // transcript, and a 20-step plan run must not push megabytes of sch.plan tables into the history.
    const compactText = after.text.length > HARNESS_RESULT_HISTORY_CAP
      ? `${after.text.slice(0, HARNESS_RESULT_HISTORY_CAP)}\n[harness result truncated in history: ${after.text.length} chars; ok=${r.ok}]${/<\/untrusted>\s*$/.test(after.text) ? "\n</untrusted>" : ""}`
      : after.text;
    const h: HMessage = { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: compactText }], isError: !r.ok, meta: { turn: t.turn, task: t.task, kind: "tool" } };
    this.history.push({ role: "assistant", content: [], toolCalls: [{ id, name, args: name === "sch.apply" || name === "sch.apply_waived" ? { target: args.target, ops: ((args.oplist as { ops?: unknown[] })?.ops ?? []).length } : args }], meta: { turn: t.turn, task: t.task, kind: "tool", paired: true } }, h);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Micro edit (no model)
  // ---------------------------------------------------------------------------

  private async runMicroEdit(t: TurnRecord, m: { reference: string; field: string; value: string }, started: number): Promise<void> {
    const state = this.policyState!;
    const env = sessionCeiling(this.d.settings().agent.session_ceiling_components_added || SESSION_CEILING_COMPONENTS_ADDED_DEFAULT, this.d.sheets(), this.rails());
    let info: { turn: number; effective_envelope: Envelope } | null = null;
    try {
      info = await call("turn_begin", { begin: { project_key: this.d.projectKey, build_session: this.buildSession, kind: "instruction", headline: `set ${m.reference}.${m.field} = ${m.value}`, plan_step: null, envelope: env, inherit_from_turn: null, mode: "build" } });
    } catch (e) {
      const f = e instanceof IpcFailure ? e.error : { code: "TURN_BEGIN_FAILED", message: String(e), req_id: "" };
      if (f.code === "SESSION_EXPIRED" || f.code === "NO_BUILD_SESSION") this.onBuildExpired(t.turn);
      else this.d.emit({ kind: "error", turn: t.turn, error: f });
    }
    if (!info) { t.status = "abandoned"; this.finishTurn(t, started); return; }
    state.began = true; t.began_in_rust = true; state.kind = "instruction"; state.envelope = info.effective_envelope; t.kind = "instruction"; t.headline = `set ${m.reference}.${m.field} = ${m.value}`; t.envelope = info.effective_envelope;
    this.d.emit({ kind: "turn_started", turn: t.turn, turn_kind: "instruction", mode: "build", headline: t.headline, envelope: info.effective_envelope });
    const comp = await this.engineDirect({ kind: "component", reference: m.reference, unit: null });
    const sheet = (comp.ok ? (comp.data as { units?: { sheet_path?: string; file?: string }[]; sheet?: string }) : null);
    const target = sheet?.units?.[0]?.file ?? sheet?.sheet ?? this.d.sheets()[0];
    const oplist = { protocol_version: 1, groups: {}, sheets: [target], ops: [{ op: "set_component_parameters", reference: m.reference, parameters: { [m.field]: m.value } }], refdes_used: [] };
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    const v = await this.guarded("ops.validate", { oplist }, ctx, bus, state, t);
    if (v.ok) { const p = await this.guarded("sch.plan", { oplist, target }, ctx, bus, state, t); if (p.ok && !this.planDenied) await this.guarded("sch.apply", { oplist, target, expected_merges: [], note: t.headline }, ctx, bus, state, t); }
    if (t.applies.length) await this.postTurnGate(t);
    t.status = t.applies.length ? "done" : "abandoned";
    this.finishTurn(t, started);
  }

  // ---------------------------------------------------------------------------
  // Turn end
  // ---------------------------------------------------------------------------

  /**
   * The plan `gate` step's fix rounds: run the engine checks; ERC-class findings the Fixer can
   * address (undriven rails, unconnected pins, isolated labels) get up to two fix rounds before the
   * verdict. The engine result is the only verdict here (red line 6).
   */
  private async gateStepRounds(target: string, ctx: ToolContext, bus: HookBus, state: TurnPolicyState, t: TurnRecord): Promise<StepOutcome> {
    let applied = false;
    for (let round = 0; ; round++) {
      const g = await this.guarded("gate.run", {}, ctx, bus, state, t);
      const findings = extractFindings(g.data).filter((f) => !isWaived(f) && (f.severity === "Error" || f.severity === "Warning"));
      const fixable = findings.filter((f) => /^(ERC_|PINMAP_|POWER_|RAIL_|LABEL_|TEXT_|ROW_|FIELD_OVER_FIELD|OFF_GRID|LONG_WIRE|DECAP_FAR)/.test(f.code));
      if (g.ok && (g.data as { ok?: boolean })?.ok !== false && fixable.length === 0) return await this.gateVerdict(findings, applied, t);
      // Deterministic repairs first (PWR_FLAG on connector- or regulator-fed rails, no-connects on unused IC pins).
      if (round === 0 && await this.runErcFix(target, fixable, ctx, bus, state, t)) { applied = true; continue; }
      // The gate is a report, not a wall: after the fix rounds the plan completes and the
      // remaining findings stay visible in the summary / findings panel.
      if (round >= 2 || fixable.length === 0) { if (findings.length) this.d.emit({ kind: "findings", turn: t.turn, findings }); return await this.gateVerdict(findings, applied, t); }
      const rep = await this.runFixer({ protocol_version: 1, groups: {}, ops: [] }, fixable.map((f) => ({ ...f, remediation: `${f.remediation ?? ""} (use add_no_connect for unused pins, place_pwr_flag for rails only connectors drive, add_net_label / rename_net to line labels up)`.trim() })), target, "pre_apply", t, ctx);
      if (!rep) { this.d.emit({ kind: "findings", turn: t.turn, findings }); return await this.gateVerdict(findings, applied, t); }
      const a = await this.guarded("sch.apply", { oplist: rep, target, expected_merges: [], note: `gate fixes round ${round + 1}` }, ctx, bus, state, t);
      if (!a.ok) { this.d.emit({ kind: "findings", turn: t.turn, findings }); return await this.gateVerdict(findings, applied, t); }
      applied = true;
    }
  }

  /**
   * What the gate step reports once its fix rounds are over. The step still succeeds — the gate is a
   * report, not a wall — but the unwaived Errors it leaves behind are carried on the turn, so the
   * turn ends as `done_with_findings` instead of a bare "done" (run 11 finished "done" with three).
   * The plan's typed acceptance is evaluated here too, from engine results only (red line 6).
   */
  private async gateVerdict(findings: Finding[], applied: boolean, t: TurnRecord): Promise<StepOutcome> {
    // Red line 6 arithmetic: the engine already leaves a waived finding out of its own verdict, so it
    // stays out of this count. The rounds above filter them out, and the filter is repeated here so
    // no caller can end a turn `done_with_findings` over an Error the human waived.
    const errorsLeft = findings.filter((f) => !isWaived(f) && String(f.severity) === "Error").length;
    t.gate_errors_left = errorsLeft;
    await this.evaluatePlanAcceptance(findings, t).catch(() => undefined);
    return { ok: true, applied, errorsLeft };
  }

  /** The kind of a plan step by id (`gate`, `draft`, …); null when the turn belongs to no plan step. */
  private stepKindOf(stepId: string | null | undefined): string | null {
    if (!stepId || !this.plan) return null;
    return this.plan.steps.find((s) => s.id === stepId)?.kind ?? null;
  }

  /** The blocks the plan has drawn so far (their step is done); every block when nothing is recorded. */
  private blocksDrawnSoFar(): PlanBlock[] {
    const plan = this.plan;
    if (!plan) return [];
    const drawn = plan.blocks.filter((b) => plan.steps.some((s) => s.block === b.id && s.kind !== "gate" && this.planStepsDone.has(s.id)));
    return drawn.length ? drawn : plan.blocks;
  }

  /**
   * Evaluate every drawn block's acceptance and record it on the turn (agent-runtime.md §2). Reads
   * only: the netlist (`net_map` per sheet instance, `sch.net` where a flag is needed), symbol
   * positions (`sch.read`, only for `decoupling_near`) and the gate findings handed in. A failed
   * item is reported, never enforced.
   */
  private async evaluatePlanAcceptance(findings: Finding[], t: TurnRecord): Promise<void> {
    const blocks = this.blocksDrawnSoFar();
    if (!blocks.length || !blocks.some((b) => (b.acceptance ?? []).length)) return;
    const { nets, ctx } = await this.acceptanceEngineData(blocks);
    for (const b of blocks) this.planAcceptance.set(b.id, evaluateAcceptance(b, nets, findings, ctx));
    t.acceptance = [...this.planAcceptance.values()].flat().slice(0, ACCEPTANCE_MAX);
  }

  /** The engine reads the acceptance types of these blocks need, and nothing more. */
  private async acceptanceEngineData(blocks: PlanBlock[]): Promise<{ nets: AcceptanceNet[]; ctx: AcceptanceContext }> {
    const sum = await this.engineDirect({ kind: "summary", sheet: null });
    const rawSheets = sum.ok ? (sum.data as { sheets?: unknown }).sheets : undefined;
    const sheets: { path?: string; file?: string }[] = Array.isArray(rawSheets) ? (rawSheets as { path?: string; file?: string }[]) : [];
    const paths = [...new Set(sheets.map((s) => s.path).filter((p): p is string => !!p))].slice(0, ACCEPTANCE_SHEETS_MAX);
    // `net_map` is the only request that hands out pin membership for a whole sheet (`REF.PIN` -> net).
    const byName = new Map<string, AcceptanceNet>();
    const labeled = new Set<string>();
    for (const p of paths.length ? paths : ["/"]) {
      const nm = await this.engineDirect({ kind: "net_map", sheet: p });
      if (!nm.ok) continue;
      const d = nm.data as { pins?: Record<string, string>; labels?: Record<string, string> };
      for (const [member, net] of Object.entries(d.pins ?? {})) {
        const e = byName.get(net) ?? { name: net, members: [] };
        if (!e.members.includes(member)) e.members.push(member);
        byName.set(net, e);
      }
      for (const net of Object.values(d.labels ?? {})) labeled.add(net);
    }
    for (const [name, n] of byName) { n.members.sort(); n.labeled = labeled.has(name); }
    const nets = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // `no_connect` is a per-net flag only `sch.net` reports; read it for the pins the plan names.
    const wanted = new Set<string>();
    for (const { prefix, pin } of acceptanceNoConnectPins(blocks)) {
      for (const n of nets) for (const m of n.members) {
        const s = splitMember(m);
        if (s && s.pin.toUpperCase() === pin.toUpperCase() && refMatchesPrefix(s.ref, prefix)) wanted.add(n.name);
      }
    }
    for (const name of [...wanted].slice(0, ACCEPTANCE_NET_READS_MAX)) {
      const r = await this.engineDirect({ kind: "net", name });
      if (!r.ok) continue;
      const d = r.data as { no_connect?: boolean; labels?: string[] };
      const n = byName.get(name);
      if (n) { n.no_connect = d.no_connect === true; if (Array.isArray(d.labels)) n.labels = d.labels; }
    }
    const ctx: AcceptanceContext = {};
    // Power symbols (`#PWR01`, `#FLG1`) are absent from every net's members by construction, so a
    // block that names such a prefix needs two more engine answers: the project's symbol list, and
    // each net's `flagged` bit ("a PWR_FLAG sits on this net"), which `sch.nets` reports per net.
    if (acceptanceNeedsPowerSymbols(blocks)) {
      const nl = await this.engineDirect({ kind: "nets", sheet: null, limit: 2000 });
      if (nl.ok) {
        for (const n of ((nl.data as { nets?: { name?: unknown; flagged?: unknown }[] }).nets ?? [])) {
          const e = typeof n.name === "string" ? byName.get(n.name) : undefined;
          if (e) e.flagged = n.flagged === true;
        }
      }
      const rd = await this.engineDirect({ kind: "read", sheet: null, all_sheets: true, limit: 2000 });
      if (rd.ok) {
        const seen = new Set<string>();
        const power: AcceptancePowerSymbol[] = [];
        for (const s of ((rd.data as { symbols?: { reference?: unknown; value?: unknown; lib_id?: unknown }[] }).symbols ?? [])) {
          const reference = typeof s.reference === "string" ? s.reference : "";
          if (!reference.startsWith("#") || seen.has(reference)) continue;
          seen.add(reference);
          power.push({ reference, ...(typeof s.value === "string" ? { value: s.value } : {}), ...(typeof s.lib_id === "string" ? { lib_id: s.lib_id } : {}) });
        }
        ctx.power = power;
      }
    }
    if (acceptanceNeedsPositions(blocks)) {
      const symbols: Record<string, AcceptanceSymbol> = {};
      for (const file of [...new Set(sheets.map((s) => s.file).filter((f): f is string => !!f))].slice(0, ACCEPTANCE_SHEETS_MAX)) {
        const r = await this.engineDirect({ kind: "read", sheet: file, limit: 2000 });
        if (!r.ok) continue;
        for (const s of ((r.data as { symbols?: { reference?: string; value?: string; x_mil?: number; y_mil?: number }[] }).symbols ?? [])) {
          if (typeof s.reference !== "string" || typeof s.x_mil !== "number" || typeof s.y_mil !== "number") continue;
          symbols[s.reference] ??= { at_mil: [s.x_mil, s.y_mil], ...(s.value ? { value: s.value } : {}) };
        }
      }
      ctx.symbols = symbols;
    }
    return { nets, ctx };
  }

  /** Returns what the gate (and KiCad's ERC, when the turn wrote) said, so a caller can report a verdict. */
  private async postTurnGate(t: TurnRecord, fix?: { ctx: ToolContext; bus: HookBus; state: TurnPolicyState }): Promise<{ findings: Finding[]; kicad: KicadErcResult | null }> {
    this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: "reviewing" });
    let g = await this.engineDirect({ kind: "gate_run" });
    // Model-driven turns get the same deterministic ERC repair as plan steps (PWR_FLAG on
    // connector-fed rails, no-connects on unused IC pins) before the findings are reported.
    if (fix && g.ok && this.mode === "build" && this.buildSession && !this.stopRequested) {
      // A dangling port is only auto-deleted in plan steps: in a free Build turn the human (or the model's next
      // turn) may be about to wire it, and a silent delete would surprise them.
      const fixable = extractFindings(g.data).filter((f) => f.code === "ERC_POWER_IN_UNDRIVEN" || f.code === "PINMAP_UNCONNECTED" || (f.code === "POWER_PORT_DANGLING" && !!t.plan_step));
      if (fixable.length) {
        const target = t.applies[t.applies.length - 1]?.target ?? this.d.sheets()[0];
        const did = await this.runErcFix(target, fixable, fix.ctx, fix.bus, fix.state, t).catch(() => false);
        if (did) g = await this.engineDirect({ kind: "gate_run" });
      }
    }
    // A sheet without a title reads as unfinished. This runs on every writing turn, not only the
    // model-driven ones: the plan path calls `postTurnGate(t)` without a `fix`, which is why the
    // fill the skill documents never actually happened on a plan-built sheet.
    if (g.ok && (await this.fillTitleBlocks(t, extractFindings(g.data)))) g = await this.engineDirect({ kind: "gate_run" });
    const f = g.ok ? extractFindings(g.data) : [];
    if (g.ok) {
      this.noteGate(f);
      if (f.length) this.pushFindings(t, f);
      // A clean gate is a result, not silence: the full batch goes out even when it is empty, so the
      // rows an earlier turn left on the findings panel (and their canvas markers) are resolved by
      // the turn that fixed them. Only a gate that did not run (`g.ok === false`) says nothing.
      // A turn that wrote nothing does not ask KiCad again (below); the rows of the run that already
      // answered for these bytes are still current, so they ride along rather than being resolved by
      // a batch that never looked at them.
      const kicadStanding = !t.applies.length && this.lastKicadRun?.seq === this.writeSeq ? this.lastKicadRun.res.rows : [];
      this.d.emit({ kind: "findings", turn: t.turn, findings: [...f, ...kicadStanding], full: true });
      if (f.length) await this.instanceRefsCards(t, f);
    }
    // A turn that wrote something is asked of KiCad itself (red line 7). Last, so every write of this
    // turn — the model's applies and the repairs above — is committed before kicad-cli reads the files.
    // Advisory only: the engine gate above stays the authority for pass/fail of the write gate.
    let kicad: KicadErcResult | null = null;
    if (t.applies.length) { kicad = await this.kicadErc(); this.noteKicad(t, kicad, f); }
    return { findings: f, kicad };
  }

  /**
   * Fill the title block of every sheet this turn may name that still has none, and report whether
   * anything was applied. This is the fill `schematic-authoring#layout` promises ("the system fills
   * an empty title block from the sheet name after the turn").
   *
   * Red line 6: the verdict is the engine's. `TITLE_BLOCK_EMPTY` comes from `sch-check`, carries the
   * file it lives in, and only exists while the title is empty — the harness never inspects a title
   * block itself and therefore can never overwrite a human-written one. On an ordinary turn only the
   * files it applied to are touched (a hierarchical project's untouched sheets keep whatever they
   * have); on a plan's `gate` step — the plan's last word on the whole project — every sheet inside
   * the turn's effective envelope is filled, because the sheet a step wrote is rarely the sheet whose
   * title is missing (run 19 left the root sheet unnamed while the child got its title). The write
   * goes through the normal apply path inside the same turn checkpoint (P2, the Rust envelope and the
   * accumulators all still see it; `set_title_block` is in `HARNESS_OPS`, which `closeAllowedOps` keeps
   * inside a model-declared envelope and the gate step declares outright), and it replaces the `title` node in place, so
   * applying the same turn twice writes the same bytes. A title block is not a component: no budget
   * of the plan counts it.
   */
  private async fillTitleBlocks(t: TurnRecord, findings: Finding[]): Promise<boolean> {
    const state = this.policyState;
    if (!state || this.mode !== "build" || !this.buildSession || this.stopRequested) return false;
    const gate = this.stepKindOf(t.plan_step) === "gate";
    if (!t.applies.length && !gate) return false;
    // An incremental edit ("change R1 to 2k2") asked for one value, not for a title: outside the plan's
    // gate step the fill runs only for a turn that could add parts and actually drew a symbol, so the
    // sheet the human only edited stays byte-identical apart from the edit itself.
    if (!gate) {
      const drewSymbol = t.applies.some((a) => (a.created ?? []).some((c) => c.kind === "symbol"));
      if ((t.envelope?.components_added_max ?? 0) === 0 || !drewSymbol) return false;
    }
    // The envelope is Rust's, not ours: on the gate step the fill reaches exactly the sheets the
    // approved plan declared for it, and a file outside it is left alone rather than refused.
    const allowed = new Set([...t.applies.flatMap(applyFiles), ...(gate ? t.envelope?.sheets ?? [] : [])].map(sheetKey));
    const files: string[] = [];
    for (const f of findings) {
      const file = (f as Finding & { file?: string }).file;
      if (f.code !== "TITLE_BLOCK_EMPTY" || !file || !allowed.has(sheetKey(file)) || files.includes(file)) continue;
      files.push(file);
    }
    if (!files.length) return false;
    const bus = new HookBus(() => ({ state, rails: this.rails(), stepNets: this.stepNets() }));
    const ctx = this.toolContext(state, t, "lead");
    let any = false;
    for (const target of files) {
      // The sheet's own file stem: deterministic, and the same string on every re-run of the turn.
      const title = sheetKey(target);
      const a = await this.harnessApply({ oplist: { protocol_version: 1, groups: {}, ops: [{ op: "set_title_block", title }] }, target, expected_merges: [], note: "title block" }, ctx, bus, state, t).catch(() => null);
      any = any || (!!a?.ok && (a.data as { applied?: boolean } | undefined)?.applied !== false);
    }
    return any;
  }

  /**
   * One bounded `kicad_advisory { kind: "erc" }` run. Never throws and never waits longer than
   * `KICAD_ADVISORY_TIMEOUT_MS`: a missing, slow or broken kicad-cli is reported as "not available",
   * never as a clean result (red line 8: absence is non-fatal, and it is never a gate).
   */
  private async kicadErc(): Promise<KicadErcResult> {
    if (this.lastKicadRun && this.lastKicadRun.seq === this.writeSeq) return this.lastKicadRun.res;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<KicadErcResult>((resolve) => { timer = setTimeout(() => resolve(emptyKicadErc("timeout")), KICAD_ADVISORY_TIMEOUT_MS); });
    const run = call("kicad_advisory", { project_key: this.d.projectKey, kind: "erc" })
      .then((adv) => kicadErcResult(adv))
      .catch((e: unknown) => emptyKicadErc(e instanceof IpcFailure ? e.error.code : String(e).slice(0, 80)));
    const res = await Promise.race([run, bounded]);
    if (timer) clearTimeout(timer);
    this.lastKicadRun = { seq: this.writeSeq, res };
    return res;
  }

  /**
   * Record a KiCad ERC run on the turn (footer segment, `system.plan_done`) and merge its rows into
   * the turn's findings, so they get canvas markers and can be waived like any other finding.
   */
  private noteKicad(t: TurnRecord, res: KicadErcResult, engineFindings: Finding[] = [], emit = true): void {
    t.kicad = { available: res.available, errors: res.errors, warnings: res.warnings, ...(res.note ? { note: res.note } : {}) };
    this.lastKicad = t.kicad;
    if (!res.available) { this.d.emit({ kind: "system", text_key: "system.kicad_advisory_unavailable", params: { reason: res.note ?? "unavailable" }, severity: "info" }); return; }
    if (res.rows.length) this.pushFindings(t, res.rows);
    // A run that raised nothing is a verdict too: the batch goes out empty rather than not at all, so
    // the `KICAD_` rows of an earlier run stop being listed as open once KiCad no longer reports them.
    // The engine rows ride along so a full batch does not resolve them again. `emit` is false for the
    // review, which sends its own batch (scoped, and carrying the Reviewer's rows) right after.
    if (emit) this.d.emit({ kind: "findings", turn: t.turn, findings: [...engineFindings, ...res.rows], full: true });
  }

  private finishTurn(t: TurnRecord, started: number): void {
    if (t.ended_at) return; // already finished (watchdog raced the natural end)
    this.sentInTurn = false; // turn boundary: the history may be rewritten again (compaction)
    if (t.status === "rolled_back") { t.ended_at = nowIso(); this.currentTurn = null; this.policyState = null; this.stepPhase = null; return; } // reverted while running: nothing to summarise
    const now = this.d.now?.() ?? Date.now();
    this.turnBudget?.stopActive(now);
    t.wall_active_ms = this.turnBudget?.used.wall_ms ?? now - started;
    t.ended_at = nowIso();
    const summary = summaryOf(t, now - started);
    if (t.status === "done") t.status = "summarized";
    this.d.emit({ kind: "phase", turn: t.turn, role: "lead", phase: t.status === "abandoned" || t.status === "stopped" || t.status === "failed" ? "stopped" : "done" });
    // The turn divider/footer already shows status, counts, cost and the rollback action;
    // the summary card is only worth a card when it carries auto decisions or a "do this" offer.
    if (t.auto_decisions.length || t.kind === "question") this.d.emit({ kind: "card", card: summaryCard(t.turn, summary, t.auto_decisions, t.kind === "question") });
    this.d.emit({ kind: "turn_ended", summary });
    // Only a turn that Rust knows (turn_begin succeeded) is ended there; a text-only turn never began in Rust.
    if (t.began_in_rust) void call("turn_end", { project_key: this.d.projectKey, turn: t.turn, outcome: summary.outcome }).catch(() => undefined);
    void this.d.persistence.turn(t.turn, t).catch(() => undefined);
    void this.d.persistence.metric("turn_duration_ms", now - started, { kind: t.kind }).catch(() => undefined);
    this.currentTurn = null;
    this.policyState = null;
    this.stepPhase = null;
    this.emitContext();
  }

  /** The project file most of these finding sheet paths (`/power/`) resolve to, by sheet stem; null when unknown. */
  private sheetFileFor(paths: (string | undefined)[]): string | null {
    const files = this.d.sheets();
    const stem = (f: string) => f.replace(/^.*\//, "").replace(/\.kicad_sch$/, "");
    const votes = new Map<string, number>();
    for (const p of paths) {
      if (!p) continue;
      const last = p.split("/").filter(Boolean).pop();
      const file = last ? files.find((f) => stem(f) === last) : files[0];
      if (file) votes.set(file, (votes.get(file) ?? 0) + 1);
    }
    let best: string | null = null; let n = 0;
    for (const [f, c] of votes) if (c > n) { best = f; n = c; }
    return best;
  }

  /** Re-run the gate and publish a full findings list (after a rollback the old rows are stale). */
  async refreshFindings(turn: number): Promise<void> {
    const g = await this.engineDirect({ kind: "gate_run" }).catch(() => null);
    if (g?.ok) { const f = extractFindings(g.data); this.noteGate(f); this.d.emit({ kind: "findings", turn, findings: f, full: true }); }
  }

  /** Rollback bookkeeping after Rust restored files (agent-runtime.md §4.3). */
  afterRollback(beforeTurn: number): void {
    for (const t of this.turns) if (t.turn >= beforeTurn) t.status = "rolled_back";
    this.lastKicadRun = null; // Rust restored the files: the cached KiCad ERC describes bytes that are gone.
    this.pendingExternal = null; // the restore replaced whatever KiCad wrote; the rollback marker below covers it
    const removed = this.history.filter((m) => m.meta.turn >= beforeTurn && m.role !== "user");
    // Compaction blocks anchored before the rollback point summarise turns whose raw messages are already gone: keep them.
    this.history = this.history.filter((m) => !(m.meta.turn >= beforeTurn && m.role !== "user") && !(m.meta.kind === "compaction" && m.meta.turn >= beforeTurn));
    for (const m of this.history) if (m.meta.turn >= beforeTurn && m.role === "user" && m.meta.kind === "user") m.content = [{ type: "text", text: `${m.content.map((c) => (c.type === "text" ? c.text : "")).join("")}\n(this turn was rolled back)` }];
    this.history.push({ role: "user", content: [{ type: "text", text: `<system>Files were restored to the state before turn ${beforeTurn}. Use sch.summary as the truth; do not reference any designator or net from turns ${beforeTurn} and later.</system>` }], meta: { turn: this.turns.length, task: this.taskCounter, kind: "marker" } });
    for (const s of [...this.planStepsDone]) { const done = this.turns.find((t) => t.plan_step === s && t.status !== "rolled_back"); if (!done) this.planStepsDone.delete(s); }
    for (const s of [...this.planStepsSkipped]) { const live = this.turns.find((t) => t.plan_step === s && t.status !== "rolled_back"); if (!live) { this.planStepsSkipped.delete(s); this.stepNotes.delete(s); } }
    if (this.plan && this.plan.display.status === "done") this.plan.display.status = "in_progress";
    this.persistProgress();
    for (const t of this.turns) if (t.turn >= beforeTurn) void this.d.persistence.turn(t.turn, t).catch(() => undefined);
    this.d.emit({ kind: "system", text_key: "system.rolled_back", params: { turn: beforeTurn, removed: removed.length }, severity: "info" });
  }

  /** Step progress lives in the plan sidecar (`display.progress`) so a restart resumes at the right step instead of redrawing blocks. */
  private persistProgress(): void {
    if (!this.plan) return;
    this.plan.display.progress = { done: [...this.planStepsDone], skipped: [...this.planStepsSkipped], notes: Object.fromEntries(this.stepNotes) };
    void call("sidecar_write", { project_key: this.d.projectKey, write: { kind: "plan", plan: this.plan } }).catch(() => undefined);
  }

  /** Restore persisted step progress (after `adoptPlan` at attach). */
  restoreProgress(): void {
    const p = this.plan?.display.progress;
    if (!p) return;
    for (const s of p.done ?? []) if (this.plan!.steps.some((x) => x.id === s)) this.planStepsDone.add(s);
    for (const s of p.skipped ?? []) if (this.plan!.steps.some((x) => x.id === s)) this.planStepsSkipped.add(s);
    for (const [k, v] of Object.entries(p.notes ?? {})) this.stepNotes.set(k, v);
  }

  adoptPlan(plan: DesignPlan, approved: boolean, keepProgress = false): void {
    this.plan = plan;
    this.planApproved = approved;
    if (!keepProgress) { this.planStepsDone.clear(); this.planStepsSkipped.clear(); }
    // Acceptance describes what a gate step measured on this plan's blocks: a new plan starts blank.
    this.planAcceptance.clear();
    this.autoTracker = new AutoSkipTracker(plan.steps.length);
    const s = this.d.settings();
    if (s.agent.budget_enabled) this.planBudget = new BudgetLedger({ tokens: plan.budget.tokens ?? s.agent.budget_defaults.plan_tokens, usd: plan.budget.cost_usd ?? s.agent.budget_defaults.plan_usd, tool_calls: plan.budget.tool_calls ?? s.agent.budget_defaults.plan_tool_calls, wall_ms: plan.budget.wall_active_min !== null ? plan.budget.wall_active_min * 60_000 : (s.agent.budget_defaults.plan_wall_min === null ? null : s.agent.budget_defaults.plan_wall_min * 60_000) }, s.agent.budget_defaults.warn_pct);
  }

  /**
   * External events from Rust (P7): lock, lock release, external change, out-of-scope, verify failure.
   * `changed` also queues a history marker for the next turn (`externalMarker`): between turns no
   * turn is running to carry the flag, and the model must not reuse designators from before the edit.
   */
  externalEvent(kind: "locked" | "unlocked" | "changed" | "outOfScope" | "verifyFailed", detail?: { files?: string[] }): void {
    if (kind === "unlocked") { if (this.policyState) this.policyState.external.locked = false; return; }
    if (kind === "changed" && this.currentTurn) this.currentTurn.external = true;
    // The files moved under us: what KiCad said about the previous bytes is not about these ones.
    if (kind === "changed") {
      this.lastKicadRun = null;
      const after = this.turns.filter((t) => t.status !== "rolled_back").map((t) => t.turn).pop() ?? 0;
      const files = new Set(this.pendingExternal?.files ?? []);
      for (const f of detail?.files ?? []) files.add(f);
      this.pendingExternal = { files: [...files].sort(), afterTurn: this.pendingExternal?.afterTurn ?? after };
    }
    if (this.policyState) this.policyState.external[kind] = true;
  }

  /** External changes seen since the last turn started; folded into one marker at the next turn start. */
  private pendingExternal: { files: string[]; afterTurn: number } | null = null;

  /** The byte-stable `<system>` marker for a pending external change (same shape as the rollback marker). */
  static externalMarker(files: string[], afterTurn: number): string {
    const list = files.length ? files.join(", ") : "the schematic";
    return `<system>${list} changed outside fluxsmith after turn ${afterTurn}. Re-read the design (sch.summary is the truth) before relying on any designator, net or position from earlier turns.</system>`;
  }

  /** Push the pending external-change marker into the history (once per change set), at turn start. */
  private flushExternalMarker(turn: number, task: number): void {
    const p = this.pendingExternal;
    if (!p) return;
    this.pendingExternal = null;
    this.history.push({ role: "user", content: [{ type: "text", text: LeadLoop.externalMarker(p.files, p.afterTurn) }], meta: { turn, task, kind: "marker" } });
  }

  /** Instruction-like text in a user message is fine (it is the user); this guards pasted files. */
  static looksPasted(text: string): boolean { return text.length > 2000 && looksLikeInstruction(text); }

  get manifestVersion(): number { return MANIFEST_VERSION; }
  get currentStepPhase(): "draft" | "verify" | "apply" | null { return this.stepPhase; }
  cardPayloadSha(p: unknown): string { return payloadSha(p); }
  question(turn: number, q: string): Card { return questionCard(turn, q, undefined, true, undefined); }
  netChangesOf(data: unknown) { return extractNetChanges(data); }
}

/** One-line detail for an activity row: the fields a human cares about (sheet, ref, net, lib id, query), never raw JSON. */
function argsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["target", "sheet", "file", "reference", "ref", "designator", "net", "name", "lib_id", "query", "op", "step", "headline", "code"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
    else if (typeof v === "number") parts.push(String(v));
  }
  const ops = (a.oplist as { ops?: unknown[] } | undefined)?.ops;
  if (Array.isArray(ops)) parts.push(`${ops.length} ops`);
  const out = parts.join(" · ");
  return out.length > 120 ? `${out.slice(0, 117)}...` : out;
}

/** Layout findings: cosmetic, fixable later by move_component; never worth losing a whole block for. */
/** Harness-path tool results kept in the model history are capped at this many chars (full body in the sidecar). */
const HARNESS_RESULT_HISTORY_CAP = 2000;
/** Total characters of covered-turn text handed to the L2 compaction side-call. */
const COMPACTION_RANGE_CHARS = 60_000;
/** Identity of a set of layout findings: two rounds with the same fingerprint changed nothing. */
function layoutFingerprint(findings: Finding[]): string {
  return findings.map((f) => `${f.code}|${f.location ?? ""}`).sort().join(",");
}

const LAYOUT_CODES = new Set(["GROUP_OVERLAP", "SYMBOL_OVERLAP", "LABEL_OVER_BODY", "LABEL_OVERLAP", "TEXT_OVERLAP", "FIELD_OVER_OWN_BODY", "FIELD_OVER_FIELD", "LABEL_OVER_WIRE", "POWER_PORT_STACKED", "LONG_WIRE", "POWER_PORT_ORIENTATION", "OFF_GRID", "ROW_MISALIGNED", "OUT_OF_FRAME"]);
/**
 * A sheet file's stem (`sub/power.kicad_sch` -> `power`). Used both to compare an engine finding's
 * `file` with the apply targets this turn recorded — the two spellings differ by directory prefix —
 * and as the deterministic default title of that sheet.
 */
export function sheetKey(file: string): string {
  return file.replace(/^.*[\\/]/, "").replace(/\.kicad_sch$/, "");
}
const SUBAGENT_CHILD_LINES_MAX = 30;
/** Pin pitch on a sheet symbol edge (the engine lays sheet pins out on this pitch, KiCad's grid). */
const SHEET_PIN_PITCH_MIL = 100;

/** Parts listed on the FR-611 card (the engine caps its own list at 20). */
export const INSTANCE_REFS_PARTS_LISTED = 20;

/**
 * Instance paths of `file` in a `sch.summary` result (`sheets: [{path, file}]`), sorted so briefs
 * and cards are deterministic. `[]` when the file is instantiated at most once.
 */
/** Sheet files the engine summary reports as existing (`sheets[].file`), de-duplicated. */
export function summarySheetFiles(summary: unknown): string[] {
  const rows = (summary as { sheets?: unknown } | null)?.sheets;
  if (!Array.isArray(rows)) return [];
  const out = new Set<string>();
  for (const r of rows) { const f = (r as { file?: unknown } | null)?.file; if (typeof f === "string" && f) out.add(f); }
  return [...out];
}

/**
 * Sheet files a step needs that the project does not have yet. The engine summary is the only source
 * (the webview never reads a `.kicad_sch`); an empty `existing` means the summary told us nothing, and
 * then nothing is reported missing rather than everything.
 */
export function missingStepSheets(existing: string[], required: string[]): string[] {
  if (!existing.length) return [];
  return [...new Set(required.filter((s) => s && !existing.some((e) => sheetMatches(e, s))))];
}

export function sheetInstancePaths(summary: unknown, file: string): string[] {
  const rows = (summary as { sheets?: unknown } | null)?.sheets;
  if (!Array.isArray(rows) || !file) return [];
  const paths = new Set<string>();
  for (const r of rows) {
    const row = r as { path?: unknown; file?: unknown } | null;
    if (!row || typeof row.path !== "string" || typeof row.file !== "string") continue;
    if (sheetMatches(row.file, file)) paths.add(row.path);
  }
  return paths.size > 1 ? [...paths].sort() : [];
}

/** FR-611 / D-18: a plan whose `sheets[]` entry declares the instances has already answered the question. */
export function planDeclaresInstances(plan: DesignPlan | null, file: string): boolean {
  const s = plan?.sheets.find((x) => sheetMatches(x.file, file));
  return (s?.instances?.length ?? 0) > 1;
}

/**
 * Sheet file and instance count of an `INSTANCE_REFS_REQUIRED` finding. The file is the engine's
 * structured `file` field; the message is only parsed as a fallback (older engine results, and the
 * instance count, which the message alone carries).
 */
export function instanceRefsFacts(f: Finding): { file: string | null; instances: number } {
  const m = /^(\S+\.kicad_sch) is instantiated (\d+) times/.exec(f.message ?? "");
  return { file: f.file ?? (m ? m[1] : null), instances: m ? Number(m[2]) : 0 };
}

/** Naming conventions every Drafter follows when the plan gives none: cross-block nets must line up by name. */
/**
 * Envelope widened to what a P2 denial asked for: counts raised to the requested totals, undeclared sheets /
 * ops / structural actions / renames added. Used only after the human approved the hard-stop card.
 */
/** Rust `check_envelope` evidence (`{budget, have, add, max}`, `{sheet}`, `{op}`, `{structural}`) in the `problems` vocabulary `widenEnvelope` reads. */
export function problemsFromEvidence(code: string, evidence: unknown): string[] {
  const e = (evidence ?? {}) as Record<string, unknown>;
  if (typeof e.budget === "string") {
    const have = Number(e.have ?? 0), add = Number(e.add ?? 0), max = Number(e.max ?? 0);
    if (e.budget === "components_added") return [`components_added ${have + add} > ${max}`];
    if (e.budget === "components_deleted") return [`components_deleted ${have + add} > ${max}`];
    if (e.budget === "properties_changed") return [`properties_changed ${have + add} > ${max}`];
    if (e.budget === "components_moved") return [`components_moved ${have + add} > ${max}`];
    if (e.budget === "wires") return ["wires_added exceeds the budget"];
  }
  if (typeof e.reference === "string") return [`reference ${e.reference} not editable`];
  if (typeof e.sheet === "string") return [`sheet ${e.sheet} not in envelope`];
  if (typeof e.op === "string") return [`op ${e.op} not allowed`];
  if (typeof e.structural === "string") return [`structural ${e.structural} not listed`];
  if (typeof e.rename === "string") return [`rename_net ${e.rename} not in nets_renamable`];
  return code ? [] : [];
}

/** How much of the engine's refusal message rides in a redraw hint. */
const REFUSAL_DETAIL_MAX = 400;

/**
 * The engine's detail for one refusal `code` in a plan / apply result, or null. A refused op is reported
 * three ways: `per_op[].error` (dry run and apply), the `refusal` line that summarises the first one, and —
 * when the whole call failed — an error whose code / message carry it. The message names what the engine
 * actually found (the sheet symbols that exist, the files the op-list would write), which is the whole
 * value of a redraw hint.
 */
export function refusalDetail(r: ToolResult, code: string): string | null {
  const cut = (s: unknown) => String(s ?? code).trim().slice(0, REFUSAL_DETAIL_MAX);
  const data = (r.data ?? {}) as { refusal?: unknown; per_op?: unknown };
  if (Array.isArray(data.per_op)) {
    for (const o of data.per_op as { error?: { code?: unknown; message?: unknown } | null }[]) if (o?.error && o.error.code === code) return cut(o.error.message);
  }
  if (typeof data.refusal === "string" && data.refusal.includes(code)) return cut(data.refusal);
  if (r.error && `${r.error.code} ${r.error.message}`.includes(code)) return cut(r.error.message);
  return null;
}

export function sheetNotFoundDetail(r: ToolResult): string | null {
  return refusalDetail(r, "SHEET_NOT_FOUND");
}

/**
 * ENVELOPE_SHEET_UNDECLARED: the op-list would write a file this step's approved sheets do not include.
 * The engine's own `remediation` rides along, so the redraw hint can repeat it verbatim.
 */
export function envelopeSheetDetail(r: ToolResult): { detail: string; remediation: string } | null {
  const detail = refusalDetail(r, "ENVELOPE_SHEET_UNDECLARED");
  if (!detail) return null;
  const rem = r.error && typeof r.error.remediation === "string" ? r.error.remediation.slice(0, REFUSAL_DETAIL_MAX) : "";
  return { detail, remediation: rem };
}

/**
 * Redraw hint after SHEET_NOT_FOUND: the engine message verbatim (it names the sheet symbols that exist)
 * plus the rule the Drafter broke. Deterministic in `detail` and `target`; appended after the brief.
 */
export function sheetNotFoundHint(detail: string, target: string): string {
  return `Your previous op-list was refused with SHEET_NOT_FOUND. Engine message: "${detail}". On add_sheet_pin, delete_sheet_pin and resize_sheet the "sheet" field names a hierarchical sheet symbol drawn on the current sheet, never a file name: use only the sheet symbol names that message lists (such an op is routed to another file with "in_sheet", not with "sheet"). On every other op "sheet" is the envelope key of another file: leave it out, so the op lands on this step's own sheet ${target}. Return the corrected op-list.`;
}

/**
 * Redraw hint after ENVELOPE_SHEET_UNDECLARED: the engine message and its remediation verbatim, plus the
 * files this step may write (the approved plan's — nothing is widened here) and the rule the Drafter broke.
 * Deterministic in its arguments; appended after the brief.
 */
export function envelopeSheetHint(detail: string, remediation: string, target: string, allowed: string[]): string {
  const files = allowed.length ? allowed.join(", ") : target;
  return `Your previous op-list was refused with ENVELOPE_SHEET_UNDECLARED. Engine message: "${detail}".${remediation ? ` Engine remediation: "${remediation}".` : ""} This step may write only these files: ${files}. add_sheet_pin writes two of them — the sheet symbol on this sheet, and the hierarchical label the engine seeds inside the child file — so drop every add_sheet_pin whose child file is not in that list. A rail (GND, +3V3, VBUS, VCC ...) never needs one at all: a rail crosses sheets on a power port of the same name on each sheet, and sheet pins are for signals. The sheet symbols of this plan already carry the interface pins the scaffold step gave them. Everything else belongs on this step's own sheet ${target}: leave "sheet" and "in_sheet" out. Return the corrected op-list.`;
}

/** Hint for the one escalated retry after a Drafter attempt failed (bad JSON, rejected output, provider error). */
export function failedAttemptHint(reason: string): string {
  return `Your previous attempt failed: ${reason.slice(0, 200)}. Answer with one \`\`\`json fence holding the complete op-list object and nothing else.`;
}

/**
 * Deterministic clean-up of a Drafter op-list before it is applied: designators come from the lease, so a
 * `set_component_parameters` that tries to rename a part (Reference / new_designator) is stripped rather than
 * refused by Rust (ENVELOPE_REFERENCE), which would skip the whole step under Auto.
 */
/** `sch.nets` reports `members` as a count (the engine's `nets()` summary); `sch.net` reports the member list. */
export function netMemberCount(n: { members?: unknown }): number {
  const m = n.members;
  return typeof m === "number" ? m : Array.isArray(m) ? m.length : 0;
}

/**
 * The label text of an instance-qualified net name: `/power/NET_X` -> `NET_X`, `/MIDROOT` ->
 * `MIDROOT`, `GND` -> `GND`. `rename_net.old_name` and the envelope's `nets_renamable` are label
 * text (session.rs compares them verbatim), the nets list is qualified by sheet instance.
 */
export function bareNetName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

export function sanitizeDraft<T extends { ops?: unknown[]; sheets?: unknown[] }>(oplist: T, note?: (text: string) => void, target?: string): T {
  if (!oplist || !Array.isArray(oplist.ops)) return oplist;
  const ops: unknown[] = [];
  let stripped = 0;
  // A Drafter draws on its step's sheet only: a foreign sheet declaration (or per-op sheet) would be refused
  // by P2 and skip the whole block, so it is folded onto the target instead.
  const stem = (f: string) => f.split("/").pop()!.replace(/\.kicad_sch$/, "");
  let resheeted = 0;
  let sheets = oplist.sheets;
  if (target && Array.isArray(sheets)) {
    const kept = sheets.filter((x) => typeof x === "string" && stem(x) === stem(target));
    resheeted += sheets.length - kept.length;
    sheets = kept;
  }
  for (const raw of oplist.ops) {
    let op = raw as Record<string, unknown>;
    // `sheet` on the sheet-symbol ops names a hierarchical sheet symbol, not the file the op is routed to
    // (that is `in_sheet`): fold the routing field only, never the symbol name, which is a required field.
    const route = op && SHEET_SYMBOL_OPS.has(String(op.op)) ? "in_sheet" : "sheet";
    if (target && op && typeof op[route] === "string" && stem(op[route] as string) !== stem(target)) { op = { ...op }; delete op[route]; resheeted++; }
    if (op && op.op === "set_component_parameters") {
      const next = { ...op };
      if ("new_designator" in next) { delete next.new_designator; stripped++; }
      if (next.parameters && typeof next.parameters === "object") {
        const params = { ...(next.parameters as Record<string, unknown>) };
        for (const k of Object.keys(params)) if (/^reference$/i.test(k)) { delete params[k]; stripped++; }
        next.parameters = params;
      }
      const hasWork = next.value !== undefined || next.footprint !== undefined || next.dnp !== undefined || (next.parameters && Object.keys(next.parameters as object).length > 0);
      if (!hasWork) continue;
      ops.push(next);
      continue;
    }
    ops.push(op);
  }
  if (stripped) note?.(`draft: removed ${stripped} reference change(s) from set_component_parameters (designators come from the lease)`);
  if (resheeted) note?.(`draft: ${resheeted} foreign sheet reference(s) folded onto ${target} (a block is drawn on its own sheet)`);
  return sheets !== undefined ? { ...oplist, ops, sheets } : { ...oplist, ops };
}

export function widenEnvelope(env: Envelope, payload: Record<string, unknown>): Envelope {
  const out: Envelope = { ...env, sheets: [...env.sheets], allowed_ops: [...env.allowed_ops], structural: [...env.structural], nets_renamable: [...env.nets_renamable], refs_editable: [...(env.refs_editable ?? [])], source: "approved_scope" };
  const problems = Array.isArray(payload.problems) ? (payload.problems as unknown[]).map(String) : [];
  if (typeof payload.structural === "string" && !out.structural.includes(payload.structural)) out.structural.push(payload.structural);
  for (const p of problems) {
    let m: RegExpExecArray | null;
    if ((m = /^components_added (\d+) > (\d+)$/.exec(p))) out.components_added_max = Math.max(out.components_added_max, Number(m[1]));
    else if ((m = /^components_deleted (\d+) > (\d+)$/.exec(p))) out.components_deleted_max = Math.max(out.components_deleted_max, Number(m[1]));
    else if ((m = /^properties_changed (\d+) > (\d+)$/.exec(p))) out.properties_changed_max = Math.max(out.properties_changed_max ?? 0, Number(m[1]));
    else if ((m = /^components_moved (\d+) > (\d+)$/.exec(p))) out.components_moved_max = Math.max(out.components_moved_max ?? 0, Number(m[1]));
    // A named part the human approves joins the editable set; a uuid-addressed one cannot be named.
    else if ((m = /^reference (\S+) not editable$/.exec(p))) { if (out.refs_editable.length && !m[1].startsWith("(") && !out.refs_editable.includes(m[1])) out.refs_editable.push(m[1]); }
    else if (/^wires_added exceeds/.test(p)) out.wires_max = null;
    else if ((m = /^sheet (\S+) not in envelope$/.exec(p))) { if (!out.sheets.includes(m[1])) out.sheets.push(m[1]); }
    else if ((m = /^op (\S+) not allowed$/.exec(p))) { if (!out.allowed_ops.includes(m[1])) out.allowed_ops.push(m[1]); }
    else if ((m = /^structural (\S+) not listed$/.exec(p))) { if (!out.structural.includes(m[1])) out.structural.push(m[1]); }
    else if ((m = /^rename_net (\S+) not in nets_renamable$/.exec(p))) { if (!out.nets_renamable.includes(m[1])) out.nets_renamable.push(m[1]); }
  }
  if (out.allowed_ops.length) out.allowed_ops = closeAllowedOps(out.allowed_ops);
  return out;
}

export function DEFAULT_CONVENTIONS(rails: string[]): { id: string; text: string }[] {
  return [
    { id: "net-names", text: `Cross-block signals connect by label name only, so use exactly these names: rails ${rails.length ? rails.join(", ") : "VBUS, +5V, +3V3, GND"} as power ports; UART_TX / UART_RX named from the MCU's point of view; UPDI; RESET; I2C_SDA / I2C_SCL; SPI_MOSI / SPI_MISO / SPI_SCK; GPIO_<port><n> using the MCU's real pin names (read them with lib.symbol / sch.pins; never invent pins the part does not have). Header pins carry the same label as the MCU pin they break out.` },
    ...DRAWING_CONVENTIONS,
  ];
}

export function extractFindings(data: unknown): Finding[] {
  const d = data as Record<string, unknown> | null;
  if (!d) return [];
  const out: Finding[] = [];
  const push = (arr: unknown) => { if (Array.isArray(arr)) for (const f of arr) if (f && typeof f === "object" && typeof (f as Finding).code === "string") out.push(f as Finding); };
  push(d.findings); push(d.integrity); push(d.integrity_introduced); push(d.layout); push(d.delivery);
  if (Array.isArray(d.families)) for (const fam of d.families as { findings?: unknown }[]) push(fam.findings);
  if (Array.isArray(d)) push(d);
  return out;
}

/**
 * Where an apply happened, as the engine reported it (`focus.refs` = the parts it drew and changed,
 * `focus.sheet` = the file they live on). Never inferred here: no `focus` means the caller falls
 * back to the sheets the apply wrote.
 */
function extractFocus(data: { focus?: unknown }): Ref[] | undefined {
  const f = data.focus as { refs?: unknown; sheet?: unknown } | null | undefined;
  if (!f || !Array.isArray(f.refs) || !f.refs.length) return undefined;
  const sheet = typeof f.sheet === "string" && f.sheet ? f.sheet : undefined;
  const refs = f.refs.filter((r): r is string => typeof r === "string" && r.length > 0);
  return refs.length ? refs.map((r) => ({ kind: "component", ref: r, ...(sheet ? { sheet } : {}) })) : undefined;
}


/** Where a tool call points the agent's attention (for the canvas presence marker). */
function attentionOf(tool: string, args: Record<string, unknown>): { label: string; refs?: Ref[]; region_mil?: [[number, number], [number, number]] } | null {
  const refsOf = (v: unknown): Ref[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((r) => ({ kind: "component", ref: String(r) }) as Ref);
  switch (tool) {
    case "sch.component": return { label: String(args.ref ?? args.reference ?? ""), refs: refsOf(args.ref ?? args.reference) };
    case "sch.pins": return { label: String(args.lib_id ?? ""), refs: [] };
    case "sch.net": return { label: String(args.name ?? ""), refs: [{ kind: "net", name: String(args.name ?? "") }] };
    case "sch.bbox": {
      const r = args.region as unknown;
      const region = Array.isArray(r) && r.length === 2 ? (r as [[number, number], [number, number]]) : Array.isArray(r) && r.length === 4 ? ([[r[0], r[1]], [r[2], r[3]]] as [[number, number], [number, number]]) : undefined;
      return { label: "bbox", refs: refsOf(args.refs), region_mil: region };
    }
    case "agent.dispatch": {
      const r = args.region_mil as unknown;
      const region = Array.isArray(r) && r.length === 2 ? (r as [[number, number], [number, number]]) : undefined;
      return { label: `${String(args.role ?? "agent")}${args.block ? ` · ${String(args.block)}` : ""}`, region_mil: region };
    }
    case "sch.read": return { label: `read${args.sheet ? ` · ${String(args.sheet)}` : ""}${args.match ? ` · ${String(args.match)}` : ""}`, refs: [] };
    case "sch.nets": return { label: `nets${args.match ? ` · ${String(args.match)}` : ""}`, refs: [] };
    case "sch.summary": return { label: "summary", refs: [] };
    case "lib.search": case "lib.resolve": case "lib.symbol": return { label: `${tool.split(".")[1]} · ${String(args.query ?? args.lib_id ?? "")}`.slice(0, 60), refs: [] };
    case "parts.search": case "parts.show": case "parts.convert": case "parts.datasheet": return { label: `${tool} · ${String(args.query ?? args.mpn ?? args.lcsc ?? "")}`.slice(0, 60), refs: [] };
    case "check.integrity": case "check.style": case "check.layout": case "check.erc": case "gate.run": return { label: tool.split(".")[1] === "run" ? "gate" : `check · ${tool.split(".")[1]}`, refs: [] };
    case "sch.plan": case "sch.apply": case "sch.apply_waived": case "sch.dryrun_scratch": {
      const groups = ((args.oplist as { groups?: Record<string, { region_mil?: number[][] }> })?.groups) ?? {};
      const g = Object.values(groups).find((x) => Array.isArray(x?.region_mil));
      const region = g?.region_mil as [[number, number], [number, number]] | undefined;
      return { label: tool.split(".")[1] ?? tool, region_mil: region };
    }
    default: return null;
  }
}

/** One thinking level up for an escalated retry (never below "low", never above "high"). */
export function bumpThinking(level: ThinkingLevel | undefined): Exclude<ThinkingLevel, "off"> {
  switch (level) {
    case "off": case "minimal": case undefined: return "low";
    case "low": return "medium";
    case "medium": return "high";
    default: return "high";
  }
}

// ---------------------------------------------------------------------------
// Ledger / recovery helpers (crash-recovery.md §3; exported for tests)
// ---------------------------------------------------------------------------

/** `intended` payload: op-list sha and the target paths (shas are only known after the engine ran). */
export function ledgerIntended(args: Record<string, unknown>): { ops_sha256: string; targets: { path: string; sha_before: string | null }[] } {
  const sheets = (args.oplist as { sheets?: Record<string, string> } | undefined)?.sheets;
  const paths = new Set<string>([String(args.target ?? "")]);
  for (const f of Object.values(sheets ?? {})) if (typeof f === "string") paths.add(f);
  return { ops_sha256: sha256Hex(canonicalJson(args.oplist)), targets: [...paths].filter(Boolean).map((path) => ({ path, sha_before: null })) };
}

/** `applied` payload from the engine result: every target with its before/after sha. */
export function ledgerApplied(data: Record<string, unknown>, run_id: string | undefined): { run_id: string | undefined; targets: { path: string; sha_before: string | null; sha_after: string | null; created?: boolean }[] } {
  const targets = (Array.isArray(data.targets) ? data.targets : []) as { path?: string; sha_before?: string | null; sha_after?: string | null; created?: boolean }[];
  return { run_id, targets: targets.filter((x) => typeof x.path === "string").map((x) => ({ path: String(x.path), sha_before: x.sha_before ?? null, sha_after: x.sha_after ?? null, created: x.created })) };
}

/** `pending_card.json` contents: the card, its step/condition/grant kind and the op-list sha — never grant or consent ids. */
export function pendingCardFile(card: Card, step: string): PendingCardFile {
  const d = (card.data ?? {}) as { condition?: unknown; request?: { oplist?: unknown }; system?: { oplist?: unknown }; oplist?: unknown };
  const oplist = d.request?.oplist ?? d.system?.oplist ?? d.oplist;
  return {
    turn: card.turn, step,
    condition: typeof d.condition === "string" ? d.condition : null,
    grant_kind: card.actions.find((a) => a.consent)?.consent?.grant_kind ?? null,
    card: { ...card, answered: undefined },
    oplist_sha256: oplist === undefined ? null : sha256Hex(canonicalJson(oplist)),
    written_at: nowIso(),
  };
}

/** Dry-run bookkeeping for one dispatch: the cutoff counters plus the digests a dry run accepted. */
export interface DryrunState { count: number; lastSha: string | null; accepted: Set<string> }

/**
 * The "answer with what you dry-ran" contract (F4). A Drafter that dry-ran an op-list and then
 * answered with a different one (run 14: dry-run on `ldo_board.kicad_sch`, final answer silently back
 * to `power.kicad_sch`) is rejected here, which costs one corrective round instead of a failed apply
 * plus a whole skipped step. A subagent that never dry-ran anything is not punished: it has no receipt
 * to contradict, and the engine calls on the harness path still judge its list.
 */
export function dryRunContract(st: DryrunState, output: unknown): string[] {
  if (!st.accepted.size) return [];
  const o = (output ?? {}) as { ops?: unknown };
  if (!Array.isArray(o.ops)) return [];
  if (st.accepted.has(oplistDigest(output))) return [];
  return [`this op-list is not the one sch.dryrun_scratch accepted (its result carried oplist_sha256 ${[...st.accepted].map((d) => d.slice(0, 12)).join(" / ")}); answer with the exact op-list that passed, or dry-run this one first`];
}

/**
 * Drafter/Fixer dry-run cutoff: the same op-list dry-run twice in a row, or more than
 * `DRYRUN_MAX_PER_DRAFT` dry-runs in one dispatch, ends the loop with a tool error that
 * tells the subagent to answer now (the loop was burning tokens without changing anything).
 */
export function dryrunCutoff(st: { count: number; lastSha: string | null }, oplist: unknown): { is_error: true; code: string; message: string; remediation: string } | null {
  const sha = sha256Hex(canonicalJson(oplist ?? null));
  st.count += 1;
  const repeated = st.lastSha === sha;
  st.lastSha = sha;
  if (repeated) return { is_error: true, code: "DRYRUN_REPEATED", message: "this op-list was already dry-run with the same result", remediation: "do not dry-run again: answer now with this op-list (or change it first)" };
  if (st.count > DRYRUN_MAX_PER_DRAFT) return { is_error: true, code: "DRYRUN_LIMIT", message: `dry-run limit (${DRYRUN_MAX_PER_DRAFT}) reached for this draft`, remediation: "answer now with your best op-list" };
  return null;
}
