import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGradingInput, validateGradeReport, RUBRIC } from "../src/lib/rubric.ts";

test("grading", () => {
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
    overall: { score: 4.9, signal: "hire", summary: "solid" },
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
});
