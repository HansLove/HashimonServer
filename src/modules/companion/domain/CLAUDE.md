# Companion Domain

## Overview

The chat companion: derives a creature's temperament and wellbeing from its own
DNA/state, builds the LLM system prompt that keeps it from acting like an assistant,
and owns the conversation transaction (credits, history, memory). One product rule
shapes every decision here: *"la criatura puede pedirte cosas, no puede ofrecerte
servicios."*

## Entry Points

- `companion.ts::temperamentOf` — derives one of 8 temperaments from DNA nibble [47]; must match `genesis-portal/src/lib/compiler.ts`'s order exactly.
- `companion.ts::wellbeingOf` — computes care levels + the single strongest "want" from a `CompanionRow`.
- `companion.ts::buildSystemPrompt` — assembles the full system prompt from identity, temperament, wellbeing, keepsakes.
- `chat.ts::speak` — the whole turn: credit check, LLM call, periodic memory extraction, persistence.
- `chat.ts::care` — records that a specific care (hunger/company/exercise/world) was just attended.
- `chat.ts::loadState` — read-only state snapshot (wellbeing, keepsakes, turns used, credits) used both before and after a turn.
- `anthropic.ts::askModel` / `anthropic.ts::askModelStructured` — the only two functions that talk to an LLM provider. `askModelStructured` (single-shot, cached system prefix, JSON-schema output) has no caller in this module: `alen/domain/` and `territory/domain/wolker-council.ts` use it, so a change to it reaches both.

## Key Files

- **chat-helpers.ts** — parses the Genesis V2 `speciesKey` (`g2_<spirit>_<element>`) into prompt-ready spirit/element; V1 creatures correctly yield `null`.
- **anthropic.ts** — server-side replacement for what used to be a browser-side call with the API key in `localStorage`; the local/Ollama path (`genesis-portal/src/lib/llm.ts`) still exists for V3 and is untouched.

## Business Logic

- **Temperament is genetic, not configuration.** `MEMORY_PROFILE` ties memory *capacity* (2 for `aloof`, up to 9 for `curious`) and *what's kept* to the temperament nibble — two creatures with the same body and different temperament have genuinely different companions with no extra code.
- **Wellbeing is the MINIMUM of the four cares (hunger/company/exercise/world), never the average.** Averaging would let a player compensate a real deficit with an easy one; minimum forces attention to whatever is actually low. Pinned by `companion.test.ts`.
- **Decay rates are deliberately staggered** (`DECAY_HOURS`: hunger 30h → world 336h) so cares don't all bottom out together and requests naturally take turns.
- **A "want" only appears below 60 overall wellbeing** — above that the creature asks for nothing, by design, so it doesn't nag constantly.
- **The system prompt is a pure function of DNA + state** — same input always produces the same prompt (test-pinned), so no player can hand-tune their creature's phrasing relative to anyone else's.
- **The prompt explicitly forbids assistant framing** ("¿en qué te ayudo?", numbered options, offering to write code) — this was a real regression from an earlier version and is now enforced by `companion.test.ts`.
- **Credits are checked BEFORE calling the provider, never after.** If checked on the way back, a broke player would already have consumed a paid token with nothing to show for the cost. See `chat.ts::speak`.
- **Memory extraction is throttled to every `MEMORY_EVERY` (3) turns**, not every turn — a second LLM call costs almost as much as the first (measured: $0.00120 of $0.00251/turn), so batching is both 32% cheaper and reads as more natural forgetting.
- **Memory extraction happens AFTER the reply is already computed and returned to the player** — if it fails, the player still gets their conversation; only the memory is lost (caught via the `SkipMemory` sentinel-error pattern).
- **`speak()`'s DB writes (turn insert, credit debit, memory insert+trim, `talked_at` bump) all happen in one `withTransaction`** — talking to the companion is itself the "company" care event, so it always bumps `talked_at` as part of the same atomic write.
- **Keepsakes are read oldest-to-newest** (`.reverse()` on a `DESC` query) so the prompt sees them in the order they accumulated, not most-recent-first.
- **Feeding spends a real croqueta; the other cares are free.** `care('hunger')` calls `mining::consumeCroqueta` inside its own transaction and throws 409 `no_food` when the creature has none — the same `pow_yield` pantry a town's wolkers eat from.

## Dependencies

**Internal:**
- `@/modules/mining/domain/mining` (`consumeCroqueta`, `croquetaBalance`) — the Hashi-croqueta stock behind `care('hunger')` and `loadState`.
- `@/modules/core/core` (`Dna.pick`) — temperament derivation must match the client's compiled DNA logic bit-for-bit; core.test.ts is the parity guard.
- `@/modules/core/core/birth-identity` (`spiritByKey`, `SpiritKey`) — spirit archetype text injected into the prompt for Genesis V2 creatures.
- `@/modules/core/db/pool` — `chat.ts` is the only file here touching Postgres directly.
- `@/modules/core/config` — `chatFreeTurns`, `chatCreditsPerTurn`, and the Anthropic API key/model/workspace-id.

**External:**
- None beyond the runtime `fetch` to Anthropic's API — no SDK, so retry/backoff and error classification (`AnthropicError.retryable`, true for 429/5xx) are hand-rolled in `anthropic.ts`.

**Environment Variables:**
- `ANTHROPIC_API_KEY` — missing → `askModel` and `askModelStructured` throw a non-retryable 503 immediately; companion chat is fully disabled (`anthropicConfigured()` guards callers), while Alen and the wolker council fall back to their own rules.
- `ANTHROPIC_WORKSPACE_ID` — only needed for identity-linked/multi-workspace keys; omit for single-workspace keys.

## Failure Modes

- A provider error mid-turn (`AnthropicError`) surfaces before any DB write in `speak()` — no partial turn is persisted, and `retryable` (429/5xx vs 400/401) tells the caller whether to retry.
- `ChatDenied` (`insufficient_credits`) is thrown before the network call, not after — see the credit-check business rule above.
