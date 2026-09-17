import type { Speaker, TimelineEvent, TranscriptTurn } from "./types";

const TURN_GAP_MS = 1500;

/**
 * Accumulates everything that happens in an interview on one session-ms
 * timeline: spoken turns (grouped from transcript fragments), whiteboard
 * change summaries, phase markers, and snapshot references.
 */
export class Timeline {
  private events: TimelineEvent[] = [];
  private openTurn: TranscriptTurn | null = null;
  private listeners = new Set<() => void>();

  reset(): void { this.events = []; this.openTurn = null; this.emit(); }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  addTranscriptFragment(speaker: Speaker, delta: string, startMs: number, endMs: number): void {
    const open = this.openTurn;
    if (open && open.speaker === speaker && startMs - open.endMs < TURN_GAP_MS) {
      open.text += delta;
      open.endMs = Math.max(open.endMs, endMs);
      this.updateOpenTurnEvent();
      this.emit();
      return;
    }
    this.closeTurn();
    this.openTurn = { speaker, startMs, endMs, text: delta };
    this.events.push({
      kind: "turn",
      speaker,
      startMs,
      endMs,
      text: delta,
    });
    this.emit();
  }

  private updateOpenTurnEvent(): void {
    const open = this.openTurn;
    if (!open) return;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.kind === "turn" && e.speaker === open.speaker && e.startMs === open.startMs) {
        e.endMs = open.endMs;
        e.text = open.text;
        return;
      }
    }
  }

  closeTurn(): void {
    this.openTurn = null;
  }

  addBoardSummary(startMs: number, summary: string): void {
    this.events.push({ kind: "board", startMs, summary });
    this.emit();
  }

  addMarker(startMs: number, label: string): void {
    this.events.push({ kind: "marker", startMs, label });
    this.emit();
  }

  addSnapshot(startMs: number, label: string, file: string): void {
    this.events.push({ kind: "snapshot", startMs, label, file });
    this.emit();
  }

  getEvents(): TimelineEvent[] {
    return this.events
      .map((event, index) => ({ event, index }))
      .sort((a, b) => a.event.startMs - b.event.startMs || a.index - b.index)
      .map(({ event }) => event);
  }

  getTranscript(): TranscriptTurn[] {
    return this.getEvents()
      .filter((e): e is Extract<TimelineEvent, { kind: "turn" }> => e.kind === "turn")
      .map((e) => ({ speaker: e.speaker, startMs: e.startMs, endMs: e.endMs, text: e.text }));
  }
}
