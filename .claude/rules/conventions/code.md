---
paths:
  - "src/**/*.ts"
---

# Code conventions

**Path aliases.** `@/*` maps to `src/*` (tsconfig `paths` + esbuild bundling) — use
`@/modules/<domain>/...`, e.g. `@/modules/player/domain/players`,
`@/modules/core/http/errors`, never relative `../../` imports. Because every import
is absolute, moving a file between modules never rewrites its own imports — only the
ones naming it.

**Logging is one wide event per request.** `src/modules/core/http/wide-event.ts` holds an
`AsyncLocalStorage<WideEvent>`; `wideEventMiddleware` (mounted first in `core/http/app.ts`) is
the *only* thing that emits a request log line, in `res.on("finish")`. Everything else
calls `enrich({ … })` to add fields to the event already in flight — never `console.*`,
never its own `logger.info`. `enrich` is a no-op outside a request, so domain code stays
callable from `core/db/migrate.ts` and from the test suites. `path` is the route template
(`/hashimons/:id`), never the resolved URL — that field is what queries group by.
Secrets never enter the event: `redact` in `src/modules/core/logger.ts` is the backstop, the rule is
`dna_prefix` over `dna` and `safeHost()` over `config.btcNodeUrl`. Only three events live
outside the request cycle: `server_start`, `shutdown` and `block_template_fetch`. See the
logging section in README.md.
