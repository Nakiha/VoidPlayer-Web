import { workerData } from 'node:worker_threads';
const ready=new Int32Array(workerData.ready);
Atomics.store(ready,0,1);Atomics.notify(ready,0);
const wait=new Int32Array(new SharedArrayBuffer(4));
for(;;)Atomics.wait(wait,0,0); // Actual non-cooperative worker; host must terminate it.
