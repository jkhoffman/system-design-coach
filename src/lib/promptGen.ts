import OpenAI from "openai";
import { z } from "zod";
import type { Briefing, PromptSpec } from "./types";
import { newId } from "./db";

const FactSheetEntry = z.object({ q: z.string(), a: z.string() });

const PromptSpecSchema = z.object({
  title: z.string(),
  question: z.string(),
  context: z.string(),
  factSheet: z.array(FactSheetEntry).min(4),
  deepDiveAngles: z.array(z.string()).min(2),
});

const JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    question: { type: "string" },
    context: { type: "string" },
    factSheet: {
      type: "array",
      items: {
        type: "object",
        properties: { q: { type: "string" }, a: { type: "string" } },
        required: ["q", "a"],
        additionalProperties: false,
      },
    },
    deepDiveAngles: { type: "array", items: { type: "string" } },
  },
  required: ["title", "question", "context", "factSheet", "deepDiveAngles"],
  additionalProperties: false,
} as const;

const GEN_INSTRUCTIONS = `You write system design interview questions used in real loops at top tech companies.

Given a company, position, and level, produce ONE realistic system design prompt of the kind that company plausibly asks for that role — grounded in the company's actual product surface and common interview patterns (e.g., a payments company → transaction systems, a social company → feeds/messaging, a logistics company → dispatch/matching).

Rules:
- "question" is delivered verbatim by the interviewer: one or two conversational sentences, scoped like a real interview question ("Design X"), not a spec document.
- "context" is one short paragraph of scenario framing for the interviewer's own use.
- "factSheet" is the interviewer's hidden ground truth: 6-9 entries covering the clarifying questions candidates most often ask — scale (users, QPS, storage), scope boundaries (what's in/out), consistency/latency requirements, and any intentional twist (e.g., celebrity accounts, flash-sale contention). Answers must be concrete numbers/facts, and internally consistent. Include at least one entry encoding a deliberate scope boundary and at least one twist that should change the design.
- "deepDiveAngles": 3-5 areas a strong interviewer would push on in the second half of the interview.
- The difficulty must match the level: entry-level prompts are forgiving and well-trodden; senior/staff prompts should have real ambiguity or scale pressure.
- Do not name internal company systems that aren't public knowledge; keep it plausible, not proprietary.`;

export async function generatePromptSpec(briefing: Briefing): Promise<PromptSpec> {
  const client = new OpenAI();
  const jd = briefing.jobDescription?.trim();
  const input = [
    `Company: ${briefing.company}`,
    `Position: ${briefing.position}`,
    `Level: ${briefing.level}`,
    jd ? `Job description excerpt:\n${jd.slice(0, 4000)}` : null,
    "Produce the prompt JSON now.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await client.responses.create({
    model: process.env.PROMPT_GEN_MODEL ?? "gpt-5.6-terra",
    instructions: GEN_INSTRUCTIONS,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "prompt_spec",
        schema: JSON_SCHEMA,
        strict: true,
      },
    },
  });

  const parsed = PromptSpecSchema.parse(JSON.parse(res.output_text));
  return { id: `gen-${newId()}`, ...parsed };
}
