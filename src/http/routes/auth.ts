import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/http/errors";
import { enrich } from "@/http/wide-event";
import { loginOwner, presentPlayer, registerOwner } from "@/domain/players";

export const authRouter = Router();

const registerSchema = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(8).max(200),
  //La fecha de nacimiento reemplaza al selector de especie: el jugador ya no
  //elige elemento, familia ni cuerpo. El formato exacto lo valida
  //core/birth-identity.ts (calendario real, 1900+, no futura).
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dob must be YYYY-MM-DD"),
  publicKey: z.string().min(66).max(66).optional(),
  custody: z.enum(["server_encrypted", "player"]).optional(),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body ?? {});
    //La FECHA NUNCA entra al evento. registerOwner enriquece con los derivados
    //(espíritu, número de vida, elemento) en cuanto los calcula.
    enrich({ key_source: input.publicKey ? "client" : "generated" });
    const result = await registerOwner(input);
    res.status(result.claimed ? 200 : 201).json({
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
