import assert from "node:assert/strict";
import { test } from "node:test";
import { interviewClockContext, interviewPacing } from "../src/lib/pacing.ts";

test("pacing", () => {
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
});
