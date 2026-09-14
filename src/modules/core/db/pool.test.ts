import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fakePoolClient, fakePoolQuerySource, fakeConnectSource, fakeSql, uniqueId } from "@/test/support/db";
import { pool, query, waitForDb, withTransaction, isUniqueViolation } from "@/modules/core/db/pool";

//A no-op sink: waitForDb/withTransaction's `logger.info/warn/error` calls must
//not touch stdout or a live request — these are unit tests, not integration ones.
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Parameters<typeof waitForDb>[0];

test("waitForDb succeeds on the first attempt without retrying", async () => {
  let calls = 0;
  await waitForDb(silentLogger, fakePoolQuerySource(() => {
    calls++;
    return [];
  }));
  assert.equal(calls, 1);
});

//Mock timers replace the real 3s backoff delay so these two tests stay fast
//(Feathers: no unit test should run slowly) instead of taking 6s/27s wall-clock.
//`tick` only fires timers already scheduled, so each loop iteration yields the
//microtask queue twice (once for the query's own await, once for the retry's
//catch block) before advancing the clock — advancing too early would tick a
//timer that hasn't been created by waitForDb's current iteration yet.
test("waitForDb retries on failure and eventually succeeds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const pending = waitForDb(silentLogger, fakePoolQuerySource(() => {
    attempts++;
    if (attempts < 3) { throw new Error("connection refused"); }
    return [];
  }));
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(3_000);
  }
  await pending;
  assert.equal(attempts, 3);
});

test("waitForDb throws a wrapped error after exhausting every attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const pending = waitForDb(silentLogger, fakePoolQuerySource(() => {
    attempts++;
    throw new Error("db is down");
  }));
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(3_000);
  }
  await assert.rejects(pending, /waitForDb: could not reach the database after 10 attempts: db is down/);
  assert.equal(attempts, 10);
});

test("withTransaction commits and releases on success", async () => {
  const client = fakePoolClient(() => [{ id: 1 }]);
  const result = await withTransaction(async (c) => {
    await c.query("INSERT INTO t VALUES (1)");
    return "ok";
  }, fakeConnectSource(client));

  assert.equal(result, "ok");
  assert.deepEqual(client.calls, ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT", "RELEASE"]);
});

test("withTransaction rolls back and releases, then rethrows, on failure", async () => {
  const client = fakePoolClient();
  const failure = new Error("insert failed");
  await assert.rejects(
    withTransaction(async (c) => {
      await c.query("INSERT INTO t VALUES (1)");
      throw failure;
    }, fakeConnectSource(client)),
    failure
  );
  assert.deepEqual(client.calls, ["BEGIN", "INSERT INTO t VALUES (1)", "ROLLBACK", "RELEASE"]);
});

test("query delegates to the injected client and returns its result rows", async () => {
  const fake = fakeSql(() => [{ id: uniqueId("row") }]);
  const result = await query("SELECT 1", [], fake);
  assert.equal(result.rows.length, 1);
});

test("query defaults params to an empty array when omitted", async () => {
  const fake = fakeSql((_text, params) => [{ paramsLength: params.length }]);
  await query("SELECT 1", undefined, fake);
  assert.deepEqual(fake.calls[0]!.params, []);
});

test("isUniqueViolation is false for non-pg errors, null, and non-23505 codes", () => {
  assert.equal(isUniqueViolation(null), false);
  assert.equal(isUniqueViolation(undefined), false);
  assert.equal(isUniqueViolation("boom"), false);
  assert.equal(isUniqueViolation(new Error("plain")), false);
  assert.equal(isUniqueViolation({ code: "23503" }), false); //foreign_key_violation, not unique
});

test("isUniqueViolation matches a 23505 code, optionally narrowed to a constraint", () => {
  assert.equal(isUniqueViolation({ code: "23505" }), true);
  assert.equal(isUniqueViolation({ code: "23505", constraint: "players_display_name_key" }, "players_display_name_key"), true);
  assert.equal(isUniqueViolation({ code: "23505", constraint: "other_key" }, "players_display_name_key"), false);
});

test("waitForDb against the real pool config reaches a live Postgres (integration smoke)", async () => {
  //The only place in this file that touches the real `pool` — proves the default
  //parameter still wires to production `pool` unchanged, per the adapter's note.
  await waitForDb(silentLogger, pool);
});

after(async () => {
  await pool.end();
});
