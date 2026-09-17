export type InterviewPhase = "lobby" | "connecting" | "live" | "ending" | "ended";
export type InterviewAction = "connect" | "connected" | "connection_failed" | "finish" | "saved";

const transitions: Record<InterviewPhase, Partial<Record<InterviewAction, InterviewPhase>>> = {
  lobby: { connect: "connecting", finish: "ending" },
  connecting: { connected: "live", connection_failed: "lobby", finish: "ending" },
  live: { finish: "ending" },
  ending: { saved: "ended" },
  ended: {},
};

export function interviewTransition(phase: InterviewPhase, action: InterviewAction): InterviewPhase {
  return transitions[phase][action] ?? phase;
}
