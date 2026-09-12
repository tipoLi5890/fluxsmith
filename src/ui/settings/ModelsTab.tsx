// SPDX-License-Identifier: Apache-2.0
// "AI models" settings tab: a collapsed provider list (name + status dot + edit/delete),
// one inline edit panel at a time, add-provider / add-custom forms, model catalogue
// fetched from the endpoint (`provider_models`), Codex sign-in as a row, models per role.
import { useMemo, useRef, useState , useEffect } from "react";
import { modelsFor } from "../../agent/models/catalog";
import { RATES_UPDATED, findRateFamily, ratesStale } from "../../agent/models/rates";
import { useT, fmtDate, errorCopy, type MessageKey } from "../../i18n";
import { call, isTauri, IpcFailure } from "../../ipc/client";
import type { Settings, ProviderConfig, ProviderKind, DeviceCodeState } from "../../ipc/types";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { Badge, Button, Callout, Chip, Dialog, Icon, Input, Select, Switch } from "../components";
import "./models.css";

export const PROVIDER_PRESETS: Record<Exclude<ProviderKind, "custom">, { label: string; base_url: string; models: string[]; context: number; vision: boolean; cache: boolean }> = {
  anthropic: { label: "Anthropic", base_url: "https://api.anthropic.com", models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"], context: 200000, vision: true, cache: true },
  openai: { label: "OpenAI", base_url: "https://api.openai.com", models: ["gpt-5", "gpt-5-mini"], context: 200000, vision: true, cache: true },
  google: { label: "Google", base_url: "https://generativelanguage.googleapis.com", models: ["gemini-2.5-pro", "gemini-2.5-flash"], context: 1000000, vision: true, cache: true },
  openrouter: { label: "OpenRouter", base_url: "https://openrouter.ai", models: [], context: 128000, vision: false, cache: false },
  xai: { label: "xAI", base_url: "https://api.x.ai", models: ["grok-4"], context: 256000, vision: true, cache: false },
  groq: { label: "Groq", base_url: "https://api.groq.com", models: [], context: 128000, vision: false, cache: false },
  mistral: { label: "Mistral", base_url: "https://api.mistral.ai", models: [], context: 128000, vision: false, cache: false },
  "openai-codex": { label: "OpenAI Codex", base_url: "https://chatgpt.com", models: ["gpt-5-codex"], context: 200000, vision: true, cache: true },
};

const ROLES = ["lead", "architect", "reviewer", "drafter", "fixer", "librarian", "sourcer", "facts", "explainer"] as const;
const BUILTIN_KINDS = (Object.keys(PROVIDER_PRESETS) as (keyof typeof PROVIDER_PRESETS)[]).filter((k) => k !== "openai-codex");

type Editing = { kind: "provider"; id: string } | { kind: "add" } | { kind: "custom" } | null;

function newProvider(kind: ProviderKind, id: string, label: string, base_url: string): ProviderConfig {
  const preset = kind === "custom" ? null : PROVIDER_PRESETS[kind];
  return {
    id, kind, label, base_url, enabled: true, rates: [0, 0, 0, 0], context_window: preset?.context ?? 32768, build_capable: "unknown",
    vision: preset?.vision ?? false, cache_reporting: preset?.cache ?? false, raw_base64_images: false, models: preset?.models ?? [], probed_at: null, has_secret: false,
  };
}

function errorText(e: unknown, _t: ReturnType<typeof useT>): string {
  // PROVIDER_AUTH is "the provider rejected the key" (401 / 403), never "save the key first".
  if (e instanceof IpcFailure) {
    const c = errorCopy(e.error.code);
    if (c) return `${c.title} ${c.next}`.trim();
    return e.error.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function safeOrigin(u: string | undefined): string { try { return u ? new URL(u).origin : ""; } catch { return u ?? ""; } }

function StatusDot({ p, authorized }: { p: ProviderConfig; authorized: boolean }) {
  const t = useT();
  const ready = p.enabled && (p.kind === "openai-codex" ? authorized : p.has_secret);
  const tone = !ready ? "off" : p.build_capable === "none" ? "warn" : "ok";
  const label = tone === "ok" ? t("settings.models.statusReady") : tone === "warn" ? t("settings.models.statusNoBuild") : t("settings.models.statusNoKey");
  return <span className={`prov-dot prov-dot-${tone}`} role="img" aria-label={label} title={label} />;
}

export function ModelsTab() {
  const t = useT();
  const { settings: s, update } = useSettings();
  const set = (patch: Partial<Settings>) => void update(patch);
  const toasts = useToasts();
  const providers = s.providers;
  const [editing, setEditing] = useState<Editing>(null);
  const [codex, setCodex] = useState<DeviceCodeState | null>(null);
  const [codexRisk, setCodexRisk] = useState(false);
  const [codexMethod, setCodexMethod] = useState<"browser" | "device">("browser");
  const [customConsent, setCustomConsent] = useState<{ provider: ProviderConfig; secret: string } | null>(null);
  const saveProviders = (list: ProviderConfig[]) => set({ providers: list });
  const upd = (id: string, patch: Partial<ProviderConfig>) => saveProviders(providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const codexProvider = providers.find((p) => p.kind === "openai-codex") ?? null;
  const codexAuthorized = codex?.status === "authorized" || !!codexProvider?.has_secret;

  const fetchModels = async (id: string): Promise<string[]> => {
    const list = await call("provider_models", { provider_id: id });
    return list;
  };

  const codexBegin = async (method: "browser" | "device" = codexMethod) => {
    try {
      setCodexMethod(method);
      const ev = await call("consent_record", { event: { project_key: "", card_kind: "codex_risk", payload_sha256: `codex:${method}`, input_kind: "click" } });
      const st = await call("codex_device_begin", { consent_event_id: ev.id, method });
      setCodex(st); setCodexRisk(false);
      // Both methods continue in the system browser: open it right away.
      if (st.verification_url) void call("open_url", { url: st.verification_url }).catch((e) => toasts.pushError(e));
      const gen = ++codexPollGen.current;
      const poll = async () => {
        if (codexPollGen.current !== gen) return; // cancelled or superseded by another login
        let n: DeviceCodeState;
        try { n = await call("codex_device_poll", {}); } catch (e) { toasts.pushError(e); return; }
        if (codexPollGen.current !== gen) return;
        if (n.status === "cancelled") { setCodex(null); return; }
        setCodex(n);
        if (n.status === "pending") setTimeout(() => void poll(), method === "browser" ? 1500 : 3000);
        else if (n.status === "authorized") {
          toasts.push({ tone: "success", text: t("settings.models.codexAuthorized") });
          if (!codexProvider) saveProviders([...useSettings.getState().settings.providers, { ...newProvider("openai-codex", "openai-codex", PROVIDER_PRESETS["openai-codex"].label, PROVIDER_PRESETS["openai-codex"].base_url), has_secret: true }]);
          void useSettings.getState().load();
        }
      };
      void poll();
    } catch (e) { toasts.pushError(e); }
  };
  const codexPollGen = useRef(0);
  const codexCancel = () => { codexPollGen.current++; void call("codex_revoke", {}).catch(() => undefined); setCodex(null); };
  const codexRevoke = () => { codexCancel(); if (codexProvider) upd(codexProvider.id, { has_secret: false }); };

  const confirmCustom = async () => {
    if (!customConsent) return;
    const { provider, secret } = customConsent;
    try {
      const origin = new URL(provider.base_url).origin;
      if (isTauri()) {
        const ev = await call("consent_record", { event: { project_key: "", card_kind: "custom_origin", payload_sha256: origin, input_kind: "click" } });
        await call("origin_register", { origin, consent_event_id: ev.id });
      }
      await commitNew(provider, secret);
      setCustomConsent(null);
    } catch (e) { toasts.push({ tone: "error", text: errorText(e, t) }); }
  };

  /** Remove the row and its secret in one Rust step (a filtered settings patch only merges and would keep both). */
  // Deleting a provider also deletes its stored key: the first click arms, the second (within 4 s) confirms.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  const armDelete = (id: string) => { setConfirmDelete(id); if (armTimer.current) clearTimeout(armTimer.current); armTimer.current = setTimeout(() => setConfirmDelete((c) => (c === id ? null : c)), 4000); };
  const removeProvider = async (id: string) => {
    if (!isTauri()) { saveProviders(providers.filter((x) => x.id !== id)); return; }
    try { const next = await call("provider_remove", { provider_id: id }); useSettings.getState().applyLocal(next); } catch (e) { toasts.pushError(e); }
  };

  /** Add a provider, store its key, then pull the catalogue from the endpoint. */
  const commitNew = async (provider: ProviderConfig, secret: string) => {
    let p = provider;
    // The row must exist before its key is stored: Rust refuses `keyring_set` for an unknown provider id.
    await update({ providers: [...useSettings.getState().settings.providers, p] });
    if (secret && isTauri()) {
      await call("keyring_set", { provider_id: p.id, secret });
      p = { ...p, has_secret: true };
      // Arrays merge as leaves: send the whole list with this row replaced, never a one-element list.
      const cur = useSettings.getState().settings.providers;
      await update({ providers: cur.some((x) => x.id === p.id) ? cur.map((x) => (x.id === p.id ? p : x)) : [...cur, p] });
    }
    setEditing(null);
    if (p.has_secret && isTauri()) {
      try {
        const list = await fetchModels(p.id);
        toasts.push({ tone: "success", text: t("settings.models.fetchedCount", { n: list.length }) });
        // Rust stored the catalogue in settings.json; pull the fresh copy.
        await useSettings.getState().load();
      } catch (e) { toasts.push({ tone: "warning", text: errorText(e, t) }); }
    }
  };

  const modelOptions = providers.filter((p) => p.enabled).flatMap((p) => modelsFor(p).map((m) => ({ value: `${p.id}/${m}`, label: `${p.label} · ${m}`, disabled: p.build_capable === "none" })));
  const ratesOld = ratesStale(s.rates_as_of ?? RATES_UPDATED, new Date());
  /** Copy the built-in table into every provider still at 0/0/0/0, stamp the table date, refresh catalogues. */
  const updateRates = async () => {
    const changed = await useSettings.getState().applyBuiltinRates();
    toasts.push({ tone: "success", text: t("settings.models.ratesApplied", { n: changed, when: fmtDate(RATES_UPDATED) }) });
    if (!isTauri()) return;
    for (const p of useSettings.getState().settings.providers) {
      if (!p.enabled || !(p.has_secret || p.kind === "openai-codex")) continue;
      try { await fetchModels(p.id); } catch { /* catalogue refresh is best-effort */ }
    }
    await useSettings.getState().load();
  };
  const rows = useMemo(() => {
    const list = providers.filter((p) => p.kind !== "openai-codex");
    return list;
  }, [providers]);
  const codexRow: ProviderConfig = codexProvider ?? { ...newProvider("openai-codex", "openai-codex", PROVIDER_PRESETS["openai-codex"].label, PROVIDER_PRESETS["openai-codex"].base_url), enabled: false };

  return (
    <div className="col">
      <p className="muted">{t("settings.models.intro")}</p>
      <Callout tone="warning" icon="security">{t("settings.models.privacy")}</Callout>
      <h3>{t("settings.models.providers")}</h3>
      <div className="prov-list" role="list">
        {!providers.some((p) => p.has_secret) && <Callout tone="info">{t("settings.models.firstRunHint")}</Callout>}
        {rows.map((p) => (
          <div key={p.id} className="prov-item" role="listitem">
            <div className="prov-row">
              <Icon name="provider" className="muted" />
              <span className="prov-name truncate">{p.label}</span>
              <StatusDot p={p} authorized={false} />
              {p.kind === "custom" && <Badge mono>custom</Badge>}
              <span className="grow" />
              <Button size="sm" variant={editing?.kind === "provider" && editing.id === p.id ? "primary" : "secondary"} icon="edit" onClick={() => setEditing(editing?.kind === "provider" && editing.id === p.id ? null : { kind: "provider", id: p.id })}>{t("settings.models.edit")}</Button>
              {confirmDelete === p.id
                ? <Button size="sm" variant="destructive" className="prov-delete" onClick={() => { setConfirmDelete(null); void removeProvider(p.id); if (editing?.kind === "provider" && editing.id === p.id) setEditing(null); }}>{t("settings.models.deleteConfirm")}</Button>
                : <Button size="sm" variant="ghost" className="prov-delete" onClick={() => armDelete(p.id)}>{t("settings.models.delete")}</Button>}
            </div>
            {editing?.kind === "provider" && editing.id === p.id && (
              <ProviderPanel key={p.id} provider={p} onCancel={() => setEditing(null)} onSaved={(next) => { upd(p.id, next); setEditing(null); }} fetchModels={fetchModels} />
            )}
          </div>
        ))}
        <div className="prov-item" role="listitem">
          <div className="prov-row">
            <Icon name="provider" className="muted" />
            <span className="prov-name truncate">{t("settings.models.codex")}</span>
            <StatusDot p={codexRow} authorized={codexAuthorized} />
            <span className="grow" />
            <Button size="sm" variant={editing?.kind === "provider" && editing.id === "openai-codex" ? "primary" : "secondary"} icon="edit" onClick={() => setEditing(editing?.kind === "provider" && editing.id === "openai-codex" ? null : { kind: "provider", id: "openai-codex" })}>{t("settings.models.edit")}</Button>
          </div>
          {editing?.kind === "provider" && editing.id === "openai-codex" && (
            <div className="prov-panel col">
              <p className="muted copy-sm">{t("settings.models.codexHint")}</p>
              {codexAuthorized ? (
                <div className="row wrap">
                  <Badge tone="success">{t("settings.models.codexAuthorized")}</Badge>
                  {codexProvider && <Switch label={t("settings.models.enabled")} checked={codexProvider.enabled} onChange={(v) => upd(codexProvider.id, { enabled: v })} />}
                  <span className="grow" />
                  <Button variant="destructive" size="sm" onClick={codexRevoke}>{t("settings.models.codexRevoke")}</Button>
                </div>
              ) : codex?.status === "pending" ? (
                <Callout tone="info">
                  {codex.user_code ? (
                    <>
                      <div>{t("settings.models.codexCode", { url: codex.verification_url ?? "" })}</div>
                      <div className="fs-mono selectable" style={{ fontSize: 20 }}>{codex.user_code}</div>
                    </>
                  ) : (
                    <div>{t("settings.models.codexBrowserHint")}</div>
                  )}
                  <div className="row wrap" style={{ marginTop: 8 }}>
                    {codex.verification_url && <Button size="sm" icon="open" onClick={() => void call("open_url", { url: codex.verification_url! }).catch((e) => toasts.pushError(e))}>{t("settings.models.codexOpenBrowser")}</Button>}
                    {codex.verification_url && <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(codex.verification_url!)}>{t("settings.models.codexCopyLink")}</Button>}
                    {!codex.user_code && <Button size="sm" variant="ghost" onClick={() => void codexBegin("device")}>{t("settings.models.codexUseDevice")}</Button>}
                    <Button size="sm" variant="ghost" onClick={codexCancel}>{t("common.cancel")}</Button>
                  </div>
                  <div className="muted">{t("settings.models.codexWaiting")}</div>
                </Callout>
              ) : (
                <div className="row"><Button size="sm" onClick={() => setCodexRisk(true)}>{t("settings.models.codexEnable")}</Button></div>
              )}
              {codex && codex.status !== "pending" && codex.status !== "authorized" && <Callout tone="error">{codex.message ?? codex.status}</Callout>}
              {codexAuthorized && (
                <CatalogueEditor provider={codexRow} models={codexRow.models.length ? codexRow.models : modelsFor(codexRow)}
                  onChange={(m) => { if (codexProvider) upd(codexProvider.id, { models: m }); }}
                  fetchModels={async (id) => { const list = await fetchModels(id); return list.length ? list : modelsFor(codexRow); }}
                  canFetch={codexAuthorized} hint={t("settings.models.fetchModelsCodexHint")} />
              )}
              <div className="row" style={{ justifyContent: "flex-end" }}><Button size="sm" onClick={() => setEditing(null)}>{t("common.close")}</Button></div>
            </div>
          )}
        </div>
      </div>
      <div className="prov-add-row">
        {BUILTIN_KINDS.some((k) => !providers.some((p) => p.kind === k)) && <button type="button" className="prov-add" onClick={() => setEditing(editing?.kind === "add" ? null : { kind: "add" })}><Icon name="add" />{t("settings.models.addBuiltin")}</button>}
        <button type="button" className="prov-add" onClick={() => setEditing(editing?.kind === "custom" ? null : { kind: "custom" })}><Icon name="add" />{t("settings.models.addCustom")}</button>
      </div>
      {editing?.kind === "add" && (
        <AddBuiltinForm existing={providers} onCancel={() => setEditing(null)} onSave={(p, secret) => void commitNew(p, secret).catch((e) => toasts.push({ tone: "error", text: errorText(e, t) }))} />
      )}
      {editing?.kind === "custom" && (
        <AddCustomForm existing={providers} onCancel={() => setEditing(null)} onSave={(p, secret) => setCustomConsent({ provider: p, secret })} />
      )}
      <h3>{t("settings.models.byRole")}</h3>
      {ROLES.map((r) => (
        <div key={r} className="srow" data-label={r}>
          <div className="srow-main">
            <div className="label">{t(`settings.models.role.${r}` as MessageKey)}</div>
            {r === "lead" && <div className="muted copy-sm">{t("settings.frozen")}</div>}
          </div>
          <div className="srow-ctl">
            <Select value={s.models_by_role[r] ?? ""} onChange={(e) => set({ models_by_role: { ...s.models_by_role, [r]: e.target.value } })} options={[{ value: "", label: t("common.none") }, ...modelOptions]} />
          </div>
        </div>
      ))}
      <div className="srow" data-label="rates">
        <div className="srow-main">
          <div className="label row wrap">
            <span>{t("settings.models.ratesAsOf", { when: fmtDate(s.rates_as_of ?? RATES_UPDATED) })}</span>
            {ratesOld && <Badge tone="warning">{t("settings.models.ratesStaleBadge")}</Badge>}
          </div>
          <div className="muted copy-sm">{ratesOld ? t("settings.models.ratesExpired") : t("settings.models.ratesBuiltinHint", { when: fmtDate(RATES_UPDATED) })}</div>
        </div>
        <div className="srow-ctl"><Button size="sm" onClick={() => void updateRates()}>{t("settings.models.updateRates")}</Button></div>
      </div>
      <h3>{t("settings.models.disclosure")}</h3>
      <p className="muted copy-sm">{t("settings.models.disclosureBody")}</p>
      <Dialog open={!!customConsent} onClose={() => setCustomConsent(null)} title={t("settings.models.customConsentTitle")} closeLabel={t("common.close")}
        footer={<><Button onClick={() => setCustomConsent(null)}>{t("common.cancel")}</Button><Button variant="primary" consent onClick={() => void confirmCustom()}>{t("common.confirm")}</Button></>}>
        <p>{t("settings.models.customConsentBody", { origin: safeOrigin(customConsent?.provider.base_url) })}</p>
        <Callout tone="warning">{t("settings.models.privacy")}</Callout>
      </Dialog>
      <Dialog open={codexRisk} onClose={() => setCodexRisk(false)} title={t("settings.models.codexRiskTitle")} closeLabel={t("common.close")} destructive
        footer={<><Button onClick={() => setCodexRisk(false)} autoFocus>{t("common.cancel")}</Button><Button variant="destructive" consent onClick={() => void codexBegin()}>{t("settings.models.codexAccept")}</Button></>}>
        <p>{t("settings.models.codexRiskBody")}</p>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function CatalogueEditor({ provider, models, onChange, fetchModels, canFetch, hint }: { provider: ProviderConfig; models: string[]; onChange: (m: string[]) => void; fetchModels: ((id: string) => Promise<string[]>) | null; canFetch: boolean; hint?: string }) {
  const t = useT();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const add = () => { const m = draft.trim(); if (!m) return; if (!models.includes(m)) onChange([...models, m]); setDraft(""); };
  const fetch = async () => {
    if (!fetchModels) return;
    setBusy(true);
    try { const list = await fetchModels(provider.id); onChange(list); toasts.push({ tone: "success", text: t("settings.models.fetchedCount", { n: list.length }) }); }
    catch (e) { toasts.push({ tone: "error", text: errorText(e, t) }); }
    finally { setBusy(false); }
  };
  return (
    <div className="col">
      <div className="row">
        <div className="label grow">{t("settings.models.catalogue")}</div>
        <Button size="sm" icon="download" loading={busy} disabled={!canFetch || !fetchModels} onClick={() => void fetch()}>{t("settings.models.fetchModels")}</Button>
      </div>
      {hint && <div className="muted copy-sm">{hint}</div>}
      <div className="row wrap prov-chips">
        {models.length === 0 && <span className="muted copy-sm">{t("settings.models.catalogueEmpty")}</span>}
        {models.map((m) => <Chip key={m} onRemove={() => onChange(models.filter((x) => x !== m))} removeLabel={t("common.remove")}>{m}</Chip>)}
      </div>
      <div className="row">
        <Input mono value={draft} placeholder={t("settings.models.addModelPlaceholder")} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} className="grow" aria-label={t("settings.models.addModel")} />
        <Button size="sm" icon="add" onClick={add} disabled={!draft.trim()}>{t("settings.models.addModel")}</Button>
      </div>
    </div>
  );
}

function AdvancedFields({ draft, onChange, showUrl }: { draft: ProviderConfig; onChange: (p: ProviderConfig) => void; showUrl: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="col">
      <button type="button" className="prov-collapse" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? "chevronDown" : "chevronRight"} />{t("settings.models.customSettings")}</button>
      {open && (
        <div className="col prov-advanced">
          <Input label={t("settings.models.label")} value={draft.label} onChange={(e) => onChange({ ...draft, label: e.target.value })} />
          {showUrl && <Input mono label={t("settings.models.baseUrl")} hint={t("settings.models.baseUrlHint")} value={draft.base_url} onChange={(e) => onChange({ ...draft, base_url: e.target.value })} />}
          <Switch label={t("settings.models.enabled")} checked={draft.enabled} onChange={(v) => onChange({ ...draft, enabled: v })} />
          <div className="label">{t("settings.models.rates")}</div>
          <div className="row">{draft.rates.map((r, i) => <Input key={i} mono type="number" step="0.01" min={0} value={String(r)} onChange={(e) => { const rates = [...draft.rates] as ProviderConfig["rates"]; rates[i] = Number(e.target.value); onChange({ ...draft, rates }); }} />)}</div>
          {draft.rates.every((r) => r === 0) && <RatesFallbackNote draft={draft} />}
          <Input mono type="number" min={0} label={t("settings.models.contextWindow")} hint={t("settings.models.contextHint")} value={String(draft.context_window)} onChange={(e) => onChange({ ...draft, context_window: Number(e.target.value) })} />
          <Select label={t("settings.models.buildCapable")} value={draft.build_capable} onChange={(e) => onChange({ ...draft, build_capable: e.target.value as ProviderConfig["build_capable"] })} options={(["full", "degraded", "none", "manual", "unknown"] as const).map((v) => ({ value: v, label: t(`settings.models.buildCapable.${v}` as MessageKey) }))} />
          <div className="row wrap">
            <Switch label={t("settings.models.vision")} checked={draft.vision} onChange={(v) => onChange({ ...draft, vision: v })} />
            <Switch label={t("settings.models.cacheReporting")} checked={draft.cache_reporting} onChange={(v) => onChange({ ...draft, cache_reporting: v })} />
            {draft.kind === "custom" && <Switch label={t("settings.models.rawImages")} checked={draft.raw_base64_images} onChange={(v) => onChange({ ...draft, raw_base64_images: v })} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderPanel({ provider, onCancel, onSaved, fetchModels }: { provider: ProviderConfig; onCancel: () => void; onSaved: (next: Partial<ProviderConfig>) => void; fetchModels: (id: string) => Promise<string[]> }) {
  const t = useT();
  const toasts = useToasts();
  const [draft, setDraft] = useState<ProviderConfig>(provider);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "probe" | null>(null);
  const save = async () => {
    setBusy("save");
    try {
      let next = draft;
      if (secret && isTauri()) { await call("keyring_set", { provider_id: provider.id, secret }); next = { ...next, has_secret: true }; }
      onSaved(next);
      toasts.push({ tone: "success", text: t("settings.saved") });
    } catch (e) { toasts.push({ tone: "error", text: errorText(e, t) }); }
    finally { setBusy(null); }
  };
  const removeSecret = async () => {
    try { await call("keyring_delete", { provider_id: provider.id }); setDraft({ ...draft, has_secret: false }); onSaved({ has_secret: false }); }
    catch (e) { toasts.push({ tone: "error", text: errorText(e, t) }); }
  };
  const probe = async () => {
    setBusy("probe");
    try { const r = await call("provider_probe", { provider_id: provider.id, model: draft.models[0] ?? modelsFor(draft)[0] ?? "" }); setDraft({ ...draft, ...r }); onSaved(r); }
    catch (e) { toasts.push({ tone: "error", text: errorText(e, t) }); }
    finally { setBusy(null); }
  };
  return (
    <div className="prov-panel col">
      <div className="label">{t("settings.models.secret")}</div>
      <div className="row">
        <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={draft.has_secret ? t("settings.models.secretSetReplace") : t("settings.models.secretNone")} className="grow" aria-label={t("settings.models.secret")} />
        {draft.has_secret && <Button size="sm" variant="destructive" onClick={() => void removeSecret()}>{t("settings.models.removeSecret")}</Button>}
      </div>
      <div className="muted copy-sm">{t("settings.models.secretHint")}</div>
      <AdvancedFields draft={draft} onChange={setDraft} showUrl={draft.kind === "custom"} />
      <CatalogueEditor provider={draft} models={draft.models} onChange={(models) => setDraft({ ...draft, models })} fetchModels={fetchModels} canFetch={draft.has_secret} hint={draft.has_secret ? undefined : t("settings.models.needKeyFirst")} />
      <div className="row wrap prov-panel-foot">
        <span className="muted copy-sm">{draft.probed_at ? t("settings.models.probedAt", { when: fmtDate(draft.probed_at) }) : ""}</span>
        <span className="grow" />
        <Button size="sm" onClick={() => void probe()} loading={busy === "probe"} disabled={!draft.has_secret}>{t("settings.models.probe")}</Button>
        <Button size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={busy === "save"}>{t("common.save")}</Button>
      </div>
    </div>
  );
}

function AddBuiltinForm({ existing, onCancel, onSave }: { existing: ProviderConfig[]; onCancel: () => void; onSave: (p: ProviderConfig, secret: string) => void }) {
  const t = useT();
  const available = BUILTIN_KINDS.filter((k) => !existing.some((p) => p.kind === k));
  const [kind, setKind] = useState<ProviderKind>(available[0] ?? "anthropic");
  const [secret, setSecret] = useState("");
  const preset = kind === "custom" ? null : PROVIDER_PRESETS[kind];
  const [draft, setDraft] = useState<ProviderConfig>(() => newProvider(kind, kind, preset?.label ?? kind, preset?.base_url ?? ""));
  const pick = (k: ProviderKind) => { setKind(k); const pr = k === "custom" ? null : PROVIDER_PRESETS[k]; setDraft(newProvider(k, k, pr?.label ?? k, pr?.base_url ?? "")); };
  return (
    <div className="prov-panel col">
      <Select label={t("settings.models.kind")} value={kind} onChange={(e) => pick(e.target.value as ProviderKind)} options={available.map((k) => ({ value: k, label: PROVIDER_PRESETS[k].label }))} />
      {available.length === 0 && <div className="muted copy-sm">{t("settings.models.allAdded")}</div>}
      <Input type="password" autoComplete="off" label={t("settings.models.secret")} hint={t("settings.models.secretHint")} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t("settings.models.secretPlaceholder")} />
      <AdvancedFields draft={draft} onChange={setDraft} showUrl={false} />
      <div className="row prov-panel-foot" style={{ justifyContent: "flex-end" }}>
        <Button size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" variant="primary" disabled={available.length === 0} onClick={() => onSave(draft, secret)}>{t("common.save")}</Button>
      </div>
    </div>
  );
}

function AddCustomForm({ existing, onCancel, onSave }: { existing: ProviderConfig[]; onCancel: () => void; onSave: (p: ProviderConfig, secret: string) => void }) {
  const t = useT();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const idOk = /^[a-z][a-z0-9-]{1,31}$/.test(id) && !existing.some((p) => p.id === id);
  let urlOk = false;
  try { const u = new URL(url); urlOk = u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")); } catch { urlOk = false; }
  const draft: ProviderConfig = { ...newProvider("custom", id || "custom", label || id, url), models };
  return (
    <div className="prov-panel col">
      <div className="label">{t("settings.models.custom")}</div>
      <Input mono label={t("settings.models.providerId")} hint={t("settings.models.providerIdHint")} value={id} placeholder="acme-gateway" onChange={(e) => setId(e.target.value.trim().toLowerCase())} error={id && !idOk ? t("settings.models.providerIdInvalid") : undefined} />
      <Input label={t("settings.models.displayName")} value={label} placeholder={t("settings.models.displayName")} onChange={(e) => setLabel(e.target.value)} />
      <Input mono label={t("settings.models.apiUrl")} hint={t("settings.models.baseUrlHint")} value={url} placeholder="https://gateway.example/v1" onChange={(e) => setUrl(e.target.value.trim())} error={url && !urlOk ? t("settings.models.apiUrlInvalid") : undefined} />
      <div className="muted copy-sm">{t("settings.models.protocolNote")}</div>
      <Input type="password" autoComplete="off" label={t("settings.models.secret")} hint={t("settings.models.secretHint")} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={t("settings.models.secretPlaceholder")} />
      <CatalogueEditor provider={draft} models={models} onChange={setModels} fetchModels={null} canFetch={false} hint={t("settings.models.fetchAfterSave")} />
      <div className="row prov-panel-foot" style={{ justifyContent: "flex-end" }}>
        <Button size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button size="sm" variant="primary" disabled={!idOk || !urlOk} onClick={() => onSave({ ...draft, label: label || id }, secret)}>{t("common.save")}</Button>
      </div>
    </div>
  );
}

/** Under 0/0/0/0: say whether the harness bills with the built-in table (and that Codex numbers are estimates) or nothing. */
function RatesFallbackNote({ draft }: { draft: ProviderConfig }) {
  const t = useT();
  const model = draft.models[0] ?? modelsFor(draft)[0];
  const entry = model ? findRateFamily(draft.kind, model) : undefined;
  if (!entry) return <div className="muted copy-sm">{t("settings.models.ratesLocal")}</div>;
  return (
    <div className="row wrap muted copy-sm">
      <span>{t("settings.models.ratesBuiltin", { when: fmtDate(entry.as_of) })}</span>
      <span className="fs-mono">{entry.rates.join(" / ")}</span>
      {entry.estimated && <Badge tone="info">{t("settings.models.ratesEstimated")}</Badge>}
    </div>
  );
}
