import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { loginOwner, presentPlayer, registerOwner } from "@/modules/player/domain/players";

export const authRouter = Router();

const registerSchema = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(8).max(200),
  // Ritual 1: day+month seal spirit only. Year arrives later via /profile/element.
  birthDay: z.number().int().min(1).max(31),
  birthMonth: z.number().int().min(1).max(12),
  publicKey: z.string().min(66).max(66).optional(),
  custody: z.enum(["server_encrypted", "player"]).optional(),
  //Código de afiliado leído del ?ref= de la URL. Se valida contra la tabla en
  //registerOwner, no aquí: un código inexistente no es un error de forma del
  //cuerpo, es un enlace viejo, y debe registrar igual.
  ref: z.string().max(40).optional(),
});

authRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const input = registerSchema.parse(req.body ?? {});
    //La FECHA NUNCA entra al evento. registerOwner enriquece con el espíritu.
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
