import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const digest = async () => createHash("sha256").update(await fs.readFile("docs/demo.gif")).digest("hex");
const before = await digest();
const child = spawn(process.execPath, ["scripts/record-demo.mjs", "--skip-build", "--fail-after-capture"], { stdio: "inherit" });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
assert.equal(code, 1, "injected capture failure must fail the recorder");
assert.match(await fs.readFile("artifacts/demo/failure.txt", "utf8"), /Injected failure after capture/);
assert.equal(await digest(), before, "failed capture replaced the existing GIF");
const { appUrl, mockUrl, dataDir } = JSON.parse(await fs.readFile("artifacts/demo/environment.json", "utf8"));
await assert.rejects(fs.stat(dataDir), { code: "ENOENT" });
await assert.rejects(fs.stat("docs/.demo.pending.gif"), { code: "ENOENT" });
for (const url of [appUrl, mockUrl]) {
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }), "server still listening after failed capture");
}
console.log("Capture failure preserved the GIF, removed temporary data, and stopped both servers.");
