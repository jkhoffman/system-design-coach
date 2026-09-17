import { saveGeneratedPrompt } from "@/lib/generatedPrompts";
import { errorResponse, readJsonBody } from "@/lib/http";
import { expandPromptSpec } from "@/lib/promptGen";
import { ExpandPromptSchema } from "@/lib/schemas";

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  try {
    const body = ExpandPromptSchema.parse(await readJsonBody(request));
    const { description, ...briefing } = body;
    const prompt = await expandPromptSpec(description, briefing, request.signal);
    return Response.json({ prompt: saveGeneratedPrompt(prompt) });
  } catch (error) {
    const res = errorResponse(error);
    if (res.status < 500) return res;
    return Response.json({ error: String(error) }, { status: 502 });
  }
}
