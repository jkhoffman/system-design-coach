import { findSession } from "@/lib/sessionLookup";
import { getSessionDiagnostics } from "@/lib/sessionQueries";
import { analyzeLiveTrace } from "@/lib/liveTraceAnalysis";

export const runtime = "nodejs";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = findSession(id, getSessionDiagnostics);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({
    session: session.session,
    analysis: analyzeLiveTrace(session.trace),
  });
}
