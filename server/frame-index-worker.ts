import { parentPort, workerData } from 'node:worker_threads';
import { openIndexDatabase } from './sqlite.ts';
import { MediaIndexQueryStore } from './media-index-query.ts';
import { FrameIndexStore } from './frame-index-store.ts';
import { AdminError } from './admin-error.ts';
import { frameIndexReply } from './frame-index-protocol.ts';
import type { FrameIndexRequest } from './frame-index-protocol.ts';

const db = openIndexDatabase(workerData.database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
const store = new FrameIndexStore(db);
const queries = new MediaIndexQueryStore(db);

parentPort!.on('message', (request: FrameIndexRequest) => {
  try {
    const send = parentPort!.postMessage.bind(parentPort!);
    switch (request.op) {
      case 'cached-indexes':
        send(frameIndexReply(request, queries.inventory(request.id, request.version, request.offset)));
        break;
      case 'semantic-query':
        send(frameIndexReply(request, queries.query(request.id, request.version, request.identity, request.query, request.cursor)));
        break;
      case 'epoch':
        send(frameIndexReply(request, store.epoch));
        break;
      case 'has':
        send(frameIndexReply(request, store.has(request.id, request.version, request.identity.kind, request.identity)));
        break;
      case 'put': {
        let body: { epoch?: unknown; index?: unknown };
        try { body = JSON.parse(new TextDecoder().decode(request.bytes)); }
        catch { throw new AdminError(400, '帧索引 JSON 无效。'); }
        send(frameIndexReply(request, store.put(request.id, request.version, request.size, body?.index, body?.epoch, request.identity)));
        break;
      }
      case 'get': {
        const result = new TextEncoder().encode(store.getJson(request.id, request.version, request.identity.kind, request.identity));
        send(frameIndexReply(request, result), [result.buffer]);
        break;
      }
      case 'stream-manifest':
        send(frameIndexReply(request, store.streamManifest(request.id, request.version, request.identity)));
        break;
      case 'stream-batches':
        send(frameIndexReply(request, store.streamBatches(request.id, request.version, request.identity, request.after, request.limit ?? 16)));
        break;
      default: {
        const exhaustive: never = request;
        void exhaustive;
        throw new Error('Unknown index worker operation');
      }
    }
  } catch (error) {
    parentPort!.postMessage({
      rpcId: request.rpcId,
      error: (error as Error).message,
      status: error instanceof AdminError ? error.status : 500,
      code: error instanceof AdminError ? error.code : undefined,
    });
  }
});
