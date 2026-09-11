---
name: add-env-var
description: Add a runtime environment variable to hashimon-server end to end, from src/modules/core/config.ts and .env.example through the hashimon_server Ansible role (server.env.j2, defaults/main.yml or vault.example.yml), so it actually reaches production. Use this whenever a change introduces a new process.env read, a new config.* property, an API key, a webhook secret, a timeout, a model name or a feature flag, or when the user says "add an env var", "make X configurable", "new secret", "agrega una variable de entorno" or "que llegue a producción", even if they only mention config.ts.
---

# Add an environment variable

A variable added only to `config.ts` works locally and silently falls back to its
default in production, because the droplet's `server.env` is rendered by the IaC repo,
not by this one. That drift already exists for several variables, so this skill treats
the server and the IaC as one change.

## 1. Pin down the variable

Infer from the conversation or ask for what is missing:

| Question | Why it matters |
|---|---|
| `NAME` (UPPER_SNAKE) and its purpose | The comment in every file explains the why, not the what |
| Development default | Goes into `config.ts` and `.env.example` |
| Production value | Non-secret: goes into the IaC `defaults/main.yml` |
| Secret? | Decides between `defaults/main.yml` and a vault example file |
| Required in production? | A required value must fail the playbook when absent; an optional one degrades (routes answer 503) |
| Consumed by another role too (e.g. luanti)? | A cross-role secret lives in `group_vars/all/`, not the role |

## 2. Server: `src/modules/core/config.ts`

Add a camelCase property next to its related group, with a comment when the value's
semantics are not obvious (what empty means, units, who reads it).

- String: `process.env.NAME ?? "default"`.
- Number: `Number(process.env.NAME) || default`. The `||` is deliberate — see the
  `incubationLotTimeoutMs` comment in `config.ts`: an Ansible template that rendered
  nothing gives `""`, and `Number("")` is `0`, not the default. If `0` is a legitimate
  value, handle it explicitly instead.

If it is a secret, never pass it to `enrich()`. Add both `"camelKey"` and
`"*.camelKey"` to `REDACT_PATHS` in `src/modules/core/logger.ts` whenever the value
will live anywhere besides `config` (a client object, request options, an error), since
that is how a secret ends up spread into an event by accident.

## 3. Server: `.env.example`

Put `NAME=value` in its section with a short comment. Secrets get a placeholder
(`change-me` or `change-me-in-production`, matching the section); an optional key whose
absence disables a feature may stay empty, like `ANTHROPIC_API_KEY=`.

## 4. Locate the IaC repo

The IaC path differs per person, so discover it instead of assuming:

1. `git rev-parse --path-format=absolute --git-common-dir` prints `<server-root>/.git`,
   also from inside a worktree. Take its parent (`<server-root>`) and that directory's
   parent (`<search-root>`). Run it as its own command and reuse the literal output:
   worktree sessions reject `$(...)` substitutions.
2. Search:
   ```bash
   find <search-root> \( -name node_modules -o -name .git -o -name galaxy_roles -o -path '*/.claude/worktrees' \) -prune -o -type d -path '*/roles/hashimon_server' -print
   ```
3. Exactly one result: `<role>` is that path and `<ansible>` is its grandparent. Zero or
   several: ask the user for the path; do not guess.
4. Report the IaC repo's current branch (`git -C <ansible> branch --show-current`) and
   `git -C <ansible> status --short` before editing. If the files you are about to touch
   already carry uncommitted changes, say so first — your edit would mix with someone
   else's work.

Never commit in the IaC repo and never run the playbook: deploying is the user's call.

## 5. IaC: template, defaults, vault example

The Ansible variable is `hashimon_` plus the lowercased name, dropping a leading
`HASHIMON_` (`INCUBATION_LOT_TIMEOUT_MS` -> `hashimon_incubation_lot_timeout_ms`,
`HASHIMON_PUBLIC_URL` -> `hashimon_public_url`). Some older variables break this rule
(`hashimon_anthropic_key`); leave them alone.

**`<role>/templates/server.env.j2`** — add `NAME={{ hashimon_<name> }}` inside its
section (sections are separated by blank lines and comments). An optional variable uses
`{{ hashimon_<name> | default('') }}`.

Then, by kind:

| Kind | Where the value goes |
|---|---|
| Non-secret | `<role>/defaults/main.yml`: `hashimon_<name>: <production value>` with a comment |
| Required secret | `<role>/vars/vault.example.yml`: `hashimon_<name>: changeme-generate-a-real-one`. In `defaults/main.yml` add **no default**, only a comment pointing at `vars/vault.yml` (the `hashimon_db_password` pattern) |
| Optional secret | Same vault example entry, plus `hashimon_<name>: ""` under the "Override in roles/hashimon_server/vars/vault.yml for production." block of `defaults/main.yml` |
| Cross-role secret | `<ansible>/group_vars/all/vault.example.yml` instead of the role's |

Why a required secret gets no default: `vars/vault.yml` is loaded by `include_vars` in
the role's tasks and overrides defaults. A placeholder default would let a playbook run
without the vault entry succeed and ship `changeme` to production; with no default, the
template render fails loudly on the undefined variable.

Why cross-role secrets go to `group_vars/all/`: `luanti` runs before `hashimon_server` in
`setup.yml`, and a role's `vars/vault.yml` only exists once that role's tasks run
(explained in `<ansible>/CLAUDE.md`).

Never decrypt, edit or create `vars/vault.yml` or `group_vars/all/vault.yml`. They are
encrypted and the real value is the user's to enter.

## 6. Verify

- `pnpm typecheck` in the server.
- Exactly one hit each:
  - `grep -n "process.env.NAME" src/modules/core/config.ts`
  - `grep -n "^NAME=" .env.example`
  - `grep -n "^NAME=" <role>/templates/server.env.j2`
- `grep -rn "hashimon_<name>" <role> <ansible>/group_vars` shows the template line plus
  its defaults or vault example entry.
- From `<ansible>`: `ansible-playbook setup.yml --syntax-check < /dev/null 2>&1 | cat`.
  It catches YAML breakage in `defaults/main.yml`, but never loads the vault example
  and never renders the template. (The redirections are not decoration: without them
  Ansible aborts under the Bash tool with "requires blocking IO".)
- For a secret, also from `<ansible>`, check that the example you edited parses (swap in
  `group_vars/all/vault.example.yml` for a cross-role one) and — when required — that no
  default leaks in (the second command must fail with `'hashimon_<name>' is undefined`):
  ```bash
  ansible localhost -c local -i localhost, -m debug -a 'msg={{ hashimon_<name> }}' -e @roles/hashimon_server/vars/vault.example.yml < /dev/null 2>&1 | cat
  ansible localhost -c local -i localhost, -m debug -a 'msg={{ hashimon_<name> }}' -e @roles/hashimon_server/defaults/main.yml < /dev/null 2>&1 | cat
  ```

## 7. Report

State what changed in each repo, the IaC branch the edits landed on, and that nothing
was committed there or deployed. If you noticed other variables in `config.ts` missing
from `server.env.j2`, list them without fixing them.

If the variable is a secret, end with the exact command the user runs to set the real
value:

```bash
cd <ansible> && ansible-vault edit roles/hashimon_server/vars/vault.yml
# cross-role: ansible-vault edit group_vars/all/vault.yml
```

and the line to add: `hashimon_<name>: <real value>`. `ansible.cfg` already points
`vault_identity_list` at the password file, so no extra flag is needed.
