import type { DecodedFrame } from '../media.ts';

export type ResourceKind = 'frames' | 'decodeReservations' | 'readback' | 'derived';
export const SESSION_RESOURCE_BYTES = 256 * 1024 * 1024;
/** Account application-owned bytes, not opaque decoder/WASM/GPU allocations.
 * Essential review frames may exceed the target; optional work never may. */
export class SessionResources {
  private bytes: Record<ResourceKind, number> = { frames: 0, decodeReservations: 0, readback: 0, derived: 0 };
  private peak = 0;
  private listeners = new Set<() => void>();
  private owned = new WeakSet<DecodedFrame>();
  private optional = new Set<() => void>();
  readonly budgetBytes: number;
  constructor(budgetBytes = SESSION_RESOURCE_BYTES) { this.budgetBytes = budgetBytes; }
  get totalBytes() { return Object.values(this.bytes).reduce((sum, bytes) => sum + bytes, 0); }
  canPrefetch(bytes: number) { return this.totalBytes + bytes <= this.budgetBytes; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  reserve(kind: ResourceKind, bytes: number, essential = false): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('无效资源大小。');
    if (!essential && !this.canPrefetch(bytes)) return null;
    this.bytes[kind] += bytes; this.peak = Math.max(this.peak, this.totalBytes);
    if (this.totalBytes >= this.budgetBytes) for (const cancel of [...this.optional]) cancel();
    let released = false;
    return () => { if (released) return; released = true; this.bytes[kind] -= bytes; for (const listener of this.listeners) listener(); };
  }
  cancelOnPressure(cancel: () => void) { this.optional.add(cancel); return () => { this.optional.delete(cancel); }; }
  own(frame: DecodedFrame): DecodedFrame {
    if (this.owned.has(frame)) return frame;
    const release = this.reserve('frames', frame.byteSize, true)!;
    const close = frame.close.bind(frame); let closed = false;
    // Preserve getters and the resource identity used by presenter/backends.
    frame.close = () => { if (closed) return; closed = true; try { close(); } finally { release(); } };
    this.owned.add(frame); return frame;
  }
  snapshot() { return { budgetBytes: this.budgetBytes, totalBytes: this.totalBytes, peakBytes: this.peak, pressure: this.totalBytes >= this.budgetBytes, overBudgetBytes: Math.max(0, this.totalBytes - this.budgetBytes), ...this.bytes,
    scope: 'application-owned; excludes decoder internals, WASM heaps and GPU allocations' }; }
}
