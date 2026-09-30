import assert from "node:assert/strict";
import { test } from "node:test";
import { interviewClockContext, interviewPacing } from "../src/lib/pacing.ts";
import { buildInterviewerInstructions, buildSessionConfig } from "../src/lib/persona.ts";
import { sessionInput } from "./helpers.mjs";

test("pacing", () => {
  for (const minutes of [5, 8, 10, 15, 20, 30, 45, 60, 90, 120]) {
    const pacing = interviewPacing(minutes * 60);
    assert.deepEqual(pacing.milestones.map((item) => item.id),
      ["clarification", "architecture", "deep_dive", "coverage", "summary"]);
    assert.ok(pacing.milestones.every((item, index, all) =>
      item.elapsedSec > 0 && item.elapsedSec < minutes * 60 && (index === 0 || item.elapsedSec > all[index - 1].elapsedSec)));
  }
  const fortyFive = interviewPacing(45 * 60);
  assert.equal(fortyFive.milestones.find((item) => item.id === "deep_dive").elapsedSec, 1431);
  assert.equal(fortyFive.milestones.find((item) => item.id === "summary").elapsedSec, 2430);
  assert.equal(interviewClockContext(30 * 60, 299_999), null);
  assert.equal(
    interviewClockContext(30 * 60, 300_000),
    "[interview clock] elapsed 05:00 of 30:00 (25:00 remaining)"
  );
  assert.equal(interviewClockContext(30 * 60, 1_800_000), null);
});

test("GPT-Live prompt has explicit conversation policies and sequential tools", () => {
  const prompt = buildInterviewerInstructions(sessionInput);
  for (const heading of ["Backchannel policy:", "Interruption policy:", "Delegation policy:", "SILENCE AND PACING"]) {
    assert.match(prompt, new RegExp(heading));
  }
  assert.match(prompt, /Do not delegate to the backend when:/);
  assert.equal(buildSessionConfig(sessionInput).delegation.responses.parallel_tool_calls, false);
});
