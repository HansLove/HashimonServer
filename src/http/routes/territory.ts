import { Router } from "express";
import { z } from "zod";
import {
  enqueueRankAction,
  getPlayerTerritory,
  getTownMembers,
  listTownClaims,
  listTownRanking,
  presentTownClaims,
  presentTownRanking,
} from "@/domain/territory";
import {
  activateAlliance,
  deleteAlliance,
  getAlliance,
  insertProposal,
  listAlliancesForTown,
  presentDiplomacy,
  resolveTownName,
} from "@/domain/diplomacy";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { listMapTiles, MAP_TILE_SIZE, readMapTile } from "@/domain/map-tiles";

export const territoryRouter = Router();

// GET /territory/towns — public leaderboard of towns by claimed extension (block
// count). Town names and sizes are already visible to everyone in-world, so this is
// intentionally unauthenticated: it can back a public ranking page.
territoryRouter.get(
  "/territory/towns",
  asyncHandler(async (_req, res) => {
    const rows = await listTownRanking(100);
    enrich({ town_count: rows.length });
    res.json({ towns: presentTownRanking(rows) });
  })
);

// GET /territory/map — public cadastral map: every town's claimed mapblocks as [x,z]
// pairs, so the website can draw a shared chunk map and highlight the viewer's own town.
// `blockSize` is Towny's mapblock size (nodes per claim block) for world↔grid math.
territoryRouter.get(
  "/territory/map",
  asyncHandler(async (_req, res) => {
    const rows = await listTownClaims();
    enrich({ town_count: rows.length });
    res.json({ blockSize: 16, towns: presentTownClaims(rows) });
  })
);

// GET /territory/map-tiles — index of discovery_maps terrain PNGs available for the
// cadastral underlay. Public: same visibility as /territory/map.
territoryRouter.get(
  "/territory/map-tiles",
  asyncHandler(async (_req, res) => {
    const tiles = await listMapTiles();
    enrich({ map_tile_count: tiles.length });
    res.json({ tileSize: MAP_TILE_SIZE, tiles });
  })
);

// GET /territory/map-tiles/:tx/:tz.png — one surface tile. Long cache: tiles are
// rewritten in place when regenerated, but clients can refresh via the index.
territoryRouter.get(
  "/territory/map-tiles/:tx/:tz.png",
  asyncHandler(async (req, res) => {
    const tx = Number(req.params.tx);
    const tz = Number(req.params.tz);
    if (!Number.isInteger(tx) || !Number.isInteger(tz)) {
      throw new AppError(400, "tile coords must be integers", "invalid_tile");
    }
    const png = await readMapTile(tx, tz);
    if (!png) {
      throw new AppError(404, "map tile not found", "tile_not_found");
    }
    enrich({ tile_x: tx, tile_z: tz, bytes: png.length });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(png);
  })
);

// GET /town/members — the caller's own town roster + ranks, and whether the caller is
// the mayor (so the web can show the co-mayor controls). Authenticated: it's your town.
territoryRouter.get(
  "/town/members",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) {
      enrich({ has_town: false });
      res.json({ town: null, youAreMayor: false, members: [] });
      return;
    }
    const members = await getTownMembers(pt.town_name);
    enrich({ has_town: true, town: pt.town_name, member_count: members.length });
    res.json({ town: pt.town_name, youAreMayor: pt.is_mayor, members });
  })
);

// POST /town/rank — the mayor promotes or demotes a member to/from co-mayor. This only
// QUEUES the change; the Luanti world re-validates against live Towny and applies it
// (Towny is the source of truth). MVP: co-mayor only — never mayor transfer.
const rankSchema = z.object({
  target: z.string().min(1).max(64),
  op: z.enum(["add", "remove"]),
  rank: z.literal("comayor"),
});

territoryRouter.post(
  "/town/rank",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { target, op, rank } = rankSchema.parse(req.body ?? {});
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) {
      throw new AppError(400, "you are not in a town", "no_town");
    }
    if (!pt.is_mayor) {
      throw new AppError(403, "only the mayor can manage ranks", "not_mayor");
    }
    // Target must be a real member of the town (case-insensitive), and not the mayor.
    const members = await getTownMembers(pt.town_name);
    const match = members.find((m) => m.name.toLowerCase() === target.toLowerCase());
    if (!match) {
      throw new AppError(404, "that player is not in your town", "not_a_member");
    }
    if (match.rank === "mayor") {
      throw new AppError(400, "the mayor's rank cannot be changed here", "is_mayor");
    }
    await enqueueRankAction({
      townName: pt.town_name,
      actor: player.username ?? "",
      target: match.name,
      op,
      rank,
    });
    enrich({ town: pt.town_name, rank_op: op, rank_target: match.name });
    res.status(202).json({ ok: true, queued: true });
  })
);

// GET /town/diplomacy — your town's alliances and pending proposals. Authenticated.
territoryRouter.get(
  "/town/diplomacy",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) {
      res.json({ town: null, isMayor: false, allies: [], incoming: [], outgoing: [] });
      return;
    }
    const rows = await listAlliancesForTown(pt.town_name);
    enrich({ town: pt.town_name, alliance_count: rows.length });
    res.json({ town: pt.town_name, isMayor: pt.is_mayor, ...presentDiplomacy(pt.town_name, rows) });
  })
);

// POST /town/alliance — the mayor conducts diplomacy: propose, accept, decline or break an
// alliance with another town. The API owns this state; the Luanti world reads the active
// alliances to keep the peace. Both sides' mayors must consent (propose → accept).
const allianceSchema = z.object({
  action: z.enum(["propose", "accept", "decline", "break"]),
  target: z.string().min(1).max(64),
});

territoryRouter.post(
  "/town/alliance",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { action, target } = allianceSchema.parse(req.body ?? {});
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    if (!pt.is_mayor) throw new AppError(403, "only the mayor can do diplomacy", "not_mayor");

    const other = await resolveTownName(target);
    if (!other) throw new AppError(404, "no town by that name", "no_such_town");
    if (other === pt.town_name) throw new AppError(400, "a town cannot ally itself", "self");

    const me = pt.town_name;
    const existing = await getAlliance(me, other);
    let result: string;

    if (action === "propose") {
      if (existing?.status === "active") throw new AppError(409, "already allied", "already_allied");
      if (existing?.status === "proposed") {
        if (existing.proposed_by === me) throw new AppError(409, "proposal already pending", "already_pending");
        await activateAlliance(me, other); // they proposed, we propose back = accept
        result = "active";
      } else {
        await insertProposal(me, other);
        result = "proposed";
      }
    } else if (action === "accept") {
      if (existing?.status === "proposed" && existing.proposed_by === other) {
        await activateAlliance(me, other);
        result = "active";
      } else {
        throw new AppError(404, "no proposal from that town", "no_proposal");
      }
    } else if (action === "decline") {
      if (existing?.status === "proposed") {
        await deleteAlliance(me, other);
        result = "declined";
      } else {
        throw new AppError(404, "no proposal to decline", "no_proposal");
      }
    } else {
      // break
      if (existing?.status === "active") {
        await deleteAlliance(me, other);
        result = "broken";
      } else {
        throw new AppError(404, "you are not allied with that town", "not_allied");
      }
    }

    enrich({ town: me, diplomacy_action: action, diplomacy_target: other, diplomacy_result: result });
    res.json({ ok: true, result, town: me, target: other });
  })
);
