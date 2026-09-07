// El consejo del town (docs/WOLKERS_V1.md §6). Lo que se prueba aquí no es que el modelo
// acierte — es que el pueblo funciona igual cuando el modelo no está, falla, o miente.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "@/config";
import { councilFor, resetCouncilBudget, ruleOf, worthAsking } from "@/domain/wolker-council";
import type { TownSituation } from "@/domain/wolkers";

const calm: TownSituation = {
  townName: "Calma",
  population: 10,
  larder: 40,
  avgHunger: 2,
  avgMorale: 70,
  starving: 0,
  deaths7d: 0,
};
const famine: TownSituation = { ...calm, townName: "Hambruna", larder: 0, avgHunger: 80, starving: 6, deaths7d: 3 };

describe("wolker council", () => {
  // La clave se inyecta en vez de tocar `config`: estos tests describen un servidor con
  // modelo y otro sin él, y deben decir lo mismo corra donde corra.
  const KEY = "test-key";

  beforeEach(() => {
    resetCouncilBudget();
  });

  it("the rule alone already governs", () => {
    assert.equal(ruleOf(calm).posture, "normal");
    assert.equal(ruleOf({ ...calm, larder: 3 }).posture, "rationing");
    assert.equal(ruleOf(calm, { hostiles: 2 }).posture, "shelter");
    assert.equal(ruleOf(famine).posture, "exodus");
  });

  it("shelter beats rationing: a raid outranks an empty larder", () => {
    assert.equal(ruleOf({ ...calm, larder: 0, starving: 1 }, { hostiles: 1 }).posture, "shelter");
  });

  it("a calm town never reaches the model", async () => {
    assert.equal(worthAsking(calm), false);
    let called = 0;
    const decision = await councilFor(calm, {}, {
      apiKey: KEY,
      ask: async () => {
        called++;
        throw new Error("no debería llamarse");
      },
    });
    assert.equal(called, 0);
    assert.equal(decision.source, "rule");
  });

  it("without an API key the model path does not exist", async () => {
    let called = 0;
    const decision = await councilFor(famine, {}, {
      apiKey: "",
      ask: async () => {
        called++;
        throw new Error("no debería llamarse");
      },
    });
    assert.equal(called, 0);
    assert.equal(decision.posture, "exodus"); // la regla siguió gobernando
  });

  it("a crisis with budget consults, and the model may soften the rule", async () => {
    const decision = await councilFor(famine, {}, {
      apiKey: KEY,
      ask: async () => ({
        data: { posture: "rationing", reason: "Aún hay caza al norte; racionad antes de marchar." },
        raw: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "test",
      }),
    });
    assert.equal(decision.source, "model");
    assert.equal(decision.posture, "rationing");
    assert.match(decision.reason, /racionad/);
  });

  it("a model that fails, stalls or invents a posture changes nothing", async () => {
    const thrown = await councilFor(famine, {}, { apiKey: KEY, ask: async () => { throw new Error("502"); } });
    assert.equal(thrown.posture, "exodus");
    assert.equal(thrown.source, "rule");

    resetCouncilBudget();
    const nonsense = await councilFor(famine, {}, {
      apiKey: KEY,
      ask: async () => ({
        data: { posture: "fiesta", reason: "x" },
        raw: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "test",
      }),
    });
    assert.equal(nonsense.posture, "exodus");
    assert.equal(nonsense.source, "rule");
  });

  it("the per-town interval is a spend valve, not a hint", async () => {
    let called = 0;
    const ask = async () => {
      called++;
      return {
        data: { posture: "shelter" as const, reason: "ok" },
        raw: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "test",
      };
    };
    const t0 = Date.now();
    await councilFor(famine, {}, { apiKey: KEY, ask, now: t0 });
    await councilFor(famine, {}, { apiKey: KEY, ask, now: t0 + 1000 });     // dentro del intervalo
    assert.equal(called, 1);
    await councilFor(famine, {}, { apiKey: KEY, ask, now: t0 + (config.wolkerCouncilMinIntervalS + 1) * 1000 });
    assert.equal(called, 2);
  });

  it("the daily cap stops the spend even mid-crisis", async () => {
    let called = 0;
    const ask = async () => {
      called++;
      return {
        data: { posture: "shelter" as const, reason: "ok" },
        raw: "", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: "test",
      };
    };
    const t0 = Date.now();
    // Un town distinto cada vez, para saltarse el intervalo y chocar sólo contra el tope.
    for (let i = 0; i < config.wolkerCouncilMaxPerDay + 5; i++) {
      await councilFor({ ...famine, townName: `T${i}` }, {}, { apiKey: KEY, ask, now: t0 });
    }
    assert.equal(called, config.wolkerCouncilMaxPerDay);
  });
});
