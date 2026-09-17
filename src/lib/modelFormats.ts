import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import { GradeReportSchema, PromptSpecSchema } from "./schemas";
import { modelSchema } from "./modelSchema";

export const GRADE_FORMAT = zodTextFormat(GradeReportSchema, "grade_report");
export const PROMPT_FORMAT = zodTextFormat(PromptSpecSchema.omit({ id: true }), "prompt_spec");

// Preserve the SDK's non-enumerable parser helpers; only the wire schema changes.
GRADE_FORMAT.schema = modelSchema(GRADE_FORMAT.schema);
PROMPT_FORMAT.schema = modelSchema(PROMPT_FORMAT.schema);
