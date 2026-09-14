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

# tsc cannot check one file without dropping tsconfig (and the @/ alias), so it checks the
# whole project and only the edited file's errors block. Errors elsewhere are either
# pre-existing or an expected mid-refactor state, and would crowd this file's out of view.
rel=${file#"$root"/}
if ! out=$(pnpm exec tsc --noEmit --pretty false 2>&1); then
  mine=$(grep -F "$rel(" <<<"$out")
  if [[ -n $mine ]]; then
    printf 'tsc --noEmit failed in %s:\n%s\n' "$rel" "$mine" | head -n 40 >&2
    exit 2
  fi
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
