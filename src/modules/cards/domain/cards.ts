import { query, type Sql } from "@/modules/core/db/pool";
import { leadingZeroBits, progressionFromBits, type YieldTier } from "@/modules/core/core/pow";
import { foodByKey } from "@/modules/mining/domain/foods";
import { YIELD_ODDS, publishRulesVersion, type RulesVersion } from "@/modules/cards/domain/rules-version";

//Las cartas — docs/CARTAS_V1.md.
//
//Cada hallazgo de PoW se acuña como una carta. La carta NO es un adorno del
//hallazgo: es el objeto con el que el jugador juega después (quemar para subir
//de nivel, fusionar, asimilar una Naturaleza).
//
//La regla que sostiene todo el sistema: **un hash, una carta, para siempre**.
//`cards.hash UNIQUE` no es integridad, es EL SUMINISTRO. Para acuñar una carta
//hay que haber gastado la electricidad que produjo ese hash, así que nadie —
//tampoco nosotros — puede regalarse cartas. Esa es la diferencia con un ERC-721,
//donde acuñar es una llamada de función.
//
//V1 es deliberadamente pequeño: las cartas son soulbound, así que no hay
//transferencia que atacar y por tanto no hacen falta firmas, sello ni notario.
//Eso llega con V2 (docs/OWNERSHIP_AND_TRANSFER.md) y no antes.

export type CardKind = "food" | "matter" | "mutagen" | "nature" | "fused";

/** El rango del hallazgo decide la familia de la carta. `nature` y `fused` no
 *  salen de un hallazgo directo, así que no están aquí. */
const KIND_BY_TIER: Record<YieldTier, CardKind> = {
  consumable: "food",
  durable: "matter",
  capital: "mutagen",
};

export function kindForTier(tier: YieldTier): CardKind {
  return KIND_BY_TIER[tier];
}

/**
 * Esencia = 100 / peso, con suelo 1.
 *
 * No hay tabla nueva que calibrar: el peso ya existe en `foods.ts` y significa
 * "cómo de común es". Invertirlo hace que la rareza pague sola — Croqueta básica
 * (peso 100) vale 1, Fruta prisma (peso 2) vale 50 — y una carta nueva hereda su
 * valor el día que se añade al catálogo, sin tocar este módulo.
 */
export function essenceOf(weight: number): number {
  return Math.max(1, Math.round(100 / weight));
}

/**
 * Las estrellas de la CARTA: las del hash que la encontró, leídas en la ventana
 * de progresión — la misma lectura que haría una share.
 *
 * No son las estrellas de la criatura. Por eso una Croqueta básica puede venir
 * sellada con 9★: es común como objeto y rarísima como hallazgo, y ahí está lo
 * que la vuelve presumible.
 */
export function starsOfHash(hash: string): number {
  return progressionFromBits(leadingZeroBits(hash)).stars;
}

export interface CardRow {
  card_id: string;
  hash: string;
  owner_id: string;
  kind: CardKind;
  item_key: string;
  stars: number;
  essence: number;
  lineage: string[] | null;
  /** La versión exacta de las reglas con que nació (rules-version.ts). */
  rules_version: string | null;
  /** El bloque que decidió una estampa madurada (stickers.ts). null si fue instantánea. */
  matured_with: string | null;
  born_at: Date;
  burned_at: Date | null;
}

/**
 * Acuñar la carta de un hallazgo. Se llama DENTRO de la transacción de
 * `submitYield`, con su mismo client: el hallazgo y su carta se confirman juntos
 * o no ocurre ninguno de los dos.
 *
 * `ON CONFLICT (hash) DO NOTHING` la hace idempotente por la misma razón que el
 * resto del proyecto: una reentrega no debe acuñar una segunda carta del mismo
 * trabajo. La unicidad es del índice, no de un `if` previo.
 *
 * No puede fallar por lógica de negocio: todo lo que necesita llega resuelto
 * desde el hallazgo. Un `item_key` que no esté en el catálogo cae al suelo de
 * esencia en vez de lanzar — perder la carta de un trabajo real sería peor que
 * valorarla de menos.
 */
export async function mintFromYield(
  client: Sql,
  input: {
    hash: string;
    ownerId: string;
    tier: YieldTier;
    itemKey: string;
    /** Sólo una estampa madurada: el bloque que decidió su ítem (stickers.ts). */
    maturedWith?: string;
    /** Las reglas que decidieron ESTA carta. Por defecto, las del hallazgo. */
    rules?: RulesVersion;
  }
): Promise<string | null> {
  const food = foodByKey(input.itemKey);
  const rules = input.rules ?? YIELD_ODDS;
  //La tabla de probabilidades que decidió ESTA carta queda publicada y sellada en
  //la fila. Así, ante cualquier auditoría, cada carta dice con qué reglas nació y
  //esas reglas se pueden leer tal cual en rules_versions.
  await publishRulesVersion(client, rules);
  const res = await query<{ card_id: string }>(
    `INSERT INTO cards (hash, owner_id, kind, item_key, stars, essence, rules_version, matured_with)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (hash) DO NOTHING
     RETURNING card_id`,
    [
      input.hash,
      input.ownerId,
      kindForTier(input.tier),
      input.itemKey,
      starsOfHash(input.hash),
      essenceOf(food?.weight ?? 100),
      rules.version,
      input.maturedWith ?? null,
    ],
    client
  );
  return res.rows[0]?.card_id ?? null;
}

/** Las cartas vivas de un jugador. Una quemada sigue en la tabla; no está aquí. */
export async function liveCardsOf(ownerId: string, limit = 200): Promise<CardRow[]> {
  const res = await query<CardRow>(
    `SELECT * FROM cards
      WHERE owner_id = $1 AND burned_at IS NULL
      ORDER BY essence DESC, born_at DESC
      LIMIT $2`,
    [ownerId, limit]
  );
  return res.rows;
}

/** La esencia viva de un jugador: lo que puede gastar en subir de nivel.
 *
 *  Suma por `owner_id` y NUNCA por criatura: el nivel es del jugador, así que
 *  una carta vale lo mismo venga del Hashimon que venga. */
export async function liveEssenceOf(ownerId: string): Promise<number> {
  const res = await query<{ essence: string }>(
    `SELECT COALESCE(SUM(essence), 0) AS essence
       FROM cards WHERE owner_id = $1 AND burned_at IS NULL`,
    [ownerId]
  );
  return Number(res.rows[0]?.essence ?? 0);
}

export interface CardSupply {
  minted: number;
  burned: number;
  live: number;
}

/**
 * El suministro, que es la mitad del argumento del proyecto: vivas = acuñadas −
 * quemadas, y las dos mitades son auditables porque una carta quemada sale del
 * suministro pero nunca de la tabla.
 */
export async function supply(): Promise<CardSupply> {
  const res = await query<{ minted: string; burned: string }>(
    `SELECT COUNT(*) AS minted,
            COUNT(*) FILTER (WHERE burned_at IS NOT NULL) AS burned
       FROM cards`
  );
  const minted = Number(res.rows[0]?.minted ?? 0);
  const burned = Number(res.rows[0]?.burned ?? 0);
  return { minted, burned, live: minted - burned };
}
