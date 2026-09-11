import { Router } from "express";
import { z } from "zod";
import {
  enqueueRankAction,
  enqueueTownAction,
  formatClaimTarget,
  getPlayerTerritory,
  getTownClaimQuota,
  getTownClaimsByName,
  getTownInvites,
  getTownMembers,
  hasPendingClaimAt,
  listInvitesForPlayer,
  listPendingClaimsForTown,
  listTownClaims,
  listTownRanking,
  listVisibleClaimOverlays,
  mapblockBordersTown,
  mapblockOwnedByTown,
  memberIsOfficer,
  mergeClaimOverlaysIntoTowns,
  presentTownClaims,
  presentTownRanking,
  TOWN_CLAIM_DAILY_LIMIT,
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
import { listVibingTowers, presentVibingTowers, heatByPlace } from "@/domain/vibing";
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

// GET /territory/map — public cadastral map. Merges pending (and very-recently
// applied) web claims into the Towny projection so a refresh still paints.
territoryRouter.get(
  "/territory/map",
  asyncHandler(async (_req, res) => {
    const rows = await listTownClaims();
    const overlays = await listVisibleClaimOverlays();
    const towns = mergeClaimOverlaysIntoTowns(presentTownClaims(rows), overlays);
    enrich({ town_count: towns.length, claim_overlay_count: overlays.length });
    res.json({
      blockSize: 16,
      towns,
      pendingClaims: overlays
        .filter((o) => o.status === "pending")
        .map((o) => ({ townName: o.townName, x: o.block[0], y: o.block[1], z: o.block[2] })),
    });
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

// GET /territory/vibing-towers — public: every Vibing tower in the world (world node
// coords), each with the tier its coordinate yields (zona(x,z)) and its accumulated heat
// (verified harvests that materialized there). A hot tower is a proven, worth-raiding one.
territoryRouter.get(
  "/territory/vibing-towers",
  asyncHandler(async (_req, res) => {
    const rows = await listVibingTowers();
    const heat = await heatByPlace(rows.map((r) => r.id));
    enrich({ tower_count: rows.length });
    res.json({ towers: presentVibingTowers(rows.map((r) => ({ ...r, heat: heat.get(r.id) ?? 0 }))) });
  })
);

// GET /town/members — the caller's own town roster + ranks, and whether the caller is
// the mayor / an officer (so the web can show invite + co-mayor controls).
territoryRouter.get(
  "/town/members",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) {
      enrich({ has_town: false });
      res.json({
        town: null,
        youAreMayor: false,
        youAreOfficer: false,
        members: [],
        invitesSent: [] as string[],
        objectives: { founded: false, expanded: false, invited: false, hasComayor: false },
      });
      return;
    }
    const members = await getTownMembers(pt.town_name);
    const invitesSent = await getTownInvites(pt.town_name);
    const me = members.find((m) => m.name.toLowerCase() === (player.username ?? "").toLowerCase());
    const youAreMayor = me?.rank === "mayor" || pt.is_mayor;
    const youAreOfficer = youAreMayor || me?.rank === "comayor";
    const hasComayor = members.some((m) => m.rank === "comayor");
    const blockCount = pt.town_block_count;
    enrich({ has_town: true, town: pt.town_name, member_count: members.length });
    res.json({
      town: pt.town_name,
      youAreMayor,
      youAreOfficer,
      members,
      invitesSent,
      objectives: {
        founded: true,
        expanded: blockCount >= 2,
        invited: members.length >= 2,
        hasComayor,
      },
    });
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

// GET /town/invites — invites you sent (if in a town) + invites you received (if townless).
territoryRouter.get(
  "/town/invites",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const username = player.username ?? "";
    const pt = await getPlayerTerritory(player.id);
    const received = await listInvitesForPlayer(username);
    if (!pt || !pt.town_name) {
      res.json({ town: null, sent: [] as string[], received });
      return;
    }
    const sent = await getTownInvites(pt.town_name);
    res.json({ town: pt.town_name, sent, received: [] as string[] });
  })
);

// POST /town/invite — officer queues an invite for a townless player.
const inviteSchema = z.object({
  target: z.string().min(1).max(64),
});

territoryRouter.post(
  "/town/invite",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { target } = inviteSchema.parse(req.body ?? {});
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    const members = await getTownMembers(pt.town_name);
    if (!memberIsOfficer(members, player.username ?? "")) {
      throw new AppError(403, "only mayor or co-mayor can invite", "not_officer");
    }
    if (members.some((m) => m.name.toLowerCase() === target.toLowerCase())) {
      throw new AppError(409, "already a member", "already_member");
    }
    await enqueueTownAction({
      townName: pt.town_name,
      actor: player.username ?? "",
      target,
      op: "invite",
    });
    enrich({ town: pt.town_name, invite_target: target });
    res.status(202).json({ ok: true, queued: true });
  })
);

// POST /town/invite/revoke — revoke a pending invite.
territoryRouter.post(
  "/town/invite/revoke",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { target } = inviteSchema.parse(req.body ?? {});
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    const members = await getTownMembers(pt.town_name);
    if (!memberIsOfficer(members, player.username ?? "")) {
      throw new AppError(403, "only mayor or co-mayor can revoke invites", "not_officer");
    }
    await enqueueTownAction({
      townName: pt.town_name,
      actor: player.username ?? "",
      target,
      op: "invite_revoke",
    });
    res.status(202).json({ ok: true, queued: true });
  })
);

// POST /town/invite/respond — townless player accepts or denies an invite.
const inviteRespondSchema = z.object({
  town: z.string().min(1).max(64),
  op: z.enum(["accept", "deny"]),
});

territoryRouter.post(
  "/town/invite/respond",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { town, op } = inviteRespondSchema.parse(req.body ?? {});
    const pt = await getPlayerTerritory(player.id);
    if (pt?.town_name) throw new AppError(400, "already in a town", "already_in_town");
    const received = await listInvitesForPlayer(player.username ?? "");
    const match = received.find((t) => t.toLowerCase() === town.toLowerCase());
    if (!match) throw new AppError(404, "no invite from that town", "no_invite");
    await enqueueTownAction({
      townName: match,
      actor: player.username ?? "",
      target: player.username ?? "",
      op: op === "accept" ? "invite_accept" : "invite_deny",
    });
    enrich({ town: match, invite_respond: op });
    res.status(202).json({ ok: true, queued: true });
  })
);

// POST /town/members/kick — officer kicks a non-mayor member.
const kickSchema = z.object({
  target: z.string().min(1).max(64),
});

territoryRouter.post(
  "/town/members/kick",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { target } = kickSchema.parse(req.body ?? {});
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    const members = await getTownMembers(pt.town_name);
    if (!memberIsOfficer(members, player.username ?? "")) {
      throw new AppError(403, "only mayor or co-mayor can kick", "not_officer");
    }
    const match = members.find((m) => m.name.toLowerCase() === target.toLowerCase());
    if (!match) throw new AppError(404, "not a member", "not_a_member");
    if (match.rank === "mayor") throw new AppError(400, "cannot kick the mayor", "is_mayor");
    await enqueueTownAction({
      townName: pt.town_name,
      actor: player.username ?? "",
      target: match.name,
      op: "kick",
    });
    res.status(202).json({ ok: true, queued: true });
  })
);

// POST /town/leave — non-mayor leaves their town.
territoryRouter.post(
  "/town/leave",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");
    if (pt.is_mayor) {
      throw new AppError(400, "mayor cannot leave; transfer mayorship first", "is_mayor");
    }
    await enqueueTownAction({
      townName: pt.town_name,
      actor: player.username ?? "",
      target: player.username ?? "",
      op: "leave",
    });
    res.status(202).json({ ok: true, queued: true });
  })
);

// GET /town/claim-quota — how many web claims this town has left today (UTC).
territoryRouter.get(
  "/town/claim-quota",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) {
      res.json({ town: null, used: 0, limit: TOWN_CLAIM_DAILY_LIMIT, remaining: 0 });
      return;
    }
    const quota = await getTownClaimQuota(pt.town_name);
    const pending = await listPendingClaimsForTown(pt.town_name);
    enrich({ town: pt.town_name, claim_used: quota.used, pending_claims: pending.length });
    res.json({
      town: pt.town_name,
      ...quota,
      pending: pending.map(([x, y, z]) => ({ x, y, z })),
    });
  })
);

// POST /town/claim — officer queues a contiguous mapblock claim. Body is mapblock
// coords { x, y, z }. Soft-checks adjacency + daily cap; Luanti re-validates.
const claimSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

territoryRouter.post(
  "/town/claim",
  requireSession,
  asyncHandler(async (req, res) => {
    const player = req.player!;
    const { x, y, z } = claimSchema.parse(req.body ?? {});
    const username = player.username ?? "";
    if (!username) throw new AppError(400, "account has no luanti username", "no_username");

    const pt = await getPlayerTerritory(player.id);
    if (!pt || !pt.town_name) throw new AppError(400, "you are not in a town", "no_town");

    const claims = await getTownClaimsByName(pt.town_name);
    if (!claims) throw new AppError(400, "town snapshot missing", "no_town");

    const members = claims.members ?? (await getTownMembers(pt.town_name));
    if (!memberIsOfficer(members, username)) {
      throw new AppError(403, "only mayor or co-mayor can claim", "not_officer");
    }

    const pendingBlocks = await listPendingClaimsForTown(pt.town_name);
    const blocks = [
      ...((claims.blocks ?? []) as [number, number, number][]),
      ...pendingBlocks,
    ];
    if (mapblockOwnedByTown(x, y, z, blocks)) {
      throw new AppError(409, "already claimed by your town", "already_claimed");
    }
    if (!mapblockBordersTown(x, y, z, blocks)) {
      throw new AppError(400, "block must border your town", "not_adjacent");
    }

    // Soft check: another town's projected footprint owns this cell.
    const all = await listTownClaims();
    for (const t of all) {
      if (t.town_name === pt.town_name) continue;
      if (mapblockOwnedByTown(x, y, z, (t.blocks ?? []) as [number, number, number][])) {
        throw new AppError(409, "already claimed by another town", "taken");
      }
    }

    const target = formatClaimTarget(x, y, z);
    if (await hasPendingClaimAt(pt.town_name, target)) {
      throw new AppError(409, "claim already queued for this block", "already_queued");
    }

    const quota = await getTownClaimQuota(pt.town_name);
    if (quota.remaining <= 0) {
      throw new AppError(
        429,
        `daily claim limit of ${TOWN_CLAIM_DAILY_LIMIT} reached`,
        "daily_limit"
      );
    }

    await enqueueTownAction({
      townName: pt.town_name,
      actor: username,
      target,
      op: "claim",
    });
    const remainingToday = quota.remaining - 1;
    enrich({ town: pt.town_name, claim_target: target, remaining_today: remainingToday });
    res.status(202).json({
      ok: true,
      queued: true,
      target: { x, y, z },
      remainingToday,
      limit: TOWN_CLAIM_DAILY_LIMIT,
    });
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
