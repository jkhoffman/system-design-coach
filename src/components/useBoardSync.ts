"use client";

import { useCallback, useEffect, useRef } from "react";
import type { LiveTransport } from "@/lib/liveSession";
import type { Timeline } from "@/lib/timeline";
import { elementsVersionKey, summarizeScene, type ExcalidrawElementLike } from "@/lib/summarizeScene";
import { bounded } from "@/lib/async";
import { SnapshotBudget } from "@/lib/snapshotBudget";
import { fmtMs } from "@/lib/time";

const DRAWING_PAUSE_MS = 4000;

interface Ref<T> {
  current: T;
}

export function useBoardSync(input: {
  sessionId: string;
  transport: Ref<LiveTransport | null>;
  timeline: Ref<Timeline>;
  t0: Ref<number | null>;
  sessionMs: () => number;
  currentElements: () => readonly ExcalidrawElementLike[];
  exportPngDataUrl: (signal?: AbortSignal) => Promise<string | null>;
}) {
  const {
    sessionId,
    transport,
    timeline,
    t0,
    sessionMs,
    currentElements,
    exportPngDataUrl,
  } = input;
  const lifetime = useRef<AbortController | null>(null);
  const finishing = useRef(false);
  const lastVersionKey = useRef("");
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const boardDirty = useRef(false);
  const budget = useRef(new SnapshotBudget());
  const pendingTasks = useRef(new Set<Promise<void>>());

  const trackTask = useCallback((task: Promise<void>) => {
    const tracked = task.catch(() => {});
    pendingTasks.current.add(tracked);
    void tracked.finally(() => pendingTasks.current.delete(tracked));
  }, []);

  const pushBoardUpdate = useCallback(async (publishLive = true) => {
    if (!boardDirty.current || !transport.current || t0.current == null) return;
    boardDirty.current = false;
    const t = sessionMs();
    const summary = summarizeScene(currentElements());
    if (publishLive) transport.current.sendThinking(`[whiteboard state at ${fmtMs(t)}]\n${summary}`);
    timeline.current.addBoardSummary(t, summary);

    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const commit = budget.current.reserve(t);
    if (!commit) return;
    try {
      const png = await exportPngDataUrl(signal).catch(() => null);
      if (!png || signal.aborted) return;
      const upload = (async () => {
        const res = await fetch(`/api/sessions/${sessionId}/snapshot`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...transport.current?.owner, startMs: t, label: "milestone", png }),
        });
        if (!res.ok) return;
        const d = (await res.json()) as { file?: string };
        if (!signal.aborted && d.file) {
          commit();
          timeline.current.addSnapshot(t, "milestone", d.file);
        }
      })();
      trackTask(upload);
      await upload.catch(() => {});
    } finally { budget.current.release(); }
  }, [
    sessionId,
    transport,
    timeline,
    t0,
    sessionMs,
    currentElements,
    exportPngDataUrl,
    trackTask,
  ]);

  const onWhiteboardChange = useCallback(
    (elements: readonly { id: string; version?: number; isDeleted?: boolean }[]) => {
      if (finishing.current) return;
      const key = elementsVersionKey(elements as readonly ExcalidrawElementLike[]);
      if (key === lastVersionKey.current) return; // selection/scroll only
      lastVersionKey.current = key;
      boardDirty.current = true;
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
      pauseTimer.current = setTimeout(() => trackTask(pushBoardUpdate()), DRAWING_PAUSE_MS);
    },
    [pushBoardUpdate, trackTask]
  );

  const flushBoardUpdates = useCallback(async () => {
    finishing.current = true;
    if (pauseTimer.current) {
      clearTimeout(pauseTimer.current);
      pauseTimer.current = null;
    }
    if (boardDirty.current) trackTask(pushBoardUpdate(false));
    try { await bounded(Promise.allSettled([...pendingTasks.current]), 12_000); }
    catch { /* A failed upload cannot prevent finalization. */ }
    finally { lifetime.current?.abort(); }
  }, [pushBoardUpdate, trackTask]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (pauseTimer.current) clearTimeout(pauseTimer.current);
    };
  }, []);

  return { onWhiteboardChange, flushBoardUpdates };
}
