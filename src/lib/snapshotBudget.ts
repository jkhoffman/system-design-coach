/** Reserve before async export; charge quota and cooldown only after publication. */
export class SnapshotBudget {
  private pending = false;
  private count = 0;
  private last = -Infinity;
  constructor(private limit = 12, private gapMs = 45_000) {}
  reserve(time: number): (() => void) | null {
    if (this.pending || this.count >= this.limit || time - this.last < this.gapMs) return null;
    this.pending = true;
    let committed = false;
    return () => { if (!committed) { committed = true; this.count++; this.last = time; } };
  }
  release(): void { this.pending = false; }
}
