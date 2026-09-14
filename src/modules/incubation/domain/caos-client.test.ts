//The single outbound POST to CaosEngine (see the ponytail note in caos-client.ts on why it
//has no retry). No DB involved — every case here mocks global fetch via node:test's own
//t.mock (auto-restored per test) instead of a live network call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "@/modules/core/config";
import { AppError } from "@/modules/core/http/errors";

//These three already come from .env in this dev environment (CAOS_ENGINE_URL,
//HASHIMON_PUBLIC_URL, HASHIMON_COINBASE_ADDRESS) — ??= only fills a genuinely missing gap,
//matching the established pattern (see magi.test.ts) rather than overriding real config.
process.env.CAOS_ENGINE_URL ??= "http://localhost:3001";
process.env.HASHIMON_PUBLIC_URL ??= "http://localhost:4000";
process.env.HASHIMON_COINBASE_ADDRESS ??= "bc1qcpzntzsnkkz7fue6jqumey63rj4epqj59uyws0";

const { isConfigured, requestHighEnergy } = await import("@/modules/incubation/domain/caos-client");

function baseInput() {
  return {
    address: config.coinbaseAddress,
    stars: 3,
    shares: 5,
    opReturn: "48415348494d4f4e2d444e412d474f4c44454e2d564543544f522d30303031",
    webhook: `${config.publicUrl}/incubation/webhook/some-secret`,
  };
}

test("isConfigured: true once caosEngineUrl, publicUrl and coinbaseAddress are all set", () => {
  assert.equal(isConfigured(), true);
});

test("requestHighEnergy: posts to <caosEngineUrl>/api/v1/mining/energy/high with the body shape CaosEngine expects", async (t) => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ requestId: "req-1", shares: 5, status: "queued", queuePosition: 2 }), { status: 202 });
  });

  const input = baseInput();
  await requestHighEnergy(input);

  assert.equal(seenUrl, `${config.caosEngineUrl.replace(/\/+$/, "")}/api/v1/mining/energy/high`);
  //`seed` must never appear: op_return and seed are mutually exclusive on CaosEngine's side.
  assert.deepEqual(seenBody, {
    address: input.address,
    stars: input.stars,
    shares: input.shares,
    op_return: input.opReturn,
    webhook: input.webhook,
  });
  assert.equal("seed" in seenBody, false);
});

test("requestHighEnergy: general — a full 202 body maps every field, including the optional message", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      JSON.stringify({ requestId: "req-2", shares: 7, status: "assigned", queuePosition: 0, message: "queued behind 2 lots" }),
      { status: 202 },
    ),
  );

  const result = await requestHighEnergy(baseInput());

  assert.deepEqual(result, {
    requestId: "req-2",
    shares: 7,
    status: "assigned",
    queuePosition: 0,
    message: "queued behind 2 lots",
  });
});

test("requestHighEnergy: edge — a 202 body with only requestId falls back to the request's own shares, 'assigned' and queuePosition 0", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ requestId: "req-3" }), { status: 202 }));

  const input = baseInput();
  const result = await requestHighEnergy(input);

  assert.deepEqual(result, {
    requestId: "req-3",
    shares: input.shares,
    status: "assigned",
    queuePosition: 0,
    message: undefined,
  });
});

test("requestHighEnergy: sends X-Caos-Key when config.caosApiKey is set", async (t) => {
  let seenHeaders: Record<string, string> = {};
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    seenHeaders = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ requestId: "req-4" }), { status: 202 });
  });

  await requestHighEnergy(baseInput());

  if (config.caosApiKey) {
    assert.equal(seenHeaders["X-Caos-Key"], config.caosApiKey);
  } else {
    assert.equal("X-Caos-Key" in seenHeaders, false);
  }
});

test("requestHighEnergy: degenerate — fetch throwing (CaosEngine unreachable) becomes a 502 caos_unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });

  await assert.rejects(
    () => requestHighEnergy(baseInput()),
    (err: AppError) => err instanceof AppError && err.status === 502 && err.code === "caos_unavailable",
  );
});

test("requestHighEnergy: error — a non-ok response becomes a 502 caos_rejected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "stars too low" }), { status: 400 }));

  await assert.rejects(
    () => requestHighEnergy(baseInput()),
    (err: AppError) => err instanceof AppError && err.status === 502 && err.code === "caos_rejected",
  );
});

test("requestHighEnergy: error — a 202 body missing requestId is treated as a rejected batch, not a silent success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ status: "queued" }), { status: 202 }));

  await assert.rejects(
    () => requestHighEnergy(baseInput()),
    (err: AppError) => err instanceof AppError && err.status === 502 && err.code === "caos_rejected",
  );
});

test("requestHighEnergy: error — a 202 with an unparseable body (json() rejects) is treated the same as a missing requestId", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not json", { status: 202 }));

  await assert.rejects(
    () => requestHighEnergy(baseInput()),
    (err: AppError) => err instanceof AppError && err.status === 502 && err.code === "caos_rejected",
  );
});
