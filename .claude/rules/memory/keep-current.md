---
paths:
  - "**/CLAUDE.md"
  - "**/AGENTS.md"
---

# Memory File Currency

These files are the map this agent navigates by. A wrong map means lost navigation, broken assumptions, and bugs introduced because the documented behavior no longer matches the code.

## When you read a CLAUDE.md or AGENTS.md

Treat it as a hypothesis, not as truth. Before relying on a fact from the file:

- Verify symbol references resolve (`file::Symbol` should be reachable via LSP `goToDefinition`).
- Verify file paths still exist.
- Spot-check at least one claim against the actual code.

If the file disagrees with the code, the code wins — and the file is now your responsibility to fix.

## When you modify code in a module that has a CLAUDE.md or AGENTS.md

Updating the memory file is part of the same change, not a follow-up task. Specifically:

- If you changed a symbol referenced in the memory file, update the reference (or remove it if it no longer matters).
- If you changed business logic, an invariant, or a side effect documented in the file, update that section.
- If you removed a pitfall, remove it from the pitfalls list — do not let solved problems linger as warnings.
- If the change introduces a new non-obvious constraint, add it.

Outdated documentation is a critical bug, not a style issue. A future agent (you, in a fresh context) will trust this file. Make sure the file deserves that trust.

## When in doubt

If you cannot tell whether a memory file is still accurate, say so to the user. Do not silently follow a file you suspect is stale; do not silently rewrite a file without flagging that you did. Either path silently corrupts the project's institutional memory.
