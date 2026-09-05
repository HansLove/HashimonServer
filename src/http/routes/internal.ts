import { Router } from "express";
import { z } from "zod";
import { requireLuantiSecret } from "@/http/luanti-secret";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import {
  canOwn,
  createSession,
  getPlayerByUsername,
  listLuantiAuthEntries,
  presentPlayer,
  registerLuantiGuest,
} from "@/domain/players";
import {
  listPendingTownActions,
  presentTerritory,
  replaceTownClaims,
  resolveTownAction,
  upsertPlayerTerritory,
  type TownClaimInput,
} from "@/domain/territory";
import { listActiveAlliancePairs } from "@/domain/diplomacy";
import {
  ALEN_VERBS,
  listPendingOrders,
  recordEvent,
  resolveOrder,
  saveState as saveAlenState,
} from "@/domain/alen";
import { MAP_TILE_SIZE, saveMapTile } from "@/domain/map-tiles";
import {
  arriveForLuantiUsername,
  markersForLuantiUsername,
} from "@/domain/map-markers";

export const internalRouter = Router();


/** Poll target for Luanti auth — every named account with a password entry, owner or
 *  not. The mod answers `get_auth` from this list, so leaving guests out would make the
 *  engine fall back to a local verifier and the two stores would diverge again. */
internalRouter.get(
  "/internal/luanti-auth",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const accounts = await listLuantiAuthEntries();
    //Heartbeat of the bridge: this route is polled every ~2s per world, so the
    //count going flat or dropping is how a broken bridge announces itself.
    enrich({ account_count: accounts.length });
    res.json({ accounts });
  })
);

const registerSchema = z.object({
  name: z.string().min(1).max(20),
  password: z.string().min(1),
});

/** The only way an in-game registration reaches the DB: the engine hands the mod the
 *  SRP entry it just built (it never sees the plaintext), the mod forwards it here. */
internalRouter.post(
  "/internal/luanti-register",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { name, password } = registerSchema.parse(req.body ?? {});
    enrich({ username: name });
    const player = await registerLuantiGuest(name, password);
    enrich({ register_result: "ok", player_id: player.id, register_source: "luanti" });
    res.status(201).json({ player: presentPlayer(player) });
  })
);

const bindSchema = z.object({
  name: z.string().min(1).max(20),
});

/** After Luanti verifies password against API hash, mint a bearer session for that owner. */
internalRouter.post(
  "/internal/luanti-bind",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { name } = bindSchema.parse(req.body ?? {});
    enrich({ username: name });
    const player = await getPlayerByUsername(name);
    if (!player) {
      enrich({ bind_result: "not_found" });
      throw new AppError(404, "player not found", "not_found");
    }
    if (!canOwn(player)) {
      enrich({ bind_result: "cannot_own", player_id: player.id });
      throw new AppError(403, "player cannot own (no key)", "cannot_own");
    }
    enrich({ bind_result: "ok", player_id: player.id, custody: player.custody });
    const session = await createSession(player.id);
    res.json({
      token: session.token,
      expiresAt: session.expires_at,
      player: presentPlayer(player),
    });
  })
);

const territorySchema = z.object({
  name: z.string().min(1).max(20),
  townName: z.string().max(64).nullable().optional(),
  townBlockCount: z.number().int().min(0).max(1_000_000).default(0),
  ownedPlotCount: z.number().int().min(0).max(1_000_000).default(0),
  isMayor: z.boolean().default(false),
});

/** The Luanti world pushes each player's Towny summary here (town, block/plot counts,
 *  mayor flag) so the website can show it. A projection, not a ledger event — no audit,
 *  no ownership consequence. Unknown players are simply ignored (a purely local player
 *  with no API account). */
internalRouter.post(
  "/internal/luanti-territory",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const body = territorySchema.parse(req.body ?? {});
    enrich({ username: body.name });
    const player = await getPlayerByUsername(body.name);
    if (!player) {
      enrich({ territory_result: "not_found" });
      throw new AppError(404, "player not found", "not_found");
    }
    const row = await upsertPlayerTerritory({
      playerId: player.id,
      townName: body.townName ?? null,
      townBlockCount: body.townBlockCount,
      ownedPlotCount: body.ownedPlotCount,
      isMayor: body.isMayor,
    });
    enrich({
      territory_result: "ok",
      player_id: player.id,
      has_town: Boolean(row.town_name),
      town_block_count: row.town_block_count,
    });
    res.json({ territory: presentTerritory(row) });
  })
);

// A mapblock coordinate triple [x, y, z] — the world is 3D. Bounds keep a bad push
// from ballooning the payload.
const coord = z.number().int().min(-1_000_000).max(1_000_000);
const blockTriple = z.tuple([coord, coord, coord]);

const memberSchema = z.object({
  name: z.string().min(1).max(64),
  rank: z.enum(["mayor", "comayor", "resident"]),
});

const townsSchema = z.object({
  towns: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        blockCount: z.number().int().min(0).max(100_000).default(0),
        memberCount: z.number().int().min(0).max(100_000).default(0),
        mayor: z.string().max(20).nullable().optional(),
        home: blockTriple.nullable().optional(),
        // Capped per town: Towny's default claim cap is 64, unlimited by priv; 20k is a
        // generous ceiling that still bounds the row.
        blocks: z.array(blockTriple).max(20_000).default([]),
        members: z.array(memberSchema).max(2_000).default([]),
      })
    )
    .max(5_000),
});

/** The Luanti world pushes the WHOLE town snapshot here (every town in towny.town_array,
 *  with each claimed mapblock's [x,z]) so the ranking is complete and the web can draw a
 *  cadastral map. Replace-all: the world is authoritative. A projection, not a ledger
 *  event. */
internalRouter.post(
  "/internal/luanti-towns",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { towns } = townsSchema.parse(req.body ?? {});
    const input: TownClaimInput[] = towns.map((t) => ({
      name: t.name,
      blockCount: t.blockCount,
      memberCount: t.memberCount,
      mayor: t.mayor ?? null,
      homeX: t.home ? t.home[0] : null,
      homeY: t.home ? t.home[1] : null,
      homeZ: t.home ? t.home[2] : null,
      blocks: t.blocks,
      members: t.members,
    }));
    const count = await replaceTownClaims(input);
    enrich({ towns_result: "ok", town_count: count });
    res.json({ ok: true, townCount: count });
  })
);

/** The Luanti world polls this for political actions the website queued (co-mayor
 *  promote/demote). It re-validates each against live Towny before applying, so this
 *  is a work queue, not authority. */
internalRouter.get(
  "/internal/luanti-town-actions",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const actions = await listPendingTownActions(50);
    enrich({ town_action_count: actions.length });
    res.json({ actions });
  })
);

const ackSchema = z.object({
  id: z.number().int().positive(),
  result: z.enum(["applied", "rejected"]),
  detail: z.string().max(200).optional(),
});

/** The world acks an action once it applied or rejected it in Towny. */
internalRouter.post(
  "/internal/luanti-town-actions/ack",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { id, result, detail } = ackSchema.parse(req.body ?? {});
    await resolveTownAction(id, result, detail);
    enrich({ town_action_ack: result, town_action_id: id });
    res.json({ ok: true });
  })
);

/** The Luanti world polls active alliances (as [a,b] town pairs) so hashimon_war can keep
 *  the peace: no auto-war and no attacks between allied towns. Read-only — the API owns
 *  alliance state; the world never writes it. */
internalRouter.get(
  "/internal/luanti-alliances",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const alliances = await listActiveAlliancePairs();
    enrich({ alliance_count: alliances.length });
    res.json({ alliances });
  })
);

const mapTileSchema = z.object({
  tileX: z.number().int(),
  tileZ: z.number().int(),
  /** Raw PNG bytes, base64-encoded (same encode_png output discovery_maps writes). */
  png: z.string().min(1).max(1_500_000),
});

/** Luanti pushes a discovery_maps surface PNG after generate_tile so the website can
 *  draw the same sea/land underlay under cadastral claims. Upsert by (tileX, tileZ). */
internalRouter.post(
  "/internal/luanti-map-tiles",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { tileX, tileZ, png } = mapTileSchema.parse(req.body ?? {});
    const buf = Buffer.from(png, "base64");
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) {
      throw new AppError(400, "png must be a PNG file", "invalid_png");
    }
    await saveMapTile(tileX, tileZ, buf);
    enrich({ map_tile: "ok", tile_x: tileX, tile_z: tileZ, bytes: buf.length });
    res.json({ ok: true, tileSize: MAP_TILE_SIZE, tileX, tileZ });
  })
);


// ---------------------------------------------------------------------------
// Alen Gregory — canal de órdenes. Mismo patrón que las acciones de pueblo:
// el mundo hace poll, revalida contra su propio estado, aplica y acusa recibo.
// La API PIDE; el mundo DECIDE. Ninguna de estas rutas es autoridad sobre la
// partida — si el mundo dice que no, el motivo vuelve en el ack y es lo único
// que hace mejorable al planificador.
// ---------------------------------------------------------------------------

/** El mundo recoge sus órdenes pendientes. Pocas a la vez: un plan largo en vuelo
 *  es peor que dos cortos, porque no se puede renegociar a mitad. */
internalRouter.get(
  "/internal/luanti-alen-orders",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const orders = await listPendingOrders(5);
    enrich({ alen_order_count: orders.length });
    res.json({ orders });
  })
);

const alenAckSchema = z.object({
  id: z.number().int().positive(),
  result: z.enum(["applied", "rejected"]),
  detail: z.string().max(200).optional(),
});

/** El mundo cierra una orden. `detail` lleva el motivo exacto del rechazo
 *  ("jugador_cerca:diego", "verbo_no_permitido:rm_rf"), que es la realimentación
 *  del bucle: sin ella el planificador repite el mismo error para siempre. */
internalRouter.post(
  "/internal/luanti-alen-orders/ack",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { id, result, detail } = alenAckSchema.parse(req.body ?? {});
    await resolveOrder(id, result, detail);
    enrich({ alen_ack: result, alen_order_id: id, alen_ack_detail: detail ?? null });
    res.json({ ok: true });
  })
);

const alenEventSchema = z.object({
  kind: z.string().min(1).max(40),
  actor: z.string().max(40).optional(),
  payload: z.record(z.unknown()).optional(),
});

const alenStateSchema = z.object({
  alive: z.boolean(),
  pos: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable().optional(),
  hp: z.number().int().min(0),
  maxHp: z.number().int().min(0),
  mood: z.string().max(40).optional(),
  observed: z.boolean(),
  digest: z.record(z.unknown()).optional(),
  events: z.array(alenEventSchema).max(20).optional(),
});

/** El mundo sube su informe: proyección de estado más las novedades ocurridas.
 *  Las novedades son lo que despierta al planificador — no un temporizador. Un
 *  dragón patrullando un bosque vacío no genera ninguna, y por tanto no cuesta
 *  un solo token. El ritmo de `events` es directamente la factura. */
internalRouter.post(
  "/internal/luanti-alen-state",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const body = alenStateSchema.parse(req.body ?? {});
    await saveAlenState({
      alive: body.alive,
      pos: body.pos ?? null,
      hp: body.hp,
      maxHp: body.maxHp,
      mood: body.mood ?? null,
      observed: body.observed,
      digest: body.digest,
    });
    for (const ev of body.events ?? []) {
      await recordEvent({ kind: ev.kind, actor: ev.actor, payload: ev.payload });
    }
    enrich({
      alen_alive: body.alive,
      alen_observed: body.observed,
      alen_hp: body.hp,
      alen_event_count: (body.events ?? []).length,
    });
    res.json({ ok: true, verbs: ALEN_VERBS });
  })
);

/** Poll synced waypoints / nation POIs / Hashimon quests for one Luanti player. */
internalRouter.get(
  "/internal/luanti-map-markers",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const name = String(req.query.name ?? "").trim();
    if (!name || name.length > 20) {
      throw new AppError(400, "name query required", "invalid_name");
    }
    const pack = await markersForLuantiUsername(name);
    enrich({
      username: name,
      map_marker_count: pack.markers.length,
      has_capital: Boolean(pack.capital),
    });
    res.json({
      markers: pack.markers,
      capital: pack.capital,
    });
  })
);

const arriveSchema = z.object({
  name: z.string().min(1).max(20),
  markerId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});

/** World confirms the player reached a Hashimon destination → care(world) + complete. */
internalRouter.post(
  "/internal/luanti-map-markers/arrive",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const body = arriveSchema.parse(req.body ?? {});
    const result = await arriveForLuantiUsername({
      username: body.name,
      markerId: body.markerId,
      x: body.x,
      y: body.y,
      z: body.z,
    });
    enrich({
      username: body.name,
      map_marker_arrive: result.completed,
      marker_id: body.markerId,
    });
    res.json(result);
  })
);
