import type { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { Info } from "@opencode/plugin/promise/tool";
import type { Coordinator, Invocation } from "./coordinator.js";
import { TeamsError } from "./domain.js";
import { choice, integer, optional, parameters, parse, string, strings } from "./input.js";
import type { Fields, Parsed } from "./input.js";

export function registerTools(ctx: Plugin.Context, coordinator: Coordinator) {
  const store = coordinator.store;
  const tools: Info[] = [];
  function add<F extends Fields>(name: string, description: string, fields: F, run: (input: Parsed<F>, call: Invocation) => Promise<unknown>) {
    tools.push({ name, description, input: parameters(fields), output: { type: "object", additionalProperties: true },
      options: { namespace: "teams", codemode: true },
      async execute(input, context) {
        try {
          coordinator.lifetime.throwIfAborted();
          const call: Invocation = { sessionID: context.sessionID, agent: context.agent, signal: context.signal,
            source: { type: "tool", messageID: context.messageID, id: context.id } };
          const result = await run(parse(fields, input), call);
          return { content: JSON.stringify(result), output: result };
        } catch (error) {
          if (error instanceof TeamsError) throw new ToolError({ message: error.message, metadata: { code: error.code } });
          throw error;
        }
      },
    });
  }
  const team = string(64, "^[a-z][a-z0-9-]{0,63}$");
  const task = { team, taskID: string() };
  const claim = { ...task, claimID: string() };
  const read = (call: Invocation, team?: string) => coordinator.authorize(call, "teams.read", team);

  add("team_create", "Create a durable project-scoped named team with the calling session as leader. Workers cannot create nested teams.", { name: team }, async (input, call) =>
    store.createTeam(await coordinator.authorize(call, "teams.team.create"), input.name));
  add("team_list", "List teams the calling session belongs to in this project.", {}, async (_, call) =>
    ({ teams: store.listTeams(await read(call)) }));
  add("team_status", "Fleet and workflow status: members, task counts, first task page and pending recoverable operations. Idle is not task completion.", { team }, async (input, call) =>
    coordinator.status(await read(call, input.team), input.team));
  add("member_create", "Create one native child worker with inherited session permissions and model selection. A name addresses one worker/attempt; retry this name to reconcile creation.",
    { team, name: team, agent: optional(string(256)) }, (input, call) => coordinator.createMember(call, input.team, input.name, input.agent));
  add("member_get", "Resolve a team member name to its native session ID and saved status.", { team, name: team }, async (input, call) =>
    store.member(await read(call, input.team), input.team, input.name));
  add("task_create", "Leader: add a task with up to 100 same-team dependencies. Incomplete prerequisites block claims.",
    { team, title: string(256), description: string(16_000), dependencies: optional(strings()) }, async (input, call) =>
      store.createTask(await coordinator.authorize(call, "teams.task.create", input.team, true), input.team,
        { title: input.title, description: input.description, ...(input.dependencies ? { dependencies: input.dependencies } : {}) }));
  add("task_update", "Leader: edit a pending task using its current version. Rejects cycles, foreign dependencies and stale edits.",
    { ...task, version: integer(1), title: optional(string(256)), description: optional(string(16_000)), dependencies: optional(strings()) }, async (input, call) =>
      store.updateTask(await coordinator.authorize(call, "teams.task.update", input.team, true), input.team, input.taskID,
        { version: input.version, ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { description: input.description }), ...(input.dependencies ? { dependencies: input.dependencies } : {}) }));
  add("task_list", "Read a page of up to 100 tasks, blocked prerequisites, state counts and the next cursor.", { team, after: optional(string()) }, async (input, call) =>
    store.tasks(await read(call, input.team), input.team, input.after));
  add("task_get", "Read a task, its claim token, dependencies, progress and result/failure.", task, async (input, call) =>
    store.task(await read(call, input.team), input.team, input.taskID));
  add("task_claim", "Atomically claim a ready task for the real calling member. One active task per member; retain the returned claimID.", task, async (input, call) =>
    store.claim(await coordinator.authorize(call, "teams.task.claim", input.team), input.team, input.taskID));
  add("task_start", "Claim owner: mark work running using the current claimID.", claim, async (input, call) =>
    store.start(await coordinator.authorize(call, "teams.task.start", input.team), input.team, input.taskID, input.claimID));
  add("task_progress", "Claim owner: persist bounded progress with a durable receipt.", { ...claim, progress: string(4_000) }, async (input, call) =>
    store.progress(await coordinator.authorize(call, "teams.task.progress", input.team), input.team, input.taskID, input.claimID, input.progress));
  add("task_finish", "Claim owner: explicitly record completed evidence or failure. Retires the worker; repeated identical reports are idempotent.",
    { ...claim, outcome: choice(["completed", "failed"] as const), detail: string(16_000) }, async (input, call) =>
      store.finish(await coordinator.authorize(call, "teams.task.finish", input.team), input.team, input.taskID, input.claimID, input.outcome, input.detail));
  add("task_release", "Owner or leader: release a claim. Native workers are fenced and stopped first. A worker's own release returns a pending operation for its leader to resume.",
    { ...claim, requestID: string() }, (input, call) => coordinator.stop(call, input.team, input.taskID, "release", input.requestID, input.claimID));
  add("task_cancel", "Leader: cancel pending or active work. Stops only the assigned plugin-created child before acknowledging cancellation.",
    { ...task, requestID: string() }, (input, call) => coordinator.stop(call, input.team, input.taskID, "cancel", input.requestID));
  add("task_retry", "Leader: reset a failed or cancelled task after pending operations are reconciled. Use a fresh worker name for the new attempt.", task, async (input, call) =>
    store.retry(await coordinator.authorize(call, "teams.task.retry", input.team, true), input.team, input.taskID));
  add("task_dispatch", "Leader: atomically assign a task to a named worker and admit one native prompt. A durable requestID and message ID make retries safe.",
    { ...task, member: team, requestID: string() }, (input, call) => coordinator.dispatch(call, input.team, input.taskID, input.member, input.requestID));
  add("task_followup", "Leader: send one queued synthetic follow-up to the active task's worker. Use a new requestID for new input, or repeat the same ID to reconcile delivery.",
    { ...task, requestID: string(), message: string(8_000) }, (input, call) => coordinator.followup(call, input.team, input.taskID, input.requestID, input.message));
  add("operation_get", "Inspect a durable native-operation receipt, immutable message ID and recovery state.", { team, operationID: string() }, async (input, call) =>
    store.operation(await read(call, input.team), input.team, input.operationID));
  add("operation_resume", "Explicitly reconcile one pending operation after failure/restart. Rechecks the original action's permission; never replays completed operations.",
    { team, operationID: string() }, (input, call) => coordinator.resume(call, input.team, input.operationID));
  add("receipts", "Read up to 100 team audit receipts after a sequence cursor, including claim generations and task results.",
    { team, after: optional(integer()) }, async (input, call) => {
      const receipts = store.receipts(await read(call, input.team), input.team, input.after);
      return { receipts, next: receipts.length === 100 ? receipts.at(-1)!.sequence : null };
    });

  return ctx.tool.transform((editor) => {
    editor.namespace({ name: "teams", description: "Durable project teams, native workers, atomic dependency-aware tasks, progress and explicit recovery. Discover these tools before use." });
    for (const tool of tools) editor.add(tool);
  });
}
