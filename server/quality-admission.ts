import { AdminError } from './admin-error.ts';

/** Conservative instance-wide exclusion for one-shot quality versus index
 * builds/uploads and bitstream work. Existing read-only cache queries remain usable.
 * This bounds those admitted workers; it is not a process RSS or OS CPU quota. */
export class QualityAdmission {
  private quality = false;
  private blockers = new Set<() => boolean>();
  register(blocked: () => boolean) { this.blockers.add(blocked); return () => this.blockers.delete(blocked); }
  ordinary() { if (this.quality) throw new AdminError(503, 'Quality execution owns the compute admission.', 'quality-busy'); }
  acquire() {
    if (this.quality || [...this.blockers].some(blocked => blocked())) throw new AdminError(503, 'Compute admission is busy.', 'quality-busy');
    this.quality = true;
    let released = false;
    return () => { if (!released) { released = true; this.quality = false; } };
  }
}
