import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

export type FrameIndexManifest = {
  epoch: number;
  manifest: null | {
    buildId: string; state: string; lastSeq: number; complete: boolean;
    packets: number; scannedBytes: number; stablePresentationUs: number;
    bytes: number; frames: number; metadata: Record<string, unknown> | null;
  };
};
export type FrameIndexBatch = { seq: number; payload: string; bytes: number; frames: number };

type Target = { id: string; version: string; identity: MediaIndexIdentity };
type Command<Request, Response> = { request: Request; response: Response };
export interface FrameIndexCommands {
  epoch: Command<Record<string, never>, number>;
  has: Command<Target, boolean>;
  get: Command<Target, Uint8Array>;
  put: Command<Target & { size: number; bytes: Uint8Array }, { ok: boolean }>;
  'stream-manifest': Command<Target, FrameIndexManifest>;
  'stream-batches': Command<Target & { after: number; limit?: number }, FrameIndexBatch[]>;
}
export type FrameIndexOperation = keyof FrameIndexCommands;
export type FrameIndexResult<K extends FrameIndexOperation> = FrameIndexCommands[K]['response'];
export type FrameIndexRequest<K extends FrameIndexOperation = FrameIndexOperation> = {
  [P in K]: { rpcId: number; op: P } & (P extends 'epoch' ? object : FrameIndexCommands[P]['request']);
}[K];
export type FrameIndexCallArgs<K extends FrameIndexOperation> = K extends 'epoch'
  ? [data?: FrameIndexCommands[K]['request'], transfer?: ArrayBuffer[], timeoutMs?: number]
  : [data: FrameIndexCommands[K]['request'], transfer?: ArrayBuffer[], timeoutMs?: number];
export type FrameIndexResponse = { rpcId: number; value?: unknown; error?: string; status?: number };

/** Request-bound compile-time checking, with the unchanged database Worker wire layout. */
export function frameIndexReply<K extends FrameIndexOperation>(request: FrameIndexRequest<K>, value: NoInfer<FrameIndexResult<K>>) {
  return { rpcId: request.rpcId, value };
}
