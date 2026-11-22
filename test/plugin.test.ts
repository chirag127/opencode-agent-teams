import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import plugin from "../src/index.js";
import { syntheticHost, sessionInfo, toolContext } from "./host.js";
import { leader } from "./helpers.js";

async function setup(t: TestContext) {
  await mkdir(".test-work", { recursive: true });
  const directory = await mkdtemp(join(".test-work", "host-"));
  const host = syntheticHost(directory);
  let cleanup = await plugin.setup(host.context);
  t.after(async () => { await cleanup?.(); await rm(directory, { recursive: true, force: true }); });
  return { host, directory, cleanup, async reload() { await cleanup?.(); cleanup = await plugin.setup(host.context); } };
}

async function assignment(host: ReturnType<typeof syntheticHost>) {
  await host.call("team_create", { name: "release" });
  const member = await host.call("member_create", { team: "release", name: "builder" });
  const task = await host.call("task_create", { team: "release", title: "Build", description: "Build synthetic fixture" });
  return { member, task };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("published instruction entry schema accepts dispatch and follow-up, and cancellation preserves unrelated entries", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  await host.context.session.instructions.entry.put({ sessionID: member.sessionID, key: "fixture.keep", value: { note: "Unrelated instruction" } });
  const dispatch = await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const entries = await host.context.session.instructions.entry.list({ sessionID: member.sessionID });
  assert.equal(entries.length, 2);
  const assignmentEntry = entries.find((entry) => entry.key !== "fixture.keep")!;
  assert.ok(typeof assignmentEntry.value === "object" && assignmentEntry.value !== null && !Array.isArray(assignmentEntry.value));
  assert.equal(assignmentEntry.value.taskID, task.id);
  assert.equal(assignmentEntry.value.claimID, dispatch.claimID);
  assert.equal(assignmentEntry.value.team, "release");
  assert.equal(typeof assignmentEntry.value.instructions, "string");
  await host.call("task_followup", { team: "release", taskID: task.id, requestID: "follow", message: "Report the synthetic evidence" });
  assert.deepEqual(await host.context.session.instructions.entry.list({ sessionID: member.sessionID }), entries);
  await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel" });
  assert.deepEqual(await host.context.session.instructions.entry.list({ sessionID: member.sessionID }), [
    { key: "fixture.keep", value: { note: "Unrelated instruction" } },
  ]);
  assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).state, "cancelled");
});

test("native Session.NotFoundError creates the reserved child and reconciles a lost create reply", async (t) => {
  const { host } = await setup(t);
  await host.call("team_create", { name: "release" });
  const get = host.context.session.get;
  host.context.session.get = async (input, options) => {
    if (!host.sessions.has(input.sessionID)) {
      throw { _tag: "Session.NotFoundError", name: "Session.NotFoundError", message: "", sessionID: input.sessionID };
    }
    return get(input, options);
  };
  host.loseCreateReply();
  const member = await host.call("member_create", { team: "release", name: "builder", agent: "general" });
  assert.equal(member.state, "ready");
  assert.equal(member.sessionID, host.creates[0]!.id);
  assert.equal(host.sessions.get(member.sessionID)!.parentID, leader.sessionID);
  assert.deepEqual(await host.call("member_create", { team: "release", name: "builder", agent: "general" }), member);
  assert.equal(host.creates.length, 1);
});

test("native absence of the exact worker acknowledges cancellation without a native interrupt", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  host.sessions.delete(member.sessionID);
  const get = host.context.session.get;
  host.context.session.get = async (input, options) => {
    if (input.sessionID === member.sessionID) {
      throw { _tag: "Session.NotFoundError", name: "Session.NotFoundError", message: "", sessionID: member.sessionID };
    }
    return get(input, options);
  };
  const cancelled = await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel" });
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await host.call("member_get", { team: "release", name: "builder" })).state, "retired");
  assert.deepEqual(host.interrupted, []);
  assert.deepEqual(host.waited, []);
});

test("member creation rejects foreign-target and wrapped absence errors without creating a child", async (t) => {
  const { host } = await setup(t);
  await host.call("team_create", { name: "release" });
  const get = host.context.session.get;
  for (const [index, tag] of ["Session.NotFoundError", "SessionNotFoundError"].entries()) {
    for (const wrapped of [false, true]) {
      let rejection: unknown;
      const name = `guard-${index}-${wrapped ? "wrapped" : "foreign"}`;
      host.context.session.get = async (input, options) => {
        if (host.sessions.has(input.sessionID)) return get(input, options);
        const missing = { _tag: tag, name: tag, message: "", sessionID: wrapped ? input.sessionID : leader.sessionID };
        rejection = wrapped ? new ToolError({ message: "", error: missing }) : missing;
        throw rejection;
      };
      await assert.rejects(host.call("member_create", { team: "release", name }), (error) => error === rejection);
      assert.equal((await host.call("member_get", { team: "release", name })).state, "creating");
      assert.equal(host.creates.length, 0);
    }
  }
  host.context.session.get = get;
});

test("published plugin setup registers usable Code Mode tools, workflow command and task-fencing hooks", async (t) => {
  const { host } = await setup(t);
  assert.ok(host.namespaces.includes("teams"));
  assert.ok(host.commands.has("teams"));
  assert.ok(host.hooks.has("tool.execute.before"));
  assert.ok(host.hooks.has("session.context"));
  const team = await host.call("team_create", { name: "release" });
  assert.equal(team.leaderSessionID, leader.sessionID);
  assert.equal((await host.call("team_list", {})).teams.length, 1);
  assert.ok([...host.tools.values()].every((tool) => tool.options?.codemode === true));
});

test("tool identity cannot be supplied by a model and permission denial precedes mutation", async (t) => {
  const { host, directory } = await setup(t);
  await assert.rejects(host.call("team_create", { name: "spoof", callerSessionID: leader.sessionID }), /unexpected|unknown|not allowed/i);
  host.deny("teams.team.create");
  await assert.rejects(host.call("team_create", { name: "release" }), /permission denial/);
  host.deny(undefined);
  assert.deepEqual((await host.call("team_list", {})).teams, []);
  await host.call("team_create", { name: "release" });
  const stranger = sessionInfo(directory, "ses_stranger");
  host.sessions.set(stranger.id, stranger);
  await assert.rejects(host.call("team_status", { team: "release" }, stranger.id), /not a team member/);
  host.sessions.set("ses_foreign", { ...sessionInfo(directory, "ses_foreign"), projectID: "project-other" });
  await assert.rejects(host.call("team_create", { name: "other" }, "ses_foreign"), /another project/);
  assert.ok(host.permissions.every((permission) => permission.sessionID === leader.sessionID && permission.source?.type === "tool"));
});

test("native child dispatch preserves restrictions and retries a lost admission acknowledgement with the same ID", async (t) => {
  const { host } = await setup(t);
  await host.call("team_create", { name: "release" });
  host.loseCreateReply();
  const member = await host.call("member_create", { team: "release", name: "builder" });
  assert.equal(host.creates.length, 1);
  assert.equal(host.sessions.get(member.sessionID)!.parentID, leader.sessionID);
  assert.deepEqual(host.sessions.get(member.sessionID)!.permissions, host.sessions.get(leader.sessionID)!.permissions);
  const task = await host.call("task_create", { team: "release", title: "Build", description: "Build the synthetic fixture" });
  host.loseAdmissionReply();
  await assert.rejects(host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" }), /lost admission/);
  const pending = (await host.call("team_status", { team: "release" })).pending;
  assert.equal(pending.length, 1);
  const done = await host.call("operation_resume", { team: "release", operationID: pending[0].id });
  assert.equal(done.state, "done");
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  assert.equal(host.admissions.size, 1);
  assert.ok([...host.admissions.values()].every((admission) => admission.sessionID === member.sessionID && admission.delivery === "queue"));
  assert.ok(host.instructions.get(member.sessionID)?.size);
  await host.call("task_progress", { team: "release", taskID: task.id, claimID: done.claimID, progress: "Checked fixture" }, member.sessionID);
  await host.call("task_finish", { team: "release", taskID: task.id, claimID: done.claimID, outcome: "completed", detail: "Fixture passed" }, member.sessionID);
  assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).result, "Fixture passed");
});

test("reload retains an uncertain admission without replay, and explicit recovery reuses its native ID", async (t) => {
  const { host, reload } = await setup(t);
  const { task } = await assignment(host);
  host.loseAdmissionReply();
  await assert.rejects(host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" }));
  const pending = (await host.call("team_status", { team: "release" })).pending[0];
  const staleExecutor = host.tools.get("team_create")!;
  await reload();
  assert.equal(host.admissions.size, 1);
  assert.equal((await host.call("operation_get", { team: "release", operationID: pending.id })).messageID, pending.messageID);
  await assert.rejects(staleExecutor.execute({ name: "after-unload" }, toolContext()), /abort/i);
  host.deny("teams.task.dispatch");
  await assert.rejects(host.call("operation_resume", { team: "release", operationID: pending.id }), /permission denial/);
  host.deny(undefined);
  assert.equal((await host.call("operation_resume", { team: "release", operationID: pending.id })).state, "done");
  assert.equal(host.admissions.size, 1);
  assert.equal((await host.call("team_list", {})).teams.length, 1);
});

test("cancellation fences tools before native stop acknowledgement and interrupts a late admission", { timeout: 10_000 }, async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  const admitting = gate();
  const admit = gate();
  const stopping = gate();
  const stopped = gate();
  host.beforeAdmission(async () => { admitting.resolve(); await admit.promise; });
  const dispatch = host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  await admitting.promise;
  host.beforeWait(async () => { stopping.resolve(); await stopped.promise; });
  const cancel = host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel" });
  await stopping.promise;
  assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).state, "stopping");
  const fence = host.hooks.get("tool.execute.before")!;
  await assert.rejects(fence({ ...toolContext(member.sessionID), tool: "shell", input: {} }), /stopped or retired/);
  await fence({ ...toolContext(), tool: "shell", input: {} });
  stopped.resolve();
  assert.equal((await cancel).state, "cancelled");
  admit.resolve();
  await dispatch;
  assert.equal(host.admissions.size, 1);
  assert.deepEqual(host.interrupted, [member.sessionID, member.sessionID]);
  assert.deepEqual(host.waited, [member.sessionID]);
  assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).state, "cancelled");
  await assert.rejects(host.call("task_finish", { team: "release", taskID: task.id, claimID: "old", outcome: "completed", detail: "Late" }, member.sessionID));
});

test("a worker self-release is durable and only its leader acknowledges the native stop", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  const dispatch = await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const release = await host.call("task_release", { team: "release", taskID: task.id, claimID: dispatch.claimID, requestID: "release" }, member.sessionID);
  assert.equal(release.requiresLeader, true);
  assert.equal(release.task.state, "stopping");
  assert.deepEqual(host.interrupted, []);
  await assert.rejects(host.call("operation_resume", { team: "release", operationID: release.operation.id }, member.sessionID), /leader must acknowledge/);
  await host.call("operation_resume", { team: "release", operationID: release.operation.id });
  await host.call("operation_resume", { team: "release", operationID: release.operation.id });
  assert.deepEqual(host.interrupted, [member.sessionID]);
  assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).state, "pending");
  assert.equal((await host.call("member_get", { team: "release", name: "builder" })).state, "retired");
});

test("foreign, reparented and tampered worker sessions cannot receive task input", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  const original = structuredClone(host.sessions.get(member.sessionID)!);
  for (const changed of [
    { ...original, projectID: "foreign-project" },
    { ...original, parentID: "ses_unrelated" },
    { ...original, metadata: {} },
    { ...original, time: { ...original.time, archived: 42 } },
  ]) {
    host.sessions.set(member.sessionID, changed);
    await assert.rejects(host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" }));
    assert.equal(host.admissions.size, 0);
    assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).state, "pending");
  }
});

test("a project move while permission is pending invalidates the caller before mutation", async (t) => {
  const { host } = await setup(t);
  host.beforePermission(async () => {
    host.sessions.get(leader.sessionID)!.projectID = "foreign-project";
  });
  await assert.rejects(host.call("team_create", { name: "release" }), /another project/);
  host.beforePermission(undefined);
  host.sessions.get(leader.sessionID)!.projectID = leader.projectID;
  assert.deepEqual((await host.call("team_list", {})).teams, []);
});

test("native outcomes update fleet progress but never manufacture task completion", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const child = host.sessions.get(member.sessionID)!;
  child.outcome = "interrupted";
  child.time.busy = 10;
  child.time.idle = 20;
  await host.event({ type: "session.execution.interrupted", id: "evt_interrupted", created: Date.now(),
    durable: { aggregateID: member.sessionID, seq: 1, version: 1 }, data: { sessionID: member.sessionID, reason: "user" } });
  const status = await host.call("team_status", { team: "release" });
  assert.equal(status.members.find((item: { name: string }) => item.name === "builder").runtime, "interrupted");
  assert.equal(status.tasks[0].state, "running");
  assert.equal(status.tasks[0].result, null);
});

test("the workflow command reports to its invoker without resuming model work", async (t) => {
  const { host } = await setup(t);
  await assignment(host);
  await host.commands.get("teams")!.execute({ sessionID: toolContext().sessionID, prompt: { text: "release" }, delivery: "queue" });
  const output = [...host.admissions.values()];
  assert.equal(output.length, 1);
  assert.equal(output[0]!.sessionID, leader.sessionID);
  assert.equal(output[0]!.resume, false);
  assert.equal(JSON.parse(output[0]!.text).counts.pending, 1);
});

test("a missing leader never acknowledges stopping an existing worker", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const worker = host.sessions.get(member.sessionID)!;
  const before = host.context.session.get;
  for (const tag of ["Session.NotFoundError", "SessionNotFoundError"]) {
    let lookups = 0;
    host.context.session.get = async (input, options) => {
      if (input.sessionID === member.sessionID) lookups++;
      if (lookups > 0 && input.sessionID === worker.parentID) throw { _tag: tag, name: tag, sessionID: worker.parentID, message: "" };
      return before(input, options);
    };
    await assert.rejects(host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel" }));
  }
  host.context.session.get = before;
  assert.equal((await host.call("task_get", { team: "release", taskID: task.id })).state, "stopping");
  assert.deepEqual(host.interrupted, []);
});

test("the tool fence observes a stop committed while its provenance lookup is awaiting", { timeout: 10_000 }, async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  const dispatch = await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const entered = gate();
  const resumeLookup = gate();
  const get = host.context.session.get;
  let firstLookup = true;
  host.context.session.get = async (input, options) => {
    if (input.sessionID === member.sessionID && firstLookup) {
      firstLookup = false;
      entered.resolve();
      await resumeLookup.promise;
    }
    return get(input, options);
  };
  const fenced = host.hooks.get("tool.execute.before")!({ ...toolContext(member.sessionID), tool: "shell", input: {} });
  await entered.promise;
  const release = await host.call("task_release", { team: "release", taskID: task.id, claimID: dispatch.claimID, requestID: "release" }, member.sessionID);
  assert.equal(release.task.state, "stopping");
  resumeLookup.resolve();
  await assert.rejects(fenced, /stopped or retired/);
  host.context.session.get = get;
});

test("acknowledged cancellation replay after retry never cancels the next attempt", async (t) => {
  const { host, reload } = await setup(t);
  const { task } = await assignment(host);
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel-once" });
  await host.call("task_retry", { team: "release", taskID: task.id });
  const before = await host.call("task_get", { team: "release", taskID: task.id });
  const receipts = await host.call("receipts", { team: "release" });
  await reload();
  await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel-once" });
  assert.deepEqual(await host.call("task_get", { team: "release", taskID: task.id }), before);
  assert.deepEqual(await host.call("receipts", { team: "release" }), receipts);
  assert.equal(host.interrupted.length, 1);
});

test("a pending-task cancellation has a durable request identity across fresh native assignment", async (t) => {
  const { host, reload } = await setup(t);
  const { task } = await assignment(host);
  await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "pending-cancel" });
  await host.call("task_retry", { team: "release", taskID: task.id });
  await reload();
  await assert.rejects(host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "pending-cancel" }), /different operation/);
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "fresh-dispatch" });
  const before = await host.call("task_get", { team: "release", taskID: task.id });
  const receipts = await host.call("receipts", { team: "release" });
  await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "pending-cancel" });
  assert.deepEqual(await host.call("task_get", { team: "release", taskID: task.id }), before);
  assert.deepEqual(await host.call("receipts", { team: "release" }), receipts);
  assert.deepEqual(host.interrupted, []);
});

test("a completed release replays its receipt without affecting a new claim generation", async (t) => {
  const { host, reload } = await setup(t);
  const { task } = await assignment(host);
  const first = await host.call("task_claim", { team: "release", taskID: task.id });
  await host.call("task_release", { team: "release", taskID: task.id, claimID: first.claimID, requestID: "local-release" });
  const next = await host.call("task_claim", { team: "release", taskID: task.id });
  const receipts = await host.call("receipts", { team: "release" });
  await reload();
  await host.call("task_release", { team: "release", taskID: task.id, claimID: first.claimID, requestID: "local-release" });
  assert.deepEqual(await host.call("task_get", { team: "release", taskID: task.id }), next);
  assert.deepEqual(await host.call("receipts", { team: "release" }), receipts);
});

test("coalesced cancellation IDs remain spent after acknowledgement, retry and reload", { timeout: 10_000 }, async (t) => {
  const { host, reload } = await setup(t);
  const { task } = await assignment(host);
  await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const firstWait = gate();
  const secondWait = gate();
  const acknowledge = gate();
  let waits = 0;
  host.beforeWait(async () => {
    if (++waits === 1) firstWait.resolve();
    else secondWait.resolve();
    await acknowledge.promise;
  });
  t.after(() => acknowledge.resolve());
  const first = host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel-a" });
  await firstWait.promise;
  const second = host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel-b" });
  await secondWait.promise;
  acknowledge.resolve();
  await Promise.all([first, second]);
  host.beforeWait(undefined);
  await host.call("task_retry", { team: "release", taskID: task.id });
  const before = await host.call("task_get", { team: "release", taskID: task.id });
  const receipts = await host.call("receipts", { team: "release" });
  const interrupts = host.interrupted.length;
  await reload();
  await host.call("task_cancel", { team: "release", taskID: task.id, requestID: "cancel-b" });
  assert.deepEqual(await host.call("task_get", { team: "release", taskID: task.id }), before);
  assert.deepEqual(await host.call("receipts", { team: "release" }), receipts);
  assert.equal(host.interrupted.length, interrupts);
});

test("worker reports reject a parent moved to another project, including during permission evaluation", async (t) => {
  const { host } = await setup(t);
  const { member, task } = await assignment(host);
  const dispatch = await host.call("task_dispatch", { team: "release", taskID: task.id, member: "builder", requestID: "dispatch" });
  const before = await host.call("task_get", { team: "release", taskID: task.id });
  const receipts = await host.call("receipts", { team: "release" });
  const parent = host.sessions.get(leader.sessionID)!;
  for (const duringPermission of [false, true]) {
    for (const [tool, detail] of [
      ["task_progress", { progress: "Must not persist" }],
      ["task_finish", { outcome: "completed", detail: "Must not satisfy prerequisites" }],
    ] as const) {
      if (duringPermission) host.beforePermission(async () => { parent.projectID = "foreign-project"; });
      else parent.projectID = "foreign-project";
      try {
        await assert.rejects(host.call(tool, { team: "release", taskID: task.id, claimID: dispatch.claimID, ...detail }, member.sessionID), /another project/);
      } finally {
        host.beforePermission(undefined);
        parent.projectID = leader.projectID;
      }
      assert.deepEqual(await host.call("task_get", { team: "release", taskID: task.id }), before);
      assert.deepEqual(await host.call("receipts", { team: "release" }), receipts);
    }
  }
});
