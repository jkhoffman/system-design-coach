import { ZodError } from "zod";
import { MAX_JSON_BODY_BYTES } from "./schemas";

export async function readJsonBody(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) {
    throw new HttpError(413, "request body too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
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
