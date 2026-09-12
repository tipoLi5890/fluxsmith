// SPDX-License-Identifier: Apache-2.0
// Conversation sessions: one project has many; the harness bridge is attached
// to exactly one at a time. Switching = detach → set the tab's sessionId →
// attach. The last session per project is remembered in local prefs.
import { call, isTauri } from "../ipc/client";
import { usePrefs } from "../state/prefs";
import { useProjects } from "../state/projects";
import { bridgeFor } from "./harness-bridge";

export interface SessionRow { session_id: string; title: string | null; created: string; updated: string; messages: number }

export async function listSessions(projectKey: string): Promise<SessionRow[]> {
  if (!isTauri()) return [];
  try { return ((await call("db_query", { query: { kind: "session_list", project_key: projectKey } })) as SessionRow[]) ?? []; } catch { return []; }
}

/** Attach the tab's bridge to `sessionId` (detaching the current one first). */
export async function switchSession(projectKey: string, sessionId: string): Promise<void> {
  const bridge = bridgeFor(projectKey);
  const st = useProjects.getState();
  if (st.tabs.find((x) => x.key === projectKey)?.sessionId === sessionId && bridge.getState().ready) return;
  await bridge.getState().detach();
  st.setFlags(projectKey, { sessionId });
  usePrefs.getState().setLastSession(projectKey, sessionId);
  await bridge.getState().attach(projectKey, sessionId);
}

/** Create an empty conversation and switch to it. */
export async function newSession(projectKey: string): Promise<string | null> {
  if (!isTauri()) return null;
  const r = (await call("db_query", { query: { kind: "session_create", project_key: projectKey } })) as { session_id: string };
  await switchSession(projectKey, r.session_id);
  return r.session_id;
}

/** Pick the session to open for a project: the remembered one when it still exists, else the newest, else a fresh one. */
export async function resolveSession(projectKey: string): Promise<string> {
  if (!isTauri()) return `local-${projectKey}`;
  const list = await listSessions(projectKey);
  const remembered = usePrefs.getState().lastSession[projectKey];
  if (remembered && list.some((s) => s.session_id === remembered)) return remembered;
  if (list[0]) return list[0].session_id;
  const r = (await call("db_query", { query: { kind: "session_create", project_key: projectKey } })) as { session_id: string };
  return r.session_id;
}
