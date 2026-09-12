// SPDX-License-Identifier: Apache-2.0
// Second consent for switching the approval policy to Auto (docs/agent-runtime.md §1b): adopting a plan
// with Auto is two decisions (adopt the plan, switch the policy) and the policy menu asks the same thing.
// One dialog for all callers so the wording and the consent button stay identical.
//
// The `plan_approval` card lives in the windowed message stream, which unmounts turn groups outside the
// viewport (and collapses answered cards), so a dialog owned by the card can disappear mid-decision. Cards
// therefore only *request* the confirmation: `AutoConfirmProvider`, mounted on a stable ancestor, owns it.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { Button, Dialog } from "./index";

export function AutoPolicyDialog({ open, onClose, onConfirm, destructive }: { open: boolean; onClose: () => void; onConfirm: () => void; /** The policy menu switches an already running session: styled as the heavier decision. */ destructive?: boolean }) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t("policy.autoConfirmTitle")} closeLabel={t("common.close")} width={480} destructive={destructive}
      footer={<>
        <Button onClick={onClose} autoFocus>{t("common.cancel")}</Button>
        <Button variant={destructive ? "destructive" : "primary"} consent onClick={onConfirm}>{t("policy.autoConfirm")}</Button>
      </>}>
      <p>{t("policy.autoConfirmBody")}</p>
    </Dialog>
  );
}

/** Ask for the Auto confirmation; `run` happens only if the human confirms. */
type AutoConfirmRequest = (run: () => void) => void;
const AutoConfirmCtx = createContext<AutoConfirmRequest | null>(null);

/** Owns the Auto confirmation for everything rendered inside it (the message stream and its cards). */
export function AutoConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ run: () => void } | null>(null);
  const request = useCallback<AutoConfirmRequest>((run) => setPending({ run }), []);
  return (
    <AutoConfirmCtx.Provider value={request}>
      {children}
      <AutoPolicyDialog open={!!pending} onClose={() => setPending(null)} onConfirm={() => { const p = pending; setPending(null); p?.run(); }} />
    </AutoConfirmCtx.Provider>
  );
}

/** `null` when no provider is mounted (a card rendered on its own): the caller must then keep its own
 * confirmation rather than skip the second consent. */
export function useAutoConfirm(): AutoConfirmRequest | null { return useContext(AutoConfirmCtx); }
