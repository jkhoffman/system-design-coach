import fs from "node:fs";
import path from "node:path";
import { getSession, SNAPSHOT_DIR } from "@/lib/db";
import { errorResponse, readJsonBody } from "@/lib/http";
import { SNAPSHOT_FILE_RE, SnapshotRequestSchema, validSessionId } from "@/lib/schemas";

export const runtime = "nodejs";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Save a whiteboard milestone PNG for the session. Returns the filename. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!validSessionId(id)) return Response.json({ error: "not found" }, { status: 404 });
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  if (session.status !== "live") return Response.json({ error: "session is not live" }, { status: 409 });

  try {
    const body = SnapshotRequestSchema.parse(await readJsonBody(request));
    const png = Buffer.from(body.png.split(",", 2)[1], "base64");
    if (png.length === 0 || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return Response.json({ error: "png data URL required" }, { status: 400 });
    }

    const dir = path.resolve(SNAPSHOT_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const t = Math.round(body.startMs);
    const file = `${t}.png`;
    fs.writeFileSync(path.join(dir, file), png);
    return Response.json({ file });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Serve a milestone PNG: /api/sessions/[id]/snapshot?file=12345.png */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const file = new URL(request.url).searchParams.get("file") ?? "";
  if (!validSessionId(id) || !SNAPSHOT_FILE_RE.test(file)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const dir = path.resolve(SNAPSHOT_DIR, id);
  const p = path.resolve(dir, file);
  if (!p.startsWith(dir + path.sep) || !fs.existsSync(/* turbopackIgnore: true */ p)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return new Response(fs.readFileSync(/* turbopackIgnore: true */ p), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
}
