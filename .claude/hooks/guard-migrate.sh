#!/usr/bin/env bash
# PreToolUse(Bash): `pnpm migrate` applies dist/modules/core/db/schema.sql and prints
# success even when that copy is stale, which surfaces later as a missing column.
# Block it unless dist/ carries the same schema as src/. `migrate:dev` reads src/
# directly and always passes.
set -u

root=${CLAUDE_PROJECT_DIR:?}
cmd=$(jq -r '.tool_input.command // empty')

# Only at command position, so a commit message that mentions the script is not blocked.
pattern='(^|[;&|(])[[:space:]]*((p?npm)([[:space:]]+run)?[[:space:]]+migrate([[:space:];&|)]|$)|node[[:space:]][^;&|]*dist/[^[:space:];&|]*migrate\.js)'
grep -Eq "$pattern" <<<"$cmd" || exit 0

src=$root/src/modules/core/db/schema.sql
dist=$root/dist/modules/core/db/schema.sql
cmp -s "$src" "$dist" && exit 0

echo "Blocked: pnpm migrate applies $dist, which is missing or differs from src/modules/core/db/schema.sql. In development use \`pnpm migrate:dev\`; to exercise the production path, run \`pnpm build\` first." >&2
exit 2
