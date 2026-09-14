import assert from "node:assert/strict";
import { after, describe, it, test } from "node:test";
import {
  ChatDenied, decideCharge, loadState, parseCompanionReply, speak,
} from "@/modules/companion/domain/chat";
import { pool, query, withTransaction } from "@/modules/core/db/pool";
import { deletePlayers, seedHashimon, seedPlayer } from "@/test/support/fixtures";
import { fakeAskModel } from "@/test/support/llm";
import type { ModelReply } from "@/modules/companion/domain/anthropic";

// ---------------------------------------------------------------------------
// decideCharge — pure, no I/O (config.chatFreeTurns/creditsPerTurn come in as
// plain numbers, so these run with no DB and no config import involved).
// ---------------------------------------------------------------------------

test("decideCharge: degenerate — no free turns and no credits is denied", () => {
  assert.throws(
    () => decideCharge({ freeTurnsLeft: 0, credits: 0 }, 1),
    (err: unknown) => err instanceof ChatDenied && err.code === "insufficient_credits"
  );
});

test("decideCharge: simple — a free turn left never touches credits", () => {
  const decision = decideCharge({ freeTurnsLeft: 5, credits: 0 }, 1);
  assert.deepEqual(decision, { needsCredits: false, spent: 0 });
});

test("decideCharge: general — free turns exhausted but enough credits spends creditsPerTurn", () => {
  const decision = decideCharge({ freeTurnsLeft: 0, credits: 5 }, 2);
  assert.deepEqual(decision, { needsCredits: true, spent: 2 });
});

test("decideCharge: edge — credits exactly equal to the cost still clears", () => {
  const decision = decideCharge({ freeTurnsLeft: 0, credits: 3 }, 3);
  assert.deepEqual(decision, { needsCredits: true, spent: 3 });
});

test("decideCharge: error — one credit short of the cost throws ChatDenied", () => {
  assert.throws(
    () => decideCharge({ freeTurnsLeft: 0, credits: 2 }, 3),
    (err: unknown) => err instanceof ChatDenied && /sin créditos/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// parseCompanionReply — pure JSON/fallback/plain-text parsing.
// ---------------------------------------------------------------------------

test("parseCompanionReply: degenerate — empty text falls back to the ellipsis placeholder", () => {
  assert.deepEqual(parseCompanionReply(""), { reply: "…", action: "idle" });
});

test("parseCompanionReply: degenerate — whitespace-only text also falls back", () => {
  assert.deepEqual(parseCompanionReply("   "), { reply: "…", action: "idle" });
});

test("parseCompanionReply: simple — valid JSON reply/action", () => {
  assert.deepEqual(
    parseCompanionReply('{"reply":"hola","action":"look"}'),
    { reply: "hola", action: "look" }
  );
});

test("parseCompanionReply: general — an action outside the closed set falls back to idle", () => {
  assert.deepEqual(
    parseCompanionReply('{"reply":"hola","action":"dance"}'),
    { reply: "hola", action: "idle" }
  );
});

test("parseCompanionReply: edge — a markdown code-fenced JSON block is stripped and parsed", () => {
  const fenced = '```json\n{"reply":"hola cerca","action":"sit"}\n```';
  assert.deepEqual(parseCompanionReply(fenced), { reply: "hola cerca", action: "sit" });
});

test("parseCompanionReply: error — plain, non-JSON dialogue is returned verbatim", () => {
  assert.deepEqual(
    parseCompanionReply("solo texto plano sin json"),
    { reply: "solo texto plano sin json", action: "idle" }
  );
});

// ---------------------------------------------------------------------------
// loadState / speak (against the local DB) — croquetaBalance() inside chat.ts
// always calls the real pool directly (it is not part of the ChatDbDeps seam),
// so these need a live Postgres regardless of which query/withTransaction
// double is passed in. Only the LLM call is faked.
// ---------------------------------------------------------------------------

describe("loadState / speak (against the local DB)", () => {
  const playerIds: string[] = [];

  after(async () => {
    await deletePlayers(playerIds);
    await pool.end();
  });

  async function seedCreature(overrides: Parameters<typeof seedPlayer>[0] = {}) {
    const player = await seedPlayer(overrides);
    playerIds.push(player.id);
    const hashimon = await seedHashimon(player.id);
    return { player, hashimon };
  }

  it("loadState: degenerate — a freshly created creature has full free turns and no memory", async () => {
    const { player, hashimon } = await seedCreature();
    const state = await loadState(hashimon.id, player.id);
    assert.equal(state.turnsUsed, 0);
    assert.equal(state.freeTurnsLeft, 20); // config.chatFreeTurns default
    assert.equal(state.credits, 0);
    assert.equal(state.croquetas, 0);
    assert.deepEqual(state.keepsakes, []);
  });

  it("loadState: general — turns/memory/credits are all read back correctly", async () => {
    const { player, hashimon } = await seedCreature({ credits: 42 });
    await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user','hola')`, [hashimon.id]);
    await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'assistant','hola tú')`, [hashimon.id]);
    await query(`INSERT INTO companion_memory (hashimon_id, text) VALUES ($1,'primero')`, [hashimon.id]);
    await query(`INSERT INTO companion_memory (hashimon_id, text) VALUES ($1,'segundo')`, [hashimon.id]);

    const state = await loadState(hashimon.id, player.id);
    assert.equal(state.turnsUsed, 1, "sólo cuenta el turno de rol user");
    assert.equal(state.freeTurnsLeft, 19);
    assert.equal(state.credits, 42);
    assert.deepEqual(state.keepsakes, ["primero", "segundo"], "de más viejo a más reciente");
  });

  it("speak: simple — a free turn produces a reply, spends no credits and records the turn", async () => {
    const { player, hashimon } = await seedCreature();
    const deps = { query, withTransaction, askModel: fakeAskModel({ text: '{"reply":"Hola","action":"look"}' }) };

    const result = await speak({
      hashimonId: hashimon.id, ownerId: player.id, name: "Petunia", dna: hashimon.dna,
      spirit: null, element: null, stage: 1, message: "hola",
    }, deps);

    assert.equal(result.reply, "Hola");
    assert.equal(result.action, "look");
    assert.equal(result.freeTurnsLeft, 19);
    assert.equal(result.credits, 0);

    const turns = await query<{ role: string; content: string }>(
      `SELECT role, content FROM chat_turns WHERE hashimon_id = $1 ORDER BY created_at ASC`, [hashimon.id]
    );
    assert.equal(turns.rows.length, 2);
    assert.equal(turns.rows[0]!.role, "user");
    assert.equal(turns.rows[1]!.content, "Hola");
  });

  it("speak: general — every MEMORY_EVERY-th turn asks for and stores a keepsake", async () => {
    const { player, hashimon } = await seedCreature();
    // Pre-seed two prior user turns so this call lands on turn number 3 (MEMORY_EVERY).
    await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user','t1')`, [hashimon.id]);
    await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user','t2')`, [hashimon.id]);

    let calls = 0;
    const replies = ['{"reply":"Tercera vez","action":"idle"}', "Me quedé con que jugaste conmigo."];
    const askModel = async (): Promise<ModelReply> => {
      const text = replies[calls]!;
      calls++;
      return { text, inputTokens: 1, outputTokens: 1 };
    };
    const deps = { query, withTransaction, askModel };

    const result = await speak({
      hashimonId: hashimon.id, ownerId: player.id, name: "Petunia", dna: hashimon.dna,
      spirit: null, element: null, stage: 1, message: "hola otra vez",
    }, deps);

    assert.equal(calls, 2, "se pidió recuerdo en el tercer turno");
    assert.equal(result.keepsake, "Me quedé con que jugaste conmigo.");

    const mem = await query<{ text: string }>(
      `SELECT text FROM companion_memory WHERE hashimon_id = $1`, [hashimon.id]
    );
    assert.equal(mem.rows.length, 1);
    assert.equal(mem.rows[0]!.text, "Me quedé con que jugaste conmigo.");
  });

  it("speak: edge — a NADA memory reply is discarded, not stored", async () => {
    const { player, hashimon } = await seedCreature();
    await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user','t1')`, [hashimon.id]);
    await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user','t2')`, [hashimon.id]);

    let calls = 0;
    const replies = ['{"reply":"Ok","action":"idle"}', "NADA"];
    const askModel = async (): Promise<ModelReply> => {
      const text = replies[calls]!;
      calls++;
      return { text, inputTokens: 0, outputTokens: 0 };
    };
    const deps = { query, withTransaction, askModel };

    const result = await speak({
      hashimonId: hashimon.id, ownerId: player.id, name: "Petunia", dna: hashimon.dna,
      spirit: null, element: null, stage: 1, message: "hola",
    }, deps);

    assert.equal(result.keepsake, null);
    const mem = await query<{ text: string }>(
      `SELECT text FROM companion_memory WHERE hashimon_id = $1`, [hashimon.id]
    );
    assert.equal(mem.rows.length, 0);
  });

  it("speak: error — once free turns are exhausted and credits run out, ChatDenied is thrown", async () => {
    const { player, hashimon } = await seedCreature({ credits: 0 });
    // Exhaust the free-turn budget (config.chatFreeTurns default = 20).
    for (let i = 0; i < 20; i++) {
      await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user',$2)`, [hashimon.id, `t${i}`]);
    }
    const deps = { query, withTransaction, askModel: fakeAskModel({ text: '{"reply":"no","action":"idle"}' }) };

    await assert.rejects(
      () => speak({
        hashimonId: hashimon.id, ownerId: player.id, name: "Petunia", dna: hashimon.dna,
        spirit: null, element: null, stage: 1, message: "hola",
      }, deps),
      (err: unknown) => err instanceof ChatDenied && err.code === "insufficient_credits"
    );

    const turns = await query(
      `SELECT 1 FROM chat_turns WHERE hashimon_id = $1 AND content = 'hola'`, [hashimon.id]
    );
    assert.equal(turns.rows.length, 0, "un turno denegado nunca se guarda");
  });

  it("speak: general — once free turns are exhausted, a paid turn spends exactly creditsPerTurn", async () => {
    const { player, hashimon } = await seedCreature({ credits: 5 });
    // 21 prior turns: free budget exhausted, and turn number 22 is not a memory turn.
    for (let i = 0; i < 21; i++) {
      await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user',$2)`, [hashimon.id, `t${i}`]);
    }
    const deps = { query, withTransaction, askModel: fakeAskModel({ text: '{"reply":"pagado","action":"idle"}' }) };

    const result = await speak({
      hashimonId: hashimon.id, ownerId: player.id, name: "Petunia", dna: hashimon.dna,
      spirit: null, element: null, stage: 1, message: "hola de pago",
    }, deps);

    assert.equal(result.freeTurnsLeft, 0);
    assert.equal(result.credits, 4, "config.chatCreditsPerTurn default = 1");
  });

  //KNOWN BUG, left failing on purpose: speak() checks the balance with a plain read and then
  //debits unconditionally, so two concurrent paid turns both clear decideCharge and overdraw.
  it("speak: edge — two concurrent paid turns with credit for one never overdraw the balance", async () => {
    const { player, hashimon } = await seedCreature({ credits: 1 });
    for (let i = 0; i < 21; i++) {
      await query(`INSERT INTO chat_turns (hashimon_id, role, content) VALUES ($1,'user',$2)`, [hashimon.id, `t${i}`]);
    }

    //Barrier: neither turn leaves the model call until both have passed the credit check,
    //which pins the interleaving instead of hoping the scheduler produces it.
    let arrived = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
    const askModel = async (): Promise<ModelReply> => {
      arrived++;
      if (arrived === 2) openBarrier();
      await barrier;
      return { text: '{"reply":"pagado","action":"idle"}', inputTokens: 1, outputTokens: 1 };
    };
    const deps = { query, withTransaction, askModel };
    const turn = (message: string) => speak({
      hashimonId: hashimon.id, ownerId: player.id, name: "Petunia", dna: hashimon.dna,
      spirit: null, element: null, stage: 1, message,
    }, deps);

    const outcomes = await Promise.allSettled([turn("primero"), turn("segundo")]);

    const balance = await query<{ credits: number }>(`SELECT credits FROM players WHERE id = $1`, [player.id]);
    assert.equal(Number(balance.rows[0]!.credits), 0, "one credit pays for exactly one turn, never a negative balance");
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "only one of the two turns is charged");
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
    assert.ok(
      rejected?.reason instanceof ChatDenied && rejected.reason.code === "insufficient_credits",
      "the losing turn is denied for insufficient credits"
    );
  });
});
