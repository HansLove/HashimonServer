import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "@/http/app";
import { pool, query } from "@/db/pool";
import { createSession } from "@/domain/players";
import { createSubAffiliate, type AffiliateRow } from "@/domain/affiliates";

//El portal reusa el bearer token del sitio, así que lo único propio que tiene
//que probarse aquí es el gate: quién puede entrar, y que cada afiliado vea
//SUS números y no los de otro. La aritmética de comisiones ya está cubierta en
//domain/affiliates.test.ts.

describe("portal de afiliados (rutas)", () => {
  let server: Server;
  let base: string;
  const playerIds: string[] = [];
  const codes: string[] = [];

  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (playerIds.length > 0) {
      await query(`DELETE FROM players WHERE id = ANY($1)`, [playerIds]);
    }
    if (codes.length > 0) {
      await query(`DELETE FROM affiliates WHERE code = ANY($1)`, [codes]);
    }
    await pool.end();
  });

  function unique(prefix: string): string {
    return `${prefix}-${process.hrtime.bigint().toString(36)}`;
  }

  async function newPlayer(): Promise<string> {
    const res = await query<{ id: string }>(
      `INSERT INTO players (display_name) VALUES ('PortalTest') RETURNING id`
    );
    const id = res.rows[0]!.id;
    playerIds.push(id);
    return id;
  }

  async function tokenFor(playerId: string): Promise<string> {
    return (await createSession(playerId)).token;
  }

  async function seedAffiliateWithPlayer(
    opts: { rateBps?: number; canRecruit?: boolean } = {}
  ): Promise<{ affiliate: AffiliateRow; token: string; playerId: string }> {
    const playerId = await newPlayer();
    const code = unique("PORTAL");
    codes.push(code);
    const res = await query<AffiliateRow>(
      `INSERT INTO affiliates (code, btc_address, rate_bps, can_recruit, player_id)
       VALUES ($1, 'bc1qportal', $2, $3, $4) RETURNING *`,
      [code, opts.rateBps ?? 1500, opts.canRecruit ?? false, playerId]
    );
    return { affiliate: res.rows[0]!, token: await tokenFor(playerId), playerId };
  }

  async function get(path: string, token?: string) {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  async function post(path: string, token: string, payload: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  }

  it("sin sesión no se entra", async () => {
    assert.equal((await get("/affiliate/me")).status, 401);
  });

  //403 y no 404: la cuenta existe, simplemente no es afiliada. El portal
  //necesita distinguirlo para enseñar "no eres afiliado" y no "página rota".
  it("una cuenta normal recibe 403 not_an_affiliate", async () => {
    const token = await tokenFor(await newPlayer());
    const res = await get("/affiliate/me", token);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "not_an_affiliate");
  });

  it("un afiliado ve su enlace y sus números", async () => {
    const { affiliate, token } = await seedAffiliateWithPlayer();
    const res = await get("/affiliate/me", token);

    assert.equal(res.status, 200);
    assert.equal(res.body.code, affiliate.code);
    assert.equal(res.body.rateBps, 1500);
    assert.ok(String(res.body.link).includes(`ref=${affiliate.code}`));
    //Un afiliado nuevo ve ceros, nunca nulls: la pantalla no debe romperse el día uno.
    assert.equal(res.body.pendingUsd, "0.00");
    assert.equal(res.body.paidUsd, "0.00");
    assert.equal(res.body.signups, 0);
  });

  it("las listas vienen vacías, no en error, cuando no hay nada todavía", async () => {
    const { token } = await seedAffiliateWithPlayer();
    assert.deepEqual((await get("/affiliate/referrals", token)).body.referrals, []);
    assert.deepEqual((await get("/affiliate/commissions", token)).body.commissions, []);
    assert.deepEqual((await get("/affiliate/team", token)).body.team, []);
  });

  it("quien no puede reclutar recibe 403 al intentarlo", async () => {
    const { token } = await seedAffiliateWithPlayer({ canRecruit: false });
    const res = await post("/affiliate/team", token, { code: unique("X"), rateBps: 500 });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "cannot_recruit");
  });

  it("un superafiliado crea a alguien y el portal le dice con cuánto se queda", async () => {
    const { affiliate, token } = await seedAffiliateWithPlayer({ canRecruit: true, rateBps: 1500 });
    const subCode = unique("SUB");
    codes.push(subCode);

    const res = await post("/affiliate/team", token, { code: subCode, rateBps: 1000, displayName: "Pedro" });
    assert.equal(res.status, 201);
    assert.equal(res.body.rateBps, 1000);
    //La resta la hace el servidor para que el portal no pueda equivocarse.
    assert.equal(res.body.parentKeepsBps, 500);

    const team = (await get("/affiliate/team", token)).body.team as unknown as Array<{ code: string }>;
    assert.equal(team.length, 1);
    assert.equal(team[0]!.code, subCode);
    assert.equal(affiliate.code, affiliate.code);
  });

  it("no deja ceder más tasa de la propia", async () => {
    const { token } = await seedAffiliateWithPlayer({ canRecruit: true, rateBps: 1000 });
    const res = await post("/affiliate/team", token, { code: unique("SUB"), rateBps: 1500 });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, "rate_above_parent");
  });

  //El aislamiento que importa: dos afiliados, y ninguno ve al otro.
  it("cada afiliado ve sólo lo suyo", async () => {
    const a = await seedAffiliateWithPlayer({ canRecruit: true });
    const b = await seedAffiliateWithPlayer({ canRecruit: true });
    const subCode = unique("SUB");
    codes.push(subCode);
    await createSubAffiliate(a.affiliate, { code: subCode, rateBps: 500 });

    const teamOfB = (await get("/affiliate/team", b.token)).body.team as unknown as unknown[];
    assert.equal(teamOfB.length, 0, "B no puede ver el equipo de A");

    const meOfB = await get("/affiliate/me", b.token);
    assert.equal(meOfB.body.code, b.affiliate.code);
    assert.equal(meOfB.body.subAffiliates, 0);
  });
});
