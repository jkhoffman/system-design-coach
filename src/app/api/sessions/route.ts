import { createSession, listSessionSummaries } from "@/lib/db";
import { errorResponse, readJsonBody } from "@/lib/http";
import { getLibraryPrompt } from "@/lib/prompts";
import { CreateSessionSchema } from "@/lib/schemas";
import { toClientSession } from "@/lib/sessionDto";
import type { PromptSpec } from "@/lib/types";

export async function GET() {
  return Response.json({ sessions: listSessionSummaries(50) });
}

export async function POST(request: Request) {
  try {
    const body = CreateSessionSchema.parse(await readJsonBody(request));

    let prompt: PromptSpec | undefined;
    if (body.mode === "library") {
      prompt = body.promptId ? getLibraryPrompt(body.promptId) : undefined;
      if (!prompt) return Response.json({ error: "unknown promptId" }, { status: 400 });
    } else {
      prompt = body.prompt;
      if (!prompt) {
        return Response.json({ error: "custom mode requires a generated prompt" }, { status: 400 });
      }
    }

    const session = createSession({
      mode: body.mode,
      briefing: body.briefing,
      prompt,
      durationSec: body.durationSec,
    });
    return Response.json({ session: toClientSession(session) });
  } catch (error) {
    return errorResponse(error);
  }
}
