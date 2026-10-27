import {taskSummaries} from '../tasks/summary.ts';
import {createHash,randomUUID} from 'node:crypto';
import {DiscoveryCatalog} from './catalog.ts';
import { openIndexDatabase } from '../sqlite.ts';
import { AdminError } from '../admin-error.ts';
import type { Actor } from '../identity.ts';
import { DISCOVERY_LIMITS as LIMITS, preparationInput } from '../../shared/media/discovery.ts';
import type { DiscoverySource,PreparationJob, PreparationState } from '../../shared/media/discovery.ts';
import type { ProbeValue } from './probe-runner.ts';

const pending="('queued','running','cancelling')";
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Same library database: source revision, prepared metadata and job receipts
 * commit atomically. The library owner's existing OS lock excludes other live
 * instances. No new global schema user_version or cache mutation is introduced. */
export class DiscoveryStore extends DiscoveryCatalog {
  taskSummaries(actor:string){return taskSummaries(this.db,'preparation',actor);}

  constructor(file:string,now=Date.now()){
    super(openIndexDatabase(file));
    try{
    this.db.exec('PRAGMA busy_timeout=1000;');
    const existing=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_meta'").get();
    if(existing&&Number(this.db.prepare('SELECT version FROM discovery_meta WHERE id=1').get()?.version)!==1)
      throw new AdminError(503,'Discovery metadata requires a newer application.','discovery-schema-unsupported');
    this.db.exec(`CREATE TABLE IF NOT EXISTS discovery_meta(id INTEGER PRIMARY KEY,version INTEGER NOT NULL,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO discovery_meta VALUES(1,1,0);
      CREATE TABLE IF NOT EXISTS discovery_probes(media_id TEXT NOT NULL,media_version TEXT NOT NULL,probe_json TEXT NOT NULL,probe_digest TEXT NOT NULL,witness_json TEXT NOT NULL,prepared_at INTEGER NOT NULL,PRIMARY KEY(media_id,media_version));
      CREATE TABLE IF NOT EXISTS discovery_jobs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL,actor_id TEXT NOT NULL,client_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,
        input_json TEXT NOT NULL,request_id TEXT NOT NULL,created_at INTEGER NOT NULL,queue_until INTEGER NOT NULL,
        started_at INTEGER,ended_at INTEGER,attempt_id TEXT,reason_json TEXT,result_json TEXT,reserved_bytes INTEGER NOT NULL,
        UNIQUE(actor_id,client_id,idempotency_key));`);
    this.transaction(()=>this.db.prepare(`UPDATE discovery_jobs SET state='interrupted',revision=revision+1,ended_at=?,reason_json=? WHERE state IN ${pending}`)
      .run(now,JSON.stringify({code:'service-restarted',message:'Previous preparation did not commit a terminal state; no automatic retry.'})));
    }catch(error){this.db.close();throw error;}
  }
  transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=action();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private sourcePin(source:DiscoverySource){const row=this.db.prepare('SELECT m.version,m.state FROM media m JOIN roots r ON r.id=m.root_id WHERE m.id=? AND r.active=1').get(source.id);
    if(!row||row.state==='missing')throw new AdminError(404,'Media is not in the active library.','media-not-found');
    if(row.version!==source.version)throw new AdminError(409,'Media version changed; browse again.','media-version-changed');return row;}
  get(id:string,actor?:string):PreparationJob{
    const r=this.db.prepare('SELECT * FROM discovery_jobs WHERE id=?').get(id);if(!r||actor!==undefined&&r.actor_id!==actor)throw new AdminError(404,'Preparation not found.','preparation-not-found');
    return {schema:'voidplayer-library-preparation',version:1,id:String(r.id),revision:Number(r.revision),state:r.state as PreparationState,input:JSON.parse(String(r.input_json)),
      submitted:{actorId:String(r.actor_id),clientId:String(r.client_id),requestId:String(r.request_id),idempotencyKey:String(r.idempotency_key)},
      createdAt:Number(r.created_at),queueUntil:Number(r.queue_until),startedAt:r.started_at===null?null:Number(r.started_at),endedAt:r.ended_at===null?null:Number(r.ended_at),attemptId:r.attempt_id===null?null:String(r.attempt_id),
      reason:r.reason_json?JSON.parse(String(r.reason_json)):null,result:r.result_json?JSON.parse(String(r.result_json)):null};
  }
  list(actor:string,before=0,limit=32){if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(limit)||limit<1||limit>32)throw new AdminError(400,'Invalid preparation page.','invalid-preparation-page');
    const rows=this.db.prepare(`SELECT ordinal,id FROM discovery_jobs WHERE actor_id=? ${before?'AND ordinal<?':''} ORDER BY ordinal DESC LIMIT ?`).all(actor,...(before?[before]:[]),limit+1);
    return {schema:'voidplayer-library-preparations',version:1,jobs:rows.slice(0,limit).map(r=>{const job=this.get(String(r.id),actor);return {...job,result:job.result===null?null:{available:true,url:`/api/library/preparations/${job.id}`}};}),next:rows.length>limit?Number(rows[limit-1].ordinal):null};}
  submit(value:unknown,actor:Actor,requestId:string,key:unknown,now:number){
    let input;try{input=preparationInput(value);}catch{throw new AdminError(400,'Invalid version-pinned preparation request.','invalid-preparation-request');}
    if(typeof key!=='string'||!/^[a-zA-Z0-9._:-]{1,120}$/.test(key))throw new AdminError(400,'Idempotency-Key required.','invalid-idempotency-key');
    const json=JSON.stringify(input),fingerprint=digest(json);
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT id,fingerprint FROM discovery_jobs WHERE actor_id=? AND client_id=? AND idempotency_key=?').get(actor.id,input.client.id,key);
      if(prior){if(prior.fingerprint!==fingerprint)throw new AdminError(409,'Idempotency-Key binds another preparation.','idempotency-conflict');return {job:this.get(String(prior.id)),replayed:true};}
      this.sourcePin(input.source);
      const all=this.db.prepare('SELECT count(*) AS n,coalesce(sum(reserved_bytes),0) AS bytes FROM discovery_jobs').get()!;
      if(Number(all.n)>=LIMITS.historyRows||Number(all.bytes)+LIMITS.probeResultBytes+Buffer.byteLength(json)>LIMITS.historyBytes)throw new AdminError(429,'Preparation history is full; receipts retained.','preparation-history-full');
      if(Number(this.db.prepare("SELECT count(*) AS n FROM discovery_jobs WHERE state='queued'").get()!.n)>=LIMITS.queued)throw new AdminError(429,'Preparation queue is full.','preparation-queue-full');
      if(Number(this.db.prepare(`SELECT count(*) AS n FROM discovery_jobs WHERE actor_id=? AND state IN ${pending}`).get(actor.id)!.n)>=LIMITS.actorOutstanding)throw new AdminError(429,'Actor preparation budget is full.','preparation-actor-limit');
      const id=randomUUID();this.db.prepare(`INSERT INTO discovery_jobs(id,state,actor_id,client_id,idempotency_key,fingerprint,input_json,request_id,created_at,queue_until,reserved_bytes) VALUES(?,'queued',?,?,?,?,?,?,?,?,?)`)
        .run(id,actor.id,input.client.id,key,fingerprint,json,requestId,now,now+LIMITS.queueWaitMs,LIMITS.probeResultBytes+Buffer.byteLength(json));return {job:this.get(id),replayed:false};
    });
  }
  queued(){const row=this.db.prepare("SELECT id FROM discovery_jobs WHERE state='queued' ORDER BY ordinal LIMIT 1").get();return row?this.get(String(row.id)):null;}
  start(id:string,now:number){return this.transaction(()=>{const job=this.get(id);if(job.state!=='queued')throw new AdminError(409,'Preparation no longer queued.','preparation-not-queued');
    if(now>=job.queueUntil)throw new AdminError(409,'Preparation waiting budget expired before admission.','queue-expired');const attempt=randomUUID();
    this.db.prepare("UPDATE discovery_jobs SET state='running',revision=revision+1,started_at=?,attempt_id=? WHERE id=?").run(now,attempt,id);return attempt;});}
  cancel(id:string,actor:string,now:number){return this.transaction(()=>{const job=this.get(id,actor);if(!['queued','running','cancelling'].includes(job.state))return job;
    this.db.prepare('UPDATE discovery_jobs SET state=?,revision=revision+1,ended_at=?,reason_json=? WHERE id=?').run(job.state==='queued'?'cancelled':'cancelling',job.state==='queued'?now:null,
      JSON.stringify({code:'cancel-requested',message:'Explicit cancellation; running capacity remains owned until physical exit.'}),id);return this.get(id,actor);});}
  finish(id:string,state:'completed'|'failed'|'interrupted',now:number,reason:{code:string;message:string}|null,value?:unknown,probe?:ProbeValue){
    this.transaction(()=>{const job=this.get(id);if(!['queued','running','cancelling'].includes(job.state))return;
      const final=job.state==='cancelling'?'cancelled':state;
      if(final==='completed'){
        if(this.sourcePin(job.input.source).state!=='ready')throw new AdminError(409,'Library source is no longer ready.','source-changed');
        if(probe){const json=JSON.stringify(probe.probe);if(Buffer.byteLength(json)>LIMITS.probeResultBytes)throw new AdminError(413,'Probe evidence exceeds budget.','probe-budget-exceeded');
          const bytes=Number(this.db.prepare('SELECT coalesce(sum(octet_length(probe_json)),0) AS bytes FROM discovery_probes WHERE media_id!=?').get(job.input.source.id)!.bytes);
          if(bytes+Buffer.byteLength(json)>LIMITS.historyBytes)throw new AdminError(429,'Prepared metadata budget is full.','probe-history-full');
          this.db.prepare('DELETE FROM discovery_probes WHERE media_id=?').run(job.input.source.id);
          this.db.prepare('INSERT INTO discovery_probes VALUES(?,?,?,?,?,?)').run(job.input.source.id,job.input.source.version,json,digest(json),JSON.stringify(probe.witness),now);
          this.db.exec('UPDATE discovery_meta SET revision=revision+1 WHERE id=1');
        }
      }
      const result=final==='completed'?JSON.stringify(value??null):null;
      if(result&&Buffer.byteLength(result)>LIMITS.probeResultBytes)throw new AdminError(413,'Preparation result exceeds budget.','probe-budget-exceeded');
      this.db.prepare('UPDATE discovery_jobs SET state=?,revision=revision+1,ended_at=?,reason_json=?,result_json=? WHERE id=?')
        .run(final,now,final==='cancelled'?JSON.stringify({code:'cancelled',message:'Execution physically stopped; a racing index commit may remain valid.'}):reason?JSON.stringify(reason):null,result,id);
    });
  }
  expire(now:number){this.db.prepare("UPDATE discovery_jobs SET state='failed',revision=revision+1,ended_at=?,reason_json=? WHERE state='queued' AND queue_until<=?")
    .run(now,JSON.stringify({code:'queue-expired',message:'Preparation did not start within its waiting budget.'}),now);}
  unfinished(){return this.db.prepare(`SELECT id FROM discovery_jobs WHERE state IN ${pending}`).all().map(r=>this.get(String(r.id)));}
  close(){this.db.close();}
}
