import { createHash } from "node:crypto";
import { ownsSession } from "@/lib/sessionCommands";
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
      if (!ownsSession(id, body)) return Response.json({ error: "Interview ownership changed. Keep this tab open to export your work." }, { status: 409 });
      const applied = saveSessionProgress(id, body);
      const session = getSessionAcknowledgment(id);
      if (!session) return Response.json({ error: "not found" }, { status: 404 });
      if (session.status !== "live") return Response.json({ error: "session is not live" }, { status: 409 });
      return Response.json({ ...session, applied });
    }
    const existing = getSessionAcknowledgment(id);
    if (!existing) return Response.json({ error: "not found" }, { status: 404 });
    if (existing.status === "live" && !ownsSession(id, body)) return Response.json({ error: "Interview ownership changed. Your local work has been retained." }, { status: 409 });
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (existing.status === "live" && body.finalImage) imageFile = await saveFinalImage(id, body.finalImage);
    const result = finishSession(id, { ...body,
      ...(body.finalImage !== undefined ? { finalImage: null, finalImagePath: imageFile ?? null } : {}) }, hash);
    if (result === "saved") imageFile = undefined;
    if (result === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (result === "ownership_conflict") return Response.json({ error: "Another tab owns or finalized this interview. Your local work has been retained.", outcome: result }, { status: 409 });
    if (result === "invalid_time") return Response.json({ error: "invalid interview end time" }, { status: 400 });
    return Response.json({ ...getSessionAcknowledgment(id), applied: result === "saved", outcome: result });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (imageFile) await discardFinalImage(id, imageFile);
  }
}
