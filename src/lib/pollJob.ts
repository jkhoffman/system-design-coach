import type { JobState } from "./jobTypes";

export interface JobWatcher {
  load(signal: AbortSignal): Promise<JobState>;
  start(signal: AbortSignal): Promise<void>;
  onState(state: JobState): void;
  onError(message: string): void;
  onDone?(): void;
  retryFailed?: boolean;
  pollMs?: number;
  maxPolls?: number;
}

/** One cancellable request at a time. Terminal failures require an explicit retry. */
export function watchJob(input: JobWatcher): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let polls = 0;
  let retryFailed = input.retryFailed ?? false;
  const tick = async () => {
    if (controller.signal.aborted) return;
    try {
      const job = await input.load(controller.signal);
      if (controller.signal.aborted) return;
      input.onState(job);
      if (job.status === "done") { input.onDone?.(); return; }
      if (job.status === "unavailable") return;
      if (job.status === "failed" && !retryFailed) { input.onError(job.error ?? "Job failed"); return; }
      if (job.status === "idle" || job.stale || (job.status === "failed" && retryFailed)) {
        retryFailed = false;
        input.onState({ status: "running", stale: false });
        await input.start(controller.signal);
        if (controller.signal.aborted) return;
      }
      failures = 0;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (++failures >= 3) {
        input.onError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (controller.signal.aborted) return;
    if (++polls >= (input.maxPolls ?? 120)) { input.onError("This is taking longer than expected. Retry to check again."); return; }
    timer = setTimeout(() => void tick(), (input.pollMs ?? 3000) * Math.max(1, failures));
  };
  void tick();
  return () => { controller.abort(); clearTimeout(timer); };
}
