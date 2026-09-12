// SPDX-License-Identifier: Apache-2.0
// Three-part error rendering (what / why / what you can do) keyed by the error code, with
// the raw message as evidence and the req_id copyable. Codes without copy fall back to
// `error.generic`. Never renders HTML from the error.
import type { IpcError } from "../../ipc/types";
import { errorCopy, useT } from "../../i18n";
import { Button, Callout } from "./index";

export function ErrorBlock({ error, compact }: { error: IpcError; compact?: boolean }) {
  const t = useT();
  const copy = errorCopy(error.code);
  const title = copy ? copy.title : t("error.generic", { code: error.code, message: error.message });
  const why = copy?.why || "";
  const next = copy?.next || error.remediation || "";
  const evidence = copy ? error.message : "";
  return (
    <Callout tone="error" actions={error.req_id ? <Button size="sm" icon="copy" onClick={() => void navigator.clipboard?.writeText(error.req_id)}>{t("chat.copyReqId")}</Button> : undefined}>
      <div className="error-block">
        <div className="error-title">{title}</div>
        {why && <div className="muted copy-sm">{why}</div>}
        {evidence && !compact && <div className="muted copy-sm fs-mono error-evidence selectable">{error.code}: {evidence}</div>}
        {next && <div className="copy-sm">{t("error.remediation", { text: next })}</div>}
        {error.req_id && !compact && <div className="muted fs-mono copy-sm">{t("error.reqId", { id: error.req_id })}</div>}
      </div>
    </Callout>
  );
}
