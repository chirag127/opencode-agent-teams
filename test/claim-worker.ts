import { parentPort, workerData } from "node:worker_threads";
import { TeamsStore } from "../src/store.js";

const input = workerData as { filename: string; actor: { projectID: string; sessionID: string }; taskID: string };
const store = await TeamsStore.open(input.filename, input.actor.projectID);
parentPort!.once("message", () => {
  try {
    const task = store.claim(input.actor, "release", input.taskID);
    parentPort!.postMessage({ ok: true, owner: task.ownerSessionID, claimID: task.claimID });
  } catch (error) {
    parentPort!.postMessage({ ok: false, code: error instanceof Error && "code" in error ? error.code : String(error) });
  } finally { store.close(); }
});
parentPort!.postMessage({ ready: true });
