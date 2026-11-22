import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { Registration } from "@opencode/plugin/promise/registration";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Coordinator } from "./coordinator.js";
import { ensure } from "./domain.js";
import { TeamsStore } from "./store.js";
import { registerTools } from "./tools.js";

export default Plugin.define({
  id: "agent-teams",
  async setup(ctx) {
    for (const key of Object.keys(ctx.options)) ensure(key === "database", "INVALID", `Unknown agent-teams option: ${key}`);
    ensure(ctx.options.database === undefined || (typeof ctx.options.database === "string" && ctx.options.database.trim()), "INVALID", "database must be a nonempty path");
    const database = resolve(ctx.location.project.canonical, ctx.options.database as string | undefined ?? ".opencode/agent-teams/teams.sqlite");
    const store = await TeamsStore.open(database, ctx.location.project.id);
    const controller = new AbortController();
    const coordinator = new Coordinator(store, ctx, controller.signal);
    const registrations: Registration[] = [];
    let events: Promise<void> | undefined;
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      controller.abort();
      await Promise.allSettled(registrations.map((registration) => registration.dispose()));
      await events;
      store.close();
    };
    try {
      registrations.push(await registerTools(ctx, coordinator));
      registrations.push(await ctx.tool.hook("execute.before", async (event) => {
        controller.signal.throwIfAborted();
        if (event.tool.startsWith("teams_")) return;
        if (await coordinator.fence(event.sessionID)) throw new ToolError({ message: "This team worker is stopped or retired; its task claim no longer permits tool work." });
      }));
      registrations.push(await ctx.session.hook("context", async (event) => {
        controller.signal.throwIfAborted();
        const assignment = store.assignment(event.sessionID);
        if (!assignment) return;
        const fenced = await coordinator.fence(event.sessionID);
        if (fenced) for (const key of Object.keys(event.tools)) delete event.tools[key];
        event.system.push({ type: "text", text: fenced
          ? "This team worker is stopped or retired. Do not perform further work. Return a brief final status; the leader owns recovery."
          : `Team worker ${assignment.team.name}/${assignment.member.name}. Use only your assigned task and current claim token. Report progress and explicit completion/failure through the teams tools; native idle does not complete a task.` });
      }));
      registrations.push(await ctx.command.transform((editor) => editor.add({
        name: "teams", description: "Show your team fleet or /teams <name> workflow status without starting model work",
        async execute({ sessionID, prompt }) {
          const team = prompt.text.trim();
          const call = { sessionID, signal: controller.signal };
          const actor = await coordinator.authorize(call, "teams.read", team || undefined);
          const status = team ? await coordinator.status(actor, team) : { teams: store.listTeams(actor) };
          await ctx.session.synthetic({ sessionID, id: `msg_${randomUUID().replaceAll("-", "")}`, text: JSON.stringify(status, null, 2),
            description: "Team workflow status", delivery: "queue", resume: false }, { signal: controller.signal });
        },
      })));
      events = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal,
            types: ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted"] })) {
            if (controller.signal.aborted) break;
            const member = store.workerBySession(event.data.sessionID);
            if (!member) continue;
            if (event.type !== "session.deleted") {
              try { await coordinator.worker(member); } catch { continue; }
            }
            if (!controller.signal.aborted) store.observe(member.sessionID, event.type === "session.deleted" ? "missing" : event.type.slice("session.execution.".length), event.created);
          }
        } catch {
          // Status reads reconcile from native session snapshots even when the event transport disconnects.
        }
      })();
      return cleanup;
    } catch (error) {
      await cleanup();
      throw error;
    }
  },
});
