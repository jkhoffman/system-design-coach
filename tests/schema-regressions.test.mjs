import test from "node:test";
import assert from "node:assert/strict";
import { GradeReportSchema, SessionPatchSchema, CreateSessionSchema, LiveTraceSchema } from "../src/lib/schemas.ts";
import { LiveTrace } from "../src/lib/liveTrace.ts";
import { analyzeLiveTrace } from "../src/lib/liveTraceAnalysis.ts";
import { GRADE_FORMAT, PROMPT_FORMAT } from "../src/lib/modelFormats.ts";
import { gradeReport, promptSpec } from "../scripts/mock-fixtures.mjs";
import { validateGradeReport } from "../src/lib/rubric.ts";
import { normalizeLegacyGrade } from "../src/lib/legacyContracts.ts";
import { databaseFixture, sessionInput } from "./helpers.mjs";

test("canonical model formats are strict SDK schemas and parse fixture outputs", () => {
  for (const format of [GRADE_FORMAT, PROMPT_FORMAT]) {
    assert.equal(format.type, "json_schema");
    assert.equal(format.strict, true);
    const visit = (schema) => {
      if (!schema || typeof schema !== "object") return;
      if (schema.type === "object") {
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      }
      for (const value of Object.values(schema)) {
        if (Array.isArray(value)) value.forEach(visit); else visit(value);
      }
    };
    visit(format.schema);
  }
  assert.deepEqual(GRADE_FORMAT.$parseRaw(JSON.stringify(gradeReport())), GradeReportSchema.parse(gradeReport()));
  assert.equal(PROMPT_FORMAT.$parseRaw(JSON.stringify(promptSpec())).title, promptSpec().title);
});

test("all fields consumed by review are validated, with explicit legacy normalization", () => {
  for (const field of ["tradeoffAudit", "strengths", "antiPatterns", "strongHireWouldHave", "drills"]) {
    const malformed = gradeReport();
    delete malformed[field];
    assert.throws(() => validateGradeReport(malformed));
    assert.ok(normalizeLegacyGrade(malformed));
    malformed[field] = 7;
    assert.equal(normalizeLegacyGrade(malformed), undefined);
  }
  const malformed = gradeReport();
  malformed.dimensions[0].moments = [{ startMs: "bad", note: "bad" }];
  assert.throws(() => validateGradeReport(malformed));
});

test("creation discriminant requires its own prompt reference", () => {
  for (const mode of ["library", "custom", "freeform"]) {
    assert.equal(CreateSessionSchema.safeParse({ mode, briefing: { level: "L5" }, durationSec: 300 }).success, false);
  }
});

test("trace producer and ingestion share limits and discard unknown payload", () => {
  const trace = new LiveTrace();
  trace.incoming("null");
  trace.incoming(JSON.stringify({ type: "error", error: { message: "x".repeat(20_000) } }));
  trace.mark("long.detail", "x".repeat(10_000));
  assert.ok(LiveTraceSchema.safeParse(trace.snapshot()).success);
  const command = SessionPatchSchema.parse({ kind: "finish", endedAt: 1, transcript: [], timeline: [],
    liveTrace: [null, { ...trace.snapshot()[1], rawAudio: "private", error: "x".repeat(20_000), offsetMs: -10 }] });
  assert.equal(command.liveTrace.length, 1);
  assert.equal(command.liveTrace[0].error.length, 2000);
  assert.equal(command.liveTrace[0].rawAudio, undefined);
  assert.equal(command.liveTrace[0].offsetMs, undefined);
  assert.equal(SessionPatchSchema.parse({ ...command, liveTrace: "bad" }).liveTrace, undefined);
});

test("mixed clocks and reordered acknowledgments retain correct durations; unsent events are excluded", () => {
  const trace = [
    { seq: 1, dir: "local", atPerfMs: 4000, type: "mic.request" },
    { seq: 2, dir: "in", atPerfMs: 5000, sessionMs: 0, type: "session.started" },
    { seq: 3, dir: "out", atPerfMs: 5100, sessionMs: 100, type: "session.thinking.append", eventId: "one", sent: true },
    { seq: 4, dir: "out", atPerfMs: 5200, sessionMs: 200, type: "session.thinking.append", eventId: "two", sent: true },
    { seq: 5, dir: "out", atPerfMs: 5300, sessionMs: 300, type: "session.thinking.append", eventId: "three", sent: false },
    { seq: 6, dir: "in", atPerfMs: 5400, sessionMs: 400, type: "session.thinking.appended", eventId: "two" },
    { seq: 7, dir: "in", atPerfMs: 5700, sessionMs: 700, type: "session.thinking.appended", eventId: "one" },
    { seq: 8, dir: "in", atPerfMs: 5800, sessionMs: 800, type: "session.thinking.appended", eventId: "three" },
  ];
  const result = analyzeLiveTrace(trace);
  assert.equal(result.durationMs, 1800);
  assert.deepEqual(result.appendLatencies.map((entry) => [entry.clientEventId, entry.durationMs]), [["one", 600], ["two", 200]]);
});

const { db } = await databaseFixture();
test("invalid diagnostics do not block a real final save", async () => {
  const { reserveSessionStart, completeSessionStart } = await import("../src/lib/sessionCommands.ts");
  const { PATCH } = await import("../src/app/api/sessions/[id]/route.ts");
  const session = db.createSession(sessionInput);
  completeSessionStart(session.id, reserveSessionStart(session.id), "live");
  const response = await PATCH(new Request("http://localhost/session", { method: "PATCH", body: JSON.stringify({
    kind: "finish", endedAt: Date.now(), transcript: [], timeline: [], liveTrace: [{ garbage: "value" }],
  }) }), { params: Promise.resolve({ id: session.id }) });
  assert.equal(response.status, 200);
  assert.equal(db.getSession(session.id).status, "ended");
});
