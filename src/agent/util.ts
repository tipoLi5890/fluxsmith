// SPDX-License-Identifier: Apache-2.0
// Small deterministic helpers shared by the harness. No timestamps, no
// randomness inside anything that feeds the prompt-cache prefix.

/** Stable JSON: keys sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/**
 * Canonical form of a turn envelope: exactly the eleven fields Rust's `Envelope` carries, keys
 * sorted, no whitespace. Projecting the fields explicitly (rather than hashing the object as it
 * arrives) is what makes the two sides agree: a stray property picked up by a spread would change
 * the sha here but be dropped by serde on the way in.
 *
 * Rust's `Envelope::canonical_json` produces the same string (`serde_json::Value` keeps object keys
 * in a `BTreeMap`), and `tests/fixtures/envelope-canonical.json` pins one envelope's sha for both.
 */
export function canonicalEnvelope(env: unknown): string {
  const e = (env ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const designators: Record<string, string[]> = {};
  const src = e.instance_designators;
  if (src && typeof src === "object") for (const [k, v] of Object.entries(src as Record<string, unknown>)) designators[k] = list(v);
  return canonicalJson({
    sheets: list(e.sheets),
    allowed_ops: list(e.allowed_ops),
    components_added_max: num(e.components_added_max),
    components_deleted_max: num(e.components_deleted_max),
    wires_max: typeof e.wires_max === "number" ? e.wires_max : null,
    structural: list(e.structural),
    nets_renamable: list(e.nets_renamable),
    properties_changed_max: num(e.properties_changed_max),
    components_moved_max: num(e.components_moved_max),
    refs_editable: list(e.refs_editable),
    rails: list(e.rails),
    interfaces: list(e.interfaces),
    instance_designators: designators,
    source: typeof e.source === "string" ? e.source : "",
  });
}

/**
 * What a `scope` approval is bound to. The hard-stop card, the consent event recorded over it, the
 * Rust grant and the `turn.begin` that spends the grant all carry this one sha, so an approval can
 * never be spent on a widening the human did not see (red line 13: one consent unlocks one action).
 */
export function envelopeSha(env: unknown): string {
  return sha256Hex(canonicalEnvelope(env));
}

/** Synchronous SHA-256 (hex). Pure JS so tests and the webview share it. */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncate a UTF-8 string to at most `cap` bytes on a character boundary. */
export function truncateBytes(s: string, cap: number): { text: string; truncated: boolean } {
  if (byteLength(s) <= cap) return { text: s, truncated: false };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLength(s.slice(0, mid)) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return { text: s.slice(0, lo), truncated: true };
}

let counter = 0;
/** Monotonic local id (not used in anything cached). */
export function localId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Instruction-like text detector (P10 flag, notes.append / skill.draft / compaction block).
 * Tuned against `tests/injection/corpus.jsonl` (L6): every attack row must match, every
 * harmless control must not. A match never changes authorisation — it only marks the
 * untrusted envelope so the model treats the text as evidence.
 */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // direct overrides
  /\bignore (all |the |any )?(previous|prior|above|earlier|preceding) (instructions?|rules?|prompts?)\b/i,
  /\byou (must|should|are required to|will) (now )?(call|run|apply|delete|write|execute|switch|enter)\b/i,
  /\b(disregard|override|bypass|skip) (the |all |any |every )?(envelope|policy|policies|hook|approval|consent|plan card|card|hard stop|review)s?\b/i,
  // role / channel forgery
  /\b(system|assistant|user|developer)\s*:\s*/i,
  /<\/?\s*(system|tool_result|tool_use|untrusted|assistant|instructions?)\b/i,
  /["']tool_use\\?["']\s*:/i,
  /\[(sch|check|gate|ops|tool|plan)\.[a-z_]+ (result|output)\]/i,
  // forged authority
  /\bapprov(e|al|ed) (is |was |has been )?granted\b/i,
  /approved[_ ]by[_ ](the[_ ])?(user|human|owner)/i,
  /consent[_ ]event[_ ]id/i,
  /\b(no|without) (card|approval|consent|review|asking|confirmation)( needed| required)?\b/i,
  /\b(ready to apply|apply (it |them |this )?(immediately|now)|do not (show|display) (the )?cards?)\b/i,
  /(^|["'\s]|\\n)(policy|mode)\s*:\s*(auto|build|ask|review)\b/im,
  // instructions smuggled as data
  /\binstructions?\s*:\s*\S/i,
  /\b(do not|don't|never) tell the (user|human)\b/i,
  /\bcall (rollback|sch\.apply|parts\.convert|turn\.begin)\b/i,
  /\b(merge|rename|split|delete) (them|it|the nets?|every (part|component|net))\b/i,
  /\btreat (it |them |this )?as (identical|the same|equivalent)\b/i,
  // exfiltration / credential bait / traversal
  /\bsecrets?\.json\b/i,
  /\b(post|send|upload|transmit|exfiltrate)\b[^\n]{0,80}\bhttps?:\/\//i,
  /\b(api[ _-]?keys?|bearer tokens?|access tokens?)\b/i,
  /sk-ant-|sk-[A-Za-z0-9]{8,}/,
  /(\.\.[\/\\]){2,}/,
  // hidden or confusable text
  /[\u200b-\u200f\u2060\ufeff]/,
  /[\u0400-\u04ff][A-Za-z0-9_]|[A-Za-z0-9_][\u0400-\u04ff]/,
  // s-expression break-out (a quoted label that closes the atom and opens a node)
  /["']\s*\)\s*\(\s*(symbol|label|wire|sheet|junction|lib_symbols|kicad_sch|property)\b/i,
  // non-English overrides (zh / ja)
  /忽略(上述|以上|之前|先前|所有|全部)/,
  /(進入|进入|切換到|切换到)\s*(build|建置|构建)\s*(模式)?/i,
  /不要(顯示|显示|出現|出现)(卡片|確認|确认)/,
  /(指示|命令|ルール)を(無視|むし)/,
  /(承認|許可)(済み|された)/,
];

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}
