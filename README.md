# fluxsmith

**AI-led schematic design for KiCad.** Describe the circuit in a chat panel; the agent plans it,
draws it into a real `.kicad_sch`, and checks its own work. You stay in the loop by approving the
plan, not by placing symbols.

**Read this in:** [繁體中文](.github/README.zh-Hant.md) · [简体中文](.github/README.zh-Hans.md) · [日本語](.github/README.ja.md)

> [!WARNING]
> **Experimental research project, not a product.** Nothing here has run outside its author's machine.
>
> - Pre-1.0 and unstable. Formats change without notice, with no upgrade path between versions.
> - It writes to real `.kicad_sch` files. Keep any project you point it at in version control.
> - Nobody has verified the circuits. Unfit for safety-critical, medical, automotive or production use.
> - Your circuits, conversations and datasheets are sent to the model provider you choose.
> - Not affiliated with, or endorsed by, the KiCad project.

## How it works

One conversation turn is one transaction, in one of three modes:

| Mode | What the agent can do |
|---|---|
| **Plan** | Read the project, ask questions, propose a plan. The tool table has no write tool. |
| **Build** | Draw into the schematic, within the scope of a plan you approved. |
| **Review** | Run checks, report findings. The tool table has no write tool. |

- Every turn takes a checkpoint before its first write. **"Go back to before turn N"** is the only
  history operation: linear, no redo, no per-op undo, no canvas editing.
- The agent cannot roll back, and cannot put itself into Build mode.
- It stops and asks before leaving the approved scope, splitting or merging a named net, creating or
  deleting a sheet, colliding a reference designator, or spending past the turn budget. One approval
  unlocks one action.
- Every pass or fail comes from the engine. The agent and the UI never judge a circuit themselves.

The engine is fluxsmith's own Rust-native KiCad schematic reader, writer, netlister and checker —
no Python, no subprocess, no KiCad plugin. KiCad is the oracle: round-trips are compared byte for
byte, netlists against `kicad-cli sch export netlist`, and written files must pass
`kicad-cli sch erc` and open in the KiCad GUI.

## Status

| Area | State |
|---|---|
| Engine | Implemented; `cargo test --workspace` green |
| KiCad conformance | Byte round-trip, netlist parity, post-write ERC, idempotent re-apply; pinned to KiCad 10.0.4 |
| App | Tauri backend, agent harness, chat, read-only canvas, settings, parts sourcing, 4 UI languages |
| Golden set | Natural-language tasks, scored by deterministic graph matching. Last runs: 0.90 weighted (N=3) and 0.86 (N=1); the hard-stop target of 15 was missed at 21 |
| Windows | Built in CI, never run by hand |
| PCB layout | Not started |

Out of scope for now: Altium import, SPICE, an MCP server, a web UI, editing on the canvas.

## Requirements

- **KiCad 10**, installed by you. Not bundled; without it the AI features stay disabled.
- A model provider: your own API key, or a local OpenAI-compatible endpoint.

To build from source, additionally:

- **Rust** stable, pinned by `rust-toolchain.toml`.
- **Node LTS + pnpm** — build time only. The app ships no Node runtime.
- **Xcode Command Line Tools** (macOS 13+) or **Visual Studio Build Tools + WebView2** (Windows 10/11).

## Install

Installers for tagged versions are attached to the [Releases](../../releases) page:

| Platform | File |
|---|---|
| macOS (Apple silicon) | `fluxsmith-<version>-macos-arm64.dmg` |
| macOS (Intel) | `fluxsmith-<version>-macos-x64.dmg` |
| Windows 10/11 (x64) | `fluxsmith-<version>-windows-x64-setup.exe` |

They are unsigned, so the first launch is blocked. That is expected, and fluxsmith does nothing to
work around it on your behalf:

- **macOS** — open the `.dmg`, drag fluxsmith to Applications, launch it once, then allow it under
  System Settings > Privacy & Security > Open Anyway.
- **Windows** — run the installer and choose More info > Run anyway. It installs for the current
  user, so there is no administrator prompt.

Check a download against the `SHA256SUMS` in the same release before running it:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum     -c SHA256SUMS --ignore-missing   # elsewhere
```

### From source

```sh
pnpm install --frozen-lockfile
pnpm tauri dev      # run
pnpm tauri build    # bundle
```

### First run

1. **Settings → Models** — pick a provider and store a key. Anthropic, OpenAI, Google, OpenRouter,
   xAI, Groq and Mistral are built in, and you can register your own OpenAI-compatible origin. Keys
   are written by Rust to `secrets.json` in the app data directory (mode `0600`) and never enter the
   webview.
2. **Open the example project** on the welcome screen. It copies `examples/ldo_3v3/`, so the
   original is never touched.
3. Ask for something small, in any of the four languages: *"wire C1 across the input and C2 across
   the output"*. Nothing is written until you enter Build.

## Privacy

**Using fluxsmith means your circuit content, conversations and datasheets are sent to the model
provider you choose. fluxsmith takes no responsibility for private or sensitive data. If privacy
matters to you, use a locally hosted model through a custom provider.**

There is no fluxsmith server, no account and no telemetry. All outbound HTTP goes through Rust
against an origin allowlist. Conversations are stored in app data, not in your project.

## Security

Untrusted input — `.kicad_sch` content, engine output, model output, skill packs — can never change
an authorisation state. The webview holds no long-lived secret. Enforcement lives in Rust, not in a
prompt. Details, and how to report a vulnerability: [`SECURITY.md`](SECURITY.md).

## Repository layout

```
crates/       Rust engine — S-expression I/O, reader, ops, netlist, writer, checks, geometry
src-tauri/    Rust backend — typed IPC, authorisation, secrets, outbound fetch, watcher, app data
src/          React webview — agent harness, chat, self-drawn canvas, i18n, settings
skills/       built-in agent skills
tests/        KiCad conformance, the golden set, adversarial corpora
examples/     the sample project bundled with the app
scripts/      lints and the golden-set runner
fuzz/         cargo-fuzz targets
```

Each directory has its own README. Design documents are kept outside version control, so a `docs/…`
reference in a source comment points at notes that are not part of this repository.

## Development

```sh
cargo test --workspace      # engine + backend
pnpm test                   # harness, canvas, UI
pnpm build                  # lints + typecheck + bundle
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo deny check licenses
```

- No emoji in the UI or its strings; check marks and status are Lucide icons. A lint enforces it.
- No hard-coded colours outside the tokens in `src/styles/tokens.css`.
- All four UI languages stay complete.
- New dependencies must be Apache-2.0, MIT or BSD-class. No GPL is linked or bundled.

Conformance tests skip when KiCad is absent. The golden set spends real money, so it is manual and
never gates a merge — see [`tests/golden-set/README.md`](tests/golden-set/README.md).

## License

[Apache-2.0](LICENSE). Third-party components keep their own licenses, listed in [`NOTICE`](NOTICE).

## Acknowledgements

- **KiCad** — the reason this project can exist, and its correctness oracle.
- **[KiCanvas](https://github.com/theacodes/kicanvas)** and eeschema — reference for the canvas
  drawing conventions. Not vendored; the canvas is drawn from the engine's own geometry.
- **[pi](https://github.com/earendil-works/pi)** — model transport and agent-loop mechanics.
- **JLC2KiCadLib**, **jlcparts** and **jlcsearch** — design reference and service for parts
  sourcing; the conversion rules are reimplemented in Rust in `crates/easyeda-convert`.
- Developed with assistance from **Codex** and **Claude Code**.
