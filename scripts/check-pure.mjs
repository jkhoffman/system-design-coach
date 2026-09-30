import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const testFiles = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => `tests/${name}`);

const result = spawnSync(process.execPath, ["--import", "./scripts/register-source.mjs", "--test", ...testFiles], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
