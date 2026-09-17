import assert from "node:assert/strict";
import { test } from "node:test";
import { Timeline } from "../src/lib/timeline.ts";

test("timeline", () => {
  const timeline = new Timeline();
  timeline.addBoardSummary(1000, "board");
  timeline.addTranscriptFragment("candidate", "hello", 2000, 2500);
  timeline.addSnapshot(1000, "milestone", "1000.png");
  assert.deepEqual(
    timeline.getEvents().map((e) => e.startMs),
    [1000, 1000, 2000]
  );
});
