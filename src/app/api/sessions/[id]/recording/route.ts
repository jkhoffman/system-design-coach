import fs from "node:fs";
import path from "node:path";
import { getSession, updateSession, RECORDING_DIR } from "@/lib/db";

export const runtime = "nodejs";

/** Download the stored GPT-Live recording (stereo WAV) for this session. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = getSession(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  if (!row.liveSessionId) {
    return Response.json({ error: "no live session id recorded" }, { status: 400 });
  }
  if (row.recordingPath === "") {
    return Response.json({ error: "session storage not permitted on project" }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }

  // Recording finalizes after session.closed — retry briefly if it isn't ready.
  let res: Response | null = null;
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`https://api.openai.com/v1/live/sessions/${row.liveSessionId}/content`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });
    if (res.ok) break;
    lastErr = await res.text();
    if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!res?.ok) {
    return Response.json(
      { error: `recording fetch failed: ${res?.status}`, detail: lastErr },
      { status: 502 }
    );
  }
  const file = path.join(RECORDING_DIR, `${id}.wav`);
  fs.writeFileSync(/* turbopackIgnore: true */ file, Buffer.from(await res.arrayBuffer()));
  updateSession(id, { recordingPath: file });
  return Response.json({ ok: true });
}

/** Serve the WAV if downloaded. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = getSession(id);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  const file = row.recordingPath ?? path.join(RECORDING_DIR, `${id}.wav`);
  if (!fs.existsSync(/* turbopackIgnore: true */ file))
    return Response.json({ error: "no recording" }, { status: 404 });
  const stat = fs.statSync(/* turbopackIgnore: true */ file);
  return new Response(fs.readFileSync(/* turbopackIgnore: true */ file), {
    headers: { "Content-Type": "audio/wav", "Content-Length": String(stat.size) },
  });
}
