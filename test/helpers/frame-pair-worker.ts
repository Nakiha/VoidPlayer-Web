import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
// Run the production browser Worker entry, with only its message transport adapted.
const scope = globalThis as unknown as { postMessage(data: unknown): void; onmessage: ((event: {data: unknown}) => void) | null };
scope.postMessage = data => parentPort!.postMessage(data);
const fetchNetwork = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  return url.startsWith('file:') ? new Response(await readFile(new URL(url))) : fetchNetwork(input, init);
};
await import('../../src/analysis/quality/pair-worker.ts');
parentPort!.on('message', data => {
  if (workerData?.stall) { parentPort!.postMessage({ started: true }); for (;;) { /* actual uncooperative worker */ } }
  void scope.onmessage?.({ data });
});
