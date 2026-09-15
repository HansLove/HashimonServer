import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { config } from "@/modules/core/config";
import { createApp } from "@/modules/core/http/app";
import { pool, query } from "@/modules/core/db/pool";

//The admin roster is read by a back office with a shared secret. What must hold:
//no secret configured is a 503 (never an open door), a wrong one is a 401, and the
//response carries the fields the back office shows and none of the credentials.

describe("admin roster (rutas)", () => {
  let server: Server;
  let base: string;
  const originalSecret = config.adminApiSecret;
  const secret = "test-admin-secret-0123456789";
  const playerIds: string[] = [];

  before(async () => {
    (config as { adminApiSecret: string }).adminApiSecret = secret;
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    (config as { adminApiSecret: string }).adminApiSecret = originalSecret;
    await new Promise((resolve) => server.close(resolve));
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    await pool.end();
  });

  const unique = (p: string) => `${p}${process.hrtime.bigint().toString(36).slice(-8)}`;

  async function seedPlayer(credits: number, bestBits: number[]) {
    const username = unique("adm");
    const res = await query<{ id: string }>(
      `INSERT INTO players (username, display_name, credits, password_hash)
       VALUES ($1, $1, $2, 'x-not-a-real-hash') RETURNING id`,
      [username, credits]
    );
    const id = res.rows[0]!.id;
    playerIds.push(id);
    for (const [i, bits] of bestBits.entries()) {
      await query(
        `INSERT INTO hashimons (owner_id, dna, species_key, template_id, birth_nonce, algo_version, provenance, best_share_bits)
         VALUES ($1, $2, 'glitchPup', 'template_pixel_002', 'n', 'test', $3, $4)`,
        [id, unique("dna"), i === 0 ? "starter" : "wild", bits]
      );
    }
    return { id, username };
  }

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("sin secreto se rechaza con 401", async () => {
    assert.equal((await get("/admin/players")).status, 401);
    assert.equal((await get("/admin/players", { "x-admin-secret": "wrong" })).status, 401);
  });

  it("un secreto sin configurar es 503, nunca una puerta abierta", async () => {
    (config as { adminApiSecret: string }).adminApiSecret = "";
    try {
      const res = await get("/admin/players", { "x-admin-secret": "" });
      assert.equal(res.status, 503);
    } finally {
      (config as { adminApiSecret: string }).adminApiSecret = secret;
    }
  });

  it("devuelve créditos, especie y la mejor share de TODAS sus criaturas", async () => {
    const { username } = await seedPlayer(1234, [8, 21]);
    const res = await get(`/admin/players?search=${username}`, { "x-admin-secret": secret });

    assert.equal(res.status, 200);
    const row = res.body.players.find((p: { username: string }) => p.username === username);
    assert.ok(row, "el jugador aparece en el roster");
    assert.equal(row.credits, 1234);
    assert.equal(row.hashimonCount, 2);
    assert.equal(row.speciesKey, "glitchPup");
    assert.equal(row.bestShareBits, 21);  // la mejor de las dos, no la del starter
    assert.equal(row.bestShareStars, 5);  // floor(21 / 4)
  });

  it("nunca expone credenciales", async () => {
    const { username } = await seedPlayer(0, []);
    const res = await get(`/admin/players?search=${username}`, { "x-admin-secret": secret });
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ["password", "enc_private_key", "encPrivateKey", "luanti", "publicKey", "public_key"]) {
      assert.ok(!serialized.includes(forbidden), `el roster no debe incluir ${forbidden}`);
    }
  });

  it("un jugador sin criaturas sale con ceros, no con nulls que rompan la tabla", async () => {
    const { username } = await seedPlayer(50, []);
    const res = await get(`/admin/players?search=${username}`, { "x-admin-secret": secret });
    const row = res.body.players[0];
    assert.equal(row.hashimonCount, 0);
    assert.equal(row.bestShareBits, 0);
    assert.equal(row.speciesName, null);
  });

  it("ordena por mejor share cuando se pide", async () => {
    const low = await seedPlayer(0, [4]);
    const high = await seedPlayer(0, [40]);
    const res = await get(`/admin/players?sort=best_share&limit=200`, { "x-admin-secret": secret });
    const order = res.body.players.map((p: { username: string }) => p.username);
    assert.ok(order.indexOf(high.username) < order.indexOf(low.username));
  });

  it("rechaza parámetros fuera de rango", async () => {
    assert.equal((await get("/admin/players?limit=5000", { "x-admin-secret": secret })).status, 400);
    assert.equal((await get("/admin/players?sort=drop_table", { "x-admin-secret": secret })).status, 400);
  });
});
