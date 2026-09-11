# Territory Domain

## Overview

Everything downstream of the Luanti Towny world: town/claim projection, alliances, wolkers
(native population), and armies (Risk-style conquest). Nothing here is authoritative over
in-world state — it mirrors what the world pushes and queues actions the world re-validates,
except the wolker census and army ticks, which run as their own SQL-only authority so a town
keeps starving/fighting/breeding even while nobody is logged in.

## Entry Points

- `territory.ts::replaceTownClaims` — full-replace sync from the Luanti push; drives every read below it.
- `territory.ts::enqueueTownAction` / `listPendingTownActions` / `resolveTownAction` — web→world action queue (claims, ranks, invites, kicks).
- `wolkers.ts::censusTick` — authoritative tick (1 h real by design): feed → breed → emigrate → army levy → autopilot, in that order. Nothing in `src/` or `scripts/` schedules it yet; only `wolkers.test.ts` calls it.
- `wolkers.ts::seedGenesis` — the only "spawn" path besides `breedTick`; idempotent per homeblock.
- `wolkers.ts::applyWorldDeltas` — the only channel the world can report wolker position/combat death through.
- `armies.ts::attack` / `muster` / `moveUnit` — the player-facing Risk actions, all turn-gated.
- `armies.ts::autoTickAll` — doctrine autopilot, called from inside `censusTick`.
- `wolker-council.ts::councilFor` — town posture (rule-first, LLM-optional) consumed by the world HUD.
- `diplomacy.ts::insertProposal` / `activateAlliance` / `listActiveAlliancePairs` — alliance lifecycle the world reads to block PvP.

## Key Files

- **territory.ts** — also owns the cadastral-map claim overlay merge (`mergeClaimOverlaysIntoTowns`), not just CRUD.
- **wolker-council.ts** — the one file in this module that talks to a model; every other file is pure SQL/rules.

## Business Logic

**`player_territory` / `town_claims` are projections, never authority.** Never gate ownership,
emission, or PvP on these tables — they mirror what the Luanti sync mod last pushed and can lag.

**Two invariants own the wolker design** (`wolkers.ts` header comment):
1. Wolkers are never spawned ad hoc — only `seedGenesis` (once per homeblock, idempotent on
   `wolker_genesis.town_seed`) and `breedTick` (paid) create rows.
2. The food supply is *shared* with Hashimon feeding: `townLarder`/`consumeTownCroquetas` read
   and spend the same `pow_yield` rows `mining::consumeCroqueta` uses. Feeding a creature starves
   the town, and vice versa — one pantry, one owner's decision.

**Census tick order is load-bearing** (`censusTick`): feed hungriest-first → age/hunger deaths →
`breedTick` (spends whatever food survived feeding) → `moraleTick` (reads post-breed state) →
`levyTick` → `autoTickAll`. Reordering any step changes who eats, whether a birth can starve the
living, or whether a dead town still recruits.

**`breedTick` has four hard gates, in order**: hearth present → under capacity
(`min(beds*2, larder/3, blocks*4)`) → real food surplus (larder ≥ pop + `BIRTH_COST`, so a birth
never eats into the living's ration) → an eligible opposite-sign pair (adult, not on cooldown,
under `BREED_MAX_HUNGER`). Cost is paid *before* the insert; a duplicate `(parentA, parentB, nonce)`
id silently skips rather than forcing — losing a birth is cheap, duplicating a lineage isn't.

**Moral/emigration is the only ungoverned number** — no admin command sets it. It is a function of
hunger/housing/work/recent deaths (`moraleTargetFor`), moves at most `MORALE_STEP`/tick, and only
after 2 consecutive ticks under `MORALE_FLEE` does a wolker look for a better town within
`MIGRATION_RANGE` and jump if `attractivenessOf(target) > attractivenessOf(here) * MIGRATION_EDGE`.

**Wolker ids are deterministic hashes**, same pattern as Hashimon DNA: `wolkerId(parentA,
parentB, nonce)` — auditable lineage without trusting the DB, and `signOf`/`traitsOf`/`appearanceOf`
must stay byte-identical with the Luanti mod's `appearance.lua`.

**Armies self-limit expansion by design** (`armies.ts` header): more claimed territory dilutes
`cohesionOf` (population/chunks vs. `DENSITY_REF`, floored at `COHESION_FLOOR`) and lengthens
`perimeterOf`, so conquering faster than you populate makes your army fight worse *and* thinner.
Battles are deterministic — `resolveBattle` seeds a roll from SHA-256 of the inputs + a caller
nonce, so any outcome is recomputable from the public `battles` log; the server arbitrates, it
doesn't oracle the result.

**Turns are derived, never stored**: `turnOf(t) = floor(t / TURN_MS)` (1h). No cron, no table to
desync — `canAct`/`already_moved` checks compare turn numbers, and `moveUnit`/`attack` stamp
`moved_at` with the caller-supplied `now`, not `now()`, so validation and storage agree even if
clocks drift.

**Army doctrine autopilot never declares war.** `autoTick` (garrison → reposition → occupy) only
recruits, repositions, and occupies *unclaimed* chunks even under `expansiva`; attacking an owned
chunk stays a human action. Default doctrine is `defensiva`, not `manual`, so an absent mayor's
town still holds its line.

**`wolker-council.ts` is rule-first by construction.** `ruleOf` always produces a valid posture;
`councilFor` only asks a model when `worthAsking` (starving/deaths/low morale/hostiles) *and*
budget allows (`wolkerCouncilMaxPerDay`, per-town min interval), and any model failure or
off-enum reply falls back to the rule silently. Consulted per-town, never per-wolker.

## Dependencies

**Internal:**
- `core/db/pool` — every file; `withTransaction` guards the multi-step invariants above (genesis idempotency, attack settlement, breed cost-then-insert).
- `territory/domain/armies` (from `wolkers.ts`) — `censusTick` drives `levyTick`/`autoTickAll` at the end of its own transaction batch.
- `companion/domain/anthropic` (from `wolker-council.ts`) — the only LLM call in this module; wrapped so it can be swapped for a test double via `CouncilAsk`.

## Side Effects & Constraints

- `censusTick` and `attack`/`muster`/`moveUnit` all rely on row-level locks (`FOR UPDATE`,
  `stock >= $2` conditional UPDATE) to make concurrent requests turn-safe — don't bypass `query`
  with a raw client inside these paths.
- `autoTickAll` swallows per-town errors so one corrupt town can't block the global tick
  (`armies.ts::autoTickAll` catch block) — a silently-failing autopilot town shows up as a
  zero-effect `AutoResult`, not a thrown error.
- `wolker-council.ts` budget state (`lastAsk`, `askedToday`) is in-process memory, reset on
  restart and via `resetCouncilBudget` in tests — never persisted, so a redeploy is a free budget
  reset (accepted tradeoff, not a bug).
