/** Observation scheduling only: never owns or cancels the underlying task. */
export class PollingCadence {
  private next = 0;
  private delay: number;
  private signature?: string;
  private visible = false;
  private interval: number;
  private maximum: number;
  private now: () => number;
  constructor(interval = 1000, maximum = 15000, now = () => performance.now()) {
    this.interval = interval; this.maximum = maximum; this.now = now; this.delay = interval;
  }
  reset() { this.next = 0; this.delay = this.interval; this.signature = undefined; }
  ready(visible = true) {
    if (!visible) { this.visible = false; return false; }
    if (!this.visible) { this.visible = true; this.reset(); }
    if (this.now() < this.next) return false;
    this.next = this.now() + this.delay;
    return true;
  }
  observe(value: unknown, active = false) {
    const signature = JSON.stringify(value);
    this.delay = active || signature !== this.signature ? this.interval : Math.min(this.maximum, this.delay * 2);
    this.signature = signature;
    this.next = this.now() + this.delay;
  }
  observeJobs(jobs: readonly { id: string; state: string; revision?: number }[], pending = false) {
    this.observe(jobs.map(job => [job.id, job.state, job.revision]), pending || jobs.some(job =>
      ['queued', 'preparing', 'running', 'cancelling', 'stopping'].includes(job.state)));
  }
}
