export const PRESET_DURATIONS = [20 * 60, 30 * 60, 45 * 60];
export type DurationSelection = { kind: "preset"; seconds: number } | { kind: "custom"; minutes: string };

export function durationSeconds(selection: DurationSelection): number | null {
  const seconds = selection.kind === "preset" ? selection.seconds : Number(selection.minutes) * 60;
  return Number.isInteger(seconds / 60) && seconds >= 300 && seconds <= 7200 ? seconds : null;
}
