# `src-tauri/` — Rust backend (the effect kernel)

The only code in fluxsmith that may touch OS resources: the filesystem, the secret store, the
network, subprocesses. The engine lives in [`../crates/`](../crates) and is called in-process;
external tools (an optional `kicad-cli` advisory pass, a router) run only as sandboxed subprocesses.

Everything the webview can reach is registered in `commands.rs`, which is a thin layer of
`#[tauri::command]` wrappers over the modules below, and constrained by the capability allowlist in
`capabilities/default.json`.

## Authorisation and the engine

| Module | Responsibility |
|---|---|
| `engine.rs` | `engine_request` — the **only** way the webview reaches the engine. A closed `EngineRequest` enum (never an arbitrary path). Write variants require a BuildSession token (inside the envelope, in Build mode, in a running turn) or a single-use grant. Rust holds the envelope, the counters and the mode as a second check, takes a sha snapshot of every target file against TOCTOU, canonicalises every path against the project root — including each file an op list's `sheets` envelope declares — and runs long operations on a cancellable blocking thread. |
| `session.rs` | BuildSession, turn and grant state. Tokens exist only in memory, bound to the project, the plan digest, the session ceiling and the tab; they expire on idle, on an absolute limit and on restart. Grants are single-use and bound to a consent event id. |
| `checkpoint.rs` | Per-turn checkpoints in app data, and verified rollback (per-entry verification, optimistic locking, transaction, pre-rollback snapshot, journal). |
| `paths.rs` | The app-data layout and every project-scope path check. |
| `sidecar.rs` | Writes under a project's `.fluxsmith/`, on a path allowlist. Never touches a design file. |
| `export.rs` | The only write outside a project, and always to a path the user picked. |

## Environment, projects and files

`env.rs` (KiCad presence, version, symbol library tables, `kicad-cli`), `project.rs` (open, close,
new, recent), `watch.rs` (sha-based external change detection and `.lck` detection), `cloud.rs`
(cloud-sync folder detection), `libindex.rs` (background symbol index), `treecache.rs` (parsed tree
and render geometry cache), `example.rs` (copies the bundled example project out of the read-only
bundle), `recovery.rs` (startup crash recovery), `advisory.rs` (optional `kicad-cli` verification),
`sandbox.rs` (the only place a subprocess is spawned).

## Secrets, network and providers

`keyring.rs` is the secret store — provider keys and OAuth tokens in `secrets.json`, atomic, mode
`0600`, never returned to the webview. `net.rs` carries **all** outbound HTTP: a built-in origin
allowlist plus user-registered custom origins, streaming responses over a channel, `Authorization`
injected in Rust, no cross-origin redirects, no response headers back to the frontend. `probe.rs`
checks what a configured provider can actually do.

## Data, content and diagnostics

`db.rs` (`fluxsmith.db` — only Rust opens it; the webview sends a closed query enum, never SQL),
`settings.rs` (`settings.json`, secret-free), `skills.rs` and `skilltest.rs` (skill packs: builtin,
user and project scopes, trust state, manifest hashing, pack golden tests), `intake.rs` (attachment
sniffing, archive limits, image preprocessing and metadata stripping), `pdftext.rs`, `webtext.rs`,
`facts.rs`, `parts.rs` and `parts_cache.rs` (parts sourcing and the shared parts library),
`clipboard.rs`, `diag.rs` (storage report, diagnostics bundle, app-data export and wipe),
`update.rs`, `log.rs` (file log with secret masking at the point of writing), `winui.rs` (the one
place UI text lives outside the webview — native dialogs shown before the webview exists).

`ipc.rs` holds the typed contract shared with the frontend, and `error.rs` makes every command
return a structured `IpcError`.

## Configuration

`tauri.conf.json` sets single-instance behaviour, the capability allowlist, a CSP that acts only as
a backstop (the real allowlist is in `net.rs`), the bundled resources, and devtools off in release.

The rules these modules exist to enforce are in [`../SECURITY.md`](../SECURITY.md).
