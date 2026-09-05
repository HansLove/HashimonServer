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
  home_y       integer,
  home_z       integer,
  blocks       jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- [[x,y,z], ...] mapblock coords (3D)
  members      jsonb   NOT NULL DEFAULT '[]'::jsonb,  -- [{name, rank}] rank: mayor|comayor|resident
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Columns added after town_claims first shipped — add idempotently for existing DBs.
-- home_y: the world is 3D (a sky-island and a ground town can share (x,z)).
-- members: the town roster + ranks, so the website can show and manage politics.
ALTER TABLE town_claims ADD COLUMN IF NOT EXISTS home_y integer;
ALTER TABLE town_claims ADD COLUMN IF NOT EXISTS members jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Political actions requested from the WEBSITE (e.g. the mayor promoting a member to
-- co-mayor) that the Luanti world must carry out. The web enqueues a 'pending' row
-- after checking the requester is the town's mayor; the world polls, RE-VALIDATES
-- against live Towny (the source of truth), applies the rank flag, and acks. A queue,
-- not authority — Towny decides what actually holds.
CREATE TABLE IF NOT EXISTS town_actions (
  id          bigserial PRIMARY KEY,
  town_name   text NOT NULL,
  actor       text NOT NULL,        -- luanti username who requested (must be mayor)
  target      text NOT NULL,        -- member being re-ranked
  op          text NOT NULL,        -- 'add' | 'remove'
  rank        text NOT NULL,        -- 'comayor'
  status      text NOT NULL DEFAULT 'pending',  -- pending | applied | rejected
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz
);
CREATE INDEX IF NOT EXISTS town_actions_pending_idx ON town_actions(status) WHERE status = 'pending';

-- Alliances between towns (Towny has no nations/alliances of its own — this is the
-- meta-diplomacy layer the website owns). A pair is stored canonically (town_a < town_b)
-- so one row = one relationship. An alliance is a PEACE PACT: the Luanti world reads the
-- active ones and suppresses auto-war / blocks attacks between allied towns, so allied
-- neighbours form one contiguous peaceful bloc. proposed → active on the other town's
-- mayor accepting. The API is authoritative here (unlike ranks, the world never writes).
CREATE TABLE IF NOT EXISTS town_alliances (
  id          bigserial PRIMARY KEY,
  town_a      text NOT NULL,        -- canonical order: town_a < town_b
  town_b      text NOT NULL,
  status      text NOT NULL DEFAULT 'proposed',  -- proposed | active
  proposed_by text NOT NULL,        -- the town that sent the proposal
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (town_a, town_b)
);
CREATE INDEX IF NOT EXISTS town_alliances_active_idx ON town_alliances(status) WHERE status = 'active';

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

-- ---------------------------------------------------------------------------
-- Assisted incubation: buying high-entropy marks from CaosEngine.
--
-- The volume ladder. Like credits_plans, the server fixes the price and the client
-- sends a count, never an amount. Keyed by its lower bound so the seed below is
-- idempotent without a surrogate id. There is deliberately no `active` flag: a tier
-- is a segment of a continuous ladder, so switching one off would leave a hole that
-- quotes nothing — retiring a tier means widening its neighbours, in one UPDATE.
CREATE TABLE IF NOT EXISTS caos_pricing (
  min_shares        integer PRIMARY KEY,
  max_shares        integer NOT NULL,
  credits_per_share numeric(10,2) NOT NULL CHECK (credits_per_share > 0),
  discount_pct      numeric(4,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 5),
  CHECK (max_shares >= min_shares)
);

-- Provisional seed (product decision P5: 5% is the cap). DO NOTHING keeps migrate
-- idempotent and stops a redeploy from reverting a price edited in production.
INSERT INTO caos_pricing (min_shares, max_shares, credits_per_share, discount_pct) VALUES
  ( 1,  9, 10.00, 0.00),
  (10, 24, 10.00, 2.00),
  (25, 49, 10.00, 3.50),
  (50, 50, 10.00, 5.00)
ON CONFLICT (min_shares) DO NOTHING;

-- The lot ledger — the second and only other path by which players.credits moves.
-- Seven states, all server-decided:
--   queued → assigned → mining → complete | partial | failed | expired
-- The client runs no state machine; the phase of its UI *is* this column, exactly
-- like payments.status.
--
-- credits_charged is a SNAPSHOT of what the player actually paid. A refund is
-- proportional to it (undelivered/requested), never a re-quote — repricing the
-- ladder must not revalue a lot already sold. Same discipline as payments.
--
-- webhook_secret is the whole authentication story for the inbound callback:
-- CaosEngine does not sign its deliveries, so the lot's URL is its own credential.
-- assigned_at is when the one-hour clock starts (P9) — NOT created_at: a healthy lot
-- waiting in CaosEngine's queue must never refund itself for being queued.
CREATE TABLE IF NOT EXISTS caos_lots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hashimon_id       uuid NOT NULL REFERENCES hashimons(id) ON DELETE CASCADE,
  owner_id          uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  shares_requested  integer NOT NULL CHECK (shares_requested BETWEEN 1 AND 50),
  shares_delivered  integer NOT NULL DEFAULT 0,
  credits_charged   bigint NOT NULL CHECK (credits_charged >= 0),
  credits_refunded  bigint NOT NULL DEFAULT 0 CHECK (credits_refunded >= 0),
  stars_before      integer NOT NULL,
  -- The star floor this lot BOUGHT. It is what the pool was asked for and, more to the
  -- point, what every delivered mark is measured against on the way in — a mark below it
  -- is not the thing the player paid for. Snapshotted per lot for the same reason payments
  -- snapshots its price: changing the product's floor must not revalue a lot already open.
  stars_requested   integer NOT NULL DEFAULT 12 CHECK (stars_requested >= 0),
  best_bits         integer,
  mutated           boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','assigned','mining','complete','partial','failed','expired')),
  caos_request_id   text,
  webhook_secret    text NOT NULL,
  btc_address       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  assigned_at       timestamptz,
  closed_at         timestamptz
);
CREATE INDEX IF NOT EXISTS caos_lots_owner_idx ON caos_lots(owner_id);
CREATE INDEX IF NOT EXISTS caos_lots_hashimon_idx ON caos_lots(hashimon_id);

-- Which position in the lot produced best_bits, so the client can point at the mark that
-- mutated the creature instead of only naming the outcome. 0-based; null until the first
-- mark lands. Ties keep the earlier mark: the first one to reach that height is the one
-- that did it.
ALTER TABLE caos_lots ADD COLUMN IF NOT EXISTS best_share_index integer;

-- The floor a mark has to clear to count against this lot. Defaulted so a lot opened
-- before the column existed keeps the only floor the product has ever sold.
ALTER TABLE caos_lots ADD COLUMN IF NOT EXISTS stars_requested integer NOT NULL DEFAULT 12;

-- Whether a mark from THIS lot ever raised the creature's star count. Recorded when it
-- happens rather than derived on read: stars_before is a snapshot from the moment the lot
-- opened, and a player who keeps incubating in the browser meanwhile makes it stale — a lot
-- whose marks changed nothing would still compare favourably against it and claim a
-- mutación that never occurred.
ALTER TABLE caos_lots ADD COLUMN IF NOT EXISTS mutated boolean NOT NULL DEFAULT false;

-- Idempotency as an index, not an `if` — same shape as payments_active_per_player_idx.
-- One live lot per PLAYER, which is stricter than P11's one-per-creature and therefore
-- subsumes it: a second creature of the same owner cannot get a lot either. A second
-- concurrent POST gets 23505, which the route turns into 409 incubation_pending with the
-- live lot in the body. Deliberately no separate per-hashimon index: it could never fire.
CREATE UNIQUE INDEX IF NOT EXISTS caos_lots_active_per_player_idx
  ON caos_lots (owner_id) WHERE status IN ('queued', 'assigned', 'mining');

-- The webhook addresses a lot by its secret; CaosEngine echoes its own batch id back.
CREATE UNIQUE INDEX IF NOT EXISTS caos_lots_secret_idx ON caos_lots (webhook_secret);
CREATE UNIQUE INDEX IF NOT EXISTS caos_lots_request_idx
  ON caos_lots (caos_request_id) WHERE caos_request_id IS NOT NULL;

-- Provenance of every accepted share, recorded from day one even though the creature
-- sheet never shows it (product decision P17/§7: stars are mined, not bought — a bought
-- share is as real as a browser one). Adding the column now is trivial; reconstructing
-- it in a year is impossible, and it is exactly the field a pay-to-win argument, a
-- separate ranking or an audit would need.
ALTER TABLE submitted_shares ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'browser';
ALTER TABLE submitted_shares ADD COLUMN IF NOT EXISTS caos_lot_id uuid REFERENCES caos_lots(id) ON DELETE SET NULL;
ALTER TABLE submitted_shares ADD COLUMN IF NOT EXISTS share_index integer;

-- A CaosEngine share has no mining_jobs row behind it and its extranonce2 is an
-- 8-byte pool counter, not this table's bigint: both are null for origin='caos'.
-- The full template snapshot of the share that mattered lives on
-- hashimons.best_share_bitcoin, which is what present() re-verifies.
ALTER TABLE submitted_shares ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE submitted_shares ALTER COLUMN extranonce2 DROP NOT NULL;

-- CaosEngine redelivers; a repeat is the normal case, not an error. The share hash is
-- already the table's PK (global dedupe), and this closes the other door: the same
-- position in the same lot can only ever be counted once, even if the pool sends two
-- different hashes for it.
CREATE UNIQUE INDEX IF NOT EXISTS submitted_shares_lot_index_idx
  ON submitted_shares (caos_lot_id, share_index) WHERE caos_lot_id IS NOT NULL;

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

-- ---------------------------------------------------------------------------
-- Compañero: estado, memoria y turnos de conversación (ver docs/COMPANION_V1.md)
-- ---------------------------------------------------------------------------

-- El bienestar NO se guarda como número. Se guardan las FECHAS de los cuatro
-- cuidados, y el valor se calcula al leer. Así el estado envejece solo, sin cron
-- ni trabajo en segundo plano: una criatura desatendida seis meses tiene hambre
-- la primera vez que alguien la mira, no porque un job lo escribiera.
CREATE TABLE IF NOT EXISTS companion_state (
  hashimon_id  uuid PRIMARY KEY REFERENCES hashimons(id) ON DELETE CASCADE,
  fed_at       timestamptz NOT NULL DEFAULT now(),
  talked_at    timestamptz NOT NULL DEFAULT now(),
  mined_at     timestamptz NOT NULL DEFAULT now(),
  world_at     timestamptz NOT NULL DEFAULT now(),
  -- Último sector visitado. Cambiarlo es lo que satisface la carencia "mundo".
  last_sector  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Lo poco que la criatura conserva. Una línea por recuerdo, en su voz.
-- Sin embeddings y sin búsqueda: caben todos en el prompt.
CREATE TABLE IF NOT EXISTS companion_memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hashimon_id uuid NOT NULL REFERENCES hashimons(id) ON DELETE CASCADE,
  text        text NOT NULL CONSTRAINT companion_memory_text_len CHECK (char_length(text) BETWEEN 1 AND 240),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companion_memory_recent_idx
  ON companion_memory (hashimon_id, created_at DESC);

-- Los turnos. Existen para dos cosas: contar el cupo gratis y dar continuidad
-- corta a la conversación. No son la memoria — la memoria es companion_memory.
CREATE TABLE IF NOT EXISTS chat_turns (
  id            bigserial PRIMARY KEY,
  hashimon_id   uuid NOT NULL REFERENCES hashimons(id) ON DELETE CASCADE,
  role          text NOT NULL CONSTRAINT chat_turns_role CHECK (role IN ('user','assistant')),
  content       text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  credits_spent bigint  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_turns_recent_idx
  ON chat_turns (hashimon_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Alen Gregory — el villano único de Hashima.
--
-- "Sólo puede haber uno en todo el mapa" es una regla del juego, así que aquí es
-- una restricción y no una convención: alen_state tiene una sola fila por el
-- CHECK (id = 1). La ficha del mundo (mod_storage) es la autoridad en vivo; esta
-- tabla es la proyección que lee el planificador y, más adelante, la web.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alen_state (
  id          int PRIMARY KEY DEFAULT 1 CONSTRAINT alen_state_singleton CHECK (id = 1),
  alive       boolean NOT NULL DEFAULT false,
  pos_x       double precision,
  pos_y       double precision,
  pos_z       double precision,
  hp          integer NOT NULL DEFAULT 0,
  max_hp      integer NOT NULL DEFAULT 0,
  mood        text,
  observed    boolean NOT NULL DEFAULT false,  -- ¿hay alguien mirándolo ahora?
  digest      jsonb,                           -- último informe comprimido del mundo
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- La cola de órdenes. Misma forma que town_actions: el servidor PIDE, el mundo
-- revalida y decide, y el ack devuelve el motivo exacto del rechazo — sin ese
-- motivo el planificador nunca aprende y las dos mitades divergen en silencio.
CREATE TABLE IF NOT EXISTS alen_orders (
  id          bigserial PRIMARY KEY,
  plan        jsonb NOT NULL,                  -- { ttl, verbs: [...] }
  source      text NOT NULL DEFAULT 'admin',   -- admin | planner | model
  reason      text,                            -- por qué se emitió (para depurar al planificador)
  status      text NOT NULL DEFAULT 'pending', -- pending | applied | rejected
  detail      text,                            -- el motivo que devolvió el mundo
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz
);
CREATE INDEX IF NOT EXISTS alen_orders_pending_idx ON alen_orders(status) WHERE status = 'pending';

-- Novedades: lo que dispara pensar. El planificador NO corre con un temporizador
-- — corre cuando pasó algo que no había pasado. Esta tabla es esa señal, y su
-- ritmo es directamente la factura de tokens.
CREATE TABLE IF NOT EXISTS alen_events (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,   -- nuevo_jugador | herido | plan_fallido | plan_completo | derrotado | provocado
  actor       text,            -- jugador implicado, si lo hay
  payload     jsonb,
  consumed    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alen_events_unconsumed_idx ON alen_events(created_at) WHERE consumed = false;

-- ---------------------------------------------------------------------------
-- Map markers (waypoints) — API is authoritative; Luanti applies into discovery_maps.
-- Claims stay world-owned; this is pins only (personal / nation POI / Hashimon quest).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS map_markers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL
                     CONSTRAINT map_markers_kind CHECK (kind IN ('player', 'nation', 'hashimon')),
  owner_player_id  uuid REFERENCES players(id) ON DELETE CASCADE,
  town_name        text,
  hashimon_id      uuid REFERENCES hashimons(id) ON DELETE CASCADE,
  x                double precision NOT NULL,
  y                double precision NOT NULL,
  z                double precision NOT NULL,
  label            text NOT NULL DEFAULT ''
                     CONSTRAINT map_markers_label_len CHECK (char_length(label) <= 80),
  color_index      integer NOT NULL DEFAULT 1
                     CONSTRAINT map_markers_color CHECK (color_index BETWEEN 1 AND 8),
  status           text NOT NULL DEFAULT 'active'
                     CONSTRAINT map_markers_status CHECK (status IN ('active', 'completed', 'dismissed')),
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT map_markers_owner_by_kind CHECK (
    (kind = 'player'   AND owner_player_id IS NOT NULL AND town_name IS NULL AND hashimon_id IS NULL) OR
    (kind = 'nation'   AND town_name IS NOT NULL AND hashimon_id IS NULL) OR
    (kind = 'hashimon' AND owner_player_id IS NOT NULL AND hashimon_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS map_markers_owner_active_idx
  ON map_markers (owner_player_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS map_markers_town_active_idx
  ON map_markers (town_name, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS map_markers_hashimon_active_idx
  ON map_markers (hashimon_id, status) WHERE status = 'active';
