import { workerData } from 'node:worker_threads';
const gate=new Int32Array(workerData.gate);
Atomics.store(gate,0,1);Atomics.notify(gate,0);
while(Atomics.load(gate,1)===0)Atomics.wait(gate,1,0);
await import('../../server/analysis/quality/worker.ts');
