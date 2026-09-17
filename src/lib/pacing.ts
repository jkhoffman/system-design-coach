import { formatSeconds } from "./time";

export interface PacingWarning {
  remainingSec: number;
  label: string;
  instruction: string;
}

export interface InterviewPacing {
  clarifySec: number;
  warnings: PacingWarning[];
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
  const wrapSec =
    durationSec < 10 * 60
      ? Math.max(45, Math.round(durationSec * 0.2))
      : durationSec < 20 * 60
        ? 120
        : 300;
  const steerSec =
    durationSec < 10 * 60
      ? Math.max(wrapSec + 30, Math.round(durationSec * 0.5))
      : durationSec < 20 * 60
        ? Math.max(wrapSec + 60, Math.round(durationSec * 0.35))
        : 600;

  const warnings: PacingWarning[] = [
    {
      remainingSec: steerSec,
      label: `${fmtRemaining(steerSec)} remaining`,
      instruction: `There are ${fmtRemaining(steerSec)} left in the interview. Begin steering toward wrap-up.`,
    },
    {
      remainingSec: wrapSec,
      label: `${fmtRemaining(wrapSec)} remaining`,
      instruction: `There are ${fmtRemaining(wrapSec)} left in the interview. Start wrapping up — ask the candidate for a closing summary.`,
    },
  ];
  return { clarifySec, warnings };
}
