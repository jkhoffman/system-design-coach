import { activateSession, finishFields } from "./helpers.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseFixture, fakeClock, sessionInput } from "./helpers.mjs";
import { gradeReport } from "../scripts/mock-fixtures.mjs";

const { db } = await databaseFixture();
const jobs = await import("../src/lib/sessionJobs.ts");
const commands = await import("../src/lib/sessionCommands.ts");
const { finishSession } = commands;
const { getDb } = await import("../src/lib/database.ts");
function endedSession() {
  const id = db.createSession(sessionInput).id;
  activateSession(commands, id, "live_job");
  finishSession(id, { ...finishFields(id), endedAt: Date.now(), transcript: [], timeline: [] });
  return id;
}

for (const kind of ["grade", "recording"]) {
  test(`${kind} leases fence both failure and success from previous attempts`, (t) => {
    const clock = fakeClock(t);
    const id = endedSession();
    const old = jobs.claimJob(id, kind);
    assert.ok(old);
    assert.equal(jobs.claimJob(id, kind), null);
    clock.advance(jobs.JOB_TIMING[kind].leaseMs + 1);
    assert.equal(jobs.getSessionJobStatus(id)[kind].stale, true);
    assert.equal(jobs.ownsJob(old), false);
    const current = jobs.claimJob(id, kind);
    assert.ok(current);
    assert.equal(jobs.failJob(old, "old failure"), false);
    const finish = kind === "grade" ? (a) => jobs.finishGrading(a, gradeReport()) : (a) => jobs.finishRecording(a, "/current.wav");
    assert.equal(finish(old), false);
    assert.equal(finish(current), true);
    assert.equal(jobs.failJob(current, "late failure after success"), false);
    assert.equal(jobs.getSessionJobStatus(id)[kind].status, "done");
    assert.equal(jobs.claimJob(id, kind), null);
  });
  test(`${kind} terminal failure permits an explicit new attempt`, () => {
    const id = endedSession();
    const first = jobs.claimJob(id, kind);
    assert.equal(jobs.failJob(first, "temporary problem"), true);
    assert.equal(jobs.getSessionJobStatus(id)[kind].error, "temporary problem");
    const second = jobs.claimJob(id, kind);
    assert.ok(second);
    assert.notEqual(first.token, second.token);
    assert.equal(jobs.getSessionJobStatus(id)[kind].error, undefined);
  });
}

test("legacy running jobs are reclaimable and status reads do not parse interview content", () => {
  const id = endedSession();
  getDb().prepare(`UPDATE interview_sessions SET grading_status = 'running', transcript = ?, live_trace = ? WHERE id = ?`)
    .run("not JSON", "x".repeat(100_000), id);
  const status = jobs.getSessionJobStatus(id);
  assert.equal(status.grade.stale, true);
  assert.ok(JSON.stringify(status).length < 500);
  assert.ok(jobs.claimJob(id, "grade"));
});

test("unavailable recordings cannot be claimed", () => {
  const id = db.createSession(sessionInput).id;
  activateSession(commands, id, "live_unstored", false);
  finishSession(id, { ...finishFields(id), endedAt: Date.now(), transcript: [], timeline: [] });
  assert.equal(jobs.getSessionJobStatus(id).recording.status, "unavailable");
  assert.equal(jobs.claimJob(id, "recording"), null);
});
