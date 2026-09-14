//Todo lo que necesita el Postgres local para el dominio de Alen: el canal de
//órdenes y la proyección de estado (alen.ts), la compuerta de gasto y el
//generador de planes (alen-planner.ts), y la compuerta de charla (alen-chat.ts).
//Los tres comparten las mismas tablas (alen_state es un singleton, alen_orders
//y alen_events se vacían enteras entre pruebas), así que viven en UN solo
//archivo a propósito: si estuvieran repartidos en varios, `node --test` los
//ejecutaría en procesos paralelos y correrían la cola/el estado entre sí. Las
//pruebas puramente funcionales (sin BD) de estos mismos módulos sí viven en
//alen.test.ts y alen-chat.test.ts, donde no hay tabla que compartir.
//
//Ninguna de estas pruebas contacta al proveedor de verdad — el askModel real
//exige ANTHROPIC_API_KEY, así que se fija una clave de prueba ANTES de
//importar @/config (patrón de magi.test.ts), y toda llamada al modelo pasa por
//el seam `deps.askModel` inyectado.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { askModelStructured } from "@/modules/companion/domain/anthropic";
import type { PlannerOutput } from "@/modules/alen/domain/alen-planner";
import type { ChatContext } from "@/modules/alen/domain/alen-chat";

//@/config lee ANTHROPIC_API_KEY en cuanto se evalúa el módulo, así que la clave
//de prueba tiene que existir ANTES del primer `await import()` que lo alcance
//transitivamente (patrón de magi.test.ts) — un `import` estático de cualquiera
//de estos módulos arriba del todo se evaluaría primero por hoisting y dejaría
//`config.anthropicApiKey` congelado en "".
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";

const { query, pool } = await import("@/modules/core/db/pool");
const { config } = await import("@/modules/core/config");
const { AnthropicError } = await import("@/modules/companion/domain/anthropic");
const { fakeAskModelStructured, fakeAskModelStructuredNull } = await import("@/test/support/llm");
const {
  enqueueOrder, recordEvent, resolveOrder, saveState, getState,
  listUnconsumedEvents, listPendingOrders, consumeEvents,
} = await import("@/modules/alen/domain/alen");
const { shouldPlan, scorePlan, planOnce, clampPlan, buildUserContent } = await import("@/modules/alen/domain/alen-planner");
const { chatsToday, replyTo } = await import("@/modules/alen/domain/alen-chat");

async function wipe() {
  await query("DELETE FROM alen_plans");
  await query("DELETE FROM alen_orders");
  await query("DELETE FROM alen_events");
  await query("DELETE FROM alen_state");
}

const OBSERVED = {
  alive: true,
  pos: { x: 10, y: 20, z: 30 },
  hp: 300,
  maxHp: 400,
  mood: "acecho",
  observed: true,
};

describe("la compuerta de gasto del planificador", () => {
  beforeEach(wipe);
  after(wipe);

  it("no planifica si Alen no vive", async () => {
    const d = await shouldPlan();
    assert.equal(d.plan, false);
    assert.equal(d.plan === false && d.why, "alen_no_vive");
  });

  it("no planifica si nadie lo está observando — la regla que más ahorra", async () => {
    await saveState({ ...OBSERVED, observed: false });
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });
    const d = await shouldPlan();
    assert.equal(d.plan === false && d.why, "sin_observadores");
  });

  it("no planifica sin novedades, por barato que sea", async () => {
    await saveState(OBSERVED);
    const d = await shouldPlan();
    assert.equal(d.plan === false && d.why, "sin_novedades");
  });

  it("no planifica con una orden todavía en vuelo", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });
    await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    const d = await shouldPlan();
    assert.equal(d.plan === false && d.why, "orden_en_vuelo");
  });

  it("vuelve a planificar cuando esa orden se cierra", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });
    const id = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    await resolveOrder(id, "applied", "2 verbos");
    const d = await shouldPlan();
    assert.equal(d.plan, true);
  });

  it("respeta el enfriamiento entre planes", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "herido", actor: "diego" });
    await query(
      `INSERT INTO alen_plans (name, plan, created_at) VALUES ('reciente', '{}'::jsonb, now())`
    );
    const d = await shouldPlan();
    assert.equal(d.plan === false && d.why, "en_enfriamiento");
  });

  it("un plan viejo ya no bloquea", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "herido", actor: "diego" });
    await query(
      `INSERT INTO alen_plans (name, plan, created_at)
       VALUES ('viejo', '{}'::jsonb, now() - make_interval(secs => $1))`,
      [config.alenPlanMinIntervalS + 60]
    );
    const d = await shouldPlan();
    assert.equal(d.plan, true);
  });

  it("corta en seco al llegar al tope diario", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "herido", actor: "diego" });
    //Todos fuera del enfriamiento, para que lo que corte sea el tope y no el ritmo.
    for (let i = 0; i < config.alenPlanMaxPerDay; i++) {
      await query(
        `INSERT INTO alen_plans (name, plan, created_at)
         VALUES ($1, '{}'::jsonb, now() - make_interval(secs => $2))`,
        [`plan_${i}`, config.alenPlanMinIntervalS + 60 + i]
      );
    }
    const d = await shouldPlan();
    assert.equal(d.plan === false && d.why, "tope_diario");
  });

  it("planifica cuando hay novedad, observadores y presupuesto", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego", payload: { dist: 30 } });
    const d = await shouldPlan();
    assert.equal(d.plan, true);
    assert.equal(d.plan === true && d.events.length, 1);
  });
});

describe("la biblioteca de habilidades aprende del veredicto del mundo", () => {
  beforeEach(wipe);
  after(wipe);

  it("un plan completado sube su marcador; uno fallido lo baja", async () => {
    const orderId = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    await query(
      `INSERT INTO alen_plans (name, plan, order_id) VALUES ('emboscada', '{}'::jsonb, $1)`,
      [orderId]
    );

    await scorePlan(orderId, "win");
    await scorePlan(orderId, "win");
    await scorePlan(orderId, "loss");

    const r = await query<{ wins: number; losses: number }>(
      `SELECT wins, losses FROM alen_plans WHERE order_id = $1`,
      [orderId]
    );
    assert.equal(r.rows[0]?.wins, 2);
    assert.equal(r.rows[0]?.losses, 1);
  });

  it("marcar una orden sin plan vinculado es un no-op silencioso (edge — order_id desligado)", async () => {
    //order_id es ON DELETE SET NULL: un id que no enlaza a ningún plan no debe
    //lanzar, sólo no tocar nada.
    await assert.doesNotReject(() => scorePlan(999_999, "win"));
  });
});

function plannerOutput(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    name: "emboscada_del_cañón",
    reason: "un jugador merodea solo",
    ttl: 180,
    verbs: [{ op: "say", text: "Vaya, vaya." }, { op: "goto", x: 1, y: 2, z: 3 }],
    ...overrides,
  };
}

describe("clampPlan — los topes que el esquema no puede aplicar", () => {
  it("un ttl ausente o no numérico cae al valor por defecto (degenerado)", () => {
    const plan = clampPlan(plannerOutput({ ttl: Number.NaN }));
    assert.equal(plan.ttl, 300);
  });

  it("un plan simple pasa sus valores tal cual, redondeando el ttl", () => {
    const plan = clampPlan(plannerOutput({ ttl: 180.4 }));
    assert.equal(plan.ttl, 180);
    assert.deepEqual(plan.verbs, [{ op: "say", text: "Vaya, vaya." }, { op: "goto", x: 1, y: 2, z: 3 }]);
  });

  it("descarta claves null/vacías/undefined y trunca `text` a 120 caracteres (general)", () => {
    const plan = clampPlan(
      plannerOutput({
        verbs: [{ op: "hunt", target: "diego", text: "", radius: null as unknown as number, seconds: undefined }],
      })
    );
    assert.deepEqual(plan.verbs, [{ op: "hunt", target: "diego" }]);
  });

  it("trunca `text` a 120 caracteres exactos (edge)", () => {
    const long = "x".repeat(200);
    const plan = clampPlan(plannerOutput({ verbs: [{ op: "say", text: long }] }));
    assert.equal((plan.verbs[0] as unknown as { text: string }).text.length, 120);
  });

  it("el ttl nunca baja de 30 ni sube de 900 (edge)", () => {
    assert.equal(clampPlan(plannerOutput({ ttl: 1 })).ttl, 30);
    assert.equal(clampPlan(plannerOutput({ ttl: 99999 })).ttl, 900);
  });

  it("nunca deja pasar más de 8 verbos, el máximo del plan (edge)", () => {
    const verbs = Array.from({ length: 12 }, () => ({ op: "wait" as const, seconds: 1 }));
    const plan = clampPlan(plannerOutput({ verbs }));
    assert.equal(plan.verbs.length, 8);
  });
});

describe("buildUserContent — la parte volátil del prompt", () => {
  const state = {
    alive: true, pos_x: 10, pos_y: 20, pos_z: 30, hp: 300, max_hp: 400,
    mood: "acecho", observed: true, digest: { resumen: "tranquilo" }, updated_at: "2026-01-01T00:00:00Z",
  };
  const events = [{ id: 1, kind: "nuevo_jugador", actor: "diego", payload: { dist: 30 }, created_at: "2026-01-01T00:00:00Z" }];

  it("sin ejemplos ni rechazos no incluye esas secciones (simple)", () => {
    const content = buildUserContent(state, events, [], []);
    assert.match(content, /ESTADO/);
    assert.match(content, /NOVEDADES/);
    assert.doesNotMatch(content, /PLANES QUE TE HAN FUNCIONADO/);
    assert.doesNotMatch(content, /RECHAZOS RECIENTES/);
    assert.match(content, /Devuelve el plan\.$/);
  });

  it("con ejemplos y rechazos, ambas secciones aparecen (general)", () => {
    const examples = [{ name: "emboscada", situation: "solo", plan: { ttl: 60, verbs: [{ op: "wait" as const }] }, wins: 3, losses: 1 }];
    const rejections = [{ detail: "jugador_cerca:diego", plan: { ttl: 60, verbs: [{ op: "blockjump" as const }] } }];
    const content = buildUserContent(state, events, examples, rejections);
    assert.match(content, /PLANES QUE TE HAN FUNCIONADO/);
    assert.match(content, /emboscada \(3-1\)/);
    assert.match(content, /RECHAZOS RECIENTES DEL MUNDO/);
    assert.match(content, /jugador_cerca:diego/);
  });

  it("sin novedades el bloque sigue formándose aunque quede vacío (edge)", () => {
    const content = buildUserContent(state, [], [], []);
    assert.match(content, /NOVEDADES \(por esto te han despertado\)/);
    assert.match(content, /Devuelve el plan\.$/);
  });
});

describe("planOnce — genera y encola con el modelo inyectado", () => {
  beforeEach(wipe);
  after(wipe);

  it("no llama al modelo si la compuerta lo impide (degenerado — Alen no vive)", async () => {
    let calls = 0;
    const askModel = (async (...args: Parameters<typeof askModelStructured>) => {
      calls++;
      return fakeAskModelStructured(plannerOutput())(...args);
    }) as typeof askModelStructured;

    const result = await planOnce({ askModel });
    assert.equal(result.planned, false);
    assert.equal(result.planned === false && result.why, "alen_no_vive");
    assert.equal(calls, 0, "la compuerta debe cortar antes de gastar un token");
  });

  it("encola un plan válido y consume las novedades que lo dispararon (simple)", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });

    const askModel = fakeAskModelStructured(plannerOutput(), { model: "claude-haiku-4-5", inputTokens: 500, outputTokens: 40, cacheReadTokens: 1200 });
    const result = await planOnce({ askModel });

    assert.equal(result.planned, true);
    if (!result.planned) throw new Error("expected planned");
    assert.equal(result.name, "emboscada_del_cañón");
    assert.equal(result.model, "claude-haiku-4-5");
    assert.equal(result.cacheRead, 1200);

    const pending = await listPendingOrders();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.source, "model");

    const remainingEvents = await listUnconsumedEvents();
    assert.equal(remainingEvents.length, 0, "el evento que disparó el plan queda consumido");
  });

  it("descarta un plan con un verbo fuera de la lista blanca (error)", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });

    const askModel = fakeAskModelStructured(plannerOutput({ verbs: [{ op: "rm_rf" as never }] }));
    const result = await planOnce({ askModel });

    assert.equal(result.planned, false);
    assert.equal(result.planned === false && result.why, "verbo_invalido:rm_rf");
    const pending = await listPendingOrders();
    assert.equal(pending.length, 0, "un plan inválido nunca se encola");
  });

  it("descarta una respuesta sin plan utilizable (error)", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });

    const result = await planOnce({ askModel: fakeAskModelStructuredNull() });

    assert.equal(result.planned, false);
    assert.equal(result.planned === false && result.why, "respuesta_sin_plan");
  });

  it("captura un error del proveedor sin lanzar y lo registra como evento (error)", async () => {
    await saveState(OBSERVED);
    await recordEvent({ kind: "nuevo_jugador", actor: "diego" });

    const askModel = (async () => {
      throw new AnthropicError("el proveedor respondió 503: sobrecarga", 503, true);
    }) as typeof askModelStructured;

    const result = await planOnce({ askModel });
    assert.equal(result.planned, false);
    assert.equal(result.planned === false && result.why, "error_proveedor");

    const events = await query<{ kind: string }>(`SELECT kind FROM alen_events WHERE kind = 'planner_error'`);
    assert.equal(events.rows.length, 1);
  });
});

describe("alen_orders — encolar, listar y resolver", () => {
  beforeEach(wipe);
  after(wipe);

  it("encola con los valores por defecto (source admin, reason null)", async () => {
    const id = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    const rows = await listPendingOrders();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, id);
    assert.equal(rows[0]?.source, "admin");
    assert.equal(rows[0]?.reason, null);
  });

  it("encola con source y reason explícitos", async () => {
    await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "say", text: "hola" }] }, source: "model", reason: "saludo" });
    const rows = await listPendingOrders();
    assert.equal(rows[0]?.source, "model");
    assert.equal(rows[0]?.reason, "saludo");
  });

  it("listPendingOrders respeta el límite y el orden ascendente", async () => {
    for (let i = 0; i < 3; i++) {
      await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] }, reason: `orden_${i}` });
    }
    const rows = await listPendingOrders(2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.reason, "orden_0");
    assert.equal(rows[1]?.reason, "orden_1");
  });

  it("listPendingOrders no devuelve nada cuando la cola está vacía (degenerado)", async () => {
    const rows = await listPendingOrders();
    assert.deepEqual(rows, []);
  });

  it("resolveOrder cierra una orden pendiente con su detalle", async () => {
    const id = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    await resolveOrder(id, "rejected", "jugador_cerca:diego");
    const r = await query<{ status: string; detail: string | null }>(
      `SELECT status, detail FROM alen_orders WHERE id = $1`,
      [id]
    );
    assert.equal(r.rows[0]?.status, "rejected");
    assert.equal(r.rows[0]?.detail, "jugador_cerca:diego");
  });

  it("resolveOrder sin detail lo deja en null", async () => {
    const id = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    await resolveOrder(id, "applied");
    const r = await query<{ detail: string | null }>(`SELECT detail FROM alen_orders WHERE id = $1`, [id]);
    assert.equal(r.rows[0]?.detail, null);
  });

  it("resolveOrder es un no-op sobre una orden que ya no está pendiente", async () => {
    const id = await enqueueOrder({ plan: { ttl: 60, verbs: [{ op: "wait" }] } });
    await resolveOrder(id, "applied", "primera");
    //Un segundo veredicto sobre la misma orden no debe pisar el primero: la
    //cláusula WHERE status = 'pending' es la guarda.
    await resolveOrder(id, "rejected", "segunda");
    const r = await query<{ status: string; detail: string | null }>(
      `SELECT status, detail FROM alen_orders WHERE id = $1`,
      [id]
    );
    assert.equal(r.rows[0]?.status, "applied");
    assert.equal(r.rows[0]?.detail, "primera");
  });
});

describe("alen_state — la proyección singleton", () => {
  beforeEach(wipe);
  after(wipe);

  it("getState devuelve null cuando el mundo nunca ha subido nada (degenerado)", async () => {
    assert.equal(await getState(), null);
  });

  it("saveState inserta y getState lee la misma fila", async () => {
    await saveState({
      alive: true,
      pos: { x: 1, y: 2, z: 3 },
      hp: 300,
      maxHp: 400,
      mood: "acecho",
      observed: true,
      digest: { resumen: "todo tranquilo" },
    });
    const state = await getState();
    assert.equal(state?.alive, true);
    assert.equal(state?.pos_x, 1);
    assert.equal(state?.hp, 300);
    assert.equal(state?.mood, "acecho");
    assert.deepEqual(state?.digest, { resumen: "todo tranquilo" });
  });

  it("saveState sin pos deja las coordenadas en null", async () => {
    await saveState({ alive: false, hp: 0, maxHp: 400, observed: false });
    const state = await getState();
    assert.equal(state?.pos_x, null);
    assert.equal(state?.pos_y, null);
    assert.equal(state?.pos_z, null);
    assert.equal(state?.mood, null);
  });

  it("saveState es un UPSERT: una segunda llamada actualiza la única fila", async () => {
    await saveState({ alive: true, hp: 300, maxHp: 400, observed: true });
    await saveState({ alive: false, hp: 0, maxHp: 400, observed: false });
    const rows = await query<{ n: string }>(`SELECT count(*) n FROM alen_state`);
    assert.equal(Number(rows.rows[0]?.n), 1);
    const state = await getState();
    assert.equal(state?.alive, false);
  });
});

describe("alen_events — la cola de novedades", () => {
  beforeEach(wipe);
  after(wipe);

  it("listUnconsumedEvents no ve nada sin eventos (degenerado)", async () => {
    assert.deepEqual(await listUnconsumedEvents(), []);
  });

  it("recordEvent guarda kind/actor/payload y aparece como no consumido", async () => {
    await recordEvent({ kind: "nuevo_jugador", actor: "diego", payload: { dist: 12 } });
    const events = await listUnconsumedEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "nuevo_jugador");
    assert.equal(events[0]?.actor, "diego");
    assert.deepEqual(events[0]?.payload, { dist: 12 });
  });

  it("recordEvent sin actor ni payload los deja en null", async () => {
    await recordEvent({ kind: "derrotado" });
    const events = await listUnconsumedEvents();
    assert.equal(events[0]?.actor, null);
    assert.equal(events[0]?.payload, null);
  });

  it("listUnconsumedEvents respeta el límite explícito", async () => {
    for (let i = 0; i < 3; i++) await recordEvent({ kind: `evento_${i}` });
    const events = await listUnconsumedEvents(2);
    assert.equal(events.length, 2);
  });

  it("consumeEvents marca sólo los ids dados", async () => {
    await recordEvent({ kind: "a" });
    await recordEvent({ kind: "b" });
    const [a, b] = await listUnconsumedEvents();
    await consumeEvents([a!.id]);
    const remaining = await listUnconsumedEvents();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, b!.id);
  });
});

function baseChatCtx(overrides: Partial<ChatContext> = {}): ChatContext {
  return { player: "diego", message: "¿por qué me odias?", ...overrides };
}

describe("chatsToday — el presupuesto de charla, aparte del de planificar", () => {
  beforeEach(wipe);
  after(wipe);

  it("sin conversaciones hoy, cero (degenerado)", async () => {
    assert.equal(await chatsToday(), 0);
  });

  it("cuenta sólo los eventos chat_respondido de las últimas 24h", async () => {
    await recordEvent({ kind: "chat_respondido", actor: "diego" });
    await recordEvent({ kind: "chat_respondido", actor: "aaron" });
    await recordEvent({ kind: "chat_error", actor: "diego" });
    assert.equal(await chatsToday(), 2);
  });

  it("un chat_respondido de ayer no cuenta hoy (edge)", async () => {
    await query(
      `INSERT INTO alen_events (kind, actor, created_at) VALUES ('chat_respondido', 'diego', now() - interval '2 days')`
    );
    assert.equal(await chatsToday(), 0);
  });
});

describe("replyTo — habla con Alen y aplica su juicio", () => {
  beforeEach(wipe);
  after(wipe);

  it("no llama al modelo si se llegó al tope diario de charla (edge — compuerta de gasto)", async () => {
    for (let i = 0; i < config.alenChatMaxPerDay; i++) {
      await recordEvent({ kind: "chat_respondido", actor: `jugador_${i}` });
    }
    let calls = 0;
    const askModel = (async (...args: Parameters<typeof askModelStructured>) => {
      calls++;
      return fakeAskModelStructured({ reply: "no debería llegar", ego: 0, interest: 0, respect: 0, intent: "speak" })(...args);
    }) as typeof askModelStructured;

    const result = await replyTo(baseChatCtx(), { askModel });
    assert.equal(result.replied, false);
    assert.equal(result.replied === false && result.why, "tope_diario_chat");
    assert.equal(calls, 0, "el tope diario debe cortar antes de gastar un token");
  });

  it("aplica una respuesta normal y acota ego/interest/respect a sus rangos (simple)", async () => {
    const askModel = fakeAskModelStructured(
      { reply: "  Interesante.  ", ego: -30, interest: 15, respect: -5, intent: "speak" },
      { inputTokens: 400, outputTokens: 30, cacheReadTokens: 1000 }
    );
    const result = await replyTo(baseChatCtx(), { askModel });

    assert.equal(result.replied, true);
    if (!result.replied) throw new Error("expected replied");
    assert.equal(result.reply, "Interesante.");
    assert.deepEqual(result.appraisal, { ego: -30, interest: 15, respect: -5, intent: "speak" });
    assert.equal(result.cacheRead, 1000);

    const events = await query<{ kind: string }>(`SELECT kind FROM alen_events WHERE kind = 'chat_respondido'`);
    assert.equal(events.rows.length, 1);
  });

  it("un ego/interest/respect fuera de rango se acota (general)", async () => {
    const askModel = fakeAskModelStructured({ reply: "ok", ego: -500, interest: 999, respect: -999, intent: "speak" });
    const result = await replyTo(baseChatCtx(), { askModel });
    assert.equal(result.replied, true);
    if (!result.replied) throw new Error("expected replied");
    assert.deepEqual(result.appraisal, { ego: -100, interest: 50, respect: -50, intent: "speak" });
  });

  it("un intent fuera de la lista blanca cae a 'speak' (edge)", async () => {
    const askModel = fakeAskModelStructured({ reply: "ok", ego: 0, interest: 0, respect: 0, intent: "destroy_everything" });
    const result = await replyTo(baseChatCtx(), { askModel });
    assert.equal(result.replied, true);
    if (!result.replied) throw new Error("expected replied");
    assert.equal(result.appraisal.intent, "speak");
  });

  it("una respuesta vacía es un silencio válido, no un fallo (edge)", async () => {
    const askModel = fakeAskModelStructured({ reply: "", ego: -80, interest: 0, respect: 0, intent: "ignore" });
    const result = await replyTo(baseChatCtx(), { askModel });
    assert.equal(result.replied, true);
    if (!result.replied) throw new Error("expected replied");
    assert.equal(result.reply, "");
    assert.equal(result.appraisal.intent, "ignore");
  });

  it("sin datos parseables del modelo, no responde (error)", async () => {
    const result = await replyTo(baseChatCtx(), { askModel: fakeAskModelStructuredNull() });
    assert.equal(result.replied, false);
    assert.equal(result.replied === false && result.why, "respuesta_vacia");
  });

  it("captura un error del proveedor sin lanzar y lo registra como evento (error)", async () => {
    const askModel = (async () => {
      throw new AnthropicError("el proveedor respondió 429: rate limited", 429, true);
    }) as typeof askModelStructured;

    const result = await replyTo(baseChatCtx(), { askModel });
    assert.equal(result.replied, false);
    assert.equal(result.replied === false && result.why, "error_proveedor");

    const events = await query<{ kind: string; actor: string | null }>(
      `SELECT kind, actor FROM alen_events WHERE kind = 'chat_error'`
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0]?.actor, "diego");
  });
});

after(() => pool.end());
