// SPDX-License-Identifier: Apache-2.0
// Attachment helpers for the harness (chat-references-and-attachments.md §2–§3).
// Content only enters context when an attach.* tool is called; images are
// attached to that single call and replaced by a text line in history.

import type { AttachInfo } from "../ipc/types";
import { estimateImageTokens } from "./context/tokens";

/** Per-sha cache so a second attach.image returns the cached block without re-reading. */
export class ImageCache {
  private map = new Map<string, { data: string; mimeType: string; est_tokens: number }>();
  get(sha: string) { return this.map.get(sha); }
  set(sha: string, v: { data: string; mimeType: string; width: number; height: number }) {
    this.map.set(sha, { data: v.data, mimeType: v.mimeType, est_tokens: estimateImageTokens(v.width, v.height) });
  }
  clear() { this.map.clear(); }
}

/** History placeholder written instead of the raw image block. */
export function imagePlaceholder(sha: string, label: string): string {
  return `[image ${sha.slice(0, 12)} "${label}" omitted from history]`;
}

/** Intake card body: what the user dropped and the suggested actions. */
export function intakeSummary(a: AttachInfo): { kind: AttachInfo["kind"]; actions: string[] } {
  switch (a.kind) {
    case "lib": return { kind: a.kind, actions: ["attach", "import_request"] };
    case "pdf": return { kind: a.kind, actions: ["attach", "bind_to_part", "copy_to_project"] };
    case "sch": case "fragment": return { kind: a.kind, actions: ["reference", "attach"] };
    case "netlist": case "bom": return { kind: a.kind, actions: ["attach", "compare"] };
    case "image": return { kind: a.kind, actions: ["attach"] };
    case "project_zip": return { kind: a.kind, actions: ["ask"] };
    default: return { kind: a.kind, actions: ["attach"] };
  }
}

/** Text > 2k chars pasted into the input becomes a text attachment (handled by UI intake); here the threshold. */
export const PASTE_TO_ATTACHMENT_CHARS = 2000;
