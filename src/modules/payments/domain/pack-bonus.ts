import { sha256 } from "@/modules/core/core/sha256";
import { query, withTransaction, type Sql } from "@/modules/core/db/pool";
import { audit } from "@/modules/core/domain/audit";
import { enrich } from "@/modules/core/http/wide-event";
import { BONUS_RULES, publishRulesVersion } from "@/modules/cards/domain/rules-version";
import {
  BONUS_CONFIRMATIONS,
  BONUS_CREDIT_STEP,
  BONUS_ROLL_MODULUS,
  BONUS_TIERS,
} from "@/modules/payments/data/bonus-table";
import {
  BlockOracleDisagreement,
  BlockOracleUnavailable,
  defaultOracle,
  type BlockOracle,
} from "@/modules/payments/domain/block-oracle";

//El bono del paquete (docs/BONO_VERIFICABLE_V1.md).
//
//El PISO del paquete son los créditos del plan y los acredita settleAndCredit, en
//el instante, como siempre. Este módulo sólo decide el EXTRA, y lo decide el hash
//de un bloque de Bitcoin que no existía cuando se fijó:
//
//  pending    ── la liquidación crea la fila (misma transacción, sin red)
//  committed  ── se fija target_height = punta + 1   (una sola vez)
//  resolved   ── con 3 confirmaciones, h = SHA-256(hash:order_id) decide el tramo
//
//Este es el CUARTO sitio que mueve players.credits (ver .claude/rules/domains/
//payments.md). Acredita DESPUÉS de la liquidación y fuera de su transacción, y
//sólo puede sumar: nunca resta, y el piso ya está pagado pase lo que pase aquí.
//
//No hay cron: igual que la incubación, lo pendiente avanza cuando alguien lo lee
//(GET /payments/bonuses). Comprometer más tarde no da ventaja a nadie — sólo
//apunta a otro bloque igual de desconocido.

export type BonusStatus = "pending" | "committed" | "resolved";

export interface PackBonusRow {
  order_id: string;
  player_id: string;
  floor_credits: number;
  rules_version: string;
  status: BonusStatus;
  target_height: number | null;
  committed_at: Date | null;
  block_hash: string | null;
  roll: number | null;
  bonus_pct: number | null;
  bonus_credits: number | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface BonusRoll {
  digest: string;
  roll: number;
  pct: number;
  credits: number;
}

/**
 * La tirada. Pura y pública: es exactamente lo que cualquiera recalcula para
 * comprobar un bono (§4 del documento).
 *
 * Se re-hashea el hash del bloque con el order_id por dos razones: el hash de un
 * bloque empieza con decenas de ceros, así que sus primeros dígitos no son
 * aleatorios; y dos compras resueltas con el mismo bloque no deben sacar el mismo
 * bono.
 */
export function bonusRoll(blockHash: string, orderId: string, floorCredits: number): BonusRoll {
  const digest = sha256(`${blockHash.toLowerCase()}:${orderId}`);
  const roll = parseInt(digest.slice(0, 8), 16) % BONUS_ROLL_MODULUS;
  const tier = BONUS_TIERS.find((t) => roll < t.upto) ?? BONUS_TIERS[BONUS_TIERS.length - 1]!;
  const credits = Math.round((floorCredits * tier.pct) / 100 / BONUS_CREDIT_STEP) * BONUS_CREDIT_STEP;
  return { digest, roll, pct: tier.pct, credits };
}

/**
 * Crear el bono pendiente de un cobro. Se llama DENTRO de settleAndCredit, con su
 * client, y no toca la red.
 *
 * No puede fallar por lógica: `order_id` es la clave primaria, así que una
 * reentrega del webhook no crea un segundo bono (`ON CONFLICT DO NOTHING`), y la
 * versión de la tabla se publica en la misma transacción para que la FK nunca
 * falle.
 */
export async function createPendingBonus(
  client: Sql,
  payment: { order_id: string; player_id: string; credits: number }
): Promise<void> {
  await publishRulesVersion(client, BONUS_RULES);
  await query(
    `INSERT INTO pack_bonuses (order_id, player_id, floor_credits, rules_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_id) DO NOTHING`,
    [payment.order_id, payment.player_id, payment.credits, BONUS_RULES.version],
    client
  );
}

async function bonusRow(orderId: string): Promise<PackBonusRow | null> {
  const res = await query<PackBonusRow>(`SELECT * FROM pack_bonuses WHERE order_id = $1`, [orderId]);
  return res.rows[0] ?? null;
}

/**
 * Fijar la altura. `WHERE status = 'pending'` es lo que hace que sólo ocurra una
 * vez: dos llamadas simultáneas con puntas distintas no pueden cambiar de bloque,
 * porque la segunda ya no encuentra la fila pendiente.
 */
export async function commitBonus(orderId: string, oracle: BlockOracle): Promise<PackBonusRow | null> {
  const { commitTip } = await oracle.tips();
  const target = commitTip + 1;
  const res = await query<PackBonusRow>(
    `UPDATE pack_bonuses
        SET status = 'committed', target_height = $2, committed_at = now()
      WHERE order_id = $1 AND status = 'pending'
      RETURNING *`,
    [orderId, target]
  );
  const row = res.rows[0] ?? null;
  if (row) { enrich({ bonus_order_id: orderId, bonus_committed_height: target }); }
  return row;
}

/**
 * Resolver: leer el hash acordado, tirar y acreditar el extra.
 *
 * La lectura de red va FUERA de la transacción. Dentro, `WHERE status =
 * 'committed' RETURNING` es la garantía de una sola acreditación: si dos lectores
 * resuelven a la vez calculan lo mismo (es determinista), pero sólo el primero
 * recibe la fila y sólo él suma créditos.
 *
 * Un bono de +0 % también se resuelve y se audita: un auditor tiene que ver TODAS
 * las tiradas, no sólo las que dieron premio.
 */
export async function resolveBonus(row: PackBonusRow, oracle: BlockOracle): Promise<PackBonusRow | null> {
  if (row.status !== "committed" || row.target_height === null) { return null; }
  const { confirmedTip } = await oracle.tips();
  if (confirmedTip < row.target_height + BONUS_CONFIRMATIONS - 1) { return null; }

  const blockHash = await oracle.hashAt(row.target_height);
  if (!blockHash) { return null; }
  const outcome = bonusRoll(blockHash, row.order_id, Number(row.floor_credits));

  return withTransaction(async (client) => {
    const res = await query<PackBonusRow>(
      `UPDATE pack_bonuses
          SET status = 'resolved', block_hash = $2, roll = $3, bonus_pct = $4,
              bonus_credits = $5, resolved_at = now()
        WHERE order_id = $1 AND status = 'committed'
        RETURNING *`,
      [row.order_id, blockHash, outcome.roll, outcome.pct, outcome.credits],
      client
    );
    const resolved = res.rows[0];
    if (!resolved) { return null; }

    if (outcome.credits > 0) {
      await query(
        `UPDATE players SET credits = credits + $2 WHERE id = $1`,
        [row.player_id, outcome.credits],
        client
      );
    }
    await audit(client, {
      playerId: row.player_id,
      action: "credits.pack_bonus",
      detail: {
        orderId: row.order_id,
        targetHeight: row.target_height,
        blockHash,
        digest: outcome.digest,
        roll: outcome.roll,
        pct: outcome.pct,
        credits: outcome.credits,
        floorCredits: Number(row.floor_credits),
        rulesVersion: row.rules_version,
      },
    });
    enrich({
      bonus_order_id: row.order_id,
      bonus_roll: outcome.roll,
      bonus_pct: outcome.pct,
      bonus_credits: outcome.credits,
    });
    return resolved;
  });
}

/**
 * Llevar un bono tan lejos como se pueda ahora. Si los exploradores no responden
 * o discrepan, el bono se queda donde estaba y se devuelve tal cual: el jugador ya
 * tiene su piso, y el extra llegará en otra lectura.
 */
export async function advanceBonus(orderId: string, oracle: BlockOracle = defaultOracle()): Promise<PackBonusRow | null> {
  let row = await bonusRow(orderId);
  if (!row) { return null; }
  try {
    if (row.status === "pending") {
      row = (await commitBonus(orderId, oracle)) ?? (await bonusRow(orderId));
    }
    if (row && row.status === "committed") {
      row = (await resolveBonus(row, oracle)) ?? (await bonusRow(orderId));
    }
  } catch (err: unknown) {
    if (err instanceof BlockOracleUnavailable || err instanceof BlockOracleDisagreement) {
      enrich({ bonus_order_id: orderId, bonus_oracle_error: err.message });
      return bonusRow(orderId);
    }
    throw err;
  }
  return row;
}

/** Los bonos de un jugador, avanzando antes los que sigan abiertos (hasta 5 por
 *  lectura, para acotar cuántas llamadas salen a los exploradores). */
export async function bonusesFor(playerId: string, oracle: BlockOracle = defaultOracle()): Promise<PackBonusRow[]> {
  const open = await query<{ order_id: string }>(
    `SELECT order_id FROM pack_bonuses
      WHERE player_id = $1 AND status <> 'resolved'
      ORDER BY created_at ASC LIMIT 5`,
    [playerId]
  );
  for (const { order_id } of open.rows) {
    await advanceBonus(order_id, oracle);
  }
  const res = await query<PackBonusRow>(
    `SELECT * FROM pack_bonuses WHERE player_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [playerId]
  );
  return res.rows;
}

/** Lo que ve el cliente: todo lo necesario para recalcular el bono sin confiar en nosotros. */
export function presentBonus(row: PackBonusRow) {
  return {
    orderId: row.order_id,
    status: row.status,
    floorCredits: Number(row.floor_credits),
    targetHeight: row.target_height,
    committedAt: row.committed_at ? row.committed_at.toISOString() : null,
    confirmationsNeeded: BONUS_CONFIRMATIONS,
    blockHash: row.block_hash,
    roll: row.roll,
    bonusPct: row.bonus_pct,
    bonusCredits: row.bonus_credits === null ? null : Number(row.bonus_credits),
    rulesVersion: row.rules_version,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    formula: "sha256(blockHash + ':' + orderId) → primeros 8 hex → entero mod 10000 → tramo",
  };
}
