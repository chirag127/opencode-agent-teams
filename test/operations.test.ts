import assert from "node:assert/strict";
import test from "node:test";
import { TeamsStore } from "../src/store.js";
import { errorCode, fixture, leader } from "./helpers.js";

test("dispatch IDs and admission payload survive restart and duplicate requests cannot assign twice", async (t) => {
  const { store, worker, filename } = await fixture(t);
  const owner = worker("builder");
  worker("other");
  const task = store.createTask(leader, "release", { title: "Build", description: "Build fixture" });
  const op = store.dispatch(leader, "release", task.id, "builder", "dispatch-1");
  assert.equal(store.task(leader, "release", task.id).ownerSessionID, owner.sessionID);
  assert.equal(op.state, "pending");
  assert.match(op.messageID, /^msg_/);
  const second = await TeamsStore.open(filename, leader.projectID);
  try {
    assert.deepEqual(second.dispatch(leader, "release", task.id, "builder", "dispatch-1"), op);
    assert.equal(second.dispatch(leader, "release", task.id, "builder", "dispatch-again").id, op.id);
    assert.throws(() => second.dispatch(leader, "release", task.id, "other", "dispatch-2"), errorCode("CONFLICT"));
    assert.equal(second.delivered(leader, "release", op.id).state, "done");
    assert.equal(second.delivered(leader, "release", op.id).messageID, op.messageID);
    assert.equal(second.task(leader, "release", task.id).state, "running");
    assert.equal(second.receipts(leader, "release").filter((receipt) => receipt.kind === "operation.delivered").length, 1);
  } finally { second.close(); }
});

test("coalesced dispatch IDs cannot become new operations after restart", async (t) => {
  const { store, worker, filename } = await fixture(t);
  const owner = worker("builder");
  worker("next-builder");
  const task = store.createTask(leader, "release", { title: "Build", description: "One dispatch" });
  const original = store.dispatch(leader, "release", task.id, "builder", "dispatch-a");
  assert.equal(store.dispatch(leader, "release", task.id, "builder", "dispatch-b").id, original.id);
  store.delivered(leader, "release", original.id);
  store.finish(owner, "release", task.id, original.claimID, "completed", "Done");
  const next = store.createTask(leader, "release", { title: "Next", description: "Must need a new request" });
  const reopened = await TeamsStore.open(filename, leader.projectID);
  try {
    assert.equal(reopened.dispatch(leader, "release", task.id, "builder", "dispatch-b").id, original.id);
    assert.throws(() => reopened.dispatch(leader, "release", next.id, "next-builder", "dispatch-b"), errorCode("CONFLICT"));
    assert.throws(() => reopened.stop(leader, "release", next.id, "cancel", "dispatch-b"), errorCode("CONFLICT"));
    assert.equal(reopened.task(leader, "release", next.id).state, "pending");
    assert.equal(reopened.receipts(leader, "release").filter((receipt) => receipt.kind === "task.claimed").length, 1);
  } finally { reopened.close(); }
});

test("coalesced release IDs from the owner and leader replay the same acknowledged stop", async (t) => {
  const { store, worker, filename } = await fixture(t);
  const owner = worker("builder");
  const task = store.createTask(leader, "release", { title: "Build", description: "Stop one attempt" });
  const dispatch = store.dispatch(leader, "release", task.id, "builder", "dispatch");
  store.delivered(leader, "release", dispatch.id);
  const first = store.stop(owner, "release", task.id, "release", "owner-release", dispatch.claimID);
  const alias = store.stop(leader, "release", task.id, "release", "leader-release", dispatch.claimID);
  assert.equal(alias.operation!.id, first.operation!.id);
  store.stopped(leader, "release", first.operation!.id);
  const next = store.claim(leader, "release", task.id);
  const reopened = await TeamsStore.open(filename, leader.projectID);
  try {
    const replay = reopened.stop(leader, "release", task.id, "release", "leader-release", dispatch.claimID);
    assert.equal(replay.operation!.id, first.operation!.id);
    assert.deepEqual(replay.task, next);
    assert.equal(reopened.receipts(leader, "release").filter((receipt) => receipt.kind === "task.released").length, 1);
  } finally { reopened.close(); }
});

test("follow-up request reuse is checked and release fences a dispatched task until native stop is acknowledged", async (t) => {
  const { store, worker } = await fixture(t);
  const owner = worker("builder");
  const task = store.createTask(leader, "release", { title: "Build", description: "Build fixture" });
  const dispatch = store.dispatch(leader, "release", task.id, "builder", "dispatch");
  store.delivered(leader, "release", dispatch.id);
  const followup = store.followup(leader, "release", task.id, "follow", "Include the evidence");
  assert.equal(store.followup(leader, "release", task.id, "follow", "Include the evidence").id, followup.id);
  assert.throws(() => store.followup(leader, "release", task.id, "follow", "Changed message"), errorCode("CONFLICT"));
  assert.throws(() => store.followup(owner, "release", task.id, "worker-follow", "Spoof leader"), errorCode("FORBIDDEN"));
  assert.throws(() => store.release(owner, "release", task.id, dispatch.claimID), errorCode("NEEDS_STOP"));
  const stop = store.beginStop(owner, "release", task.id, "release", "release", dispatch.claimID);
  assert.equal(store.task(leader, "release", task.id).state, "stopping");
  assert.throws(() => store.finish(owner, "release", task.id, dispatch.claimID, "completed", "Late"), errorCode("STATE"));
  assert.throws(() => store.followup(leader, "release", task.id, "too-late", "No"), errorCode("STATE"));
  assert.equal(store.stopped(owner, "release", stop.id).state, "pending");
  assert.equal(store.member(leader, "release", "builder").state, "retired");
  assert.equal(store.operation(leader, "release", followup.id).state, "done");
  const next = store.claim(leader, "release", task.id);
  store.stopped(owner, "release", stop.id);
  assert.equal(store.task(leader, "release", task.id).claimID, next.claimID);
});
