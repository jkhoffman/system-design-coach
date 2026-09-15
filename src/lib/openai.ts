import OpenAI from "openai";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export function openAiBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
}

export function openAiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${openAiBaseUrl()}${suffix}`;
}

export function createOpenAIClient(): OpenAI {
  return new OpenAI({ baseURL: openAiBaseUrl() });
}
