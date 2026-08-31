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

-- Birth Identity V2 (caos-core@2). La fecha de nacimiento fija el destino
-- compartido: espíritu, número de vida, elemento y por tanto especie.
--
-- LA FECHA NO SE GUARDA, ni en claro ni como compromiso. Nada la necesita
-- después del onboarding: sus derivados están aquí. Y un SHA256(fecha) pelado
-- no sería privacidad — el espacio son ~17,900 valores, una tabla arcoíris
-- completa se construye en milisegundos.
--
-- birth_set_at es el anti-reroll: una vez puesta la identidad no se recalcula,
-- así que no se puede probar fechas hasta sacar el espíritu que se quería.
ALTER TABLE players ADD COLUMN IF NOT EXISTS birth_spirit    text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS life_number     smallint;
ALTER TABLE players ADD COLUMN IF NOT EXISTS genesis_element text;
ALTER TABLE players ADD COLUMN IF NOT EXISTS birth_version   smallint;
ALTER TABLE players ADD COLUMN IF NOT EXISTS birth_set_at    timestamptz;

-- Per-player territory PROJECTION, pushed from the Luanti world (Towny mod).
-- Not authoritative ledger state — a read cache of "which town / how many blocks"
-- so the website can show a player their holdings without querying Luanti. Keyed
-- 1:1 to a player (a Towny resident belongs to at most one town). Kept fresh by
-- POST /internal/luanti-territory. Empty/absent row = the player has no town.
CREATE TABLE IF NOT EXISTS player_territory (
  player_id         uuid PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  town_name         text,
  town_block_count  integer NOT NULL DEFAULT 0,
  owned_plot_count  integer NOT NULL DEFAULT 0,
  is_mayor          boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Authoritative, town-keyed snapshot of every town's claimed mapblocks, pushed as a
-- whole from the Luanti world (towny.town_array) independent of who is logged in — so
-- the ranking is complete and the web cadastral (chunk) map can draw every town. Still
-- a PROJECTION of in-world Towny state (the world is the source of truth); never gate
-- ownership or emission on it. `blocks` is a compact [[x,z], ...] list of deduped
-- mapblock coordinates; kept fresh by POST /internal/luanti-towns (replace-all).
CREATE TABLE IF NOT EXISTS town_claims (
  town_name    text PRIMARY KEY,
  block_count  integer NOT NULL DEFAULT 0,
  member_count integer NOT NULL DEFAULT 0,
  mayor        text,
  home_x       integer,
  home_z       integer,
  blocks       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now()
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

-- Birth Identity denormalizada en la criatura, para que un Genesis se describa
-- solo sin consultar a su dueño. Null en los salvajes: nadie nació con ellos.
ALTER TABLE hashimons ADD COLUMN IF NOT EXISTS birth_spirit text;
ALTER TABLE hashimons ADD COLUMN IF NOT EXISTS life_number  smallint;

-- Renacimiento V1 -> V2. La fila V1 se ARCHIVA, nunca se reescribe.
--
-- No es una preferencia estética: el PoW está ligado criptográficamente al DNA
-- (verifyStoredPow recomputa doubleSha256(dna:extranonce1:extranonce2:nonce)),
-- y el speciesKey entra en el preimagen del DNA. Cambiar la especie in situ
-- haría que cada share almacenado dejara de verificar, y present() reportaría
-- verified:false — o sea "adulterada", que es peor que "sin minar".
--
-- Archivando, la criatura V1 conserva su DNA original y sigue verificando para
-- siempre. Simplemente deja de ser tu Genesis activo.
ALTER TABLE hashimons ADD COLUMN IF NOT EXISTS archived_at    timestamptz;
ALTER TABLE hashimons ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS hashimons_active_owner_idx
  ON hashimons(owner_id) WHERE archived_at IS NULL;

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

-- ---------------------------------------------------------------------------
-- MAGI: finite cubic bearer objects.
--
-- A MAGI lives as an ITEM in a Luanti inventory (its serial/seal ride in the
-- item metadata), but this table is the authority on whether that item is real.
-- Two layers guard it:
--
--   seal          HMAC over (serial, sats, epoch, custody_nonce). Catches an item
--                 whose metadata was fabricated or edited (wrong sats, wrong epoch).
--   custody_nonce Rotated on EVERY custody check. A seal alone only catches forgery,
--                 not duplication — a byte-perfect clone of a legitimate item carries
--                 a legitimate seal. Rotation makes custody a chain: after either
--                 copy is checked, the other one is presenting a nonce the ledger has
--                 already retired, and is destroyed on sight. A dupe glitch therefore
--                 yields exactly one surviving note, never two — supply is preserved
--                 without needing to know which copy was the "original".
--
-- Supply is finite: issuance is capped (config.magiSupplyCap) and every note is
-- backed by a fixed sats amount recorded at issue time. The reserve is a discipline
-- against silent issuance, not a redemption promise (see Magi/finite-object-protocol).
CREATE TABLE IF NOT EXISTS magi_notes (
  serial         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sats           bigint NOT NULL,
  epoch          integer NOT NULL,
  -- vaulted: dematerialized, held as a balance. materialized: an item in a world.
  -- retired: taken out of circulation by an admin. Supply counts all three.
  state          text NOT NULL DEFAULT 'vaulted',
  custody_nonce  text NOT NULL,
  custody_seq    integer NOT NULL DEFAULT 0,
  holder         text,                                  -- luanti account name
  issued_at      timestamptz NOT NULL DEFAULT now(),
  moved_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magi_notes_holder_idx ON magi_notes(holder);
CREATE INDEX IF NOT EXISTS magi_notes_state_idx ON magi_notes(state);

-- Every custody event, accepted or rejected. A destroyed item is an accusation of
-- duplication against a player: it has to leave a trace that says exactly why.
CREATE TABLE IF NOT EXISTS magi_custody_log (
  id          bigserial PRIMARY KEY,
  serial      uuid REFERENCES magi_notes(serial) ON DELETE SET NULL,
  seq         integer NOT NULL DEFAULT 0,
  holder      text,
  event       text NOT NULL,     -- issue | withdraw | deposit | check | pickup | place | join
  verdict     text NOT NULL,     -- ok | stale | forged | unknown | retired
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magi_custody_log_serial_idx ON magi_custody_log(serial);
CREATE INDEX IF NOT EXISTS magi_custody_log_verdict_idx ON magi_custody_log(verdict) WHERE verdict <> 'ok';
