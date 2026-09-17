"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GptLiveTransport, type LiveTransport } from "@/lib/liveSession";
import { Timeline } from "@/lib/timeline";
import { summarizeScene } from "@/lib/summarizeScene";
import { interviewClockContext, interviewPacing, TIME_CONTEXT_INTERVAL_MS } from "@/lib/pacing";
import { interviewTransition } from "@/lib/interviewState";
import { createBoardExporter } from "@/lib/boardExport";
import { persistFinalSession, type FinalPayload } from "@/lib/sessionPersistence";
import { ApiError, fetchJson } from "@/lib/clientApi";
import { HEARTBEAT_MS } from "@/lib/ownership";
import { captureFinalPayload } from "@/lib/finalCapture";
import { useBoardSync } from "./useBoardSync";
import { useInterviewCheckpoint } from "./useInterviewCheckpoint";
import type { ClientSession, TimelineEvent } from "@/lib/types";

export function useInterviewController(session: ClientSession) {
  const router = useRouter();
  const [phase, dispatch] = useReducer(interviewTransition, "lobby");
  const [statusDetail, setStatusDetail] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [muted, setMuted] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const board = useMemo(() => createBoardExporter(), []);
  const transport = useRef<LiveTransport | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const connecting = useRef(false);
  const saving = useRef(false);
  const timeline = useRef(new Timeline());
  const t0 = useRef<number | null>(null);
  const warnedAt = useRef(new Set<number>());
  const nextTimeContextAt = useRef(TIME_CONTEXT_INTERVAL_MS);
  const endedRef = useRef(false);
  const recoveryRequest = useRef<string | null>(null);
  const [prepared, setPrepared] = useState(false);
  const lostOwnerHandler = useRef<() => void>(() => {});
  const onOwnershipLost = useCallback(() => lostOwnerHandler.current(), []);
  const owner = useCallback(() => transport.current?.owner ?? null, []);
  const finalPayload = useRef<FinalPayload | null>(null);
  const pacingWarnings = useMemo(() => interviewPacing(session.durationSec).warnings, [session.durationSec]);
  const sessionMs = useCallback(() => t0.current == null ? 0 : performance.now() - t0.current, []);
  const { onWhiteboardChange, flushBoardUpdates } = useBoardSync({
    sessionId: session.id, transport, timeline, t0, sessionMs,
    currentElements: board.currentElements, exportPngDataUrl: board.exportPng,
  });
  const liveTraceSnapshot = useCallback(() => transport.current?.traceSnapshot() ?? [], []);
  const { checkpointError, stopCheckpointing } = useInterviewCheckpoint({
    owner, onOwnershipLost, sessionId: session.id, initialRevision: session.checkpointRevision,
    timeline, t0, ended: endedRef, liveTrace: liveTraceSnapshot, active: phase === "live",
  });

  const saveAndFinish = useCallback(async () => {
    if (saving.current || !finalPayload.current || !lifetime.current) return;
    saving.current = true;
    const signal = lifetime.current.signal;
    try {
      setError(null);
      await persistFinalSession(session.id, finalPayload.current, signal);
      if (signal.aborted) return;
      dispatch("saved");
      router.push(`/interview/${session.id}/review`);
    } catch (error) {
      if (!signal.aborted) setError(`Could not save the interview: ${error instanceof Error ? error.message : String(error)}`);
    } finally { saving.current = false; }
  }, [session.id, router]);

  const endInterview = useCallback(async (reason: string) => {
    if (endedRef.current || !lifetime.current || lifetime.current.signal.aborted) return;
    endedRef.current = true;
    dispatch("finish");
    setError(null);
    stopCheckpointing();
    timeline.current.addMarker(sessionMs(), `interview ended (${reason})`);
    const signal = lifetime.current.signal;
    // Attach the handler immediately: cleanup is optional to the saved transcript.
    const closing = transport.current?.close().catch(() => {});
    try {
      await flushBoardUpdates();
      const finalImage = await board.exportPng(signal).catch(() => null);
      await closing;
      if (signal.aborted) return;
      const ownership = owner();
      if (!ownership) throw new Error("Connection ownership is unavailable");
      finalPayload.current = captureFinalPayload({ ...ownership,
        kind: "finish", requestId: crypto.randomUUID(), endedAt: Date.now(),
        transcript: timeline.current.getTranscript(), timeline: timeline.current.getEvents(),
        liveTrace: transport.current?.traceSnapshot() ?? [], finalImage,
      }, board.currentElements);
      setPrepared(true);
      await saveAndFinish();
    } catch (error) {
      if (!signal.aborted) setError(`Could not prepare the final save: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [stopCheckpointing, sessionMs, flushBoardUpdates, board, saveAndFinish, owner]);

  useEffect(() => { lostOwnerHandler.current = () => { void endInterview("connection ownership changed"); }; }, [endInterview]);

  const retryFinalization = useCallback(() => {
    if (finalPayload.current) { void saveAndFinish(); return; }
    endedRef.current = false;
    void endInterview("retry final preparation");
  }, [saveAndFinish, endInterview]);

  const exportLocalWork = useCallback(() => {
    const data = finalPayload.current ?? { transcript: timeline.current.getTranscript(), timeline: timeline.current.getEvents() };
    const { ownerToken: _token, generation: _generation, ...content } = data as Partial<FinalPayload>;
    void _token; void _generation;
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `interview-${session.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [session.id]);

  const recoverSavedInterview = useCallback(async () => {
    if (saving.current) return;
    saving.current = true; setError(null);
    recoveryRequest.current ??= crypto.randomUUID();
    try {
      await fetchJson(`/api/sessions/${session.id}/recover`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: recoveryRequest.current }),
        signal: AbortSignal.timeout(30_000),
      });
      router.push(`/interview/${session.id}/review`);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { saving.current = false; }
  }, [session.id, router]);

  useEffect(() => {
    if (phase !== "live") return;
    const controller = new AbortController();
    let inFlight = false;
    const heartbeat = async () => {
      if (inFlight || endedRef.current) return;
      inFlight = true;
      try {
        await fetchJson(`/api/sessions/${session.id}/connection`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat", ...owner() }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
      } catch (error) {
        if (!controller.signal.aborted && error instanceof ApiError && error.status === 409) onOwnershipLost();
      } finally { inFlight = false; }
    };
    const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
    const visible = () => { if (document.visibilityState === "visible") void heartbeat(); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [phase, session.id, owner, onOwnershipLost]);

  const start = useCallback(async () => {
    if (phase !== "lobby" || connecting.current || endedRef.current || !lifetime.current) return;
    connecting.current = true;
    dispatch("connect");
    setError(null);
    setMuted(false);
    timeline.current.reset();
    t0.current = null;
    const signal = lifetime.current.signal;
    const t = new GptLiveTransport(session.id, {
      onStatus(status, detail) {
        if (signal.aborted || endedRef.current) return;
        setStatusDetail(detail ?? status);
        if (status === "live" || status === "thinking") setThinking(status === "thinking");
        if (status === "error") setError(detail ?? "session error");
      },
      onStarted(liveSessionId) {
        if (signal.aborted || endedRef.current) return;
        t0.current = t.sessionT0() ?? performance.now();
        dispatch("connected");
        timeline.current.addMarker(0, `interview started (live session ${liveSessionId || "?"})`);
        t.sendCommentary("The candidate has just joined the call. Greet them briefly and deliver the interview question now.");
      },
      onTranscript(speaker, delta, startMs, endMs) {
        if (!signal.aborted && !finalPayload.current) timeline.current.addTranscriptFragment(speaker, delta, startMs, endMs);
      },
      onUsageSeconds() {},
      async onToolCall(name, _args, toolSignal) {
        if (name !== "view_whiteboard") return JSON.stringify({ error: `unknown tool ${name}` });
        const summary = summarizeScene(board.currentElements());
        t.markLocal("tool.view_whiteboard.export.start");
        const image = await board.exportLiveImage(toolSignal).catch(() => null);
        toolSignal.throwIfAborted();
        t.markLocal("tool.view_whiteboard.export.end", image ? `${image.length} chars` : "failed");
        return { output: JSON.stringify({ whiteboard: summary }),
          ...(image ? { image: { dataUrl: image, note: "requested via view_whiteboard" } } : {}) };
      },
      onEnded(reason) { if (!signal.aborted) void endInterview(reason); },
    });
    transport.current = t;
    try { await t.connect(signal); }
    catch (error) {
      await t.close(false);
      if (signal.aborted || endedRef.current) return;
      setError(error instanceof Error ? error.message : String(error));
      dispatch("connection_failed");
      // The server may already have accepted the offer. Refresh exposes saved-progress recovery.
      router.refresh();
    } finally { connecting.current = false; }
  }, [phase, session.id, board, endInterview, router]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const unsubscribe = timeline.current.subscribe(() => setEvents([...timeline.current.getEvents()]));
    return () => {
      unsubscribe();
      controller.abort();
      void transport.current?.close(false);
    };
  }, []);

  // Session-clock timer + pacing warnings
  useEffect(() => {
    if (phase !== "live") return;
    const iv = setInterval(() => {
      const ms = sessionMs();
      setElapsedSec(Math.floor(ms / 1000));
      const remain = session.durationSec - ms / 1000;
      if (ms >= nextTimeContextAt.current) {
        const context = interviewClockContext(session.durationSec, ms);
        if (context) transport.current?.sendThinking(context);
        nextTimeContextAt.current =
          (Math.floor(ms / TIME_CONTEXT_INTERVAL_MS) + 1) * TIME_CONTEXT_INTERVAL_MS;
      }
      for (const warning of pacingWarnings) {
        if (remain <= warning.remainingSec && !warnedAt.current.has(warning.remainingSec)) {
          warnedAt.current.add(warning.remainingSec);
          transport.current?.sendInstructions(warning.instruction);
          timeline.current.addMarker(ms, warning.label);
        }
      }
      if (remain <= 0) void endInterview("time expired");
    }, 500);
    return () => clearInterval(iv);
  }, [phase, session.durationSec, sessionMs, pacingWarnings, endInterview]);


  const toggleMute = () => {
    if (muted) transport.current?.unmute();
    else transport.current?.mute();
    setMuted(!muted);
  };
  const onBoardApi = board.setApi;
  return { phase, statusDetail, elapsedSec, muted, thinking, events, error, checkpointError,
    start, endInterview, saveAndFinish, recoverSavedInterview, retryFinalization, exportLocalWork, prepared, toggleMute, onBoardApi, onWhiteboardChange };
}
