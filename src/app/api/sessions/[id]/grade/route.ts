import { findSession } from "@/lib/sessionLookup";
import { getGradingSession } from "@/lib/sessionQueries";
import { getSessionJobStatus } from "@/lib/sessionJobs";
import { gradingImages } from "@/lib/artifacts";
import { claimJob, failJob, finishGrading, JOB_TIMING } from "@/lib/sessionJobs";
import { createOpenAIClient } from "@/lib/openai";
import { buildGradingInput, validateGradeReport } from "@/lib/rubric";
import { GRADE_FORMAT } from "@/lib/modelFormats";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = findSession(id, getGradingSession);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (row.grade) return Response.json({ grade: row.grade, status: "done" });
  if (row.status !== "ended") {
    return Response.json({ error: "session has not ended" }, { status: 409 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  const attempt = claimJob(id, "grade");
  if (!attempt) {
    const state = getSessionJobStatus(id)?.grade;
    return Response.json({ status: state?.status ?? "running", error: state?.error }, { status: 202 });
  }

  try {
    const elapsedSec =
      row.startedAt && row.endedAt ? Math.max(0, (row.endedAt - row.startedAt) / 1000) : undefined;
    const text = buildGradingInput({
      briefing: row.briefing,
      prompt: row.prompt,
      durationSec: row.durationSec,
      elapsedSec,
      transcript: row.transcript,
      timeline: row.timeline,
    });

    const imageParts = await gradingImages(id, row.timeline);

    const client = createOpenAIClient();
    const res = await client.responses.create({
      model: process.env.GRADING_MODEL ?? "gpt-5.6-terra",
      instructions:
        "You are an experienced hiring-committee bar raiser grading a recorded system design interview. Be calibrated, cite timestamps, and follow the requested JSON schema exactly.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text }, ...imageParts],
        },
      ],
      text: { format: GRADE_FORMAT },
    }, { signal: AbortSignal.timeout(JOB_TIMING.grade.timeoutMs), timeout: JOB_TIMING.grade.timeoutMs, maxRetries: 0 });

    const grade = validateGradeReport(JSON.parse(res.output_text));
    if (!finishGrading(attempt, grade)) {
      const current = getGradingSession(id);
      if (current?.grade) return Response.json({ grade: current.grade, status: "done" });
      throw new Error("grading claim was lost before the result could be saved");
    }
    return Response.json({ grade, status: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(attempt, message);
    return Response.json({ error: message, status: "failed" }, { status: 502 });
  }
}
