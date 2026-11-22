import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.env.npm_execpath;
assert.ok(npm, "Run this check with npm run test:pack");
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 300_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const compiler = join(root, "node_modules/typescript/bin/tsc6");
run([compiler, "-p", "tsconfig.build.json"]);
run([compiler, "-p", "tsconfig.test.json"]);
const packResult = JSON.parse(run([npm, "pack", "--ignore-scripts", "--json"]));
// npm releases return either an array or a package-name-keyed object.
const [packed] = Array.isArray(packResult) ? packResult : Object.values(packResult);
assert.equal(packed?.name, "opencode-agent-teams");
assert.ok(packed.files.some((file) => file.path === "dist/index.js"));
assert.ok(packed.files.some((file) => file.path === "dist/index.d.ts"));
assert.ok(packed.files.every((file) => !file.path.startsWith("src/") && !file.path.startsWith("test/") && !file.path.includes(".sqlite")));
const tarball = resolve(root, packed.filename);
await mkdir(join(root, ".test-work"), { recursive: true });
const fixture = await mkdtemp(join(root, ".test-work", "pack-"));
let verified = false;
try {
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "agent-teams-packed-fixture", private: true, type: "module",
    dependencies: { "opencode-agent-teams": pathToFileURL(tarball).href, "@opencode/plugin": "2.3.2" },
  }, null, 2));
  run([npm, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", "--prefer-offline"], fixture);
  await writeFile(join(fixture, "contract.ts"), `import plugin from "opencode-agent-teams";
import type { Plugin } from "@opencode/plugin";
const definition: Plugin.Plugin = plugin;
export default definition;
`);
  await writeFile(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: true, noEmit: true, types: [],
  }, files: ["contract.ts"] }));
  run([compiler, "-p", "tsconfig.json"], fixture);
  const hostURL = pathToFileURL(join(root, ".test-dist/test/host.js")).href;
  await writeFile(join(fixture, "smoke.mjs"), `import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import { syntheticHost } from ${JSON.stringify(hostURL)};
const entry = Host.resolve({ directory: process.cwd(), name: "opencode-agent-teams" });
assert.ok(entry.server?.endsWith("dist/index.js"));
const loaded = await Host.load(entry.server);
const plugin = loaded.default;
assert.equal(plugin.id, "agent-teams");
const host = syntheticHost(resolve("project"));
const get = host.context.session.get;
host.context.session.get = async (input, options) => {
  if (!host.sessions.has(input.sessionID)) {
    throw { _tag: "Session.NotFoundError", name: "Session.NotFoundError", message: "", sessionID: input.sessionID };
  }
  return get(input, options);
};
const cleanup = await plugin.setup(host.context);
try {
  const team = await host.call("team_create", { name: "packed" });
  const task = await host.call("task_create", { team: "packed", title: "Packed entry", description: "Synthetic artifact verification" });
  const member = await host.call("member_create", { team: "packed", name: "builder" });
  const dispatch = await host.call("task_dispatch", { team: "packed", taskID: task.id, member: "builder", requestID: "packed-dispatch" });
  assert.equal(dispatch.state, "done");
  assert.equal(host.admissions.size, 1);
  assert.equal([...host.admissions.values()][0].sessionID, member.sessionID);
  assert.equal(team.leaderSessionID, "ses_leader");
  assert.equal(host.tools.size, 21);
  const followup = await host.call("task_followup", { team: "packed", taskID: task.id, requestID: "packed-followup", message: "Include the synthetic evidence" });
  assert.equal(followup.state, "done");
  const cancelled = await host.call("task_cancel", { team: "packed", taskID: task.id, requestID: "packed-cancel" });
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(await host.context.session.instructions.entry.list({ sessionID: member.sessionID }), []);
  console.log(JSON.stringify({ plugin: plugin.id, tools: host.tools.size, entry: entry.server, nativeMissingTag: "Session.NotFoundError", syntheticDispatch: "passed", schemaBoundInstructionsAndStop: "passed" }));
} finally { await cleanup?.(); }
`);
  const installed = JSON.parse(await readFile(join(fixture, "node_modules/@opencode/plugin/package.json"), "utf8"));
  assert.equal(installed.version, "2.3.2");
  console.log(run(["smoke.mjs"], fixture).trim());
  const receipt = { tarball, sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"), sha512: packed.integrity,
    consumer: fixture, installedPackage: join(fixture, "node_modules/opencode-agent-teams"),
    packedFiles: packed.files.length, publishedTypes: "passed", installedEntrypoint: "passed" };
  await writeFile(join(fixture, "verification.json"), JSON.stringify(receipt, null, 2) + "\n");
  verified = true;
  console.log(JSON.stringify(receipt));
} finally {
  if (!verified) await rm(fixture, { recursive: true, force: true, maxRetries: 3 });
}
