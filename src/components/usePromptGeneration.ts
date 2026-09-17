"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LatestRequest } from "@/lib/latestRequest";
import { fetchJson } from "@/lib/clientApi";
import type { PublicPrompt } from "@/lib/publicPrompt";
import type { Briefing, Mode } from "@/lib/types";

export function usePromptGeneration() {
  const requests = useMemo(() => new LatestRequest(), []);
  const [generated, setGenerated] = useState<PublicPrompt | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => requests.invalidate(), [requests]);
  const invalidate = useCallback(() => {
    requests.invalidate(); setGenerated(null); setGenerating(false); setError(null);
  }, [requests]);
  const generate = async (mode: Mode, briefing: Briefing, description: string) => {
    const request = requests.begin();
    setGenerating(true); setGenerated(null); setError(null);
    try {
      const data = await fetchJson<{ prompt: PublicPrompt }>(mode === "freeform" ? "/api/prompts/expand" : "/api/prompts/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "freeform" ? { ...briefing, description } : briefing),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(65_000)]),
      });
      if (request.isCurrent()) setGenerated(data.prompt);
    } catch (error) {
      if (request.isCurrent()) setError(error instanceof Error ? error.message : String(error));
    } finally { if (request.isCurrent()) setGenerating(false); }
  };
  return { generated, generating, error, generate, invalidate };
}
