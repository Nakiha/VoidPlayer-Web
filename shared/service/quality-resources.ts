/** Instance admission reservations, not an OS RSS/CPU or bandwidth limit. */
export const QUALITY_EXECUTORS = ['psnr', 'vmaf', 'xpsnr', 'cambi', 'inspection', 'planning', 'preparation'] as const;
export type QualityExecutor = typeof QUALITY_EXECUTORS[number];
export type QualityResourceLimits = {
  concurrency: number;
  perExecutor: Record<QualityExecutor, number>;
  outstanding: number;
  actorOutstanding: number;
  memoryBytes: number;
  readBytes: number;
  threads: number;
};
export const DEFAULT_QUALITY_RESOURCES: QualityResourceLimits = {
  concurrency: 1,
  perExecutor: {psnr: 1, vmaf: 1, xpsnr: 1, cambi: 1, inspection: 1, planning: 1, preparation: 1},
  outstanding: 32, actorOutstanding: 8,
  memoryBytes: 2 * 1024 ** 3, readBytes: 8 * 1024 ** 3, threads: 4,
};
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw Error('Unknown or missing quality resource fields');
}
export function qualityResourceLimits(value: unknown): QualityResourceLimits {
  object(value, Object.keys(DEFAULT_QUALITY_RESOURCES));
  object(value.perExecutor, QUALITY_EXECUTORS);
  const integer = (n: unknown, min: number, max: number) => {
    if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max) throw Error('Quality resource limit out of range');
  };
  integer(value.concurrency, 1, 8);
  for (const kind of QUALITY_EXECUTORS) integer(value.perExecutor[kind], 1, ['inspection','planning','preparation'].includes(kind)?1:4);
  integer(value.outstanding, 1, 128); integer(value.actorOutstanding, 1, 32);
  integer(value.memoryBytes, 256 * 1024 ** 2, 32 * 1024 ** 3);
  integer(value.readBytes, 16 * 1024 ** 2, 256 * 1024 ** 3);
  integer(value.threads, 1, 32);
  return structuredClone(value) as QualityResourceLimits;
}
export type QualityReservation = {executor: QualityExecutor; memoryBytes: number; readBytes: number; threads: number};
export type QualityQueueCount = {actor: string; count: number};
export type QualityResourceChange = {
  at: number; actor: {id: string; name: string}; requestId: string; previousRevision: string;
  before: QualityResourceLimits; after: QualityResourceLimits;
};
export type QualityResourceStatus = {
  limits: QualityResourceLimits;
  running: number; outstanding: number;
  reservations: {memoryBytes: number; readBytes: number; threads: number};
  executors: Record<QualityExecutor, {running: number; limit: number}>;
  ordinaryPolicy: 'exclusive-with-index-and-bitstream';
};
export type QualityResourceSettings = QualityResourceStatus & {
  revision: string | null; writable: boolean;
  reasonCode: 'external-change' | 'no-source' | 'not-writable' | null;
  history: QualityResourceChange[];
};
