import "dotenv/config";
import { CORE_VERSION } from "@/core/index";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`config: ${name} is required when HASHIMON_MINING_MODE=bitcoin and was not set`);
  }
  return value;
}

const DEFAULT_CORS_ORIGINS = [
  "https://ihashima.com",
  "https://www.ihashima.com",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8081",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

function parseCorsOrigin(raw: string | undefined): string[] {
  const extra = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEFAULT_CORS_ORIGINS, ...extra])];
}

// "bitcoin" requires a client that implements hashBitcoinJob (src/core/pow.ts) —
// flipping this without a matching client rejects every share. Default stays "bound".
const miningMode = (process.env.HASHIMON_MINING_MODE === "bitcoin" ? "bitcoin" : "bound") as "bound" | "bitcoin";

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/hashimon",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 720),
  //Se deriva de CORE_VERSION en vez de repetir el literal. Estaban desfasados:
  //el log decía algo_version "caos-core@1" mientras las criaturas se sellaban
  //con "caos-core@2" (hashimons.ts usa CORE_VERSION directamente). El campo del
  //log es lo que se consulta para saber qué reglas produjeron una fila, así que
  //mentir ahí es peor que no tenerlo.
  //Anthropic. Sin clave, la ruta /chat responde 503 y lo dice: nunca falla en
  //silencio ni cae a un modelo distinto sin avisar.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Required for multi-workspace / identity-linked keys (header anthropic-workspace-id).
  // Find it in Claude Console → Settings → Workspaces (wrkspc_…).
  anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
  //Turnos gratis por criatura antes de empezar a cobrar créditos.
  chatFreeTurns: Number(process.env.CHAT_FREE_TURNS ?? 20),
  //Créditos por turno una vez agotado el cupo.
  chatCreditsPerTurn: Number(process.env.CHAT_CREDITS_PER_TURN ?? 1),
  algoVersion: process.env.ALGO_VERSION ?? CORE_VERSION,
  // Stamped on every log event so a failure can be traced back to the deploy that
  // shipped it. The image has no .git, so the Dockerfile bakes it in as a build arg.
  commitSha: process.env.COMMIT_SHA ?? "dev",
  shareTargetBits: Number(process.env.HASHIMON_SHARE_TARGET_BITS ?? 20),
  jobTtlMs: Number(process.env.HASHIMON_JOB_TTL_MS ?? 900_000),
  blockTargetBits: Number(process.env.HASHIMON_BLOCK_TARGET_BITS ?? 64),
  // Always includes https://ihashima.com; CORS_ORIGIN adds more origins.
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  luantiServerSecret: process.env.LUANTI_SERVER_SECRET ?? "",
  // Hace AUDITABLE la semilla de nacimiento: con ella, cada birth_nonce es
  // recomputable desde su entrada, así que el servidor puede demostrar que no
  // molió nonces para fabricar una criatura rara. Vacío = randomBytes puro; se
  // pierde la auditabilidad, no la seguridad, y nunca bloquea un nacimiento.
  birthSecret: process.env.BIRTH_SECRET ?? "",
  // MAGI (finite cubic object). The seal secret is what makes a note unforgeable:
  // it never leaves this process, so a player editing item metadata cannot produce a
  // seal that verifies. Empty means the MAGI routes answer 503 rather than issue
  // notes nobody can trust.
  magiSealSecret: process.env.MAGI_SEAL_SECRET ?? "",
  // Hard ceiling on notes ever issued. Issuance past it is refused — the point of the
  // object is that no admin can silently print more.
  magiSupplyCap: Number(process.env.MAGI_SUPPLY_CAP ?? 21_000),
  // Backing recorded on each note at issue time. Not a redemption promise.
  magiSatsPerMagi: Number(process.env.MAGI_SATS_PER_MAGI ?? 1_000),
  // Reserve epoch stamped into every seal, so notes from a past epoch are
  // distinguishable (and re-sealable) without touching the ledger rows.
  magiEpoch: Number(process.env.MAGI_EPOCH ?? 1),
  // Bitcoin Core RPC URL with basic-auth credentials embedded (user:pass@host:port).
  // Never log this value — see src/domain/block-template.ts.
  btcNodeUrl: process.env.BTC_NODE_CONNECTION_URL ?? "",
  miningMode,
  templateRefreshMs: Number(process.env.HASHIMON_TEMPLATE_REFRESH_MS ?? 30_000),
  // Segwit address (bech32/bech32m) the coinbase output pays — never submitted to the
  // network today, but a real address keeps the template well-formed instead of an
  // unspendable OP_RETURN. Required only in bitcoin mode, no default — see
  // src/domain/bitcoin-address.ts.
  coinbaseAddress: miningMode === "bitcoin" ? requireEnv("HASHIMON_COINBASE_ADDRESS") : (process.env.HASHIMON_COINBASE_ADDRESS ?? ""),
  // BTCPay Server — credit purchases. The middleware reads these env names on its own,
  // but config stays the single source and hands them to configure() explicitly.
  // btcpayApiKey and btcpayWebhookSecret are secrets: never log them, never enrich() them.
  btcpayBaseUrl: process.env.BTCPAY_BASE_URL ?? "",
  btcpayApiKey: process.env.BTCPAY_API_KEY ?? "",
  btcpayStoreId: process.env.BTCPAY_STORE_ID ?? "",
  btcpayWebhookSecret: process.env.BTCPAY_WEBHOOK_SECRET ?? "",
} as const;
