// SPDX-License-Identifier: Apache-2.0
// fetch override (red line 12): provider origins → Rust `net_fetch`
// streaming channel; every other origin is refused — never a browser fetch
// fallback. Authorization is injected by Rust from the keyring; the webview
// only sends the provider id.

import { netFetch } from "../ipc/client";
import type { NetChunk, NetRequest } from "../ipc/types";

export interface NetShimOptions {
  /** origin → provider id; registered from settings (built-in + custom). */
  origins: () => Map<string, string>;
  /** Origin consented for web_fetch / parts (second outbound channel). */
  extraOrigins?: () => Set<string>;
  idFactory?: () => string;
}

let installed: { restore: () => void } | null = null;
let seq = 0;

export function originOf(url: string): string | null {
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return null; }
}

export function classify(url: string, opts: NetShimOptions, self: string): "passthrough" | "provider" | "extra" | "deny" {
  const o = originOf(url);
  if (!o) return "passthrough";
  if (!/^https?:/.test(o)) return "passthrough";
  if (o === self || o.startsWith("http://ipc.localhost") || o.startsWith("http://asset.localhost") || o.startsWith("tauri://")) return "passthrough";
  if (opts.origins().has(o)) return "provider";
  if (opts.extraOrigins?.().has(o)) return "extra";
  return "deny";
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function bodyToString(body: BodyInit | null | undefined): Promise<string | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as Uint8Array);
  if (body instanceof Blob) return await body.text();
  if (typeof (body as ReadableStream).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value) parts.push(value); }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    return new TextDecoder().decode(all);
  }
  return String(body);
}

/** Build a Response backed by the Rust streaming channel. */
export function shimFetch(opts: NetShimOptions, originalFetch: typeof fetch, self: string): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const cls = classify(url, opts, self);
    if (cls === "passthrough") return originalFetch(input, init);
    if (cls === "deny") {
      throw new TypeError(`NET_ORIGIN_DENIED: ${originOf(url)} is not a registered provider origin`);
    }
    const req = input instanceof Request ? input : null;
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers ?? req?.headers ?? undefined);
    h.forEach((v, k) => { const lk = k.toLowerCase(); if (lk === "authorization" || lk === "x-api-key" || lk === "x-goog-api-key") return; headers[k] = v; });
    const body = await bodyToString(init?.body ?? (req ? await req.text() : null));
    const id = opts.idFactory ? opts.idFactory() : `net-${++seq}`;
    const signal = init?.signal ?? req?.signal ?? undefined;
    const provider = cls === "provider" ? opts.origins().get(originOf(url)!) ?? null : null;
    const request: NetRequest = { id, method: (init?.method ?? req?.method ?? "GET").toUpperCase(), url, headers, body, provider, timeout_ms: null, purpose: cls === "provider" ? "provider" : "web_fetch" };

    let headResolve: (r: Response) => void = () => {};
    let headReject: (e: unknown) => void = () => {};
    const headPromise = new Promise<Response>((res, rej) => { headResolve = res; headReject = rej; });
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let headSeen = false;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const onChunk = (c: NetChunk) => {
      if (c.kind === "head") {
        headSeen = true;
        headResolve(new Response(stream, { status: c.status, headers: c.headers }));
      } else if (c.kind === "body") {
        // A late chunk after the consumer cancelled / an error closed the stream is not an error
        // (it used to surface as a console "not in a state where chunk can be enqueued").
        try { controller?.enqueue(b64ToBytes(c.data_base64)); } catch { /* stream already closed */ }
      } else if (c.kind === "done") {
        try { controller?.close(); } catch { /* already closed */ }
      } else if (c.kind === "error") {
        if (!headSeen) headReject(new TypeError(`${c.error.code}: ${c.error.message}`));
        try { controller?.error(new Error(`${c.error.code}: ${c.error.message}`)); } catch { /* closed */ }
      }
    };
    const abort = () => { void import("../ipc/client").then((m) => m.call("net_abort", { id })).catch(() => undefined); try { controller?.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } };
    signal?.addEventListener("abort", abort, { once: true });
    netFetch(request, onChunk).catch((e) => { if (!headSeen) headReject(e); try { controller?.error(e); } catch { /* closed */ } });
    return headPromise;
  };
}

export function installNetShim(opts: NetShimOptions): void {
  if (installed) return;
  const original = globalThis.fetch.bind(globalThis);
  const self = typeof location !== "undefined" ? `${location.protocol}//${location.host}` : "";
  globalThis.fetch = shimFetch(opts, original, self);
  installed = { restore: () => { globalThis.fetch = original; installed = null; } };
}

export function uninstallNetShim(): void {
  installed?.restore();
}
