// SPDX-License-Identifier: Apache-2.0
// Phase → orb state mapping (docs/message-stream-ux.md §12). Pure function; the orb renderer only knows OrbState.
import type { Phase } from "../agent/api";

export type OrbState = "working" | "searching" | "composing" | "weaving" | "solving" | "shaping" | "listening" | "connecting" | "breathing" | "paused" | "none";

export type UiPhase = Phase | "fixing" | "stopping";

export function orbStateOf(phase: UiPhase, opts?: { retrying?: boolean }): OrbState {
  if (opts?.retrying) return "connecting";
  switch (phase) {
    case "thinking": return "working";
    case "exploring": return "searching";
    case "designing": return "composing";
    case "building": return "weaving";
    case "fixing": return "solving";
    case "reviewing": return "shaping";
    case "waiting": return "listening";
    case "stopping": return "breathing";
    case "done": return "none";
    case "stopped": return "none";
    case "failed": return "none";
    default: return "breathing";
  }
}

export function phaseIcon(phase: UiPhase): "thinking" | "exploring" | "designing" | "building" | "fixing" | "reviewing" | "waiting" | "stopping" | "done" | "failed" {
  switch (phase) {
    case "stopped": return "failed";
    case "thinking": case "exploring": case "designing": case "building": case "fixing": case "reviewing": case "waiting": case "stopping": case "done": case "failed":
      return phase;
    default: return "thinking";
  }
}
