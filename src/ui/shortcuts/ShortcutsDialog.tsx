// SPDX-License-Identifier: Apache-2.0
import { useT } from "../../i18n";
import { useSettings } from "../../state/settings";
import { Dialog, Kbd } from "../components";
import { effectiveShortcuts } from "./keymap";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const overrides = useSettings((s) => s.settings.shortcuts);
  return (
    <Dialog open={open} onClose={onClose} title={t("shortcut.title")} closeLabel={t("common.close")} width={560}>
      <table className="shortcut-table">
        <tbody>
          {effectiveShortcuts(overrides).map((d) => (
            <tr key={d.action}><td>{t(d.labelKey)}</td><td className="shortcut-key">{d.combo ? <Kbd combo={d.combo} /> : <span className="muted">{t("common.none")}</span>}</td></tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
