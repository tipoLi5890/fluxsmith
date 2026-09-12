// SPDX-License-Identifier: Apache-2.0
// The engine's `net_map` for one sheet: fetched once per (project, sheet, revision), never
// recomputed in the webview. Exposes lookups the canvas and status bar use.

import { useEffect, useRef, useState } from "react";
import { call, isTauri } from "../../ipc/client";
import type { NetMapResult } from "../../ipc/types";

const EMPTY: NetMapResult = { sheet: "", wires: {}, labels: {}, pins: {}, sheet_pins: {} };

export function useNetMap(projectKey: string, sheet: string, revision: number): NetMapResult | null {
  const [map, setMap] = useState<NetMapResult | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!isTauri() || !projectKey || !sheet) { setMap(null); return; }
    void (async () => {
      try {
        const res = await call("engine_request", { project_key: projectKey, request: { kind: "net_map", sheet }, auth: {} });
        if (mine !== seq.current) return;
        setMap(res.ok ? (res.data as NetMapResult) : EMPTY);
      } catch {
        if (mine === seq.current) setMap(EMPTY);
      }
    })();
  }, [projectKey, sheet, revision]);
  return map;
}
