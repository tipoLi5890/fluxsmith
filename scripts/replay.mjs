#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// L5 replay — re-drive recorded sessions through the real harness (hooks, ledger, cards)
// with no provider and the fake IPC. Runs the vitest replay suite with FLUXSMITH_REPLAY_FILES set.
//
//   pnpm replay                       # every tests/replay/*.jsonl{,.gz}
//   pnpm replay tests/replay/x.jsonl.gz other.jsonl
//
// Exit code is vitest's: a hash mismatch (strict recordings) or a harness error fails the run.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

export function listRecordings(dir = join(ROOT, "tests", "replay")) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz")).sort().map((f) => join(dir, f));
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : listRecordings();
  if (!files.length) { console.error("replay: no recordings (tests/replay/*.jsonl[.gz]); record one with `pnpm replay:record <session_id>`"); process.exit(2); }
  console.log(`replay: ${files.length} recording(s)`);
  const r = spawnSync("pnpm", ["exec", "vitest", "run", "src/agent/__tests__/replay.test.ts", "--reporter=verbose"], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, FLUXSMITH_REPLAY_FILES: files.join(",") },
  });
  process.exit(r.status ?? 1);
}
