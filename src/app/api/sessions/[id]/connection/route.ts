import { ConnectionCommandSchema, validSessionId } from "@/lib/schemas";
import { confirmSessionStart, renewSessionOwner, releaseSessionStart, attemptOwner } from "@/lib/sessionCommands";
import { reconcileConnections } from "@/lib/connectionCleanup";
import { errorResponse, readJsonBody } from "@/lib/http";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const body = ConnectionCommandSchema.parse(await readJsonBody(request));
    const owner = attemptOwner(id, body.ownerToken);
    if (!owner || owner.generation !== body.generation) return Response.json({ error: "Connection ownership changed" }, { status: 409 });
    if (body.action === "cancel") {
      releaseSessionStart(id, body.ownerToken);
      await reconcileConnections(id);
      return Response.json({ ok: true });
    }
    const ok = body.action === "confirm" ? confirmSessionStart(id, body) : renewSessionOwner(id, body);
    return Response.json(ok ? { ok } : { error: "Connection ownership expired or changed" }, { status: ok ? 200 : 409 });
  } catch (error) { return errorResponse(error); }
}
