import "dotenv/config";

function parseCorsOrigin(raw: string | undefined): string | string[] {
  const value = raw ?? "http://localhost:8080";
  if (value.includes(",")) {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/hashimon",
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 720),
  algoVersion: process.env.ALGO_VERSION ?? "caos-core@1",
  shareTargetBits: Number(process.env.HASHIMON_SHARE_TARGET_BITS ?? 12),
  jobTtlMs: Number(process.env.HASHIMON_JOB_TTL_MS ?? 900_000),
  blockTargetBits: Number(process.env.HASHIMON_BLOCK_TARGET_BITS ?? 64),
  // Comma-separated list allowed (e.g. game + Lovable preview URL).
  corsOrigin: parseCorsOrigin(process.env.CORS_ORIGIN),
  luantiServerSecret: process.env.LUANTI_SERVER_SECRET ?? "",
  // Bitcoin Core RPC URL with basic-auth credentials embedded (user:pass@host:port).
  // Never log this value — see src/domain/block-template.ts.
  btcNodeUrl: process.env.BTC_NODE_CONNECTION_URL ?? "",
  // "bitcoin" requires a client that implements hashBitcoinJob (src/core/pow.ts) —
  // flipping this without a matching client rejects every share. Default stays "bound".
  miningMode: (process.env.HASHIMON_MINING_MODE === "bitcoin" ? "bitcoin" : "bound") as "bound" | "bitcoin",
  templateRefreshMs: Number(process.env.HASHIMON_TEMPLATE_REFRESH_MS ?? 30_000),
} as const;
