"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, ApiError } from "@/lib/clientApi";
import type { LiveTraceEvent } from "@/lib/liveTrace";
import type { Timeline } from "@/lib/timeline";

import type { SessionOwner } from "@/lib/ownership";

const CHECKPOINT_MS = 5_000;

interface Ref<T> {
  current: T;
}

export function useInterviewCheckpoint(input: {
  sessionId: string;
  owner: () => SessionOwner | null;
  onOwnershipLost: () => void;
  initialRevision: number;
  timeline: Ref<Timeline>;
  t0: Ref<number | null>;
  ended: Ref<boolean>;
  liveTrace: () => LiveTraceEvent[];
  active: boolean;
}) {
  const { sessionId, initialRevision, timeline, t0, ended, liveTrace, active, owner, onOwnershipLost } = input;
  const persistInFlight = useRef(false);
  const revision = useRef(initialRevision);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const stopCheckpointing = useCallback(() => { request.current?.abort(); }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopCheckpointing(); };
  }, [stopCheckpointing]);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);

  const progressPayload = useCallback(() => {
    return {
      kind: "progress",
      ...owner(),
      revision: ++revision.current,
      transcript: timeline.current.getTranscript(),
      timeline: timeline.current.getEvents(),
      liveTrace: liveTrace(),
    };
  }, [timeline, liveTrace, owner]);

  const saveProgress = useCallback(async () => {
    if (t0.current == null || ended.current || persistInFlight.current) return;
    persistInFlight.current = true;
    const controller = new AbortController();
    request.current = controller;
    try {
      await fetchJson(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progressPayload()),
      });
      if (mounted.current && !ended.current) setCheckpointError(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && !controller.signal.aborted) onOwnershipLost();
      if (mounted.current && !ended.current && !controller.signal.aborted) setCheckpointError(error instanceof Error ? error.message : "Checkpoint failed; retrying…");
    } finally {
      request.current = null;
      persistInFlight.current = false;
    }
  }, [sessionId, t0, ended, progressPayload, onOwnershipLost]);

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
  return { checkpointError, stopCheckpointing };
}
