import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`config: ${name} is required when HASHIMON_MINING_MODE=bitcoin and was not set`);
  }
  return value;
}

function parseCorsOrigin(raw: string | undefined): string | string[] {
  const value = raw ?? "http://localhost:8080";
  if (value.includes(",")) {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return value;
}

// "bitcoin" requires a client that implements hashBitcoinJob (src/core/pow.ts) —
// flipping this without a matching client rejects every share. Default stays "bound".
const miningMode = (process.env.HASHIMON_MINING_MODE === "bitcoin" ? "bitcoin" : "bound") as "bound" | "bitcoin";

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/hashimon",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 720),
  algoVersion: process.env.ALGO_VERSION ?? "caos-core@1",
  shareTargetBits: Number(process.env.HASHIMON_SHARE_TARGET_BITS ?? 20),
  jobTtlMs: Number(process.env.HASHIMON_JOB_TTL_MS ?? 900_000),
  blockTargetBits: Number(process.env.HASHIMON_BLOCK_TARGET_BITS ?? 64),
  // Comma-separated list allowed (e.g. game + Lovable preview URL).
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  luantiServerSecret: process.env.LUANTI_SERVER_SECRET ?? "",
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
} as const;
