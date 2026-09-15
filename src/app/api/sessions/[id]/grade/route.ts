import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { getSession, updateSession, SNAPSHOT_DIR } from "@/lib/db";
import { buildGradingInput, GRADE_SCHEMA } from "@/lib/rubric";
import type { GradeReport } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = getSession(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  if (row.grade) return Response.json({ grade: row.grade });

  const text = buildGradingInput({
    briefing: row.briefing,
    prompt: row.prompt,
    durationSec: row.durationSec,
    transcript: row.transcript,
    timeline: row.timeline,
  });

  // Attach milestone snapshots (capped) + final board image as input images.
  const snapFiles = row.timeline
    .filter((e) => e.kind === "snapshot")
    .map((e) => (e as { file: string }).file)
    .slice(0, 10);
  const imageParts: { type: "input_image"; image_url: string; detail: "high" }[] = [];
  for (const f of snapFiles) {
    const p = path.join(SNAPSHOT_DIR, id, f);
    if (fs.existsSync(/* turbopackIgnore: true */ p)) {
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

  const client = new OpenAI();
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
  });

  const grade = JSON.parse(res.output_text) as GradeReport;
  updateSession(id, { grade, status: "graded" });
  return Response.json({ grade });
}
