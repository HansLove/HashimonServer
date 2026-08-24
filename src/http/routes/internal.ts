import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "@/config";
import { AppError, asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import {
  canOwn,
  createSession,
  getPlayerByUsername,
  listLuantiAuthEntries,
  presentPlayer,
} from "@/domain/players";

export const internalRouter = Router();

function requireLuantiSecret(req: { header: (n: string) => string | undefined }) {
  const secret = config.luantiServerSecret;
  if (!secret) {
    throw new AppError(503, "LUANTI_SERVER_SECRET not configured", "misconfigured");
  }
  const provided = req.header("x-luanti-secret") ?? "";
  const providedBuf = Buffer.from(provided);
  const secretBuf = Buffer.from(secret);
  // Constant-time compare: this secret gates an endpoint that discloses Luanti
  // password hashes and mints bearer sessions, so a timing side-channel matters.
  // Length must match before timingSafeEqual (it throws on mismatched lengths).
  const matches = providedBuf.length === secretBuf.length && timingSafeEqual(providedBuf, secretBuf);
  if (!matches) {
    throw new AppError(401, "invalid luanti server secret", "unauthorized");
  }
  enrich({ auth_source: "luanti" });
}

/** Poll target for Luanti hybrid auth — only owners (username + key). */
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
