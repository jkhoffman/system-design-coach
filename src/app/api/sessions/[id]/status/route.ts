import { getSessionJobStatus } from "@/lib/sessionJobs";
import { validSessionId } from "@/lib/schemas";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = validSessionId(id) ? getSessionJobStatus(id) : null;
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(session, { headers: { "Cache-Control": "no-store" } });
}
