import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { TeamsStore } from "../src/store.js";
import { fixture, leader } from "./helpers.js";

test("simultaneous claims on independent SQLite connections commit exactly one owner and receipt", async (t) => {
  const { store, filename, worker } = await fixture(t);
  const task = store.createTask(leader, "release", { title: "Contended", description: "Only one winner" });
  const actors = [worker("left"), worker("right")];
  const threads = actors.map((actor) => new Worker(new URL("./claim-worker.js", import.meta.url), { workerData: { actor, filename, taskID: task.id } }));
  t.after(async () => { await Promise.all(threads.map((thread) => thread.terminate())); });
  await Promise.all(threads.map((thread) => once(thread, "message")));
  const results = threads.map((thread) => once(thread, "message"));
  threads.forEach((thread) => thread.postMessage("claim"));
  const outcomes = (await Promise.all(results)).map(([result]) => result as { ok: boolean; owner?: string; code?: string });
  assert.equal(outcomes.filter((result) => result.ok).length, 1);
  assert.equal(outcomes.find((result) => !result.ok)!.code, "CONFLICT");
  const reopened = await TeamsStore.open(filename, leader.projectID);
  try {
    assert.equal(reopened.task(leader, "release", task.id).ownerSessionID, outcomes.find((result) => result.ok)!.owner);
    assert.equal(reopened.receipts(leader, "release").filter((receipt) => receipt.kind === "task.claimed").length, 1);
  } finally { reopened.close(); }
});
