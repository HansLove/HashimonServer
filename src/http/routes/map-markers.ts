import { Router } from "express";
import { z } from "zod";
import { requireSession } from "@/http/auth";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import {
  assertCanEditNation,
  bundleForPlayer,
  createNationPoi,
  createPlayerWaypoint,
  deleteNationPoi,
  deletePlayerWaypoint,
  presentMarker,
} from "@/domain/map-markers";

export const mapMarkersRouter = Router();

const coord = z.number().finite().min(-1_000_000).max(1_000_000);
const placeBody = z.object({
  x: coord,
  y: coord.default(8),
  z: coord,
  label: z.string().trim().max(80).optional(),
});

/** Bundle: personal + nation + hashimon quests + capital. Authenticated. */
mapMarkersRouter.get(
  "/map/markers",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const bundle = await bundleForPlayer(player.id, player.username);
    enrich({
      waypoint_count: bundle.waypoints.length,
      nation_poi_count: bundle.nationPois.length,
      hashimon_quest_count: bundle.hashimonQuests.length,
      has_capital: Boolean(bundle.capital),
    });
    res.json(bundle);
  })
);

mapMarkersRouter.get(
  "/map/waypoints",
  requireSession,
  asyncHandler(async (req, res) => {
    const bundle = await bundleForPlayer(req.player!.id, req.player!.username);
    res.json({ waypoints: bundle.waypoints });
  })
);

mapMarkersRouter.post(
  "/map/waypoints",
  requireSession,
  asyncHandler(async (req, res) => {
    const body = placeBody.parse(req.body ?? {});
    const row = await createPlayerWaypoint({
      playerId: req.player!.id,
      x: body.x,
      y: body.y,
      z: body.z,
      label: body.label ?? "Waypoint",
    });
    enrich({ map_marker: "player_created", marker_id: row.id });
    res.status(201).json({ waypoint: presentMarker(row) });
  })
);

mapMarkersRouter.delete(
  "/map/waypoints/:id",
  requireSession,
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    if (!z.string().uuid().safeParse(id).success) {
      throw new AppError(400, "invalid id", "invalid_id");
    }
    await deletePlayerWaypoint(req.player!.id, id);
    enrich({ map_marker: "player_dismissed", marker_id: id });
    res.json({ ok: true });
  })
);

mapMarkersRouter.get(
  "/map/nation-pois",
  requireSession,
  asyncHandler(async (req, res) => {
    const bundle = await bundleForPlayer(req.player!.id, req.player!.username);
    res.json({
      town: bundle.townName,
      canEdit: bundle.canEditNation,
      pois: bundle.nationPois,
    });
  })
);

mapMarkersRouter.post(
  "/map/nation-pois",
  requireSession,
  asyncHandler(async (req, res) => {
    const body = placeBody.parse(req.body ?? {});
    const { townName } = await assertCanEditNation(req.player!.id, req.player!.username);
    const row = await createNationPoi({
      townName,
      ownerPlayerId: req.player!.id,
      x: body.x,
      y: body.y,
      z: body.z,
      label: body.label ?? "POI",
    });
    enrich({ map_marker: "nation_created", marker_id: row.id, town: townName });
    res.status(201).json({ poi: presentMarker(row) });
  })
);

mapMarkersRouter.delete(
  "/map/nation-pois/:id",
  requireSession,
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    if (!z.string().uuid().safeParse(id).success) {
      throw new AppError(400, "invalid id", "invalid_id");
    }
    const { townName } = await assertCanEditNation(req.player!.id, req.player!.username);
    await deleteNationPoi(townName, id);
    enrich({ map_marker: "nation_dismissed", marker_id: id, town: townName });
    res.json({ ok: true });
  })
);
