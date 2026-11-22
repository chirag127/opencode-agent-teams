# OpenCode agent teams

This repository owns durable project-bound team/task coordination over public OpenCode 2.3.2 session APIs. Preserve trusted calling-session/project authorization, atomic SQLite claims, dependency validation, restart recovery and cancellation fencing. Generic messaging/search/RAG belongs to the separately maintained agent bus.

## Development and verification

- Use the pinned dependencies and lockfile. Node requires 22.19.0 or later; the alternative SQLite adapter uses `bun:sqlite`.
- Run `npm ci --ignore-scripts`, `npm run check`, and `npm run test:pack` from this repository. The pinned compiler executable is `tsc6`. For SQLite-adapter changes, also run `bun test ./test` with a working Bun installation.
- Test synthetic sessions and temporary databases. Do not use live user sessions or external model calls for regression fixtures.
- Verify the actual installed tarball and published API schemas. In-process session error tags differ from HTTP error tags; recovery must match the exact missing session ID. Instruction keys and values must satisfy the published instruction-entry contract.
- Task completion requires an explicit result. Native idle and interruption are observations, not completion receipts. Request IDs and claim generations must remain effective across retries.
- Preserve the MIT license. Keep source, tests and package checks together; keep generated consumers and databases out of Git.

## Maintainer workspace

Canonical detailed documentation and continuation state are workspace-private at `C:/ws/docs/okf/opencode`, including `tasks/feature-parity-20261121.md`. Do not copy that knowledge base into this repository. Public setup is self-contained in README.md.

In the maintainer workspace, this project is registered at `repos/own/public/libraries/opencode-agent-teams`. Follow `C:/ws/AGENTS.md` and its autonomous-coding policy when available. Concurrent workers retain exclusive source scopes; the integration owner alone changes shared configuration, Git integration and canonical notes. Preserve existing worktrees and unrelated work.
