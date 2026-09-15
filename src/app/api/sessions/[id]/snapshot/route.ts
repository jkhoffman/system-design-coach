import fs from "node:fs";
import path from "node:path";
import { getSession, SNAPSHOT_DIR } from "@/lib/db";

export const runtime = "nodejs";

/** Save a whiteboard milestone PNG for the session. Returns the filename. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getSession(id)) return Response.json({ error: "not found" }, { status: 404 });

  const body = (await request.json()) as { startMs?: number; label?: string; png?: string };
  if (!body.png?.startsWith("data:image/")) {
    return Response.json({ error: "png data URL required" }, { status: 400 });
  }
  const dir = path.join(SNAPSHOT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const t = Math.max(0, Math.round(body.startMs ?? 0));
  const file = `${t}.png`;
  fs.writeFileSync(path.join(dir, file), Buffer.from(body.png.split(",", 2)[1], "base64"));
  return Response.json({ file });
}

/** Serve a milestone PNG: /api/sessions/[id]/snapshot?file=12345.png */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const file = new URL(request.url).searchParams.get("file") ?? "";
  if (!/^[\w.-]+\.png$/.test(file)) return Response.json({ error: "bad file" }, { status: 400 });
  const p = path.join(SNAPSHOT_DIR, id, file);
  if (!fs.existsSync(/* turbopackIgnore: true */ p))
    return Response.json({ error: "not found" }, { status: 404 });
  return new Response(fs.readFileSync(/* turbopackIgnore: true */ p), {
    headers: { "Content-Type": "image/png" },
  });
}
