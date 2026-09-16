import { getSession } from "@/lib/db";
import { analyzeLiveTrace } from "@/lib/liveTraceAnalysis";
import { validSessionId } from "@/lib/schemas";

export const runtime = "nodejs";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  return Response.json({
    session: {
      id: session.id,
      status: session.status,
      liveSessionId: session.liveSessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      transcriptTurns: session.transcript.length,
      timelineEvents: session.timeline.length,
    },
    analysis: analyzeLiveTrace(session.liveTrace ?? []),
  });
}
