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
} as const;
