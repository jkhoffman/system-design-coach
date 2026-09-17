import type { PromptSpec } from "./types";

export type PublicPrompt = Pick<PromptSpec, "id" | "title" | "question">;
export function toPublicPrompt(prompt: PromptSpec): PublicPrompt {
  return { id: prompt.id, title: prompt.title, question: prompt.question };
}
