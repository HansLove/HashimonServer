//Applies schema.sql. Idempotent, so `npm run migrate` is safe to re-run. For
//Phase 1 this stands in for a real migration tool; adopt one (e.g. node-pg-migrate)
//once schema changes need ordering and rollback.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./pool";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "schema.sql"), "utf8");

try {
  await pool.query(sql);
  console.log("✓ schema applied");
} catch (err) {
  console.error("✗ migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
