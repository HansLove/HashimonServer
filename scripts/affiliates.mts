// El programa de afiliación entero, operado desde la terminal.
//
// No hay panel a propósito: con 3-5 afiliados, un panel es más código que
// mantener que valor que entrega, y el corte se hace una vez por semana.
//
//   pnpm affiliates alta DANIEL bc1q... [rate_bps] [--recruit]  alta de afiliado raíz
//   pnpm affiliates ligar DANIEL <usuario>                      ligarlo a su cuenta (abre el portal)
//   pnpm affiliates corte                                       qué se debe ahora mismo
//   pnpm affiliates pagado DANIEL <txid>                        marcar pagado, con recibo
//   pnpm affiliates quien DANIEL                                a quién trajo y cuánto compró
//   pnpm affiliates equipo DANIEL                               sus sub-afiliados
import { pool, query } from "@/db/pool";
import { affiliateLink, markPaid, pendingPayouts, subAffiliatesOf } from "@/domain/affiliates";

const usd = (v: string | number) => `$${Number(v).toFixed(2)}`;

async function alta(code: string, btcAddress: string, rateBps: string | undefined, recruit: boolean) {
  const bps = rateBps ? Number(rateBps) : 1500;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new Error(`rate_bps debe ser un entero entre 0 y 10000 (1500 = 15%), no "${rateBps}"`);
  }
  //Un afiliado nuevo no puede pisar a uno existente: el código es la clave con
  //la que se le paga, reasignarlo silenciosamente movería dinero de sitio.
  const res = await query<{ code: string; rate_bps: number }>(
    `INSERT INTO affiliates (code, btc_address, rate_bps, can_recruit)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO NOTHING
     RETURNING code, rate_bps`,
    [code.trim(), btcAddress.trim(), bps, recruit]
  );
  if (!res.rows[0]) {
    console.error(`✗ el código "${code}" ya existe — usa otro, o edítalo en la tabla a mano`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ alta ${res.rows[0].code} — ${(res.rows[0].rate_bps / 100).toFixed(2)}% a ${btcAddress}`);
  console.log(`  su enlace: ${affiliateLink(res.rows[0].code)}`);
  if (recruit) { console.log(`  puede reclutar sub-afiliados y cederles hasta su propia tasa`); }
  console.log(`  ahora lígalo a su cuenta:  pnpm affiliates ligar ${res.rows[0].code} <usuario>`);
}

//Sin esto el portal no reconoce a nadie: entra con la cuenta de Hashimon y
//resuelve el afiliado por player_id.
async function ligar(code: string, username: string) {
  const player = await query<{ id: string; username: string }>(
    `SELECT id, username FROM players WHERE lower(username) = lower($1)`,
    [username.trim()]
  );
  if (!player.rows[0]) {
    console.error(`✗ no existe ninguna cuenta "${username}" — que se registre primero en el sitio`);
    process.exitCode = 1;
    return;
  }
  //Una cuenta no puede ser dos afiliados: el índice parcial lo impediría, pero
  //avisar aquí da un mensaje entendible en vez de un error de Postgres.
  const taken = await query<{ code: string }>(
    `SELECT code FROM affiliates WHERE player_id = $1 AND lower(code) <> lower($2)`,
    [player.rows[0].id, code.trim()]
  );
  if (taken.rows[0]) {
    console.error(`✗ esa cuenta ya es el afiliado ${taken.rows[0].code}`);
    process.exitCode = 1;
    return;
  }
  const res = await query<{ code: string }>(
    `UPDATE affiliates SET player_id = $2 WHERE lower(code) = lower($1) RETURNING code`,
    [code.trim(), player.rows[0].id]
  );
  if (!res.rows[0]) {
    console.error(`✗ no existe el afiliado "${code}"`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${res.rows[0].code} ligado a la cuenta ${player.rows[0].username}`);
  console.log(`  ya puede entrar al portal con su usuario y contraseña de siempre`);
}

async function equipo(code: string) {
  const team = await subAffiliatesOf(code);
  if (team.length === 0) {
    console.log(`${code} no ha reclutado a nadie todavía.`);
    return;
  }
  console.log(`\nEQUIPO DE ${code.toUpperCase()}\n`);
  for (const m of team) {
    console.log(
      `  ${m.code.padEnd(16)} ${(m.rateBps / 100).toFixed(2).padStart(6)}%  ` +
        `${String(m.signups).padStart(3)} altas  ` +
        `le ha generado ${usd(m.overrideEarnedUsd)}${m.active ? "" : "  (inactivo)"}`
    );
  }
  console.log("");
}

async function corte() {
  const lines = await pendingPayouts();
  if (lines.length === 0) {
    console.log("Nada pendiente de pago.");
    return;
  }
  let total = 0;
  console.log("\nPENDIENTE DE PAGO\n");
  for (const line of lines) {
    total += Number(line.total_usd);
    console.log(
      `  ${line.code.padEnd(14)} ${usd(line.total_usd).padStart(10)}` +
        `  (${line.commission_count} compra${line.commission_count === 1 ? "" : "s"})` +
        `  → ${line.btc_address ?? "SIN DIRECCIÓN BTC"}`
    );
  }
  console.log(`\n  ${"TOTAL".padEnd(14)} ${usd(total).padStart(10)}\n`);
  console.log("Paga a mano y registra cada uno con:  pnpm affiliates pagado <CODE> <txid>\n");
}

async function pagado(code: string, txid: string) {
  //El txid es el único recibo que va a existir. Sin él la fila queda 'accrued'
  //y vuelve a salir en el siguiente corte, que es el comportamiento correcto:
  //mejor pagar dos veces por error visible que dar por pagado lo que no se pagó.
  if (!/^[0-9a-fA-F]{64}$/.test(txid.trim())) {
    throw new Error(`"${txid}" no parece un txid de Bitcoin (64 hex)`);
  }
  const { count, totalUsd } = await markPaid(code, txid.trim());
  if (count === 0) {
    console.error(`✗ ${code} no tenía nada pendiente — ¿ya se marcó este corte?`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${code}: ${count} comisión(es) por ${usd(totalUsd)} marcadas como pagadas`);
}

async function quien(code: string) {
  const res = await query<{
    username: string | null;
    referred_at: string;
    purchases: number;
    spent_usd: string | null;
    earned_usd: string | null;
  }>(
    `SELECT pl.username,
            pl.referred_at,
            COUNT(pay.order_id) FILTER (WHERE pay.status = 'settled')::int AS purchases,
            SUM(pay.amount_usd) FILTER (WHERE pay.status = 'settled')      AS spent_usd,
            (SELECT SUM(c.amount_usd) FROM commissions c WHERE c.buyer_id = pl.id) AS earned_usd
       FROM players pl
       LEFT JOIN payments pay ON pay.player_id = pl.id
      WHERE lower(pl.referred_by) = lower($1)
      GROUP BY pl.id, pl.username, pl.referred_at
      ORDER BY pl.referred_at DESC`,
    [code]
  );
  if (res.rows.length === 0) {
    console.log(`${code} todavía no ha traído a nadie.`);
    return;
  }
  console.log(`\nTRAÍDOS POR ${code.toUpperCase()}\n`);
  for (const r of res.rows) {
    const when = new Date(r.referred_at).toISOString().slice(0, 10);
    console.log(
      `  ${(r.username ?? "—").padEnd(20)} ${when}  ` +
        `${r.purchases} compra(s), gastó ${usd(r.spent_usd ?? 0)}, generó ${usd(r.earned_usd ?? 0)}`
    );
  }
  console.log("");
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "alta": {
      if (args.length < 2) { throw new Error("uso: pnpm affiliates alta <CODE> <btc_address> [rate_bps] [--recruit]"); }
      const recruit = args.includes("--recruit");
      const rate = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
      await alta(args[0]!, args[1]!, rate, recruit);
      break;
    }
    case "ligar":
      if (args.length < 2) { throw new Error("uso: pnpm affiliates ligar <CODE> <usuario>"); }
      await ligar(args[0]!, args[1]!);
      break;
    case "equipo":
      if (args.length < 1) { throw new Error("uso: pnpm affiliates equipo <CODE>"); }
      await equipo(args[0]!);
      break;
    case "corte":
      await corte();
      break;
    case "pagado":
      if (args.length < 2) { throw new Error("uso: pnpm affiliates pagado <CODE> <txid>"); }
      await pagado(args[0]!, args[1]!);
      break;
    case "quien":
      if (args.length < 1) { throw new Error("uso: pnpm affiliates quien <CODE>"); }
      await quien(args[0]!);
      break;
    default:
      console.log("comandos: alta | ligar | corte | pagado | quien | equipo");
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
