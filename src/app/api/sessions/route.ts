import { createSession, listSessionSummaries } from "@/lib/db";
import { errorResponse, readJsonBody } from "@/lib/http";
import { getLibraryPrompt } from "@/lib/prompts";
import { CreateSessionSchema } from "@/lib/schemas";
import { toClientSession } from "@/lib/sessionDto";
import { getGeneratedPrompt } from "@/lib/generatedPrompts";

export async function GET() {
  return Response.json({ sessions: listSessionSummaries(50) });
}

export async function POST(request: Request) {
  try {
    const body = CreateSessionSchema.parse(await readJsonBody(request));

    const prompt = body.mode === "library" ? getLibraryPrompt(body.promptId) : getGeneratedPrompt(body.promptId);
    if (!prompt) return Response.json({ error: "unknown promptId" }, { status: 400 });

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
