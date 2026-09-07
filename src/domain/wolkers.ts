import { createHash } from "node:crypto";
import { query, withTransaction, type DbClient, type Sql } from "@/db/pool";

// Wolkers — la población nativa de un town (docs/WOLKERS_V1.md).
//
// Dos invariantes cargan con todo el diseño:
//  1. NO se spawnean. Sólo hay dos orígenes: el reparto genesis (una vez por homeblock) y,
//     desde la Fase 2, la reproducción pagada con comida ya minada. No existe una función
//     que cree un wolker de la nada, y no debe existir.
//  2. La comida es COMPARTIDA con los Hashimons: la despensa de un town son las mismas filas
//     `pow_yield` consumibles sin gastar que `mining::consumeCroqueta` le da de comer a una
//     criatura. Alimentar a tu bicho le quita de comer a tu pueblo — cada croqueta se gasta
//     una vez, y el alcalde decide en qué.
//
// El censo es autoritativo aquí, no en Luanti: este tick corre en SQL puro aunque el mundo
// esté vacío, así que un town abandonado sigue pasando hambre.

/** Sube el hambre de un wolker que no comió en el tick. 100 = muerte, así que ~25 ticks. */
const HUNGER_PER_TICK = 4;
/** Lo que baja el hambre una croqueta. Una comida cubre unos seis ticks de ayuno. */
const FEED_RELIEF = 25;
/** A partir de aquí el wolker se está muriendo de hambre y el evento se hace visible. */
const STARVING_AT = 76;
/** Wolkers por reparto genesis (WOLKERS_V1.md §4.1). */
export const GENESIS_LITTER = 4;
/** Edad a partir de la cual la vejez puede matar; sin esto un town viejo es inmortal. */
const ELDER_DAYS = 180;
/** Probabilidad de muerte por vejez, por tick, una vez pasada ELDER_DAYS. */
const ELDER_DEATH_P = 0.004;

export type WolkerState = "alive" | "migrating" | "dead";
export type DeathCause = "hunger" | "combat" | "raid" | "age";

export interface WolkerRow {
  id: string;
  town_name: string | null;
  parent_a: string;
  parent_b: string;
  birth_nonce: number;
  vigor: number;
  oficio: number;
  temple: number;
  hunger: number;
  morale: number;
  state: WolkerState;
  born_at: Date;
  died_at: Date | null;
  death_cause: DeathCause | null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * La identidad del town para el genesis. Es el HOMEBLOCK, no el nombre: renombrar el town no
 * da un segundo reparto, y borrarlo y refundarlo en el mismo sitio tampoco.
 */
export function townSeed(townName: string, home: { x: number; y: number; z: number }): string {
  return sha256Hex(`town:${townName}:${home.x},${home.y},${home.z}`);
}

/**
 * Un wolker ES un hash, como toda criatura en Hashimon. Con los padres y el nonce cualquiera
 * recomputa el id, así que el linaje completo se audita desde el genesis sin confiar en la DB.
 */
export function wolkerId(parentA: string, parentB: string, birthNonce: number): string {
  return sha256Hex(`wolker:v1:${parentA}:${parentB}:${birthNonce}`);
}

/**
 * Días hasta la adultez. Un wolker nacido en la Fase 2 pasa un mes real de niño: tiempo
 * suficiente para que se le vea crecer y para que matar niños no sea un atajo demográfico.
 */
export const CHILD_DAYS = 30;

/** El signo es el sexo: +1 hombre, −1 mujer. Un bit del hash, no una elección. */
export type WolkerSign = 1 | -1;
export type WolkerStage = "child" | "adult";

export interface WolkerAppearance {
  sign: WolkerSign;
  stage: WolkerStage;
  /** Modelo que el mundo debe cargar. Sólo hay tres piezas de lego. */
  model: "wolker_pos" | "wolker_neg" | "wolker_small";
}

/**
 * Signo derivado del id: bit bajo del byte 3. Un byte distinto del que dan los rasgos, para
 * que vigor y sexo no queden correlacionados por accidente.
 */
export function signOf(id: string): WolkerSign {
  return parseInt(id.slice(6, 8), 16) % 2 === 0 ? 1 : -1;
}

/**
 * Apariencia = signo + etapa, y nada más. Tres modelos cubren toda la población porque el
 * niño es un modelo propio teñido por su signo: crece hacia el modelo adulto que le toca,
 * sin que haya que autorizar un asset por wolker.
 *
 * Gemelo exacto de `appearance.lua` en el mod — mismo id, misma pieza, en los dos lados.
 */
export function appearanceOf(id: string, bornAt: Date, now: Date = new Date()): WolkerAppearance {
  const sign = signOf(id);
  const ageDays = (now.getTime() - bornAt.getTime()) / 86_400_000;
  const stage: WolkerStage = ageDays < CHILD_DAYS ? "child" : "adult";
  const model = stage === "child" ? "wolker_small" : sign === 1 ? "wolker_pos" : "wolker_neg";
  return { sign, stage, model };
}

export interface WolkerTraits {
  vigor: number;
  oficio: number;
  temple: number;
}

/** Rasgos derivados del id (mismo criterio que el Look Compiler: bytes fijos, sin azar). */
export function traitsOf(id: string): WolkerTraits {
  const byteAt = (i: number) => parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return { vigor: byteAt(0), oficio: byteAt(1), temple: byteAt(2) };
}

async function recordEvent(
  client: DbClient,
  input: { wolkerId: string; kind: string; fromTown?: string | null; toTown?: string | null; detail?: unknown }
): Promise<void> {
  await query(
    `INSERT INTO wolker_events (wolker_id, kind, from_town, to_town, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.wolkerId, input.kind, input.fromTown ?? null, input.toTown ?? null, JSON.stringify(input.detail ?? {})],
    client
  );
}

/**
 * El reparto genesis: la única creación sin padres que existe. Idempotente por `town_seed`
 * (PK de `wolker_genesis`), de modo que dos llamadas concurrentes o un refundado del town
 * no reparten dos veces. Devuelve los ids repartidos, o [] si el homeblock ya tenía su lote.
 */
export async function seedGenesis(
  townName: string,
  home: { x: number; y: number; z: number }
): Promise<string[]> {
  const seed = townSeed(townName, home);
  return withTransaction(async (client) => {
    const claimed = await query(
      `INSERT INTO wolker_genesis (town_seed, town_name, count)
       VALUES ($1, $2, $3)
       ON CONFLICT (town_seed) DO NOTHING
       RETURNING town_seed`,
      [seed, townName, GENESIS_LITTER],
      client
    );
    if (claimed.rows.length === 0) return [];

    const ids: string[] = [];
    for (let nonce = 0; nonce < GENESIS_LITTER; nonce++) {
      const id = wolkerId(seed, seed, nonce);
      const t = traitsOf(id);
      await query(
        `INSERT INTO wolkers
           (id, town_name, parent_a, parent_b, birth_nonce, vigor, oficio, temple, home_x, home_y, home_z)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, townName, seed, nonce, t.vigor, t.oficio, t.temple, home.x, home.y, home.z],
        client
      );
      await recordEvent(client, { wolkerId: id, kind: "birth", toTown: townName, detail: { genesis: true } });
      ids.push(id);
    }
    return ids;
  });
}

/** Censo vivo de un town (`migrating` cuenta: sigue siendo gente, sólo que de salida). */
export async function population(townName: string, client?: Sql): Promise<number> {
  const sql = `SELECT count(*)::text AS n FROM wolkers WHERE town_name = $1 AND state <> 'dead'`;
  const res = client
    ? await query<{ n: string }>(sql, [townName], client)
    : await query<{ n: string }>(sql, [townName]);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * La despensa del town: croquetas sin gastar de sus residentes. Son LAS MISMAS filas que come
 * un Hashimon vía `consumeCroqueta` — no hay un segundo inventario. La residencia sale de
 * `player_territory`, que el mundo empuja; un jugador sin town no alimenta a nadie.
 */
export async function townLarder(townName: string, client?: Sql): Promise<number> {
  const sql =
    `SELECT count(*)::text AS n
       FROM pow_yield y
       JOIN player_territory t ON t.player_id = y.owner_id
      WHERE t.town_name = $1 AND y.tier = 'consumable' AND y.consumed_at IS NULL`;
  const res = client
    ? await query<{ n: string }>(sql, [townName], client)
    : await query<{ n: string }>(sql, [townName]);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Gasta hasta `n` croquetas de la despensa del town, FIFO. `SKIP LOCKED` es lo que hace que
 * este tick y un `consumeCroqueta` simultáneo no se peleen por la misma fila: quien llega
 * primero se la lleva, el otro sigue con la siguiente. Devuelve cuántas gastó de verdad.
 */
export async function consumeTownCroquetas(townName: string, n: number, client: DbClient): Promise<number> {
  if (n <= 0) return 0;
  const res = await query<{ hash: string }>(
    `UPDATE pow_yield
        SET consumed_at = now()
      WHERE hash IN (
        SELECT y.hash
          FROM pow_yield y
          JOIN player_territory t ON t.player_id = y.owner_id
         WHERE t.town_name = $1 AND y.tier = 'consumable' AND y.consumed_at IS NULL
         ORDER BY y.created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING hash`,
    [townName, n],
    client
  );
  return res.rows.length;
}

export interface CensusResult {
  towns: number;
  fed: number;
  starving: number;
  deaths: number;
  byCause: Record<DeathCause, number>;
}

export interface CensusOptions {
  /** Inyectable para que los tests fijen la vejez en vez de tirar dados. */
  random?: () => number;
  /**
   * Limita el tick a un town. El tick normal (cron) corre sobre todos; esto existe para
   * reprocesar uno suelto tras un incidente, y para que un test pueda observar un town sin
   * que los contadores le mezclen los vecinos.
   */
  townName?: string;
}

async function kill(client: DbClient, id: string, cause: DeathCause, townName: string | null): Promise<void> {
  await query(
    `UPDATE wolkers SET state = 'dead', died_at = now(), death_cause = $2, updated_at = now() WHERE id = $1`,
    [id, cause],
    client
  );
  await recordEvent(client, { wolkerId: id, kind: "death", fromTown: townName, detail: { cause } });
}

/**
 * El tick de censo (1 h real). Fase 0: comer, pasar hambre, morir. Reproducción, moral y
 * emigración llegan en fases 2-3 y se enganchan aquí.
 *
 * Corre town por town en su propia transacción: un town con datos corruptos no puede tumbar
 * el censo del resto, y el tick es reanudable.
 */
export async function censusTick(opts: CensusOptions = {}): Promise<CensusResult> {
  const random = opts.random ?? Math.random;
  const result: CensusResult = {
    towns: 0,
    fed: 0,
    starving: 0,
    deaths: 0,
    byCause: { hunger: 0, combat: 0, raid: 0, age: 0 },
  };

  // Los apátridas (town borrado) entran como un grupo más, sin despensa: pasan hambre igual.
  const groups = opts.townName
    ? await query<{ town_name: string | null }>(
        `SELECT DISTINCT town_name FROM wolkers WHERE state <> 'dead' AND town_name = $1`,
        [opts.townName]
      )
    : await query<{ town_name: string | null }>(
        `SELECT DISTINCT town_name FROM wolkers WHERE state <> 'dead'`
      );

  for (const { town_name: townName } of groups.rows) {
    await withTransaction(async (client) => {
      result.towns++;

      // Los más hambrientos comen primero: con despensa corta, la comida salva vidas en vez
      // de repartirse en migajas entre todos.
      const alive = await query<{ id: string; hunger: number; born_at: Date }>(
        `SELECT id, hunger, born_at
           FROM wolkers
          WHERE state <> 'dead' AND town_name IS NOT DISTINCT FROM $1
          ORDER BY hunger DESC, id ASC
          FOR UPDATE`,
        [townName],
        client
      );
      if (alive.rows.length === 0) return;

      // Sólo comen los que lo necesitan: no se queman croquetas para bajar de 0 a 0.
      const wantFood = alive.rows.filter((w) => w.hunger > 0).length;
      const meals = townName ? await consumeTownCroquetas(townName, wantFood, client) : 0;

      let served = 0;
      const nowMs = Date.now();
      for (const w of alive.rows) {
        let hunger = w.hunger;
        if (hunger > 0 && served < meals) {
          served++;
          hunger = Math.max(0, hunger - FEED_RELIEF);
          await recordEvent(client, { wolkerId: w.id, kind: "fed", fromTown: townName, detail: { hunger } });
          result.fed++;
        } else {
          hunger = Math.min(100, hunger + HUNGER_PER_TICK);
        }

        if (hunger >= 100) {
          await kill(client, w.id, "hunger", townName);
          result.deaths++;
          result.byCause.hunger++;
          continue;
        }

        const ageDays = (nowMs - new Date(w.born_at).getTime()) / 86_400_000;
        if (ageDays > ELDER_DAYS && random() < ELDER_DEATH_P) {
          await kill(client, w.id, "age", townName);
          result.deaths++;
          result.byCause.age++;
          continue;
        }

        await query(`UPDATE wolkers SET hunger = $2, updated_at = now() WHERE id = $1`, [w.id, hunger], client);
        // El aviso se emite al cruzar el umbral, no en cada tick por encima: el HUD y la web
        // muestran "se están muriendo de hambre" una vez, no un torrente de filas iguales.
        if (hunger >= STARVING_AT && w.hunger < STARVING_AT) {
          await recordEvent(client, { wolkerId: w.id, kind: "starving", fromTown: townName, detail: { hunger } });
          result.starving++;
        }
      }
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Puente con el mundo (Fase 1). Luanti no es autoridad sobre el censo: pide el padrón
// para saber a quién encarnar, y devuelve sólo lo que únicamente el mundo sabe — dónde
// está cada uno y quién murió peleando. Cualquier otra cosa que llegue del mundo se
// ignora: un mod comprometido no debe poder inventar población.
// ---------------------------------------------------------------------------

export interface WolkerRosterEntry {
  id: string;
  sign: WolkerSign;
  stage: WolkerStage;
  model: WolkerAppearance["model"];
  vigor: number;
  oficio: number;
  temple: number;
  hunger: number;
  morale: number;
  state: WolkerState;
  home: { x: number; y: number; z: number } | null;
}

/** El padrón vivo de un town, con la apariencia ya resuelta para que el mundo no decida. */
export async function rosterForTown(townName: string, now: Date = new Date()): Promise<WolkerRosterEntry[]> {
  const res = await query<{
    id: string; vigor: number; oficio: number; temple: number; hunger: number;
    morale: number; state: WolkerState; born_at: Date;
    home_x: number | null; home_y: number | null; home_z: number | null;
  }>(
    `SELECT id, vigor, oficio, temple, hunger, morale, state, born_at, home_x, home_y, home_z
       FROM wolkers
      WHERE town_name = $1 AND state <> 'dead'
      ORDER BY id ASC`,
    [townName]
  );
  return res.rows.map((r) => {
    const look = appearanceOf(r.id, new Date(r.born_at), now);
    return {
      id: r.id,
      sign: look.sign,
      stage: look.stage,
      model: look.model,
      vigor: r.vigor,
      oficio: r.oficio,
      temple: r.temple,
      hunger: r.hunger,
      morale: r.morale,
      state: r.state,
      home: r.home_x === null || r.home_y === null || r.home_z === null
        ? null
        : { x: r.home_x, y: r.home_y, z: r.home_z },
    };
  });
}

export interface WorldDelta {
  id: string;
  /** Dónde lo dejó el mundo; se guarda como `home` para que reaparezca donde vivía. */
  pos?: { x: number; y: number; z: number };
  /** Sólo `combat` y `raid`: el hambre y la vejez las decide el censo, no el mundo. */
  died?: "combat" | "raid";
}

export interface WorldDeltaResult {
  moved: number;
  deaths: number;
  ignored: number;
}

/**
 * Aplica lo que el mundo reporta. Dos reglas que valen por todo el endpoint:
 *  - un delta sobre un wolker que no existe, o que ya está muerto, se cuenta como
 *    `ignored` y no crea nada — el mundo no puede dar de alta población;
 *  - las únicas causas de muerte aceptables aquí son las que pasan en el mundo. Si el mod
 *    reporta 'hunger' se descarta: esa muerte la firma el tick de censo o no ocurre.
 */
export async function applyWorldDeltas(deltas: WorldDelta[]): Promise<WorldDeltaResult> {
  const out: WorldDeltaResult = { moved: 0, deaths: 0, ignored: 0 };
  if (deltas.length === 0) return out;

  await withTransaction(async (client) => {
    for (const d of deltas) {
      const cur = await query<{ town_name: string | null }>(
        `SELECT town_name FROM wolkers WHERE id = $1 AND state <> 'dead' FOR UPDATE`,
        [d.id],
        client
      );
      if (cur.rows.length === 0) {
        out.ignored++;
        continue;
      }
      if (d.pos) {
        await query(
          `UPDATE wolkers SET home_x = $2, home_y = $3, home_z = $4, updated_at = now() WHERE id = $1`,
          [d.id, Math.round(d.pos.x), Math.round(d.pos.y), Math.round(d.pos.z)],
          client
        );
        out.moved++;
      }
      if (d.died) {
        await kill(client, d.id, d.died, cur.rows[0]!.town_name);
        out.deaths++;
      }
    }
  });
  return out;
}

export interface TownSituation {
  townName: string;
  population: number;
  larder: number;
  avgHunger: number;
  avgMorale: number;
  starving: number;
  deaths7d: number;
}

/** El resumen que lee el consejo (y el HUD). Un SELECT, no una lectura por wolker. */
export async function townSituation(townName: string): Promise<TownSituation> {
  const res = await query<{ n: string; hunger: string; morale: string; starving: string }>(
    `SELECT count(*)::text AS n,
            COALESCE(avg(hunger), 0)::text AS hunger,
            COALESCE(avg(morale), 0)::text AS morale,
            count(*) FILTER (WHERE hunger >= ${STARVING_AT})::text AS starving
       FROM wolkers WHERE town_name = $1 AND state <> 'dead'`,
    [townName]
  );
  const deaths = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM wolkers
      WHERE town_name = $1 AND state = 'dead' AND died_at > now() - interval '7 days'`,
    [townName]
  );
  const r = res.rows[0]!;
  return {
    townName,
    population: Number(r.n),
    larder: await townLarder(townName),
    avgHunger: Math.round(Number(r.hunger)),
    avgMorale: Math.round(Number(r.morale)),
    starving: Number(r.starving),
    deaths7d: Number(deaths.rows[0]?.n ?? 0),
  };
}
