import { createHash } from "node:crypto";
import { pool, query, withTransaction, type DbClient, type Sql } from "@/db/pool";

// Ejércitos — la capa Risk de Hashimon (docs/ARMIES_V1.md).
//
// El problema de diseño que resuelve este fichero es el de siempre en un juego de mapa:
// **si más territorio diese más ejército y nada más, la partida se decide sola.** El que va
// ganando gana más rápido, y a los demás sólo les queda mirar. Aquí más territorio da más
// fichas, sí, pero también:
//
//   1. **diluye la calidad** — la cohesión cae con la densidad de población por chunk, y
//      todas tus unidades pelean multiplicadas por ella;
//   2. **alarga la frontera** — el perímetro crece más rápido que la guarnición, así que
//      cada chunk de borde queda peor defendido que antes de expandirse.
//
// El resultado es un imperio autolimitado: se puede conquistar más de lo que se puede
// poblar, pero entonces se pelea al 25 % y con la frontera llena de agujeros. Expandirse es
// una apuesta, no una escalera.
//
// Y todo lo que decide una batalla es reproducible: la tirada sale de un hash de las
// entradas, se guarda la semilla, y cualquiera puede recomputarla. El servidor arbitra; no
// es un oráculo.

export type UnitKind = "milicia" | "linea" | "incursores";

export interface UnitSpec {
  kind: UnitKind;
  /** Levas que cuesta reclutar una ficha. */
  cost: number;
  /** Chunks que puede recorrer en un turno. */
  move: number;
  attack: number;
  defense: number;
}

/**
 * Tres fichas y ni una más. Cada una es buena en algo y mala en otra cosa, que es lo que
 * hace que colocarlas sea una decisión y no una suma:
 *  - milicia: barata y terca, defiende bien y casi no se mueve. La red de contención.
 *  - línea: el ejército de verdad, equilibrado y caro de reemplazar.
 *  - incursores: rápidos y frágiles. Toman terreno vacío y mueren si les plantan cara.
 */
export const UNITS: Record<UnitKind, UnitSpec> = {
  milicia:    { kind: "milicia",    cost: 1, move: 1, attack: 1, defense: 3 },
  linea:      { kind: "linea",      cost: 2, move: 2, attack: 3, defense: 3 },
  incursores: { kind: "incursores", cost: 3, move: 4, attack: 4, defense: 1 },
};

/** Habitantes por chunk a partir de los cuales un ejército pelea a pleno rendimiento. */
export const DENSITY_REF = 0.5;
/** Suelo de cohesión: ni el imperio más vacío pelea a cero. */
export const COHESION_FLOOR = 0.25;
/** Ventaja de pelear en tu propio claim: conoces el terreno y tienes dónde apoyarte. */
export const HOME_ADVANTAGE = 0.5;
/** Levas por habitante y día. Sin población no hay ejército: esa es toda la economía. */
export const LEVY_PER_POP_DAY = 1 / 20;
/** Ticks de censo por día (el tick es horario). */
const TICKS_PER_DAY = 24;

export interface Block {
  x: number;
  y: number;
  z: number;
}

/**
 * Cohesión: cuánto rinde de verdad tu ejército. Es población dividida entre chunks, medida
 * contra una densidad de referencia y recortada a [0.25, 1].
 *
 * Un town de 20 chunks con 20 habitantes pelea al 100 %. Ese mismo pueblo, si conquista
 * hasta 200 chunks sin ganar gente, pelea al 25 %: ha multiplicado por diez su territorio
 * para tener un ejército CUATRO VECES peor por ficha. Conquistar sin poblar es perder.
 */
export function cohesionOf(population: number, chunks: number): number {
  if (chunks <= 0) return COHESION_FLOOR;
  const density = population / chunks;
  return Math.min(1, Math.max(COHESION_FLOOR, density / DENSITY_REF));
}

const key = (b: Block) => `${b.x},${b.z}`;

/**
 * Perímetro: chunks del claim con al menos un vecino ortogonal que no es tuyo. Es la
 * longitud real de tu frontera, y crece con la forma del territorio, no sólo con su tamaño
 * — un imperio en tira larga es casi todo frontera; uno compacto casi no lo es.
 *
 * La comparación se hace en el plano X/Z: la frontera de una nación es su contorno en el
 * mapa, no su volumen.
 */
export function perimeterOf(blocks: Block[]): number {
  const owned = new Set(blocks.map(key));
  let perimeter = 0;
  for (const b of blocks) {
    const neighbours = [
      { x: b.x + 1, z: b.z }, { x: b.x - 1, z: b.z },
      { x: b.x, z: b.z + 1 }, { x: b.x, z: b.z - 1 },
    ];
    if (neighbours.some((n) => !owned.has(`${n.x},${n.z}`))) perimeter++;
  }
  return perimeter;
}

/** Distancia en chunks, tipo rey de ajedrez: moverse en diagonal cuesta lo mismo. */
export function chunkDistance(a: Block, b: Block): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

export interface ArmyForce {
  kinds: Record<UnitKind, number>;
}

function powerOf(force: ArmyForce, axis: "attack" | "defense"): number {
  let total = 0;
  for (const k of Object.keys(force.kinds) as UnitKind[]) {
    total += (force.kinds[k] ?? 0) * UNITS[k][axis];
  }
  return total;
}

export interface BattleInput {
  block: Block;
  attacker: string;
  defender: string | null;
  attackForce: ArmyForce;
  defenseForce: ArmyForce;
  attackerCohesion: number;
  defenderCohesion: number;
  /** El chunk pertenece al defensor: ventaja local. */
  onDefenderClaim: boolean;
  /** Discriminante temporal para que dos batallas iguales no tengan la misma semilla. */
  nonce: string;
}

export interface BattleOutcome {
  seed: string;
  roll: number;
  attackPower: number;
  defensePower: number;
  /** Probabilidad de victoria del atacante, la que se enseña ANTES de atacar. */
  odds: number;
  winner: "attacker" | "defender";
  attackerLosses: number;
  defenderLosses: number;
}

/**
 * La batalla. Determinista y auditable: la tirada sale de SHA256 de las entradas, se guarda
 * la semilla, y cualquiera puede recomputar el resultado desde el registro público. Nadie
 * tiene que fiarse de que el servidor no puso el dedo.
 *
 * Nada de "el más fuerte gana": las probabilidades son proporcionales a la fuerza, así que
 * un defensor pequeño y bien plantado puede ganarle a un imperio diluido, y el imperio lo
 * sabe antes de atacar (`odds` se enseña en el panel). Perder duele el doble que ganar —
 * el perdedor deja la mitad de sus fichas, el ganador un cuarto — para que atacar por
 * atacar no salga gratis.
 */
export function resolveBattle(input: BattleInput): BattleOutcome {
  const attackPower = powerOf(input.attackForce, "attack") * input.attackerCohesion;
  const defensePower =
    powerOf(input.defenseForce, "defense") *
    input.defenderCohesion *
    (input.onDefenderClaim ? 1 + HOME_ADVANTAGE : 1);

  const seed = createHash("sha256")
    .update(
      [
        "battle:v1",
        `${input.block.x},${input.block.y},${input.block.z}`,
        input.attacker,
        input.defender ?? "-",
        attackPower.toFixed(3),
        defensePower.toFixed(3),
        input.nonce,
      ].join(":")
    )
    .digest("hex");
  const roll = parseInt(seed.slice(0, 8), 16) / 0x1_0000_0000;

  const total = attackPower + defensePower;
  // Un chunk sin nadie que lo defienda se ocupa, no se pelea.
  const odds = total === 0 ? 1 : attackPower / total;
  const winner = roll < odds ? "attacker" : "defender";

  const attackerUnits = Object.values(input.attackForce.kinds).reduce((a, b) => a + b, 0);
  const defenderUnits = Object.values(input.defenseForce.kinds).reduce((a, b) => a + b, 0);
  const attackerLosses = winner === "attacker" ? Math.ceil(attackerUnits * 0.25) : Math.ceil(attackerUnits * 0.5);
  const defenderLosses = winner === "defender" ? Math.ceil(defenderUnits * 0.25) : Math.ceil(defenderUnits * 0.5);

  return { seed, roll, attackPower, defensePower, odds, winner, attackerLosses, defenderLosses };
}

// --- Estado en la base de datos --------------------------------------------------------

/** Acumula levas para todos los towns. Corre con el tick de censo, después de la población:
 *  el ejército del turno lo paga la gente que sobrevivió a ese turno. */
export async function levyTick(client?: DbClient): Promise<number> {
  const res = await query<{ n: string }>(
    `INSERT INTO army_levies (town_name, stock, updated_at)
     SELECT c.town_name,
            LEAST(COALESCE(p.n, 0) / 2.0, $1 * COALESCE(p.n, 0) / $2),
            now()
       FROM town_claims c
       LEFT JOIN LATERAL (
         SELECT count(*)::numeric AS n FROM wolkers w
          WHERE w.town_name = c.town_name AND w.state <> 'dead'
       ) p ON true
     ON CONFLICT (town_name) DO UPDATE SET
       -- El tope es población ÷ 2: un pueblo no puede guardar más soldados en potencia que
       -- gente tiene. Sin esto, un town abandonado acumularía un ejército eterno.
       stock = LEAST(
         (SELECT count(*)::numeric / 2 FROM wolkers w
           WHERE w.town_name = army_levies.town_name AND w.state <> 'dead'),
         army_levies.stock + EXCLUDED.stock
       ),
       updated_at = now()
     RETURNING town_name AS n`,
    [LEVY_PER_POP_DAY, TICKS_PER_DAY],
    client ?? pool
  );
  return res.rows.length;
}

// --- Turnos ----------------------------------------------------------------------------
//
// Sin turnos, "movilidad 2 chunks" no limita nada: bastaba con pulsar mover cinco veces
// seguidas. El turno es lo que convierte la movilidad en una decisión — cada ficha actúa
// UNA vez por turno, y elegir si ese movimiento lo gasta acercándose o atacando es el juego.
//
// El turno no se guarda ni lo dispara un planificador: se DERIVA del reloj, igual que todo
// lo demás en Hashimon. `turno = floor(epoch / 1h)`. Sin tabla, sin cron, sin estado que se
// pueda desincronizar, y cualquiera puede calcular en qué turno está el mundo.

/** Un turno por hora, alineado con el tick de censo: la leva que entra es la que se puede
 *  gastar ese turno. */
export const TURN_MS = 60 * 60 * 1000;

export function turnOf(at: Date | number): number {
  return Math.floor((at instanceof Date ? at.getTime() : at) / TURN_MS);
}

export function currentTurn(now: number = Date.now()): number {
  return turnOf(now);
}

/** Cuándo empieza el siguiente turno, para que la web pueda enseñar la cuenta atrás. */
export function nextTurnAt(now: number = Date.now()): Date {
  return new Date((turnOf(now) + 1) * TURN_MS);
}

/** Una ficha puede actuar si no ha actuado ya en este turno. Una recién reclutada
 *  (`moved_at` nulo) puede moverse o atacar el mismo turno: en un Risk se coloca refuerzo y
 *  se ataca con él, y hacer esperar un turno al recién llegado sólo añade fricción. */
export function canAct(movedAt: Date | string | null, now: number = Date.now()): boolean {
  if (!movedAt) return true;
  return turnOf(new Date(movedAt)) < turnOf(now);
}

export interface ArmyView {
  town: string;
  /** Qué hace este ejército cuando su alcalde no está. Público: saber que el vecino está en
   *  `expansiva` es información de guerra legítima. */
  doctrine: Doctrine;
  levies: number;
  units: Record<UnitKind, number>;
  total: number;
  cohesion: number;
  perimeter: number;
  /** Fichas defensivas por chunk de frontera. Por debajo de 1, la frontera es un colador. */
  garrisonPerFrontier: number;
  /** Turno en curso y cuándo acaba: la web enseña la cuenta atrás con esto. */
  turn: number;
  nextTurnAt: string;
  /** Fichas que todavía pueden actuar este turno. */
  ready: number;
  /** Dónde están, por chunk y por tipo. Público, y con el desglose a propósito: con él la
   *  web calcula las MISMAS probabilidades que el servidor antes de atacar, así que la
   *  decisión se toma con la información completa y el cálculo se puede contrastar. */
  positions: { x: number; y: number; z: number; units: number; kinds: Record<UnitKind, number> }[];
}

/**
 * Lo que cualquier jugador puede ver de cualquier nación: tamaño, tipos y dónde está.
 * Los ejércitos son públicos a propósito — un Risk donde no ves el tablero no es un Risk,
 * y saber que el vecino tiene tres veces tus fichas es la información que evita guerras.
 */
export async function armyOf(townName: string, client?: Sql): Promise<ArmyView> {
  const sql = client ?? pool;
  const levy = await query<{ stock: string }>(
    `SELECT stock FROM army_levies WHERE town_name = $1`, [townName], sql
  );
  const units = await query<{ kind: UnitKind; bx: number; by: number; bz: number; n: string; ready: string }>(
    `SELECT kind, bx, by, bz, count(*)::text AS n,
            count(*) FILTER (WHERE moved_at IS NULL OR moved_at < $2)::text AS ready
       FROM army_units WHERE town_name = $1
      GROUP BY kind, bx, by, bz`,
    [townName, new Date(currentTurn() * TURN_MS)],
    sql
  );
  const claim = await query<{ blocks: Block[]; block_count: number }>(
    `SELECT blocks, block_count FROM town_claims WHERE town_name = $1`, [townName], sql
  );
  const pop = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM wolkers WHERE town_name = $1 AND state <> 'dead'`, [townName], sql
  );

  const kinds: Record<UnitKind, number> = { milicia: 0, linea: 0, incursores: 0 };
  let ready = 0;
  const byBlock = new Map<string, { x: number; y: number; z: number; units: number; kinds: Record<UnitKind, number> }>();
  let total = 0;
  for (const r of units.rows) {
    const n = Number(r.n);
    kinds[r.kind] += n;
    total += n;
    ready += Number(r.ready);
    const k = `${r.bx},${r.bz}`;
    const cur = byBlock.get(k) ?? { x: r.bx, y: r.by, z: r.bz, units: 0, kinds: { milicia: 0, linea: 0, incursores: 0 } };
    cur.units += n;
    cur.kinds[r.kind] += n;
    byBlock.set(k, cur);
  }

  const rawBlocks = claim.rows[0]?.blocks ?? [];
  const blocks: Block[] = Array.isArray(rawBlocks)
    ? rawBlocks.map((b: unknown) =>
        Array.isArray(b) ? { x: b[0] as number, y: b[1] as number, z: b[2] as number } : (b as Block)
      )
    : [];
  const perimeter = perimeterOf(blocks);
  const defenders = kinds.milicia + kinds.linea;

  const doctrine = await query<{ doctrine: Doctrine }>(
    `SELECT doctrine FROM army_doctrine WHERE town_name = $1`, [townName], sql
  );

  return {
    town: townName,
    doctrine: doctrine.rows[0]?.doctrine ?? DEFAULT_DOCTRINE,
    levies: Number(levy.rows[0]?.stock ?? 0),
    units: kinds,
    total,
    cohesion: cohesionOf(Number(pop.rows[0]?.n ?? 0), claim.rows[0]?.block_count ?? blocks.length),
    perimeter,
    garrisonPerFrontier: perimeter === 0 ? defenders : defenders / perimeter,
    turn: currentTurn(),
    nextTurnAt: nextTurnAt().toISOString(),
    ready,
    positions: [...byBlock.values()],
  };
}

export type MusterError = "no_levies" | "not_your_claim" | "unknown_kind";

/**
 * Recluta una ficha y la coloca. Sólo dentro de tu propio claim: el despliegue inicial es
 * libre —pones tus fichas donde quieras, como en el Risk— pero dentro de tu casa.
 */
export async function muster(
  townName: string,
  kind: UnitKind,
  block: Block
): Promise<{ ok: true; unitId: number } | { ok: false; error: MusterError }> {
  const spec = UNITS[kind];
  if (!spec) return { ok: false, error: "unknown_kind" };

  return withTransaction(async (client) => {
    const owns = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM town_claims
        WHERE town_name = $1 AND blocks @> $2::jsonb`,
      [townName, JSON.stringify([[block.x, block.y, block.z]])],
      client
    );
    if (Number(owns.rows[0]?.n ?? 0) === 0) return { ok: false as const, error: "not_your_claim" as const };

    // El cobro y la comprobación van en el mismo UPDATE: sin ventana entre "tengo levas" y
    // "las gasto", dos reclutamientos simultáneos no pueden pagar con la misma leva.
    const paid = await query<{ stock: string }>(
      `UPDATE army_levies SET stock = stock - $2, spent = spent + $2, updated_at = now()
        WHERE town_name = $1 AND stock >= $2
        RETURNING stock`,
      [townName, spec.cost],
      client
    );
    if (paid.rows.length === 0) return { ok: false as const, error: "no_levies" as const };

    const unit = await query<{ id: number }>(
      `INSERT INTO army_units (town_name, kind, bx, by, bz) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [townName, kind, block.x, block.y, block.z],
      client
    );
    return { ok: true as const, unitId: unit.rows[0]!.id };
  });
}

export type MoveError = "no_unit" | "too_far" | "not_yours" | "already_moved";

/**
 * Mueve una ficha. El límite es su movilidad en chunks, y punto: no hay teletransporte ni
 * "mover todo el ejército" en un clic. Mover a terreno ajeno es lo que empieza una batalla,
 * y por eso el movimiento no la resuelve — `attack` sí.
 */
export async function moveUnit(
  townName: string,
  unitId: number,
  to: Block,
  now: number = Date.now()
): Promise<{ ok: true; from: Block } | { ok: false; error: MoveError }> {
  return withTransaction(async (client) => {
    const cur = await query<{ kind: UnitKind; bx: number; by: number; bz: number; moved_at: Date | null }>(
      `SELECT kind, bx, by, bz, moved_at FROM army_units WHERE id = $1 AND town_name = $2 FOR UPDATE`,
      [unitId, townName],
      client
    );
    const u = cur.rows[0];
    if (!u) return { ok: false as const, error: "no_unit" as const };
    // Una ficha, una acción por turno. El FOR UPDATE de arriba es lo que impide que dos
    // peticiones simultáneas gasten el mismo turno dos veces.
    if (!canAct(u.moved_at, now)) return { ok: false as const, error: "already_moved" as const };

    const from = { x: u.bx, y: u.by, z: u.bz };
    if (chunkDistance(from, to) > UNITS[u.kind].move) {
      return { ok: false as const, error: "too_far" as const };
    }
    await query(
      // Se sella con el instante que decide el turno, no con now() de Postgres: si los dos
      // relojes se separan, el que manda tiene que ser el mismo que valida.
      `UPDATE army_units SET bx = $2, by = $3, bz = $4, moved_at = $5 WHERE id = $1`,
      [unitId, to.x, to.y, to.z, new Date(now)],
      client
    );
    return { ok: true as const, from };
  });
}

export type AttackError = "already_moved";

export interface AttackResult extends BattleOutcome {
  battleId: number;
  defender: string | null;
  /** Wolkers muertos en el chunk por la batalla. La guerra se cobra en gente, no en puntos. */
  civiliansKilled: number;
  /** El chunk queda a la espera de que el mundo aplique el cambio de claim. */
  captured: boolean;
}

async function forceAt(townName: string, block: Block, client: DbClient): Promise<ArmyForce> {
  const res = await query<{ kind: UnitKind; n: string }>(
    `SELECT kind, count(*)::text AS n FROM army_units
      WHERE town_name = $1 AND bx = $2 AND bz = $3 GROUP BY kind`,
    [townName, block.x, block.z],
    client
  );
  const kinds: Record<UnitKind, number> = { milicia: 0, linea: 0, incursores: 0 };
  for (const r of res.rows) kinds[r.kind] = Number(r.n);
  return { kinds };
}

async function cohesionForTown(townName: string, client: DbClient): Promise<number> {
  const res = await query<{ pop: string; blocks: number }>(
    `SELECT (SELECT count(*) FROM wolkers w WHERE w.town_name = $1 AND w.state <> 'dead')::text AS pop,
            COALESCE((SELECT block_count FROM town_claims WHERE town_name = $1), 0) AS blocks`,
    [townName],
    client
  );
  return cohesionOf(Number(res.rows[0]?.pop ?? 0), res.rows[0]?.blocks ?? 0);
}

/** Retira `n` fichas de un town en un chunk, las más caras primero: perder una guerra cuesta
 *  tus mejores tropas, no las que te sobraban. */
async function takeLosses(townName: string, block: Block, n: number, client: DbClient): Promise<number> {
  if (n <= 0) return 0;
  const res = await query<{ id: number }>(
    `DELETE FROM army_units WHERE id IN (
       SELECT id FROM army_units
        WHERE town_name = $1 AND bx = $2 AND bz = $3
        ORDER BY CASE kind WHEN 'incursores' THEN 0 WHEN 'linea' THEN 1 ELSE 2 END
        LIMIT $4
     ) RETURNING id`,
    [townName, block.x, block.z, n],
    client
  );
  return res.rows.length;
}

/**
 * Ataca un chunk. Resuelve la batalla, cobra las bajas de los dos lados, mata a los wolkers
 * que vivían allí si cae la defensa, y —si el atacante gana— encola la toma del claim en
 * `town_actions`, que es el canal que el mundo ya sabe aplicar. El servidor no reescribe el
 * mapa de Towny por su cuenta: lo propone, y Luanti lo valida.
 */
export async function attack(
  attacker: string,
  block: Block,
  nonce: string = new Date().toISOString(),
  now: number = Date.now()
): Promise<AttackResult | { error: AttackError }> {
  return withTransaction(async (client) => {
    // Atacar ES la acción del turno de esas fichas. Sin esta puerta, un ejército podía
    // atacar el mismo chunk una y otra vez hasta que la moneda saliera bien — y entonces
    // las probabilidades no significan nada.
    const turnStart = new Date(turnOf(now) * TURN_MS);
    const fresh = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM army_units
        WHERE town_name = $1 AND bx = $2 AND bz = $3
          AND (moved_at IS NULL OR moved_at < $4)`,
      [attacker, block.x, block.z, turnStart],
      client
    );
    if (Number(fresh.rows[0]?.n ?? 0) === 0) return { error: "already_moved" as const };

    const owner = await query<{ town_name: string }>(
      `SELECT town_name FROM town_claims WHERE blocks @> $1::jsonb LIMIT 1`,
      [JSON.stringify([[block.x, block.y, block.z]])],
      client
    );
    const defender = owner.rows[0]?.town_name ?? null;

    const attackForce = await forceAt(attacker, block, client);
    const defenseForce = defender ? await forceAt(defender, block, client) : { kinds: { milicia: 0, linea: 0, incursores: 0 } };

    const outcome = resolveBattle({
      block,
      attacker,
      defender,
      attackForce,
      defenseForce,
      attackerCohesion: await cohesionForTown(attacker, client),
      defenderCohesion: defender ? await cohesionForTown(defender, client) : 1,
      onDefenderClaim: defender !== null,
      nonce,
    });

    // Todas las fichas que participan gastan su turno, ganen o pierdan.
    await query(
      `UPDATE army_units SET moved_at = $4 WHERE town_name = $1 AND bx = $2 AND bz = $3`,
      [attacker, block.x, block.z, new Date(now)],
      client
    );

    await takeLosses(attacker, block, outcome.attackerLosses, client);
    if (defender) await takeLosses(defender, block, outcome.defenderLosses, client);

    // La población del chunk paga la guerra: un wolker por ficha defensora perdida.
    let civiliansKilled = 0;
    if (defender && outcome.winner === "attacker") {
      const dead = await query<{ id: string }>(
        `UPDATE wolkers SET state = 'dead', died_at = now(), death_cause = 'raid', updated_at = now()
          WHERE id IN (
            SELECT id FROM wolkers
             WHERE town_name = $1 AND state <> 'dead'
               AND home_x >= $2 AND home_x < $2 + 16
               AND home_z >= $3 AND home_z < $3 + 16
             LIMIT $4
          ) RETURNING id`,
        [defender, block.x * 16, block.z * 16, Math.max(1, outcome.defenderLosses)],
        client
      );
      civiliansKilled = dead.rows.length;
      for (const r of dead.rows) {
        await query(
          `INSERT INTO wolker_events (wolker_id, kind, from_town, detail)
           VALUES ($1, 'death', $2, $3)`,
          [r.id, defender, JSON.stringify({ cause: "raid", battle: true })],
          client
        );
      }
    }

    const saved = await query<{ id: number }>(
      `INSERT INTO battles (bx, by, bz, attacker, defender, seed, roll, attack_power, defense_power, winner, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [block.x, block.y, block.z, attacker, defender, outcome.seed, outcome.roll,
       outcome.attackPower, outcome.defensePower, outcome.winner,
       JSON.stringify({ attackForce, defenseForce, odds: outcome.odds, civiliansKilled })],
      client
    );

    const captured = outcome.winner === "attacker";
    if (captured) {
      await query(
        `INSERT INTO town_actions (town_name, actor, target, op, rank, detail)
         VALUES ($1, $2, $3, 'war_claim', '', $4)`,
        [attacker, "war", `${block.x},${block.y},${block.z}`, `battle:${saved.rows[0]!.id}`],
        client
      );
    }

    return { ...outcome, battleId: saved.rows[0]!.id, defender, civiliansKilled, captured };
  });
}

// ---------------------------------------------------------------------------
// Doctrina — lo que tu ejército hace cuando no estás.
//
// La mayoría de la gente no quiere jugar a un Risk todos los días: quiere que su nación
// siga viva mientras mira. Por eso el valor por defecto es `defensiva` y no `manual` — una
// nación cuyo alcalde no ha entrado en una semana se sigue guarneciendo sola, y el jugador
// que sí quiere jugar simplemente pone `manual` y manda a mano.
//
// **La autopiloto nunca ataca el claim de otra nación.** Recluta, se reposiciona y ocupa
// tierra de nadie; declarar una guerra sigue siendo una decisión humana. Un juego que le
// declara la guerra a tu vecino mientras duermes no te está entreteniendo: te está
// metiendo en un lío que no elegiste.
//
// Y es todo reglas: cero llamadas a modelo, cero azar. Corre en el mismo tick que el censo.
// ---------------------------------------------------------------------------

export type Doctrine = "manual" | "defensiva" | "equilibrada" | "expansiva";

export const DEFAULT_DOCTRINE: Doctrine = "defensiva";

/** Guarnición por chunk de frontera a la que apunta cada doctrina antes de gastar en otra
 *  cosa. Por debajo de 1 la frontera es un colador, así que ninguna baja de ahí. */
const GARRISON_TARGET: Record<Exclude<Doctrine, "manual">, number> = {
  defensiva: 2,
  equilibrada: 1,
  expansiva: 1,
};

export async function getDoctrine(townName: string, client?: Sql): Promise<Doctrine> {
  const res = await query<{ doctrine: Doctrine }>(
    `SELECT doctrine FROM army_doctrine WHERE town_name = $1`,
    [townName],
    client ?? pool
  );
  return res.rows[0]?.doctrine ?? DEFAULT_DOCTRINE;
}

export async function setDoctrine(townName: string, doctrine: Doctrine): Promise<void> {
  await query(
    `INSERT INTO army_doctrine (town_name, doctrine, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (town_name) DO UPDATE SET doctrine = EXCLUDED.doctrine, updated_at = now()`,
    [townName, doctrine]
  );
}

/** Los chunks del claim que tocan tierra ajena o vacía: donde hay que estar. */
export function frontierBlocks(blocks: Block[]): Block[] {
  const owned = new Set(blocks.map(key));
  return blocks.filter((b) =>
    [
      { x: b.x + 1, z: b.z }, { x: b.x - 1, z: b.z },
      { x: b.x, z: b.z + 1 }, { x: b.x, z: b.z - 1 },
    ].some((n) => !owned.has(`${n.x},${n.z}`))
  );
}

/** Un paso hacia el destino, sin pasarse de la movilidad de la ficha. Movimiento de rey:
 *  la diagonal cuesta lo mismo, así que se acerca en los dos ejes a la vez. */
export function stepToward(from: Block, to: Block, move: number): Block {
  const clamp = (d: number) => Math.max(-move, Math.min(move, d));
  return { x: from.x + clamp(to.x - from.x), y: from.y, z: from.z + clamp(to.z - from.z) };
}

export interface AutoResult {
  town: string;
  doctrine: Doctrine;
  recruited: number;
  moved: number;
  occupied: number;
}

function blocksOf(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b: unknown) =>
    Array.isArray(b) ? { x: b[0] as number, y: b[1] as number, z: b[2] as number } : (b as Block)
  );
}

/**
 * Un turno de autopiloto para un town. Tres pasos, en este orden, y el orden es la doctrina:
 *
 *  1. **Guarnecer.** Reclutar hasta llegar a la guarnición objetivo por chunk de frontera.
 *     Primero se tapa el agujero; sólo lo que sobra se gasta en otra cosa.
 *  2. **Reposicionar.** Las fichas del interior caminan hacia el chunk de frontera peor
 *     defendido. Un ejército en el centro del mapa no defiende nada.
 *  3. **Ocupar** (sólo `expansiva`). Los incursores entran en tierra de nadie adyacente.
 *     Nunca en el claim de otro: eso es una guerra, y la declara una persona.
 */
export async function autoTick(townName: string): Promise<AutoResult> {
  const doctrine = await getDoctrine(townName);
  const result: AutoResult = { town: townName, doctrine, recruited: 0, moved: 0, occupied: 0 };
  if (doctrine === "manual") return result;

  const claim = await query<{ blocks: unknown }>(
    `SELECT blocks FROM town_claims WHERE town_name = $1`, [townName]
  );
  const blocks = blocksOf(claim.rows[0]?.blocks);
  if (blocks.length === 0) return result;

  const frontier = frontierBlocks(blocks);
  if (frontier.length === 0) return result;

  // --- 1. Guarnecer ---------------------------------------------------------------
  const view = await armyOf(townName);
  const defenders = view.units.milicia + view.units.linea;
  const target = Math.ceil(GARRISON_TARGET[doctrine] * frontier.length);

  // Se recluta en el chunk de frontera con menos fichas: el refuerzo va donde falta, no
  // donde ya hay. Y se recalcula el hueco en cada vuelta, así que reparte en vez de apilar.
  const unitsAt = new Map<string, number>();
  for (const p of view.positions) unitsAt.set(`${p.x},${p.z}`, p.units);

  let levies = view.levies;
  let placed = defenders;
  const recruitKind: UnitKind = doctrine === "expansiva" ? "linea" : "milicia";
  while (placed < target && levies >= UNITS[recruitKind].cost) {
    const thinnest = frontier.reduce((a, b) =>
      (unitsAt.get(`${a.x},${a.z}`) ?? 0) <= (unitsAt.get(`${b.x},${b.z}`) ?? 0) ? a : b
    );
    const out = await muster(townName, recruitKind, thinnest);
    if (!out.ok) break;
    unitsAt.set(`${thinnest.x},${thinnest.z}`, (unitsAt.get(`${thinnest.x},${thinnest.z}`) ?? 0) + 1);
    levies -= UNITS[recruitKind].cost;
    placed++;
    result.recruited++;
  }

  // Con la frontera cubierta, la expansiva se guarda incursores para el paso 3.
  if (doctrine === "expansiva" && levies >= UNITS.incursores.cost) {
    const out = await muster(townName, "incursores", frontier[0]!);
    if (out.ok) result.recruited++;
  }

  // --- 2. Reposicionar ------------------------------------------------------------
  const frontierKeys = new Set(frontier.map(key));
  const units = await query<{ id: number; kind: UnitKind; bx: number; by: number; bz: number }>(
    `SELECT id, kind, bx, by, bz FROM army_units WHERE town_name = $1`, [townName]
  );
  for (const u of units.rows) {
    const at = { x: u.bx, y: u.by, z: u.bz };
    if (frontierKeys.has(key(at))) continue; // ya está donde tiene que estar

    const dest = frontier.reduce((a, b) => {
      const ua = unitsAt.get(`${a.x},${a.z}`) ?? 0;
      const ub = unitsAt.get(`${b.x},${b.z}`) ?? 0;
      if (ua !== ub) return ua < ub ? a : b;
      return chunkDistance(at, a) <= chunkDistance(at, b) ? a : b;
    });
    const step = stepToward(at, dest, UNITS[u.kind].move);
    if (step.x === at.x && step.z === at.z) continue;
    const moved = await moveUnit(townName, u.id, step);
    if (moved.ok) {
      unitsAt.set(`${step.x},${step.z}`, (unitsAt.get(`${step.x},${step.z}`) ?? 0) + 1);
      result.moved++;
    }
  }

  // --- 3. Ocupar tierra de nadie (sólo expansiva) ----------------------------------
  if (doctrine !== "expansiva") return result;

  const owned = new Set(blocks.map(key));
  const raiders = await query<{ id: number; bx: number; by: number; bz: number }>(
    `SELECT id, bx, by, bz FROM army_units WHERE town_name = $1 AND kind = 'incursores'`,
    [townName]
  );
  for (const r of raiders.rows) {
    const at = { x: r.bx, y: r.by, z: r.bz };
    const candidates = [
      { x: at.x + 1, y: at.y, z: at.z }, { x: at.x - 1, y: at.y, z: at.z },
      { x: at.x, y: at.y, z: at.z + 1 }, { x: at.x, y: at.y, z: at.z - 1 },
    ].filter((c) => !owned.has(key(c)));

    for (const c of candidates) {
      // La frontera del autopiloto: si el chunk tiene dueño, se para aquí. Ocupar lo vacío
      // es expandirse; entrar en casa de otro es una guerra, y esa la declara una persona.
      const other = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM town_claims WHERE blocks @> $1::jsonb`,
        [JSON.stringify([[c.x, c.y, c.z]])]
      );
      if (Number(other.rows[0]?.n ?? 0) > 0) continue;

      const moved = await moveUnit(townName, r.id, c);
      if (!moved.ok) continue;
      const battle = await attack(townName, c, `auto:${townName}:${new Date().toISOString().slice(0, 13)}`);
      // La ficha ya había gastado su turno moviéndose: el autopiloto lo respeta como
      // cualquier jugador, así que a veces la ocupación cae en el turno siguiente.
      if ("captured" in battle && battle.captured) result.occupied++;
      break;
    }
  }

  return result;
}

/** Un turno de autopiloto para todas las naciones que no están en `manual`. */
export async function autoTickAll(): Promise<AutoResult[]> {
  const towns = await query<{ town_name: string }>(`SELECT town_name FROM town_claims`);
  const out: AutoResult[] = [];
  for (const t of towns.rows) {
    try {
      const r = await autoTick(t.town_name);
      if (r.recruited || r.moved || r.occupied) out.push(r);
    } catch (err) {
      // Una nación con datos raros no puede parar el turno de las demás. El autopiloto es
      // un servicio de fondo: falla callado por nación, nunca en bloque.
      out.push({ town: t.town_name, doctrine: "manual", recruited: 0, moved: 0, occupied: 0 });
      void err;
    }
  }
  return out;
}
