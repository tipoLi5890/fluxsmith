#!/usr/bin/env bash
# Rebuild every task's reference schematic from reference.ops.json and refresh
# expected.json (canonical matching, docs/SPEC.md D-54). Usage: build.sh [task]
set -euo pipefail
cd "$(dirname "$0")/../.."
CLI=target/debug/fluxsmith-cli
cargo build -q -p fluxsmith-cli
for d in tests/golden-set/tasks/${1:-*}/; do
  t=$(basename "$d"); work=$(mktemp -d)
  if [ -d "$d/fixture" ]; then
    # An editing task starts from a fixture design; the reference ops are applied on top of it.
    cp "$d"/fixture/* "$work"/
    root=$(ls "$work"/*.kicad_pro | head -1); root="${root%.kicad_pro}.kicad_sch"
  else
    $CLI new "$work" ref >/dev/null; root="$work/ref.kicad_sch"
  fi
  $CLI draw "$root" --ops "$d/reference.ops.json" --apply --journal /dev/null >/dev/null || { echo "FAIL $t"; $CLI draw "$root" --ops "$d/reference.ops.json"; exit 1; }
  $CLI golden extract "$root" --task "$t" --task-text "$d/task.md" --out "$d/expected.json" >/dev/null
  $CLI golden match "$d/expected.json" "$root" >/dev/null && echo "ok   $t"
  rm -rf "$work"
done
