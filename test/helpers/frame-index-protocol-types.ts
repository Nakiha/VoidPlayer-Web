import type { FrameIndexJobs } from '../../server/frame-index-jobs.ts';
import { frameIndexReply } from '../../server/frame-index-protocol.ts';
import type { FrameIndexRequest, FrameIndexBatch } from '../../server/frame-index-protocol.ts';
import { FLV_MEDIA_INDEX_IDENTITY as identity } from '../../shared/media/indexing/media-index-identity.ts';

// Compiled by build and node-frame-index-worker; never executed.
export function frameIndexProtocolTypeChecks(jobs: FrameIndexJobs) {
  const target = { id: 'id', version: 'version', identity };
  const present: Promise<boolean> = jobs.call('has', target);
  const epoch: Promise<number> = jobs.call('epoch');
  const bytes: Promise<Uint8Array> = jobs.call('get', target);
  const batches: Promise<FrameIndexBatch[]> = jobs.call('stream-batches', { ...target, after: -1 });
  void [present, epoch, bytes, batches];
  // @ts-expect-error Unknown operation.
  jobs.call('not-an-operation');
  // @ts-expect-error A target-bearing operation cannot omit data.
  jobs.call('get');
  // @ts-expect-error Missing media version.
  jobs.call('has', { id: 'id', identity });
  // @ts-expect-error Wrong upload payload type.
  jobs.call('put', { ...target, size: 1, bytes: 'data' });
  // @ts-expect-error Batch cursor is required.
  jobs.call('stream-batches', target);
  // @ts-expect-error Epoch takes no business fields.
  jobs.call('epoch', target);
  // @ts-expect-error The caller cannot choose a boolean result for get.
  const wrongResult: Promise<boolean> = jobs.call('get', target);
  void wrongResult;
  const request: FrameIndexRequest<'has'> = { rpcId: 1, op: 'has', ...target };
  frameIndexReply(request, true);
  // @ts-expect-error Response must match the request operation.
  frameIndexReply(request, 1);
  // @ts-expect-error Manifest output cannot be used for get.
  frameIndexReply({ rpcId: 2, op: 'get', ...target }, { epoch: 0, manifest: null });
  // @ts-expect-error Batch fields are statically checked at the responder.
  frameIndexReply({ rpcId: 3, op: 'stream-batches', ...target, after: 0 }, [{ seq: 0, payload: '', bytes: 0 }]);
}
