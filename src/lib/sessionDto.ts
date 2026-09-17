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
    prompt: {
      id: session.prompt.id,
      title: session.prompt.title,
      question: session.prompt.question,
      context: session.prompt.context,
      deepDiveAngles: session.prompt.deepDiveAngles,
    },
    durationSec: session.durationSec,
    status: session.status,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    transcript: session.transcript,
    timeline: session.timeline,
    finalImage: session.finalImage,
    grade: session.grade,
    gradeStatus: session.gradeStatus,
    gradeError: session.gradeError,
    recordingStatus: session.recordingStatus,
    recordingError: session.recordingError,
    hasRecording: Boolean(session.recordingPath),
  };
}
