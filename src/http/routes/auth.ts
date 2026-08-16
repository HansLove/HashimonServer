import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/http/errors";
import { loginOwner, presentPlayer, registerOwner } from "@/domain/players";

export const authRouter = Router();

const registerSchema = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(8).max(200),
  speciesKey: z.string().min(1).max(60),
  publicKey: z.string().min(66).max(66).optional(),
  custody: z.enum(["server_encrypted", "player"]).optional(),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body ?? {});
    const result = await registerOwner(input);
    res.status(201).json({
      token: result.session.token,
      expiresAt: result.session.expires_at,
      player: presentPlayer(result.player),
      publicKey: result.player.public_key,
      custody: result.player.custody,
      hashimon: result.hashimon,
    });
  })
);

const loginSchema = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(1).max(200),
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = loginSchema.parse(req.body ?? {});
    const result = await loginOwner(input.username, input.password);
    res.json({
      token: result.session.token,
      expiresAt: result.session.expires_at,
      player: presentPlayer(result.player),
      publicKey: result.player.public_key,
      custody: result.player.custody,
      // Encrypted private key blob for custody = server_encrypted (client decrypts with password).
      encPrivateKey: result.encPrivateKeyBase64,
      kdfSalt: result.kdfSalt,
      kdfParams: result.kdfParams,
    });
  })
);
