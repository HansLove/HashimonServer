import { query } from "@/db/pool";
import { AppError } from "@/http/errors";

//The credit catalogue. Its whole job is that the price lives on the server: a
//request carries a sku, the amount is looked up here, and nothing a client sends
//can influence it.

//price_usd stays a string all the way to the ledger. pg returns numeric as a
//string (db/pool.ts only overrides int8) and that is the form to keep for money —
//it is the presented view, not the stored snapshot, that turns it into a number.
export interface CreditPlanRow {
  sku: string;
  credits: number;
  price_usd: string;
  sort_order: number;
  is_active: boolean;
}

export interface CreditPlan {
  sku: string;
  credits: number;
  priceUsd: number;
}

/** The catalogue as the client sees it: active plans only, in display order. */
export async function listActivePlans(): Promise<CreditPlan[]> {
  const { rows } = await query<CreditPlanRow>(
    `SELECT sku, credits, price_usd, sort_order, is_active
       FROM credits_plans
      WHERE is_active
      ORDER BY sort_order, sku`
  );
  return rows.map(presentPlan);
}

/**
 * Resolve the sku a client asked for, or refuse. 400 rather than 404 on purpose:
 * the sku came from GET /payments/plans, so an unknown or retired one is a
 * malformed request, not a missing resource.
 */
export async function planFor(sku: string): Promise<CreditPlanRow> {
  const { rows } = await query<CreditPlanRow>(
    `SELECT sku, credits, price_usd, sort_order, is_active
       FROM credits_plans
      WHERE sku = $1 AND is_active`,
    [sku]
  );
  const plan = rows[0];
  if (!plan) {
    throw new AppError(400, `planFor: sku "${sku}" is unknown or no longer for sale`, "bad_request");
  }
  return plan;
}

function presentPlan(row: CreditPlanRow): CreditPlan {
  return { sku: row.sku, credits: row.credits, priceUsd: Number(row.price_usd) };
}
