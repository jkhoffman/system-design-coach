import { GradeReportSchema } from "./schemas";
import type { GradeReport } from "./types";

/** Older validators accepted reports without ancillary arrays. Normalize only that known legacy shape. */
export function normalizeLegacyGrade(input: unknown): GradeReport | undefined {
  if (!input || typeof input !== "object") return undefined;
  const result = GradeReportSchema.safeParse({
    tradeoffAudit: [], strengths: [], antiPatterns: [], strongHireWouldHave: [], drills: [],
    ...input,
  });
  return result.success ? result.data : undefined;
}
