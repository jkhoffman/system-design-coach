import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.APP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "interview-app-test-"));

const { summarizeScene } = await import("../src/lib/summarizeScene.ts");
const { Timeline } = await import("../src/lib/timeline.ts");
const { interviewClockContext, interviewPacing } = await import("../src/lib/pacing.ts");
const { buildGradingInput, validateGradeReport, RUBRIC } = await import("../src/lib/rubric.ts");
const {
  claimGrading,
  claimRecording,
  createSession,
  getSession,
  listSessionSummaries,
  updateSession,
} = await import("../src/lib/db.ts");
const { SessionPatchSchema, CreateSessionSchema, ExpandPromptSchema } = await import(
  "../src/lib/schemas.ts"
);
const { analyzeLiveTrace } = await import("../src/lib/liveTraceAnalysis.ts");

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
assert.equal(interviewClockContext(30 * 60, 299_999), null);
assert.equal(
  interviewClockContext(30 * 60, 300_000),
  "[interview clock] elapsed 05:00 of 30:00 (25:00 remaining)"
);
assert.equal(interviewClockContext(30 * 60, 1_800_000), null);

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

const trace = (seq, dir, sessionMs, type, extra = {}) => ({
  seq,
  dir,
  atPerfMs: sessionMs,
  sessionMs,
  type,
  ...extra,
});
const sampleTrace = [
  trace(1, "in", 0, "session.started"),
  trace(2, "in", 1_000, "session.input_transcript.delta", { endMs: 1_500, speaker: "candidate" }),
  trace(3, "in", 4_000, "session.delegation.created"),
  trace(4, "in", 5_000, "response.event", { innerType: "response.created" }),
  trace(5, "in", 7_000, "response.event", {
    innerType: "response.output_item.done",
    itemType: "function_call",
    callId: "call_1",
    toolName: "view_whiteboard",
  }),
  trace(6, "local", 7_500, "tool.handler.start", { callId: "call_1" }),
  trace(7, "out", 8_000, "response.item.create", {
    itemType: "function_call_output",
    callId: "call_1",
    sent: true,
  }),
  trace(8, "out", 8_500, "response.create", { sent: true }),
  trace(9, "in", 12_000, "response.event", { innerType: "response.completed" }),
  trace(10, "in", 14_000, "session.output_transcript.delta", {
    startMs: 14_500,
    speaker: "interviewer",
  }),
  trace(11, "out", 15_000, "session.thinking.append", { clientEventId: "append_1", sent: true }),
  trace(12, "in", 15_500, "session.thinking.appended", { eventId: "append_1" }),
  trace(13, "in", 16_000, "session.closed"),
];
const traceReport = analyzeLiveTrace(sampleTrace);
const stageMs = Object.fromEntries(traceReport.stages.map((s) => [s.name, s.durationMs]));
assert.equal(stageMs.candidate_end_to_delegation, 2_500);
assert.equal(stageMs.delegation_to_response_created, 1_000);
assert.equal(stageMs.delegation_to_tool_call, 3_000);
assert.equal(stageMs.tool_call_to_tool_result, 1_000);
assert.equal(stageMs.tool_result_to_continuation, 500);
assert.equal(stageMs.continuation_to_response_completed, 3_500);
assert.equal(stageMs.response_completed_to_interviewer_transcript, 2_500);
assert.deepEqual(traceReport.appendLatencies.map((l) => l.durationMs), [500]);
assert.equal(traceReport.turnGaps[0].durationMs, 13_000);
assert(traceReport.gaps.some((g) => g.classification === "turn_taking"));
assert(traceReport.gaps.some((g) => g.classification === "backend_response"));
assert.equal(traceReport.missingSignals.length, 0);

updateSession(session.id, { liveTrace: sampleTrace });
assert.equal(getSession(session.id).liveTrace.length, sampleTrace.length);
assert.equal(
  SessionPatchSchema.parse({ kind: "progress", transcript: [], timeline: [], liveTrace: sampleTrace })
    .liveTrace.length,
  sampleTrace.length
);

assert.throws(() =>
  SessionPatchSchema.parse({
    kind: "progress",
    transcript: [],
    timeline: [{ kind: "snapshot", startMs: 0, label: "bad", file: "../outside.png" }],
  })
);

const freeformBody = CreateSessionSchema.parse({
  mode: "freeform",
  briefing: { level: "L5" },
  prompt: {
    id: "x",
    title: "t",
    question: "q",
    context: "",
    factSheet: [{ q: "q", a: "a" }],
    deepDiveAngles: ["a"],
  },
  durationSec: 1200,
});
assert.equal(freeformBody.mode, "freeform");
assert.equal(
  ExpandPromptSchema.parse({ level: "L5", description: "  design a ledger  " }).description,
  "design a ledger"
);
assert.throws(() => ExpandPromptSchema.parse({ level: "L5", description: "   " }));
assert.throws(() => ExpandPromptSchema.parse({ description: "design a ledger" }));

console.log("pure checks passed");
