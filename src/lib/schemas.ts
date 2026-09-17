import { z } from "zod";
import { TraceInputSchema } from "./traceContracts";
export { LiveTraceEventSchema, LiveTraceSchema } from "./traceContracts";

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

export const ExpandPromptSchema = BriefingSchema.extend({
  description: z.string().trim().min(1).max(20_000),
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
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    transcript: z.array(TranscriptTurnSchema).max(20_000),
    timeline: z.array(TimelineEventSchema).max(50_000),
    liveTrace: TraceInputSchema,
  }),
  z.object({
    kind: z.literal("finish"),
    endedAt: z.number().int().positive(),
    transcript: z.array(TranscriptTurnSchema).max(20_000),
    timeline: z.array(TimelineEventSchema).max(50_000),
    liveTrace: TraceInputSchema,
    finalScene: z.array(z.unknown()).max(50_000).optional(),
    finalImage: z.string().max(MAX_PNG_DATA_URL_CHARS).regex(/^data:image\/(png|jpeg|webp);base64,/).nullable().optional(),
  }),
]);

const SessionSetupSchema = z.object({
  briefing: BriefingSchema,
  durationSec: z.number().int().min(5 * 60).max(120 * 60),
});
export const CreateSessionSchema = z.discriminatedUnion("mode", [
  SessionSetupSchema.extend({ mode: z.literal("library"), promptId: z.string().trim().min(1).max(80) }),
  SessionSetupSchema.extend({ mode: z.literal("custom"), prompt: PromptSpecSchema }),
  SessionSetupSchema.extend({ mode: z.literal("freeform"), prompt: PromptSpecSchema }),
]);

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

const gradeText = z.string().max(20_000);
const gradeTime = z.number().finite().min(0);
export const DimensionScoreSchema = z.object({
  key: z.enum(["scoping", "architecture", "depth", "tradeoffs", "communication", "pacing"]),
  label: gradeText, score: z.number().min(1).max(5), weight: z.number().min(0).max(1),
  evidence: gradeText,
  moments: z.array(z.object({ startMs: gradeTime, note: gradeText })),
});
export const TradeoffAuditEntrySchema = z.object({
  choice: gradeText, alternativeStated: z.boolean(), reasonStated: z.boolean(), startMs: gradeTime.nullable(),
});
export const GradeReportSchema = z.object({
  overall: z.object({ score: z.number().min(1).max(5),
    signal: z.enum(["strong_no_hire", "no_hire", "lean_no_hire", "lean_hire", "hire", "strong_hire"]),
    summary: gradeText }),
  dimensions: z.array(DimensionScoreSchema).length(6),
  tradeoffAudit: z.array(TradeoffAuditEntrySchema),
  strengths: z.array(gradeText),
  antiPatterns: z.array(z.object({ startMs: gradeTime.nullable(), description: gradeText })),
  strongHireWouldHave: z.array(gradeText), drills: z.array(gradeText),
});
