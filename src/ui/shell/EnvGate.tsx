// SPDX-License-Identifier: Apache-2.0
// Full-screen EnvIncomplete flow (D-51 / UJ-0).
import { useT, fmtDate, errorCopy } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import { kicadMajor, useEnv } from "../../state/env";
import { Button, Callout, Icon } from "../components";

/** Where KiCad 10 is downloaded (UJ-0 asks the wizard to link the install page). */
const KICAD_DOWNLOAD = "https://www.kicad.org/download/";

export function EnvGate({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT();
  const { report, checking, check, dismissGate } = useEnv();
  const rows: { label: string; value: string | null; ok: boolean }[] = report
    ? [
        { label: t("env.kicadApp"), value: report.kicad_app_path, ok: !!report.kicad_app_path },
        // Green only for a version this build can write: a 9.0.1 install is found, and still not enough.
        { label: t("env.kicadVersion"), value: report.kicad_version, ok: (kicadMajor(report.kicad_version) ?? 0) >= 10 },
        { label: t("env.symbolDir"), value: report.symbol_dir ? `${report.symbol_dir} (${t("env.symbolLibs", { n: report.symbol_lib_count })})` : null, ok: report.symbol_lib_count > 0 },
        { label: t("env.symLibTable"), value: report.sym_lib_table, ok: !!report.sym_lib_table },
        { label: t("env.kicadCli"), value: report.kicad_cli_path, ok: !!report.kicad_cli_path },
        { label: t("env.keyring"), value: report.keyring_available ? t("env.available") : t("env.missing"), ok: report.keyring_available },
      ]
    : [];
  return (
    <div className="env-gate">
      <div className="env-gate-card">
        <div className="row"><Icon name="kicadMissing" size={20} /><h1>{t("env.incomplete")}</h1></div>
        <p className="muted">{t("env.incompleteHint")}</p>
        <table className="env-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="label-sm">{r.label}</td>
                <td className={`fs-mono ${r.ok ? "" : "muted"}`}>{r.value ?? t("env.missing")}</td>
                <td><Icon name={r.ok ? "done" : "failed"} className={r.ok ? "ok" : "bad"} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {report?.problems.map((p) => {
          // The catalogue has four-language three-part copy for every environment code; Rust's English is the fallback.
          const c = errorCopy(p.code);
          return (
            <Callout key={p.code} tone={p.fatal ? "error" : "warning"}>
              <div>{c?.title ?? p.message}</div>
              {c?.why && <div className="muted copy-sm">{c.why}</div>}
              <div className="muted">{t("error.remediation", { text: c?.next ?? p.remediation })}</div>
            </Callout>
          );
        })}
        {report && <div className="muted copy-sm">{t("env.lastChecked", { when: fmtDate(report.checked_at) })}</div>}
        <div className="row">
          <Button variant="primary" icon="externalChange" loading={checking} onClick={() => void check(true)}>{t("env.recheck")}</Button>
          <Button icon="external" onClick={() => { if (isTauri()) void call("open_url", { url: KICAD_DOWNLOAD }).catch(() => undefined); }}>{t("env.installKicad")}</Button>
          <Button icon="settings" onClick={onOpenSettings}>{t("env.openSettings")}</Button>
          <span className="grow" />
          <Button variant="ghost" onClick={dismissGate}>{t("env.continueWithoutAi")}</Button>
        </div>
      </div>
    </div>
  );
}
