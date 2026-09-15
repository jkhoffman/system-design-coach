import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "interview-app-test-"));

const { summarizeScene } = await import("../src/lib/summarizeScene.ts");
const { Timeline } = await import("../src/lib/timeline.ts");
const { interviewPacing } = await import("../src/lib/pacing.ts");
const { buildGradingInput, validateGradeReport, RUBRIC } = await import("../src/lib/rubric.ts");
const {
  claimGrading,
  claimRecording,
  createSession,
  getSession,
  listSessionSummaries,
  updateSession,
} = await import("../src/lib/db.ts");
const { SessionPatchSchema } = await import("../src/lib/schemas.ts");

const shape = (id, x) => ({ id, type: "rectangle", x, y: 0, width: 100, height: 50 });
const connector = (overrides) => ({
  id: "edge",
  type: "arrow",
  x: 100,
  y: 25,
  width: 100,
  height: 0,
  startBinding: { elementId: "client" },
  endBinding: { elementId: "server" },
  ...overrides,
});
const elements = [shape("client", 0), shape("server", 200)];
assert.match(
  summarizeScene([...elements, connector({ startArrowhead: null, endArrowhead: "arrow" })]),
  /#clie -> #serv/
);
assert.match(
  summarizeScene([...elements, connector({ startArrowhead: "arrow", endArrowhead: null })]),
  /#serv -> #clie/
);
assert.match(
  summarizeScene([...elements, connector({ startArrowhead: "arrow", endArrowhead: "arrow" })]),
  /#clie <-> #serv/
);
assert.match(
  summarizeScene([
    ...elements,
    connector({
      startBinding: null,
      endBinding: null,
      points: [[0, 0], [100, 0]],
      startArrowhead: null,
      endArrowhead: "arrow",
    }),
  ]),
  /#clie -> #serv/
);
const labeledScene = summarizeScene([
  ...elements,
  { id: "label", type: "text", x: 20, y: 15, width: 60, height: 20, text: "Client" },
]);
assert.match(labeledScene, /rect "Client" @left/);
assert.doesNotMatch(labeledScene, /LABELS:/);

const timeline = new Timeline();
timeline.addBoardSummary(1000, "board");
timeline.addTranscriptFragment("candidate", "hello", 2000, 2500);
timeline.addSnapshot(1000, "milestone", "1000.png");
assert.deepEqual(
  timeline.getEvents().map((e) => e.startMs),
  [1000, 1000, 2000]
);

assert.deepEqual(
  interviewPacing(5 * 60).warnings.map((w) => w.remainingSec),
  [150, 60]
);
assert.deepEqual(
  interviewPacing(8 * 60).warnings.map((w) => w.remainingSec),
  [240, 96]
);
assert.deepEqual(
  interviewPacing(20 * 60).warnings.map((w) => w.remainingSec),
  [600, 300]
);
assert.deepEqual(
  interviewPacing(45 * 60).warnings.map((w) => w.remainingSec),
  [600, 300]
);

const gradingInput = buildGradingInput({
  briefing: { company: "Example", position: "SWE", level: "L5" },
  prompt: {
    id: "test",
    title: "test",
    question: "Design a service",
    context: "context",
    factSheet: [{ q: "Consistency?", a: "UNIQUE_FACT_SHEET_CONSTRAINT" }],
    deepDiveAngles: ["data model"],
  },
  durationSec: 2700,
  elapsedSec: 1200,
  transcript: [],
  timeline: [],
});
assert.match(gradingInput, /UNIQUE_FACT_SHEET_CONSTRAINT/);
assert.match(gradingInput, /approximately 20 minutes/);

const validGrade = {
  overall: { score: 9.9, signal: "hire", summary: "solid" },
  dimensions: RUBRIC.map((d) => ({
    key: d.key,
    label: d.label,
    score: 4,
    weight: d.weight,
    evidence: "evidence",
    moments: [],
  })),
  tradeoffAudit: [],
  strengths: [],
  antiPatterns: [],
  strongHireWouldHave: [],
  drills: [],
};
assert.equal(validateGradeReport(validGrade).overall.score, 4);
assert.throws(() => validateGradeReport({ ...validGrade, dimensions: validGrade.dimensions.slice(1) }));

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

assert.throws(() =>
  SessionPatchSchema.parse({
    kind: "progress",
    transcript: [],
    timeline: [{ kind: "snapshot", startMs: 0, label: "bad", file: "../outside.png" }],
  })
);

console.log("pure checks passed");
