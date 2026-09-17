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
  const finalPayload = useRef<FinalPayload | null>(null);
  const pacingWarnings = useMemo(() => interviewPacing(session.durationSec).warnings, [session.durationSec]);
  const sessionMs = useCallback(() => t0.current == null ? 0 : performance.now() - t0.current, []);
  const { onWhiteboardChange, flushBoardUpdates } = useBoardSync({
    sessionId: session.id, transport, timeline, t0, sessionMs,
    currentElements: board.currentElements, exportPngDataUrl: board.exportPng,
  });
  const liveTraceSnapshot = useCallback(() => transport.current?.traceSnapshot() ?? [], []);
  const { checkpointError, stopCheckpointing } = useInterviewCheckpoint({
    sessionId: session.id, initialRevision: session.checkpointRevision,
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
    // Teardown stops capture immediately while pending board work drains within its deadline.
    const closing = transport.current?.close();
    await flushBoardUpdates();
    const finalImage = await board.exportPng(signal).catch(() => null);
    await closing;
    if (signal.aborted) return;
    finalPayload.current = structuredClone({
      kind: "finish", endedAt: Date.now(), transcript: timeline.current.getTranscript(),
      timeline: timeline.current.getEvents(), liveTrace: transport.current?.traceSnapshot() ?? [],
      finalScene: [...board.currentElements()], finalImage,
    });
    await saveAndFinish();
  }, [stopCheckpointing, sessionMs, flushBoardUpdates, board, saveAndFinish]);

  const recoverSavedInterview = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    dispatch("finish");
    finalPayload.current = structuredClone({ kind: "finish", endedAt: Date.now(),
      transcript: session.transcript, timeline: session.timeline });
    void saveAndFinish();
  }, [session.transcript, session.timeline, saveAndFinish]);

  const start = useCallback(async () => {
    if (phase !== "lobby" || connecting.current || endedRef.current || !lifetime.current) return;
    connecting.current = true;
    dispatch("connect");
    setError(null);
    setMuted(false);
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
    start, endInterview, saveAndFinish, recoverSavedInterview, toggleMute, onBoardApi, onWhiteboardChange };
}
