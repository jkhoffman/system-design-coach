import "server-only";
import { zodTextFormat } from "openai/helpers/zod";
import { GradeReportSchema, PromptSpecSchema } from "./schemas";

export const GRADE_FORMAT = zodTextFormat(GradeReportSchema, "grade_report");
export const PROMPT_FORMAT = zodTextFormat(PromptSpecSchema.omit({ id: true }), "prompt_spec");
