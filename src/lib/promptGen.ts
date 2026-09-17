import { createOpenAIClient } from "./openai";
import type { Briefing, PromptSpec } from "./types";
import { newId } from "./db";
import { PromptSpecSchema } from "./schemas";
import { PROMPT_FORMAT } from "./modelFormats";

const GEN_INSTRUCTIONS = `You write system design interview questions used in real loops at top tech companies.

Given a company, position, and level, produce ONE realistic system design prompt of the kind that company plausibly asks for that role — grounded in the company's actual product surface and common interview patterns (e.g., a payments company → transaction systems, a social company → feeds/messaging, a logistics company → dispatch/matching).

Rules:
- "question" is delivered verbatim by the interviewer: one or two conversational sentences, scoped like a real interview question ("Design X"), not a spec document.
- "context" is one short paragraph of scenario framing for the interviewer's own use.
- "factSheet" is the interviewer's hidden ground truth: 6-9 entries covering the clarifying questions candidates most often ask — scale (users, QPS, storage), scope boundaries (what's in/out), consistency/latency requirements, and any intentional twist (e.g., celebrity accounts, flash-sale contention). Answers must be concrete numbers/facts, and internally consistent. Include at least one entry encoding a deliberate scope boundary and at least one twist that should change the design.
- "deepDiveAngles": 3-5 areas a strong interviewer would push on in the second half of the interview.
- The difficulty must match the level: entry-level prompts are forgiving and well-trodden; senior/staff prompts should have real ambiguity or scale pressure.
- Do not name internal company systems that aren't public knowledge; keep it plausible, not proprietary.`;

const EXPAND_INSTRUCTIONS = `You write system design interview questions used in real loops at top tech companies.

Given a candidate's freeform description of the interview they want, produce ONE complete prompt spec for it. The description is ground truth for the question and scope — honor every detail it states. Fill in whatever it leaves unspecified with plausible, internally consistent specifics.

Rules:
- "question" is delivered verbatim by the interviewer: one or two conversational sentences that faithfully capture the described interview, scoped like a real interview question ("Design X"), not a spec document.
- "context" is one short paragraph of scenario framing for the interviewer's own use.
- "factSheet" is the interviewer's hidden ground truth: 6-9 entries covering the clarifying questions candidates most often ask — scale (users, QPS, storage), scope boundaries (what's in/out), consistency/latency requirements, and any twist the description implies. Answers must be concrete numbers/facts, and internally consistent. Fold any facts the description states into the sheet; include at least one entry encoding a deliberate scope boundary and at least one twist that should change the design.
- "deepDiveAngles": 3-5 areas a strong interviewer would push on in the second half of the interview.
- If a level is provided, match the difficulty: entry-level prompts are forgiving and well-trodden; senior/staff prompts should have real ambiguity or scale pressure.
- Do not name internal company systems that aren't public knowledge; keep it plausible, not proprietary.`;

async function runSpecGeneration(instructions: string, input: string, signal?: AbortSignal): Promise<PromptSpec> {
  const client = createOpenAIClient();
  const res = await client.responses.create({
    model: process.env.PROMPT_GEN_MODEL ?? "gpt-5.6-terra",
    instructions,
    input,
    text: { format: PROMPT_FORMAT },
  }, { signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]), timeout: 60_000, maxRetries: 0 });

  const parsed = PromptSpecSchema.omit({ id: true }).parse(JSON.parse(res.output_text));
  return { id: `gen-${newId()}`, ...parsed };
}

export async function generatePromptSpec(briefing: Briefing, signal?: AbortSignal): Promise<PromptSpec> {
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

  return runSpecGeneration(GEN_INSTRUCTIONS, input, signal);
}

export async function expandPromptSpec(
  description: string,
  briefing: Briefing,
  signal?: AbortSignal,
): Promise<PromptSpec> {
  const input = [
    briefing.company.trim() ? `Company (flavor only): ${briefing.company}` : null,
    briefing.position.trim() ? `Position: ${briefing.position}` : null,
    briefing.level.trim() ? `Level: ${briefing.level}` : null,
    `Candidate's description of the interview they want:\n${description}`,
    "Produce the prompt JSON now.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return runSpecGeneration(EXPAND_INSTRUCTIONS, input, signal);
}
