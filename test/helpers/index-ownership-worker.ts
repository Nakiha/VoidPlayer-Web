import {parentPort,workerData} from 'node:worker_threads';
import {openIndexDatabase} from '../../server/sqlite.ts';
const db=openIndexDatabase(workerData.database);
parentPort!.on('message',()=>parentPort!.postMessage(db.prepare('SELECT count(*) AS n FROM roots').get()));
parentPort!.postMessage('ready');
