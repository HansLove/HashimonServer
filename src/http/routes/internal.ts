import { Router } from "express";
import { z } from "zod";
import { config } from "@/config";
import { AppError, asyncHandler } from "@/http/errors";
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
  if (provided !== secret) {
    throw new AppError(401, "invalid luanti server secret", "unauthorized");
  }
}

/** Poll target for Luanti hybrid auth — only owners (username + key). */
internalRouter.get(
  "/internal/luanti-auth",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const accounts = await listLuantiAuthEntries();
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
    const player = await getPlayerByUsername(name);
    if (!player) {
      throw new AppError(404, "player not found", "not_found");
    }
    if (!canOwn(player)) {
      throw new AppError(403, "player cannot own (no key)", "cannot_own");
    }
    const session = await createSession(player.id);
    res.json({
      token: session.token,
      expiresAt: session.expires_at,
      player: presentPlayer(player),
    });
  })
);
