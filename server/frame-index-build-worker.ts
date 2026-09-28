import { parentPort, workerData } from 'node:worker_threads';
import { openIndexDatabase } from './sqlite.ts';
import { FrameIndexStore, prepareFrameIndex } from './frame-index-store.ts';
import { AdminError } from './admin-error.ts';
import { buildFfmpegIndexDocument, hasServerIndexCore } from './frame-index-builder.ts';
import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

const db = openIndexDatabase(workerData.database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
const store = new FrameIndexStore(db);

parentPort!.on('message', async (request: {
  id: string; version: string; size: number; filePath: string; epoch: number; identity: MediaIndexIdentity;
}) => {
  try {
    if (store.has(request.id, request.version, request.identity.kind, request.identity)) {
      parentPort!.postMessage({ value: { built: false, epoch: store.epoch } });
      return;
    }
    if (!hasServerIndexCore(workerData.coreDir)) throw new AdminError(503, '服务端 FFmpeg WASM core 不可用。');
    if (store.epoch !== request.epoch) throw new AdminError(409, '索引缓存已被清理，请重新请求。');
    const document = await buildFfmpegIndexDocument(
      request.filePath, request.size, request.version, workerData.coreDir, request.identity,
    );
    const prepared = prepareFrameIndex(document, request.size, request.identity);
    store.commit(request.id, request.version, prepared, request.epoch);
    parentPort!.postMessage({ value: { built: true, epoch: request.epoch } });
  } catch (error) {
    parentPort!.postMessage({
      error: (error as Error).message,
      status: error instanceof AdminError ? error.status : 500,
    });
  } finally {
    db.close();
    parentPort!.close();
  }
});
