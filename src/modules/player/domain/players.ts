import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { isUniqueViolation, query } from "@/modules/core/db/pool";
import { config } from "@/modules/core/config";
import { AppError } from "@/modules/core/http/errors";
import { elapsedMs, enrich } from "@/modules/core/http/wide-event";
import {
  encPrivateKeyToBase64,
  encryptPrivateKey,
  generateSecp256k1Keypair,
  isValidCompressedPublicKey,
  isLuantiSrpEntry,
  isValidLuantiUsername,
  luantiSrpEntry,
  luantiSrpVerify,
  type Custody,
} from "@/modules/player/domain/crypto";
import { emit, present, type HashimonRow } from "@/modules/hashimon/domain/hashimons";
import { resolveAffiliateCode } from "@/modules/affiliate/domain/affiliates";
import { birthIdentityOf, composeDob, isPlausibleDob, isPlausibleMonthDay, spiritOf, spiritOfMonthDay, type BirthIdentity } from "@/modules/core/core/birth-identity";

export interface Player {
  id: string;
  public_key: string | null;
  display_name: string;
  credits: number;
  created_at: string;
  username: string | null;
  password_hash: string | null;
  luanti_password: string | null;
  enc_private_key: Buffer | null;
  kdf_salt: string | null;
  kdf_params: Record<string, unknown> | null;
  custody: string | null;
  //Birth Identity V2. La fecha completa NO se guarda; mes/día sí (espíritu).
  birth_spirit: string | null;
  birth_month: number | null;
  birth_day: number | null;
  life_number: number | null;
  genesis_element: string | null;
  birth_version: number | null;
  birth_set_at: string | null;
  //Quién trajo a esta cuenta. Se escribe una vez, en el registro, y no se
  //reasigna nunca: cambiarlo después reescribiría a quién se le debe dinero
  //por compras que ya ocurrieron. No se expone en presentPlayer — es un dato
  //del libro de comisiones, no del perfil.
  referred_by: string | null;
  referred_at: string | null;
  /** Last checkpoint from Luanti (world nodes); null until the world pushes once. */
  last_x: number | null;
  last_y: number | null;
  last_z: number | null;
  last_pos_at: string | null;
}

/** Ownership requires a secp256k1 public key (web register). Guests have none. */
export function canOwn(player: Pick<Player, "public_key">): boolean {
  return Boolean(player.public_key);
}

export function presentPlayer(player: Player) {
  return {
    id: player.id,
    displayName: player.display_name,
    username: player.username,
    publicKey: player.public_key,
    credits: player.credits,
    custody: player.custody,
    canOwn: canOwn(player),
    //El destino compartido. lifeNumber va aparte a propósito: publicarlo junto
    //al espíritu deja la fecha real en ~3 candidatos si se conoce el año
    //(medido sobre 1970-2018), contra ~31 publicando sólo el espíritu.
    birthSpirit: player.birth_spirit,
    birthMonth: player.birth_month,
    birthDay: player.birth_day,
    genesisElement: player.genesis_element,
    lifeNumber: player.life_number,
    /** False until POST /profile/element seals year → life/element → Genesis. */
    elementAwakened: player.life_number != null,
  };
}

//Create-or-restore an identity. With a public_key we return the existing player
//if one is bound to it (so the same identity persists across devices); otherwise
//we mint a fresh anonymous player. Real key-ownership proof (sign a challenge)
//is a later hardening step — Phase 1 trusts the supplied key.
export async function findOrCreatePlayer(input: {
  publicKey?: string | null;
  displayName?: string;
}): Promise<{ player: Player; created: boolean }> {
  if (input.publicKey) {
    const existing = await query<Player>(`SELECT * FROM players WHERE public_key = $1`, [input.publicKey]);
    if (existing.rows[0]) { return { player: existing.rows[0], created: false }; }
  }
  const created = await query<Player>(
    `INSERT INTO players (public_key, display_name)
     VALUES ($1, $2) RETURNING *`,
    [input.publicKey ?? null, input.displayName?.trim() || "Trainer"]
  );
  return { player: created.rows[0]!, created: true };
}

export async function getPlayer(id: string): Promise<Player | null> {
  const res = await query<Player>(`SELECT * FROM players WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function getPlayerByUsername(username: string): Promise<Player | null> {
  const res = await query<Player>(
    `SELECT * FROM players WHERE lower(username) = lower($1)`,
    [username]
  );
  return res.rows[0] ?? null;
}

/** Snapshot from Luanti (leaveplayer / periodic). Overwrites the previous checkpoint. */
export async function setPlayerCheckpoint(
  playerId: string,
  pos: { x: number; y: number; z: number }
): Promise<void> {
  await query(
    `UPDATE players
        SET last_x = $2, last_y = $3, last_z = $4, last_pos_at = now()
      WHERE id = $1`,
    [playerId, pos.x, pos.y, pos.z]
  );
}

export async function setPlayerCheckpointByUsername(
  username: string,
  pos: { x: number; y: number; z: number }
): Promise<boolean> {
  const res = await query(
    `UPDATE players
        SET last_x = $2, last_y = $3, last_z = $4, last_pos_at = now()
      WHERE lower(username) = lower($1)`,
    [username, pos.x, pos.y, pos.z]
  );
  return (res.rowCount ?? 0) > 0;
}

export type PlayerCheckpoint = {
  x: number;
  y: number;
  z: number;
  at: string;
};

export function checkpointOf(player: Player): PlayerCheckpoint | null {
  if (
    player.last_x == null ||
    player.last_y == null ||
    player.last_z == null ||
    !player.last_pos_at
  ) {
    return null;
  }
  return {
    x: player.last_x,
    y: player.last_y,
    z: player.last_z,
    at: player.last_pos_at,
  };
}

export interface Session {
  token: string;
  player_id: string;
  expires_at: string;
}

export async function createSession(playerId: string): Promise<Session> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000);
  const res = await query<Session>(
    `INSERT INTO sessions (token, player_id, expires_at)
     VALUES ($1, $2, $3) RETURNING token, player_id, expires_at`,
    [token, playerId, expires.toISOString()]
  );
  return res.rows[0]!;
}

//Resolve a bearer token to its player, rejecting expired tokens.
export async function playerForToken(token: string): Promise<Player | null> {
  const res = await query<Player>(
    `SELECT p.* FROM sessions s
       JOIN players p ON p.id = s.player_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return res.rows[0] ?? null;
}

//El registro ya no pregunta qué quieres ser. Pregunta cuándo naciste.
//
//    Fecha    -> destino compartido  (espíritu, número de vida, elemento, especie)
//    Servidor -> individuo singular  (DNA: color, proporciones, cuerpo destino)
//
//Dos personas nacidas el mismo día reciben la misma especie y no comparten ni
//un color. Eso es intencional: si todo individuo es único, nada es reconocible.
export async function registerOwner(input: {
  username: string;
  password: string;
  /** Day of birth (1–31). With month, seals spirit only — no year. */
  birthDay: number;
  /** Month of birth (1–12). */
  birthMonth: number;
  publicKey?: string;
  custody?: Custody;
  //El código de afiliado que venía en la URL (?ref=). Opcional siempre: un
  //código inválido se ignora, nunca rompe un registro. Sólo se captura en el
  //alta web — un invitado de Luanti que reclama su cuenta ya estaba jugando,
  //así que no llegó por un enlace de nadie.
  ref?: string;
}): Promise<{
  player: Player;
  session: Session;
  hashimon: null;
  created: true;
  claimed: boolean;
}> {
  const username = input.username.trim();
  if (!isValidLuantiUsername(username)) {
    throw new AppError(422, "invalid username (1–20 chars: A-Z a-z 0-9 _ -)", "invalid_username");
  }
  if (input.password.length < 8) {
    throw new AppError(422, "password must be at least 8 characters", "invalid_password");
  }
  if (!isPlausibleMonthDay(input.birthMonth, input.birthDay)) {
    throw new AppError(422, "birth day/month must be a real calendar date", "invalid_birth_day");
  }
  const spirit = spiritOfMonthDay(input.birthMonth, input.birthDay);
  enrich({ birth_spirit: spirit, element_awakened: false });

  const existing = await getPlayerByUsername(username);
  if (existing) {
    // A Luanti-only guest (no password_hash, no public_key) is reclaimable from this
    // same endpoint if the caller proves they know the account's password.
    if (existing.password_hash || existing.public_key) {
      throw new AppError(409, "username already registered", "username_taken");
    }
    return claimLuantiGuest(existing, input, spirit);
  }

  const keyMaterial = await deriveOwnerKeyMaterial(input);

  //argon2 is deliberately slow, so it dominates this route's duration_ms. Reported
  //as its own field, otherwise every registration reads like a latency anomaly.
  const hashStartedAt = process.hrtime.bigint();
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  enrich({ custody: keyMaterial.custody, argon2_ms: elapsedMs(hashStartedAt) });
  const luantiPassword = luantiSrpEntry(username, input.password);

  //Se resuelve contra la tabla antes de escribirlo, así que en players.referred_by
  //sólo puede acabar un código que existe y está activo — la FK nunca es la que
  //descubre un enlace mal copiado. Un código inválido deja esto en null y el
  //registro sigue su curso.
  const referredBy = await resolveAffiliateCode(input.ref);
  enrich({ referred_by: referredBy, ref_supplied: Boolean(input.ref) });

  let player: Player;
  try {
    const inserted = await query<Player>(
      `INSERT INTO players (
         username, password_hash, luanti_password, public_key, display_name,
         enc_private_key, kdf_salt, kdf_params, custody,
         birth_spirit, birth_month, birth_day,
         referred_by, referred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
                 $13, CASE WHEN $13::text IS NULL THEN NULL ELSE now() END)
       RETURNING *`,
      [
        username,
        passwordHash,
        luantiPassword,
        keyMaterial.publicKey,
        username,
        keyMaterial.encPrivateKey,
        keyMaterial.kdfSalt,
        keyMaterial.kdfParams ? JSON.stringify(keyMaterial.kdfParams) : null,
        keyMaterial.custody,
        spirit,
        input.birthMonth,
        input.birthDay,
        referredBy,
      ]
    );
    player = inserted.rows[0]!;
  } catch (err: unknown) {
    if (isUniqueViolation(err, "players_username_lower_idx")) {
      throw new AppError(409, "username already registered", "username_taken");
    }
    if (isUniqueViolation(err, "players_public_key_key")) {
      throw new AppError(409, "publicKey already registered", "public_key_taken");
    }
    throw err;
  }

  // Ritual 1: cuenta + espíritu. Genesis (ADN) llega en POST /profile/element.
  try {
    const session = await createSession(player.id);
    enrich({ player_id: player.id, starter_emitted: false });
    return { player, session, hashimon: null, created: true, claimed: false };
  } catch (err) {
    await query(`DELETE FROM players WHERE id = $1`, [player.id]).catch(() => {});
    throw err;
  }
}

/** Give a Luanti-only guest row (no password_hash, no public_key) what registerOwner
 *  would have given a brand-new account — keypair/custody and spirit — without
 *  touching luanti_password. Genesis waits for /profile/element. */
async function claimLuantiGuest(
  existing: Player,
  input: {
    password: string;
    birthDay: number;
    birthMonth: number;
    publicKey?: string;
    custody?: Custody;
  },
  spirit: string
): Promise<{
  player: Player;
  session: Session;
  hashimon: null;
  created: true;
  claimed: true;
}> {
  if (!existing.luanti_password || !luantiSrpVerify(existing.username!, input.password, existing.luanti_password)) {
    // Same 409 as a genuinely taken username: a wrong password here must not reveal
    // that the account exists and is claimable.
    throw new AppError(409, "username already registered", "username_taken");
  }

  const keyMaterial = await deriveOwnerKeyMaterial(input);

  const hashStartedAt = process.hrtime.bigint();
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  enrich({ custody: keyMaterial.custody, argon2_ms: elapsedMs(hashStartedAt) });

  let player: Player;
  try {
    const claimedRow = await query<Player>(
      `UPDATE players
          SET password_hash = $2, public_key = $3, enc_private_key = $4,
              kdf_salt = $5, kdf_params = $6::jsonb, custody = $7,
              birth_spirit = $8, birth_month = $9, birth_day = $10
        WHERE id = $1 AND password_hash IS NULL AND public_key IS NULL
        RETURNING *`,
      [
        existing.id,
        passwordHash,
        keyMaterial.publicKey,
        keyMaterial.encPrivateKey,
        keyMaterial.kdfSalt,
        keyMaterial.kdfParams ? JSON.stringify(keyMaterial.kdfParams) : null,
        keyMaterial.custody,
        spirit,
        input.birthMonth,
        input.birthDay,
      ]
    );
    const row = claimedRow.rows[0];
    if (!row) {
      // Lost the race against a concurrent claim on the same row.
      throw new AppError(409, "username already registered", "username_taken");
    }
    player = row;
  } catch (err: unknown) {
    if (err instanceof AppError) { throw err; }
    if (isUniqueViolation(err, "players_public_key_key")) {
      throw new AppError(409, "publicKey already registered", "public_key_taken");
    }
    throw err;
  }

  try {
    const session = await createSession(player.id);
    enrich({ player_id: player.id, starter_emitted: false, claimed: true });
    return { player, session, hashimon: null, created: true, claimed: true };
  } catch (err) {
    await query(
      `UPDATE players
          SET password_hash = NULL, public_key = NULL, enc_private_key = NULL,
              kdf_salt = NULL, kdf_params = NULL, custody = NULL,
              birth_spirit = NULL, birth_month = NULL, birth_day = NULL
        WHERE id = $1`,
      [player.id]
    ).catch(() => {});
    throw err;
  }
}

/** Validates + derives the keypair/custody/encrypted-blob triad shared by a fresh
 *  registration and a claim — the only difference between them is what SQL persists
 *  the result. */
async function deriveOwnerKeyMaterial(input: {
  password: string;
  publicKey?: string;
  custody?: Custody;
}): Promise<{
  publicKey: string;
  custody: Custody;
  encPrivateKey: Buffer | null;
  kdfSalt: string | null;
  kdfParams: Record<string, unknown> | null;
}> {
  if (input.custody === "player" && !input.publicKey) {
    throw new AppError(422, "custody player requires publicKey", "invalid_custody");
  }
  if (input.custody === "server_encrypted" && input.publicKey) {
    throw new AppError(422, "custody server_encrypted is incompatible with a supplied publicKey", "invalid_custody");
  }

  if (input.publicKey) {
    if (!isValidCompressedPublicKey(input.publicKey)) {
      throw new AppError(422, "invalid compressed secp256k1 publicKey", "invalid_public_key");
    }
    const keyTaken = await query(`SELECT 1 FROM players WHERE public_key = $1`, [input.publicKey]);
    if (keyTaken.rows[0]) {
      throw new AppError(409, "publicKey already registered", "public_key_taken");
    }
    return {
      publicKey: input.publicKey.toLowerCase(),
      custody: "player",
      encPrivateKey: null,
      kdfSalt: null,
      kdfParams: null,
    };
  }

  const kp = generateSecp256k1Keypair();
  const enc = await encryptPrivateKey(kp.privateKeyHex, input.password);
  return {
    publicKey: kp.publicKeyHex,
    custody: "server_encrypted",
    encPrivateKey: enc.ciphertext,
    kdfSalt: enc.kdfSalt,
    kdfParams: enc.kdfParams,
  };
}

/** Emits the genesis starter and mints the session that both a fresh registration
 *  and a successful claim end with. `compensate` undoes whatever the caller just
 *  persisted if this fails partway — a DELETE for a brand-new row, a revert-to-NULL
 *  for a claimed one (deleting it would destroy a pre-existing Luanti account). */
async function emitStarterAndBindSession(
  player: Player,
  identity: BirthIdentity,
  compensate: () => Promise<unknown>
): Promise<{ session: Session; hashimon: ReturnType<typeof present> }> {
  try {
    const row: HashimonRow = await emit({
      ownerId: player.id,
      speciesKey: identity.speciesKey,
      templateId: identity.templateId,
      provenance: "starter",
      birthSpirit: identity.spirit,
      lifeNumber: identity.lifeNumber,
    });
    const session = await createSession(player.id);
    enrich({ player_id: player.id, starter_emitted: true });
    return { session, hashimon: present(row) };
  } catch (err) {
    // emit()/createSession() failed after the row above already committed — neither
    // is part of that transaction (emit owns its own), so without this the account
    // would be left in a half-registered state.
    await compensate().catch(() => {});
    throw err;
  }
}

//Renacimiento V1 -> V2: le da su Birth Identity a una cuenta que se registró
//cuando la especie todavía se elegía a mano.
//
//La criatura vieja se ARCHIVA, jamás se reescribe. El PoW está ligado al DNA y
//el speciesKey entra en el preimagen del DNA, así que cambiar la especie in
//situ haría que cada share almacenado dejara de verificar y present() la
//reportaría como adulterada. Archivada conserva su DNA original y sigue
//verificando para siempre — simplemente deja de ser tu Genesis activo.
//
//El precio, y hay que decirlo claro: la nueva criatura nace en stage 1. La
//biografía de trabajo no se transfiere porque no PUEDE transferirse; ese es
//exactamente el rigor que hace verificable al sistema.
export async function rebirthWithBirthDate(
  player: Player,
  dob: string
): Promise<{ hashimon: ReturnType<typeof present>; archived: number; identity: BirthIdentity }> {
  if (!canOwn(player)) {
    throw new AppError(403, "cannot own without a public key — register on the web", "cannot_own");
  }
  //Anti-reroll. Sin esto, un jugador podría probar fechas hasta sacar el
  //espíritu que quería, que es justo lo que el sistema quita.
  if (player.birth_spirit) {
    throw new AppError(409, "birth identity already set and cannot be changed", "birth_already_set");
  }
  if (!isPlausibleDob(dob)) {
    throw new AppError(422, "dob must be a real calendar date (YYYY-MM-DD), 1900 or later, not in the future", "invalid_dob");
  }

  const identity = birthIdentityOf(dob);
  enrich({ birth_spirit: identity.spirit, life_number: identity.lifeNumber, genesis_element: identity.element });

  //La condición birth_spirit IS NULL cierra la carrera entre dos renacimientos
  //simultáneos: el segundo no actualiza ninguna fila y se rechaza. Mismo patrón
  //que claimLuantiGuest.
  const claimed = await query<Player>(
    `UPDATE players
        SET birth_spirit = $2, life_number = $3, genesis_element = $4,
            birth_version = $5, birth_set_at = now()
      WHERE id = $1 AND birth_spirit IS NULL
      RETURNING *`,
    [player.id, identity.spirit, identity.lifeNumber, identity.element, identity.version]
  );
  if (!claimed.rows[0]) {
    throw new AppError(409, "birth identity already set and cannot be changed", "birth_already_set");
  }

  const archived = await query(
    `UPDATE hashimons
        SET archived_at = now(), archive_reason = 'rebirth_v2'
      WHERE owner_id = $1 AND archived_at IS NULL AND provenance = 'starter'`,
    [player.id]
  );

  const row = await emit({
    ownerId: player.id,
    speciesKey: identity.speciesKey,
    templateId: identity.templateId,
    provenance: "starter",
    birthSpirit: identity.spirit,
    lifeNumber: identity.lifeNumber,
  });
  enrich({ rebirth_archived: archived.rowCount ?? 0, hashimon_id: row.id });
  return { hashimon: present(row), archived: archived.rowCount ?? 0, identity };
}

/**
 * Ritual 2: year → life number + natural element → emit Genesis.
 * Requires spirit already set at register (birth_spirit + birth_month/day) and
 * life_number still null. The year is never stored.
 */
export async function awakenElement(
  player: Player,
  input: { year: number } | { dob: string }
): Promise<{ hashimon: ReturnType<typeof present>; identity: BirthIdentity; player: Player }> {
  if (!canOwn(player)) {
    throw new AppError(403, "cannot own without a public key — register on the web", "cannot_own");
  }
  if (!player.birth_spirit) {
    throw new AppError(422, "set spirit first (register with day/month)", "spirit_required");
  }
  if (player.life_number != null) {
    throw new AppError(409, "element already awakened and cannot be changed", "element_already_set");
  }

  let dob: string;
  if ("dob" in input) {
    dob = input.dob;
    if (!isPlausibleDob(dob)) {
      throw new AppError(422, "dob must be a real calendar date (YYYY-MM-DD), 1900 or later, not in the future", "invalid_dob");
    }
    if (spiritOf(dob) !== player.birth_spirit) {
      throw new AppError(422, "date does not match your sealed spirit", "spirit_mismatch");
    }
  } else {
    const month = player.birth_month;
    const day = player.birth_day;
    if (month == null || day == null) {
      throw new AppError(422, "birth day/month missing — send full dob instead", "birth_day_missing");
    }
    const year = input.year;
    if (!Number.isInteger(year) || year < 1900) {
      throw new AppError(422, "year must be an integer >= 1900", "invalid_year");
    }
    dob = composeDob(year, month, day);
    if (!isPlausibleDob(dob)) {
      throw new AppError(422, "year + stored day/month is not a valid past date", "invalid_dob");
    }
  }

  const identity = birthIdentityOf(dob);
  if (identity.spirit !== player.birth_spirit) {
    throw new AppError(422, "date does not match your sealed spirit", "spirit_mismatch");
  }
  enrich({
    birth_spirit: identity.spirit,
    life_number: identity.lifeNumber,
    genesis_element: identity.element,
  });

  const dobParts = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/)!;
  const month = Number(dobParts[2]);
  const day = Number(dobParts[3]);

  // life_number IS NULL closes the race between two concurrent awakens.
  const sealed = await query<Player>(
    `UPDATE players
        SET life_number = $2, genesis_element = $3,
            birth_version = $4, birth_set_at = now(),
            birth_month = COALESCE(birth_month, $5),
            birth_day = COALESCE(birth_day, $6)
      WHERE id = $1 AND birth_spirit IS NOT NULL AND life_number IS NULL
      RETURNING *`,
    [player.id, identity.lifeNumber, identity.element, identity.version, month, day]
  );
  if (!sealed.rows[0]) {
    throw new AppError(409, "element already awakened and cannot be changed", "element_already_set");
  }

  // Should not already have an active starter; if somehow present, archive first.
  await query(
    `UPDATE hashimons
        SET archived_at = now(), archive_reason = 'element_awaken'
      WHERE owner_id = $1 AND archived_at IS NULL AND provenance = 'starter'`,
    [player.id]
  );

  const row = await emit({
    ownerId: player.id,
    speciesKey: identity.speciesKey,
    templateId: identity.templateId,
    provenance: "starter",
    birthSpirit: identity.spirit,
    lifeNumber: identity.lifeNumber,
  });
  enrich({ starter_emitted: true, hashimon_id: row.id });
  return { hashimon: present(row), identity, player: sealed.rows[0]! };
}

export async function loginOwner(username: string, password: string): Promise<{
  player: Player;
  session: Session;
  encPrivateKeyBase64: string | null;
  kdfSalt: string | null;
  kdfParams: Record<string, unknown> | null;
}> {
  //The response deliberately collapses both failures into one 401 so it leaks no
  //account existence. The event does not have to: operationally, a spike of
  //bad_password on existing accounts and a spike of no_user are different incidents.
  const player = await getPlayerByUsername(username.trim());
  if (!player || (!player.password_hash && !player.luanti_password)) {
    enrich({ login_result: "no_user" });
    throw new AppError(401, "invalid username or password", "invalid_credentials");
  }

  let ok: boolean;
  if (player.password_hash) {
    const verifyStartedAt = process.hrtime.bigint();
    ok = await argon2.verify(player.password_hash, password);
    enrich({ argon2_ms: elapsedMs(verifyStartedAt), login_source: "argon2" });
  } else {
    ok = luantiSrpVerify(player.username!, password, player.luanti_password!);
    enrich({ login_source: "srp" });
  }
  if (!ok) {
    enrich({ login_result: "bad_password", player_id: player.id });
    throw new AppError(401, "invalid username or password", "invalid_credentials");
  }
  enrich({ login_result: "ok", player_id: player.id, custody: player.custody });
  const session = await createSession(player.id);
  return {
    player,
    session,
    encPrivateKeyBase64: player.enc_private_key
      ? encPrivateKeyToBase64(player.enc_private_key)
      : null,
    kdfSalt: player.kdf_salt,
    kdfParams: player.kdf_params,
  };
}

export interface LuantiAuthEntry {
  name: string;
  password: string;
  can_own: boolean;
}

/** Every named account with a password entry — the mod mirrors this list and answers
 *  `get_auth` from it, so guests registered in-game must be in it too. `can_own`
 *  replaces "presence in the list means owner": presence now only means "the DB knows
 *  this password". */
export async function listLuantiAuthEntries(): Promise<LuantiAuthEntry[]> {
  const res = await query<{ username: string; luanti_password: string; public_key: string | null }>(
    `SELECT username, luanti_password, public_key FROM players
      WHERE username IS NOT NULL
        AND luanti_password IS NOT NULL`
  );
  return res.rows.map((r) => ({
    name: r.username,
    password: r.luanti_password,
    can_own: canOwn(r),
  }));
}

/** A player who registered from the Luanti client: username + the SRP entry the engine
 *  built from the password they typed, nothing else. No `password_hash` (they never
 *  gave us a plaintext to argon2) and no key, so `canOwn` stays false until they
 *  register on the web. */
export async function registerLuantiGuest(name: string, passwordEntry: string): Promise<Player> {
  const username = name.trim();
  if (!isValidLuantiUsername(username)) {
    throw new AppError(422, "invalid username (1–20 chars: A-Z a-z 0-9 _ -)", "invalid_username");
  }
  if (!isLuantiSrpEntry(passwordEntry)) {
    throw new AppError(422, "password must be a Luanti SRP entry (#1#salt#verifier)", "invalid_password_entry");
  }
  try {
    const inserted = await query<Player>(
      `INSERT INTO players (username, luanti_password, display_name)
       VALUES ($1, $2, $1) RETURNING *`,
      [username, passwordEntry]
    );
    return inserted.rows[0]!;
  } catch (err: unknown) {
    // No pre-SELECT: the unique index is what makes the check race-free against two
    // worlds registering the same name in the same tick.
    if (isUniqueViolation(err, "players_username_lower_idx")) {
      throw new AppError(409, "username already registered", "username_taken");
    }
    throw err;
  }
}

export async function claimSelfCustody(playerId: string): Promise<Player> {
  const res = await query<Player>(
    `UPDATE players
        SET enc_private_key = NULL, kdf_salt = NULL, kdf_params = NULL, custody = 'player'
      WHERE id = $1 AND public_key IS NOT NULL
      RETURNING *`,
    [playerId]
  );
  if (!res.rows[0]) {
    throw new AppError(404, "player not found or cannot own", "not_found");
  }
  return res.rows[0];
}
