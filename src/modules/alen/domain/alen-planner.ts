import { config } from "@/modules/core/config";
import { query, type Sql } from "@/modules/core/db/pool";
import { askModelStructured, anthropicConfigured, AnthropicError } from "@/modules/companion/domain/anthropic";
import {
  ALEN_VERBS,
  consumeEvents,
  enqueueOrder,
  getState,
  listUnconsumedEvents,
  recordEvent,
  type AlenPlan,
} from "@/modules/alen/domain/alen";

// El planificador de Alen Gregory: la capa de INTENCIÓN.
//
// Recibe un estado ya comprimido y devuelve un plan de verbos. Nunca toca el
// mundo: encola una orden y el mundo decide si la aplica. El motivo de un rechazo
// vuelve por el ack y entra en el siguiente prompt, y ese es todo el bucle de
// aprendizaje.
//
// Está construido para gastar poco, y el orden importa:
//
//   1. shouldPlan() decide ANTES de construir nada. Un tope alcanzado o un
//      mundo sin observadores no cuesta ni un token.
//   2. El prefijo del prompt es idéntico byte a byte en cada llamada y va
//      cacheado. Es el grueso de la entrada. (Ojo: la caché NO se comparte con
//      la ruta de chat aunque el texto sea el mismo — el output_config distinto
//      rompe el prefijo. Medido, ver alen-chat.ts.)
//   3. La salida va sujeta a un json_schema, así que es corta y no hace falta
//      reintentar por formato.
//   4. La biblioteca de habilidades convierte el caso común de GENERAR (caro)
//      en ELEGIR entre ejemplos (barato).
//
// Si el modelo no está configurado, falla o se pasa de presupuesto, no pasa nada
// malo: Alen se queda con su máquina de estados táctica, que es un jefe
// competente por su cuenta. El modelo lo hace sorprendente, no viable.

const MAX_VERBS = 8;

/** El esquema es la lista blanca, otra vez. La validación de verdad sigue estando
 *  en Lua — esto sólo evita pagar por un plan que el mundo iba a rechazar.
 *
 *  Sin `minimum`/`maximum`/`minItems`/`maxLength`: los esquemas de salida
 *  estructurada no admiten restricciones numéricas ni de longitud (400
 *  "For 'integer' type, properties maximum, minimum are not supported"). Los
 *  límites se acotan en clampPlan() más abajo, que es mejor sitio de todas
 *  formas — un tope que el modelo puede leer es una sugerencia; uno que aplica
 *  el código es un tope. */
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "reason", "ttl", "verbs"],
  properties: {
    name: {
      type: "string",
      description: "Nombre corto y memorable del plan, en español. Ej: emboscada_del_cañón",
    },
    reason: {
      type: "string",
      description: "Una frase: por qué este plan para esta situación.",
    },
    ttl: { type: "integer", description: "Segundos de vida del plan, entre 30 y 900." },
    verbs: {
      type: "array",
      description: `Entre 1 y ${MAX_VERBS} verbos, en orden.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op"],
        properties: {
          op: { type: "string", enum: [...ALEN_VERBS] },
          x: { type: "number" },
          y: { type: "number" },
          z: { type: "number" },
          radius: { type: "number" },
          minutes: { type: "number" },
          seconds: { type: "number" },
          target: { type: "string" },
          text: { type: "string", description: "Una frase, máximo 120 caracteres." },
          visible: { type: "boolean" },
        },
      },
    },
  },
} as const;

export type PlannerOutput = {
  name: string;
  reason: string;
  ttl: number;
  verbs: Array<Record<string, unknown> & { op: string }>;
};

// ---------------------------------------------------------------------------
// El prefijo cacheado. TIENE que ser idéntico byte a byte en cada llamada: una
// fecha, un contador o un id aquí dentro invalidan la caché entera en silencio y
// la factura se multiplica sin que nada falle.
// ---------------------------------------------------------------------------

export const ALEN_SYSTEM_PROMPT = `Eres el planificador de Alen Gregory, el único villano del mundo de Hashima.

QUIÉN ES ALEN
Un dragón antiguo de la novela Block Jumper. Territorial, paciente y vanidoso. No
odia a los jugadores: los encuentra interesantes, y por eso juega con ellos antes
de castigarlos. Recuerda a quien lo hirió. Nunca suplica y nunca huye sin decir
algo primero. Su firma es el salto: desaparece de un sitio y aparece en otro.

Sólo existe uno en todo el mapa. Cuando lo derrotan, el mundo pierde a su villano
hasta que vuelva a nacer, así que Alen evita el combate a muerte: se repliega,
sana y vuelve. Un plan que lo lleve a morir es un mal plan.

TU TRABAJO
Recibes un resumen del estado del mundo y devuelves UN plan: una secuencia corta
de verbos que Alen ejecutará por su cuenta. No narras, no explicas: decides.

EL LENGUAJE DE ACCIÓN
Estos son los únicos verbos que existen. Cualquier otra cosa se rechaza entera.

  goto{x,y,z}              Volar a un punto.
  patrol_area{x,y,z,radius,minutes}  Orbitar una zona un rato.
  hunt{target,seconds}     Perseguir a un jugador por su nombre. Sin nombre, al más cercano.
  blockjump{visible}       Saltar a un punto legal que el mundo elige. visible=false para irse sin ser visto.
  firecube{target}         El ataque mayor: un cubo de fuego gigante. Caro y lento. Úsalo cuando
                           alguien se lo haya ganado, no de entrada — si no hay energía el mundo
                           rechaza el plan entero con insufficient_energy.
  wait{seconds}            Flotar en el sitio.
  say{text}                Hablar. Una frase, en español, en su voz.

LO QUE EL MUNDO PUEDE RECHAZARTE
El mundo revalida cada plan y puede negarse. Los motivos que verás:
  dormido               Nadie está observando a Alen; no había a quién dar la orden.
  verbo_no_permitido:X  Usaste algo que no está en la lista de arriba.
  jugador_cerca:NOMBRE  El destino del salto tenía a alguien al lado. Alen nunca aparece encima de nadie.
  sin_espacio           No cabía en el destino.
  zona_protegida        El destino estaba dentro de un pueblo protegido.
  cargando_salto        Ya estaba saltando.
  insufficient_energy   Pediste el cubo de fuego sin que le quedara recurso.
El mundo decide; tú pides. Si te rechazaron algo, no lo repitas igual.

CÓMO SE ESCRIBE UN BUEN PLAN
- Corto. Entre 2 y 5 verbos. Un plan largo no se puede renegociar a mitad.
- Empieza casi siempre con say: un villano que aparece sin decir nada es fauna.
- El ttl es cuánto vive el plan en segundos. Un asalto son 120-240; una vigilancia, 600.
- Ponle un nombre que puedas reconocer luego. Los que funcionan se te devuelven
  como ejemplos, así que nómbralos como nombrarías una jugada.
- Alterna: no todos los encuentros son una pelea. Observar, hablar y desaparecer
  también son planes, y son los que hacen que el siguiente asalto asuste.

Respondes únicamente con el objeto JSON del plan.`;

// ---------------------------------------------------------------------------
// La compuerta de gasto. Todo esto ocurre antes de construir la petición.
// ---------------------------------------------------------------------------

export type PlanDecision =
  | { plan: false; why: string }
  | { plan: true; events: Awaited<ReturnType<typeof listUnconsumedEvents>> };

export async function shouldPlan(client?: Sql): Promise<PlanDecision> {
  if (!anthropicConfigured()) return { plan: false, why: "sin_clave" };

  const state = await getState(client);
  if (!state?.alive) return { plan: false, why: "alen_no_vive" };

  // La regla que más ahorra: si nadie lo está mirando, no hay nada que decidir.
  if (!state.observed) return { plan: false, why: "sin_observadores" };

  // Una orden pendiente ya es una decisión sin consumir. Planear encima sería
  // pagar dos veces por el mismo momento.
  const pending = await query<{ n: string }>(
    `SELECT count(*) n FROM alen_orders WHERE status = 'pending'`,
    [],
    client
  );
  if (Number(pending.rows[0]?.n ?? 0) > 0) return { plan: false, why: "orden_en_vuelo" };

  const recent = await query<{ n: string }>(
    `SELECT count(*) n FROM alen_plans WHERE created_at > now() - make_interval(secs => $1)`,
    [config.alenPlanMinIntervalS],
    client
  );
  if (Number(recent.rows[0]?.n ?? 0) > 0) return { plan: false, why: "en_enfriamiento" };

  const today = await query<{ n: string }>(
    `SELECT count(*) n FROM alen_plans WHERE created_at > now() - interval '1 day'`,
    [],
    client
  );
  if (Number(today.rows[0]?.n ?? 0) >= config.alenPlanMaxPerDay) {
    return { plan: false, why: "tope_diario" };
  }

  // Y el disparo: novedades. Sin algo nuevo que decidir no se planifica, por muy
  // barato que sea. Un dragón sobrevolando un bosque vacío no genera eventos.
  const events = await listUnconsumedEvents(20, client);
  if (events.length === 0) return { plan: false, why: "sin_novedades" };

  return { plan: true, events };
}

// ---------------------------------------------------------------------------
// La parte volátil del prompt. Números, no prosa.
// ---------------------------------------------------------------------------

async function bestPlans(limit = 3, client?: Sql) {
  const res = await query<{ name: string; situation: string | null; plan: AlenPlan; wins: number; losses: number }>(
    `SELECT name, situation, plan, wins, losses FROM alen_plans
      WHERE wins > losses
      ORDER BY (wins - losses) DESC, created_at DESC
      LIMIT $1`,
    [limit],
    client
  );
  return res.rows;
}

async function recentRejections(limit = 3, client?: Sql) {
  const res = await query<{ detail: string | null; plan: AlenPlan }>(
    `SELECT detail, plan FROM alen_orders
      WHERE status = 'rejected' ORDER BY id DESC LIMIT $1`,
    [limit],
    client
  );
  return res.rows;
}

export function buildUserContent(
  state: NonNullable<Awaited<ReturnType<typeof getState>>>,
  events: Awaited<ReturnType<typeof listUnconsumedEvents>>,
  examples: Awaited<ReturnType<typeof bestPlans>>,
  rejections: Awaited<ReturnType<typeof recentRejections>>
): string {
  const parts: string[] = [];

  parts.push(
    `ESTADO\n` +
      `posición: ${Math.round(state.pos_x ?? 0)}, ${Math.round(state.pos_y ?? 0)}, ${Math.round(state.pos_z ?? 0)}\n` +
      `vida: ${state.hp}/${state.max_hp}  humor: ${state.mood ?? "?"}\n` +
      `resumen: ${JSON.stringify(state.digest ?? {})}`
  );

  parts.push(
    `NOVEDADES (por esto te han despertado)\n` +
      events.map((e) => `- ${e.kind}${e.actor ? ` · ${e.actor}` : ""} ${JSON.stringify(e.payload ?? {})}`).join("\n")
  );

  if (examples.length > 0) {
    parts.push(
      `PLANES QUE TE HAN FUNCIONADO\n` +
        examples
          .map((p) => `- ${p.name} (${p.wins}-${p.losses}) ante ${p.situation ?? "?"}: ${JSON.stringify(p.plan.verbs)}`)
          .join("\n")
    );
  }

  if (rejections.length > 0) {
    parts.push(
      `RECHAZOS RECIENTES DEL MUNDO — no repitas esto\n` +
        rejections.map((r) => `- ${r.detail ?? "?"} en ${JSON.stringify(r.plan?.verbs ?? [])}`).join("\n")
    );
  }

  parts.push("Devuelve el plan.");
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------

export type PlanResult =
  | { planned: false; why: string }
  | { planned: true; orderId: number; name: string; model: string; cacheRead: number; inTokens: number; outTokens: number };

/** Genera un plan y lo encola. Seguro de llamar en cualquier momento: la
 *  compuerta decide, y todo error acaba como un evento, nunca como una excepción
 *  que rompa el informe del mundo.
 *
 *  `deps.client` swaps the Postgres client (mirrors `withTransaction`'s `Sql`
 *  param across `alen.ts`); `deps.askModel` swaps the Anthropic call. Both
 *  default to the real implementations, so calling `planOnce()` with no args
 *  is unchanged. */
export async function planOnce(
  deps: { client?: Sql; askModel?: typeof askModelStructured } = {}
): Promise<PlanResult> {
  const { client, askModel = askModelStructured } = deps;

  const decision = await shouldPlan(client);
  if (!decision.plan) return { planned: false, why: decision.why };

  const state = await getState(client);
  if (!state) return { planned: false, why: "alen_no_vive" };

  const [examples, rejections] = await Promise.all([bestPlans(3, client), recentRejections(3, client)]);
  const userContent = buildUserContent(state, decision.events, examples, rejections);

  let reply;
  try {
    reply = await askModel<PlannerOutput>({
      model: config.alenPlannerModel,
      cachedSystem: ALEN_SYSTEM_PROMPT,
      userContent,
      schema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    });
  } catch (err) {
    const msg = err instanceof AnthropicError ? err.message : String(err);
    await recordEvent({ kind: "planner_error", payload: { error: msg.slice(0, 200) } }, client);
    return { planned: false, why: "error_proveedor" };
  }

  const out = reply.data;
  if (!out || !Array.isArray(out.verbs) || out.verbs.length === 0) {
    await recordEvent({ kind: "planner_error", payload: { error: "respuesta_sin_plan" } }, client);
    return { planned: false, why: "respuesta_sin_plan" };
  }

  // Cinturón y tirantes: el esquema ya restringe `op`, pero un plan con un verbo
  // desconocido no debe llegar ni a la cola. El mundo lo rechazaría igual; esto
  // sólo evita gastar un ciclo de poll en algo que ya sabemos que no vale.
  const bad = out.verbs.find((v) => !(ALEN_VERBS as readonly string[]).includes(v.op));
  if (bad) {
    await recordEvent({ kind: "planner_error", payload: { error: `verbo_invalido:${bad.op}` } }, client);
    return { planned: false, why: `verbo_invalido:${bad.op}` };
  }

  const plan = clampPlan(out);
  const orderId = await enqueueOrder({ plan, source: "model", reason: out.reason }, client);

  await query(
    `INSERT INTO alen_plans (name, plan, situation, order_id, model, input_tokens, output_tokens, cache_read_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      out.name.slice(0, 60),
      JSON.stringify(plan),
      out.reason.slice(0, 200),
      orderId,
      reply.model,
      reply.inputTokens,
      reply.outputTokens,
      reply.cacheReadTokens,
    ],
    client
  );

  await consumeEvents(decision.events.map((e) => e.id), client);

  return {
    planned: true,
    orderId,
    name: out.name,
    model: reply.model,
    cacheRead: reply.cacheReadTokens,
    inTokens: reply.inputTokens,
    outTokens: reply.outputTokens,
  };
}

/** Acota lo que el esquema no puede. El modelo lee los límites en las
 *  descripciones, pero un tope sólo es un tope cuando lo aplica el código. */
export function clampPlan(out: PlannerOutput): AlenPlan {
  const ttl = Math.min(900, Math.max(30, Math.round(Number(out.ttl) || 300)));
  const verbs = out.verbs.slice(0, MAX_VERBS).map((v) => {
    // `additionalProperties: false` obliga a declarar todas las claves posibles en
    // cada verbo, así que el modelo devuelve cosas como text:"" en un `hunt`. El
    // mundo las ignora, pero guardarlas ensucia la biblioteca de habilidades que
    // luego se le devuelve como ejemplo.
    const clean: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === null || val === "" || val === undefined) continue;
      clean[k] = k === "text" && typeof val === "string" ? val.slice(0, 120) : val;
    }
    return clean as AlenPlan["verbs"][number];
  });
  return { ttl, verbs: verbs as AlenPlan["verbs"] };
}

/** Cierra el bucle de aprendizaje: el mundo dice si el plan se completó o falló,
 *  con el id de la orden que lo originó, y el historial de esa habilidad se mueve.
 *  Es lo único que hace que la biblioteca mejore en vez de sólo crecer. */
export async function scorePlan(orderId: number, outcome: "win" | "loss"): Promise<void> {
  const col = outcome === "win" ? "wins" : "losses";
  await query(`UPDATE alen_plans SET ${col} = ${col} + 1 WHERE order_id = $1`, [orderId]);
}
