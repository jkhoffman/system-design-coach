import { findSession } from "@/lib/sessionLookup";
import { getRecordingSession } from "@/lib/sessionQueries";
import { availableRecording, publishRecording, serveRecording } from "@/lib/artifacts";
import { claimJob, failJob, JOB_TIMING } from "@/lib/sessionJobs";
import { validSessionId } from "@/lib/schemas";
import { openAiUrl } from "@/lib/openai";
import { delay } from "@/lib/async";

export const runtime = "nodejs";
export const maxDuration = 60;
function recordingStatusResponse(row: ReturnType<typeof getRecordingSession>, extra: Record<string, unknown> = {}) {
  return Response.json({ status: row?.recordingStatus ?? "idle", error: row?.recordingError, ...extra });
}

/** Download the stored GPT-Live recording (stereo WAV) for this session. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let row = findSession(id, getRecordingSession);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (row.status !== "ended" && row.status !== "graded") {
    return Response.json({ error: "session has not ended" }, { status: 409 });
  }
  const liveSessionId = row.liveSessionId;
  if (!liveSessionId) {
    return Response.json({ error: "no live session id recorded" }, { status: 400 });
  }
  if (row.recordingPath === "" || row.recordingStatus === "unavailable") {
    return Response.json({ error: "session storage not permitted on project" }, { status: 400 });
  }
  if (await availableRecording(id)) {
    return recordingStatusResponse(row, { ok: true });
  }
  row = getRecordingSession(id)!;
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  const attempt = claimJob(id, "recording");
  if (!attempt) {
    return recordingStatusResponse(getRecordingSession(id), { ok: false });
  }

  try {
    // Recording finalizes after session.closed — retry briefly if it isn't ready.
    const signal = AbortSignal.timeout(JOB_TIMING.recording.timeoutMs);
    let res: Response | null = null;
    let lastErr = "";
    for (let retry = 0; retry < 4; retry++) {
      res = await fetch(openAiUrl(`/live/sessions/${encodeURIComponent(liveSessionId)}/content`), {
        signal,
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      if (res.ok) break;
      lastErr = await res.text();
      if (retry < 3) await delay(2500, signal);
    }
    if (!res?.ok) {
      throw new Error(`recording fetch failed: ${res?.status ?? "network error"} ${lastErr}`.trim());
    }
    await publishRecording(res, attempt, signal);
    return recordingStatusResponse(getRecordingSession(id), { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(attempt, message);
    return Response.json({ error: message, status: "failed" }, { status: 502 });
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const file = validSessionId(id) ? await availableRecording(id) : null;
  if (!file) return Response.json({ error: "no recording" }, { status: 404 });
  return serveRecording(file, request);
}
