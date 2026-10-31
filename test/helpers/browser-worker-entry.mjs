import { parentPort, workerData } from 'node:worker_threads';
globalThis.self = globalThis;
let receive;
const pending = [];
Object.defineProperty(globalThis, 'onmessage', {
  get: () => receive,
  set: (listener) => {
    receive = listener;
    if (listener) for (const data of pending.splice(0)) listener({ data });
  },
});
globalThis.postMessage = (value, transfer = []) =>
  parentPort.postMessage(value, Array.isArray(transfer) ? transfer : (transfer.transfer ?? []));
parentPort.on('message', (data) => (receive ? receive({ data }) : pending.push(data)));
await import(workerData.entry);
