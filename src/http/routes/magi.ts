import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AppError, asyncHandler } from "@/http/errors";
import { requireLuantiSecret } from "@/http/luanti-secret";
import { enrich } from "@/http/wide-event";
import {
  check,
  deposit,
  holderState,
  issue,
  MagiSupplyExhausted,
  MagiUnconfigured,
  supply,
  withdraw,
  type CustodyResult,
} from "@/domain/magi";

export const magiRouter = Router();

const HOLDER = z.string().regex(/^[A-Za-z0-9_-]{1,20}$/);

//Exactly the fields the Luanti item carries. Coerced, because item metadata is a
//string store — an honest client sends "1000", a forger sends anything.
const tokenSchema = z.object({
  serial: z.string(),
  sats: z.coerce.number().int(),
  epoch: z.coerce.number().int(),
  nonce: z.string(),
  seal: z.string(),
});

const notesSchema = z.object({
  holder: HOLDER,
  event: z.string().max(32).optional(),
  notes: z.array(tokenSchema).min(1).max(64),
});

const countSchema = z.object({
  holder: HOLDER,
  count: z.coerce.number().int().min(1).max(64),
});

//The whole point of the object is that its supply is inspectable by anyone, so this
//one route is public and unauthenticated.
magiRouter.get(
  "/magi/supply",
  asyncHandler(async (_req, res) => {
    res.json(await supply());
  })
);

/** Counts by verdict on the wide event: a spike in `stale` is what a duplication
 *  glitch looks like from the outside, and it should be visible without a query. */
function enrichVerdicts(results: CustodyResult[]): void {
  const counts: Record<string, number> = {};
  for (const r of results) { counts[r.verdict] = (counts[r.verdict] ?? 0) + 1; }
  enrich({ magi_notes: results.length, magi_verdicts: counts, magi_rejected: results.length - (counts.ok ?? 0) });
}

magiRouter.post(
  "/internal/magi/issue",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { holder, count } = countSchema.parse(req.body);
    try {
      const result = await issue(holder, count);
      enrich({ magi_issued: result.issued, magi_supply_issued: result.supply.issued });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof MagiSupplyExhausted) {
        throw new AppError(409, err.message, "supply_exhausted");
      }
      throw err;
    }
  })
);

/** Vault -> inventory. The response tokens are what the mod writes into item meta. */
magiRouter.post(
  "/internal/magi/withdraw",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { holder, count } = countSchema.parse(req.body);
    const notes = await withdraw(holder, count);
    enrich({ magi_withdrawn: notes.length, magi_requested: count });
    res.json({ notes, requested: count });
  })
);

/** Inventory -> vault. A note that fails custody is not deposited: its verdict comes
 *  back and the mod destroys the item. */
magiRouter.post(
  "/internal/magi/deposit",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { holder, notes } = notesSchema.parse(req.body);
    const results = await deposit(holder, notes);
    enrichVerdicts(results);
    res.json({ results, deposited: results.filter((r) => r.verdict === "ok").length });
  })
);

/** The customs check. Called on join, pickup, place and on a timer — every result
 *  with verdict `ok` carries a freshly rotated token that must replace the item's. */
magiRouter.post(
  "/internal/magi/custody",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const { holder, notes, event } = notesSchema.parse(req.body);
    const results = await check(holder, notes, event ?? "check");
    enrichVerdicts(results);
    res.json({ results });
  })
);

magiRouter.get(
  "/internal/magi/holder/:name",
  asyncHandler(async (req, res) => {
    requireLuantiSecret(req);
    const holder = HOLDER.parse(req.params.name);
    res.json(await holderState(holder));
  })
);

//A missing seal secret is a deployment fault, not a client error: answer 503 so the
//mod can say "verification is down" instead of destroying items it cannot check.
magiRouter.use((err: unknown, _req: Request, _res: Response, next: NextFunction) => {
  next(err instanceof MagiUnconfigured ? new AppError(503, err.message, "misconfigured") : err);
});
