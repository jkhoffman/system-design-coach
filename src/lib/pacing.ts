import { formatSeconds } from "./time";

export interface PacingWarning {
  remainingSec: number;
  label: string;
  instruction: string;
}

export interface InterviewPacing {
  clarifySec: number;
  warnings: PacingWarning[];
  milestones: PacingMilestone[];
}

export interface PacingMilestone {
  id: "clarification" | "architecture" | "deep_dive" | "coverage" | "summary";
  elapsedSec: number;
  label: string;
  instruction: string;
}

export const TIME_CONTEXT_INTERVAL_MS = 5 * 60_000;

export function interviewClockContext(durationSec: number, elapsedMs: number): string | null {
  const elapsedSec = Math.floor(elapsedMs / 1000);
  if (elapsedSec < TIME_CONTEXT_INTERVAL_MS / 1000 || elapsedSec >= durationSec) return null;
  const remainingSec = durationSec - elapsedSec;
  return `[interview clock] elapsed ${formatSeconds(elapsedSec)} of ${formatSeconds(durationSec)} (${formatSeconds(remainingSec)} remaining)`;
}

function fmtRemaining(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} seconds`;
  const mins = Math.max(1, Math.round(sec / 60));
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

/** Derive interview phases from the configured duration instead of fixed 45-minute markers. */
export function interviewPacing(durationSec: number): InterviewPacing {
  const clarifySec = Math.max(60, Math.min(7 * 60, Math.round(durationSec * 0.15)));
  const at = (fraction: number, after: number) => Math.min(durationSec - 15, Math.max(after + 30, Math.round(durationSec * fraction)));
  const architectureSec = at(0.42, clarifySec);
  const deepDiveSec = at(0.53, architectureSec);
  const coverageSec = at(0.78, deepDiveSec);
  const summarySec = at(0.9, coverageSec);
  const milestones: PacingMilestone[] = [
    { id: "clarification", elapsedSec: clarifySec, label: "clarification complete",
      instruction: "Conclude clarification now. Ask the candidate to summarize the requirements briefly, then have them begin the high-level architecture." },
    { id: "architecture", elapsedSec: architectureSec, label: "architecture checkpoint",
      instruction: "Ensure the candidate has an end-to-end high-level design. If the main flow is clear, stop broad scoping and prepare to choose a focused deep dive." },
    { id: "deep_dive", elapsedSec: deepDiveSec, label: "deep-dive phase",
      instruction: "Move into the deep-dive phase. Choose at most two design-specific areas based on what the candidate actually proposed; do not open unrelated topics." },
    { id: "coverage", elapsedSec: coverageSec, label: "coverage check",
      instruction: "Check the most important remaining gap: scale, failure behavior, consistency, or an unstated trade-off. Do not start more than one new topic." },
    { id: "summary", elapsedSec: summarySec, label: "final summary",
      instruction: "Stop opening new topics. Tell the candidate time is nearly up and ask for a concise end-to-end summary plus their biggest unresolved risk." },
  ];

  const warnings = milestones.slice(-2).map((milestone) => {
    const remainingSec = durationSec - milestone.elapsedSec;
    return { remainingSec, label: `${fmtRemaining(remainingSec)} remaining`, instruction: milestone.instruction };
  });
  return { clarifySec, warnings, milestones };
}
