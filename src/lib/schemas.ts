import { z } from "zod";

export const SESSION_ID_RE = /^[a-f0-9]{16}$/;
export const SNAPSHOT_FILE_RE = /^\d{1,10}\.png$/;
export const MAX_JSON_BODY_BYTES = 30 * 1024 * 1024;
export const MAX_PNG_DATA_URL_CHARS = 20 * 1024 * 1024;

export const BriefingSchema = z.object({
  company: z.string().trim().max(120).default(""),
  position: z.string().trim().max(120).default(""),
  level: z.string().trim().min(1).max(40),
  jobDescription: z.string().max(20_000).optional(),
});

export const GenerateBriefingSchema = BriefingSchema.extend({
  company: z.string().trim().min(1).max(120),
  position: z.string().trim().min(1).max(120),
});

export const FactSheetEntrySchema = z.object({
  q: z.string().trim().min(1).max(1000),
  a: z.string().trim().min(1).max(2000),
});

export const PromptSpecSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  question: z.string().trim().min(1).max(2000),
  context: z.string().trim().max(4000).default(""),
  factSheet: z.array(FactSheetEntrySchema).min(1).max(20),
  deepDiveAngles: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
});

export const TranscriptTurnSchema = z.object({
  speaker: z.enum(["candidate", "interviewer"]),
  startMs: z.number().finite().min(0),
  endMs: z.number().finite().min(0),
  text: z.string().max(20_000),
});

const timeMs = z.number().finite().min(0).max(24 * 60 * 60 * 1000);

export const TimelineEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn"),
    startMs: timeMs,
    endMs: timeMs,
    speaker: z.enum(["candidate", "interviewer"]),
    text: z.string().max(20_000),
  }),
  z.object({
    kind: z.literal("board"),
    startMs: timeMs,
    summary: z.string().max(10_000),
  }),
  z.object({
    kind: z.literal("marker"),
    startMs: timeMs,
    label: z.string().max(500),
  }),
  z.object({
    kind: z.literal("snapshot"),
    startMs: timeMs,
    label: z.string().max(200),
    file: z.string().regex(SNAPSHOT_FILE_RE),
  }),
]);

export const SessionPatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("progress"),
    transcript: z.array(TranscriptTurnSchema).max(20_000),
    timeline: z.array(TimelineEventSchema).max(50_000),
  }),
  z.object({
    kind: z.literal("finish"),
    endedAt: z.number().int().positive(),
    transcript: z.array(TranscriptTurnSchema).max(20_000),
    timeline: z.array(TimelineEventSchema).max(50_000),
    finalScene: z.array(z.unknown()).max(50_000).optional(),
    finalImage: z.string().max(MAX_PNG_DATA_URL_CHARS).regex(/^data:image\/(png|jpeg|webp);base64,/).nullable().optional(),
  }),
]);

export const CreateSessionSchema = z.object({
  mode: z.enum(["library", "custom"]),
  briefing: BriefingSchema,
  promptId: z.string().trim().max(80).optional(),
  prompt: PromptSpecSchema.optional(),
  durationSec: z.number().int().min(5 * 60).max(120 * 60),
});

export const LiveSessionRequestSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_RE),
  sdp: z.string().min(1).max(128 * 1024),
});

export const SnapshotRequestSchema = z.object({
  startMs: timeMs,
  label: z.string().trim().min(1).max(100).default("milestone"),
  png: z
    .string()
    .max(MAX_PNG_DATA_URL_CHARS)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/),
});

export function validSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}
