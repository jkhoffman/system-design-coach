import { saveSnapshot, readSnapshot } from "@/lib/artifacts";
import { getSessionAcknowledgment } from "@/lib/sessionCommands";
import { errorResponse, readJsonBody } from "@/lib/http";
import { SnapshotRequestSchema, validSessionId, MAX_PNG_DATA_URL_CHARS } from "@/lib/schemas";

export const runtime = "nodejs";
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const body = SnapshotRequestSchema.parse(await readJsonBody(request, MAX_PNG_DATA_URL_CHARS + 1024));
    const session = getSessionAcknowledgment(id);
    if (!session) return Response.json({ error: "not found" }, { status: 404 });
    if (session.status !== "live") return Response.json({ error: "session is not live" }, { status: 409 });
    return Response.json({ file: await saveSnapshot(id, body.startMs, body.png) });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const image = await readSnapshot(id, new URL(request.url).searchParams.get("file") ?? "");
  if (!image) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(image), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" } });
}
