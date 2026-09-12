// SPDX-License-Identifier: Apache-2.0
// Intake card (`ATTACH_INTAKE`): one row per dropped file with its detected kind and a
// suggested action (attach to the conversation / keep in the project / use as a reference /
// ignore). A `.kicad_sym` or `.pretty` row also offers "add to project symbol library", which
// records the human's consent and lets Rust copy and register it (`lib_register`); it is never a
// suggested default. Applying runs `attach_intake` per row. Esc = keep only.
import { useState } from "react";
import { fmtBytes, useT, type MessageKey } from "../../i18n";
import { Button, Dialog, Select } from "../components";
import { actionsFor, type IntakeAction, type IntakeItem } from "./intake";

export function IntakeDialog({ items, onApply, onClose }: { items: IntakeItem[] | null; onApply: (items: IntakeItem[]) => Promise<void>; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<IntakeItem[]>(items ?? []);
  const [busy, setBusy] = useState(false);
  // Re-seed when a new drop arrives.
  const [seed, setSeed] = useState(items);
  if (items !== seed) { setSeed(items); setRows(items ?? []); }
  // `.pretty/` footprints collapse into one row: the action applies to the whole library.
  const groups = new Map<string, IntakeItem[]>();
  const single: IntakeItem[] = [];
  for (const r of rows) { if (r.group) groups.set(r.group, [...(groups.get(r.group) ?? []), r]); else single.push(r); }
  const setAction = (ids: string[], action: IntakeAction) => setRows((rs) => rs.map((r) => (ids.includes(r.id) ? { ...r, action } : r)));
  const apply = async (keepOnly: boolean) => {
    setBusy(true);
    try { await onApply(keepOnly ? rows.map((r) => ({ ...r, action: r.action === "ignore" ? "ignore" : "keep" as IntakeAction })) : rows); } finally { setBusy(false); }
  };
  const types = [...new Set(rows.map((r) => r.kind))].map((k) => t(`intake.kind.${k}` as MessageKey)).join(", ");
  const line = (label: string, kind: string, size: number, ids: string[], action: IntakeAction, options: IntakeAction[]) => (
    <tr key={ids[0]}>
      <td className="truncate intake-name" title={label}>{label}</td>
      <td className="muted copy-sm nowrap">{t(`intake.kind.${kind}` as MessageKey)}</td>
      <td className="muted copy-sm fs-mono nowrap">{fmtBytes(size)}</td>
      <td><Select value={action} onChange={(e) => setAction(ids, e.target.value as IntakeAction)} options={options.map((a) => ({ value: a, label: t(`intake.action.${a}` as MessageKey) }))} /></td>
    </tr>
  );
  return (
    <Dialog open={!!items} onClose={onClose} title={t("intake.title", { n: rows.length, types })} closeLabel={t("common.close")} width={640}
      footer={<><Button onClick={() => void apply(true)} disabled={busy}>{t("intake.keepOnly")}</Button><span className="grow" /><Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button><Button variant="primary" loading={busy} onClick={() => void apply(false)}>{t("common.apply")}</Button></>}>
      <p className="muted copy-sm">{t("intake.intro")}</p>
      <div className="scroll intake-scroll">
        <table className="intake-table">
          <thead><tr><th>{t("common.name")}</th><th>{t("intake.detected")}</th><th>{t("common.size")}</th><th>{t("intake.action")}</th></tr></thead>
          <tbody>
            {[...groups.entries()].map(([g, rs]) => line(t("intake.prettyGroup", { name: g, n: rs.length }), "lib", rs.reduce((n, r) => n + r.size, 0), rs.map((r) => r.id), rs[0].action, actionsFor(rs[0])))}
            {single.map((r) => line(r.name, r.kind, r.size, [r.id], r.action, actionsFor(r)))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
