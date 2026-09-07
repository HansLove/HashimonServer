//La compuerta de gasto del planificador de Alen. Es la parte que no puede
//fallar: cada `plan: false` de aquí es una llamada al modelo que no se hace.
//Ninguna de estas pruebas contacta al proveedor — miden exactamente lo contrario,
//que no lo contacte. Necesita el Postgres local, como payments.test.ts.
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { query } from "@/modules/core/db/pool";
import { config } from "@/modules/core/config";
import { enqueueOrder, recordEvent, resolveOrder, saveState } from "@/modules/alen/domain/alen";
import { shouldPlan, scorePlan } from "@/modules/alen/domain/alen-planner";

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
});
