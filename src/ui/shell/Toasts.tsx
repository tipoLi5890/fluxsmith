// SPDX-License-Identifier: Apache-2.0
import { useToasts } from "../../state/toasts";
import { useT } from "../../i18n";
import { Button, Callout, IconButton } from "../components";

export function Toasts() {
  const t = useT();
  const { toasts, dismiss } = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className="toast">
          <Callout tone={x.tone} actions={<>
            {x.action && <Button size="sm" onClick={() => { x.action?.run(); dismiss(x.id); }}>{x.action.label}</Button>}
            <IconButton icon="close" label={t("common.close")} onClick={() => dismiss(x.id)} />
          </>}>{x.text}</Callout>
        </div>
      ))}
    </div>
  );
}
