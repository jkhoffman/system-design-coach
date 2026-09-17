import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionPatchSchema, CreateSessionSchema, ExpandPromptSchema } from "../src/lib/schemas.ts";
import { sampleTrace } from "./fixtures.mjs";

test("contracts", () => {
  assert.equal(
    SessionPatchSchema.parse({ kind: "progress", revision: 1, transcript: [], timeline: [], liveTrace: sampleTrace })
      .liveTrace.length,
    sampleTrace.length
  );
  
  assert.throws(() =>
    SessionPatchSchema.parse({
      kind: "progress", revision: 1,
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
});
