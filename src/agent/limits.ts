// SPDX-License-Identifier: Apache-2.0
// Scale and concurrency constants (agent-runtime.md §4.4a, tool-manifest.md §5).
// Provisional values; S-A2 back-fills measured numbers. Treated as static rules.

export const MAX_AUTHORED_OPS_PER_APPLY = 120; // a 2x10 header block alone is ~45 ops (parts + one label per pin)
export const MAX_EXPANDED_OPS_PER_APPLY = 400;
export const MAX_COMPONENTS_PER_BLOCK = 12;
export const MAX_NETS_PER_WIRING_STEP = 8;
export const MAX_STEPS_PER_PLAN = 40;
export const DRAFTER_CONCURRENCY_DEFAULT = 3;
export const DRAFTER_CONCURRENCY_DEGRADED = 2;
export const FIX_ATTEMPTS_MAX = 2;
export const SUBAGENT_OUTPUT_CAP = 64 * 1024;
export const TOOL_PARALLEL_MAX_DEFAULT = 4;
export const PROVIDER_CONN_MAX_DEFAULT = 6;

/** Tool result byte caps (tool-manifest.md §1). */
/** Upper bound for the L2 compaction side-call (it also stops with the turn's abort). */
export const COMPACTION_CALL_TIMEOUT_MS = 120_000;
/**
 * `kicad_advisory` (KiCad's own ERC) after a turn that wrote: the harness waits at most this long
 * for it. The Rust side gives kicad-cli 120 s; a slow or hung CLI must not hold a turn open that
 * long, and a bound that expires is reported as "not available", never as a clean result.
 */
export const KICAD_ADVISORY_TIMEOUT_MS = 20_000;
/** A turn.begin declaration is a few hundred characters; anything far beyond is a degenerate generation. */
export const TURN_BEGIN_ARGS_MAX_CHARS = 6_000;
/**
 * Output cap per assistant message. Thinking budgets are carved out of this number by pi-ai (a "high" level
 * takes 16k), so a drafting role needs ~32k to keep 15k visible tokens for a 45-op block; the runaway guard is
 * the stream stall detector plus TURN_BEGIN_ARGS_MAX_CHARS, not this cap.
 */
export const MODEL_MAX_OUTPUT_TOKENS = 32_000;
/** Tool-call arguments streamed in one attempt beyond this are a repetition loop (a 45-op list is ~12 KB): abort and nudge. */
export const TOOL_ARGS_STREAM_MAX_BYTES = 48 * 1024;
export const RESULT_CAP_DEFAULT = 32 * 1024;
export const RESULT_CAP_SCH_READ = 64 * 1024;
export const RESULT_CAP_SCH_SUMMARY = 8 * 1024;
export const SKILLS_L0_CAP = 4 * 1024;
export const TURN_STATUS_MAX_CHARS = 80;
export const TURN_STATUS_MAX_PER_STEP = 2;
export const DRYRUN_MAX_PER_DRAFT = 6;
export const SESSION_CEILING_COMPONENTS_ADDED_DEFAULT = 24;

/** Provider resilience (provider-resilience.md §2). */
export const RETRY_BACKOFF_MS = [1000, 2000, 4000] as const;
export const RETRY_JITTER = 0.3;
export const RETRY_MAX = 3;
export const RETRY_AFTER_CAP_S = 120;
export const STREAM_STALL_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const REQUEST_TOTAL_TIMEOUT_MS = 10 * 60_000;
export const LONG_OUTAGE_MS = 10 * 60_000;

/** Auto policy pause rule (agent-runtime.md §1b.1). */
export const AUTO_MAX_CONSECUTIVE_SKIPS = 3;
export const AUTO_MAX_SKIP_RATIO = 0.3;

/** Context (context-compaction.md §0). */
export const RESERVE_OUTPUT_TOKENS_DEFAULT = 8000;
export const RESERVE_TOOL_TOKENS = Math.max(TOOL_PARALLEL_MAX_DEFAULT * 8192, 16384);
export const RESERVE_SAFETY = 0.05;
export const MIN_CTX_BUILD = 128_000;
export const MIN_CTX_CHAT = 64_000;
export const COMPACTION_TARGET_PCT = 50;
export const COMPACTION_MIN_TURNS_BETWEEN = 5;
export const COMPACTION_BLOCK_MAX_TOKENS = 4000;
export const ESTIMATE_SAFETY_FACTOR = 1.1;
