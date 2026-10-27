import {createHash} from 'node:crypto';
import type {IndexDatabase} from '../../sqlite.ts';
import {AdminError} from '../../admin-error.ts';
import {canonicalJson} from '../../../shared/analysis/quality/correspondence.ts';
import type {ReexecutionLineage,ReexecutionRequest,QualityExecutionContract} from '../../../shared/analysis/quality/reexecution.ts';

export const executionDigest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export type ReexecutionReceipt={actorId:string;parentId:string;jobId:string;key:string;request:ReexecutionRequest;lineage:ReexecutionLineage};
export type ReexecutionCreation={parentId:string;parentRevision:number;key:string;request:ReexecutionRequest;lineage:ReexecutionLineage;contract:QualityExecutionContract};
/** Stored in the same database and transaction as the new job. One successor
 * per parent makes two windows with different keys conflict rather than fork.
 * A further explicit execution must name the new failed/interrupted job. */
export class ReexecutionLedger{
  private db:IndexDatabase;
  constructor(db:IndexDatabase){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS quality_reexecutions(parent_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,job_id TEXT UNIQUE NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL)');}
  get(parentId:string,actorId:string){const row=this.db.prepare('SELECT body FROM quality_reexecutions WHERE parent_id=? AND actor_id=?').get(parentId,actorId);return row?JSON.parse(String(row.body)) as ReexecutionReceipt:null;}
  replay(parentId:string,actorId:string,key:string,request:ReexecutionRequest){const prior=this.get(parentId,actorId);if(prior&&(prior.key!==key||executionDigest(prior.request)!==executionDigest(request)))throw new AdminError(409,'An explicit successor already exists. Observe the chain; replay only the original request/key.','reexecution-conflict');return prior;}
  insert(receipt:ReexecutionReceipt){this.db.prepare('INSERT INTO quality_reexecutions VALUES(?,?,?,?,?)').run(receipt.parentId,receipt.actorId,receipt.jobId,receipt.key,JSON.stringify(receipt));}
}
