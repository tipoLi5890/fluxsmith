// SPDX-License-Identifier: Apache-2.0
// Safe markdown renderer: produces React elements only (text nodes), never innerHTML, never raw HTML.
// Supported: headings, paragraphs, bullet/numbered lists, code fences, inline code, bold, italic, links (http/https only), tables.
import React from "react";
import type { Ref } from "../../agent/api";
import { call, isTauri } from "../../ipc/client";

/** The chip syntax `[[ref:kind:value]]` as a typed ref; an unknown kind reads as a component designator. */
export function chipRef(kind: string, value: string): Ref {
  switch (kind) {
    case "net": return { kind: "net", name: value };
    case "sheet": return { kind: "sheet", path: value };
    case "block": return { kind: "block", group: value };
    case "finding": return { kind: "finding", code: value };
    default: return { kind: "component", ref: value };
  }
}

/** What a ref is called: the designator, the net name, the sheet path, the finding code. */
export function refValue(r: Ref): string {
  switch (r.kind) {
    case "component": return r.ref;
    case "net": return r.name;
    case "sheet": return r.path;
    case "block": return r.group;
    case "finding": return r.code;
    default: return "";
  }
}

/**
 * A clickable reference to something on the canvas, in chat prose and in the turn summaries. The
 * click is a request, not an action: the canvas panel decides which sheet has it and frames it.
 */
export function RefChip({ target, label }: { target: Ref; label?: string }) {
  const value = refValue(target);
  return (
    <button type="button" className={`ref-chip ref-chip-${target.kind}`} title={`${target.kind} ${value}`}
      onClick={() => document.dispatchEvent(new CustomEvent("fs:focus-ref", { detail: { kind: target.kind, value, ref: target } }))}>{label ?? value}</button>
  );
}

/** Open a link in the system browser: through Rust in the app (allowlisted https), a new tab in the dev browser. */
async function openExternal(href: string): Promise<void> {
  if (isTauri()) { try { await call("open_url", { url: href }); } catch { /* refused by the allowlist: nothing to open */ } }
  else window.open(href, "_blank", "noopener,noreferrer");
}

type Inline = React.ReactNode;

const SAFE_HREF = /^https?:\/\//i;

function renderInline(text: string, keyBase: string): Inline[] {
  const out: Inline[] = [];
  // tokens: `code`, **bold**, *italic*, [text](url)
  // `[[ref:kind:value]]` is the agent's chip syntax for components / nets / sheets: rendered as a clickable chip that focuses the canvas.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[\[ref:(component|net|sheet|block|finding):([^\]]+)\]\])|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) out.push(<code key={k} className="md-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else if (tok.startsWith("[[ref:")) {
      const kind = m[5] ?? "component";
      const value = (m[6] ?? "").trim();
      out.push(<RefChip key={k} target={chipRef(kind, value)} />);
    } else if (tok.startsWith("[")) {
      const label = tok.slice(1, tok.indexOf("]("));
      const href = m[8] ?? "";
      // Inside the Tauri webview a plain anchor would navigate the app; the audited `open_url` command (https only) opens the browser.
      out.push(SAFE_HREF.test(href) ? <a key={k} href={href} rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); void openExternal(href); }}>{label}</a> : label);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} className="md-pre"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(3, h[1].length);
      const Tag = (`h${level + 1}`) as "h2" | "h3" | "h4";
      blocks.push(<Tag key={key++} className="md-h">{renderInline(h[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{renderInline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""), `li${key}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={key++} className="md-list">{items}</ol> : <ul key={key++} className="md-list">{items}</ul>);
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1]?.trim().match(/^\|?\s*:?-+/)) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        i++;
      }
      const [head, , ...body] = rows;
      blocks.push(
        <div key={key++} className="md-table-wrap"><table className="md-table">
          <thead><tr>{head.map((c, ci) => <th key={ci}>{renderInline(c, `th${key}-${ci}`)}</th>)}</tr></thead>
          <tbody>{body.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, `td${key}-${ri}-${ci}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("```") && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(<p key={key++} className="md-p">{renderInline(buf.join(" "), `p${key}`)}</p>);
  }
  return <div className={["md selectable", className].filter(Boolean).join(" ")}>{blocks}</div>;
}
