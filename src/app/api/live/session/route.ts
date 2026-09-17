import { getLiveSetup } from "@/lib/sessionQueries";
import { reserveSessionStart, releaseSessionStart, completeSessionStart, START_TIMEOUT_MS } from "@/lib/sessionCommands";
import { errorResponse, readJsonBody } from "@/lib/http";
import { buildSessionConfig } from "@/lib/persona";
import { LiveSessionRequestSchema } from "@/lib/schemas";
import { openAiUrl } from "@/lib/openai";

/**
 * Browser sends an SDP offer; we attach the session config (persona, fact
 * sheet, delegation backend) and forward to OpenAI. The API key never
 * leaves the server. Returns the SDP answer + live session id.
 */
export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  let reservation: { id: string; token: string } | undefined;
  try {
    const body = LiveSessionRequestSchema.parse(await readJsonBody(request, 256 * 1024));
    const row = getLiveSetup(body.sessionId);
    if (!row) return Response.json({ error: "unknown sessionId" }, { status: 404 });
    const token = reserveSessionStart(row.id);
    if (!token) return Response.json({ error: "session already started or connection in progress" }, { status: 409 });
    reservation = { id: row.id, token };
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(START_TIMEOUT_MS)]);
    let storageAllowed = true;

    const session = buildSessionConfig({
      briefing: row.briefing,
      prompt: row.prompt,
      durationSec: row.durationSec,
    });

    const create = (cfg: Record<string, unknown>) =>
      fetch(openAiUrl("/live/sessions"), {
        method: "POST",
        signal,
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
        const noStore: Record<string, unknown> = { ...session };
        delete noStore.store;
        res = await create(noStore);
        storageAllowed = false;
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
    if (!answer || !liveSessionId) {
      return Response.json({ error: "incomplete session answer from OpenAI", detail: data }, { status: 502 });
    }

    signal.throwIfAborted();
    if (!completeSessionStart(row.id, token, liveSessionId!, storageAllowed)) {
      return Response.json({ error: "connection attempt expired or superseded" }, { status: 409 });
    }

    return Response.json({
      sdp: answer,
      liveSessionId,
      imagePushEnabled: process.env.IMAGE_PUSH_MODE !== "off",
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (reservation) releaseSessionStart(reservation.id, reservation.token);
  }
}
