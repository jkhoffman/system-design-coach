import "server-only";
import { getDb } from "./database";
import { PromptSpecSchema } from "./schemas";
import { toPublicPrompt } from "./publicPrompt";
import type { PromptSpec } from "./types";

export function saveGeneratedPrompt(input: PromptSpec) {
  const prompt = PromptSpecSchema.parse(input);
  getDb().prepare("INSERT INTO generated_prompts (id, spec, created_at) VALUES (?, ?, ?)")
    .run(prompt.id, JSON.stringify(prompt), Date.now());
  return toPublicPrompt(prompt);
}

export function getGeneratedPrompt(id: string): PromptSpec | undefined {
  const row = getDb().prepare("SELECT spec FROM generated_prompts WHERE id = ?").get(id);
  return row ? PromptSpecSchema.parse(JSON.parse(String(row.spec))) : undefined;
}
