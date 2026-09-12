// SPDX-License-Identifier: Apache-2.0
// Three-part finding copy (title / what was measured / the usual fix), expanded into the four
// catalogues as `finding.<CODE>.{title,detail,remedy}`. The code list of record is
// `src/agent/finding-codes.ts`; `scripts/i18n-lint.mjs` keeps the four tables and that list in step.
//
// Red line 6: this copy describes what the check looked at and the usual engineering remedy. It
// never says whether the circuit is right — that verdict is the engine's, and its own English
// message is shown verbatim next to this copy.
import { FINDING_CODES, type FindingCode, type FindingCopyKey } from "../../agent/finding-codes";

/** `[title, detail, remedy]`: a short human title, one sentence of measurement, one sentence of fix. */
export type FindingCopyTable = Record<FindingCode, readonly [string, string, string]>;

/** Expands a copy table into flat catalogue keys (typed so `MessageKey` stays a union). */
export function expandFindingCopy(table: FindingCopyTable): Record<FindingCopyKey, string> {
  const out = {} as Record<FindingCopyKey, string>;
  for (const code of FINDING_CODES) {
    const [title, detail, remedy] = table[code];
    out[`finding.${code}.title`] = title;
    out[`finding.${code}.detail`] = detail;
    out[`finding.${code}.remedy`] = remedy;
  }
  return out;
}
