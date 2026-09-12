// SPDX-License-Identifier: Apache-2.0
// Codex OAuth device-code flow, webview side (red line 16). The risk-consent
// card must precede `begin`; polling and token storage happen in Rust.

import { call } from "../ipc/client";
import type { DeviceCodeState } from "../ipc/types";

export interface DeviceCodeFlow {
  state: DeviceCodeState;
  stop(): void;
}

export async function beginCodexDeviceCode(consentEventId: string, onState: (s: DeviceCodeState) => void, pollMs = 5000): Promise<DeviceCodeFlow> {
  let state = await call("codex_device_begin", { consent_event_id: consentEventId });
  onState(state);
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  if (state.status === "pending") {
    timer = setInterval(async () => {
      try {
        state = await call("codex_device_poll", {});
        onState(state);
        if (state.status !== "pending") stop();
      } catch (e) {
        state = { status: "error", user_code: null, verification_url: null, expires_at: null, message: String(e) };
        onState(state);
        stop();
      }
    }, pollMs);
  }
  return { get state() { return state; }, stop };
}

export function revokeCodex(): Promise<null> {
  return call("codex_revoke", {});
}
