import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeLiveTrace } from "../src/lib/liveTraceAnalysis.ts";
import { sampleTrace } from "./fixtures.mjs";

test("diagnostics", () => {
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
});
