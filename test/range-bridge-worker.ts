import { parentPort } from 'node:worker_threads';
import { rangeBlobReader } from '../src/range-bridge-reader.ts';
parentPort!.on('message', ({ shared, size, start, end }) => {
  try {
    const adapter = rangeBlobReader(shared, size, request => parentPort!.postMessage(request));
    const bytes = adapter.reader.readAsArrayBuffer(adapter.blob.slice(start, end));
    parentPort!.postMessage({ type: 'result', bytes }, [bytes]);
  } catch (error) { parentPort!.postMessage({ type: 'result', error: String(error) }); }
});
