import assert from "node:assert/strict";
import test from "node:test";
import { TeamsStore } from "../src/store.js";
import { errorCode, fixture, leader } from "./helpers.js";

test("dependencies block claims until completed, including failed and cancelled prerequisites", async (t) => {
  const { store, worker } = await fixture(t);
  const a = store.createTask(leader, "release", { title: "Compile", description: "Compile fixture" });
  const b = store.createTask(leader, "release", { title: "Ship", description: "Ship fixture", dependencies: [a.id] });
  const first = worker("compiler");
  assert.throws(() => store.claim(first, "release", b.id), errorCode("BLOCKED"));
  const claim = store.claim(first, "release", a.id);
  store.finish(first, "release", a.id, claim.claimID!, "failed", "Compiler failed");
  assert.deepEqual(store.task(leader, "release", b.id).blockedBy, [a.id]);
  store.retry(leader, "release", a.id);
  store.cancel(leader, "release", a.id);
  assert.throws(() => store.claim(leader, "release", b.id), errorCode("BLOCKED"));
  store.retry(leader, "release", a.id);
  const second = worker("compiler-retry");
  const next = store.claim(second, "release", a.id);
  store.finish(second, "release", a.id, next.claimID!, "completed", "Compiled successfully");
  assert.deepEqual(store.claim(leader, "release", b.id).blockedBy, []);
});

test("cycles, cross-team dependencies and stale graph edits roll back without partial changes", async (t) => {
  const { store } = await fixture(t);
  const a = store.createTask(leader, "release", { title: "A", description: "First" });
  const b = store.createTask(leader, "release", { title: "B", description: "Second", dependencies: [a.id] });
  const c = store.createTask(leader, "release", { title: "C", description: "Third", dependencies: [b.id] });
  assert.throws(() => store.updateTask(leader, "release", a.id, { version: a.version, dependencies: [c.id] }), errorCode("CYCLE"));
  assert.throws(() => store.updateTask(leader, "release", a.id, { version: a.version, dependencies: [a.id] }), errorCode("CYCLE"));
  store.createTeam(leader, "foreign");
  const foreign = store.createTask(leader, "foreign", { title: "Foreign", description: "Other team" });
  assert.throws(() => store.updateTask(leader, "release", a.id, { version: a.version, dependencies: [foreign.id] }), errorCode("NOT_FOUND"));
  assert.deepEqual(store.task(leader, "release", a.id), a);
  const updated = store.updateTask(leader, "release", a.id, { version: a.version, title: "Updated" });
  assert.throws(() => store.updateTask(leader, "release", a.id, { version: a.version, description: "Stale" }), errorCode("CONFLICT"));
  assert.equal(store.task(leader, "release", a.id).title, updated.title);
});

test("claim ownership and generation fence stale workers across release, cancellation and retry", async (t) => {
  const { store, worker, filename } = await fixture(t);
  const one = worker("one");
  const two = worker("two");
  const task = store.createTask(leader, "release", { title: "Work", description: "Do fixture" });
  const claim = store.claim(one, "release", task.id);
  assert.equal(store.claim(one, "release", task.id).claimID, claim.claimID);
  assert.throws(() => store.claim(two, "release", task.id), errorCode("CONFLICT"));
  assert.throws(() => store.finish(two, "release", task.id, claim.claimID!, "completed", "Forged"), errorCode("FORBIDDEN"));
  assert.throws(() => store.progress(one, "release", task.id, "stale", "Wrong generation"), errorCode("STALE_CLAIM"));
  store.release(one, "release", task.id, claim.claimID!);
  const next = store.claim(two, "release", task.id);
  assert.notEqual(next.claimID, claim.claimID);
  assert.throws(() => store.finish(one, "release", task.id, claim.claimID!, "completed", "Late result"));
  store.start(two, "release", task.id, next.claimID!);
  store.progress(two, "release", task.id, next.claimID!, "Checked input");
  const reopened = await TeamsStore.open(filename, leader.projectID);
  try {
    assert.equal(reopened.task(two, "release", task.id).progress, "Checked input");
    assert.equal(reopened.task(two, "release", task.id).claimID, next.claimID);
  } finally { reopened.close(); }
  store.cancel(leader, "release", task.id);
  assert.throws(() => store.finish(two, "release", task.id, next.claimID!, "completed", "After cancellation"), errorCode("STATE"));
  store.retry(leader, "release", task.id);
  const final = store.claim(leader, "release", task.id);
  const completed = store.finish(leader, "release", task.id, final.claimID!, "completed", "Evidence: fixture passed");
  assert.equal(completed.result, "Evidence: fixture passed");
  assert.throws(() => store.retry(leader, "release", task.id), errorCode("STATE"));
  assert.ok(store.receipts(leader, "release").some((receipt) => receipt.kind === "task.released" && receipt.claimID === claim.claimID));
});

test("project binding, nonmembers, leader authority and retired-worker claims are enforced", async (t) => {
  const { store, worker, filename } = await fixture(t);
  const member = worker("worker");
  const outsider = { projectID: leader.projectID, sessionID: "ses_foreign" };
  const foreignProject = { ...leader, projectID: "project-beta" };
  assert.throws(() => store.members(outsider, "release"), errorCode("FORBIDDEN"));
  assert.throws(() => store.createTeam(foreignProject, "other"), errorCode("PROJECT"));
  assert.throws(() => store.reserveMember(member, "release", "intruder", "build"), errorCode("FORBIDDEN"));
  assert.throws(() => store.createTask(member, "release", { title: "No", description: "Leader only" }), errorCode("FORBIDDEN"));
  await assert.rejects(TeamsStore.open(filename, "project-beta"), errorCode("PROJECT"));
  const task = store.createTask(leader, "release", { title: "Work", description: "One attempt" });
  const claim = store.claim(member, "release", task.id);
  store.finish(member, "release", task.id, claim.claimID!, "completed", "Done");
  const next = store.createTask(leader, "release", { title: "Next", description: "New worker needed" });
  assert.throws(() => store.claim(member, "release", next.id), errorCode("STATE"));
});
