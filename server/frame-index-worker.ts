import { parentPort, workerData } from 'node:worker_threads';
import { openIndexDatabase } from './sqlite.ts';
import { FrameIndexStore } from './frame-index-store.ts';
import { AdminError } from './admin-error.ts';
import type { MediaIndexIdentity } from '../src/media-index-identity.ts';

const db = openIndexDatabase(workerData.database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
const store = new FrameIndexStore(db);

parentPort!.on('message', (request: {
  rpcId: number; op: string; id?: string; version?: string; size?: number;
  bytes?: Uint8Array; identity?: MediaIndexIdentity; epoch?: number;
}) => {
  try {
    let value: unknown;
    if (request.op === 'epoch') {
      value = store.epoch;
    } else if (request.op === 'has') {
      value = store.has(request.id!, request.version!, request.identity!.kind, request.identity!);
    } else if (request.op === 'put') {
      let body: { epoch?: unknown; index?: unknown };
      try { body = JSON.parse(new TextDecoder().decode(request.bytes!)); }
      catch { throw new AdminError(400, '帧索引 JSON 无效。'); }
      value = store.put(request.id!, request.version!, request.size!, body?.index, body?.epoch, request.identity!);
    } else if (request.op === 'get') {
      const result = new TextEncoder().encode(store.getJson(
        request.id!, request.version!, request.identity!.kind, request.identity!,
      ));
      parentPort!.postMessage({ rpcId: request.rpcId, value: result }, [result.buffer]);
      return;
    } else {
      throw new Error('Unknown index worker operation');
    }
    parentPort!.postMessage({ rpcId: request.rpcId, value });
  } catch (error) {
    parentPort!.postMessage({
      rpcId: request.rpcId,
      error: (error as Error).message,
      status: error instanceof AdminError ? error.status : 500,
    });
  }
});
