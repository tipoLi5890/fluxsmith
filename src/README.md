# `src/` — React webview

The frontend runs the agent loop, the chat, the canvas and the settings UI. There is **no Node
runtime**: everything here is bundled by Vite and executed inside the platform webview, and anything
that touches the OS goes through Tauri IPC to [`../src-tauri/`](../src-tauri).

```
agent/     the agent harness — loop, policy, tools, plans, skills, workflows, context
canvas/    the self-drawn read-only schematic canvas
ui/        chat, canvas panel, sidebar, settings, shell, shortcuts
i18n/      four UI languages, plus error and finding copy
ipc/       the typed client for the Rust command surface
state/     zustand stores (projects, settings, preferences, environment, toasts)
styles/    design tokens, base stylesheet, vendored Geist fonts
```

## `agent/`

- `pi-adapter.ts` — the **single** point of contact with the model libraries: agent construction,
  hook mounting, provider cache breakpoints, native web tools and image blocks, credential store
  delegation to Rust. Types are pinned and centralised here so nothing else depends on them.
- `net-shim.ts` — overrides `globalThis.fetch`: provider and registered custom origins are routed to
  the Rust `net_fetch` streaming channel, non-`http(s)` schemes and same-origin requests pass
  through, and everything else is refused with no fallback.
- `lead.ts` — the Lead loop: one message per turn, turn begin, subagent dispatch, serialised verify
  and apply, hard-stop waiting, turn event emission.
- `subagents/` — per-role tool allowlists, output schemas and frozen prefixes; one agent per run.
- `policy/` — the P0–P12 policy hooks as pure functions, plus the hook bus. These are code, not
  prompt text, and they are the first of the two enforcement points (Rust is the second).
- `turns/`, `plans/` — turn state, the ledger, summaries, rollback consent, compaction; the
  `DesignPlan` schema, its versioning and the plan card data.
- `tools/` — the tool catalogue and registry. `toolTable(mode, role)` is frozen for the lifetime of
  a BuildSession; Plan and Review tables contain no write tool, and only the Lead ever holds one.
- `skills/`, `workflows/` — `SKILL.md` parsing, the layered registry and lint; workflow definitions,
  the YAML interpreter and its load-time static rules.
- `context/` — the context assembler (tools, then system, then messages), the cache breakpoints, and
  compaction. History is append-only and rewritten only at a compaction boundary.
- `replay/` — record and replay of provider transcripts, used by the tests.

## `canvas/`

A read-only canvas drawn by fluxsmith itself on a 2D context from the typed geometry the engine
produces — KiCanvas is **not** vendored, and the webview never parses raw `.kicad_sch` text. It
handles hit-testing, selection, highlighting, follow-the-agent, viewport and gestures, with a
spatial index and a sheet cache for large sheets. **No judgement of any kind depends on the canvas.**
It only displays; netlists, checks and envelopes all come from the engine.

## `ui/`

`chat/` is the mode row, the turn blocks and their phase segments, the activity line, cards (which
are rendered only from a turn event, never from model text), and the composer with its `@`
references, chips and paste/drop intake. `canvas-panel/`, `sidebar/` (sheet tree, findings, turn
timeline, attachments, parts, sessions), `settings/`, `shell/`, `shortcuts/` and `components/` make
up the rest. `icons.ts` is the single Lucide mapping table and `orb-state.ts` maps agent phases onto
the thinking orb.

## Rules that apply to everything here

- **No emoji anywhere** — in strings, cards, badges, notifications, status text or errors. Check
  marks and status are Lucide icons. A build-time lint fails the build on a hit.
- **No untrusted string reaches `innerHTML`.** Chat markdown goes through the sanitiser (the single
  allowlisted exception, raw HTML forbidden); everything else — engine errors, findings, overlays,
  list items, skill digests, provider errors — is a text node. See [`../SECURITY.md`](../SECURITY.md).
- **No hard-coded colours.** Light, dark and system themes are expressed only through the tokens in
  `styles/tokens.css`, and a lint enforces it.
- **All four UI languages stay complete** (`zh-Hant`, `zh-Hans`, `en`, `ja`), checked by the i18n
  lint. Reply language is detected per message; UI strings follow the interface language.
- **The frontend never decides whether a circuit is correct.** Any pass or fail comes from an engine
  result.
