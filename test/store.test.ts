import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TeamsStore } from "../src/store.js";

test("named teams and their real leader survive closing and reopening the database", async () => {
  await mkdir(".test-work", { recursive: true });
  const directory = await mkdtemp(join(".test-work", "teams-"));
  const filename = join(directory, "teams.sqlite");
  const actor = { projectID: "project-alpha", sessionID: "ses_leader" };
  const first = await TeamsStore.open(filename, actor.projectID);
  let second: TeamsStore | undefined;
  try {
    const created = first.createTeam(actor, "release");
    first.close();
    second = await TeamsStore.open(filename, actor.projectID);
    assert.deepEqual(second.listTeams(actor), [created]);
    assert.equal(created.leaderSessionID, "ses_leader");
    assert.equal(created.name, "release");
  } finally {
    first.close();
    second?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
