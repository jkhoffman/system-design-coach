import { findSession } from "@/lib/sessionLookup";
import { saveFinalImage, discardFinalImage } from "@/lib/artifacts";
import { getReviewSession } from "@/lib/sessionQueries";
import { errorResponse, readJsonBody } from "@/lib/http";
import { SessionPatchSchema, validSessionId, MAX_JSON_BODY_BYTES } from "@/lib/schemas";
import { finishSession, saveSessionProgress, getSessionAcknowledgment } from "@/lib/sessionCommands";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = findSession(id, getReviewSession);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ session });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  let imageFile: string | undefined;
  try {
    const body = SessionPatchSchema.parse(await readJsonBody(request, MAX_JSON_BODY_BYTES));
    if (body.kind === "progress") {
      const applied = saveSessionProgress(id, body);
      const session = getSessionAcknowledgment(id);
      if (!session) return Response.json({ error: "not found" }, { status: 404 });
      if (session.status !== "live") return Response.json({ error: "session is not live" }, { status: 409 });
      return Response.json({ ...session, applied });
    }
    const existing = getSessionAcknowledgment(id);
    if (existing?.status === "ended" || existing?.status === "graded") return Response.json({ ...existing, applied: false });
    if (body.finalImage) imageFile = await saveFinalImage(id, body.finalImage);
    const result = finishSession(id, { ...body,
      ...(body.finalImage !== undefined ? { finalImage: null, finalImagePath: imageFile ?? null } : {}) });
    if (result === "saved") imageFile = undefined;
    if (result === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (result === "not_live") return Response.json({ error: "session has not started" }, { status: 409 });
    if (result === "invalid_time") return Response.json({ error: "invalid interview end time" }, { status: 400 });
    return Response.json({ ...getSessionAcknowledgment(id), applied: result === "saved" });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (imageFile) await discardFinalImage(id, imageFile);
  }
}
