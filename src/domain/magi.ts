import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "@/config";
import { pool, query, withTransaction, type DbClient, type Sql } from "@/db/pool";

//A MAGI as it travels: this is exactly what rides in the Luanti item's metadata.
//Everything in it is public except that it is *sealed* — the client can read the
//fields, it cannot mint a new combination of them.
export interface MagiToken {
  serial: string;
  sats: number;
  epoch: number;
  nonce: string;
  seal: string;
}

export interface MagiNoteRow {
  serial: string;
  sats: number;
  epoch: number;
  state: MagiState;
  custody_nonce: string;
  custody_seq: number;
  holder: string | null;
  issued_at: string;
  moved_at: string;
}

export type MagiState = "vaulted" | "materialized" | "retired";

//A verdict is the ONLY thing that justifies destroying a player's item, so it
//distinguishes "the ledger says this is not real" from "we could not ask".
//The mod destroys on stale/forged/unknown/retired and never on a transport error.
export type MagiVerdict = "ok" | "stale" | "forged" | "unknown" | "retired";

export interface CustodyResult {
  serial: string;
  verdict: MagiVerdict;
  //Present only on `ok`: the rotated token the item must be rewritten with.
  token?: MagiToken;
  reason?: string;
}

export class MagiUnconfigured extends Error {
  constructor() {
    super("MAGI_SEAL_SECRET not configured");
  }
}

function sealSecret(): Buffer {
  if (!config.magiSealSecret) { throw new MagiUnconfigured(); }
  return Buffer.from(config.magiSealSecret, "utf8");
}

/** HMAC over every field the item carries. Editing any of them — sats above all —
 *  invalidates the seal, because the secret never leaves this process. */
export function sealOf(serial: string, sats: number, epoch: number, nonce: string): string {
  return createHmac("sha256", sealSecret())
    .update(`magi:v1:${serial}:${sats}:${epoch}:${nonce}`, "utf8")
    .digest("hex");
}

export function verifySeal(token: MagiToken): boolean {
  const expected = Buffer.from(sealOf(token.serial, token.sats, token.epoch, token.nonce), "utf8");
  const actual = Buffer.from(String(token.seal ?? ""), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function tokenFor(row: MagiNoteRow): MagiToken {
  return {
    serial: row.serial,
    sats: row.sats,
    epoch: row.epoch,
    nonce: row.custody_nonce,
    seal: sealOf(row.serial, row.sats, row.epoch, row.custody_nonce),
  };
}

async function log(
  client: Sql,
  entry: { serial: string | null; seq?: number; holder?: string | null; event: string; verdict: MagiVerdict | "issued"; detail?: unknown }
): Promise<void> {
  await query(
    `INSERT INTO magi_custody_log (serial, seq, holder, event, verdict, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.serial, entry.seq ?? 0, entry.holder ?? null, entry.event, entry.verdict, JSON.stringify(entry.detail ?? {})],
    client
  );
}

/* ---- supply ------------------------------------------------------------- */

export interface MagiSupply {
  cap: number;
  issued: number;
  vaulted: number;
  materialized: number;
  retired: number;
  satsPerMagi: number;
  reserveSats: number;
  epoch: number;
}

//Takes an optional client so a caller inside a transaction reads its own
//uncommitted writes: on the pool, `issue` would report the supply as it was
//*before* the notes it just minted.
export async function supply(client: Sql = pool): Promise<MagiSupply> {
  const { rows } = await query<{ state: MagiState; n: string }>(
    `SELECT state, count(*)::text AS n FROM magi_notes GROUP BY state`,
    [],
    client
  );
  const by = (s: MagiState) => Number(rows.find((r) => r.state === s)?.n ?? 0);
  const vaulted = by("vaulted");
  const materialized = by("materialized");
  const retired = by("retired");
  const issued = vaulted + materialized + retired;
  return {
    cap: config.magiSupplyCap,
    issued,
    vaulted,
    materialized,
    retired,
    satsPerMagi: config.magiSatsPerMagi,
    //What the whole issued supply claims as backing. Derived, never stored: the
    //reserve is a public constraint on issuance, so it must follow the ledger.
    reserveSats: issued * config.magiSatsPerMagi,
    epoch: config.magiEpoch,
  };
}

/* ---- issuance ----------------------------------------------------------- */

/** Mint `count` new MAGI straight into `holder`'s vault. Refused past the cap —
 *  this is the one operation an admin could otherwise use to inflate silently. */
export async function issue(holder: string, count: number): Promise<{ issued: number; supply: MagiSupply }> {
  sealSecret(); //fail closed before touching the ledger
  return withTransaction(async (client: DbClient) => {
    //Lock the whole table for the duration: the cap is a global invariant, and two
    //concurrent mints each seeing room for the last note would break it.
    await client.query("LOCK TABLE magi_notes IN EXCLUSIVE MODE");
    const { rows: countRows } = await query<{ n: string }>(`SELECT count(*)::text AS n FROM magi_notes`, [], client);
    const already = Number(countRows[0]?.n ?? 0);
    const room = config.magiSupplyCap - already;
    if (room <= 0) { throw new MagiSupplyExhausted(config.magiSupplyCap); }
    const toIssue = Math.min(count, room);
    for (let i = 0; i < toIssue; i += 1) {
      const { rows } = await query<{ serial: string }>(
        `INSERT INTO magi_notes (sats, epoch, state, custody_nonce, holder)
         VALUES ($1, $2, 'vaulted', $3, $4) RETURNING serial`,
        [config.magiSatsPerMagi, config.magiEpoch, newNonce(), holder],
        client
      );
      await log(client, { serial: rows[0]!.serial, holder, event: "issue", verdict: "issued", detail: { sats: config.magiSatsPerMagi } });
    }
    return { issued: toIssue, supply: await supply(client) };
  });
}

export class MagiSupplyExhausted extends Error {
  constructor(public cap: number) {
    super(`MAGI supply cap of ${cap} reached`);
  }
}

/* ---- vault <-> world ----------------------------------------------------- */

/** Dematerialized -> physical. Returns one token per note to put in the inventory. */
export async function withdraw(holder: string, count: number): Promise<MagiToken[]> {
  sealSecret();
  return withTransaction(async (client: DbClient) => {
    const { rows } = await query<{ serial: string }>(
      `SELECT serial FROM magi_notes
        WHERE holder = $1 AND state = 'vaulted'
        ORDER BY issued_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [holder, count],
      client
    );
    const tokens: MagiToken[] = [];
    for (const { serial } of rows) {
      const nonce = newNonce();
      const { rows: updated } = await query<MagiNoteRow>(
        `UPDATE magi_notes
            SET state = 'materialized', custody_nonce = $2, custody_seq = custody_seq + 1, moved_at = now()
          WHERE serial = $1
      RETURNING *`,
        [serial, nonce],
        client
      );
      const row = updated[0]!;
      await log(client, { serial, seq: row.custody_seq, holder, event: "withdraw", verdict: "ok" });
      tokens.push(tokenFor(row));
    }
    return tokens;
  });
}

/** Physical -> dematerialized. Runs a full custody check first: a note that fails
 *  it is not deposited, it is destroyed. */
export async function deposit(holder: string, tokens: MagiToken[]): Promise<CustodyResult[]> {
  return runCustody(holder, tokens, "deposit", "vaulted");
}

/** Verify notes in hand and rotate their nonces, leaving them materialized. */
export async function check(holder: string, tokens: MagiToken[], event: string): Promise<CustodyResult[]> {
  return runCustody(holder, tokens, event, "materialized");
}

/** One note, one transaction: a rejected note must not roll back its neighbours,
 *  and the custody log entry has to commit with the rotation it describes. */
async function runCustody(
  holder: string,
  tokens: MagiToken[],
  event: string,
  nextState: MagiState
): Promise<CustodyResult[]> {
  sealSecret();
  const results: CustodyResult[] = [];
  for (const token of tokens) {
    results.push(await custodyOne(holder, token, event, nextState));
  }
  return results;
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

async function custodyOne(
  holder: string,
  token: MagiToken,
  event: string,
  nextState: MagiState
): Promise<CustodyResult> {
  //Seal first, and before any DB lookup: a fabricated serial should never even
  //become a query, let alone a row lock.
  if (!UUID_RE.test(String(token.serial ?? "")) || !verifySeal(token)) {
    await log(pool, { serial: null, holder, event, verdict: "forged", detail: { serial: token.serial ?? null } });
    return { serial: String(token.serial ?? ""), verdict: "forged", reason: "seal does not verify" };
  }
  return withTransaction(async (client: DbClient) => {
    const { rows } = await query<MagiNoteRow>(
      `SELECT * FROM magi_notes WHERE serial = $1 FOR UPDATE`,
      [token.serial],
      client
    );
    const row = rows[0];
    if (!row) {
      await log(client, { serial: null, holder, event, verdict: "unknown", detail: { serial: token.serial } });
      return { serial: token.serial, verdict: "unknown" as const, reason: "no such note in the ledger" };
    }
    if (row.state === "retired") {
      await log(client, { serial: row.serial, seq: row.custody_seq, holder, event, verdict: "retired" });
      return { serial: row.serial, verdict: "retired" as const, reason: "note was retired" };
    }
    //The duplication check. The seal proved this note was issued by us; the nonce
    //proves it is the copy that still holds custody. A clone is byte-identical and
    //therefore equally well sealed — only the retired nonce gives it away.
    if (row.custody_nonce !== token.nonce) {
      await log(client, {
        serial: row.serial,
        seq: row.custody_seq,
        holder,
        event,
        verdict: "stale",
        detail: { presented_nonce: token.nonce, ledger_seq: row.custody_seq, ledger_holder: row.holder },
      });
      return {
        serial: row.serial,
        verdict: "stale" as const,
        reason: "custody nonce already retired — duplicate copy",
      };
    }
    const nonce = newNonce();
    const { rows: updated } = await query<MagiNoteRow>(
      `UPDATE magi_notes
          SET state = $2, custody_nonce = $3, custody_seq = custody_seq + 1, holder = $4, moved_at = now()
        WHERE serial = $1
    RETURNING *`,
      [row.serial, nextState, nonce, holder],
      client
    );
    const next = updated[0]!;
    await log(client, { serial: next.serial, seq: next.custody_seq, holder, event, verdict: "ok" });
    return { serial: next.serial, verdict: "ok" as const, token: tokenFor(next) };
  });
}

/* ---- reads -------------------------------------------------------------- */

export interface HolderState {
  holder: string;
  vaulted: number;
  materialized: number;
  notes: Array<{ serial: string; state: MagiState; sats: number; custodySeq: number; movedAt: string }>;
}

export async function holderState(holder: string): Promise<HolderState> {
  const { rows } = await query<MagiNoteRow>(
    `SELECT * FROM magi_notes WHERE holder = $1 AND state <> 'retired' ORDER BY moved_at DESC`,
    [holder]
  );
  return {
    holder,
    vaulted: rows.filter((r) => r.state === "vaulted").length,
    materialized: rows.filter((r) => r.state === "materialized").length,
    notes: rows.map((r) => ({
      serial: r.serial,
      state: r.state,
      sats: r.sats,
      custodySeq: r.custody_seq,
      movedAt: r.moved_at,
    })),
  };
}
