import {createHash} from 'node:crypto';
import type {IndexDatabase} from '../../sqlite.ts';
import {AdminError} from '../../admin-error.ts';
import {canonicalJson} from '../../../shared/analysis/quality/correspondence.ts';
import type {ReexecutionLineage,ReexecutionRequest,QualityExecutionContract,ReexecutionMetadata} from '../../../shared/analysis/quality/reexecution.ts';

export const executionDigest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export type ReexecutionReceipt={actorId:string;parentId:string;jobId:string;key:string;request:ReexecutionRequest;lineage:ReexecutionLineage};
export type ReexecutionCreation={parentId:string;parentRevision:number;key:string;request:ReexecutionRequest;lineage:ReexecutionLineage;contract:QualityExecutionContract};
/** Stored in the same database and transaction as the new job. One successor
 * per parent makes two windows with different keys conflict rather than fork.
 * A further explicit execution must name the new failed/interrupted job. */
export class ReexecutionLedger{
  private db:IndexDatabase;
  constructor(db:IndexDatabase){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS quality_reexecutions(parent_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,job_id TEXT UNIQUE NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL)');}
  links(actorId:string,limit:number){const rows=this.db.prepare('SELECT parent_id,job_id FROM quality_reexecutions WHERE actor_id=? LIMIT ?').all(actorId,limit+1);if(rows.length>limit)throw new AdminError(503,'Reexecution associations exceed history budget.','task-history-budget');return rows.map(row=>({parentId:String(row.parent_id),jobId:String(row.job_id)}));}
  get(parentId:string,actorId:string){const row=this.db.prepare('SELECT * FROM quality_reexecutions WHERE parent_id=? AND actor_id=?').get(parentId,actorId);if(!row)return null;const receipt=JSON.parse(String(row.body)) as ReexecutionReceipt;if(receipt.parentId!==row.parent_id||receipt.actorId!==row.actor_id||receipt.jobId!==row.job_id||receipt.key!==row.key||receipt.lineage.retryOf!==parentId||receipt.lineage.planDigest!==receipt.request.planDigest||receipt.lineage.reason!==receipt.request.reason)throw new AdminError(500,'Stored reexecution receipt binding changed.','stored-reexecution-invalid');return receipt;}
  verify<T extends ReexecutionMetadata&{id:string}>(receipt:ReexecutionReceipt,job:T){if(job.id!==receipt.jobId||!job.retryOf||executionDigest(job.retryOf)!==executionDigest(receipt.lineage)||!job.executionContract)throw new AdminError(500,'Reexecution receipt points to another execution.','stored-reexecution-invalid');return job;}
  replay(parentId:string,actorId:string,key:string,request:ReexecutionRequest){const prior=this.get(parentId,actorId);if(prior&&(prior.key!==key||executionDigest(prior.request)!==executionDigest(request)))throw new AdminError(409,'An explicit successor already exists. Observe the chain; replay only the original request/key.','reexecution-conflict');return prior;}
  insert(receipt:ReexecutionReceipt){this.db.prepare('INSERT INTO quality_reexecutions VALUES(?,?,?,?,?)').run(receipt.parentId,receipt.actorId,receipt.jobId,receipt.key,JSON.stringify(receipt));}
}
