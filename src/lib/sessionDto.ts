import { toPublicPrompt } from "./publicPrompt";
import type { ClientSession, SessionRow } from "./types";

/** Fields that are safe and useful for browser callers; hides secrets, paths, and hidden prompt data. */
export function toClientSession(session: SessionRow): ClientSession {
  return {
    id: session.id,
    checkpointRevision: session.checkpointRevision,
    mode: session.mode,
    briefing: {
      company: session.briefing.company,
      position: session.briefing.position,
      level: session.briefing.level,
    },
    prompt: toPublicPrompt(session.prompt),
    durationSec: session.durationSec,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    transcript: session.transcript,
    timeline: session.timeline,
    finalImageUrl: session.finalImage || session.finalImagePath ? `/api/sessions/${session.id}/image` : undefined,
    grade: session.grade,
    gradeReadError: session.gradeReadError,
    gradeStatus: session.gradeStatus,
    gradeError: session.gradeError,
    recordingStatus: session.recordingStatus,
    recordingError: session.recordingError,
    hasRecording: Boolean(session.recordingPath),
  };
}
