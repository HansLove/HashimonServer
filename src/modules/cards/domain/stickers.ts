import { sha256 } from "@/modules/core/core/sha256";
import { MATERIAL_WINDOW, rollYieldTier, type YieldTier } from "@/modules/core/core/pow";
import { query, withTransaction, type Sql } from "@/modules/core/db/pool";
import { audit } from "@/modules/core/domain/audit";
import { enrich } from "@/modules/core/http/wide-event";
import { FOODS, foodFor, type Food } from "@/modules/mining/domain/foods";
import { MATURATION_BANDS } from "@/modules/cards/data/maturation";
import { MATURATION_RULES, publishRulesVersion } from "@/modules/cards/domain/rules-version";
import { mintFromYield } from "@/modules/cards/domain/cards";
import {
  BlockOracleDisagreement,
  BlockOracleUnavailable,
  defaultOracle,
  type BlockOracle,
} from "@/modules/payments/domain/block-oracle";

//La estampa de cada marca comprada (docs/ESTAMPAS_V1.md).
//
//Una marca de CaosEngine es trabajo real sobre la cadena de Bitcoin, atado al ADN de
//la criatura. Cada una da UNA estampa:
//
//  instantánea  ── lo común: tier e ítem salen del hash de la marca, como un hallazgo
//  capullo      ── lo valioso (cards/data/maturation.ts): el tier se ve al instante;
//                  el ítem lo decide el bloque h, el que la marca intentaba ganar
//
//La marca lleva el prevHash del bloque h-1; el bloque h no existía cuando se minó.
//Por eso nadie puede escoger en qué se convierte un capullo, ni siquiera quien mina.
//
//No hay cron, igual que el bono y la incubación: los capullos maduran cuando alguien
//los lee (GET /cards/cocoons). Madurar más tarde no cambia nada: el bloque h es el
//mismo lo lea quien lo lea.

export type CocoonStatus = "cocoon" | "matured";

export interface CocoonRow {
  mark_hash: string;
  owner_id: string;
  tier: YieldTier;
  prev_hash: string;
  rules_version: string;
  status: CocoonStatus;
  target_height: number | null;
  block_hash: string | null;
  item_key: string | null;
  card_id: string | null;
  matured_at: Date | null;
  created_at: Date;
  hashimon_id: string | null;
  yield_bits: number | null;
  nonce: string | null;
  place: string | null;
}

/** Todo lo que la marca aporta a su estampa y a la despensa. */
export interface MarkInput {
  hash: string;
  ownerId: string;
  hashimonId: string;
  prevHash: string;
  /** Profundidad recomputada de la marca (leadingZeroBits del hash). */
  bits: number;
  nonce: number;
  /** De dónde vino, para la despensa: `incubation:<lote>`. */
  place: string;
}

export interface StickerRoll {
  tier: YieldTier;
  /** La tirada instantánea. En un capullo sólo dice que cayó en la banda. */
  item: Food;
  maturing: boolean;
}

function materialOf(hash: string): string {
  return hash.toLowerCase().slice(MATERIAL_WINDOW.start, MATERIAL_WINDOW.end);
}

/** Lo que la marca dice por sí sola, sin bloque. Pura: es lo que cualquiera recalcula. */
export function stickerOf(markHash: string): StickerRoll {
  const tier = rollYieldTier(markHash);
  const item = foodFor(materialOf(markHash), tier);
  return { tier, item, maturing: MATURATION_BANDS[tier].includes(item.key) };
}

/** El hash que decide un capullo: la marca cruzada con el bloque h. */
export function sealedHashOf(markHash: string, blockHash: string): string {
  return sha256(`${markHash.toLowerCase()}:${blockHash.toLowerCase()}`);
}

/**
 * El ítem de un capullo maduro: una elección con pesos DENTRO de la banda, leída de la
 * ventana de material del hash sellado. Misma aritmética que foodFor y mismos pesos,
 * así que P(ítem) = P(banda) × peso/peso(banda) = peso/peso(tier): las probabilidades
 * publicadas no cambian. El orden es el de FOODS, no el de la banda: fijo y público.
 */
export function maturedItem(tier: YieldTier, sealedHash: string): Food {
  const band = FOODS.filter((f) => f.tier === tier && MATURATION_BANDS[tier].includes(f.key));
  if (band.length === 0) { throw new Error(`maturedItem: el tier ${tier} no tiene banda de maduración`); }
  const total = band.reduce((s, f) => s + f.weight, 0);
  const roll = (parseInt(materialOf(sealedHash).slice(0, 8), 16) >>> 0) % total;
  let acc = 0;
  for (const f of band) {
    acc += f.weight;
    if (roll < acc) { return f; }
  }
  return band[band.length - 1]!;
}

/**
 * La despensa sigue a la estampa (decisión del 18 sept): la fila de `pow_yield` lleva el
 * MISMO tier e ítem que la carta. Comida si es comida (los wolkers y el Hashimon la
 * comen), materia o mutágeno si es eso (no se gasta aquí). Antes cada marca dejaba una
 * croqueta fija sin importar lo que dijera la estampa. Idempotente por el hash (PK).
 */
async function stockPantry(
  client: Sql,
  input: { hash: string; hashimonId: string; ownerId: string; bits: number; nonce: number | string; place: string; tier: YieldTier; itemKey: string }
): Promise<void> {
  await query(
    `INSERT INTO pow_yield
       (hash, hashimon_id, owner_id, yield_bits, tier, material_key, extranonce2, nonce, place, food_key)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9)
     ON CONFLICT DO NOTHING`,
    [input.hash, input.hashimonId, input.ownerId, input.bits, input.tier, materialOf(input.hash), input.nonce, input.place, input.itemKey],
    client
  );
}

/**
 * La estampa de una marca verificada. Se llama DENTRO de la transacción de
 * `incubation.ts::applyShare`, con su client: la marca y su estampa (o su capullo) se
 * confirman juntas o no ocurre ninguna. Idempotente por las dos claves primarias
 * (`cards.hash`, `sticker_cocoons.mark_hash`), igual que la marca.
 */
export async function mintFromMark(client: Sql, input: MarkInput): Promise<StickerRoll> {
  const roll = stickerOf(input.hash);
  if (!roll.maturing) {
    await mintFromYield(client, { hash: input.hash, ownerId: input.ownerId, tier: roll.tier, itemKey: roll.item.key });
    await stockPantry(client, { ...input, tier: roll.tier, itemKey: roll.item.key });
    return roll;
  }
  //Un capullo no deja nada en la despensa todavía: se guarda lo que la fila necesitará
  //al madurar, porque la plantilla y el lote ya no estarán a mano entonces.
  await publishRulesVersion(client, MATURATION_RULES);
  await query(
    `INSERT INTO sticker_cocoons (mark_hash, owner_id, tier, prev_hash, rules_version, hashimon_id, yield_bits, nonce, place)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (mark_hash) DO NOTHING`,
    [input.hash, input.ownerId, roll.tier, input.prevHash, MATURATION_RULES.version, input.hashimonId, input.bits, input.nonce, input.place],
    client
  );
  return roll;
}

async function cocoonRow(markHash: string): Promise<CocoonRow | null> {
  const res = await query<CocoonRow>(`SELECT * FROM sticker_cocoons WHERE mark_hash = $1`, [markHash]);
  return res.rows[0] ?? null;
}

/**
 * Madurar un capullo si su bloque ya existe. La red va FUERA de la transacción; dentro,
 * `WHERE status = 'cocoon' RETURNING` es lo que hace que madure una sola vez: dos
 * lectores simultáneos calculan lo mismo (es determinista), pero sólo el primero
 * recibe la fila y sólo él acuña la carta.
 *
 * null si todavía no se puede: el bloque h no ha salido, o los exploradores no conocen
 * el bloque sobre el que se minó la marca (una plantilla de pruebas, o un bloque
 * huérfano que ya olvidaron). Un capullo así se queda cerrado; no se inventa nada.
 */
export async function matureCocoon(row: CocoonRow, oracle: BlockOracle): Promise<CocoonRow | null> {
  if (row.status !== "cocoon") { return null; }
  const prevHeight = await oracle.heightOf(row.prev_hash);
  if (prevHeight === null) { return null; }
  const target = prevHeight + 1;
  const blockHash = await oracle.hashAt(target);
  if (!blockHash) { return null; }

  const item = maturedItem(row.tier, sealedHashOf(row.mark_hash, blockHash));

  return withTransaction(async (client) => {
    const res = await query<CocoonRow>(
      `UPDATE sticker_cocoons
          SET status = 'matured', target_height = $2, block_hash = $3, item_key = $4, matured_at = now()
        WHERE mark_hash = $1 AND status = 'cocoon'
        RETURNING *`,
      [row.mark_hash, target, blockHash, item.key],
      client
    );
    const matured = res.rows[0];
    if (!matured) { return null; }

    const cardId = await mintFromYield(client, {
      hash: row.mark_hash,
      ownerId: row.owner_id,
      tier: row.tier,
      itemKey: item.key,
      maturedWith: blockHash,
      rules: MATURATION_RULES,
    });
    //La despensa recibe lo que el bloque decidió. Un capullo anterior a estas columnas
    //(sin criatura guardada) no puede: queda sin fila, y lo dice el evento.
    if (row.hashimon_id) {
      await stockPantry(client, {
        hash: row.mark_hash,
        hashimonId: row.hashimon_id,
        ownerId: row.owner_id,
        bits: row.yield_bits ?? 0,
        nonce: row.nonce ?? 0,
        place: row.place ?? "incubation",
        tier: row.tier,
        itemKey: item.key,
      });
    } else {
      enrich({ cocoon_pantry_skipped: row.mark_hash });
    }
    const linked = await query<CocoonRow>(
      `UPDATE sticker_cocoons SET card_id = $2 WHERE mark_hash = $1 RETURNING *`,
      [row.mark_hash, cardId],
      client
    );
    await audit(client, {
      playerId: row.owner_id,
      action: "sticker.matured",
      detail: {
        markHash: row.mark_hash,
        prevHash: row.prev_hash,
        targetHeight: target,
        blockHash,
        sealedHash: sealedHashOf(row.mark_hash, blockHash),
        tier: row.tier,
        item: item.key,
        rulesVersion: row.rules_version,
      },
    });
    enrich({ cocoon_mark: row.mark_hash, cocoon_height: target, cocoon_item: item.key });
    return linked.rows[0] ?? matured;
  });
}

/** Llevar un capullo tan lejos como se pueda ahora. Si los exploradores no responden o
 *  discrepan, se queda como estaba: la estampa llegará en otra lectura. */
export async function advanceCocoon(markHash: string, oracle: BlockOracle = defaultOracle()): Promise<CocoonRow | null> {
  const row = await cocoonRow(markHash);
  if (!row || row.status !== "cocoon") { return row; }
  try {
    return (await matureCocoon(row, oracle)) ?? (await cocoonRow(markHash));
  } catch (err: unknown) {
    if (err instanceof BlockOracleUnavailable || err instanceof BlockOracleDisagreement) {
      enrich({ cocoon_mark: markHash, cocoon_oracle_error: err.message });
      return cocoonRow(markHash);
    }
    throw err;
  }
}

/** Los capullos de un jugador, madurando antes los que sigan cerrados (hasta 10 por
 *  lectura: acota las llamadas a los exploradores; el caché del oráculo hace que diez
 *  capullos del mismo bloque cuesten casi lo mismo que uno). */
export async function cocoonsFor(ownerId: string, oracle: BlockOracle = defaultOracle()): Promise<CocoonRow[]> {
  const open = await query<{ mark_hash: string }>(
    `SELECT mark_hash FROM sticker_cocoons
      WHERE owner_id = $1 AND status = 'cocoon'
      ORDER BY created_at ASC LIMIT 10`,
    [ownerId]
  );
  for (const { mark_hash } of open.rows) {
    await advanceCocoon(mark_hash, oracle);
  }
  const res = await query<CocoonRow>(
    `SELECT * FROM sticker_cocoons WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [ownerId]
  );
  return res.rows;
}

/** Lo que ve el cliente: lo necesario para recalcular el capullo sin confiar en nosotros. */
export function presentCocoon(row: CocoonRow) {
  return {
    markHash: row.mark_hash,
    status: row.status,
    tier: row.tier,
    prevHash: row.prev_hash,
    targetHeight: row.target_height,
    blockHash: row.block_hash,
    itemKey: row.item_key,
    cardId: row.card_id,
    rulesVersion: row.rules_version,
    maturedAt: row.matured_at ? row.matured_at.toISOString() : null,
    formula: "sha256(markHash + ':' + blockHash(altura(prevHash) + 1)) → ventana de material → elección con pesos dentro de la banda",
  };
}
