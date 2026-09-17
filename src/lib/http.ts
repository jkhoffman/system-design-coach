import { ZodError } from "zod";


export async function readJsonBody(request: Request, maxBytes = 128 * 1024): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    await request.body?.cancel();
    throw new HttpError(413, "request body too large");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "request body too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "invalid JSON body"); }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return Response.json(
      { error: issue ? `${issue.path.join(".") || "request"}: ${issue.message}` : "invalid request" },
      { status: 400 }
    );
  }
  return Response.json({ error: "internal error" }, { status: 500 });
}
