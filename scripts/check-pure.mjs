import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--import", "./scripts/test-register.mjs", "--test", "tests/*.test.mjs"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
