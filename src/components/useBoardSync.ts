"use client";

import { useCallback, useEffect, useRef } from "react";
import type { LiveTransport } from "@/lib/liveSession";
import type { Timeline } from "@/lib/timeline";
import { elementsVersionKey, summarizeScene, type ExcalidrawElementLike } from "@/lib/summarizeScene";
import { bounded } from "@/lib/async";
import { fmtMs } from "@/lib/time";

const DRAWING_PAUSE_MS = 4000;
const SNAPSHOT_MIN_GAP_MS = 45_000;
const MAX_SNAPSHOTS = 12;

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
  const lastSnapshotMs = useRef(-SNAPSHOT_MIN_GAP_MS);
  const snapshotCount = useRef(0);
  const pendingTasks = useRef(new Set<Promise<void>>());

  const trackTask = useCallback((task: Promise<void>) => {
    const tracked = task.catch(() => {});
    pendingTasks.current.add(tracked);
    void tracked.finally(() => pendingTasks.current.delete(tracked));
  }, []);

  const pushBoardUpdate = useCallback(async () => {
    if (!boardDirty.current || !transport.current || t0.current == null) return;
    boardDirty.current = false;
    const t = sessionMs();
    const summary = summarizeScene(currentElements());
    transport.current.sendThinking(`[whiteboard state at ${fmtMs(t)}]\n${summary}`);
    timeline.current.addBoardSummary(t, summary);

    if (
      snapshotCount.current >= MAX_SNAPSHOTS ||
      t - lastSnapshotMs.current < SNAPSHOT_MIN_GAP_MS
    ) {
      return;
    }

    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    lastSnapshotMs.current = t;
    snapshotCount.current++;
    const png = await exportPngDataUrl(signal).catch(() => null);
    if (!png || signal.aborted) return;
    const upload = (async () => {
      const res = await fetch(`/api/sessions/${sessionId}/snapshot`, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startMs: t, label: "milestone", png }),
      });
      if (!res.ok) return;
      const d = (await res.json()) as { file?: string };
      if (!signal.aborted && d.file) timeline.current.addSnapshot(t, "milestone", d.file);
    })();
    trackTask(upload);
    await upload.catch(() => {});
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
    if (boardDirty.current) trackTask(pushBoardUpdate());
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
