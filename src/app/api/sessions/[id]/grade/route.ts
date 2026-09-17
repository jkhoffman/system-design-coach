import fs from "node:fs";
import path from "node:path";
import { getSession, SNAPSHOT_DIR } from "@/lib/db";
import { claimJob, failJob, finishGrading, JOB_TIMING } from "@/lib/sessionJobs";
import { createOpenAIClient } from "@/lib/openai";
import { buildGradingInput, GRADE_SCHEMA, validateGradeReport } from "@/lib/rubric";
import { SNAPSHOT_FILE_RE, validSessionId } from "@/lib/schemas";
import type { GradeReport } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const row = getSession(id);
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
    const current = getSession(id);
    if (current?.grade) return Response.json({ grade: current.grade, status: "done" });
    return Response.json(
      { status: current?.gradeStatus ?? "running", error: current?.gradeError },
      { status: 202 }
    );
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

    // Attach milestone snapshots (capped) + final board image as input images.
    const snapshotRoot = path.resolve(SNAPSHOT_DIR, id);
    const snapFiles = row.timeline
      .filter((e) => e.kind === "snapshot")
      .map((e) => (e as { file: string }).file)
      .filter((f) => SNAPSHOT_FILE_RE.test(f))
      .slice(0, 10);
    const imageParts: { type: "input_image"; image_url: string; detail: "high" }[] = [];
    for (const f of snapFiles) {
      const p = path.resolve(snapshotRoot, f);
      if (p.startsWith(snapshotRoot + path.sep) && fs.existsSync(/* turbopackIgnore: true */ p)) {
        imageParts.push({
          type: "input_image",
          image_url: `data:image/png;base64,${fs.readFileSync(/* turbopackIgnore: true */ p).toString("base64")}`,
          detail: "high",
        });
      }
    }
    if (row.finalImage?.startsWith("data:image/")) {
      imageParts.push({ type: "input_image", image_url: row.finalImage, detail: "high" });
    }

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
      text: {
        format: {
          type: "json_schema",
          name: "grade_report",
          schema: GRADE_SCHEMA,
          strict: true,
        },
      },
    }, { signal: AbortSignal.timeout(JOB_TIMING.grade.timeoutMs), timeout: JOB_TIMING.grade.timeoutMs, maxRetries: 0 });

    const grade = validateGradeReport(JSON.parse(res.output_text)) as GradeReport;
    if (!finishGrading(attempt, grade)) {
      const current = getSession(id);
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
