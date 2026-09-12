// SPDX-License-Identifier: Apache-2.0
// The one waiver form: the reason and the expiry the Rust gate asks for before a finding is hidden.
// Both places a human can waive — the review card (`chat/CardView.tsx`) and the findings panel
// (`sidebar/Sidebar.tsx`) — mount this, so "waive" means the same thing and sends the same payload
// in both: an Error needs a written reason of at least WAIVER_REASON_MIN characters and an expiry,
// a Warning or an info finding may leave the reason empty (the record then carries
// WAIVE_REASON_DEFAULT). The verdict stays the engine's; this only collects what the record names.
import { useState } from "react";
import { useT } from "../../i18n";
import { Button, Icon, Input, TextArea } from "./index";
import { expiryDate, reasonOk, WAIVER_DAY_CHOICES, WAIVER_DEFAULT_DAYS, WAIVER_REASON_MIN } from "../../agent/review-waiver";

export interface WaiverFormProps {
  /** How many findings this waiver would cover (named in the intro line). */
  count: number;
  /** Any Error in the selection: the reason and the expiry become mandatory (Rust WAIVER_SEVERITY). */
  hasError: boolean;
  /** Distinguishes the expiry radio group from every other one on the page. */
  name: string;
  /** A request is in flight: the buttons wait for it. */
  busy?: boolean;
  /** Marks the record button as consent-bearing (the review card's waive action carries a grant). */
  consent?: boolean;
  onCancel: () => void;
  onSubmit: (reason: string, expires: string) => void;
}

export function WaiverForm({ count, hasError, name, busy, consent, onCancel, onSubmit }: WaiverFormProps) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState<string>(() => expiryDate(WAIVER_DEFAULT_DAYS));
  const ready = count > 0 && reasonOk(reason, hasError) && (!hasError || !!expires);
  // Plain-text validation line (never colour alone): what is still missing, in characters.
  const hint = !hasError
    ? t("card.waiver.reasonOptionalHint")
    : reason.trim().length >= WAIVER_REASON_MIN
      ? t("card.waiver.reasonEnough")
      : t("card.waiver.reasonMore", { n: WAIVER_REASON_MIN - reason.trim().length });
  return (
    <div className="review-waiver" role="group" aria-label={t("card.waiver.title")}>
      <div className="hardstop-zone-label"><Icon name="security" className="icon-sm" /> {t("card.waiver.title")}</div>
      <p className="copy-sm">{t("card.waiver.intro", { n: count })}</p>
      <TextArea label={t("card.waiver.reasonLabel")} placeholder={t("card.waiver.reasonPlaceholder")} value={reason} rows={2} autoFocus
        required={hasError} aria-required={hasError} onChange={(e) => setReason(e.target.value)} />
      <div className="muted copy-sm review-waiver-hint">{hint}</div>
      <div className="question-options" role="radiogroup" aria-label={t("card.waiver.expiryLabel")}>
        {WAIVER_DAY_CHOICES.map((d) => {
          const v = expiryDate(d);
          return (
            <label key={d} className={`question-option ${expires === v ? "checked" : ""}`}>
              <input type="radio" name={`waive-${name}`} value={v} checked={expires === v} onChange={() => setExpires(v)} />
              <span>{t("card.waiver.days", { n: d })}</span>
            </label>
          );
        })}
      </div>
      <Input type="date" label={t("card.waiver.expiryLabel")} value={expires} min={expiryDate(1)} onChange={(e) => setExpires(e.target.value)} />
      <div className="row card-actions">
        <span className="grow" />
        <Button variant="secondary" disabled={!!busy} onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" consent={consent} loading={!!busy} disabled={!!busy || !ready} onClick={() => onSubmit(reason, expires)}>{t("card.waiver.record")}</Button>
      </div>
    </div>
  );
}
