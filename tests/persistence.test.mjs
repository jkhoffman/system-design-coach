import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseFixture } from "./helpers.mjs";
import { sampleTrace } from "./fixtures.mjs";
const { db } = await databaseFixture();
const { claimGrading, claimRecording, createSession, getSession, listSessionSummaries, updateSession } = db;

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
  assert.equal(claimGrading(session.id), false);
  updateSession(session.id, { status: "ended", endedAt: Date.now() });
  assert.equal(claimGrading(session.id), true);
  assert.equal(claimGrading(session.id), false);
  assert.equal(getSession(session.id).gradeStatus, "running");
  assert.equal(listSessionSummaries()[0].id, session.id);
  assert.equal(listSessionSummaries()[0].title, "test");
  
  updateSession(session.id, { liveSessionId: "live_test" });
  assert.equal(claimRecording(session.id), true);
  assert.equal(claimRecording(session.id), false);
  assert.equal(getSession(session.id).recordingStatus, "running");
  
  
  updateSession(session.id, { liveTrace: sampleTrace });
  assert.equal(getSession(session.id).liveTrace.length, sampleTrace.length);
});
