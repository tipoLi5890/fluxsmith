// SPDX-License-Identifier: Apache-2.0
// Root: one window, project tabs; left sidebar / centre canvas / right chat; settings & shortcuts dialogs; env gate; toasts.
import { usePrefs } from "../state/prefs";
import { newSession, resolveSession } from "./sessions";
import { useCallback, useEffect, useState } from "react";
import type { Ref } from "../agent/api";
import { useT, useLang, type MessageKey } from "../i18n";
import { call, isTauri, onAppEvent } from "../ipc/client";
import type { AppEvent, Mode } from "../ipc/types";
import { useEnv } from "../state/env";
import { useProjects, loadPersistedTabs } from "../state/projects";
import { useSettings, applyTheme } from "../state/settings";
import { useToasts } from "../state/toasts";
import { CanvasPanel } from "./canvas-panel/CanvasPanel";
import { ChatPanel } from "./chat/ChatPanel";
import { Button, Callout, Dialog, SplitPane, hasOpenDialog } from "./components";
import { errorCopy } from "../i18n";
import { installFonts } from "./fonts";
import { bridgeFor } from "./harness-bridge";
import { SettingsDialog } from "./settings/SettingsDialog";
import { EnvGate } from "./shell/EnvGate";
import { ProjectTabs } from "./shell/ProjectTabs";
import { Toasts } from "./shell/Toasts";
import { Welcome, IdentityDialog } from "./shell/Welcome";
import { ShortcutsDialog } from "./shortcuts/ShortcutsDialog";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { useIndexStore } from "./sidebar/index-state";
import { Sidebar } from "./sidebar/Sidebar";
import "../styles/base.css";
import "./app.css";

installFonts();

export function App() {
  const t = useT();
  const lang = useLang();
  const settings = useSettings();
  const env = useEnv();
  const projects = useProjects();
  const toasts = useToasts();
  const [settingsOpen, setSettingsOpen] = useState<null | "general" | "environment" | "models" | "agent" | "skills" | "project" | "storage" | "privacy" | "advanced">(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [revision, setRevision] = useState(0);
  const [requestedMode, setRequestedMode] = useState<Mode | null>(null);
  /** One-shot "frame these on the canvas" requests from the sidebar / chat; `seq` makes each click distinct. */
  const [externalFocus, setExternalFocus] = useState<{ seq: number; refs: Ref[] }>({ seq: 0, refs: [] });
  // First run of a new version: disclose bytes-affecting changes once (docs/updates-and-compatibility.md §4).
  const [disclosure, setDisclosure] = useState<{ version: string; bytes_affecting: string[]; entries: string[] } | null>(null);
  const active = projects.tabs.find((x) => x.key === projects.activeKey) ?? null;

  useEffect(() => {
    document.documentElement.lang = lang;
    void (async () => {
      await settings.load();
      await env.check(false);
      if (isTauri()) {
        try {
          const d = await call("update_disclosure", {});
          if (d.version && useSettings.getState().settings.disclosed_version !== d.version) setDisclosure(d);
        } catch { /* optional */ }
      }
      await projects.loadRecent();
      let startupArgs: string[] = [];
      if (isTauri()) { try { startupArgs = await call("startup_args", {}); } catch { /* no args */ } }
      const scripted = startupArgs.some((p) => p.startsWith("--script="));
      // A scripted run (golden set / dogfood) starts from a clean shell: no restored tabs.
      if (useSettings.getState().settings.restore_tabs_on_launch && isTauri() && !scripted) {
        for (const p of loadPersistedTabs()) { await projects.open(p); if (useProjects.getState().error) useProjects.setState({ error: null }); }
      }
      if (isTauri()) {
        try {
          for (const p of startupArgs) {
            // `--settings=<tab>` / `--script=<file>` are developer conveniences for screenshots/tests.
            if (p.startsWith("--settings=")) document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: p.slice("--settings=".length) }));
            else if (p.startsWith("--script=")) { const { maybeAutorun } = await import("./autorun"); void maybeAutorun(); }
            else await projects.open(p);
          }
        } catch { /* no args */ }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  // Attach a harness bridge per tab and detect unfinished turns (crash recovery).
  useEffect(() => {
    if (!active) return;
    const bridge = bridgeFor(active.key);
    if (!bridge.getState().ready) {
      void (async () => {
        let sessionId = active.sessionId;
        if (!sessionId) {
          try { sessionId = await resolveSession(active.key); } catch { sessionId = null; }
        }
        sessionId ??= `local-${active.key}`;
        projects.setFlags(active.key, { sessionId });
        usePrefs.getState().setLastSession(active.key, sessionId);
        await bridge.getState().attach(active.key, sessionId);
        // Cloud-sync folder (SPEC UJ-11): one-time notice per project with the three-part copy.
        if (active.info.cloud_synced && !usePrefs.getState().dismissedTips[`cloud:${active.key}`]) {
          const c = errorCopy("CLOUD_SYNC_FOLDER");
          if (c) toasts.push({ tone: "warning", sticky: true, text: `${c.title} — ${c.why} ${c.next}`, action: { label: t("common.dontShowAgain"), run: () => usePrefs.getState().dismissTip(`cloud:${active.key}`) } });
        }
      })();
    }
  }, [active?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rust → webview events.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void onAppEvent((e: AppEvent) => {
      switch (e.kind) {
        case "fs_changed": setRevision((r) => r + 1); if (e.external) toasts.push({ tone: "warning", text: t("event.fsChanged", { files: e.files.join(", ") }) }); void projects.refresh(e.project_key); break;
        case "lock_detected": toasts.push({ tone: "warning", text: t("event.lockDetected", { file: e.file }) }); void projects.refresh(e.project_key); break;
        // KiCad closed the sheet: `info.locked` drives the rollback button and the sidebar badge, so re-read it now
        // rather than at the next file change.
        case "lock_released": toasts.push({ tone: "info", text: t("event.lockReleased", { file: e.file }) }); void projects.refresh(e.project_key); break;
        case "symbol_index": useIndexStore.getState().set({ state: e.state, done: e.done, total: e.total }); if (e.state === "error") toasts.push({ tone: "error", text: t("event.symbolIndexError") }); break;
        case "session_expired": toasts.push({ tone: "warning", text: t("event.sessionExpired", { reason: e.reason }) }); break;
        case "env_changed": env.setReport(e.report); toasts.push({ tone: "info", text: t("event.envChanged") }); break;
        case "notification": {
          toasts.push({ tone: "info", text: `${e.title}: ${e.body}` });
          if (e.project_key && e.project_key !== useProjects.getState().activeKey) useProjects.getState().setFlags(e.project_key, { needsYou: true });
          break;
        }
        // Open With / a file dropped on the app icon while fluxsmith is already running: the same
        // work as a click on a recent project (a first launch takes the path from `startup_args`).
        case "open_file": void useProjects.getState().open(e.path); break;
        case "log": break;
      }
    }).then((u) => { un = u; });
    return () => un?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = (e: Event) => setSettingsOpen(((e as CustomEvent).detail as typeof settingsOpen) ?? "general");
    document.addEventListener("fs:open-settings", h);
    return () => document.removeEventListener("fs:open-settings", h);
  }, []);

  const onShortcut = useCallback((action: string) => {
    const st = useProjects.getState();
    const idx = st.tabs.findIndex((x) => x.key === st.activeKey);
    switch (action) {
      case "stop": if (st.activeKey) void bridgeFor(st.activeKey).getState().stop(); return;
      case "modePlan": setRequestedMode("plan"); return;
      case "modeBuild": setRequestedMode("build"); return;
      case "modeReview": setRequestedMode("review"); return;
      case "jumpCard": { const id = st.activeKey ? bridgeFor(st.activeKey).getState().pendingCardId : null; if (id) document.getElementById(`card-${id}`)?.scrollIntoView({ block: "center" }); return; }
      case "escape": if (hasOpenDialog()) return false; setSettingsOpen(null); setShowShortcuts(false); return;
      case "searchCanvas": document.dispatchEvent(new CustomEvent("fs:canvas-search")); return;
      case "cyclePanes":
      case "cyclePanesBack": {
        const panes = Array.from(document.querySelectorAll<HTMLElement>(".sidebar, .canvas-panel, .composer-input"));
        if (!panes.length) return;
        const cur = panes.findIndex((p) => p.contains(document.activeElement));
        const step = action === "cyclePanesBack" ? -1 : 1;
        panes[((cur < 0 ? (step > 0 ? -1 : 0) : cur) + step + panes.length) % panes.length]?.focus();
        return;
      }
      case "prevTab": if (idx > 0) st.activate(st.tabs[idx - 1].key); return;
      case "nextTab": if (idx >= 0 && idx < st.tabs.length - 1) st.activate(st.tabs[idx + 1].key); return;
      case "closeTab": if (st.activeKey) document.dispatchEvent(new CustomEvent("fs:request-close-tab", { detail: st.activeKey })); return;
      case "newSession": if (st.activeKey) void newSession(st.activeKey); return;
      case "compact": if (st.activeKey) void bridgeFor(st.activeKey).getState().compact(); return;
      case "settings": setSettingsOpen("general"); return;
      case "help": setShowShortcuts(true); return;
      case "themeToggle": { const cur = useSettings.getState().settings.theme; const next = cur === "dark" ? "light" : "dark"; void useSettings.getState().update({ theme: next }); applyTheme(next); return; }
      default: return false;
    }
  }, []);
  useShortcuts(onShortcut);

  const onFocus = useCallback((refs: Ref[]) => { setExternalFocus((s) => ({ seq: s.seq + 1, refs })); }, []);
  const onSaveRule = useCallback(() => { if (active) document.dispatchEvent(new CustomEvent("fs:open-settings", { detail: "skills" })); }, [active]);

  if (!settings.loaded) return <div className="boot" />;
  const gate = env.report && env.report.status === "incomplete" && !env.dismissedGate && isTauri();
  return (
    <div className="app" data-density={settings.settings.agent.chat_density}>
      {gate ? <EnvGate onOpenSettings={() => setSettingsOpen("environment")} /> : (
        <>
          <ProjectTabs onOpenSettings={() => setSettingsOpen("general")} />
          {/* `degraded` (KiCad 9 with working libraries) keeps viewing, questions and Review; only Plan and Build are stopped. */}
          {env.report && env.report.status !== "ok" && isTauri() && <Callout tone="warning" actions={<Button size="sm" onClick={() => setSettingsOpen("environment")}>{t("env.openSettings")}</Button>}>{t(env.report.status === "degraded" ? "env.degraded" : "env.incomplete")}</Callout>}
          <div className="main">
            {active ? (
              <SplitPane side="left" initial={320} min={240} max={560} storageKey="left2" left={<Sidebar tab={active} bridge={bridgeFor(active.key)} onFocus={onFocus} />}
                right={<SplitPane side="right" initial={440} min={320} max={800} storageKey="right"
                  left={<CanvasPanel key={active.key} tab={active} bridge={bridgeFor(active.key)} revision={revision} externalFocus={externalFocus} />}
                  right={<ChatPanel tab={active} bridge={bridgeFor(active.key)} requestedMode={requestedMode} onModeConsumed={() => setRequestedMode(null)} onSaveRule={onSaveRule} onFocusCanvas={onFocus} />} />} />
            ) : <Welcome />}
      <IdentityDialog />
          </div>
        </>
      )}
      <SettingsDialog open={settingsOpen !== null} onClose={() => setSettingsOpen(null)} initialTab={settingsOpen} />
      <ShortcutsDialog open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <Dialog open={!!disclosure} onClose={() => setDisclosure(null)} title={t("disclosure.title", { ver: disclosure?.version ?? "" })} closeLabel={t("common.close")}
        footer={<Button variant="primary" autoFocus onClick={() => { const v = disclosure?.version ?? null; setDisclosure(null); void useSettings.getState().update({ disclosed_version: v }); }}>{t("common.ok")}</Button>}>
        <p>{t("disclosure.body")}</p>
        {disclosure && disclosure.bytes_affecting.length === 0 ? <p className="muted copy-sm">{t("disclosure.none")}</p> : <ul className="copy-sm">{disclosure?.bytes_affecting.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </Dialog>
      <Toasts />
      <span className="sr-only">{t("app.tagline" as MessageKey)}</span>
    </div>
  );
}
