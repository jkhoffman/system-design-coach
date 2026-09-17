import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fmtMs, formatSeconds } from "../src/lib/time.ts";
import { databaseFixture, sessionInput } from "./helpers.mjs";

test("evidence rounds while live clocks floor at minute boundaries", () => {
  assert.equal(fmtMs(59_600), "01:00");
  assert.equal(formatSeconds(59.6), "00:59");
  assert.equal(fmtMs(-1000), "00:00");
  assert.equal(formatSeconds(7200), "120:00");
});

const { db, directory } = await databaseFixture();
test("trace CLI loads the real session query modules without framework runtime", () => {
  const session = db.createSession(sessionInput);
  const result = spawnSync(process.execPath, ["scripts/live-trace-report.mjs", session.id], {
    encoding: "utf8", env: { ...process.env, APP_DATA_DIR: directory }, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`session: ${session.id}`));
  assert.match(result.stdout, /trace events: 0/);
});
