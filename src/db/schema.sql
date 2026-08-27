-- Phase 1 schema: identity, inventory, emission ledger.
-- Idempotent: safe to run repeatedly (CREATE ... IF NOT EXISTS).
-- Needs Postgres 13+ for gen_random_uuid() (pgcrypto is bundled since 13).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A player is an identity that owns creatures and (later) credits. public_key is
-- optional so a device can play anonymously and bind an identity later.
-- Web owners (Lovable /register) get username + password + public_key; Luanti
-- guests have no API row — ownership requires a key (canOwn).
CREATE TABLE IF NOT EXISTS players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key   text UNIQUE,
  display_name text NOT NULL DEFAULT 'Trainer',
  credits      bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Owner accounts (web register). Anonymous POST /session rows leave these null.
ALTER TABLE players ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS luanti_password text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS enc_private_key bytea;
ALTER TABLE players ADD COLUMN IF NOT EXISTS kdf_salt text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS kdf_params jsonb;
ALTER TABLE players ADD COLUMN IF NOT EXISTS custody text; -- server_encrypted | player | null

CREATE UNIQUE INDEX IF NOT EXISTS players_username_lower_idx
  ON players (lower(username)) WHERE username IS NOT NULL;

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

-- Bitcoin-mode PoW: the template snapshot (prevhash, bits, merkle branch, coinbase
-- prefix/suffix, nTime) used for the best share, captured at submit time because the
-- source mining_jobs row and in-memory template cache are not guaranteed to survive
-- (see core/pow.ts::BitcoinShareSnapshot). Null for bound/legacy best shares.
ALTER TABLE hashimons ADD COLUMN IF NOT EXISTS best_share_bitcoin jsonb;

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

-- The credit catalogue. The server fixes the price: a client sends a sku, never an
-- amount. Changing a price is an UPDATE, not a deploy. No admin CRUD yet — plans are
-- edited by SQL until an administration surface exists.
CREATE TABLE IF NOT EXISTS credits_plans (
  sku        text PRIMARY KEY,
  credits    bigint NOT NULL CONSTRAINT credits_plans_credits_positive CHECK (credits > 0),
  price_usd  numeric(10,2) NOT NULL CONSTRAINT credits_plans_price_positive CHECK (price_usd > 0),
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The catalogue is edited by hand in SQL, so the fat-finger guard belongs in the database.
-- A price of 0.00 would make BTCPay settle an invoice for nothing and mint the plan's
-- credits on every request. Postgres has no ADD CONSTRAINT IF NOT EXISTS; the DO block is
-- the idempotent idiom, and a no-op on a database created after the constraints existed.
DO $$ BEGIN
  ALTER TABLE credits_plans ADD CONSTRAINT credits_plans_credits_positive CHECK (credits > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE credits_plans ADD CONSTRAINT credits_plans_price_positive CHECK (price_usd > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Provisional seed. DO NOTHING is what keeps migrate idempotent here and, more
-- importantly, stops a redeploy from reverting a price edited in production.
INSERT INTO credits_plans (sku, credits, price_usd, sort_order) VALUES
  ('credits_500',   500,  5.00, 1),
  ('credits_1200', 1200, 10.00, 2),
  ('credits_3000', 3000, 25.00, 3)
ON CONFLICT (sku) DO NOTHING;

-- The payment ledger. Six states, all decided by the server:
--   waiting → confirming → settled | expired | failed | cancelled
-- (the last four are terminal). The client never runs a state machine of its own —
-- the phase of its UI *is* this column.
--
-- sku/credits/amount_usd are a SNAPSHOT taken when the charge is created, not a live
-- lookup: raising a plan's price must never revalue a charge already issued. The FK
-- to credits_plans is referential integrity, nothing more.
--
-- invoice_id/amount_btc/address/bip21/checkout_link are null between the INSERT and
-- the BTCPay call that fills them: the row is written first precisely so the partial
-- unique index below rejects a duplicate charge *before* an invoice is created at the
-- gateway. expires_at defaults to a short window so a row orphaned by a crash in
-- between is stale rather than permanent (see createPayment in domain/payments.ts).
CREATE TABLE IF NOT EXISTS payments (
  order_id      text PRIMARY KEY,
  player_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  gateway       text NOT NULL DEFAULT 'btcpay-server',
  invoice_id    text,
  status        text NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'confirming', 'settled', 'expired', 'failed', 'cancelled')),
  sku           text NOT NULL REFERENCES credits_plans(sku),
  credits       bigint NOT NULL,
  amount_usd    numeric(10,2) NOT NULL,
  amount_btc    text,
  address       text,
  bip21         text,
  checkout_link text,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '20 minutes',
  settled_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_player_idx ON payments(player_id);

-- The webhook identifies an invoice by BTCPay's own id, not by our order_id.
CREATE UNIQUE INDEX IF NOT EXISTS payments_invoice_idx
  ON payments (invoice_id) WHERE invoice_id IS NOT NULL;

-- Idempotency as an index, not an `if`: one live charge per player. Two simultaneous
-- POSTs — one wins, the other gets 23505, which the route turns into 409
-- payment_pending. Same shape as players_username_lower_idx above.
CREATE UNIQUE INDEX IF NOT EXISTS payments_active_per_player_idx
  ON payments (player_id) WHERE status IN ('waiting', 'confirming');

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
