import { Router } from "express";
import {
  listTownClaims,
  listTownRanking,
  presentTownClaims,
  presentTownRanking,
} from "@/domain/territory";
import { asyncHandler } from "@/http/errors";
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
