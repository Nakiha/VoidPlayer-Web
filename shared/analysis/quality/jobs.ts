import type { FramePairRequest } from './frame-pair.ts';
import type { LibraryPairResult } from './library-pair.ts';

export const QUALITY_JOB_LIMITS = Object.freeze({
  running: 1, queued: 4, actorOutstanding: 2, queueWaitMs: 300_000,
  requestBytes: 16 * 1024, resultBytes: 128 * 1024, historyRows: 1000,
  reservedBytes: 64 * 1024 * 1024, pageSize: 50,
});
export type QualityJobState = 'queued' | 'preparing' | 'running' | 'cancelling'
  | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type QualityJobPhase = 'queued' | 'source' | 'resolve' | 'decode' | 'publish' | 'stopping' | 'done';
export type QualityJobInput = {
  schema: 'voidplayer-psnr-frame-job'; version: 1;
  client: { id: string; kind: 'agent' | 'browser' | 'other' };
  request: FramePairRequest;
};
export type QualityJobReason = { code: string; message: string };
export type QualityJob = {
  schema: 'voidplayer-quality-job'; version: 1; id: string; revision: number; sequence: number;
  state: QualityJobState; phase: QualityJobPhase;
  submitted: { actorId: string; actorName: string; client: QualityJobInput['client']; requestId: string; idempotencyKey: string };
  createdAt: number; queueUntil: number; startedAt: number | null; endedAt: number | null;
  cancelRequestedAt: number | null; cancelRequestedBy: string | null; cancelRequestId: string | null;
  reason: QualityJobReason | null; input: QualityJobInput;
  attempt: { id: string; number: 1; startedAt: number; endedAt: number | null; state: QualityJobState; phase: QualityJobPhase } | null;
  result: { available: boolean; url: string; digest: string | null };
  progress: { scoredPairs: 0 | 1; targetPairs: 1; decodedFrames: null | 2 };
};
export type QualityJobResult = {
  schema: 'voidplayer-quality-job-result'; version: 1; jobId: string; attemptId: string;
  submitted: QualityJob['submitted']; completedAt: number; value: LibraryPairResult;
};
export type QualityJobPage = { schema: 'voidplayer-quality-jobs'; version: 1;
  entries: Omit<QualityJob, 'input'>[]; cursor: number; head: number; more: boolean };
export const terminalQualityJob = (state: QualityJobState) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(state);
