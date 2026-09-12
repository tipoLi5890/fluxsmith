// SPDX-License-Identifier: Apache-2.0
// Composer: textarea with @ autocomplete, ref chips, paste/drag-drop intake, image previews, /compact hint, context ring, send/stop.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ContextUsage, FindingRow, Ref, UserMessage } from "../../agent/api";
import { findingRef } from "../../agent/finding-ref";
import { useT } from "../../i18n";
import { call, isTauri } from "../../ipc/client";
import type { AttachInfo, SheetInfo } from "../../ipc/types";
import { useToasts } from "../../state/toasts";
import type { Mode, Policy, ProviderConfig } from "../../ipc/types";
import { Button, Chip, Icon, IconButton, ProgressRing, Tooltip } from "../components";
import { instanceByPath, sheetLabel } from "../sheet-paths";
import { netInstance } from "../sidebar/list-scope";
import { comboFromEvent, isComposing, normalizeCombo } from "../shortcuts/keymap";
import type { TurnBlock } from "../harness-bridge";
import { ModeMenu, ModelPicker, type Density } from "./ComposerMenus";
import { IntakeDialog } from "./IntakeDialog";
import { expandDataTransfer, intakeMode, makeItem, needsIntakeCard, registerLibrary, type IntakeItem } from "./intake";
import { useSettings } from "../../state/settings";
import type { ThinkingLevel } from "../harness-bridge";

type MentionGroup = "components" | "nets" | "sheets" | "findings" | "turns" | "attachments";
const MENTION_GROUPS: readonly MentionGroup[] = ["components", "nets", "sheets", "findings", "turns", "attachments"];
interface MentionItem { ref: Ref; label: string; group: MentionGroup }
/** Rows one `@` group offers at most: the panel is a picker, not a browser. */
const MENTION_LIMIT = { components: 20, nets: 10, sheets: 8, findings: 8, turns: 5, attachments: 8 } as const;

/** A component / net row as `read { all_sheets }` and `nets { sheet: null }` answer them. */
interface MentionSymbol { reference: string; value: string; sheet?: string; instance_path?: string }
interface MentionNet { name: string; sheets?: string[] }

export interface ComposerMenuProps {
  mode: Mode; policy: Policy; density: Density; hasPendingCard: boolean; shortcuts: Record<string, string>;
  /** A turn is running: the mode entries are disabled (switching would stop it). */
  running?: boolean;
  /** Modes the environment or the project refuses (UJ-0 / D-57), each with the reason shown on the disabled entry. */
  blocked?: Partial<Record<Mode, string>>;
  onMode: (m: Mode) => void; onPolicy: (p: Policy) => void; onDensity: (d: Density) => void; onSearch: () => void; onJump: () => void;
  providers: ProviderConfig[]; leadModel: string | null; onPickModel: (id: string) => Promise<void>; onOpenModelSettings: () => void;
  onNewSession?: () => void;
  /** Switch the sidebar to the plan panel. */
  onViewPlan?: () => void;
  thinking?: ThinkingLevel;
  onThinking?: (level: ThinkingLevel) => Promise<void>;
}

export function Composer({ projectKey, sheet, sheets, sessionId, running, context, onSend, onStop, onCompact, turns, attachments, findings, selection, onSkipSelection, sendCombo, attachCombo, prefill, onPrefillConsumed, menus }: {
  projectKey: string; sheet: string; sessionId: string; running: boolean; context: ContextUsage | null;
  /** Every sheet instance of the project: `@` reaches all of them, not only the one on screen. */
  sheets: SheetInfo[];
  onSend: (m: UserMessage) => Promise<void>; onStop: (force?: boolean) => Promise<void>; onCompact: () => Promise<void>;
  turns: TurnBlock[]; attachments: AttachInfo[]; findings: FindingRow[]; sendCombo: string; attachCombo: string; prefill?: string | null; onPrefillConsumed?: () => void;
  /** Canvas selection that rides along with the next message, and the control that skips it once. */
  selection: Ref[]; onSkipSelection?: () => void;
  menus: ComposerMenuProps;
}) {
  const t = useT();
  const toasts = useToasts();
  const [text, setText] = useState("");
  const [refs, setRefs] = useState<Ref[]>([]);
  const [pending, setPending] = useState<AttachInfo[]>([]);
  const [intakeItems, setIntakeItems] = useState<IntakeItem[] | null>(null);
  const intakeDefaults = useSettings((s) => s.settings.agent.intake_defaults);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [mention, setMention] = useState<{ query: string; at: number } | null>(null);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [hi, setHi] = useState(0);
  const [stopping, setStopping] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (prefill) { setText(prefill); onPrefillConsumed?.(); ta.current?.focus(); } }, [prefill, onPrefillConsumed]);
  // Canvas → chat: "reference in chat" from the canvas context menu adds chips here.
  useEffect(() => {
    const h = (ev: Event) => {
      const refs = (ev as CustomEvent<Ref[]>).detail ?? [];
      setRefs((r) => { const out = r.slice(); for (const x of refs) if (!out.some((y) => JSON.stringify(y) === JSON.stringify(x))) out.push(x); return out; });
      ta.current?.focus();
    };
    document.addEventListener("fs:canvas-selection", h);
    return () => document.removeEventListener("fs:canvas-selection", h);
  }, []);
  useEffect(() => {
    if (!stopping) return;
    const id = window.setInterval(() => setStopping((s) => (s == null ? s : s + 1)), 1000);
    return () => window.clearInterval(id);
  }, [stopping]);
  useEffect(() => { if (!running) setStopping(null); }, [running]);

  const loadMentions = useCallback(async (q: string) => {
    const out: MentionItem[] = [];
    const ql = q.toLowerCase();
    const here = sheets.find((s) => s.instance_path === sheet) ?? null;
    const named = (path: string | undefined, file: string | undefined) => sheetLabel(instanceByPath(sheets, path ?? ""), file ?? "");
    if (isTauri()) {
      try {
        // The whole project, not the sheet on screen: a component on another sheet is exactly what
        // the human cannot point at otherwise. Each ref carries its own instance so the canvas
        // switches sheets when the chip is used.
        const r = await call("engine_request", { project_key: projectKey, request: { kind: "read", sheet: null, match: q || null, limit: MENTION_LIMIT.components, all_sheets: true }, auth: {} });
        const syms = ((r.data as { symbols?: MentionSymbol[] })?.symbols ?? []).filter((s) => !s.reference.startsWith("#"));
        syms.forEach((s) => {
          const on = s.instance_path ?? sheet;
          const where = sheets.length > 1 ? ` · ${named(on, s.sheet)}` : "";
          out.push({ ref: { kind: "component", ref: s.reference, sheet: on }, label: `${s.reference} ${s.value}${where}`, group: "components" });
        });
        const n = await call("engine_request", { project_key: projectKey, request: { kind: "nets", sheet: null, match: q || null, limit: MENTION_LIMIT.nets }, auth: {} });
        ((n.data as { nets?: MentionNet[] })?.nets ?? []).forEach((x) => {
          // A net the current sheet already carries stays here; one it does not is framed where it lives.
          const to = netInstance(sheets, here, x.sheets);
          out.push({ ref: to ? { kind: "net", name: x.name, sheet: to } : { kind: "net", name: x.name }, label: x.name, group: "nets" });
        });
      } catch { /* ignore */ }
    }
    sheets.filter((s) => { const l = named(s.instance_path, s.file).toLowerCase(); return !ql || l.includes(ql) || s.file.toLowerCase().includes(ql); })
      .slice(0, MENTION_LIMIT.sheets)
      .forEach((s) => out.push({ ref: { kind: "sheet", path: s.instance_path }, label: `${named(s.instance_path, s.file)} · ${s.file}`, group: "sheets" }));
    findings.filter((f) => !f.resolved && !f.waived)
      .filter((f) => !ql || f.code.toLowerCase().includes(ql) || (f.refs ?? []).some((r) => r.toLowerCase().includes(ql)) || (f.location ?? "").toLowerCase().includes(ql))
      .slice(0, MENTION_LIMIT.findings)
      .forEach((f) => out.push({ ref: findingRef(f), label: `${f.code} ${(f.refs ?? []).join(", ") || f.location || ""}`.trim(), group: "findings" }));
    turns.filter((b) => b.turn > 0 && (!ql || String(b.turn).includes(ql) || b.headline.toLowerCase().includes(ql))).slice(-MENTION_LIMIT.turns).forEach((b) => out.push({ ref: { kind: "turn", turn: b.turn }, label: `#${b.turn} ${b.headline}`, group: "turns" }));
    attachments.filter((a) => !ql || a.label.toLowerCase().includes(ql)).slice(0, MENTION_LIMIT.attachments).forEach((a) => out.push({ ref: { kind: "attachment", sha256: a.sha256, label: a.label }, label: a.label, group: "attachments" }));
    setItems(out);
    setHi(0);
  }, [projectKey, sheet, sheets, turns, attachments, findings]);

  useEffect(() => { if (mention) void loadMentions(mention.query); }, [mention?.query, mention, loadMentions]);

  const onChange = (v: string, caret: number) => {
    setText(v);
    const before = v.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    setMention(m ? { query: m[2], at: caret - m[2].length - 1 } : null);
  };
  const pickMention = (it: MentionItem) => {
    if (!mention) return;
    const caret = ta.current?.selectionStart ?? text.length;
    setText(text.slice(0, mention.at) + text.slice(caret));
    setRefs((r) => (r.some((x) => JSON.stringify(x) === JSON.stringify(it.ref)) ? r : [...r, it.ref]));
    setMention(null);
    ta.current?.focus();
  };

  const intake = useCallback(async (files: { path?: string; file?: File; mode?: string | null }[]) => {
    for (const f of files) {
      try {
        let req;
        if (f.path) req = { project_key: projectKey, path: f.path, bytes_base64: null, filename: null, mode: f.mode ?? null };
        else if (f.file) {
          const buf = new Uint8Array(await f.file.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          req = { project_key: projectKey, path: null, bytes_base64: btoa(bin), filename: f.file.name || "pasted", mode: f.mode ?? null };
          if (f.file.type.startsWith("image/")) setPreviews((p) => ({ ...p, [f.file!.name || "pasted"]: URL.createObjectURL(f.file!) }));
        } else continue;
        if (!isTauri()) { toasts.push({ tone: "warning", text: t("error.IPC_TRANSPORT.title") }); continue; }
        const info = await call("attach_intake", { request: req });
        setPending((p) => (p.some((x) => x.sha256 === info.sha256) ? p : [...p, info]));
        setRefs((r) => [...r, { kind: "attachment", sha256: info.sha256, label: info.label }]);
        info.warnings.forEach((w) => toasts.push({ tone: "warning", text: w }));
      } catch (e) { toasts.pushError(e); }
    }
  }, [projectKey, toasts, t]);

  /** Route a set of files: one ordinary file attaches directly, anything else goes through the intake card. */
  const route = useCallback((items: IntakeItem[]) => {
    if (!items.length) return;
    if (needsIntakeCard(items)) setIntakeItems(items);
    else void intake(items.map((it) => ({ path: it.path ?? undefined, file: it.file ?? undefined })));
  }, [intake]);
  const applyIntake = async (items: IntakeItem[]) => {
    setIntakeItems(null);
    // "Add to project symbol library" is a human write: consent + `lib_register` in Rust, one call
    // per library (a `.pretty` group registers as a whole). Everything else is a plain attachment.
    const libs = items.filter((it) => it.action === "library");
    const groups = new Map<string, IntakeItem[]>();
    for (const it of libs) groups.set(it.group ?? it.id, [...(groups.get(it.group ?? it.id) ?? []), it]);
    for (const rows of groups.values()) {
      try {
        const out = await registerLibrary(projectKey, rows);
        toasts.push({ tone: "success", text: t("intake.libRegistered", { nickname: out.nickname, n: out.symbols }) });
      } catch (e) {
        if (e instanceof Error && e.message === "LIB_IMPORT_NEEDS_PATH") toasts.push({ tone: "warning", text: t("intake.libNeedsPath") });
        else toasts.pushError(e);
      }
    }
    await intake(items.filter((it) => it.action !== "ignore" && it.action !== "library").map((it) => ({ path: it.path ?? undefined, file: it.file ?? undefined, mode: intakeMode(it.action) })));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length) { e.preventDefault(); route(files.map((file) => makeItem({ name: file.name, file }, intakeDefaults))); return; }
    const txt = e.clipboardData.getData("text/plain");
    if (txt.includes("(kicad_sch") || txt.includes("(lib_symbols")) { e.preventDefault(); void intake([{ file: new File([txt], "fragment.kicad_sch", { type: "text/plain" }) }]); return; }
    // Some webviews (WebView2) hand over no File for a copied bitmap: fall back to the OS clipboard through Rust (arboard).
    if (!txt && isTauri() && Array.from(e.clipboardData.types ?? []).some((ty) => ty.startsWith("image/") || ty === "Files")) {
      e.preventDefault();
      void call("clipboard_read_image", {}).then((img) => {
        if (!img) return;
        const bytes = Uint8Array.from(atob(img.png_base64), (c) => c.charCodeAt(0));
        void intake([{ file: new File([bytes], "pasted.png", { type: "image/png" }) }]);
      }).catch(() => undefined);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void expandDataTransfer(e.dataTransfer, intakeDefaults).then(route);
  };
  const attachViaDialog = async () => {
    if (!isTauri()) return;
    const picked = await openDialog({ multiple: true });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    route(list.map((path) => makeItem({ name: path.split(/[\\/]/).pop() ?? path, path }, intakeDefaults)));
  };

  const send = async () => {
    const body = text.trim();
    if (!body && refs.length === 0) return;
    if (body === "/compact") { setText(""); await onCompact(); return; }
    const m: UserMessage = { text: body, refs, attachments: pending, session_id: sessionId };
    setText(""); setRefs([]); setPending([]); setPreviews({});
    try { await onSend(m); } catch {
      // The bridge already put the error in the stream; here only the typed content comes back.
      setText(body); setRefs(m.refs); setPending(m.attachments);
      toasts.push({ tone: "warning", text: t("chat.inputKept") });
    }
  };
  const stop = async () => { setStopping(1); await onStop(); };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e.nativeEvent)) return;
    if (mention && items.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % items.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + items.length) % items.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(items[hi]); return; }
      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
    }
    const combo = normalizeCombo(comboFromEvent(e.nativeEvent));
    if (combo === normalizeCombo(sendCombo)) { e.preventDefault(); void send(); }
    else if (combo === normalizeCombo(attachCombo)) { e.preventDefault(); void attachViaDialog(); }
  };

  const groups = useMemo(() => {
    const g: Record<string, MentionItem[]> = {};
    items.forEach((it) => { (g[it.group] ??= []).push(it); });
    return g;
  }, [items]);
  const ctxLevel = context?.level ?? "ok";
  const ctxLabel = context ? `${t("chat.contextUsage", { pct: Math.round(context.pct) })}${ctxLevel === "hint" ? ` — ${t("chat.contextLevelHint")}` : ctxLevel === "auto" ? ` — ${t("chat.contextLevelAuto")}` : ctxLevel === "emergency" ? ` — ${t("chat.contextLevelEmergency")}` : ""}` : t("chat.contextUsage", { pct: 0 });
  // Before the first turn the ring shows 0%: the fixed prompt/tool cost only becomes
  // part of "usage" once a real conversation exists.
  const firstTurnPending = turns.filter((b) => b.turn > 0).length === 0;
  const ctxPct = firstTurnPending ? 0 : Math.round(context?.pct ?? 0);
  const ctxLabelFull = firstTurnPending ? t("chat.contextUsage", { pct: 0 }) : ctxLabel;
  const showSlash = text.startsWith("/");
  return (
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <IntakeDialog items={intakeItems} onApply={applyIntake} onClose={() => setIntakeItems(null)} />
      {/* What the canvas selection adds to the next message, stated before it is sent
          (chat-references-and-attachments.md §4); the dismiss control skips it for that message. */}
      {selection.length > 0 && (
        <div className="row selection-pill copy-sm">
          <Icon name="focus" className="icon-sm" />
          <span className="muted nowrap">{t("chat.selectionAttached")}</span>
          <span className="fs-mono truncate grow">{selectionLabel(selection)}</span>
          {onSkipSelection && <IconButton icon="close" size="sm" variant="ghost" label={t("chat.selectionSkip")} title={t("chat.selectionSkip")} onClick={onSkipSelection} />}
        </div>
      )}
      {(refs.length > 0 || pending.length > 0) && (
        <div className="row wrap chips">
          {refs.map((r, i) => <Chip key={i} icon={r.kind === "attachment" ? "attachment" : r.kind === "net" ? "net" : r.kind === "sheet" ? "sheet" : r.kind === "turn" ? "turn" : r.kind === "region" ? "focus" : "component"} onRemove={() => setRefs((x) => x.filter((_, j) => j !== i))} removeLabel={t("common.remove")}>{chipLabel(r)}</Chip>)}
        </div>
      )}
      {Object.keys(previews).length > 0 && <div className="row wrap">{Object.entries(previews).map(([k, url]) => <img key={k} src={url} alt={t("chat.imagePreview")} className="img-preview" />)}</div>}
      <div className="composer-box">
        <textarea ref={ta} className="composer-input selectable" rows={3} placeholder={t("chat.placeholder")} value={text} onChange={(e) => onChange(e.target.value, e.target.selectionStart)} onKeyDown={onKey} onPaste={onPaste} aria-label={t("chat.title")} />
        {mention && items.length > 0 && (
          <div className="mention-menu" role="listbox">
            {MENTION_GROUPS.map((g) => groups[g]?.length ? (
              <div key={g}>
                <div className="mention-group muted copy-sm">{t(`chat.mention${g[0].toUpperCase()}${g.slice(1)}` as "chat.mentionComponents")}</div>
                {groups[g].map((it) => { const idx = items.indexOf(it); return <button key={idx} type="button" role="option" aria-selected={idx === hi} className={`mention-item ${idx === hi ? "hi" : ""}`} onMouseDown={(e) => { e.preventDefault(); pickMention(it); }}><span className="fs-mono truncate">{it.label}</span></button>; })}
              </div>
            ) : null)}
          </div>
        )}
        {showSlash && <div className="slash-hint muted copy-sm">{t("chat.slashHint")}</div>}
      </div>
      <div className="composer-bar">
        <Tooltip text={`${t("chat.attach")} (${attachCombo})`}><IconButton icon="add" label={t("chat.attach")} onClick={() => void attachViaDialog()} /></Tooltip>
        <ModeMenu mode={menus.mode} policy={menus.policy} density={menus.density} hasPendingCard={menus.hasPendingCard} shortcuts={menus.shortcuts} running={menus.running} blocked={menus.blocked}
          onMode={menus.onMode} onPolicy={menus.onPolicy} onDensity={menus.onDensity} onSearch={menus.onSearch} onJump={menus.onJump} onCompact={() => void onCompact()} onNewSession={menus.onNewSession} onViewPlan={menus.onViewPlan} />
        <span className="grow" />
        <ModelPicker providers={menus.providers} current={menus.leadModel} running={running} usedTokens={context?.used_tokens ?? 0} ceilingTokens={context?.ceiling_tokens ?? 0}
          turnCount={turns.filter((b) => b.turn > 0).length} inBuild={menus.mode === "build"} onPick={menus.onPickModel} onOpenSettings={menus.onOpenModelSettings} thinking={menus.thinking} onThinking={menus.onThinking} />
        <Tooltip text={ctxLabelFull}><ProgressRing pct={ctxPct} level={firstTurnPending ? "ok" : ctxLevel} label={ctxLabelFull} onClick={() => void onCompact()} /></Tooltip>
        <span className="muted copy-sm num">{`${ctxPct}%`}</span>
        {running ? (
          <>
            {stopping != null && <span className="muted copy-sm">{t("chat.stopping", { s: stopping })}</span>}
            {stopping != null && stopping > 15 ? <Button variant="destructive" icon="stopping" onClick={() => void onStop(true)}>{t("chat.forceStop")}</Button> : <Button icon="stopping" onClick={() => void stop()}>{t("chat.stop")}</Button>}
          </>
        ) : (
          <Button variant="primary" icon="play" onClick={() => void send()} disabled={!text.trim() && refs.length === 0}>{t("chat.send")}</Button>
        )}
      </div>
    </div>
  );
}

/** The selected objects, named the way a chip names them; a long selection is counted, not listed. */
const SELECTION_SHOWN = 4;
function selectionLabel(refs: Ref[]): string {
  const shown = refs.slice(0, SELECTION_SHOWN).map(chipLabel).join(", ");
  return refs.length > SELECTION_SHOWN ? `${shown} +${refs.length - SELECTION_SHOWN}` : shown;
}

function chipLabel(r: Ref): string {
  switch (r.kind) {
    case "component": return r.ref;
    case "net": return r.name;
    case "sheet": return r.path;
    case "block": return r.group;
    case "region": return `${r.bbox_mil[0][0]},${r.bbox_mil[0][1]}`;
    case "turn": return `#${r.turn}`;
    case "finding": return r.code;
    case "attachment": return r.label;
  }
}
