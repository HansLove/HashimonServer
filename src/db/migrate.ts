//Applies schema.sql. Idempotent, so `npm run migrate` is safe to re-run. For
//Phase 1 this stands in for a real migration tool; adopt one (e.g. node-pg-migrate)
//once schema changes need ordering and rollback.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "@/db/pool";

//schema.sql se lee JUNTO a este archivo, así que cuál se aplica depende de
//desde dónde se ejecuta:
//
//  pnpm migrate:dev  -> src/db/schema.sql   (la fuente de verdad, para desarrollo)
//  pnpm migrate      -> dist/db/schema.sql  (la copia que `pnpm build` deposita)
//
//`pnpm migrate` sin `pnpm build` previo aplica una copia VIEJA y reporta éxito.
//Ese fallo silencioso ya costó una sesión de depuración: el registro moría con
//`column "birth_spirit" of relation "players" does not exist` mientras el
//esquema en src ya la tenía. Por eso el script avisa de qué archivo leyó.
const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "schema.sql");
const sql = readFileSync(schemaPath, "utf8");
console.log(`applying ${schemaPath}`);

try {
  await pool.query(sql);
  console.log("✓ schema applied");
} catch (err) {
  console.error("✗ migration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
