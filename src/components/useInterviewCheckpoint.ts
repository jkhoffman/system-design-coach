"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveTraceEvent } from "@/lib/liveTrace";
import type { Timeline } from "@/lib/timeline";

const CHECKPOINT_MS = 5_000;

interface Ref<T> {
  current: T;
}

export function useInterviewCheckpoint(input: {
  sessionId: string;
  timeline: Ref<Timeline>;
  t0: Ref<number | null>;
  ended: Ref<boolean>;
  liveTrace: () => LiveTraceEvent[];
  active: boolean;
}) {
  const { sessionId, timeline, t0, ended, liveTrace, active } = input;
  const persistInFlight = useRef(false);
  const revision = useRef(0);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);

  const progressPayload = useCallback(() => {
    return {
      kind: "progress",
      revision: ++revision.current,
      transcript: timeline.current.getTranscript(),
      timeline: timeline.current.getEvents(),
      liveTrace: liveTrace(),
    };
  }, [timeline, liveTrace]);

  const saveProgress = useCallback(async () => {
    if (t0.current == null || ended.current || persistInFlight.current) return;
    persistInFlight.current = true;
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progressPayload()),
      });
      if (!response.ok) throw new Error(`Checkpoint failed (${response.status}); retrying…`);
      setCheckpointError(null);
    } catch (error) {
      if (!ended.current) setCheckpointError(error instanceof Error ? error.message : "Checkpoint failed; retrying…");
    } finally {
      persistInFlight.current = false;
    }
  }, [sessionId, t0, ended, progressPayload]);

  const beaconProgress = useCallback(() => {
    if (t0.current == null || ended.current) return;
    void fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(progressPayload()),
      keepalive: true,
    }).catch(() => {});
  }, [sessionId, t0, ended, progressPayload]);

  useEffect(() => {
    const onPageHide = () => beaconProgress();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [beaconProgress]);

  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => void saveProgress(), CHECKPOINT_MS);
    return () => clearInterval(iv);
  }, [active, saveProgress]);
  return { checkpointError };
}
