import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";
import { requireSession } from "@/modules/core/http/auth";
import {
  affiliateForPlayer,
  affiliateSummary,
  commissionsOf,
  createSubAffiliate,
  referralsOf,
  subAffiliatesOf,
  type AffiliateRow,
} from "@/modules/affiliate/domain/affiliates";

//El portal de afiliados. Vive en su propio subdominio pero NO tiene su propio
//login: un afiliado entra con la misma cuenta de Hashimon que cualquier otra
//persona, y este router sólo comprueba que esa cuenta tenga un código detrás.
//
//Montar un segundo sistema de credenciales para cinco personas sería otra
//superficie que asegurar, otro sitio donde se pierde una contraseña, y un sitio
//más desde el que robar. El bearer token que ya existe basta.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      affiliate?: AffiliateRow;
    }
  }
}

//Corre siempre después de requireSession, que es quien prueba la identidad.
//Esto sólo resuelve el rol.
const requireAffiliate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const player = req.player!;
  const affiliate = await affiliateForPlayer(player.id);
  if (!affiliate) {
    //403 y no 404: la cuenta existe y está autenticada, simplemente no es
    //afiliada. Un 404 haría pensar al portal que la ruta no existe.
    throw new AppError(403, "esta cuenta no es un afiliado", "not_an_affiliate");
  }
  enrich({ affiliate_code: affiliate.code, affiliate_is_root: affiliate.parent_code === null });
  req.affiliate = affiliate;
  next();
});

export const affiliateRouter = Router();

const portal = [requireSession, requireAffiliate] as const;

/** La pantalla principal: su enlace, su tasa y sus números. */
affiliateRouter.get(
  "/affiliate/me",
  ...portal,
  asyncHandler(async (req, res) => {
    const summary = await affiliateSummary(req.affiliate!.code);
    if (!summary) { throw new AppError(404, "afiliado no encontrado", "not_found"); }
    res.json(summary);
  })
);

/** Quién entró por su enlace. Sin identidades: etiquetas opacas. */
affiliateRouter.get(
  "/affiliate/referrals",
  ...portal,
  asyncHandler(async (req, res) => {
    res.json({ referrals: await referralsOf(req.affiliate!.code) });
  })
);

/** El historial de comisiones, incluidas las ya pagadas con su txid. */
affiliateRouter.get(
  "/affiliate/commissions",
  ...portal,
  asyncHandler(async (req, res) => {
    res.json({ commissions: await commissionsOf(req.affiliate!.code) });
  })
);

/** Su equipo. Un afiliado sin gente recibe una lista vacía, no un 403. */
affiliateRouter.get(
  "/affiliate/team",
  ...portal,
  asyncHandler(async (req, res) => {
    res.json({
      canRecruit: req.affiliate!.can_recruit && req.affiliate!.parent_code === null,
      maxRateBps: req.affiliate!.rate_bps,
      team: await subAffiliatesOf(req.affiliate!.code),
    });
  })
);

//La tasa llega en puntos básicos enteros, no en porcentaje decimal: 1000 = 10%.
//Un `10.5` como número de coma flotante sería una tasa que no se puede
//representar exactamente y que acaba en céntimos que no cuadran al pagar.
const createSubSchema = z
  .object({
    code: z.string().min(3).max(20),
    rateBps: z.number().int().min(0).max(10000),
    displayName: z.string().max(60).optional(),
    btcAddress: z.string().max(120).optional(),
  })
  .strict();

/**
 * Crear a alguien de su equipo, cediéndole parte de su tasa.
 *
 * Las reglas (puede reclutar, es raíz, la tasa no supera la suya) se comprueban
 * en el dominio, no aquí: son de negocio, y esta ruta no debe ser el único sitio
 * donde se cumplen.
 */
affiliateRouter.post(
  "/affiliate/team",
  ...portal,
  asyncHandler(async (req, res) => {
    const input = createSubSchema.parse(req.body ?? {});
    const created = await createSubAffiliate(req.affiliate!, input);
    enrich({ sub_affiliate_code: created.code, sub_affiliate_rate_bps: created.rate_bps });
    res.status(201).json({
      code: created.code,
      displayName: created.display_name,
      rateBps: created.rate_bps,
      //El diferencial que le queda al padre, calculado aquí para que el portal
      //no tenga que repetir la resta y pueda equivocarse.
      parentKeepsBps: req.affiliate!.rate_bps - created.rate_bps,
    });
  })
);
