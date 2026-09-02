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
