# Alen Domain

## Overview

Server side of Alen Gregory, the world's single villain — a channel of orders, not
authority. Same doctrine as `town_actions`: **the server proposes, the world (Lua)
decides**; a rejection's exact reason flows back through the ack and is the only
signal the planner ever learns from.

## Entry Points

- `alen::enqueueOrder` / `alen::listPendingOrders` / `alen::resolveOrder` — the order
  channel the world polls and acks.
- `alen::saveState` / `alen::getState` — the single-row world state projection.
- `alen::recordEvent` / `alen::listUnconsumedEvents` / `alen::consumeEvents` — the
  novelty queue that wakes the planner.
- `alen-planner::shouldPlan` — the spend gate; call before building anything model-facing.
- `alen-planner::planOnce` — generates and enqueues one plan; safe to call anytime, the
  gate decides.
- `alen-planner::scorePlan` — closes the learning loop with a win/loss verdict.
- `alen-chat::replyTo` — the chat path; separate model call, separate daily budget.

## Business Logic

**Two independent spend gates, not one.** `alen-planner::shouldPlan` (campaign
planning) and `alen-chat::replyTo`'s own `chatsToday` counter (conversation) are
unrelated budgets — a busy chat day does not throttle planning and vice versa.

**`shouldPlan` order is deliberate and cost-ordered**: unconfigured key → not alive →
unobserved → order in flight → cooldown → daily cap → no unconsumed events. Each
check that returns `false` costs nothing further; `observed` is checked before
anything DB-heavier because "nobody is watching" is the cheapest and most common
reject. A plan is only generated once ALL gates pass, including at least one
unconsumed event — no event, no plan, no matter how cheap.

**The prompt cache is per-route, not shared.** `ALEN_SYSTEM_PROMPT` is the same
constant used by both planner and chat, but Anthropic's cache prefix also covers
`output_config.format` (the JSON schema), so a planner call right after chat calls
still misses (measured: `cache_read = 0`). Chat-to-chat calls do share (measured:
1538 cached tokens). Do not "fix" this by unifying schemas — plan and chat return
structurally different things; the cost of a duplicate cache write per route is
accepted.

**Numeric limits live in code, never trust the schema.** Anthropic's structured
output schema rejects `minimum`/`maximum`/`minItems`/`maxLength` (400 error), so
`PLAN_SCHEMA`/`REPLY_SCHEMA` only describe ranges in prose. `alen-planner::clampPlan`
and `alen-chat`'s `clamp` are what actually enforce them — a limit the model can
read is a suggestion, one the code applies is a limit.

**Verb validation happens twice on purpose.** `ALEN_VERBS` gates the JSON schema
`enum` and is re-checked manually in `planOnce` before enqueueing. Lua's own list is
still the real authority; the double check here only avoids burning a poll cycle on
a plan the world would reject anyway.

**Empty chat reply is a valid outcome, not a failure.** `replyTo` treats
`reply: ""` / `intent: "ignore"` as Alen choosing silence; the appraisal (ego,
interest, respect) is still recorded and applied by the world — silence is a
reaction, not a dropped call.

**`ego <= -40` forces `intent` to at least `"warn"`, `<= -70` forces `"attack"`** —
this rule lives only inside `REPLY_SCHEMA`'s prompt text (`alen-chat.ts`), the model
self-enforces it, there is no code-side guard. If output drifts, check the prompt,
not `alen-chat.ts` logic.

**Model failure never throws past this module.** Both `planOnce` and `replyTo` catch
`AnthropicError`, log an `*_error` event via `recordEvent`, and return a failure result
(`{ planned: false, why }` from `planOnce`, `{ replied: false, why }` from `replyTo`) — the world's report loop must never break because the model was
down or over budget. Alen keeps functioning via Lua's own tactical state machine
either way; the model makes him better, not viable.

## Dependencies

**Internal:**
- `@/modules/companion/domain/anthropic` — `askModelStructured`/`anthropicConfigured`
  wraps the Anthropic call and structured-output plumbing shared with the companion module.
- `@/modules/core/db/pool` — direct SQL, no ORM; queries assume Postgres jsonb columns
  (`plan`, `payload`, `digest`).
- `@/modules/core/config` — `alenPlanMinIntervalS`, `alenPlanMaxPerDay`,
  `alenChatMaxPerDay`, `alenPlannerModel`, `alenChatModel` gate every spend decision.

**Environment Variables (indirect, via config):**
- Planner/chat daily caps and cooldown — wrong values silently change token spend,
  not correctness; no error surfaces, just a different bill.

## Side Effects & Constraints

- `alen_state` is a hard singleton (`CHECK (id = 1)` in schema): `getState`/`saveState`
  always target row `id = 1`. It is a *projection*, not authority — `mod_storage` in
  the Lua world is the live source of truth.
- `planOnce` and `replyTo` both write an `alen_events` row on model error — those rows
  are also novelty and will themselves wake the next `shouldPlan` check unless consumed.
- `scorePlan` matches on `alen_plans.order_id`, which is nullable
  (`ON DELETE SET NULL`); scoring an order whose plan row lost that link silently
  no-ops (`UPDATE ... WHERE order_id = $1` matches zero rows).

## Common Pitfalls

- Adding a field to the cached prompt (a date, counter, or id) invalidates the cache
  silently — no error, just a multiplied bill. `ALEN_SYSTEM_PROMPT` must stay byte-identical
  across calls.
- Adding `minimum`/`maximum` to a schema field to "be safe" will 400 at call time —
  clamp in code instead (`clampPlan`, `clamp` in `alen-chat.ts`).
