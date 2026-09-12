# `tests/`

Test data and cross-cutting suites that do not belong to a single crate. Unit tests live with their
crate (`crates/*/tests/`) and the frontend suites live with their modules (`src/**/*.test.ts`).

```
conformance/   KiCad parity: fixtures, the pinned KiCad version, the op schema, identity vectors
golden-set/    Real-model end-to-end tasks and their deterministic scoring
injection/     Prompt-injection corpus
i18n/          Reply-language detection and emoji-lint corpora
logging/       Secret-leak corpus for the log masker
replay/        Recorded provider transcripts
fixtures/      Shared JSON fixtures for the harness suites
```

## The layers

1. **Crate unit tests** — one test per engine invariant (the `inv_` family), one per known
   regression (the `reg_` family), a double-apply sweep, and `cargo fuzz` targets for the parser and
   the reader (with the same no-panic contract asserted deterministically on stable CI).
2. **KiCad parity** (`conformance/`) — Rust integration tests that call `kicad-cli` for netlists and
   ERC and compare against committed goldens, at three levels: bytes, netlist, geometry. The KiCad
   version is pinned in `KICAD_VERSION` and its paths in `env.toml`; these tests skip when KiCad is
   absent rather than failing. `ops.v1.schema.json` is drift-checked against the op vocabulary.
3. **App tests** — the frontend suites (Vitest) drive the agent loop, the policy hooks, the workflow
   static rules and the grant flow against a fake provider; Rust command tests cover the backend.
4. **Adversarial corpora** — `injection/corpus.jsonl` (attack classes from direct instruction to
   unicode confusables), `logging/leak-corpus.jsonl` (strings the log masker must never emit), and
   `i18n/` (reply-language detection cases and emoji-lint positives and negatives).

## The golden set

`golden-set/` is the real-model, end-to-end measure: natural-language requests, scored by
deterministic graph matching against a reference solution rather than by another model. It **never
gates a merge** — real models are non-deterministic — but "must not fall below the baseline" is a
milestone criterion. It needs a configured provider and it spends money. See
[`golden-set/README.md`](golden-set/README.md) for the scoring rules and how to run it.
