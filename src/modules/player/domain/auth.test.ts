import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import {
  encryptPrivateKey,
  decryptPrivateKey,
  encPrivateKeyToBase64,
  generateSecp256k1Keypair,
  isValidCompressedPublicKey,
  isValidLuantiUsername,
  isLuantiSrpEntry,
  luantiSrpEntry,
  luantiSrpVerify,
} from "@/modules/player/domain/crypto";
import {
  canOwn,
  checkpointOf,
  claimSelfCustody,
  createSession,
  findOrCreatePlayer,
  getPlayer,
  getPlayerByUsername,
  listLuantiAuthEntries,
  loginOwner,
  playerForToken,
  rebirthWithBirthDate,
  registerLuantiGuest,
  registerOwner,
  setPlayerCheckpoint,
  setPlayerCheckpointByUsername,
  type Player,
} from "@/modules/player/domain/players";
import type { HashimonRow } from "@/modules/hashimon/domain/hashimons";
import { pool, query } from "@/modules/core/db/pool";
import { AppError } from "@/modules/core/http/errors";
import { fakeQuery, uniqueId } from "@/test/support/db";

function rejectsWithCode(code: string) {
  return (err: unknown) => err instanceof AppError && err.code === code;
}

/** A minimal, freshly-born HashimonRow — enough for `present()` to derive a view
 *  from without a live species/PoW pipeline. Used as the shape a fake `emitFn`
 *  returns when isolating players.ts's own orchestration from hashimon's `emit`. */
function fakeHashimonRow(overrides: Partial<HashimonRow> = {}): HashimonRow {
  return {
    id: overrides.id ?? uniqueId("hashimon"),
    owner_id: overrides.owner_id ?? "owner",
    dna: overrides.dna ?? "a".repeat(64),
    species_key: overrides.species_key ?? "fuego_guardian",
    template_id: overrides.template_id ?? "t1",
    birth_nonce: overrides.birth_nonce ?? "nonce",
    provenance: overrides.provenance ?? "starter",
    algo_version: overrides.algo_version ?? "caos-core@2",
    name: overrides.name ?? "",
    born_at: overrides.born_at ?? new Date().toISOString(),
    birth_spirit: overrides.birth_spirit ?? null,
    life_number: overrides.life_number ?? null,
    archived_at: overrides.archived_at ?? null,
    archive_reason: overrides.archive_reason ?? null,
    best_share_bits: overrides.best_share_bits ?? 0,
    best_share_hash: overrides.best_share_hash ?? null,
    best_share_nonce: overrides.best_share_nonce ?? null,
    best_share_extranonce2: overrides.best_share_extranonce2 ?? null,
    best_share_bitcoin: overrides.best_share_bitcoin ?? null,
    extranonce2: overrides.extranonce2 ?? 0,
    total_hashes: overrides.total_hashes ?? 0,
    valid_shares: overrides.valid_shares ?? 0,
    found_block: overrides.found_block ?? false,
  };
}

describe("crypto / ownership helpers", () => {
  it("validates Luanti usernames", () => {
    assert.equal(isValidLuantiUsername("Hans"), true);
    assert.equal(isValidLuantiUsername("a"), true);
    assert.equal(isValidLuantiUsername("too_long_username_xxx"), false);
    assert.equal(isValidLuantiUsername("bad name"), false);
  });

  // Reference vector: this entry was produced by luantiSrpEntry and then fed to the
  // engine's own core.check_password_entry() on a throwaway devtest world, which
  // accepted it for "Hans" and "hans" with secret123 and rejected a wrong password.
  // If a change here breaks parity with the engine, this vector is what catches it.
  const ENGINE_VECTOR = "#1#CWvgWHs19Sugq+uNeEFcKQ==#MVCq88fjqjehoHtx6U9AcuV/+jVT/Up8lqi3HE0Zkn66zf4wGnOQ4DjiKErARvl0BK9njKPDdZ5kSC5TQEEveSdMytMiz/RgfnsTt1+O8lh6du0XnWrA2Agidyx6FIRh/ZlyeEuL2NZsULf6B96zc2BKtisNXGsdpCpM4Ji7Ep7OdoPnt+pfdCQEnsCTZCXK2WX4oxvA1A9uQB0wn8HJAU6/XuOW3oCh1iP7paa0l4asNrMHLBtEQSuq8j+h9BnRFZQ3b+ZWY8KAK/M279vYkfJ4qUqnB0xY82x+3pCNp+OywusvFNWyum0Uhf1JlpdEJWEzCVlAG48biFB85VsiCg==";

  it("matches the engine's SRP verifier for a known entry", () => {
    assert.equal(luantiSrpVerify("Hans", "secret123", ENGINE_VECTOR), true);
    // The engine lowercases the name before deriving x, so casing cannot diverge.
    assert.equal(luantiSrpVerify("hans", "secret123", ENGINE_VECTOR), true);
    assert.equal(luantiSrpVerify("Hans", "secret124", ENGINE_VECTOR), false);
  });

  it("round-trips a freshly generated SRP entry", () => {
    const entry = luantiSrpEntry("Hans", "secret123");
    assert.equal(isLuantiSrpEntry(entry), true);
    assert.equal(luantiSrpVerify("Hans", "secret123", entry), true);
    assert.equal(luantiSrpVerify("HANS", "secret123", entry), true);
    assert.equal(luantiSrpVerify("Hans", "wrong", entry), false);
    // Fresh salt per call, so the same credentials never yield the same entry.
    assert.notEqual(entry, luantiSrpEntry("Hans", "secret123"));
  });

  it("rejects non-SRP password entries", () => {
    assert.equal(isLuantiSrpEntry("K7poFuVjUiXSeZvwAnieGlRMpkk"), false); // legacy SHA1
    assert.equal(isLuantiSrpEntry("#1#onlysalt"), false);
    assert.equal(luantiSrpVerify("Hans", "secret123", "#1#onlysalt"), false);
  });

  it("accepts the unpadded base64 the engine actually emits (util/base64.cpp skips padding)", () => {
    const unpadded = ENGINE_VECTOR.replace(/=+/g, "");
    assert.equal(isLuantiSrpEntry(unpadded), true);
    assert.equal(luantiSrpVerify("Hans", "secret123", unpadded), true);
  });

  it("generates entries in the engine's unpadded format", () => {
    const entry = luantiSrpEntry("Hans", "secret123");
    assert.equal(entry.includes("="), false);
  });

  it("generates and round-trips encrypted private keys", async () => {
    const kp = generateSecp256k1Keypair();
    assert.equal(isValidCompressedPublicKey(kp.publicKeyHex), true);
    const enc = await encryptPrivateKey(kp.privateKeyHex, "password123");
    const plain = decryptPrivateKey(enc.ciphertext, "password123", enc.kdfSalt, enc.kdfParams);
    assert.equal(plain, kp.privateKeyHex);
  });

  it("canOwn requires public_key", () => {
    assert.equal(canOwn({ public_key: null }), false);
    assert.equal(canOwn({ public_key: "02ab" }), true);
  });
});

describe("Luanti guest login and claim (against the local DB)", () => {
  const testUsernames: string[] = [];

  function uniqueUsername(prefix: string): string {
    const suffix = process.hrtime.bigint().toString(36);
    const name = `${prefix}${suffix}`.slice(0, 20);
    testUsernames.push(name);
    return name;
  }

  after(async () => {
    if (testUsernames.length > 0) {
      await query(`DELETE FROM players WHERE username = ANY($1)`, [testUsernames]);
    }
    await pool.end();
  });

  it("logs a Luanti-only guest in against its SRP entry, with the wrong password rejected", async () => {
    const username = uniqueUsername("srpguest");
    await registerLuantiGuest(username, luantiSrpEntry(username, "correct-horse-1"));

    const result = await loginOwner(username, "correct-horse-1");
    assert.equal(result.player.username, username);
    assert.equal(canOwn(result.player), false);

    await assert.rejects(loginOwner(username, "wrong-password"), rejectsWithCode("invalid_credentials"));
  });

  it("claims a Luanti-only guest through registerOwner, keeping the same luanti_password", async () => {
    const username = uniqueUsername("claimguest");
    const luantiPassword = luantiSrpEntry(username, "correct-horse-2");
    const guest = await registerLuantiGuest(username, luantiPassword);

    const claimed = await registerOwner({
      username,
      password: "correct-horse-2",
      dob: "1996-01-06",
    });
    assert.equal(claimed.claimed, true);
    assert.equal(canOwn(claimed.player), true);
    assert.equal(claimed.hashimon !== undefined, true);

    const row = await query<{ luanti_password: string }>(
      `SELECT luanti_password FROM players WHERE id = $1`,
      [guest.id]
    );
    assert.equal(row.rows[0]?.luanti_password, luantiPassword);

    // Now claimed: the same endpoint refuses to claim it a second time.
    await assert.rejects(
      registerOwner({ username, password: "correct-horse-2", dob: "1996-01-06" }),
      rejectsWithCode("username_taken")
    );
  });

  it("refuses to claim a Luanti-only guest with the wrong password", async () => {
    const username = uniqueUsername("badclaim");
    await registerLuantiGuest(username, luantiSrpEntry(username, "correct-horse-3"));

    await assert.rejects(
      registerOwner({ username, password: "totally-wrong-pw", dob: "1996-01-06" }),
      rejectsWithCode("username_taken")
    );
  });
});

describe("findOrCreatePlayer", () => {
  it("returns the existing player bound to a publicKey without inserting", async () => {
    const { query: fakeDb, calls } = fakeQuery((text) =>
      text.startsWith("SELECT * FROM players WHERE public_key") ? [{ id: "p1", public_key: "02ab" }] : []
    );
    const result = await findOrCreatePlayer({ publicKey: "02ab" }, fakeDb);
    assert.equal(result.created, false);
    assert.equal(calls.length, 1);
  });

  it("creates a fresh anonymous player, defaulting displayName to Trainer", async () => {
    const { query: fakeDb } = fakeQuery((text) =>
      text.startsWith("INSERT INTO players") ? [{ id: "p2", display_name: "Trainer", public_key: null }] : []
    );
    const result = await findOrCreatePlayer({}, fakeDb);
    assert.equal(result.created, true);
    assert.equal(result.player.display_name, "Trainer");
  });

  it("creates a new player bound to a publicKey when none exists yet", async () => {
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE public_key")) { return []; }
      if (text.startsWith("INSERT INTO players")) { return [{ id: "p3", public_key: "02cd", display_name: "Trainer" }]; }
      return [];
    });
    const result = await findOrCreatePlayer({ publicKey: "02cd" }, fakeDb);
    assert.equal(result.created, true);
    assert.equal(result.player.public_key, "02cd");
  });
});

describe("getPlayer / getPlayerByUsername", () => {
  it("returns null when no row matches", async () => {
    const { query: fakeDb } = fakeQuery(() => []);
    assert.equal(await getPlayer("missing", fakeDb), null);
    assert.equal(await getPlayerByUsername("missing", fakeDb), null);
  });

  it("returns the row when found", async () => {
    const { query: fakeDb } = fakeQuery(() => [{ id: "p1", username: "found" }]);
    assert.equal((await getPlayer("p1", fakeDb))?.id, "p1");
    assert.equal((await getPlayerByUsername("found", fakeDb))?.username, "found");
  });
});

describe("checkpointOf", () => {
  it("returns null when a coordinate is missing", () => {
    assert.equal(checkpointOf({ last_x: null, last_y: 1, last_z: 1, last_pos_at: "t" } as Player), null);
  });

  it("returns null when the timestamp is missing", () => {
    assert.equal(checkpointOf({ last_x: 1, last_y: 1, last_z: 1, last_pos_at: null } as Player), null);
  });

  it("returns the checkpoint when fully set", () => {
    const checkpoint = checkpointOf({ last_x: 1, last_y: 2, last_z: 3, last_pos_at: "2024-01-01T00:00:00Z" } as Player);
    assert.deepEqual(checkpoint, { x: 1, y: 2, z: 3, at: "2024-01-01T00:00:00Z" });
  });
});

describe("setPlayerCheckpoint / setPlayerCheckpointByUsername", () => {
  it("writes the checkpoint by player id", async () => {
    const { query: fakeDb, calls } = fakeQuery(() => []);
    await setPlayerCheckpoint("p1", { x: 1, y: 2, z: 3 }, fakeDb);
    assert.deepEqual(calls[0]?.params, ["p1", 1, 2, 3]);
  });

  it("returns true when a username matched", async () => {
    const { query: fakeDb } = fakeQuery(() => [{}]);
    const updated = await setPlayerCheckpointByUsername("someone", { x: 1, y: 2, z: 3 }, fakeDb);
    assert.equal(updated, true);
  });

  it("returns false when no username matched", async () => {
    const { query: fakeDb } = fakeQuery(() => []);
    const updated = await setPlayerCheckpointByUsername("ghost", { x: 1, y: 2, z: 3 }, fakeDb);
    assert.equal(updated, false);
  });
});

describe("createSession / playerForToken", () => {
  it("mints a 64-hex-char token and persists it", async () => {
    const { query: fakeDb } = fakeQuery((text, params) =>
      text.startsWith("INSERT INTO sessions") ? [{ token: params[0], player_id: params[1], expires_at: params[2] }] : []
    );
    const session = await createSession("p1", fakeDb);
    assert.match(session.token, /^[0-9a-f]{64}$/);
    assert.equal(session.player_id, "p1");
  });

  it("resolves a valid token to its player", async () => {
    const { query: fakeDb } = fakeQuery(() => [{ id: "p1" }]);
    assert.equal((await playerForToken("tok", fakeDb))?.id, "p1");
  });

  it("returns null for an unknown or expired token", async () => {
    const { query: fakeDb } = fakeQuery(() => []);
    assert.equal(await playerForToken("nope", fakeDb), null);
  });
});

describe("registerOwner — input validation (no DB reached)", () => {
  it("rejects an invalid username", async () => {
    await assert.rejects(
      registerOwner({ username: "bad name", password: "password1", dob: "1996-01-06" }),
      rejectsWithCode("invalid_username")
    );
  });

  it("rejects a password shorter than 8 characters", async () => {
    await assert.rejects(
      registerOwner({ username: "shortpw", password: "short", dob: "1996-01-06" }),
      rejectsWithCode("invalid_password")
    );
  });

  it("rejects an implausible dob", async () => {
    await assert.rejects(
      registerOwner({ username: "baddob", password: "password1", dob: "2999-01-01" }),
      rejectsWithCode("invalid_dob")
    );
  });
});

describe("registerOwner — duplicate username / custody / key-material validation", () => {
  it("rejects a username already taken by an owner (has a password or a key)", async () => {
    const { query: fakeDb } = fakeQuery(() => [{ id: "p1", username: "taken", password_hash: "hash", public_key: null }]);
    await assert.rejects(
      registerOwner({ username: "taken", password: "password1", dob: "1996-01-06" }, { db: fakeDb }),
      rejectsWithCode("username_taken")
    );
  });

  it("rejects custody:player without a publicKey", async () => {
    const { query: fakeDb } = fakeQuery();
    await assert.rejects(
      registerOwner({ username: "custody1", password: "password1", dob: "1996-01-06", custody: "player" }, { db: fakeDb }),
      rejectsWithCode("invalid_custody")
    );
  });

  it("rejects custody:server_encrypted combined with a publicKey", async () => {
    const kp = generateSecp256k1Keypair();
    const { query: fakeDb } = fakeQuery();
    await assert.rejects(
      registerOwner(
        { username: "custody2", password: "password1", dob: "1996-01-06", custody: "server_encrypted", publicKey: kp.publicKeyHex },
        { db: fakeDb }
      ),
      rejectsWithCode("invalid_custody")
    );
  });

  it("rejects a malformed publicKey", async () => {
    const { query: fakeDb } = fakeQuery();
    await assert.rejects(
      registerOwner({ username: "badkey", password: "password1", dob: "1996-01-06", publicKey: "not-a-key" }, { db: fakeDb }),
      rejectsWithCode("invalid_public_key")
    );
  });

  it("rejects a publicKey already registered", async () => {
    const kp = generateSecp256k1Keypair();
    const { query: fakeDb } = fakeQuery((text) =>
      text.startsWith("SELECT 1 FROM players WHERE public_key") ? [{ "?column?": 1 }] : []
    );
    await assert.rejects(
      registerOwner({ username: "keytaken", password: "password1", dob: "1996-01-06", publicKey: kp.publicKeyHex }, { db: fakeDb }),
      rejectsWithCode("public_key_taken")
    );
  });

  it("maps a username unique-violation on insert to username_taken", async () => {
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) { return []; }
      if (text.startsWith("INSERT INTO players")) {
        const err = Object.assign(new Error("dup"), { code: "23505", constraint: "players_username_lower_idx" });
        throw err;
      }
      return [];
    });
    await assert.rejects(
      registerOwner({ username: "dupuser", password: "password123", dob: "1996-01-06" }, { db: fakeDb }),
      rejectsWithCode("username_taken")
    );
  });

  it("maps a publicKey unique-violation on insert to public_key_taken", async () => {
    const kp = generateSecp256k1Keypair();
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) { return []; }
      if (text.startsWith("SELECT 1 FROM players WHERE public_key")) { return []; }
      if (text.startsWith("INSERT INTO players")) {
        const err = Object.assign(new Error("dup key"), { code: "23505", constraint: "players_public_key_key" });
        throw err;
      }
      return [];
    });
    await assert.rejects(
      registerOwner({ username: "keydup", password: "password123", dob: "1996-01-06", publicKey: kp.publicKeyHex }, { db: fakeDb }),
      rejectsWithCode("public_key_taken")
    );
  });

  it("rethrows an unrelated DB error during insert unchanged", async () => {
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) { return []; }
      if (text.startsWith("INSERT INTO players")) { throw new Error("connection lost"); }
      return [];
    });
    await assert.rejects(
      registerOwner({ username: "erruser2", password: "password123", dob: "1996-01-06" }, { db: fakeDb }),
      (err: unknown) => err instanceof Error && !(err instanceof AppError) && err.message === "connection lost"
    );
  });
});

describe("registerOwner — orchestration with injected collaborators (no live DB, no hashimon/affiliate modules)", () => {
  it("orchestrates a fresh registration end-to-end (server-generated keypair, referral resolved)", async () => {
    const { query: fakeDb, calls } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) { return []; }
      if (text.startsWith("INSERT INTO players")) { return [{ id: "new-player-id", username: "freshuser" }]; }
      if (text.startsWith("INSERT INTO sessions")) { return [{ token: "tok", player_id: "new-player-id", expires_at: new Date().toISOString() }]; }
      return [];
    });
    const emitFn = async (input: { ownerId: string; speciesKey: string; birthSpirit?: string; lifeNumber?: number }) =>
      fakeHashimonRow({ owner_id: input.ownerId, species_key: input.speciesKey, birth_spirit: input.birthSpirit ?? null, life_number: input.lifeNumber ?? null });
    const resolveAffiliateCodeFn = async (ref: string | undefined | null) => (ref ? "AFF1" : null);

    const result = await registerOwner(
      { username: "freshuser", password: "password123", dob: "1996-01-06", ref: "some-ref" },
      { db: fakeDb, emitFn, resolveAffiliateCodeFn }
    );

    assert.equal(result.created, true);
    assert.equal(result.claimed, false);
    assert.equal(result.player.id, "new-player-id");
    assert.equal(result.hashimon.ownerId, "new-player-id");

    const insertCall = calls.find((c) => c.text.startsWith("INSERT INTO players"));
    // custody index 8, referred_by index 13 — see the INSERT column list in players.ts.
    assert.equal(insertCall?.params[8], "server_encrypted");
    assert.equal(insertCall?.params[13], "AFF1");
    assert.equal(Buffer.isBuffer(insertCall?.params[5]), true); // enc_private_key present
  });

  it("orchestrates a fresh registration with a supplied publicKey (custody: player)", async () => {
    const kp = generateSecp256k1Keypair();
    const { query: fakeDb, calls } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) { return []; }
      if (text.startsWith("SELECT 1 FROM players WHERE public_key")) { return []; }
      if (text.startsWith("INSERT INTO players")) { return [{ id: "player-2", public_key: kp.publicKeyHex, custody: "player" }]; }
      if (text.startsWith("INSERT INTO sessions")) { return [{ token: "t2", player_id: "player-2", expires_at: new Date().toISOString() }]; }
      return [];
    });
    const emitFn = async (input: { ownerId: string; speciesKey: string }) =>
      fakeHashimonRow({ owner_id: input.ownerId, species_key: input.speciesKey });

    await registerOwner(
      { username: "ownerkey", password: "password123", dob: "1996-01-06", publicKey: kp.publicKeyHex },
      { db: fakeDb, emitFn }
    );

    const insertCall = calls.find((c) => c.text.startsWith("INSERT INTO players"));
    assert.equal(insertCall?.params[3], kp.publicKeyHex.toLowerCase());
    assert.equal(insertCall?.params[8], "player");
    assert.equal(insertCall?.params[5], null); // no encrypted private key for custody:player
  });

  it("compensates (deletes) the new player row when starter emission fails", async () => {
    const { query: fakeDb, calls } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) { return []; }
      if (text.startsWith("INSERT INTO players")) { return [{ id: "new-id" }]; }
      return [];
    });
    const emitFn = async (): Promise<HashimonRow> => { throw new Error("caos down"); };

    await assert.rejects(
      registerOwner({ username: "emitfail", password: "password123", dob: "1996-01-06" }, { db: fakeDb, emitFn }),
      /caos down/
    );
    assert.equal(calls.some((c) => c.text.startsWith("DELETE FROM players WHERE id")), true);
  });
});

describe("claimLuantiGuest (reached only through registerOwner's collision branch)", () => {
  it("loses the race when the claim UPDATE matches no row", async () => {
    const username = "raceguest";
    const luantiPassword = luantiSrpEntry(username, "pw12345678");
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) {
        return [{ id: "guest-id", username, password_hash: null, public_key: null, luanti_password: luantiPassword }];
      }
      if (text.startsWith("UPDATE players") && text.includes("password_hash = $2")) { return []; }
      return [];
    });
    await assert.rejects(
      registerOwner({ username, password: "pw12345678", dob: "1996-01-06" }, { db: fakeDb }),
      rejectsWithCode("username_taken")
    );
  });

  it("maps a publicKey unique-violation on claim to public_key_taken", async () => {
    const username = "claimkeydup";
    const luantiPassword = luantiSrpEntry(username, "pw12345678");
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) {
        return [{ id: "guest-id", username, password_hash: null, public_key: null, luanti_password: luantiPassword }];
      }
      if (text.startsWith("UPDATE players") && text.includes("password_hash = $2")) {
        const err = Object.assign(new Error("dup key"), { code: "23505", constraint: "players_public_key_key" });
        throw err;
      }
      return [];
    });
    await assert.rejects(
      registerOwner({ username, password: "pw12345678", dob: "1996-01-06" }, { db: fakeDb }),
      rejectsWithCode("public_key_taken")
    );
  });

  it("reverts the claimed row to guest state when starter emission fails after a successful claim", async () => {
    const username = "revertguest";
    const luantiPassword = luantiSrpEntry(username, "pw12345678");
    const { query: fakeDb, calls } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) {
        return [{ id: "guest-id", username, password_hash: null, public_key: null, luanti_password: luantiPassword }];
      }
      if (text.startsWith("UPDATE players") && text.includes("password_hash = $2")) {
        return [{ id: "guest-id", username }];
      }
      return [];
    });
    const emitFn = async (): Promise<HashimonRow> => { throw new Error("caos down"); };

    await assert.rejects(
      registerOwner({ username, password: "pw12345678", dob: "1996-01-06" }, { db: fakeDb, emitFn }),
      /caos down/
    );
    assert.equal(calls.some((c) => c.text.includes("SET password_hash = NULL")), true);
  });
});

describe("rebirthWithBirthDate", () => {
  it("rejects a player who cannot own (no public_key)", async () => {
    const player = { public_key: null, birth_spirit: null } as Player;
    await assert.rejects(rebirthWithBirthDate(player, "1996-01-06"), rejectsWithCode("cannot_own"));
  });

  it("rejects a player whose birth identity is already set (anti-reroll)", async () => {
    const player = { public_key: "02ab", birth_spirit: "corazon" } as Player;
    await assert.rejects(rebirthWithBirthDate(player, "1996-01-06"), rejectsWithCode("birth_already_set"));
  });

  it("rejects an implausible dob", async () => {
    const player = { public_key: "02ab", birth_spirit: null } as Player;
    await assert.rejects(rebirthWithBirthDate(player, "not-a-date"), rejectsWithCode("invalid_dob"));
  });

  it("rejects the race where a concurrent rebirth already claimed the row", async () => {
    const player = { id: "p1", public_key: "02ab", birth_spirit: null } as Player;
    const { query: fakeDb } = fakeQuery(() => []); // UPDATE ... WHERE birth_spirit IS NULL matches nothing
    await assert.rejects(
      rebirthWithBirthDate(player, "1996-01-06", { db: fakeDb }),
      rejectsWithCode("birth_already_set")
    );
  });

  it("archives the old starter and emits a fresh one on success", async () => {
    const player = { id: "p1", public_key: "02ab", birth_spirit: null } as Player;
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("UPDATE players")) { return [{ id: "p1", public_key: "02ab", birth_spirit: "espiritu" }]; }
      if (text.startsWith("UPDATE hashimons")) { return [{}]; } // one archived row
      return [];
    });
    const emitFn = async (input: { ownerId: string; speciesKey: string; birthSpirit?: string; lifeNumber?: number }) =>
      fakeHashimonRow({ owner_id: input.ownerId, species_key: input.speciesKey, birth_spirit: input.birthSpirit ?? null, life_number: input.lifeNumber ?? null });

    const result = await rebirthWithBirthDate(player, "1996-01-06", { db: fakeDb, emitFn });
    assert.equal(result.archived, 1);
    assert.equal(result.hashimon.birthSpirit, result.identity.spirit);
  });
});

describe("loginOwner", () => {
  it("rejects when no player matches the username", async () => {
    const { query: fakeDb } = fakeQuery(() => []);
    await assert.rejects(loginOwner("nouser", "whatever", fakeDb), rejectsWithCode("invalid_credentials"));
  });

  it("rejects a player with neither a password hash nor a luanti password", async () => {
    const { query: fakeDb } = fakeQuery(() => [{ id: "p1", username: "ghost", password_hash: null, luanti_password: null }]);
    await assert.rejects(loginOwner("ghost", "whatever", fakeDb), rejectsWithCode("invalid_credentials"));
  });

  it("rejects a wrong argon2 password", async () => {
    const hash = await argon2.hash("correct-password", { type: argon2.argon2id });
    const { query: fakeDb } = fakeQuery(() => [{ id: "p1", username: "owner1", password_hash: hash, luanti_password: null }]);
    await assert.rejects(loginOwner("owner1", "wrong-password", fakeDb), rejectsWithCode("invalid_credentials"));
  });

  it("logs in with the correct argon2 password and returns the encrypted key material", async () => {
    const hash = await argon2.hash("correct-password", { type: argon2.argon2id });
    const encBuf = Buffer.from("ciphertext-bytes");
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) {
        return [{
          id: "p1", username: "owner1", password_hash: hash, luanti_password: null,
          custody: "server_encrypted", enc_private_key: encBuf, kdf_salt: "salt", kdf_params: { N: 1 },
        }];
      }
      if (text.startsWith("INSERT INTO sessions")) { return [{ token: "tok", player_id: "p1", expires_at: new Date().toISOString() }]; }
      return [];
    });
    const result = await loginOwner("owner1", "correct-password", fakeDb);
    assert.equal(result.player.id, "p1");
    assert.equal(result.encPrivateKeyBase64, encPrivateKeyToBase64(encBuf));
  });

  it("returns a null encPrivateKeyBase64 when the player has no encrypted key (custody: player)", async () => {
    const hash = await argon2.hash("correct-password", { type: argon2.argon2id });
    const { query: fakeDb } = fakeQuery((text) => {
      if (text.startsWith("SELECT * FROM players WHERE lower(username)")) {
        return [{ id: "p2", username: "owner2", password_hash: hash, luanti_password: null, custody: "player", enc_private_key: null, kdf_salt: null, kdf_params: null }];
      }
      if (text.startsWith("INSERT INTO sessions")) { return [{ token: "tok2", player_id: "p2", expires_at: new Date().toISOString() }]; }
      return [];
    });
    const result = await loginOwner("owner2", "correct-password", fakeDb);
    assert.equal(result.encPrivateKeyBase64, null);
  });
});

describe("listLuantiAuthEntries", () => {
  it("returns an empty list when nobody has a password entry", async () => {
    const { query: fakeDb } = fakeQuery(() => []);
    assert.deepEqual(await listLuantiAuthEntries(fakeDb), []);
  });

  it("maps rows to name/password/can_own", async () => {
    const { query: fakeDb } = fakeQuery(() => [
      { username: "owner1", luanti_password: "#1#a#b", public_key: "02ab" },
      { username: "guest1", luanti_password: "#1#a#b", public_key: null },
    ]);
    const entries = await listLuantiAuthEntries(fakeDb);
    assert.deepEqual(entries, [
      { name: "owner1", password: "#1#a#b", can_own: true },
      { name: "guest1", password: "#1#a#b", can_own: false },
    ]);
  });
});

describe("registerLuantiGuest — validation & error mapping", () => {
  it("rejects an invalid username", async () => {
    await assert.rejects(registerLuantiGuest("bad name", "#1#a#b"), rejectsWithCode("invalid_username"));
  });

  it("rejects a malformed password entry", async () => {
    await assert.rejects(registerLuantiGuest("goodname", "not-srp"), rejectsWithCode("invalid_password_entry"));
  });

  it("maps a username unique-violation to username_taken", async () => {
    const { query: fakeDb } = fakeQuery(() => {
      const err = Object.assign(new Error("dup"), { code: "23505", constraint: "players_username_lower_idx" });
      throw err;
    });
    const entry = luantiSrpEntry("dupguest", "whatever12");
    await assert.rejects(registerLuantiGuest("dupguest", entry, fakeDb), rejectsWithCode("username_taken"));
  });

  it("rethrows an unrelated DB error unchanged", async () => {
    const { query: fakeDb } = fakeQuery(() => { throw new Error("connection reset"); });
    const entry = luantiSrpEntry("erruser", "whatever12");
    await assert.rejects(registerLuantiGuest("erruser", entry, fakeDb), /connection reset/);
  });
});

describe("claimSelfCustody", () => {
  it("throws not_found when the player cannot own or does not exist", async () => {
    const { query: fakeDb } = fakeQuery(() => []);
    await assert.rejects(claimSelfCustody("missing-id", fakeDb), rejectsWithCode("not_found"));
  });

  it("wipes the encrypted key material and switches custody to player", async () => {
    const { query: fakeDb } = fakeQuery(() => [{ id: "p1", custody: "player", enc_private_key: null, kdf_salt: null, kdf_params: null }]);
    const result = await claimSelfCustody("p1", fakeDb);
    assert.equal(result.custody, "player");
    assert.equal(result.enc_private_key, null);
  });
});
