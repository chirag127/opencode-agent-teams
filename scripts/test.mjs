import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = readdirSync(".test-dist/test").filter((name) => name.endsWith(".test.js"));
const result = spawnSync(process.execPath, ["--test", ...files.map((name) => `.test-dist/test/${name}`)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
