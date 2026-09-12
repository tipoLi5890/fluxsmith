// SPDX-License-Identifier: Apache-2.0
// Typed wrapper over Tauri `invoke`. This is the only place the webview
// touches the IPC boundary; everything above it works with `Commands`.
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppEvent, CommandName, Commands, IpcError, NetChunk, NetRequest } from "./types";

export class IpcFailure extends Error {
  constructor(public readonly error: IpcError) {
    super(`${error.code}: ${error.message}`);
  }
}

function isIpcError(e: unknown): e is IpcError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e && "req_id" in e;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** L5 replay seam (b): observes every IPC call and its outcome. Secret-free by construction: results never carry credentials. */
export type IpcTap = (name: string, args: unknown, result: unknown, error: IpcError | null) => void;
let ipcTap: IpcTap | null = null;
export function setIpcTap(tap: IpcTap | null): void { ipcTap = tap; }

export async function call<K extends CommandName>(name: K, args: Commands[K]["args"]): Promise<Commands[K]["result"]> {
  try {
    const result = (await invoke(name, args as Record<string, unknown>)) as Commands[K]["result"];
    if (ipcTap) { try { ipcTap(name, args, result, null); } catch { /* recorder faults never break IPC */ } }
    return result;
  } catch (e) {
    const failure = isIpcError(e) ? new IpcFailure(e) : new IpcFailure({ code: "IPC_TRANSPORT", message: String(e), req_id: "" });
    if (ipcTap) { try { ipcTap(name, args, null, failure.error); } catch { /* see above */ } }
    // Transport-level failures (bad argument names, missing command) are programming
    // errors: surface them in the console and the Rust log so they never fail silently.
    // Every failed command is recorded in the Rust log (secret-free: only code + message)
    // so a tester's session can be reconstructed without the webview console.
    if (name !== "log_write") {
      const level = failure.error.code === "IPC_TRANSPORT" ? "error" : "warn";
      console[level === "error" ? "error" : "warn"](`[ipc] ${name}: ${failure.error.code} ${failure.error.message}`);
      invoke("log_write", { level, message: `ipc ${name}: ${failure.error.code} ${failure.error.message}`, req_id: failure.error.req_id || null }).catch(() => undefined);
    }
    throw failure;
  }
}

/** Streaming network fetch through Rust (`net_fetch`). Resolves when `done`/`error` arrives. */
export function netFetch(request: NetRequest, onChunk: (c: NetChunk) => void): Promise<void> {
  const channel = new Channel<NetChunk>();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    channel.onmessage = (chunk) => {
      onChunk(chunk);
      if (chunk.kind === "done" && !settled) { settled = true; resolve(); }
      if (chunk.kind === "error" && !settled) { settled = true; reject(new IpcFailure(chunk.error)); }
    };
    invoke("net_fetch", { request, on_chunk: channel }).catch((e) => {
      if (!settled) { settled = true; reject(isIpcError(e) ? new IpcFailure(e) : e); }
    });
  });
}

export function onAppEvent(handler: (e: AppEvent) => void): Promise<UnlistenFn> {
  return listen<AppEvent>("fluxsmith://event", (ev) => handler(ev.payload));
}


/** Route uncaught webview errors and console.error into the Rust log (installed once by the shell). */
export function installErrorLogging(): void {
  if (!isTauri()) return;
  const send = (message: string) => invoke("log_write", { level: "error", message: message.slice(0, 2000), req_id: null }).catch(() => undefined);
  window.addEventListener("error", (e) => send(`webview error: ${e.message} @${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => send(`webview unhandled rejection: ${e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ""}` : String(e.reason)}`));
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    if (!String(args[0]).startsWith("[ipc]")) send(`console.error: ${args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  };
}
