import { createSession, listSessions } from "@/lib/db";
import { getLibraryPrompt } from "@/lib/prompts";
import type { Briefing, Mode, PromptSpec } from "@/lib/types";

export async function GET() {
  return Response.json({ sessions: listSessions() });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    mode: Mode;
    briefing: Briefing;
    promptId?: string;
    prompt?: PromptSpec;
    durationSec: number;
  };

  if (!body.durationSec || body.durationSec < 60) {
    return Response.json({ error: "durationSec required" }, { status: 400 });
  }

  let prompt: PromptSpec | undefined;
  if (body.mode === "library") {
    prompt = body.promptId ? getLibraryPrompt(body.promptId) : undefined;
    if (!prompt) return Response.json({ error: "unknown promptId" }, { status: 400 });
  } else {
    prompt = body.prompt;
    if (!prompt?.question || !prompt?.factSheet?.length) {
      return Response.json({ error: "custom mode requires a generated prompt" }, { status: 400 });
    }
  }

  const session = createSession({
    mode: body.mode,
    briefing: body.briefing,
    prompt,
    durationSec: body.durationSec,
  });
  return Response.json({ session });
}
