import { query, withTransaction, type Sql } from "@/modules/core/db/pool";
import { audit } from "@/modules/core/domain/audit";
import { AppError } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";

//La escalera de 99 (docs/CARTAS_V1.md §3).
//
//El NIVEL es del jugador, no de la criatura: cambiar de Hashimon no reinicia
//nada, y una carta vale lo mismo venga del Hashimon que venga. Por eso todo aquí
//suma por `owner_id` y jamás por `hashimon_id`.
//
//Y no sale del hash. Las estrellas de una criatura mueren en la 8-10 porque cada
//una cuesta 16× la anterior; estirarlas hasta 99 obligaría al servidor a otorgar
//estrellas en vez de verificarlas. El nivel sale de QUEMAR cartas, así que puede
//subir para siempre sin que nadie mienta.

export const MAX_LEVEL = 99;
const LEVEL_BASE = 12;
const LEVEL_EXP = 1.5;
/** Cada 10 niveles se gana una mutación; del 90 al 99 no hay más (§6.1). */
export const MUTATION_EVERY = 10;
export const LAST_MUTATION_LEVEL = 90;

/**
 * Lo que cuesta pasar de `level` al siguiente, en esencia.
 *
 * `12 × N^1.5` es la curva elegida: el salto 98→99 pide 11.642 esencia (unas 6 h
 * de ronroneo) y llegar al 99 son ~462.000 (unos 10 días continuos). Se probaron
 * `N^1.2` — el tope cae en 3 días, regalado — y `N^1.8` — 35 días, con el último
 * nivel a día y medio, que ya es castigo.
 */
export function levelCost(level: number): number {
  return Math.round(LEVEL_BASE * Math.pow(level, LEVEL_EXP));
}

/** Los niveles múltiplos de 10 que quedan estrictamente entre `from` y `to`. */
export function mutationLevelsCrossed(from: number, to: number): number[] {
  const out: number[] = [];
  for (let l = Math.floor(from / MUTATION_EVERY) * MUTATION_EVERY + MUTATION_EVERY; l <= to; l += MUTATION_EVERY) {
    if (l > from && l <= LAST_MUTATION_LEVEL) { out.push(l); }
  }
  return out;
}

export interface LevelState {
  level: number;
  /** La barra ACTUAL, no un acumulado: al subir se vacía y vuelve a empezar. */
  essence: number;
  /** Lo que cuesta el siguiente salto; null en el tope. */
  nextCost: number | null;
}

export async function levelStateOf(ownerId: string, client?: Sql): Promise<LevelState> {
  const res = await query<{ level: number; essence: number }>(
    `SELECT level, essence FROM players WHERE id = $1`,
    [ownerId],
    client
  );
  const row = res.rows[0];
  if (!row) { throw new AppError(404, "levelStateOf: no such player", "not_found"); }
  return {
    level: row.level,
    essence: row.essence,
    nextCost: row.level >= MAX_LEVEL ? null : levelCost(row.level),
  };
}

export interface BurnResult extends LevelState {
  /** Cartas realmente quemadas — puede ser menos de las pedidas. */
  burned: number;
  essenceGained: number;
  levelsGained: number;
  /** Niveles múltiplos de 10 cruzados en esta quema. */
  mutationsUnlocked: number[];
}

/**
 * Quemar cartas para subir de nivel.
 *
 * La garantía que importa es SQL, no un `if`: el `UPDATE … WHERE burned_at IS
 * NULL RETURNING essence` sólo devuelve fila para las cartas que seguían vivas,
 * así que dos peticiones simultáneas con la misma carta no pueden cobrarla dos
 * veces — la segunda no recibe nada que sumar. Mismo patrón que `settleAndCredit`
 * en payments.
 *
 * `owner_id` en el WHERE es lo que impide quemar cartas ajenas: no es una
 * comprobación previa que una carrera pueda saltarse, es parte del UPDATE.
 */
export async function burnForLevel(ownerId: string, cardIds: string[]): Promise<BurnResult> {
  if (cardIds.length === 0) {
    throw new AppError(422, "burnForLevel: no cards given", "no_cards");
  }
  if (cardIds.length > 500) {
    throw new AppError(422, "burnForLevel: too many cards at once (max 500)", "too_many_cards");
  }

  return withTransaction(async (client) => {
    const burned = await query<{ essence: number }>(
      `UPDATE cards SET burned_at = now()
        WHERE card_id = ANY($1::uuid[]) AND owner_id = $2 AND burned_at IS NULL
        RETURNING essence`,
      [cardIds, ownerId],
      client
    );
    if (burned.rowCount === 0) {
      throw new AppError(409, "burnForLevel: none of those cards are yours and unburned", "nothing_to_burn");
    }
    const essenceGained = burned.rows.reduce((sum, r) => sum + r.essence, 0);

    //FOR UPDATE: el nivel se lee y se escribe en la misma vista de la fila, así
    //que dos quemas a la vez no pueden calcular el salto sobre el mismo estado.
    const before = await query<{ level: number; essence: number }>(
      `SELECT level, essence FROM players WHERE id = $1 FOR UPDATE`,
      [ownerId],
      client
    );
    const startLevel = before.rows[0]!.level;
    let level = startLevel;
    let essence = before.rows[0]!.essence + essenceGained;

    //La barra se vacía en cada salto: eso es lo que convierte 99 niveles en 98
    //logros cerrados en vez de una sola barra que nunca llena.
    while (level < MAX_LEVEL && essence >= levelCost(level)) {
      essence -= levelCost(level);
      level += 1;
    }
    //En el tope la esencia sobrante NO se tira: se queda en la barra. Quemar
    //nunca puede costarle nada a nadie.

    await query(
      `UPDATE players SET level = $2, essence = $3 WHERE id = $1`,
      [ownerId, level, essence],
      client
    );

    const mutationsUnlocked = mutationLevelsCrossed(startLevel, level);
    for (const at of mutationsUnlocked) {
      await query(
        `INSERT INTO mutation_grants (owner_id, level) VALUES ($1, $2)
         ON CONFLICT (owner_id, level) DO NOTHING`,
        [ownerId, at],
        client
      );
    }

    await audit(client, {
      playerId: ownerId,
      action: "cards.burned_for_level",
      detail: {
        burned: burned.rowCount,
        essenceGained,
        fromLevel: startLevel,
        toLevel: level,
        mutationsUnlocked,
      },
    });
    enrich({
      cards_burned: burned.rowCount,
      essence_gained: essenceGained,
      level_from: startLevel,
      level_to: level,
      mutations_unlocked: mutationsUnlocked.length,
    });

    return {
      burned: burned.rowCount ?? 0,
      essenceGained,
      levelsGained: level - startLevel,
      mutationsUnlocked,
      level,
      essence,
      nextCost: level >= MAX_LEVEL ? null : levelCost(level),
    };
  });
}

export interface MutationGrant {
  level: number;
  granted_at: Date;
  claimed_at: Date | null;
}

/**
 * Las mutaciones que el jugador se ha ganado jugando (§6.1).
 *
 * En V1 esto sólo REGISTRA el derecho: el sistema que lo convierte en una forma
 * nueva (Signature, afinidad, coste en esencia) todavía no existe —
 * `docs/MUTACION_V3.md` es diseño. Registrarlo desde ya es lo que hace que nadie
 * pierda lo que ganó mientras esa parte se construye.
 */
export async function mutationGrantsOf(ownerId: string): Promise<MutationGrant[]> {
  const res = await query<MutationGrant>(
    `SELECT level, granted_at, claimed_at FROM mutation_grants
      WHERE owner_id = $1 ORDER BY level ASC`,
    [ownerId]
  );
  return res.rows;
}
