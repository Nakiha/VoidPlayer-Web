import {createHmac,randomBytes} from 'node:crypto';
import {AdminError} from '../admin-error.ts';
import type {MediaLibraryIndex} from '../library.ts';
import {TASK_LIMITS,taskMatches,taskPath,taskPending} from '../../shared/service/tasks.ts';
import type {TaskSummary,TaskQuery,TaskPage,TaskKind,TaskDetail,TaskFilter} from '../../shared/service/tasks.ts';
import type {TaskEdge} from './summary.ts';

type Snapshot={id:string;actor:string;filter:TaskFilter;capturedAt:number;expiresAt:number;rows:TaskSummary[];bytes:number};
type Collection={rows:TaskSummary[];edges:TaskEdge[]};
const key=(kind:TaskKind,id:string)=>`${kind}/${id}`;
/** A bounded read model, not a scheduler. Snapshot pages freeze the complete
 * actor-owned metadata read set. Refresh makes a new read set; no polling work
 * or result pixels are retained by this service. */
export class TaskCenterService{
  private snapshots=new Map<string,Snapshot>();
  private secret=randomBytes(32);
  private library:MediaLibraryIndex;
  private now:()=>number;
  constructor(library:MediaLibraryIndex,now=Date.now){this.library=library;this.now=now;}
  private collect(actor:string):Collection{
    if(!this.library.durableQualityJobsEnabled)throw new AdminError(503,'Task history requires persistent storage.','task-storage-unavailable');
    // All owning services commit state on this process event loop. There is no
    // await between these bounded projections. No new compute admission.
    const l=this.library;
    const rows=[...l.discovery.store.taskSummaries(actor),...l.qualityCorrespondence.taskSummaries(actor),...l.qualityJobs.taskSummaries(actor),...l.qualityRanges.taskSummaries(actor),...l.qualityVmaf.taskSummaries(actor),...l.qualityXpsnr.taskSummaries(actor)];
    const index=new Map(rows.map(r=>[key(r.kind,r.id),r]));
    const edges=[...l.qualityRanges.taskEdges(actor),...l.qualityCorrespondence.taskEdges(actor),...l.qualityVmaf.taskEdges(actor),...l.qualityXpsnr.taskEdges(actor)].filter(e=>{
      const from=index.get(key(e.from,e.id)),to=index.get(key(e.to,e.target));
      return !!from&&!!to&&(!e.attemptId||e.attemptId===to.attemptId&&e.digest===to.resultDigest);
    });
    for(const r of rows)if(r.kind==='range'){
      const retained=edges.filter(e=>e.from==='range'&&e.id===r.id&&index.get(key(e.to,e.target))?.result.available).length;
      r.result={...r.result,available:retained>0,retained};if(!retained)r.links=r.links.filter(x=>x.rel!=='result');
    }
    if(rows.length>TASK_LIMITS.rows)throw new AdminError(503,'Task read set exceeds its history budget.','task-history-budget');
    return {rows,edges};
  }
  private expired():never{throw new AdminError(409,'Task cursor expired, changed scope or belongs to another actor. Restart without cursor; keep filters and target.','task-cursor-expired');}
  private token(s:Snapshot,offset:number){const text=`${s.id}.${offset}`;return `${text}.${createHmac('sha256',this.secret).update(text).digest('hex')}`;}
  query(actor:string,query:TaskQuery):TaskPage{
    const now=this.now();for(const [id,s]of this.snapshots)if(s.expiresAt<=now)this.snapshots.delete(id);
    let snapshot:Snapshot,offset=0;
    if(query.cursor){
      const [id,n]=query.cursor.split('.'),s=this.snapshots.get(id);offset=Number(n);
      if(!s||s.actor!==actor||JSON.stringify(s.filter)!==JSON.stringify(query.filter)||!Number.isSafeInteger(offset)||offset<1||offset>=s.rows.length||this.token(s,offset)!==query.cursor)this.expired();snapshot=s;
    }else{
      const rows=this.collect(actor).rows.filter(r=>taskMatches(r,query.filter)).sort((a,b)=>b.createdAt-a.createdAt||(a.kind<b.kind?-1:a.kind>b.kind?1:0)||(a.id<b.id?-1:a.id>b.id?1:0));
      const bytes=Buffer.byteLength(JSON.stringify(rows));if(bytes>TASK_LIMITS.snapshotBytes)throw new AdminError(503,'Task snapshot exceeds metadata budget. Narrow the query.','task-snapshot-budget');
      const own=[...this.snapshots.values()].filter(s=>s.actor===actor);while(own.length>=TASK_LIMITS.actorSnapshots)this.snapshots.delete(own.shift()!.id);
      while(this.snapshots.size>=TASK_LIMITS.snapshots||[...this.snapshots.values()].reduce((a,s)=>a+s.bytes,bytes)>TASK_LIMITS.snapshotBytes)this.snapshots.delete(this.snapshots.keys().next().value!);
      snapshot={id:randomBytes(16).toString('hex'),actor,filter:query.filter,capturedAt:now,expiresAt:now+TASK_LIMITS.snapshotMs,rows,bytes};this.snapshots.set(snapshot.id,snapshot);
    }
    const entries=snapshot.rows.slice(offset,offset+query.limit),next=offset+entries.length;
    return structuredClone({schema:'voidplayer-task-page',version:1,filter:snapshot.filter,capturedAt:snapshot.capturedAt,expiresAt:snapshot.expiresAt,entries,nextCursor:next<snapshot.rows.length?this.token(snapshot,next):null,total:snapshot.rows.length,limits:TASK_LIMITS});
  }
  detail(kind:TaskKind,id:string,actor:string):TaskDetail{
    const {rows,edges}=this.collect(actor),task=rows.find(r=>r.kind===kind&&r.id===id);
    if(!task)throw new AdminError(404,'Task not found for this actor.','task-not-found');
    const related:TaskDetail['related']=[];
    for(const e of edges){
      if(!(e.from===kind&&e.id===id||e.to===kind&&e.target===id))continue;
      // Listing projects only metadata. Detail verifies the original frozen
      // receipt/input association before presenting an actionable link.
      if(e.from==='correspondence'&&this.library.qualityCorrespondence.taskRange(e.id,actor)!==e.target)continue;
      if(e.from==='range'&&!this.library.qualityRanges.taskChild(e.id,e.target,actor))continue;
      if(e.from==='vmaf'||e.from==='xpsnr'){
        const pin=(e.from==='vmaf'?this.library.qualityVmaf:this.library.qualityXpsnr).get(e.id,actor).input.plan,plan=this.library.qualityCorrespondence.get(e.target,actor);
        if(pin.id!==plan.id||pin.attemptId!==plan.attemptId||pin.digest!==plan.resultDigest)continue;
      }
      if(e.from===kind&&e.id===id)related.push({kind:e.to,id:e.target,relation:e.relation,href:taskPath(e.to,e.target)});
      if(e.to===kind&&e.target===id)related.push({kind:e.from,id:e.id,relation:`parent-${e.relation}`,href:taskPath(e.from,e.id)});
    }
    const links=[...task.links];
    if(kind==='correspondence'){
      const plan=this.library.qualityCorrespondence.get(id,actor),relation=this.library.qualityCorrespondence.relation(plan.relation.id,actor);
      if(JSON.stringify(relation)===JSON.stringify(plan.relation))links.push({rel:'reference-relation',href:`/api/quality/reference-relations/${encodeURIComponent(relation.id)}`});
    }
    if(kind==='range'||kind==='vmaf'||kind==='xpsnr')links.push({rel:'candidate-receipt',href:task.links[0].href+'/candidates'});
    if(taskPending(task.state))links.push({rel:'cancel',href:taskPath(kind,id)+'/cancel'});
    return {schema:'voidplayer-task-detail',version:1,task,related,links};
  }
  cancel(kind:TaskKind,id:string,actor:string,requestId:string){
    // Resolve actor ownership before delegating. Original services remain the
    // authority for idempotent cancellation and confirmed physical exit.
    this.detail(kind,id,actor);const l=this.library;
    switch(kind){case 'preparation':l.discovery.cancel(id,actor);break;case 'correspondence':l.qualityCorrespondence.cancel(id,actor);break;case 'single':l.qualityJobs.cancel(id,actor,requestId);break;case 'range':l.qualityRanges.cancel(id,actor);break;case 'vmaf':l.qualityVmaf.cancel(id,actor);break;case 'xpsnr':l.qualityXpsnr.cancel(id,actor);break;}
    return this.detail(kind,id,actor);
  }
  close(){this.snapshots.clear();}
}
