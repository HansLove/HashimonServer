# Core — domain

## Overview
The one piece of domain logic no single bounded context owns: the append-only audit
log. Everything else that used to live here moved to its module — see
`player/domain/`, `hashimon/domain/` and `mining/domain/`.

## Entry Points
- `audit::audit` — append-only log writer; must be called with the same transaction `client` as the mutation it records.

## Side Effects & Constraints
- `audit()` must be called with the transaction's `client`, not a bare `query()` — passing the wrong client silently writes the audit row outside the transaction, breaking the "commits atomically" guarantee every caller relies on. `hashimon::emit`, `mining::submitShare`, `payments::applyWebhook` and `incubation::applyShare` all depend on this.

## Common Pitfalls
- Adding a new mutation anywhere in the ledger without an `audit()` call breaks the append-only trail other tooling assumes exists for every state change.
