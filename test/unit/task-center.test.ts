import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openIndexDatabase} from '../../server/sqlite.ts';
import {taskSummaries,taskEdges,rangeTaskChildren,retainedTaskResults} from '../../server/tasks/summary.ts';
import type {TaskCommands} from '../../server/quality-service-ports.ts';
import {TaskCenterService} from '../../server/tasks/service.ts';
import {taskQuery,TASK_KINDS,TASK_HISTORY_ROWS,TASK_LIMITS} from '../../shared/service/tasks.ts';
import type {TaskKind,TaskFilter} from '../../shared/service/tasks.ts';
import type {MediaLibraryIndex} from '../../server/library.ts';

function fixture(){
 const db=openIndexDatabase(':memory:');
 for(const table of ['discovery_jobs','quality_jobs','quality_ranges','quality_correspondence_plans','quality_vmaf_jobs','quality_xpsnr_jobs','cambi_jobs'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,actor TEXT,actor_id TEXT,revision INTEGER,state TEXT,phase TEXT,created_at INTEGER,started_at INTEGER,ended_at INTEGER,reason_json TEXT,request_id TEXT,client_id TEXT,input_json TEXT,body TEXT,result TEXT,result_json TEXT,result_sha TEXT,snapshot TEXT,attempt_id TEXT)`);
 db.exec('CREATE TABLE quality_plan_executions(plan_id TEXT,body TEXT)');
 const source={mediaId:'a'.repeat(24),mediaVersion:'b'.repeat(24)},other={mediaId:'c'.repeat(24),mediaVersion:'d'.repeat(24)};
 const insert=(kind:TaskKind,actor='actor-A',options:any={})=>{
  const id=options.id??(kind==='vmaf'||kind==='xpsnr'||kind==='cambi'?kind+'-':'')+randomUUID(),state=options.state??'completed',createdAt=options.createdAt??100,attempt=options.attemptId??randomUUID(),digest=options.digest??'e'.repeat(64);
  const reference={...source,...options.source},distorted={...other,...options.distorted},pair={reference,distorted,ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'}};
  const input={client:{id:'test-client'},request:pair,source:{id:reference.mediaId,version:reference.mediaVersion},operation:'quality-index'};
  const body={id,actor:{id:actor},revision:1,state,phase:'native',createdAt,startedAt:createdAt,endedAt:state==='completed'?createdAt+10:null,requestId:'request',input:{...input,...(kind==='cambi'?{source:reference}:{}),metrics:{ssim:true},plan:options.plan??{}},reason:options.reason??null,attemptId:attempt,resultDigest:digest,progress:{preparedFrames:8,targetFrames:8},metrics:{psnr:{state:'completed'},ssim:{state:'completed'},vmaf:{state}},relation:{input:{reference,distorted}},plan:{input:{client:input.client,pairs:[pair]},targets:1},summary:{scoredPairs:1},samples:options.samples??[]};
  const table={preparation:'discovery_jobs',single:'quality_jobs',range:'quality_ranges',correspondence:'quality_correspondence_plans',vmaf:'quality_vmaf_jobs',xpsnr:'quality_xpsnr_jobs',cambi:'cambi_jobs'}[kind];
  db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,actor,actor,1,state,'decode',createdAt,createdAt,state==='completed'?createdAt+10:null,JSON.stringify(options.reason??null),'request','test-client',JSON.stringify(input),JSON.stringify(body),options.result??'not-JSON-result-that-must-not-be-parsed',options.result??'not-JSON-result-that-must-not-be-parsed',digest,JSON.stringify({value:{sources:{reference:{binding:reference},distorted:{binding:distorted}}}}),attempt);
  return {id,attemptId:attempt,digest};
 };
 const owner=(kind:TaskKind)=>({taskSummaries:(actor:string,id?:string,filter?:TaskFilter)=>taskSummaries(db,kind,actor,id,filter),taskEdges:(actor:string,id?:string)=>taskEdges(db,kind as 'range'|'correspondence'|'vmaf',actor,id),cancel:()=>{throw Error('Cancellation callback not installed');}});
 const services={preparation:owner('preparation'),correspondence:owner('correspondence'),single:owner('single'),range:owner('range'),vmaf:owner('vmaf'),xpsnr:owner('xpsnr'),cambi:owner('cambi')};
 Object.assign(services.range,{taskChildEdges:(actor:string,ids:string[])=>rangeTaskChildren(db,actor,ids)});Object.assign(services.single,{taskRetainedResults:(actor:string,ids:string[])=>retainedTaskResults(db,actor,ids)});
 Object.assign(services.range,{taskChild:()=>true});Object.assign(services.correspondence,{taskRange:(id:string)=>JSON.parse(String(db.prepare('SELECT body FROM quality_plan_executions WHERE plan_id=?').get(id)?.body??'null'))?.rangeId??null,get:(id:string)=>JSON.parse(String(db.prepare('SELECT body FROM quality_correspondence_plans WHERE id=?').get(id)!.body))});Object.assign(services.vmaf,{get:(id:string)=>JSON.parse(String(db.prepare('SELECT body FROM quality_vmaf_jobs WHERE id=?').get(id)!.body))});
 const retries=new Map<string,{parentId:string;jobId:string}[]>();
 const qualityReexecutions={links:(kind:string,actor:string)=>retries.get(kind+'/'+actor)??[],chain:(kind:string,id:string,actor:string)=>({retryOf:retries.get(kind+'/'+actor)?.find(r=>r.jobId===id)?{retryOf:retries.get(kind+'/'+actor)!.find(r=>r.jobId===id)!.parentId}:null,successor:retries.get(kind+'/'+actor)?.find(r=>r.parentId===id)?{id:retries.get(kind+'/'+actor)!.find(r=>r.parentId===id)!.jobId}:null})};
 const library={qualityReexecutions,durableQualityJobsEnabled:true,discovery:{store:services.preparation,cancel:services.preparation.cancel},qualityCorrespondence:services.correspondence,qualityJobs:services.single,qualityRanges:services.range,qualityVmaf:services.vmaf,qualityXpsnr:services.xpsnr,qualityCambi:services.cambi} as unknown as MediaLibraryIndex;
 const commands={preparation:services.preparation.cancel,correspondence:services.correspondence.cancel,single:services.single.cancel,range:services.range.cancel,vmaf:services.vmaf.cancel,xpsnr:services.xpsnr.cancel,cambi:services.cambi.cancel};
 let clock=1000;const center=new TaskCenterService(library,commands,()=>clock);
 return {db,insert,center,library,commands,retries,source,other,clock:(value:number)=>{clock=value;},close:()=>{center.close();db.close();}};
}
const query=(s='')=>taskQuery(new URLSearchParams(s));

test('large range snapshots use bounded indexed metadata batches, never one full relation scan per row',t=>{
 const f=fixture();t.after(f.close);const count=1000;
 f.db.exec('BEGIN');for(let i=0;i<count;i++){const child=f.insert('single');f.insert('range','actor-A',{createdAt:i,samples:[{jobId:child.id,result:{attemptId:child.attemptId,digest:child.digest}}]});}f.db.exec('COMMIT');
 const queries:string[]=[],prepare=f.db.prepare.bind(f.db);t.mock.method(f.db,'prepare',(sql:string)=>{queries.push(sql);return prepare(sql);});
 const page=f.center.query('actor-A',query('kind=range&limit=50'));assert.equal(page.total,count);assert.equal(page.entries.length,50);assert.ok(page.entries.every(row=>row.result.retained===1));
 assert.ok(queries.length<=7+2*Math.ceil(count/8),`metadata query count ${queries.length} must follow bounded batches, not range/child count`);
 const cursorQueries=queries.length;f.center.query('actor-A',query(`kind=range&limit=50&cursor=${page.nextCursor}`));assert.equal(queries.length,cursorQueries,'frozen pages do not re-read live relations');
 for(const sql of queries.filter(sql=>sql.includes('json_each(?)'))){const plan=prepare('EXPLAIN QUERY PLAN '+sql).all('[]','actor-A',8193) as {detail:string}[];assert.ok(plan.some(row=>/SEARCH [pq] USING INDEX/.test(row.detail)),JSON.stringify(plan));}
});
test('retention batches cover full admitted 1024-sample ranges without the ordinary summary row cap or result parsing',t=>{
 const f=fixture();t.after(f.close);const parents=[];
 f.db.exec('BEGIN');for(let parent=0;parent<8;parent++){const samples=[];for(let i=0;i<1024;i++){const child=f.insert('single');samples.push({jobId:child.id,result:{attemptId:child.attemptId,digest:child.digest}});}parents.push(f.insert('range','actor-A',{samples}));}f.db.exec('COMMIT');
 const page=f.center.query('actor-A',query('kind=range'));assert.equal(page.total,8);assert.ok(page.entries.every(row=>row.result.retained===1024));
 const child=f.insert('single'),foreign=f.insert('single','actor-B'),released=f.insert('single');f.db.prepare('UPDATE quality_jobs SET result_json=NULL WHERE id=?').run(released.id);
 const parent=f.insert('range','actor-A',{samples:[{jobId:child.id,result:{attemptId:child.attemptId,digest:child.digest}},{jobId:child.id,result:{attemptId:'wrong',digest:child.digest}},{jobId:child.id,result:{attemptId:child.attemptId,digest:'wrong'}},{jobId:foreign.id},{jobId:released.id},{jobId:randomUUID()}]});
 const fresh=f.center.query('actor-A',query('kind=range'));assert.equal(fresh.entries.find(row=>row.id===parent.id)!.result.retained,1);assert.equal(page.entries[0].result.retained,1024,'prior snapshot remains immutable');
});

test('strict shared query: same-side version, exact enums, half-open time and no duplicate/unknown fields',()=>{
 for(const s of ['limit=0','limit=51','kind=nr','state=stopping','createdFrom=-1','createdFrom=1.5','createdFrom=2&createdTo=2','foo=x','kind=single&kind=range','mediaVersion='+ 'a'.repeat(24),'cursor=guess'])assert.throws(()=>query(s),s);
 assert.deepEqual(query('kind=vmaf&state=partial&metric=ssim&createdFrom=0&createdTo=9&limit=1'),{filter:{kind:'vmaf',metric:'ssim',state:'partial',createdFrom:0,createdTo:9},limit:1});
});

test('exhaustive cross-store projections find old matching jobs beyond all legacy first pages',t=>{
 const f=fixture();t.after(f.close);
 for(let n=0;n<130;n++)f.insert('single','actor-A',{createdAt:n+1000,source:{mediaId:'f'.repeat(24)}});
 const expected=TASK_KINDS.map(kind=>f.insert(kind,'actor-A',{createdAt:20}));
 for(const kind of TASK_KINDS)f.insert(kind,'actor-B');
 const page=f.center.query('actor-A',query(`mediaId=${f.source.mediaId}&mediaVersion=${f.source.mediaVersion}`));
 assert.equal(page.total,TASK_KINDS.length);assert.deepEqual(new Set(page.entries.map(x=>x.id)),new Set(expected.map(x=>x.id)));assert.deepEqual(new Set(page.entries.map(x=>x.kind)),new Set(TASK_KINDS));
 assert.equal(f.center.query('actor-A',query(`mediaId=${f.source.mediaId}&mediaVersion=${f.other.mediaVersion}`)).total,0,'version cannot match the opposite side');
 assert.equal(f.center.query('actor-A',query('createdFrom=20&createdTo=21')).total,TASK_KINDS.length);
 assert.equal(f.center.query('actor-A',query('createdFrom=0&createdTo=20')).total,0,'exclusive end');
 const single=f.center.query('actor-A',query('kind=single&metric=ssim')).entries[0];assert.equal(single.phase,'decode');assert.equal(single.result.available,true);assert.ok(!JSON.stringify(page).includes('not-JSON-result'),'no result parsing or result blob copying');
 assert.ok(!JSON.stringify(page).includes('actor-B'));
});

test('frozen pagination survives new tasks/state mutations and immutable tie order; refresh sees new facts',t=>{
 const f=fixture();t.after(f.close);for(const k of TASK_KINDS)f.insert(k,'actor-A',{state:'running'});
 const first=f.center.query('actor-A',query('limit=2'));assert.equal(first.total,TASK_KINDS.length);assert.ok(first.nextCursor);
 f.db.exec("UPDATE quality_jobs SET state='failed'");f.insert('single','actor-A',{createdAt:999});
 const second=f.center.query('actor-A',query(`limit=2&cursor=${first.nextCursor}`));const third=f.center.query('actor-A',query(`limit=2&cursor=${second.nextCursor}`));
 const fourth=f.center.query('actor-A',query(`limit=2&cursor=${third.nextCursor}`));const rows=[...first.entries,...second.entries,...third.entries,...fourth.entries];assert.equal(new Set(rows.map(r=>r.id)).size,TASK_KINDS.length);assert.ok(rows.every(r=>r.state==='running'));assert.equal(fourth.nextCursor,null);assert.equal(second.capturedAt,first.capturedAt);
 assert.deepEqual(rows.map(r=>r.kind),[...TASK_KINDS].sort());const fresh=f.center.query('actor-A',query());assert.equal(fresh.total,TASK_KINDS.length+1);assert.ok(fresh.entries.some(r=>r.state==='failed'));
});

test('cursor is scoped, signed, bounded, expiring, restart-invalid and recoverable without deleting jobs',t=>{
 const f=fixture();t.after(f.close);for(let n=0;n<4;n++)f.insert('single');
 const a=f.center.query('actor-A',query('limit=1')),cursor=a.nextCursor!;
 for(const [actor,s]of [['actor-B',`cursor=${cursor}`],['actor-A',`cursor=${cursor}&metric=psnr`],['actor-A',`cursor=${cursor.slice(0,-1)}${cursor.at(-1)==='0'?'1':'0'}`]])assert.throws(()=>f.center.query(actor,query(s)),(e:any)=>e.code==='task-cursor-expired');
 const restarted=new TaskCenterService(f.library,f.commands);assert.throws(()=>restarted.query('actor-A',query(`cursor=${cursor}`)),(e:any)=>e.code==='task-cursor-expired');restarted.close();
 f.clock(1000+TASK_LIMITS.snapshotMs);assert.throws(()=>f.center.query('actor-A',query(`cursor=${cursor}`)),(e:any)=>e.code==='task-cursor-expired');
 assert.equal(f.center.query('actor-A',query()).total,4);
 const old=f.center.query('actor-A',query('limit=1'));f.center.query('actor-A',query('limit=1'));f.center.query('actor-A',query('limit=1'));
 assert.throws(()=>f.center.query('actor-A',query(`cursor=${old.nextCursor}`)),(e:any)=>e.code==='task-cursor-expired');
 const global=f.center.query('actor-A',query('limit=1'));for(let n=0;n<TASK_LIMITS.snapshots;n++)f.center.query('bounded-actor-'+n,query());assert.throws(()=>f.center.query('actor-A',query(`cursor=${global.nextCursor}`)),(e:any)=>e.code==='task-cursor-expired');
});

test('detail traces only same-actor pinned relationships and distinguishes retained range results',t=>{
 const f=fixture();t.after(f.close);const child=f.insert('single'),foreign=f.insert('single','actor-B');
 const parent=f.insert('range','actor-A',{samples:[{jobId:child.id,result:{attemptId:child.attemptId,digest:child.digest}},{jobId:foreign.id}]});
 const plan=f.insert('correspondence'),native=f.insert('vmaf','actor-A',{plan:{id:plan.id,attemptId:plan.attemptId,digest:plan.digest}});
 f.db.prepare('INSERT INTO quality_plan_executions VALUES(?,?)').run(plan.id,JSON.stringify({rangeId:parent.id}));
 const detail=f.center.detail('range',parent.id,'actor-A');assert.equal(detail.task.result.retained,1);assert.equal(detail.task.result.available,true);assert.equal(detail.related.length,2);assert.ok(detail.related.every(r=>r.id!==foreign.id));
 assert.equal(f.center.detail('vmaf',native.id,'actor-A').related[0].id,plan.id);
 f.db.prepare("UPDATE quality_correspondence_plans SET body=json_set(body,'$.resultDigest',?) WHERE id=?").run('f'.repeat(64),plan.id);
 assert.equal(f.center.detail('vmaf',native.id,'actor-A').related.length,0,'changed plan pin cannot be linked');
 f.db.prepare('UPDATE quality_jobs SET result_json=NULL WHERE id=?').run(child.id);
 const collected=f.center.detail('range',parent.id,'actor-A');assert.equal(collected.task.result.retained,0);assert.equal(collected.task.progress.scored,1);assert.equal(collected.task.result.available,false);assert.ok(!collected.task.links.some(l=>l.rel==='result'));
 assert.throws(()=>f.center.detail('range',parent.id,'actor-B'),(e:any)=>e.status===404);
});

test('hard history excess fails closed, never returns a silently incomplete first window',t=>{
 const temporary=new TaskCenterService({durableQualityJobsEnabled:false}as MediaLibraryIndex,{} as TaskCommands);assert.throws(()=>temporary.query('actor-A',query()),(e:any)=>e.code==='task-storage-unavailable');temporary.close();
 const f=fixture();t.after(f.close);for(let n=0;n<=TASK_LIMITS.rows;n++)f.insert('vmaf','actor-A',{createdAt:n+100});assert.throws(()=>f.center.query('actor-A',query()),(e:any)=>e.code==='task-snapshot-budget');
 assert.equal(f.center.query('actor-A',query('createdFrom=100&createdTo=101')).total,1,'SQL filters reach oldest history beyond the snapshot budget');
});


test('reexecution edges are bidirectional, actor-scoped and never count a successor as a retained range sample',t=>{
 const f=fixture();t.after(f.close);
 for(const kind of ['single','range','vmaf','xpsnr'] as const){
  const original=f.insert(kind,'actor-A',{state:'failed',samples:[]}),next=f.insert(kind),foreign=f.insert(kind,'actor-B');
  f.retries.set(kind+'/actor-A',[{parentId:original.id,jobId:next.id},{parentId:original.id,jobId:foreign.id}]);
  const parent=f.center.detail(kind,original.id,'actor-A'),child=f.center.detail(kind,next.id,'actor-A');
  assert.deepEqual(parent.related.filter(r=>r.relation==='reexecution').map(r=>r.id),[next.id]);
  assert.deepEqual(child.related.filter(r=>r.relation==='parent-reexecution').map(r=>r.id),[original.id]);
  assert.ok(parent.links.some(l=>l.rel==='reexecution-plan'));assert.ok(parent.links.some(l=>l.rel==='reexecution-chain'));
  if(kind==='range')assert.equal(parent.task.result.retained,0,'successor is a new computation, not an old scored child');
  assert.throws(()=>f.center.detail(kind,original.id,'actor-B'),{status:404});
 }
});
