import { sanitizeTraceEvent, MAX_TRACE_EVENTS, TRACE_LIMITS, type LiveTraceEvent } from "./traceContracts";
export type { LiveTraceEvent, LiveTraceDirection } from "./traceContracts";

const MAX_PREVIEW_CHARS = TRACE_LIMITS.preview;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function preview(value: unknown): string | undefined {
  const text = asString(value);
  return text ? text.slice(0, MAX_PREVIEW_CHARS) : undefined;
}

function contentSummary(content: unknown): {
  hasImage?: boolean;
  imageBytes?: number;
  textPreview?: string;
} {
  if (!Array.isArray(content)) return {};
  let imageBytes = 0;
  const texts: string[] = [];
  for (const part of content) {
    const item = asObject(part);
    if (!item) continue;
    if (item.type === "input_image") {
      imageBytes += asString(item.image_url)?.length ?? 0;
      continue;
    }
    const text = asString(item.text);
    if (text) texts.push(text);
  }
  return {
    hasImage: imageBytes > 0 || undefined,
    imageBytes: imageBytes || undefined,
    textPreview: preview(texts.join(" ")),
  };
}

/** Bounded, redacted record of Live protocol activity for latency diagnosis. */
export class LiveTrace {
  private events: LiveTraceEvent[] = [];
  private seq = 0;
  private droppedCount = 0;
  private sessionT0: number | null = null;

  private sessionMs(): number | undefined {
    return this.sessionT0 == null ? undefined : performance.now() - this.sessionT0;
  }

  private push(event: Omit<LiveTraceEvent, "seq" | "atPerfMs" | "sessionMs">): void {
    const clean = sanitizeTraceEvent({
      seq: this.seq++,
      atPerfMs: performance.now(),
      sessionMs: this.sessionMs(),
      ...event,
    });
    if (!clean) return;
    this.events.push(clean);
    if (this.events.length >= MAX_TRACE_EVENTS) {
      const preserve = new Set(["connect.start", "session.started"]);
      let excess = this.events.length - MAX_TRACE_EVENTS + 1;
      for (let i = 0; i < this.events.length && excess > 0; i++) {
        if (preserve.has(this.events[i].type)) continue;
        this.events.splice(i, 1);
        this.droppedCount++;
        i--;
        excess--;
      }
      while (excess > 0 && this.events.length > 1) {
        this.events.shift();
        this.droppedCount++;
        excess--;
      }
    }
  }

  incoming(raw: string): void {
    let ev: JsonObject;
    try {
      const parsed = asObject(JSON.parse(raw));
      if (!parsed) throw new Error("protocol event must be an object");
      ev = parsed;
    } catch (error) {
      this.push({
        dir: "in",
        type: "message.parse_error",
        bytes: new TextEncoder().encode(raw).length,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (ev.type === "session.started" && this.sessionT0 == null) this.sessionT0 = performance.now();
    const inner = asObject(ev.event);
    const innerItem = asObject(inner?.item);
    const item = asObject(ev.item) ?? innerItem;
    const delegation = asObject(ev.delegation);
    const error = asObject(ev.error);
    const transcriptSpeaker =
      ev.type === "session.input_transcript.delta"
        ? "candidate"
        : ev.type === "session.output_transcript.delta"
          ? "interviewer"
          : undefined;

    this.push({
      dir: "in",
      type: asString(ev.type) ?? "unknown",
      innerType: asString(inner?.type),
      eventId: asString(ev.event_id),
      clientEventId: asString(ev.client_event_id) ?? asString(error?.client_event_id),
      delegationId: asString(ev.delegation_id) ?? asString(delegation?.id),
      responseId:
        asString(ev.response_id) ??
        asString(asObject(ev.response)?.id) ??
        asString(inner?.response_id) ??
        asString(asObject(inner?.response)?.id),
      callId: asString(item?.call_id),
      itemType: asString(item?.type),
      toolName: asString(item?.name),
      speaker: transcriptSpeaker,
      startMs: asNumber(ev.start_ms) ?? asNumber(inner?.start_ms),
      endMs: asNumber(ev.end_ms) ?? asNumber(inner?.end_ms),
      offsetMs: asNumber(ev.offset_ms),
      bytes: new TextEncoder().encode(raw).length,
      textPreview:
        preview(ev.delta) ??
        preview(inner?.delta) ??
        preview(item?.arguments) ??
        preview(ev.reason),
      detail:
        asString(ev.reason) ??
        asString(inner?.status) ??
        asString(asObject(ev.session)?.id),
      error: asString(error?.message) ?? asString(ev.message),
    });
  }

  outgoing(obj: JsonObject, raw: string, sent: boolean, error?: string): void {
    const item = asObject(obj.item);
    this.push({
      dir: "out",
      type: asString(obj.type) ?? "unknown",
      eventId: asString(obj.event_id),
      delegationId: asString(obj.delegation_id),
      callId: asString(item?.call_id),
      itemType: asString(item?.type),
      toolName: asString(item?.name),
      bytes: new TextEncoder().encode(raw).length,
      sent,
      textPreview:
        preview(obj.content) ??
        contentSummary(item?.content).textPreview ??
        preview(item?.output),
      hasImage: contentSummary(item?.content).hasImage,
      imageBytes: contentSummary(item?.content).imageBytes,
      error,
    });
  }

  mark(type: string, detail?: string, extra: Partial<LiveTraceEvent> = {}): void {
    this.push({ dir: "local", type, detail, ...extra });
  }

  snapshot(): LiveTraceEvent[] {
    const events = this.events.map((event) => ({ ...event }));
    if (this.droppedCount > 0) {
      return [
        {
          seq: -1,
          dir: "local",
          atPerfMs: events[0]?.atPerfMs ?? 0,
          type: "trace.dropped",
          detail: `${this.droppedCount} oldest events dropped`,
        },
        ...events,
      ];
    }
    return events;
  }
}
