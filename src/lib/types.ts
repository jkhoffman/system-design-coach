import type { LiveTraceEvent } from "./liveTrace";

import type { z } from "zod";
import type { BriefingSchema, PromptSpecSchema, FactSheetEntrySchema, TranscriptTurnSchema,
  TimelineEventSchema, GradeReportSchema, DimensionScoreSchema, TradeoffAuditEntrySchema, CreateSessionSchema,
} from "./schemas";

export type Mode = z.infer<typeof CreateSessionSchema>["mode"];
export type Briefing = z.infer<typeof BriefingSchema>;
export type PromptSpec = z.infer<typeof PromptSpecSchema>;
export type FactSheetEntry = z.infer<typeof FactSheetEntrySchema>;
export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type GradeReport = z.infer<typeof GradeReportSchema>;
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;
export type TradeoffAuditEntry = z.infer<typeof TradeoffAuditEntrySchema>;

export type Speaker = "candidate" | "interviewer";
export type SessionStatus = "created" | "live" | "ended" | "graded";
export type GradeStatus = "idle" | "running" | "done" | "failed";
export type RecordingStatus = "idle" | "running" | "done" | "failed" | "unavailable";

export interface SessionRow {
  id: string;
  checkpointRevision: number;
  mode: Mode;
  briefing: Briefing;
  prompt: PromptSpec;
  durationSec: number;
  status: SessionStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  liveSessionId?: string;
  recordingPath?: string;
  recordingStatus?: RecordingStatus;
  recordingError?: string;
  gradeStatus?: GradeStatus;
  gradeError?: string;
  transcript: TranscriptTurn[];
  timeline: TimelineEvent[];
  liveTrace?: LiveTraceEvent[];
  finalScene?: unknown;
  finalImage?: string;
  grade?: GradeReport;
}

export interface ClientSession {
  id: string;
  checkpointRevision: number;
  mode: Mode;
  briefing: Omit<Briefing, "jobDescription">;
  prompt: Omit<PromptSpec, "factSheet">;
  durationSec: number;
  status: SessionStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  transcript: TranscriptTurn[];
  timeline: TimelineEvent[];
  finalImage?: string;
  grade?: GradeReport;
  gradeStatus?: GradeStatus;
  gradeError?: string;
  recordingStatus?: RecordingStatus;
  recordingError?: string;
  hasRecording: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  company: string;
  level: string;
  durationSec: number;
  status: SessionStatus;
  createdAt: number;
  score?: number;
}

