import { getSession, updateSession } from "@/lib/db";
import { errorResponse, readJsonBody } from "@/lib/http";
import { SessionPatchSchema, validSessionId } from "@/lib/schemas";
import { toClientSession } from "@/lib/sessionDto";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ session: toClientSession(session) });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  try {
    const body = SessionPatchSchema.parse(await readJsonBody(request));
    if (body.kind === "progress") {
      if (session.status !== "live") {
        return Response.json({ error: "session is not live" }, { status: 409 });
      }
      updateSession(id, { transcript: body.transcript, timeline: body.timeline });
      return Response.json({ session: toClientSession(getSession(id)!) });
    }

    if (session.status === "created") {
      return Response.json({ error: "session has not started" }, { status: 409 });
    }
    if (body.endedAt > Date.now() + 60_000) {
      return Response.json({ error: "endedAt is in the future" }, { status: 400 });
    }
    if (session.status !== "graded" && session.startedAt && body.endedAt < session.startedAt) {
      return Response.json({ error: "endedAt precedes startedAt" }, { status: 400 });
    }
    if (session.status !== "graded") {
      updateSession(id, {
        status: "ended",
        endedAt: body.endedAt,
        transcript: body.transcript,
        timeline: body.timeline,
        finalScene: body.finalScene,
        finalImage: body.finalImage === undefined ? undefined : body.finalImage,
      });
    }
    return Response.json({ session: toClientSession(getSession(id)!) });
  } catch (error) {
    return errorResponse(error);
  }
}
