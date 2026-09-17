import { z } from "zod";

export const MAX_TRACE_EVENTS = 10_000;
export const TRACE_LIMITS = { name: 120, id: 200, preview: 500, error: 2000 } as const;

export const LiveTraceEventSchema = z.object({
  seq: z.number().finite(),
  dir: z.enum(["in", "out", "local"]),
  atPerfMs: z.number().finite().min(0),
  sessionMs: z.number().finite().min(0).optional(),
  type: z.string().max(TRACE_LIMITS.name),
  innerType: z.string().max(TRACE_LIMITS.name).optional(),
  eventId: z.string().max(TRACE_LIMITS.id).optional(),
  clientEventId: z.string().max(TRACE_LIMITS.id).optional(),
  delegationId: z.string().max(TRACE_LIMITS.id).optional(),
  responseId: z.string().max(TRACE_LIMITS.id).optional(),
  callId: z.string().max(TRACE_LIMITS.id).optional(),
  itemType: z.string().max(TRACE_LIMITS.name).optional(),
  toolName: z.string().max(TRACE_LIMITS.name).optional(),
  speaker: z.enum(["candidate", "interviewer"]).optional(),
  startMs: z.number().finite().min(0).optional(),
  endMs: z.number().finite().min(0).optional(),
  offsetMs: z.number().finite().min(0).optional(),
  bytes: z.number().int().min(0).optional(),
  hasImage: z.boolean().optional(),
  imageBytes: z.number().int().min(0).optional(),
  sent: z.boolean().optional(),
  textPreview: z.string().max(TRACE_LIMITS.preview).optional(),
  detail: z.string().max(TRACE_LIMITS.preview).optional(),
  error: z.string().max(TRACE_LIMITS.error).optional(),
});

export const LiveTraceSchema = z.array(LiveTraceEventSchema).max(MAX_TRACE_EVENTS);


export type LiveTraceEvent = z.infer<typeof LiveTraceEventSchema>;
export type LiveTraceDirection = LiveTraceEvent["dir"];

/** Diagnostics are best effort: discard invalid fields/records, never reject interview content. */
export function sanitizeTraceEvent(input: unknown): LiveTraceEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(LiveTraceEventSchema.shape)) {
    let value = source[key];
    if (typeof value === "string") {
      const limit = key === "error" ? TRACE_LIMITS.error
        : key === "detail" || key === "textPreview" ? TRACE_LIMITS.preview
        : key.endsWith("Id") ? TRACE_LIMITS.id : TRACE_LIMITS.name;
      value = value.slice(0, limit);
    }
    const parsed = field.safeParse(value);
    if (parsed.success && parsed.data !== undefined) clean[key] = parsed.data;
  }
  const result = LiveTraceEventSchema.safeParse(clean);
  return result.success ? result.data : null;
}

export function sanitizeTrace(input: unknown): LiveTraceEvent[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input.slice(0, MAX_TRACE_EVENTS).flatMap((event) => {
    const clean = sanitizeTraceEvent(event);
    return clean ? [clean] : [];
  });
}

export const TraceInputSchema = z.preprocess(sanitizeTrace, LiveTraceSchema.optional());
