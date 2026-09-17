import { getSessionDiagnostics } from "@/lib/sessionQueries";
import { analyzeLiveTrace } from "@/lib/liveTraceAnalysis";
import { validSessionId } from "@/lib/schemas";

export const runtime = "nodejs";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const session = getSessionDiagnostics(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({
    session: session.session,
    analysis: analyzeLiveTrace(session.trace),
  });
}
