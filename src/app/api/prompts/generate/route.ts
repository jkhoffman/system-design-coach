import { errorResponse, readJsonBody } from "@/lib/http";
import { generatePromptSpec } from "@/lib/promptGen";
import { GenerateBriefingSchema } from "@/lib/schemas";

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 503 });
  }
  try {
    const briefing = GenerateBriefingSchema.parse(await readJsonBody(request));
    const prompt = await generatePromptSpec(briefing);
    return Response.json({ prompt });
  } catch (error) {
    const res = errorResponse(error);
    if (res.status < 500) return res;
    return Response.json({ error: String(error) }, { status: 502 });
  }
}
