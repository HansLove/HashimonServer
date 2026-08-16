import { Router } from "express";
import { z } from "zod";
import { createSession, findOrCreatePlayer } from "@/domain/players";
import { asyncHandler } from "@/http/errors";

export const sessionRouter = Router();

const bodySchema = z.object({
  publicKey: z.string().min(1).max(200).optional(),
  displayName: z.string().min(1).max(60).optional(),
});

//POST /session — create-or-restore an identity and hand back a bearer token.
//No token required to call this; it is how a client gets its first token.
sessionRouter.post(
  "/session",
  asyncHandler(async (req, res) => {
    const input = bodySchema.parse(req.body ?? {});
    const { player, created } = await findOrCreatePlayer(input);
    const session = await createSession(player.id);
    res.status(created ? 201 : 200).json({
      token: session.token,
      expiresAt: session.expires_at,
      player: {
        id: player.id,
        displayName: player.display_name,
        username: player.username,
        publicKey: player.public_key,
        credits: player.credits,
        custody: player.custody,
        canOwn: Boolean(player.public_key),
      },
    });
  })
);
