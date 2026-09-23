import { parentPort, workerData } from 'node:worker_threads';
import { openIndexDatabase } from './sqlite.ts';
import { FrameIndexStore, prepareFrameIndex } from './frame-index-store.ts';
import { AdminError } from './admin-error.ts';

const db = openIndexDatabase(workerData.database);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
const store = new FrameIndexStore(db);
let prepared: ReturnType<typeof prepareFrameIndex> | undefined;
parentPort!.on('message', (request) => {
  try {
    let value: unknown;
    if (request.op === 'prepare') {
      prepared = undefined;
      let body;
      try { body = JSON.parse(new TextDecoder().decode(request.bytes)); }
      catch { throw new AdminError(400, '帧索引 JSON 无效。'); }
      prepared = prepareFrameIndex(body?.index, request.size);
      value = { epoch: body?.epoch };
    } else if (request.op === 'commit') {
      if (!prepared) throw new AdminError(409, '索引任务已失效。');
      try { value = store.commit(request.id, request.version, prepared, request.epoch); }
      finally { prepared = undefined; }
    } else if (request.op === 'discard') {
      prepared = undefined; value = null;
    } else if (request.op === 'get') {
      const result = new TextEncoder().encode(store.getJson(request.id, request.version));
      parentPort!.postMessage({ value: result }, [result.buffer]); return;
    } else if (request.op === 'close') {
      prepared = undefined; db.close(); parentPort!.postMessage({ value: null }); parentPort!.close(); return;
    } else throw new Error('Unknown index worker operation');
    parentPort!.postMessage({ value });
  } catch (error) {
    parentPort!.postMessage({ error: (error as Error).message, status: error instanceof AdminError ? error.status : 500 });
  }
});
