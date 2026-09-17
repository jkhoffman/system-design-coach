import { getSession } from "@/lib/db";
import { errorResponse, readJsonBody } from "@/lib/http";
import { SessionPatchSchema, validSessionId } from "@/lib/schemas";
import { finishSession, saveSessionProgress, getSessionAcknowledgment } from "@/lib/sessionCommands";
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
  try {
    const body = SessionPatchSchema.parse(await readJsonBody(request));
    if (body.kind === "progress") {
      const applied = saveSessionProgress(id, body);
      const session = getSessionAcknowledgment(id);
      if (!session) return Response.json({ error: "not found" }, { status: 404 });
      if (session.status !== "live") return Response.json({ error: "session is not live" }, { status: 409 });
      return Response.json({ ...session, applied });
    }
    const result = finishSession(id, body);
    if (result === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (result === "not_live") return Response.json({ error: "session has not started" }, { status: 409 });
    if (result === "invalid_time") return Response.json({ error: "invalid interview end time" }, { status: 400 });
    return Response.json({ ...getSessionAcknowledgment(id), applied: result === "saved" });
  } catch (error) {
    return errorResponse(error);
  }
}
