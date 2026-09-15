import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  claimRecording,
  failRecording,
  finishRecording,
  getSession,
  RECORDING_DIR,
  updateSession,
} from "@/lib/db";
import { validSessionId } from "@/lib/schemas";
import { openAiUrl } from "@/lib/openai";

export const runtime = "nodejs";
export const maxDuration = 60;

function recordingFile(id: string): string {
  return path.resolve(RECORDING_DIR, `${id}.wav`);
}

function recordingStatusResponse(row: ReturnType<typeof getSession>, extra: Record<string, unknown> = {}) {
  return Response.json({
    status: row?.recordingStatus ?? "idle",
    error: row?.recordingError,
    ...extra,
  });
}

/** Download the stored GPT-Live recording (stereo WAV) for this session. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  let row = getSession(id);
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
  if (row.recordingPath && fs.existsSync(/* turbopackIgnore: true */ row.recordingPath)) {
    return recordingStatusResponse(row, { ok: true });
  }
  if (row.recordingPath) {
    updateSession(id, { recordingPath: null, recordingStatus: "idle", recordingError: null });
    row = getSession(id)!;
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  if (!claimRecording(id)) {
    return recordingStatusResponse(getSession(id), { ok: false });
  }

  try {
    // Recording finalizes after session.closed — retry briefly if it isn't ready.
    let res: Response | null = null;
    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(openAiUrl(`/live/sessions/${encodeURIComponent(liveSessionId)}/content`), {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      });
      if (res.ok) break;
      lastErr = await res.text();
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2500));
    }
    if (!res?.ok) {
      throw new Error(`recording fetch failed: ${res?.status ?? "network error"} ${lastErr}`.trim());
    }
    const file = recordingFile(id);
    fs.writeFileSync(/* turbopackIgnore: true */ file, Buffer.from(await res.arrayBuffer()));
    finishRecording(id, file);
    return recordingStatusResponse(getSession(id), { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failRecording(id, message);
    return Response.json({ error: message, status: "failed" }, { status: 502 });
  }
}

/** Serve the WAV if downloaded, with byte-range support for audio seeking. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const row = getSession(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  const file = row.recordingPath ? path.resolve(row.recordingPath) : recordingFile(id);
  const root = path.resolve(RECORDING_DIR);
  if (
    row.recordingPath === "" ||
    !file.startsWith(root + path.sep) ||
    !fs.existsSync(/* turbopackIgnore: true */ file)
  ) {
    return Response.json({ error: "no recording" }, { status: 404 });
  }
  const stat = fs.statSync(/* turbopackIgnore: true */ file);
  const range = request.headers.get("range");
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
  };
  if (range) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isSafeInteger(start) || start >= stat.size || end < start) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    headers: { ...headers, "Content-Length": String(stat.size) },
  });
}
