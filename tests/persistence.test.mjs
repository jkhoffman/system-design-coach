import { activateSession, ownerFor, finishFields } from "./helpers.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseFixture } from "./helpers.mjs";
import { sampleTrace } from "./fixtures.mjs";
const { db } = await databaseFixture();
const commands = await import("../src/lib/sessionCommands.ts");
const { finishSession, saveSessionProgress } = commands;
const { claimJob } = await import("../src/lib/sessionJobs.ts");
const { createSession, getSession, listSessionSummaries } = db;

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
  activateSession(commands, session.id);
  saveSessionProgress(session.id, { ...ownerFor(session.id), revision: 1, transcript: [], timeline: [], liveTrace: sampleTrace });
  finishSession(session.id, { ...finishFields(session.id), endedAt: Date.now(), transcript: [], timeline: [] });
  assert.ok(claimJob(session.id, "grade"));
  assert.equal(claimJob(session.id, "grade"), null);
  assert.equal(getSession(session.id).gradeStatus, "running");
  assert.equal(listSessionSummaries()[0].id, session.id);
  assert.equal(listSessionSummaries()[0].title, "test");
  
  assert.ok(claimJob(session.id, "recording"));
  assert.equal(claimJob(session.id, "recording"), null);
  assert.equal(getSession(session.id).recordingStatus, "running");
  
  
  assert.equal(getSession(session.id).liveTrace.length, sampleTrace.length);
});
