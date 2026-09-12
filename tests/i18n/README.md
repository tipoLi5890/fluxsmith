# i18n test corpora

- `lang-detect.jsonl` — reply-language detection cases. One JSON object per line:
  `{"text": "...", "ui": "zh-Hant|zh-Hans|en|ja", "prev": "...|null", "locale": "...", "expect": "..."}`.
  The detector must be correct on 100% of them. The current file is a seed set — short messages,
  mixed scripts, all-kanji Japanese, and reference designators and net names as distractors — with a
  target of 200 or more.
- `emoji-lint.jsonl` — positive and negative cases for the emoji lint: the allowlist (`©`, `®`, `™`)
  and the characters that must always be rejected.

Completeness of the four UI languages, and the three-part key structure, are checked by the
build-time i18n lint rather than here.
