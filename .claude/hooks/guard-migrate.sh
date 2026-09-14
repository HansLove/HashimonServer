#!/usr/bin/env bash
# PreToolUse(Bash): `pnpm migrate` applies dist/modules/core/db/schema.sql and prints
# success even when that copy is stale, which surfaces later as a missing column.
# Block it unless dist/ carries the same schema as src/. `migrate:dev` reads src/
# directly and always passes.
set -u

root=${CLAUDE_PROJECT_DIR:?}
cmp -s "$root/src/modules/core/db/schema.sql" "$root/dist/modules/core/db/schema.sql" && exit 0

cmd=$(jq -r '.tool_input.command // empty')

# One simple command per line: heredoc bodies are data (a commit message), not commands,
# so they are dropped; then ; & | split `pnpm build && pnpm migrate` into two.
segments=$(awk '
  skip { if ($0 ~ "^[[:space:]]*" delim "[[:space:]]*$") skip = 0; next }
  match($0, /<<-?[[:space:]]*["\047]?[A-Za-z_][A-Za-z0-9_]*/) {
    delim = substr($0, RSTART, RLENGTH)
    sub(/^<<-?[[:space:]]*["\047]?/, "", delim)
    skip = 1
  }
  { print }' <<<"$cmd" | sed -E 's/[;&|]+/\n/g')

# Word boundaries include quotes and parens so `bash -c "pnpm migrate"` still matches.
# pnpm/npm with any flags or wrappers before `migrate`, or node running any migrate.js.
b="[[:space:]\"'()]"
migrate="(^|$b)p?npm([[:space:]]+[^[:space:]]+)*[[:space:]]+migrate($b|\$)|(^|$b)node[[:space:]].*migrate\.js($b|\$)"
build="(^|$b)p?npm([[:space:]]+run)?[[:space:]]+build($b|\$)"

while IFS= read -r segment; do
  # A git command only mentions the script (commit -m "...pnpm migrate...").
  [[ $segment =~ ^[[:space:]]*git[[:space:]] ]] && continue
  # A build earlier in the same command refreshes dist/ before the migrate runs.
  grep -Eq "$build" <<<"$segment" && exit 0
  if grep -Eq "$migrate" <<<"$segment"; then
    echo "Blocked: pnpm migrate applies dist/modules/core/db/schema.sql, which is missing or differs from src/modules/core/db/schema.sql. In development use \`pnpm migrate:dev\`; to exercise the production path, run \`pnpm build && pnpm migrate\`." >&2
    exit 2
  fi
done <<<"$segments"

exit 0
