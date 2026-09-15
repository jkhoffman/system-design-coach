"use client";

import { useCallback, useEffect, useRef } from "react";
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
  active: boolean;
}) {
  const { sessionId, timeline, t0, ended, active } = input;
  const persistInFlight = useRef(false);

  const progressPayload = useCallback(() => {
    return {
      kind: "progress",
      transcript: timeline.current.getTranscript(),
      timeline: timeline.current.getEvents(),
    };
  }, [timeline]);

  const saveProgress = useCallback(async () => {
    if (t0.current == null || ended.current || persistInFlight.current) return;
    persistInFlight.current = true;
    try {
      await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progressPayload()),
      });
    } catch {
      /* checkpointing is best-effort; the next tick retries */
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
}
