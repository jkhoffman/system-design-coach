import { getSession, updateSession } from "@/lib/db";
import { buildSessionConfig } from "@/lib/persona";

/**
 * Browser sends an SDP offer; we attach the session config (persona, fact
 * sheet, delegation backend) and forward to OpenAI. The API key never
 * leaves the server. Returns the SDP answer + live session id.
 */
export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  const body = (await request.json()) as { sessionId?: string; sdp?: string };
  if (!body.sessionId || !body.sdp?.trim()) {
    return Response.json({ error: "sessionId and sdp required" }, { status: 400 });
  }
  const row = getSession(body.sessionId);
  if (!row) return Response.json({ error: "unknown sessionId" }, { status: 404 });

  const session = buildSessionConfig({
    briefing: row.briefing,
    prompt: row.prompt,
    durationSec: row.durationSec,
  });

  const create = (cfg: Record<string, unknown>) =>
    fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: cfg, transport: { type: "webrtc", sdp: body.sdp } }),
    });

  let res = await create(session);
  // Projects without data-persistence permission reject store:true — retry
  // without it and flag the row so the review page knows no recording exists.
  if (!res.ok) {
    const errText = await res.text();
    if (errText.includes("session_storage_not_allowed")) {
      const { store: _store, ...noStore } = session;
      res = await create(noStore);
      updateSession(row.id, { recordingPath: "" });
    } else {
      return Response.json(
        { error: `OpenAI live session failed: ${res.status}`, detail: errText },
        { status: 502 }
      );
    }
  }

  if (!res.ok) {
    const text = await res.text();
    return Response.json(
      { error: `OpenAI live session failed: ${res.status}`, detail: text },
      { status: 502 }
    );
  }

  const data = (await res.json()) as {
    id?: string;
    session?: { id?: string };
    transport?: { sdp?: string };
    sdp?: string;
  };
  const answer = data.transport?.sdp ?? data.sdp;
  const liveSessionId = data.id ?? data.session?.id;
  if (!answer) {
    return Response.json({ error: "no SDP answer from OpenAI", detail: data }, { status: 502 });
  }

  updateSession(row.id, {
    status: "live",
    startedAt: Date.now(),
    liveSessionId,
  });

  return Response.json({
    sdp: answer,
    liveSessionId,
    imagePushMode: process.env.IMAGE_PUSH_MODE ?? "queue-only",
  });
}
