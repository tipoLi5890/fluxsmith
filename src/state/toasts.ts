// SPDX-License-Identifier: Apache-2.0
import { create } from "zustand";
import { errorCopy } from "../i18n";
import { IpcFailure } from "../ipc/client";

export interface Toast { id: string; tone: "info" | "warning" | "error" | "success"; text: string; action?: { label: string; run: () => void }; sticky?: boolean }

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, "id">): string;
  /** Error toast from any thrown value: IPC errors get their three-part copy (title — next step), others `String(e)`. */
  pushError(e: unknown, action?: Toast["action"]): string;
  dismiss(id: string): void;
}

let seq = 0;
export const MAX_TOASTS = 4;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(t) {
    const ttl = t.tone === "error" ? 12000 : 6000;
    const arm = (id: string) => { const old = timers.get(id); if (old) clearTimeout(old); if (!t.sticky) timers.set(id, setTimeout(() => { timers.delete(id); set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })); }, ttl)); };
    // The same text again (a burst of external-change notices) refreshes the existing toast in place instead of stacking.
    const dup = get().toasts.find((x) => x.text === t.text && x.tone === t.tone);
    if (dup) {
      set((s) => ({ toasts: s.toasts.map((x) => (x.id === dup.id ? { ...x, ...t, id: dup.id } : x)) }));
      arm(dup.id);
      return dup.id;
    }
    const id = `t${++seq}`;
    // At most MAX_TOASTS on screen: the oldest non-sticky one makes room.
    set((s) => {
      let list = [...s.toasts, { ...t, id }];
      while (list.length > MAX_TOASTS) { const victim = list.findIndex((x) => !x.sticky && x.id !== id); if (victim < 0) break; list = list.filter((_, i) => i !== victim); }
      return { toasts: list };
    });
    arm(id);
    return id;
  },
  pushError(e, action) {
    return get().push({ tone: "error", text: errorToastText(e), action });
  },
  dismiss(id) { const tm = timers.get(id); if (tm) { clearTimeout(tm); timers.delete(id); } set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })); },
}));

/** "title — next" from the error copy when the code has one; otherwise the raw message. */
export function errorToastText(e: unknown): string {
  const err = e instanceof IpcFailure ? e.error : (e && typeof e === "object" && "code" in e && "message" in e) ? (e as { code: string; message: string; remediation?: string }) : null;
  if (!err) return String(e);
  const copy = errorCopy(err.code);
  if (!copy) return err.remediation ? `${err.code}: ${err.message} — ${err.remediation}` : `${err.code}: ${err.message}`;
  const tail = copy.next || err.remediation || "";
  return tail ? `${copy.title} — ${tail}` : copy.title;
}
