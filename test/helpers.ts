import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { TeamsStore } from "../src/store.js";

export const leader = { projectID: "project-alpha", sessionID: "ses_leader" };

export async function fixture(t: TestContext) {
  await mkdir(".test-work", { recursive: true });
  const directory = await mkdtemp(join(".test-work", "teams-"));
  const filename = join(directory, "teams.sqlite");
  const store = await TeamsStore.open(filename, leader.projectID);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  store.createTeam(leader, "release");
  const worker = (name: string) => {
    const member = store.reserveMember(leader, "release", name, "build");
    store.activateMember(leader, "release", name);
    return { projectID: leader.projectID, sessionID: member.sessionID };
  };
  return { store, filename, directory, worker };
}

export const errorCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;
