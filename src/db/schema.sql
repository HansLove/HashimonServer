-- Phase 1 schema: identity, inventory, emission ledger.
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS).
-- Needs Postgres 13+ for gen_random_uuid() (pgcrypto is bundled since 13).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A player is an identity that owns creatures and (later) credits. public_key is
-- optional so a device can play anonymously and bind an identity later.
CREATE TABLE IF NOT EXISTS players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key   text UNIQUE,
  display_name text NOT NULL DEFAULT 'Trainer',
  credits      bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Bearer session tokens. Thin on purpose; swap for a real auth provider before
-- production (see README — do not grow this into a home-made auth system).
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  player_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_player_idx ON sessions(player_id);

-- The emission ledger. One row = one creature that has been officially born.
-- The server owns the birth: it generates birth_nonce and derives dna, so the
-- client cannot grind for a rare identity (ADR D2/D6). dna is UNIQUE — the
-- anti-duplication guarantee. Stats and look are NOT stored: they are derived
-- from dna + pow by the Caos Core, so they can never drift or be forged.
CREATE TABLE IF NOT EXISTS hashimons (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  dna                text NOT NULL UNIQUE,
  species_key        text NOT NULL,
  template_id        text NOT NULL,
  birth_nonce        text NOT NULL,
  provenance         text NOT NULL DEFAULT 'wild',   -- wild | starter | (future) incubation
  algo_version       text NOT NULL,
  name               text NOT NULL DEFAULT '',
  born_at            timestamptz NOT NULL DEFAULT now(),
  -- pow record (the creature's biography of real work). Best share drives rank.
  best_share_bits    integer NOT NULL DEFAULT 0,
  best_share_hash    text,
  best_share_nonce   bigint,
  extranonce2        bigint NOT NULL DEFAULT 0,
  total_hashes       bigint NOT NULL DEFAULT 0,
  valid_shares       integer NOT NULL DEFAULT 0,
  found_block        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS hashimons_owner_idx ON hashimons(owner_id);

-- Bound-mode PoW: extranonce2 at time of best share (null = legacy single-counter shares).
ALTER TABLE hashimons ADD COLUMN IF NOT EXISTS best_share_extranonce2 bigint;

-- Active mining jobs (TTL ~15 min). Client fetches before grinding.
CREATE TABLE IF NOT EXISTS mining_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hashimon_id         uuid NOT NULL REFERENCES hashimons(id) ON DELETE CASCADE,
  owner_id            uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  extranonce1         text NOT NULL,
  share_target_bits   integer NOT NULL,
  block_target_bits   integer NOT NULL DEFAULT 64,
  mode                text NOT NULL DEFAULT 'bound',
  header              jsonb NOT NULL,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mining_jobs_hashimon_idx ON mining_jobs(hashimon_id);
CREATE INDEX IF NOT EXISTS mining_jobs_expires_idx ON mining_jobs(expires_at);

-- Global dedupe of accepted share hashes.
CREATE TABLE IF NOT EXISTS submitted_shares (
  hash            text PRIMARY KEY,
  hashimon_id     uuid NOT NULL REFERENCES hashimons(id) ON DELETE CASCADE,
  job_id          uuid NOT NULL REFERENCES mining_jobs(id) ON DELETE CASCADE,
  bits            integer NOT NULL,
  extranonce2     bigint NOT NULL,
  nonce           bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log.
CREATE TABLE IF NOT EXISTS audit_log (
  id           bigserial PRIMARY KEY,
  player_id    uuid REFERENCES players(id) ON DELETE SET NULL,
  hashimon_id  uuid REFERENCES hashimons(id) ON DELETE SET NULL,
  action       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_player_idx ON audit_log(player_id);
