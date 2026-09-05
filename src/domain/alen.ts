import { query } from "@/db/pool";

// Alen Gregory — el villano único. Este módulo es el lado servidor del canal de
// órdenes: encola planes, los sirve al mundo, recoge el ack y guarda la
// proyección de estado más el registro de novedades.
//
// La doctrina es la de town_actions y no cambia: **el servidor pide, el mundo
// decide**. Nada de aquí es autoridad sobre la partida. Si el mundo rechaza un
// plan, su motivo vuelve en `detail` y es lo único que hace mejorable al
// planificador.

/** Los únicos verbos que el mundo sabe ejecutar. Se valida aquí ADEMÁS de en Lua:
 *  no porque no confiemos en el mundo, sino para que un plan imposible muera en
 *  la cola y no gaste un ciclo de poll. La lista de Lua sigue siendo la que manda. */
export const ALEN_VERBS = [
  "goto",
  "patrol_area",
  "hunt",
  "blockjump",
  "wait",
  "say",
] as const;

export type AlenVerb = (typeof ALEN_VERBS)[number];

export interface AlenPlan {
  ttl?: number;
  verbs: Array<{ op: AlenVerb; [k: string]: unknown }>;
}

export interface AlenOrderRow {
  id: number;
  plan: AlenPlan;
  source: string;
  reason: string | null;
}

export interface AlenStateRow {
  alive: boolean;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  hp: number;
  max_hp: number;
  mood: string | null;
  observed: boolean;
  digest: unknown;
  updated_at: string;
}

/** Encola un plan para que el mundo lo recoja en su siguiente poll. */
export async function enqueueOrder(input: {
  plan: AlenPlan;
  source?: string;
  reason?: string;
}): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO alen_orders (plan, source, reason) VALUES ($1, $2, $3) RETURNING id`,
    [JSON.stringify(input.plan), input.source ?? "admin", input.reason ?? null]
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error("alen_order_insert_returned_nothing");
  }
  return row.id;
}

/** Lo que el mundo se lleva en cada poll. Deliberadamente pocas: un plan largo en
 *  vuelo es peor que dos cortos, porque el mundo no puede renegociar a mitad. */
export async function listPendingOrders(limit = 5): Promise<AlenOrderRow[]> {
  const res = await query<AlenOrderRow>(
    `SELECT id, plan, source, reason
       FROM alen_orders
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** Cierra una orden con el veredicto del mundo. `detail` es el motivo exacto
 *  ("jugador_cerca:diego", "verbo_no_permitido:rm_rf") y es la única realimentación
 *  que recibe el planificador. */
export async function resolveOrder(
  id: number,
  result: "applied" | "rejected",
  detail?: string
): Promise<void> {
  await query(
    `UPDATE alen_orders SET status = $2, detail = $3, applied_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [id, result, detail ?? null]
  );
}

/** La proyección de estado que sube el mundo. Una fila, siempre la misma. */
export async function saveState(input: {
  alive: boolean;
  pos?: { x: number; y: number; z: number } | null;
  hp: number;
  maxHp: number;
  mood?: string | null;
  observed: boolean;
  digest?: unknown;
}): Promise<void> {
  await query(
    `INSERT INTO alen_state (id, alive, pos_x, pos_y, pos_z, hp, max_hp, mood, observed, digest, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (id) DO UPDATE SET
       alive = EXCLUDED.alive, pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y,
       pos_z = EXCLUDED.pos_z, hp = EXCLUDED.hp, max_hp = EXCLUDED.max_hp,
       mood = EXCLUDED.mood, observed = EXCLUDED.observed,
       digest = EXCLUDED.digest, updated_at = now()`,
    [
      input.alive,
      input.pos?.x ?? null,
      input.pos?.y ?? null,
      input.pos?.z ?? null,
      input.hp,
      input.maxHp,
      input.mood ?? null,
      input.observed,
      input.digest === undefined ? null : JSON.stringify(input.digest),
    ]
  );
}

export async function getState(): Promise<AlenStateRow | null> {
  const res = await query<AlenStateRow>(
    `SELECT alive, pos_x, pos_y, pos_z, hp, max_hp, mood, observed, digest, updated_at
       FROM alen_state WHERE id = 1`
  );
  return res.rows[0] ?? null;
}

/** Registra una novedad. El planificador se despierta por ESTO y no por un reloj:
 *  un dragón dando vueltas sobre un bosque vacío no genera eventos y por tanto no
 *  cuesta un solo token. El ritmo de esta tabla ES la factura. */
export async function recordEvent(input: {
  kind: string;
  actor?: string | null;
  payload?: unknown;
}): Promise<void> {
  await query(
    `INSERT INTO alen_events (kind, actor, payload) VALUES ($1, $2, $3)`,
    [input.kind, input.actor ?? null, input.payload === undefined ? null : JSON.stringify(input.payload)]
  );
}

export interface AlenEventRow {
  id: number;
  kind: string;
  actor: string | null;
  payload: unknown;
  created_at: string;
}

/** Novedades sin consumir, para quien vaya a planificar. */
export async function listUnconsumedEvents(limit = 20): Promise<AlenEventRow[]> {
  const res = await query<AlenEventRow>(
    `SELECT id, kind, actor, payload, created_at
       FROM alen_events WHERE consumed = false
      ORDER BY id ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

export async function consumeEvents(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await query(`UPDATE alen_events SET consumed = true WHERE id = ANY($1::bigint[])`, [ids]);
}
