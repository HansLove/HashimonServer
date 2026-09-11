#!/usr/bin/env bash
# PostToolUse(Edit|Write): typecheck after every edit to a .ts file under src/ (the only
# tree tsconfig includes). An edit inside the Caos Core also runs core.test.ts, whose
# golden vectors guard byte-parity with the client's copy.
# Exit 2 feeds stderr back to Claude; exit 0 means pass or not applicable.
set -u

root=${CLAUDE_PROJECT_DIR:?}
file=$(jq -r '.tool_input.file_path // empty')

case "$file" in
  "$root"/src/*.ts) ;;
  *) exit 0 ;;
esac

cd "$root" || exit 0

if ! out=$(pnpm exec tsc --noEmit 2>&1); then
  printf 'tsc --noEmit failed after editing %s:\n%s\n' "$file" "$out" | head -n 40 >&2
  exit 2
fi

case "$file" in
  "$root"/src/modules/core/core/*)
    if ! out=$(node --import tsx --test --test-reporter=spec src/modules/core/core/core.test.ts 2>&1); then
      # spec prints its failure summary last, so keep the tail.
      printf 'Caos Core parity broke after editing %s (core.test.ts):\n%s\n' "$file" "$(tail -n 38 <<<"$out")" >&2
      exit 2
    fi
    ;;
esac

exit 0
