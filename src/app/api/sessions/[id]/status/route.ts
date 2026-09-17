import { availableRecording } from "@/lib/artifacts";
import { getSessionJobStatus } from "@/lib/sessionJobs";
import { validSessionId } from "@/lib/schemas";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = validSessionId(id) ? getSessionJobStatus(id) : null;
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  const recording = await availableRecording(id);
  if (recording) session.recording = { status: "done", stale: false };
  else if (session.recording.status === "done") {
    session.recording = { status: "failed", stale: false, error: "The saved recording is missing. Retry to download a replacement." };
  }
  return Response.json(session, { headers: { "Cache-Control": "no-store" } });
}
