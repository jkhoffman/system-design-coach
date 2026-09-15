import { getSession, updateSession } from "@/lib/db";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ session });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  updateSession(id, {
    status: body.status as never,
    startedAt: body.startedAt as number | undefined,
    endedAt: body.endedAt as number | undefined,
    transcript: body.transcript as never,
    timeline: body.timeline as never,
    finalScene: body.finalScene,
    finalImage: body.finalImage as string | undefined,
  });
  return Response.json({ session: getSession(id) });
}
