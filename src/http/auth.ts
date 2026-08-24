import type { NextFunction, Request, Response } from "express";
import { canOwn, playerForToken, type Player } from "@/domain/players";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";

//Augment Express's Request so downstream handlers see req.player typed.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      player?: Player;
    }
  }
}

//Gate a route behind a valid bearer session. Reads `Authorization: Bearer <token>`,
//resolves it to a player, and attaches it. This is deliberately the ONLY way a
//request proves who it is — the frontend is never the authority (ADR).
export const requireSession = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) { throw new AppError(401, "missing bearer token", "unauthenticated"); }

  const player = await playerForToken(match[1]!.trim());
  if (!player) { throw new AppError(401, "invalid or expired session", "unauthenticated"); }

  //Identity on the event as soon as it is proven, so even a request that fails
  //further down says who was making it.
  enrich({
    player_id: player.id,
    auth_source: "session",
    custody: player.custody,
    can_own: canOwn(player),
  });
  req.player = player;
  next();
});
