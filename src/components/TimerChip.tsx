import { formatSeconds } from "@/lib/time";

export default function TimerChip({
  elapsedSec,
  totalSec,
  live,
}: {
  elapsedSec: number;
  totalSec: number;
  live: boolean;
}) {
  const remain = Math.max(0, totalSec - elapsedSec);
  const low = live && remain <= 300;
  return (
    <span
      className={`rounded px-2 py-1 font-mono text-sm tabular-nums ${
        low ? "bg-red-900/60 text-red-300" : "bg-neutral-800 text-neutral-200"
      }`}
    >
      {formatSeconds(remain)}
    </span>
  );
}
