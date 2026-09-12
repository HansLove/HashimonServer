import { config } from "@/modules/core/config";
import { birthKindLabel } from "@/modules/core/core/birth-identity";
import { isUniqueViolation, query, type Sql } from "@/modules/core/db/pool";
import { AppError } from "@/modules/core/http/errors";
import { enrich } from "@/modules/core/http/wide-event";

//Afiliación energética: introducing brokers, en dos niveles.
//
//Un afiliado raíz tiene un trato directo con la casa (su rate_bps). Si puede
//reclutar, crea sub-afiliados y les CEDE parte de su propia tasa: Daniel al 15%
//que le da 10% a alguien cobra el 5% restante de lo que ese alguien traiga.
//Cederle los 15 enteros es legal y le deja 0 — es su decisión de negocio, no un
//error que el sistema deba impedirle.
//
//Tres garantías viven en SQL y no en un `if`, porque BTCPay reentrega webhooks
//y "esto ya pasó" es el caso normal:
//  - un pago paga a cada beneficiario una sola vez → commissions_order_code_idx
//  - cambiar una tasa no revalúa lo ya devengado    → rate_bps congelado en la fila
//  - nadie cobra de su propia compra                → el guard en accrueCommission

//Un código viaja en una URL y lo teclea gente: sin espacios, sin acentos, y
//corto. Lo que sobrevive a un copiar/pegar por WhatsApp.
const CODE_RE = /^[A-Za-z0-9_-]{3,20}$/;

export interface AffiliateRow {
  code: string;
  player_id: string | null;
  rate_bps: number;
  btc_address: string | null;
  active: boolean;
  note: string | null;
  parent_code: string | null;
  can_recruit: boolean;
  display_name: string | null;
  created_at: Date;
}

/** El enlace que el afiliado copia y pega. Apunta al sitio público, no al portal. */
export function affiliateLink(code: string): string {
  return `${config.publicSiteUrl}/?ref=${encodeURIComponent(code)}`;
}

/**
 * Resolver un código de referido tal y como lo tecleó una persona.
 *
 * Devuelve el código **canónico** (la capitalización con la que está guardado),
 * nunca lo que llegó del cliente — así `?ref=daniel` y `?ref=DANIEL` acaban en
 * la misma fila y el corte del viernes no se parte en dos líneas.
 *
 * Un código inexistente, inactivo o basura devuelve null en vez de lanzar: un
 * enlace mal copiado nunca debe impedir que alguien se registre. Quien lo
 * refirió pierde la comisión, que es el fallo barato de los dos.
 */
export async function resolveAffiliateCode(raw: string | undefined | null): Promise<string | null> {
  if (!raw) { return null; }
  const candidate = raw.trim();
  if (!candidate || candidate.length > 40) { return null; }

  const res = await query<{ code: string }>(
    `SELECT code FROM affiliates WHERE lower(code) = lower($1) AND active`,
    [candidate]
  );
  return res.rows[0]?.code ?? null;
}

/**
 * Devengar las comisiones de un cobro que acaba de liquidar. Hasta dos filas:
 * el afiliado directo, y su padre por el diferencial de tasa.
 *
 * Se llama **dentro de la transacción de settleAndCredit**, con su mismo client:
 * las comisiones y los créditos del comprador se confirman juntos o no ocurre
 * ninguno. Por eso este INSERT no puede fallar por lógica de negocio — no hay
 * ningún camino en el que una comisión bloquee el acreditamiento de un pago:
 *
 *   - comprador sin referido        → el JOIN no produce filas, no inserta nada
 *   - afiliado desactivado          → igual, el JOIN lo filtra
 *   - sin padre, o padre sin margen → la segunda rama no produce fila
 *   - webhook reentregado           → ON CONFLICT lo absorbe
 *
 * El importe sale de `payments.amount_usd` leído aquí dentro, nunca de un
 * parámetro: se comisiona lo que quedó en el libro, no lo que pase un argumento.
 */
export async function accrueCommission(client: Sql, orderId: string): Promise<void> {
  const res = await query<{ code: string; amount_usd: string }>(
    `WITH ctx AS (
       SELECT pay.order_id,
              pay.player_id,
              pay.amount_usd,
              direct.code     AS direct_code,
              direct.rate_bps AS direct_rate,
              parent.code     AS parent_code,
              parent.rate_bps AS parent_rate
         FROM payments   pay
         JOIN players    pl     ON pl.id = pay.player_id
         JOIN affiliates direct ON direct.code = pl.referred_by AND direct.active
         --El override sólo existe si el padre sigue activo. Si lo desactivaron,
         --el sub cobra lo suyo igual: su trato es con la casa, no con su padre.
         LEFT JOIN affiliates parent
                ON parent.code = direct.parent_code AND parent.active
        WHERE pay.order_id = $1
          --Nadie cobra de su propia compra. Un afiliado que se auto-refiere se
          --estaría dando un descuento permanente pagado por la casa.
          AND (direct.player_id IS NULL OR direct.player_id <> pay.player_id)
     )
     INSERT INTO commissions (order_id, code, source_code, buyer_id, amount_usd, rate_bps)
     SELECT order_id, direct_code, direct_code, player_id,
            ROUND(amount_usd * direct_rate / 10000.0, 2), direct_rate
       FROM ctx
     UNION ALL
     --El diferencial. Si el padre cedió su tasa entera (parent_rate = direct_rate)
     --esta rama no produce fila: no se insertan comisiones de importe cero.
     SELECT order_id, parent_code, direct_code, player_id,
            ROUND(amount_usd * (parent_rate - direct_rate) / 10000.0, 2),
            parent_rate - direct_rate
       FROM ctx
      WHERE parent_code IS NOT NULL AND parent_rate > direct_rate
     ON CONFLICT (order_id, code) DO NOTHING
     RETURNING code, amount_usd`,
    [orderId],
    client
  );

  //Sólo se enriquece cuando hubo comisión: un campo a null en cada compra sin
  //referido no dice nada y ensucia la consulta que este evento existe para responder.
  if (res.rows.length > 0) {
    enrich({
      affiliate_codes: res.rows.map((r) => r.code).join(","),
      affiliate_commission_usd: res.rows.reduce((sum, r) => sum + Number(r.amount_usd), 0),
      affiliate_payees: res.rows.length,
    });
  }
}

// ─── Portal ──────────────────────────────────────────────────────────────────

/** El afiliado ligado a una sesión, o null si ese jugador no lo es. */
export async function affiliateForPlayer(playerId: string): Promise<AffiliateRow | null> {
  const res = await query<AffiliateRow>(
    `SELECT * FROM affiliates WHERE player_id = $1 AND active`,
    [playerId]
  );
  return res.rows[0] ?? null;
}

export async function affiliateByCode(code: string): Promise<AffiliateRow | null> {
  const res = await query<AffiliateRow>(
    `SELECT * FROM affiliates WHERE lower(code) = lower($1)`,
    [code]
  );
  return res.rows[0] ?? null;
}

export interface AffiliateSummary {
  code: string;
  displayName: string | null;
  link: string;
  rateBps: number;
  canRecruit: boolean;
  parentCode: string | null;
  btcAddress: string | null;
  /** Cuánta gente entró por su enlace, haya comprado o no. */
  signups: number;
  /** Cuántos de esos han comprado al menos una vez. */
  buyers: number;
  /** Devengado y todavía sin pagar. Es lo que verá en el corte del viernes. */
  pendingUsd: string;
  /** Ya liquidado, histórico. */
  paidUsd: string;
  subAffiliates: number;
}

/**
 * Todo lo que el portal enseña en su pantalla principal, en una consulta por
 * bloque. Los importes se suman con COALESCE a 0 para que un afiliado nuevo vea
 * "$0.00" y no una pantalla rota con nulls.
 */
export async function affiliateSummary(code: string): Promise<AffiliateSummary | null> {
  const affiliate = await affiliateByCode(code);
  if (!affiliate) { return null; }

  const stats = await query<{
    signups: number;
    buyers: number;
    pending_usd: string;
    paid_usd: string;
    sub_affiliates: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM players
         WHERE lower(referred_by) = lower($1))                              AS signups,
       --Un comprador es alguien con al menos un cobro liquidado. Se cuenta
       --desde payments y no desde commissions porque una comisión de override
       --se paga a otra persona: el cliente sigue siendo del sub.
       (SELECT COUNT(DISTINCT pay.player_id)::int
          FROM payments pay
          JOIN players pl ON pl.id = pay.player_id
         WHERE lower(pl.referred_by) = lower($1)
           AND pay.status = 'settled')                                      AS buyers,
       (SELECT COALESCE(SUM(amount_usd), 0) FROM commissions
         WHERE lower(code) = lower($1) AND status = 'accrued')              AS pending_usd,
       (SELECT COALESCE(SUM(amount_usd), 0) FROM commissions
         WHERE lower(code) = lower($1) AND status = 'paid')                 AS paid_usd,
       (SELECT COUNT(*)::int FROM affiliates
         WHERE lower(parent_code) = lower($1))                              AS sub_affiliates`,
    [affiliate.code]
  );
  const row = stats.rows[0]!;

  return {
    code: affiliate.code,
    displayName: affiliate.display_name,
    link: affiliateLink(affiliate.code),
    rateBps: affiliate.rate_bps,
    canRecruit: affiliate.can_recruit,
    parentCode: affiliate.parent_code,
    btcAddress: affiliate.btc_address,
    signups: row.signups,
    buyers: row.buyers,
    pendingUsd: Number(row.pending_usd).toFixed(2),
    paidUsd: Number(row.paid_usd).toFixed(2),
    subAffiliates: row.sub_affiliates,
  };
}

export interface ReferralLine {
  /** Nunca el username real de otra persona: el portal no es un directorio. */
  label: string;
  /** Espíritu + elemento, p.ej. "Guardian Air". Null si aún no tiene Genesis. */
  hashimon: string | null;
  joinedAt: string;
  purchases: number;
  spentUsd: string;
  earnedUsd: string;
}

/**
 * La gente que entró por su enlace.
 *
 * Deliberadamente **sin identidad**: un afiliado no tiene por qué ver el nombre
 * de usuario de un cliente, y menos su correo. Ve una etiqueta estable, cuándo
 * llegó, qué Hashimon le tocó y cuánto ha generado — que es todo lo que
 * necesita para saber si su tráfico sirve.
 */
export async function referralsOf(code: string, limit = 100): Promise<ReferralLine[]> {
  const res = await query<{
    label: string;
    birth_spirit: string | null;
    genesis_element: string | null;
    joined_at: string;
    purchases: number;
    spent_usd: string;
    earned_usd: string;
  }>(
    `SELECT
       --Primeros 4 del uuid: estable, opaco, suficiente para distinguir filas.
       'Cliente ' || substr(pl.id::text, 1, 4)                        AS label,
       pl.birth_spirit,
       pl.genesis_element,
       pl.referred_at                                                 AS joined_at,
       COUNT(pay.order_id) FILTER (WHERE pay.status = 'settled')::int AS purchases,
       COALESCE(SUM(pay.amount_usd) FILTER (WHERE pay.status = 'settled'), 0) AS spent_usd,
       COALESCE((SELECT SUM(c.amount_usd) FROM commissions c
                  WHERE c.buyer_id = pl.id AND lower(c.code) = lower($1)), 0) AS earned_usd
       FROM players pl
       LEFT JOIN payments pay ON pay.player_id = pl.id
      WHERE lower(pl.referred_by) = lower($1)
      GROUP BY pl.id, pl.birth_spirit, pl.genesis_element, pl.referred_at
      ORDER BY pl.referred_at DESC
      LIMIT $2`,
    [code, limit]
  );
  return res.rows.map((r) => ({
    label: r.label,
    hashimon: birthKindLabel(r.birth_spirit, r.genesis_element),
    joinedAt: new Date(r.joined_at).toISOString(),
    purchases: r.purchases,
    spentUsd: Number(r.spent_usd).toFixed(2),
    earnedUsd: Number(r.earned_usd).toFixed(2),
  }));
}

export interface CommissionLine {
  date: string;
  amountUsd: string;
  rateBps: number;
  status: string;
  /** De qué línea vino: su propio código, o el del sub que trajo al cliente. */
  sourceCode: string | null;
  payoutTxid: string | null;
}

export async function commissionsOf(code: string, limit = 200): Promise<CommissionLine[]> {
  const res = await query<{
    created_at: string;
    amount_usd: string;
    rate_bps: number;
    status: string;
    source_code: string | null;
    payout_txid: string | null;
  }>(
    `SELECT created_at, amount_usd, rate_bps, status, source_code, payout_txid
       FROM commissions
      WHERE lower(code) = lower($1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [code, limit]
  );
  return res.rows.map((r) => ({
    date: new Date(r.created_at).toISOString(),
    amountUsd: Number(r.amount_usd).toFixed(2),
    rateBps: r.rate_bps,
    status: r.status,
    sourceCode: r.source_code,
    payoutTxid: r.payout_txid,
  }));
}

export interface SubAffiliateLine {
  code: string;
  displayName: string | null;
  link: string;
  rateBps: number;
  active: boolean;
  signups: number;
  /** Lo que ESTE padre ha ganado por el diferencial de este sub. */
  overrideEarnedUsd: string;
  createdAt: string;
}

/** El equipo de un superafiliado, con lo que cada uno le ha producido. */
export async function subAffiliatesOf(parentCode: string): Promise<SubAffiliateLine[]> {
  const res = await query<{
    code: string;
    display_name: string | null;
    rate_bps: number;
    active: boolean;
    created_at: string;
    signups: number;
    override_earned_usd: string;
  }>(
    `SELECT a.code, a.display_name, a.rate_bps, a.active, a.created_at,
            (SELECT COUNT(*)::int FROM players pl
              WHERE lower(pl.referred_by) = lower(a.code))          AS signups,
            COALESCE((SELECT SUM(c.amount_usd) FROM commissions c
                       WHERE lower(c.source_code) = lower(a.code)
                         AND lower(c.code) = lower($1)), 0)         AS override_earned_usd
       FROM affiliates a
      WHERE lower(a.parent_code) = lower($1)
      ORDER BY a.created_at DESC`,
    [parentCode]
  );
  return res.rows.map((r) => ({
    code: r.code,
    displayName: r.display_name,
    link: affiliateLink(r.code),
    rateBps: r.rate_bps,
    active: r.active,
    signups: r.signups,
    overrideEarnedUsd: Number(r.override_earned_usd).toFixed(2),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Un superafiliado crea a alguien de su equipo y le cede parte de su tasa.
 *
 * Las cuatro reglas que se hacen cumplir aquí, y por qué:
 *  - sólo un afiliado con `can_recruit` recluta;
 *  - sólo un afiliado **raíz** recluta, que es lo que mantiene el árbol en dos
 *    niveles — si un sub reclutara, su override tendría que salir del override
 *    de su padre y el cálculo se vuelve recursivo;
 *  - la tasa cedida nunca supera la del padre (cederla entera sí se permite:
 *    deja al padre en 0, y es su decisión);
 *  - el código es único, lo valida el índice y no un SELECT previo.
 */
export async function createSubAffiliate(
  parent: AffiliateRow,
  input: { code: string; rateBps: number; displayName?: string; btcAddress?: string }
): Promise<AffiliateRow> {
  if (!parent.can_recruit) {
    throw new AppError(403, "este afiliado no puede reclutar", "cannot_recruit");
  }
  if (parent.parent_code) {
    throw new AppError(403, "un sub-afiliado no puede reclutar a su vez", "depth_limit");
  }
  const code = input.code.trim();
  if (!CODE_RE.test(code)) {
    throw new AppError(422, "el código admite 3-20 caracteres: letras, números, _ y -", "invalid_code");
  }
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0) {
    throw new AppError(422, "la tasa debe ser un entero en puntos básicos", "invalid_rate");
  }
  if (input.rateBps > parent.rate_bps) {
    throw new AppError(
      422,
      `no puedes ceder más de tu propia tasa (${(parent.rate_bps / 100).toFixed(2)}%)`,
      "rate_above_parent"
    );
  }

  try {
    const res = await query<AffiliateRow>(
      `INSERT INTO affiliates (code, parent_code, rate_bps, display_name, btc_address, can_recruit)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING *`,
      [code, parent.code, input.rateBps, input.displayName?.trim() || null, input.btcAddress?.trim() || null]
    );
    return res.rows[0]!;
  } catch (err: unknown) {
    //Sin SELECT previo: el índice es lo que hace esto seguro contra dos pestañas
    //creando el mismo código en el mismo tick.
    if (isUniqueViolation(err, "affiliates_code_lower_idx") || isUniqueViolation(err, "affiliates_pkey")) {
      throw new AppError(409, "ese código ya está tomado", "code_taken");
    }
    throw err;
  }
}

// ─── Corte semanal ───────────────────────────────────────────────────────────

export interface PayoutLine {
  code: string;
  btc_address: string | null;
  commission_count: number;
  total_usd: string;
}

/**
 * El corte del viernes: qué se le debe a cada afiliado ahora mismo.
 *
 * Una línea por afiliado con algo pendiente — es la lista desde la que se pagan
 * las transferencias a mano, no un reporte de negocio.
 */
export async function pendingPayouts(): Promise<PayoutLine[]> {
  const res = await query<PayoutLine>(
    `SELECT c.code,
            a.btc_address,
            COUNT(*)::int      AS commission_count,
            SUM(c.amount_usd)  AS total_usd
       FROM commissions c
       JOIN affiliates  a ON a.code = c.code
      WHERE c.status = 'accrued'
      GROUP BY c.code, a.btc_address
      ORDER BY SUM(c.amount_usd) DESC`
  );
  return res.rows;
}

/**
 * Marcar como pagado todo lo devengado de un afiliado, con el txid como recibo.
 *
 * El guard `status = 'accrued'` es lo que hace que correr esto dos veces con el
 * mismo txid no re-marque comisiones de un corte anterior: la segunda vez no
 * encuentra filas y devuelve 0.
 */
export async function markPaid(
  code: string,
  txid: string
): Promise<{ count: number; totalUsd: string }> {
  const res = await query<{ amount_usd: string }>(
    `UPDATE commissions
        SET status = 'paid', payout_txid = $2, paid_at = now()
      WHERE lower(code) = lower($1) AND status = 'accrued'
      RETURNING amount_usd`,
    [code, txid]
  );
  const totalUsd = res.rows
    .reduce((sum, row) => sum + Number(row.amount_usd), 0)
    .toFixed(2);
  return { count: res.rowCount ?? 0, totalUsd };
}
