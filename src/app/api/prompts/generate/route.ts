import { generatePromptSpec } from "@/lib/promptGen";
import type { Briefing } from "@/lib/types";

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  const briefing = (await request.json()) as Briefing;
  if (!briefing.company?.trim() || !briefing.position?.trim() || !briefing.level?.trim()) {
    return Response.json({ error: "company, position and level are required" }, { status: 400 });
  }
  try {
    const prompt = await generatePromptSpec(briefing);
    return Response.json({ prompt });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
