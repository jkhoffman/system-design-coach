import { readFinalImage } from "@/lib/artifacts";
import { validSessionId } from "@/lib/schemas";

export const runtime = "nodejs";
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const image = validSessionId(id) ? await readFinalImage(id) : null;
  if (!image) return Response.json({ error: "not found" }, { status: 404 });
  return new Response(new Uint8Array(image.bytes), { headers: { "Content-Type": image.mimeType, "Cache-Control": "private, max-age=3600" } });
}
