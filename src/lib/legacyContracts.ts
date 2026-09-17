import { z } from "zod";
import { GradeReportSchema, DimensionScoreSchema, TradeoffAuditEntrySchema } from "./schemas";

const text = z.string();
const evidenceTime = z.unknown().transform((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
/** Read compatibility is deliberately broader than the new-model write contract. */
export const HistoricalGradeSchema = GradeReportSchema.extend({
  overall: GradeReportSchema.shape.overall.extend({ summary: text }),
  dimensions: z.array(DimensionScoreSchema.extend({ label: text, evidence: text,
    moments: z.array(z.object({ startMs: evidenceTime, note: text })).default([]),
  })).length(6),
  tradeoffAudit: z.array(TradeoffAuditEntrySchema.extend({ choice: text, startMs: evidenceTime })).default([]),
  strengths: z.array(text).default([]),
  antiPatterns: z.array(z.object({ startMs: evidenceTime, description: text })).default([]),
  strongHireWouldHave: z.array(text).default([]), drills: z.array(text).default([]),
});
export type ReadableGradeReport = z.infer<typeof HistoricalGradeSchema>;
export function normalizeLegacyGrade(input: unknown): ReadableGradeReport | undefined {
  const result = HistoricalGradeSchema.safeParse(input);
  return result.success ? result.data : undefined;
}
export function readStoredGrade(raw: unknown):
  { state: "absent" } | { state: "readable"; grade: ReadableGradeReport } | { state: "unreadable"; reason: string } {
  if (raw == null) return { state: "absent" };
  try {
    const grade = normalizeLegacyGrade(typeof raw === "string" ? JSON.parse(raw) : raw);
    if (grade) return { state: "readable", grade };
  } catch { /* A corrupt historical JSON value needs a repair action, not a render failure. */ }
  return { state: "unreadable", reason: "The saved scorecard cannot be read. Generate a replacement from the saved interview; the original is retained until grading succeeds." };
}
