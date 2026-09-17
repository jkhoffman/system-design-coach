/** Evidence timestamps round to the nearest second; live clocks show whole elapsed seconds. */
export function fmtMs(ms: number): string { return formatSeconds(Math.round(ms / 1000)); }
export function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
