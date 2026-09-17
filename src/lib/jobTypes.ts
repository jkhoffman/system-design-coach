import type { SessionStatus } from "./types";

export type JobKind = "grade" | "recording";
export interface JobState {
  status: "idle" | "running" | "done" | "failed" | "unavailable";
  error?: string;
  leaseExpiresAt?: number;
  stale: boolean;
}
export interface SessionJobStatus {
  id: string;
  status: SessionStatus;
  grade: JobState;
  recording: JobState;
}
