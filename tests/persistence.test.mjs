import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseFixture } from "./helpers.mjs";
import { sampleTrace } from "./fixtures.mjs";
const { db } = await databaseFixture();
const { claimJob } = await import("../src/lib/sessionJobs.ts");
const { createSession, getSession, listSessionSummaries, updateSession } = db;

test("persistence", () => {
  const session = createSession({
    mode: "library",
    briefing: { company: "Example", position: "SWE", level: "L5" },
    prompt: {
      id: "test",
      title: "test",
      question: "Design a service",
      context: "context",
      factSheet: [{ q: "q", a: "a" }],
      deepDiveAngles: ["angle"],
    },
    durationSec: 1200,
  });
  assert.equal(claimJob(session.id, "grade"), null);
  updateSession(session.id, { status: "ended", endedAt: Date.now() });
  assert.ok(claimJob(session.id, "grade"));
  assert.equal(claimJob(session.id, "grade"), null);
  assert.equal(getSession(session.id).gradeStatus, "running");
  assert.equal(listSessionSummaries()[0].id, session.id);
  assert.equal(listSessionSummaries()[0].title, "test");
  
  updateSession(session.id, { liveSessionId: "live_test" });
  assert.ok(claimJob(session.id, "recording"));
  assert.equal(claimJob(session.id, "recording"), null);
  assert.equal(getSession(session.id).recordingStatus, "running");
  
  
  updateSession(session.id, { liveTrace: sampleTrace });
  assert.equal(getSession(session.id).liveTrace.length, sampleTrace.length);
});
