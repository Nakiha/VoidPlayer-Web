import type { MediaIndexIdentity } from './media-index-identity.ts';

export interface ServerIndexResult { epoch: number; index: unknown | null; }
export interface MediaIndexScanProgress { scannedBytes: number; totalBytes: number; packets: number; }
export interface MediaIndexRecordManifest {
  epoch: number; buildId: string; kind: 'ffmpeg'; state: 'building' | 'streaming' | 'complete' | 'failed';
  identity: MediaIndexIdentity; metadata: Record<string, unknown>; recordBytes: number; lastSeq: number;
}
export interface MediaIndexRecordBatch {
  buildId: string; seq: number; records: Uint8Array; count: number; safePresentationUs: number;
}
export interface MediaIndexTrace {
  serverIndexRequests: number;
  reconnects: number;
  indexBuildId?: string;
  indexIdentity?: MediaIndexIdentity;
  firstIndexBatchMs?: number;
  indexCompleteMs?: number;
  /** Time spent importing delivered records into the decoder core (diagnostic only). */
  recordImportMs?: number;
}
/** Compatibility alias for older call sites; transport consumers should use MediaIndexTrace. */
export type MediaIndexClientTrace = MediaIndexTrace;
