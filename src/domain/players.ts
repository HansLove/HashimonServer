import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { query } from "@/db/pool";
import { config } from "@/config";
import { AppError } from "@/http/errors";
import { elapsedMs, enrich } from "@/http/wide-event";
import {
  encPrivateKeyToBase64,
  encryptPrivateKey,
  generateSecp256k1Keypair,
  isValidCompressedPublicKey,
  isValidLuantiUsername,
  luantiSrpEntry,
  type Custody,
} from "@/domain/crypto";
import { emit, isGenesisSpecies, present, type HashimonRow } from "@/domain/hashimons";
import { Hashimons } from "@/data/species";

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

export async function registerOwner(input: {
  username: string;
  password: string;
  speciesKey: string;
  publicKey?: string;
  custody?: Custody;
}): Promise<{
  player: Player;
  session: Session;
  hashimon: ReturnType<typeof present>;
  created: true;
}> {
  const username = input.username.trim();
  if (!isValidLuantiUsername(username)) {
    throw new AppError(422, "invalid username (1–20 chars: A-Z a-z 0-9 _ -)", "invalid_username");
  }
  if (input.password.length < 8) {
    throw new AppError(422, "password must be at least 8 characters", "invalid_password");
  }
  if (!isGenesisSpecies(input.speciesKey) || !Hashimons[input.speciesKey]) {
    throw new AppError(422, "speciesKey must be a genesis starter element", "invalid_species");
  }

  const existing = await getPlayerByUsername(username);
  if (existing) {
    throw new AppError(409, "username already registered", "username_taken");
  }

  if (input.custody === "player" && !input.publicKey) {
    throw new AppError(422, "custody player requires publicKey", "invalid_custody");
  }
  if (input.custody === "server_encrypted" && input.publicKey) {
    throw new AppError(422, "custody server_encrypted is incompatible with a supplied publicKey", "invalid_custody");
  }

  let publicKey: string;
  let custody: Custody;
  let encPrivateKey: Buffer | null = null;
  let kdfSalt: string | null = null;
  let kdfParams: Record<string, unknown> | null = null;

  if (input.publicKey) {
    if (!isValidCompressedPublicKey(input.publicKey)) {
      throw new AppError(422, "invalid compressed secp256k1 publicKey", "invalid_public_key");
    }
    const keyTaken = await query(`SELECT 1 FROM players WHERE public_key = $1`, [input.publicKey]);
    if (keyTaken.rows[0]) {
      throw new AppError(409, "publicKey already registered", "public_key_taken");
    }
    publicKey = input.publicKey.toLowerCase();
    custody = "player";
  } else {
    const kp = generateSecp256k1Keypair();
    const enc = await encryptPrivateKey(kp.privateKeyHex, input.password);
    publicKey = kp.publicKeyHex;
    custody = "server_encrypted";
    encPrivateKey = enc.ciphertext;
    kdfSalt = enc.kdfSalt;
    kdfParams = enc.kdfParams;
  }

  //argon2 is deliberately slow, so it dominates this route's duration_ms. Reported
  //as its own field, otherwise every registration reads like a latency anomaly.
  const hashStartedAt = process.hrtime.bigint();
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  enrich({ custody, argon2_ms: elapsedMs(hashStartedAt) });
  const luantiPassword = luantiSrpEntry(username, input.password);

  let player: Player;
  try {
    const inserted = await query<Player>(
      `INSERT INTO players (
         username, password_hash, luanti_password, public_key, display_name,
         enc_private_key, kdf_salt, kdf_params, custody
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING *`,
      [
        username,
        passwordHash,
        luantiPassword,
        publicKey,
        username,
        encPrivateKey,
        kdfSalt,
        kdfParams ? JSON.stringify(kdfParams) : null,
        custody,
      ]
    );
    player = inserted.rows[0]!;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("players_username_lower_idx")) {
      throw new AppError(409, "username already registered", "username_taken");
    }
    if (msg.includes("public_key")) {
      throw new AppError(409, "publicKey already registered", "public_key_taken");
    }
    throw err;
  }

  try {
    const row: HashimonRow = await emit({
      ownerId: player.id,
      speciesKey: input.speciesKey,
      provenance: "starter",
    });
    const session = await createSession(player.id);
    enrich({ player_id: player.id, starter_emitted: true });
    return {
      player,
      session,
      hashimon: present(row),
      created: true,
    };
  } catch (err) {
    // emit()/createSession() failed after the player row already committed — the
    // INSERT above is not part of that transaction (emit owns its own), so without
    // this the username would be permanently orphaned (registered but unusable).
    // ponytail: best-effort compensating delete, not a real distributed transaction —
    // revisit if emit() ever accepts an external client to share one transaction.
    await query(`DELETE FROM players WHERE id = $1`, [player.id]).catch(() => {});
    throw err;
  }
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
  if (!player || !player.password_hash) {
    enrich({ login_result: "no_user" });
    throw new AppError(401, "invalid username or password", "invalid_credentials");
  }
  const verifyStartedAt = process.hrtime.bigint();
  const ok = await argon2.verify(player.password_hash, password);
  enrich({ argon2_ms: elapsedMs(verifyStartedAt) });
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

/** Owners with a key, for Luanti auth cache poll. */
export async function listLuantiAuthEntries(): Promise<Array<{ name: string; password: string }>> {
  const res = await query<{ username: string; luanti_password: string }>(
    `SELECT username, luanti_password FROM players
      WHERE username IS NOT NULL
        AND luanti_password IS NOT NULL
        AND public_key IS NOT NULL`
  );
  return res.rows.map((r) => ({ name: r.username, password: r.luanti_password }));
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
