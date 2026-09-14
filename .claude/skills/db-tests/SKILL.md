---
name: db-tests
description: Run hashimon-server's test suites with a Postgres preflight — probe the database, start it if it is down (docker container or native daemon), apply the schema with migrate:dev, then run pnpm test or a single test file. Use this whenever the user asks to run the tests, "corre los tests", verify a change against the database, or run any of the DB-backed suites (auth, payments, affiliates, incubation, food, wolkers, armies), and whenever tests fail with "Connection terminated due to connection timeout", "timeout expired", ECONNREFUSED, `database "..." does not exist` or `column "..." does not exist`, even if Postgres is never mentioned.
---

# Run the DB-backed tests

Half the suites need a live Postgres. Without one, `pnpm test` reports around 30
failures that all read as connection timeouts — they look like regressions but are
environmental. Postgres may run in a container or as a native daemon depending on the
machine, so detect which instead of assuming.

Run every command from the repo root.

## 1. Probe

```bash
node .claude/skills/db-tests/probe-db.mjs
```

The probe resolves `DATABASE_URL` exactly as the server and the suites do (dotenv, then
the `config.ts` fallback) and prints only `user@host:port/db`. Do not read `.env`
yourself: it holds payment and API secrets, and the target line is all the diagnosis
needs.

- `db: reachable <target>` (exit 0): go to step 4.
- `probe-db: <code> <message> target=<target>` (exit 1): go to step 2.

## 2. Diagnose

| Code | Meaning | Action |
|---|---|---|
| `ECONNREFUSED`, `TIMEOUT` | Nothing is answering | Step 3 |
| `3D000` | Server is up, the database does not exist | Offer to create it — container: `docker exec <container> createdb -U <user> <db>`; native: `createdb -h <host> -p <port> -U <user> <db>`. Run it once the user agrees, then step 4 |
| `28P01`, `28000`, `NOCODE` with a `SASL`/password message | Password or role rejected | Stop. Report the target and ask the user to fix `DATABASE_URL` in `.env`. Never edit `.env` or try other credentials |
| anything else (`ENOTFOUND`, other `NOCODE`, ...) | Misconfigured target | Report verbatim and stop |

Some sandboxes hang on a refused local connection until the 3 s timeout instead of
failing fast, so `TIMEOUT` against a local host means the same as `ECONNREFUSED`.

If the host is not local (`localhost`, `127.0.0.1`, `::1`), it is someone else's
database: start nothing and report.

## 3. Start Postgres

**Container.** List candidates:

```bash
docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
```

Look for images named `postgres` or `postgis/postgis` with any tag, by reading the list —
`--filter ancestor=postgres` misses tagged images such as `postgres:18`. For each
candidate, `docker inspect -f '{{json .HostConfig.PortBindings}}' <name>` shows which host
port it publishes; the one matching the probe's port is the database.

- Exactly one match, exited: `docker start <name>`, and remember that you started it.
- Several matches on that port: ask the user which one.
- A match already running while the probe still fails: it may just be booting; continue
  with the wait below.

**Native daemon.** When there is no docker or no matching container, look for a
system service: `systemctl is-active postgresql` (on Debian/Ubuntu, `pg_lsclusters`
lists clusters and ports), `brew services list` on macOS, or Postgres.app in
`/Applications`. Never start it yourself with sudo — the password prompt hangs the Bash
tool, and starting system services is the user's decision. Ask the user to run it, e.g.
`! sudo systemctl start postgresql`, `! brew services start postgresql@16`, or to open
Postgres.app.

**Nothing found.** Tell the user no Postgres is available (the server needs Postgres
13 or newer; see README.md) and stop.

Then wait for it to accept connections:

```bash
node .claude/skills/db-tests/probe-db.mjs --wait 30
```

`--wait` retries once per second, since a foreground `sleep` is blocked in the Bash tool.
A still-failing probe goes back to step 2 with its new code.

## 4. Migrate

```bash
pnpm migrate:dev
```

Never `pnpm migrate`: it applies the copy of the schema in `dist/`, which is stale unless
you just built, and still prints `✓ schema applied` — the damage surfaces later as
`column "..." does not exist` inside a test. A project hook blocks it when `dist/` is
stale. `schema.sql` is idempotent, so migrating on every run is safe.

## 5. Run

- Full suite: `pnpm test`. It runs only the files listed in `package.json`.
- One file: `node --import tsx --test <file>`; narrow to one test with
  `--test-name-pattern "<regex>"`.

**`pnpm test` includes `src/modules/alen/domain/alen-planner.test.ts`, which deletes every
row of `alen_plans`, `alen_orders`, `alen_events` and `alen_state`** (unconditional
`wipe()` in its setup). On a development database that wipes real Alen state. Before the
full suite, confirm the user accepts losing those tables or points `DATABASE_URL` at a
disposable database; otherwise run the other files individually.

## 6. Report

- The counts from node:test's closing summary (`# tests`, `# pass`, `# fail` — the Bash
  tool is not a TTY, so the reporter is TAP; the output is long, so redirect it to a file
  and read the tail).
- Every failure verbatim — test name plus its error or assertion diff — not paraphrased.
  Separate environmental failures (connection, missing database) from real ones.
- If you started a container in step 3, say so and give `docker stop <name>` to stop it.
