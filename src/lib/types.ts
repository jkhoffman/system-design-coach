export type Mode = "library" | "custom";

export interface Briefing {
  company: string;
  position: string;
  level: string;
  jobDescription?: string;
}

export interface FactSheetEntry {
  q: string;
  a: string;
}

export interface PromptSpec {
  id: string;
  title: string;
  /** The exact question the interviewer delivers. */
  question: string;
  /** One-paragraph scenario framing. */
  context: string;
  /** Hidden ground truth for clarifying questions. */
  factSheet: FactSheetEntry[];
  /** Angles the interviewer should push on in deep-dive phase. */
  deepDiveAngles: string[];
}

export type Speaker = "candidate" | "interviewer";
export type SessionStatus = "created" | "live" | "ended" | "graded";
export type GradeStatus = "idle" | "running" | "done" | "failed";
export type RecordingStatus = "idle" | "running" | "done" | "failed" | "unavailable";

export interface TranscriptTurn {
  speaker: Speaker;
  startMs: number;
  endMs: number;
  text: string;
}

export type TimelineEvent =
  | { kind: "turn"; startMs: number; endMs: number; speaker: Speaker; text: string }
  | { kind: "board"; startMs: number; summary: string }
  | { kind: "marker"; startMs: number; label: string }
  | { kind: "snapshot"; startMs: number; label: string; file: string };

export interface SessionRow {
  id: string;
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
  finalScene?: unknown;
  finalImage?: string;
  grade?: GradeReport;
}

export interface DimensionScore {
  key: string;
  label: string;
  /** 1-5 */
  score: number;
  weight: number;
  evidence: string;
  moments: { startMs: number; note: string }[];
}

export interface TradeoffAuditEntry {
  choice: string;
  alternativeStated: boolean;
  reasonStated: boolean;
  startMs: number | null;
}

export interface ClientSession {
  id: string;
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

export interface GradeReport {
  overall: {
    score: number;
    signal:
      | "strong_no_hire"
      | "no_hire"
      | "lean_no_hire"
      | "lean_hire"
      | "hire"
      | "strong_hire";
    summary: string;
  };
  dimensions: DimensionScore[];
  tradeoffAudit: TradeoffAuditEntry[];
  strengths: string[];
  antiPatterns: { startMs: number | null; description: string }[];
  strongHireWouldHave: string[];
  drills: string[];
}
