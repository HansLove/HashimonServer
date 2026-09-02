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
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";

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
