// SPDX-License-Identifier: Apache-2.0
// Error codes that carry three-part copy (`error.<CODE>.{title,why,next}`) in all four
// catalogues. Regenerate the skeleton with `node scripts/gen-error-copy.mjs`; the list is
// the ui-states.md set plus the provider/network codes users actually hit. Codes absent here
// fall back to `error.generic`.
export const ERROR_CODES = [
  "PATH_OUT_OF_SCOPE", "KICAD_NOT_FOUND", "KICAD_VERSION_UNSUPPORTED", "KICAD_VERSION_UNKNOWN", "SYMBOL_TABLE_NOT_FOUND", "SYMBOL_TABLE_INVALID",
  "KICAD_DATA_DIR_NOT_FOUND", "ENV_SETUP_REQUIRED", "LIBTABLE_UNREADABLE", "BAD_CONFIG", "VERSION_UNKNOWN_NEWER", "VERSION_UNSUPPORTED",
  "NO_BUILD_SESSION", "SESSION_EXPIRED", "PLAN_NOT_LOCALLY_APPROVED", "PLAN_SHA_CHANGED", "SYMBOL_INDEX_BUILDING", "SYMBOL_INDEX_EMPTY",
  "KEYRING_UNAVAILABLE", "KEYRING_DENIED", "PROJECT_NO_PRO", "PROJECT_TAB_NEEDS_ATTENTION", "PROJECT_TAB_CLOSE_RUNNING",
  "PROJECT_MOVED_OR_COPIED", "PROJECT_NAME_MISMATCH", "CLOUD_SYNC_FOLDER", "SKILL_PACK_UNTRUSTED", "SKILL_PACK_LINT_FAILED", "SKILL_DRAFT",
  "CONTEXT_EXHAUSTED", "CONTEXT_COMPACTED", "CONTEXT_WILL_COMPACT", "WEBVIEW_RESTARTED", "ENGINE_PANIC", "ENGINE_CANCELLED", "TURN_INTERRUPTED",
  "RESUME_NEEDS_CONSENT", "DISK_FULL", "APP_DATA_TOO_NEW", "PLAN_SCHEMA_TOO_NEW", "BYTES_AFFECTING_NOTICE", "UPDATE_AVAILABLE",
  "UPDATE_SOURCE_UNSET", "WEBVIEW2_MISSING", "WEBVIEW2_BROKEN", "CLOUD_PLACEHOLDER_FILES", "PATH_TOO_LONG_FOR_TOOL", "NET_OFFLINE",
  "SHORTCUT_CONFLICT", "SETTINGS_SAFETY_CONFIRM", "SETTINGS_PROJECT_CARD", "SETTINGS_RESET_ALL", "ATTACH_TYPE_REJECTED", "ATTACH_INTAKE",
  "ATTACH_TOO_LARGE", "LIB_PARSE_ERROR", "LIB_NICKNAME_CONFLICT", "VISION_UNSUPPORTED", "UNVERIFIED_SOURCE", "EXTERNAL_FILE_MISSING",
  "REVISION_CHANGED", "KICAD_CLI_MISSING", "ROUTER_MISSING", "MODE_MISMATCH", "TARGET_LOCKED", "VERIFY_FAILED", "TXN_ROLLBACK_FAILED",
  "FS_TRANSIENT", "CHECKPOINT_FAILED", "CHECKPOINT_TAMPERED", "ROLLBACK_STALE", "NET_RISK_MERGE", "NET_RISK_SPLIT", "NET_DIFF_UNAVAILABLE",
  "INSTANCE_REFS_REQUIRED", "SCOPE_WIDEN", "BUDGET_EXCEEDED", "SYMBOL_NOT_FOUND", "INTERFACE_UNDECLARED", "PROVIDER_CONTEXT_OVERFLOW",
  "PROVIDER_BAD_REQUEST", "PROVIDER_CLIENT_OUTDATED", "PROVIDER_AUTH", "PROVIDER_QUOTA", "PROVIDER_RATE_LIMIT", "PROVIDER_STREAM_BROKEN", "PROVIDER_REFUSAL",
  "PROVIDER_UNSUPPORTED_TOOLS", "NET_TIMEOUT", "NET_ORIGIN_DENIED", "CONSENT_REQUIRED", "CONSENT_MISMATCH", "REASON_REQUIRED", "CARD_UNKNOWN", "WAIVER_SEVERITY", "WAIVER_SCOPE", "FILE_UNREADABLE", "IPC_TRANSPORT", "ENV_INCOMPLETE",
  // Codes raised by Rust (`src-tauri/src/**`, `err(...)` and the `From` impls of `error.rs`) that
  // reach the webview as a toast or a card. Agent-facing refusals that only travel back inside a
  // tool result (OPLIST_*, OP_*, FACT_*, POLICY_DENY_*, SHEET_UNKNOWN, NET_NOT_FOUND,
  // COMPONENT_NOT_FOUND, PARTS_NOT_FOUND, NOT_FOUND) deliberately have no card copy: the model reads
  // the message, the human never sees one.
  "ENVELOPE_SHEET_UNDECLARED", "ENVELOPE_SHEET", "ENVELOPE_OP", "ENVELOPE_STRUCTURAL", "ENVELOPE_RENAME", "ENVELOPE_REFERENCE",
  // The one op refusal with card copy: a rename the engine cannot place (`sch-write` handlers.rs)
  // hard-stops the step, and the human sees which sheets carry the name.
  "RENAME_SCOPE_AMBIGUOUS",
  "GRANT_INVALID", "GRANT_EXPIRED", "PROJECT_ROOT_MISSING", "PROJECT_ROOT_AMBIGUOUS", "PROJECT_ROOT_SHEET_MISMATCH",
  "SEXPR_PARSE", "SHEET_FILE_MISSING", "DB_CORRUPT", "DB_ERROR", "BAD_URL", "OPEN_FAILED", "PORT_BUSY", "PREVIEW_NOT_FOUND",
  "PDF_UNPARSEABLE", "NOT_SUPPORTED", "NET_TOO_LARGE", "NET_REDIRECT_BLOCKED", "NET_TYPE_REJECTED",
  "PARTS_DISABLED", "PARTS_UPSTREAM", "BOM_LOCK_MISSING", "ROUTER_FAILED", "WORKFLOW_NOT_FOUND",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** `[title, why, next]` — the three-part copy of docs/ui-states.md. `why`/`next` may be empty. */
export type ErrorCopyTable = Record<ErrorCode, readonly [string, string, string]>;

export type ErrorCopyKey = `error.${ErrorCode}.title` | `error.${ErrorCode}.why` | `error.${ErrorCode}.next`;

/** Expands a copy table into flat catalogue keys `error.<CODE>.title|why|next` (typed so `MessageKey` stays a union). */
export function expandErrorCopy(table: ErrorCopyTable): Record<ErrorCopyKey, string> {
  const out = {} as Record<ErrorCopyKey, string>;
  for (const code of ERROR_CODES) {
    const [title, why, next] = table[code];
    out[`error.${code}.title`] = title;
    out[`error.${code}.why`] = why;
    out[`error.${code}.next`] = next;
  }
  return out;
}

/** Codes recognised by `errorCopy`. */
export function isErrorCode(code: string): code is ErrorCode { return (ERROR_CODES as readonly string[]).includes(code); }
