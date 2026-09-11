import { createHash } from "node:crypto";
import { pool, query, withTransaction, type DbClient, type Sql } from "@/db/pool";
import { autoTickAll, levyTick } from "@/domain/armies";

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

    // La camada se equilibra por construcción: mitad de cada signo. Sin esto, un fundador
    // podía recibir cuatro wolkers del mismo signo —una de cada ocho veces— y quedarse con
    // un pueblo estéril desde el minuto cero sin haber hecho nada mal. Se avanza el nonce
    // hasta llenar los dos cupos, así que sigue siendo determinista desde el homeblock.
    const half = GENESIS_LITTER / 2;
    const chosen: number[] = [];
    let pos = 0, neg = 0;
    for (let nonce = 0; chosen.length < GENESIS_LITTER && nonce < 1000; nonce++) {
      const sign = signOf(wolkerId(seed, seed, nonce));
      if (sign === 1 && pos < half) { pos++; chosen.push(nonce); }
      else if (sign === -1 && neg < half) { neg++; chosen.push(nonce); }
    }

    const ids: string[] = [];
    for (const nonce of chosen) {
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
  births: number;
  emigrated: number;
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
    births: 0,
    emigrated: 0,
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

  // Los destinos posibles se leen una sola vez, fuera del bucle: cada wolker descontento
  // consulta la misma foto del mundo, y así una emigración masiva no cuesta N consultas.
  const targets = await withTransaction((client) => migrationTargets(client));

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

      // Se cría DESPUÉS de comer, y con la despensa ya mermada por la comida de este tick.
      // El orden es la regla: primero se alimenta a quien está vivo, y sólo lo que sobra
      // puede convertirse en un nacimiento. Los apátridas no crían: no hay Hogar donde.
      if (townName) {
        const bred = await breedTick(townName, client, random);
        result.births += bred.births;
      }

      // Y al final, la pregunta política: ¿me quedo? La lista de destinos se calcula una
      // vez por tick y se pasa a todos los towns, en vez de recalcularla por wolker.
      const morale = await moraleTick(townName, client, targets);
      result.emigrated += morale.emigrated;
    });
  }

  // Y por último la leva: el ejército del turno lo paga la gente que sobrevivió a este tick.
  // Va al final a propósito — quien murió de hambre esta hora no recluta a nadie.
  await levyTick();

  // Y con esa leva recién acuñada, las naciones en autopiloto se guarnecen solas. Esto es
  // lo que hace que el mundo siga jugando cuando sus alcaldes no están: la mayoría de la
  // gente quiere mirar una partida viva, no llevarla a mano todos los días.
  if (!opts.townName) await autoTickAll();

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

// ---------------------------------------------------------------------------
// Techo de capacidad y reproducción (Fase 2, WOLKERS_V1.md §4.2-4.3).
//
// Aquí es donde el jugador *pone* población en su nación, y donde se cumple la ley 1: no
// hay comando que cree un wolker. Se construyen camas, se mina comida y se reclama
// territorio; el techo sube y la gente nace sola. Los tres términos son distintos a
// propósito — quien sólo reclama mapa topa en comida, quien sólo mina topa en camas.
// ---------------------------------------------------------------------------

/** Cada cama alberga a dos: una pareja por cama, que es lo que hace crecer un pueblo. */
const PER_BED = 2;
/** Croquetas de despensa semanal que hace falta reservar por habitante. */
const FOOD_PER_HEAD = 3;
/** Habitantes que sostiene cada mapblock reclamado y maduro. */
const PER_BLOCK = 4;
/** Coste en croquetas de un nacimiento. Se paga de la despensa del town, al nacer. */
export const BIRTH_COST = 3;
/** Horas que un progenitor descansa antes de poder volver a tener descendencia. */
const BREED_COOLDOWN_H = 48;
/** Probabilidad base por tick de una pareja elegible. */
const BREED_BASE_P = 0.06;
/** Con más hambre que esto, nadie cría. */
const BREED_MAX_HUNGER = 50;

export interface TownCapacity {
  cap: number;
  beds: number;
  /** El término de cada eje, ya calculado: se enseña en el HUD para que se vea el cuello. */
  byBeds: number;
  byFood: number;
  byBlocks: number;
  bottleneck: "beds" | "food" | "blocks";
  hearth: { x: number; y: number; z: number } | null;
}

/** El mundo empuja lo que sólo él ve: camas construidas y dónde está el Hogar. */
export async function recordTownCapacity(input: {
  townName: string;
  beds: number;
  hearth: { x: number; y: number; z: number } | null;
}): Promise<void> {
  await query(
    `INSERT INTO town_capacity (town_name, beds, hearth_x, hearth_y, hearth_z, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (town_name) DO UPDATE SET
       beds = EXCLUDED.beds,
       hearth_x = EXCLUDED.hearth_x,
       hearth_y = EXCLUDED.hearth_y,
       hearth_z = EXCLUDED.hearth_z,
       updated_at = now()`,
    [input.townName, input.beds, input.hearth?.x ?? null, input.hearth?.y ?? null, input.hearth?.z ?? null]
  );
}

/**
 * El techo: `min(camas × 2, comida ÷ 3, bloques × 4)`. Un town sin fila en `town_capacity`
 * tiene cero camas y por tanto techo cero — la población que ya existe no muere por eso,
 * simplemente no crece hasta que alguien construya. Poner el Hogar y unas camas es
 * literalmente cómo se asienta gente en tu nación.
 */
export async function capacityFor(townName: string, client?: Sql): Promise<TownCapacity> {
  const cap = await query<{ beds: number; hearth_x: number | null; hearth_y: number | null; hearth_z: number | null }>(
    `SELECT beds, hearth_x, hearth_y, hearth_z FROM town_capacity WHERE town_name = $1`,
    [townName],
    client ?? pool
  );
  const blocks = await query<{ block_count: number }>(
    `SELECT block_count FROM town_claims WHERE town_name = $1`,
    [townName],
    client ?? pool
  );
  const larder = await townLarder(townName, client);

  const beds = cap.rows[0]?.beds ?? 0;
  const byBeds = beds * PER_BED;
  const byFood = Math.floor(larder / FOOD_PER_HEAD);
  const byBlocks = (blocks.rows[0]?.block_count ?? 0) * PER_BLOCK;
  const value = Math.min(byBeds, byFood, byBlocks);
  const bottleneck = byBeds === value ? "beds" : byFood === value ? "food" : "blocks";

  const h = cap.rows[0];
  return {
    cap: value,
    beds,
    byBeds,
    byFood,
    byBlocks,
    bottleneck,
    hearth: h && h.hearth_x !== null && h.hearth_y !== null && h.hearth_z !== null
      ? { x: h.hearth_x, y: h.hearth_y, z: h.hearth_z }
      : null,
  };
}

export interface BreedResult {
  births: number;
  /** Qué puerta cerró el paso. Cuando es el techo, se nombra el término que lo fija —
   *  decirle al alcalde "cap" no le dice qué construir; decirle "beds" sí. */
  blockedBy: "beds" | "food" | "blocks" | "hearth" | "pairs" | null;
}

/**
 * Un intento de crianza para un town, dentro del tick de censo y de su transacción.
 *
 * Las cuatro puertas, en orden, y ninguna es opcional:
 *  1. **Hogar.** Sin un sitio donde asentar a la cría, no nace: es la decisión del jugador.
 *  2. **Techo.** Al llenarse, la probabilidad cae a cero — curva logística, no exponencial.
 *  3. **Excedente real.** Se exige despensa para todos los vivos MÁS el coste del parto.
 *     Nunca se alimenta a un recién nacido a costa de matar de hambre a los que ya están.
 *  4. **Pareja elegible.** Dos adultos de signo opuesto, sin cooldown y sin hambre.
 *
 * La comida se debita de la MISMA despensa que comen los Hashimons: cada cría cuesta tres
 * croquetas que alguien minó y que tu criatura no se va a comer.
 */
export async function breedTick(
  townName: string,
  client: DbClient,
  random: () => number = Math.random
): Promise<BreedResult> {
  const capacity = await capacityFor(townName, client);
  if (!capacity.hearth) return { births: 0, blockedBy: "hearth" };

  const alive = await query<{ id: string; hunger: number; born_at: Date; last_bred_at: Date | null }>(
    `SELECT id, hunger, born_at, last_bred_at
       FROM wolkers
      WHERE town_name = $1 AND state = 'alive'
      ORDER BY id ASC`,
    [townName],
    client
  );
  const pop = alive.rows.length;
  if (pop >= capacity.cap) return { births: 0, blockedBy: capacity.bottleneck };

  // Guarda de cinturón: hoy el término de comida del techo ya garantiza este excedente
  // (byFood ≥ pop+1 implica despensa ≥ 3·pop+3), pero la regla que importa es esta y no la
  // aritmética de las constantes: nunca se paga un parto con la comida de los vivos.
  const larder = await townLarder(townName, client);
  if (larder < pop + BIRTH_COST) return { births: 0, blockedBy: "food" };

  const now = Date.now();
  const eligible = alive.rows.filter((w) => {
    if (w.hunger > BREED_MAX_HUNGER) return false;
    const ageDays = (now - new Date(w.born_at).getTime()) / 86_400_000;
    if (ageDays < CHILD_DAYS) return false; // los niños no crían
    if (w.last_bred_at && now - new Date(w.last_bred_at).getTime() < BREED_COOLDOWN_H * 3_600_000) return false;
    return true;
  });

  // El signo por fin significa algo mecánico: hacen falta los dos.
  const males = eligible.filter((w) => signOf(w.id) === 1);
  const females = eligible.filter((w) => signOf(w.id) === -1);
  const pairs = Math.min(males.length, females.length);
  if (pairs === 0) return { births: 0, blockedBy: "pairs" };

  const moraleRes = await query<{ m: string }>(
    `SELECT COALESCE(avg(morale), 0)::text AS m FROM wolkers WHERE town_name = $1 AND state = 'alive'`,
    [townName],
    client
  );
  const morale = Number(moraleRes.rows[0]?.m ?? 0);
  const p = BREED_BASE_P * (1 - pop / capacity.cap) * (morale / 100);

  let births = 0;
  for (let i = 0; i < pairs; i++) {
    if (pop + births >= capacity.cap) break;
    if (random() >= p) continue;

    // El coste se paga ANTES del alta: si la despensa no da, no hay parto — nunca al revés.
    const paid = await consumeTownCroquetas(townName, BIRTH_COST, client);
    if (paid < BIRTH_COST) break;

    const father = males[i]!;
    const mother = females[i]!;
    const nonceRes = await query<{ n: string }>(
      `SELECT (COALESCE(MAX(birth_nonce), -1) + 1)::text AS n FROM wolkers WHERE town_name = $1`,
      [townName],
      client
    );
    const nonce = Number(nonceRes.rows[0]!.n);
    const id = wolkerId(father.id, mother.id, nonce);
    const t = traitsOf(id);
    const inserted = await query<{ id: string }>(
      `INSERT INTO wolkers
         (id, town_name, parent_a, parent_b, birth_nonce, vigor, oficio, temple, home_x, home_y, home_z)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, townName, father.id, mother.id, nonce, t.vigor, t.oficio, t.temple,
       capacity.hearth.x, capacity.hearth.y, capacity.hearth.z],
      client
    );
    // Un id repetido significaría los mismos padres con el mismo nonce: no se fuerza, se
    // deja pasar el turno. Perder un parto es barato; duplicar un linaje no.
    if (inserted.rows.length === 0) continue;

    await query(
      `UPDATE wolkers SET last_bred_at = now(), updated_at = now() WHERE id = ANY($1)`,
      [[father.id, mother.id]],
      client
    );
    await recordEvent(client, {
      wolkerId: id,
      kind: "birth",
      toTown: townName,
      detail: { parents: [father.id, mother.id], cost: BIRTH_COST },
    });
    births++;
  }

  return { births, blockedBy: births === 0 ? "pairs" : null };
}

// ---------------------------------------------------------------------------
// Moral y emigración (Fase 3, WOLKERS_V1.md §5).
//
// Es el único número que el alcalde NO controla con un comando: se gobierna con comida,
// camas, defensa y territorio, o no se gobierna. Y su consecuencia no es una penalización
// abstracta — es que la gente se levanta y se va al pueblo de al lado, andando, a la vista
// de todos. Perder población por gobernar mal es el castigo político del juego.
// ---------------------------------------------------------------------------

/** Por debajo de esto, y dos ticks seguidos, un wolker empieza a hacer las maletas. */
const MORALE_FLEE = 25;
/** Ticks consecutivos de descontento antes de marcharse. Un mal rato no vacía un pueblo. */
const MORALE_FLEE_TICKS = 2;
/** Lo máximo que la moral se mueve en un tick. Evita que un pueblo entero cambie de humor
 *  de golpe por un solo suceso, y hace que recuperarse cueste tanto como hundirse. */
const MORALE_STEP = 10;
/** Radio en nodos dentro del que un emigrante busca destino. No cruza el mundo andando. */
const MIGRATION_RANGE = 600;
/** Cuánto mejor tiene que ser el vecino para justificar el viaje. */
const MIGRATION_EDGE = 1.1;
/** Con la que llega el recién inmigrado: esperanza, no euforia. */
const MORALE_ON_ARRIVAL = 45;

export interface MoraleFactors {
  hunger: number;
  housing: number;
  work: number;
  losses: number;
  target: number;
}

/**
 * La moral que MERECE un town, dada su situación. Cada término es una palanca real que el
 * alcalde puede mover mañana; no hay ningún sumando que dependa de la suerte.
 */
export function moraleTargetFor(input: {
  hunger: number;
  population: number;
  beds: number;
  hasHearth: boolean;
  deaths7d: number;
}): MoraleFactors {
  const hunger = -Math.round(input.hunger / 4);
  // Hacinamiento: una cama por cada dos habitantes es el mínimo para dormir bajo techo.
  const housed = input.beds * 2 >= input.population;
  const housing = housed ? 10 : -15;
  const work = input.hasHearth ? 5 : -5;
  // Cada vecino muerto en la semana pesa, con tope: un pueblo arrasado no baja de cero.
  const losses = -Math.min(30, input.deaths7d * 5);
  const target = Math.max(0, Math.min(100, 50 + hunger + housing + work + losses));
  return { hunger, housing, work, losses, target };
}

interface TownAnchor {
  townName: string;
  home: { x: number; y: number; z: number };
  larder: number;
  population: number;
  avgMorale: number;
  deaths7d: number;
}

/** Los towns candidatos a acoger emigrantes: los que tienen Hogar encendido. Sin Hogar no
 *  hay donde alojar a nadie, así que ni siquiera aparecen en la lista. */
async function migrationTargets(client: DbClient): Promise<TownAnchor[]> {
  const res = await query<{
    town_name: string; hearth_x: number; hearth_y: number; hearth_z: number;
    population: string; morale: string; deaths: string;
  }>(
    `SELECT c.town_name, c.hearth_x, c.hearth_y, c.hearth_z,
            COALESCE(p.n, 0)::text AS population,
            COALESCE(p.morale, 50)::text AS morale,
            COALESCE(d.n, 0)::text AS deaths
       FROM town_capacity c
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, avg(morale) AS morale
           FROM wolkers w WHERE w.town_name = c.town_name AND w.state <> 'dead'
       ) p ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM wolkers w
          WHERE w.town_name = c.town_name AND w.state = 'dead' AND w.died_at > now() - interval '7 days'
       ) d ON true
      WHERE c.hearth_x IS NOT NULL`,
    [],
    client
  );
  const out: TownAnchor[] = [];
  for (const r of res.rows) {
    out.push({
      townName: r.town_name,
      home: { x: r.hearth_x, y: r.hearth_y, z: r.hearth_z },
      larder: await townLarder(r.town_name, client),
      population: Number(r.population),
      avgMorale: Number(r.morale),
      deaths7d: Number(r.deaths),
    });
  }
  return out;
}

/**
 * Lo atractivo que resulta un town visto desde fuera. Comida por cabeza pesa el doble que
 * la moral porque es lo que se puede comprobar sin vivir allí, y las muertes recientes
 * espantan: nadie se muda a un sitio donde están matando gente.
 */
export function attractivenessOf(t: TownAnchor, from: { x: number; y: number; z: number }): number {
  const perCapita = t.population > 0 ? t.larder / t.population : t.larder;
  const dist = Math.sqrt((t.home.x - from.x) ** 2 + (t.home.y - from.y) ** 2 + (t.home.z - from.z) ** 2);
  const risk = t.deaths7d >= 2 ? 1 : 0;
  return perCapita * 2 + t.avgMorale - dist / 200 - risk * 30;
}

export interface MoraleResult {
  emigrated: number;
  discontent: number;
}

/**
 * Recalcula la moral del town y deja marchar a quien lleva dos ticks harto. Corre dentro de
 * la transacción del tick de censo, después de comer y criar: el orden es comer → criar →
 * decidir si te quedas, que es también el orden en que lo pensaría una persona.
 */
export async function moraleTick(
  townName: string | null,
  client: DbClient,
  targets: TownAnchor[]
): Promise<MoraleResult> {
  const out: MoraleResult = { emigrated: 0, discontent: 0 };

  const alive = await query<{ id: string; hunger: number; morale: number; low_morale_ticks: number;
                              home_x: number | null; home_y: number | null; home_z: number | null }>(
    `SELECT id, hunger, morale, low_morale_ticks, home_x, home_y, home_z
       FROM wolkers WHERE state <> 'dead' AND town_name IS NOT DISTINCT FROM $1`,
    [townName],
    client
  );
  if (alive.rows.length === 0) return out;

  const cap = townName ? await capacityFor(townName, client) : null;
  const deaths = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM wolkers
      WHERE town_name IS NOT DISTINCT FROM $1 AND state = 'dead' AND died_at > now() - interval '7 days'`,
    [townName],
    client
  );

  for (const w of alive.rows) {
    // Un apátrida no tiene camas, ni Hogar, ni pueblo: su moral tiende al suelo, y por eso
    // acaba buscando town. Vagar sin patria no es un estado estable.
    const factors = moraleTargetFor({
      hunger: w.hunger,
      population: alive.rows.length,
      beds: cap?.beds ?? 0,
      hasHearth: cap?.hearth != null,
      deaths7d: Number(deaths.rows[0]?.n ?? 0),
    });
    const delta = Math.max(-MORALE_STEP, Math.min(MORALE_STEP, factors.target - w.morale));
    const morale = Math.max(0, Math.min(100, w.morale + delta));
    const low = morale < MORALE_FLEE ? w.low_morale_ticks + 1 : 0;
    if (morale < MORALE_FLEE) out.discontent++;

    if (low < MORALE_FLEE_TICKS) {
      await query(
        `UPDATE wolkers SET morale = $2, low_morale_ticks = $3, updated_at = now() WHERE id = $1`,
        [w.id, morale, low],
        client
      );
      continue;
    }

    // Harto y con dos ticks a cuestas: mira quién vive mejor cerca.
    const from = { x: w.home_x ?? 0, y: w.home_y ?? 0, z: w.home_z ?? 0 };
    const here = targets.find((t) => t.townName === townName);
    const hereScore = here ? attractivenessOf(here, from) : -Infinity;

    let best: TownAnchor | null = null;
    let bestScore = -Infinity;
    for (const t of targets) {
      if (t.townName === townName) continue;
      const d = Math.sqrt((t.home.x - from.x) ** 2 + (t.home.z - from.z) ** 2);
      if (d > MIGRATION_RANGE) continue;
      const score = attractivenessOf(t, from);
      if (score > bestScore) {
        best = t;
        bestScore = score;
      }
    }

    // Sin destino mejor se queda, con la moral por los suelos y el contador corriendo: la
    // gente atrapada en un mal pueblo es un estado real del juego, no un error.
    const worthIt = best && (hereScore === -Infinity ? bestScore > 0 : bestScore > hereScore * MIGRATION_EDGE);
    if (!worthIt || !best) {
      await query(
        `UPDATE wolkers SET morale = $2, low_morale_ticks = $3, updated_at = now() WHERE id = $1`,
        [w.id, morale, low],
        client
      );
      continue;
    }

    await query(
      `UPDATE wolkers
          SET town_name = $2, home_x = $3, home_y = $4, home_z = $5,
              morale = $6, low_morale_ticks = 0, state = 'alive', updated_at = now()
        WHERE id = $1`,
      [w.id, best.townName, best.home.x, best.home.y, best.home.z, MORALE_ON_ARRIVAL],
      client
    );
    // Dos filas por mudanza, no una: el town que pierde gente lo ve en su historial, y el
    // que la gana también. Es la frase "31 se fueron a Nueva Roca" hecha datos.
    await recordEvent(client, { wolkerId: w.id, kind: "emigrate", fromTown: townName, toTown: best.townName });
    await recordEvent(client, { wolkerId: w.id, kind: "immigrate", fromTown: townName, toTown: best.townName });
    out.emigrated++;
  }

  return out;
}
