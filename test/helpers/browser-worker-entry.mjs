import { parentPort, workerData } from 'node:worker_threads';
let receive;
const pending = [];
Object.defineProperty(globalThis, 'onmessage', {
  get: () => receive,
  set: (listener) => {
    receive = listener;
    if (listener) for (const data of pending.splice(0)) listener({ data });
  },
});
globalThis.postMessage = (value, transfer = []) => parentPort.postMessage(value, transfer);
parentPort.on('message', (data) => (receive ? receive({ data }) : pending.push(data)));
await import(workerData.entry);
