import { randomBytes } from "node:crypto";
import { query } from "@/db/pool";
import { config } from "@/config";

export interface Player {
  id: string;
  public_key: string | null;
  display_name: string;
  credits: number;
  created_at: string;
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
