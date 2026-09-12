// SPDX-License-Identifier: Apache-2.0
// "Go back to before turn n": lists every turn that will be undone (headline, change counts),
// the files the restore would move out of the project, warns when a change made in KiCad after the
// checkpoint would be overwritten, and explains the pre-rollback snapshot (`pre_rollback`
// checkpoint kind, kept 7 days, restorable once from the result card). The consent event is
// recorded by the caller on the click.
import { useCallback, useEffect, useMemo, useState } from "react";
import { errorCopy, fmtDuration, fmtUsd, useT } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { CheckpointInfo, RollbackPreview } from "../../ipc/types";
import { usePrefs } from "../../state/prefs";
import { Badge, Button, Callout, Dialog } from "../components";
import type { TurnBlock } from "../harness-bridge";
import type { Card } from "../../agent/api";

/** A card is the external-change notice the watcher files when KiCad (or another tool) wrote. */
export function isExternalCard(c: Card | undefined): boolean {
  return !!c && c.kind === "system" && c.title === "system.external_change";
}

/** When the external change happened, from the card the watcher filed (empty when older cards carry no timestamp). */
export function externalChangeAt(c: Card): string {
  const at = (c.data as { at?: unknown } | undefined)?.at;
  return typeof at === "string" ? at : "";
}

/**
 * The external changes a rollback would overwrite: everything KiCad wrote after
 * the checkpoint that is about to be restored. Time is what decides it, not the
 * turn the card was filed under — a change made between turns belongs to no turn
 * block, and one made before the checkpoint was taken is inside it and survives.
 * Without a checkpoint time (older card payloads, checkpoint list unavailable)
 * this falls back to the turns that will be undone.
 */
export function overwrittenExternalChanges(turns: TurnBlock[], cards: Record<string, Card>, target: number, checkpointCreated?: string): Card[] {
  const external = Object.values(cards).filter(isExternalCard);
  if (checkpointCreated) {
    const timed = external.filter((c) => externalChangeAt(c));
    if (timed.length || !external.length) return timed.filter((c) => externalChangeAt(c) > checkpointCreated);
  }
  const undone = new Set(turns.filter((b) => b.turn >= target && !b.rolled_back).map((b) => b.turn));
  return external.filter((c) => undone.has(c.turn));
}

/** The three-part copy for a refused rollback, as one line ("title — next"). */
function failedCopy(code: string): string {
  const c = errorCopy(code);
  return c ? `${c.title} — ${c.next}` : code;
}

export function RollbackDialog({ turn, turns, cards = {}, projectKey, locked, onClose, onConfirm }: {
  turn: number | null; turns: TurnBlock[]; cards?: Record<string, Card>; projectKey: string; locked?: boolean; onClose: () => void;
  onConfirm: (turn: number, opts?: { state_sha256?: string }) => Promise<string | null | void>;
}) {
  const t = useT();
  const prefs = usePrefs();
  const [busy, setBusy] = useState(false);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[] | null>(null);
  const [preview, setPreview] = useState<RollbackPreview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    if (turn == null || !isTauri()) { setCheckpoints(null); setPreview(null); return; }
    call("checkpoint_list", { project_key: projectKey }).then(setCheckpoints).catch(() => setCheckpoints([]));
    // Read-only impact plus the state token the write is checked against.
    call("rollback_preview", { project_key: projectKey, before_turn: turn }).then(setPreview).catch(() => setPreview(null));
  }, [turn, projectKey]);
  useEffect(() => { setFailed(null); load(); }, [load]);
  const undone = useMemo(() => (turn == null ? [] : turns.filter((b) => b.turn >= turn && !b.rolled_back)), [turn, turns]);
  const last = turns[turns.length - 1]?.turn ?? 0;
  const cp = checkpoints?.find((c) => c.turn === turn && c.kind === "turn");
  const cpBad = !!cp && (cp.pruned || !cp.verified);
  // A turn whose block carries the external-change card gets the row badge; the warning below counts
  // the changes that are actually younger than the checkpoint (see `overwrittenExternalChanges`).
  const isExternal = (b: TurnBlock) => b.items.some((i) => i.kind === "card" && isExternalCard(cards[i.id])) || b.messages.some((m) => m.kind === "system" && m.text_key === "system.external_change");
  const external = turn == null ? [] : overwrittenExternalChanges(turns, cards, turn, cp?.created);
  const removed = preview?.remove_files ?? [];
  const confirm = async () => {
    if (turn == null) return;
    setBusy(true);
    try {
      const code = await onConfirm(turn, preview ? { state_sha256: preview.state_sha256 } : undefined);
      if (!code) { if (!prefs.dismissedTips.firstRollback) prefs.dismissTip("firstRollback"); return; }
      // Refused (typically ROLLBACK_STALE): re-read, show why, let the human decide again.
      setFailed(code);
      load();
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={turn != null} onClose={onClose} title={t("side.rollbackTitle", { n: turn ?? 0 })} closeLabel={t("common.close")} destructive width={560}
      footer={<><Button onClick={onClose} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent loading={busy} disabled={locked || cpBad} onClick={() => void confirm()}>{t("side.rollbackConfirm", { n: turn ?? 0 })}</Button></>}>
      <p>{t("side.rollbackBody", { n: turn ?? 0, m: last })}</p>
      {undone.length > 0 && (
        <ol className="rollback-list">
          {undone.map((b) => (
            <li key={b.turn} className="rollback-item">
              <span className="fs-mono nowrap">{t("chat.turn", { n: b.turn })}</span>
              <span className="truncate grow">{b.headline || b.messages[0]?.text || ""}</span>
              {isExternal(b) && <Badge tone="warning">{t("rollback.external")}</Badge>}
              {b.summary && (b.summary.applied.components_added > 0 || b.summary.applied.components_deleted > 0 || b.summary.applied.wires_added > 0) && (
                <span className="muted copy-sm fs-mono nowrap">{t("chat.summaryComponents", { add: b.summary.applied.components_added, del: b.summary.applied.components_deleted })} · {t("chat.summaryWires", { n: b.summary.applied.wires_added })}</span>
              )}
              {b.summary && <span className="muted copy-sm nowrap">{fmtDuration(b.summary.duration_ms)}{b.summary.cost_usd > 0 ? ` · ${fmtUsd(b.summary.cost_usd)}` : ""}</span>}
            </li>
          ))}
        </ol>
      )}
      {removed.length > 0 && (
        <div className="col">
          <p className="copy-sm">{t("rollback.willRemove", { n: removed.length })}</p>
          <ul className="rollback-list">
            {removed.map((f) => <li key={f} className="rollback-item fs-mono copy-sm selectable truncate">{f}</li>)}
          </ul>
        </div>
      )}
      {external.length > 0 && <Callout tone="warning">{t("rollback.externalWarn", { n: external.length })}</Callout>}
      {locked && <Callout tone="error">{t("rollback.locked")}</Callout>}
      {cpBad && <Callout tone="error">{t(cp?.pruned ? "rollback.checkpointPruned" : "rollback.checkpointUnverified")}</Callout>}
      {failed && <Callout tone="error">{failedCopy(failed)}</Callout>}
      <p className="muted copy-sm">{t("rollback.snapshotNote")}</p>
      {!prefs.dismissedTips.firstRollback && <Callout tone="info">{t("chat.firstRollbackTip")}</Callout>}
    </Dialog>
  );
}
