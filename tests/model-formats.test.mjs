import test from "node:test";
import assert from "node:assert/strict";
import { GradeReportSchema } from "../src/lib/schemas.ts";
import { GRADE_FORMAT, PROMPT_FORMAT } from "../src/lib/modelFormats.ts";
import { gradeReport } from "../scripts/mock-fixtures.mjs";
import { assertStrictFormat } from "../scripts/strict-schema-profile.mjs";

test("serialized model schemas reject annotations without weakening write validation", () => {
  for (const format of [GRADE_FORMAT, PROMPT_FORMAT]) {
    const wire = JSON.parse(JSON.stringify(format));
    assertStrictFormat(wire);
    const bad = structuredClone(wire);
    bad.schema.properties.injected = { type: "string", default: "" };
    bad.schema.required.push("injected");
    assert.throws(() => assertStrictFormat(bad), /default/);
  }
  assert.equal(GRADE_FORMAT.schema.properties.overall.properties.score.minimum, 1);
  assert.equal(PROMPT_FORMAT.schema.properties.context.default, undefined);
  const malformed = gradeReport(); malformed.dimensions[0].score = 10;
  assert.equal(GradeReportSchema.safeParse(malformed).success, false);
});
