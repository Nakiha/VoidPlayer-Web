import { parentPort, workerData } from 'node:worker_threads';
import { openIndexDatabase } from './sqlite.ts';
import { FrameIndexStore } from './frame-index-store.ts';
import { encodeBase64 } from '../src/ffmpeg-index-cache.ts';
import { AdminError } from './admin-error.ts';
import { buildFfmpegIndexDocument, hasServerIndexCore } from './frame-index-builder.ts';
import type { FfmpegIndexBuildProgress } from './frame-index-builder.ts';
import type { FfmpegIndexBuildBatch, FfmpegIndexStreamMetadata } from './frame-index-builder.ts';
import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

const db = openIndexDatabase(workerData.database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
const store = new FrameIndexStore(db);

parentPort!.on('message', async (request: {
  id: string; version: string; size: number; filePath: string; epoch: number; identity: MediaIndexIdentity; buildId: string;
}) => {
  let started = false;
  try {
    if (store.has(request.id, request.version, request.identity.kind, request.identity)) {
      parentPort!.postMessage({ value: { built: false, epoch: store.epoch } });
      return;
    }
    if (!hasServerIndexCore(workerData.coreDir)) throw new AdminError(503, '服务端 FFmpeg WASM core 不可用。');
    if (store.epoch !== request.epoch) throw new AdminError(409, '索引缓存已被清理，请重新请求。');
    const result = await buildFfmpegIndexDocument(
      request.filePath, request.size, request.version, workerData.coreDir, request.identity,
      (progress: FfmpegIndexBuildProgress) => {
        store.updateBuildProgress(request.id, request.version, request.identity, request.buildId, progress.packets, progress.scannedBytes);
        parentPort!.postMessage({ type: 'progress', data: progress });
      },
      (metadata: FfmpegIndexStreamMetadata) => {
        store.beginBuild(request.id, request.version, request.identity, request.epoch, request.buildId, metadata as unknown as Record<string, unknown>);
        started = true;
        parentPort!.postMessage({ type: 'manifest', data: { buildId: request.buildId } });
      },
      (batch: FfmpegIndexBuildBatch) => {
        store.appendBuildBatch(request.id, request.version, request.identity, request.epoch, request.buildId,
          batch.seq, encodeBase64(batch.records), batch.count, batch.scannedBytes, batch.safePresentationUs);
        // Every notification follows a successful SQLite commit. Subscribers
        // read batches from the database, so a disconnect cannot lose a batch.
        parentPort!.postMessage({ type: 'batch', data: { buildId: request.buildId, seq: batch.seq } });
      },
    );
    store.finishBuild(request.id, request.version, request.identity, request.epoch, request.buildId, result.scannedBytes, result.stablePresentationUs, result.count);
    parentPort!.postMessage({ type: 'complete', data: { buildId: request.buildId } });
    parentPort!.postMessage({ value: { built: true, epoch: request.epoch } });
  } catch (error) {
    if (started) {
      try { store.failBuild(request.id, request.version, request.identity, request.buildId); } catch { /* retain the last durable prefix */ }
    }
    parentPort!.postMessage({
      error: (error as Error).message,
      status: error instanceof AdminError ? error.status : 500,
    });
  } finally {
    db.close();
    parentPort!.close();
  }
});
