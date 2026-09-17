import { z } from "zod";
import { validSessionId } from "@/lib/schemas";
import { recoverSession } from "@/lib/sessionCommands";
import { reconcileConnections } from "@/lib/connectionCleanup";
import { errorResponse, readJsonBody } from "@/lib/http";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(await readJsonBody(request));
    const outcome = recoverSession(id, requestId);
    if (outcome === "not_found") return Response.json({ error: "not found" }, { status: 404 });
    if (outcome === "ownership_conflict") return Response.json({ error: "This interview is active in another tab or was already finalized. Close the active tab and wait up to three minutes before recovering." }, { status: 409 });
    await reconcileConnections(id);
    return Response.json({ outcome });
  } catch (error) { return errorResponse(error); }
}
