/** A response belongs to exactly one input revision, even if cancellation is ignored. */
export class LatestRequest {
  private revision = 0;
  private controller: AbortController | null = null;
  invalidate(): void {
    this.revision++;
    this.controller?.abort();
    this.controller = null;
  }
  begin() {
    this.invalidate();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    return { signal: controller.signal, isCurrent: () => revision === this.revision && !controller.signal.aborted };
  }
}
