# opencode-agent-teams

Durable, project-scoped teams and dependency-aware tasks for **OpenCode V2 2.3.2**.
Uses native child sessions, SQLite transactions, and the public plugin API.

- Named teams with a session leader and individually addressed child workers.
- A shared task graph, cycle detection, atomic claims, progress and result receipts.
- Explicit dispatch, queued follow-ups, cancellation, release and restart recovery.
- 21 Code Mode tools under `teams` and a `/teams [name]` workflow/fleet command.

## Install locally

Requires Node **22.19+** (including the plugin dependency floor and built-in `node:sqlite`) or Bun with `bun:sqlite`.

```sh
npm ci --ignore-scripts
npm run check
npm run test:pack
```

After building, add the checkout to the project's OpenCode configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/path/to/opencode-agent-teams"]
}
```

`npm run test:pack` creates `opencode-agent-teams-0.1.0.tgz`, installs it into an
isolated fixture, checks its published types, and loads it using the real plugin
host loader with synthetic sessions. Successful consumers and their hash receipts
are retained under `.test-work/pack-*/verification.json`. The repository is not an
npm publication.

### Storage option

The default database is `<project.canonical>/.opencode/agent-teams/teams.sqlite`.
Add that data directory to the consuming project's ignore rules. Instances in
the same canonical project share it. The database binds to one OpenCode project
ID and rejects another project.

```jsonc
{
  "plugins": [{
    "package": "C:/path/to/opencode-agent-teams",
    "options": { "database": "C:/private/project-data/teams.sqlite" }
  }]
}
```

`database` is the only option; relative paths resolve from the canonical project.
SQLite uses WAL, full synchronous commits and a five-second contention timeout.

## Example workflow

Discover the `teams` namespace with Code Mode's `search` first. These example
calls run in the leader's session; identity always comes from the tool context.

```js
await tools.teams.team_create({ name: "release" });
await tools.teams.member_create({ team: "release", name: "builder" });
const task = await tools.teams.task_create({
  team: "release", title: "Verify the build", description: "Run project checks and report evidence."
});
await tools.teams.task_dispatch({
  team: "release", taskID: task.id, member: "builder", requestID: "build-attempt-1"
});
return await tools.teams.team_status({ team: "release" });
```

Workers receive their task ID and claim token through native instructions. They
report with `task_progress` and `task_finish` (`completed` or `failed`). Idle or
interrupted sessions retain their task; they do not silently complete or release
it. The leader can send `task_followup`, stop with `task_cancel`/`task_release`,
or explicitly reconcile a pending operation with `operation_resume`.

| Tools | Purpose |
| --- | --- |
| `team_create`, `team_list`, `team_status` | Team membership and fleet/workflow overview |
| `member_create`, `member_get` | Create one child or resolve a member address |
| `task_create`, `task_update`, `task_list`, `task_get` | Versioned task graph; pages of 100 |
| `task_claim`, `task_start`, `task_progress`, `task_finish` | Owned work and claim-generation fencing |
| `task_dispatch`, `task_followup` | Explicit native admission with stable request/message IDs |
| `task_release`, `task_cancel`, `task_retry` | Stop/release or retry an attempt |
| `operation_get`, `operation_resume`, `receipts` | Durable recovery and audit trail |

## Execution contract

- Every tool asserts the caller's OpenCode permissions (`teams.read` or its
  `teams.<domain>.<action>`); child creation also asserts `subagent` for the selected
  agent. Native child permission and model inheritance are retained.
- Only plugin-created workers in the same project, with matching parent and
  provenance, receive task input. Tool schemas reject caller identity overrides.
- Dispatch and follow-up retries reuse durable native message IDs. Recovery is
  explicit; loading the plugin does not spawn workers or submit prompts.
- Keep a request ID stable when retrying the same action; use a new ID for new
  work. Stop requests remain recorded across task retries, including cancellation
  of pending tasks and release of leader-owned claims.
- One active task per member. A worker is retired after its one task attempt;
  create a new worker name for the next attempt. Limits are 64 teams/project,
  64 workers/team, 1,000 tasks/team and 100 dependencies/task.
- Worker self-release returns a fenced pending stop for the leader to acknowledge,
  avoiding self-interruption deadlock. A native stop is acknowledged before the
  task becomes available again. Already-running external effects are not rolled back.
- `/teams` adds a non-resuming synthetic status entry to its invoker. There is no
  background scheduler, general messaging/RAG service, custom agent runtime or
  model-selected caller RPC.

Workspace maintainers keep the canonical notes and implementation evidence in
`C:/ws/docs/okf/opencode/tasks/feature-parity-20261121.md`. This is a
workspace-private reference; the package usage above is self-contained.

<footer class="hire-me">
  <h3>Hire me</h3>
  <p>Chirag Singhal — building free, open APIs and tools.</p>
  <p>
    <a href="mailto:chirag@oriz.in">chirag@oriz.in</a> ·
    <a href="https://github.com/chirag127">GitHub</a> ·
    <a href="https://www.linkedin.com/in/chirag127/">LinkedIn</a> ·
    <a href="https://x.com/singhal127">X</a> ·
    <a href="https://www.youtube.com/@ChiragSinghal127">YouTube</a> ·
    <a href="https://www.instagram.com/chiragsinghal127/">Instagram</a> ·
    <a href="https://www.reddit.com/user/Far_Macaron_9910/">Reddit</a> ·
    <a href="https://buymeacoffee.com/chirag127">Buy me a coffee</a>
  </p>
</footer>
