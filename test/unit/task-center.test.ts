import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openIndexDatabase} from '../../server/sqlite.ts';
import {taskSummaries,taskEdges} from '../../server/tasks/summary.ts';
import {TaskCenterService} from '../../server/tasks/service.ts';
import {taskQuery,TASK_KINDS,TASK_HISTORY_ROWS,TASK_LIMITS} from '../../shared/service/tasks.ts';
import type {TaskKind} from '../../shared/service/tasks.ts';
import type {MediaLibraryIndex} from '../../server/library.ts';

function fixture(){
 const db=openIndexDatabase(':memory:');
 for(const table of ['discovery_jobs','quality_jobs','quality_ranges','quality_correspondence_plans','quality_vmaf_jobs'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,actor TEXT,actor_id TEXT,revision INTEGER,state TEXT,phase TEXT,created_at INTEGER,started_at INTEGER,ended_at INTEGER,reason_json TEXT,request_id TEXT,client_id TEXT,input_json TEXT,body TEXT,result TEXT,result_json TEXT,result_sha TEXT,snapshot TEXT,attempt_id TEXT)`);
 db.exec('CREATE TABLE quality_plan_executions(plan_id TEXT,body TEXT)');
 const source={mediaId:'a'.repeat(24),mediaVersion:'b'.repeat(24)},other={mediaId:'c'.repeat(24),mediaVersion:'d'.repeat(24)};
 const insert=(kind:TaskKind,actor='actor-A',options:any={})=>{
  const id=options.id??(kind==='vmaf'?'vmaf-':'')+randomUUID(),state=options.state??'completed',createdAt=options.createdAt??100,attempt=options.attemptId??randomUUID(),digest=options.digest??'e'.repeat(64);
  const reference={...source,...options.source},distorted={...other,...options.distorted},pair={reference,distorted,ssim:{variant:'ffmpeg-uniform-8x8-step4-v1'}};
  const input={client:{id:'test-client'},request:pair,source:{id:reference.mediaId,version:reference.mediaVersion},operation:'quality-index'};
  const body={id,actor:{id:actor},revision:1,state,phase:'native',createdAt,startedAt:createdAt,endedAt:state==='completed'?createdAt+10:null,requestId:'request',input:{...input,metrics:{ssim:true},plan:options.plan??{}},reason:options.reason??null,attemptId:attempt,resultDigest:digest,progress:{preparedFrames:8,targetFrames:8},metrics:{psnr:{state:'completed'},ssim:{state:'completed'},vmaf:{state}},relation:{input:{reference,distorted}},plan:{input:{client:input.client,pairs:[pair]},targets:1},summary:{scoredPairs:1},samples:options.samples??[]};
  const table={preparation:'discovery_jobs',single:'quality_jobs',range:'quality_ranges',correspondence:'quality_correspondence_plans',vmaf:'quality_vmaf_jobs'}[kind];
  db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,actor,actor,1,state,'decode',createdAt,createdAt,state==='completed'?createdAt+10:null,JSON.stringify(options.reason??null),'request','test-client',JSON.stringify(input),JSON.stringify(body),options.result??'not-JSON-result-that-must-not-be-parsed',options.result??'not-JSON-result-that-must-not-be-parsed',digest,JSON.stringify({value:{sources:{reference:{binding:reference},distorted:{binding:distorted}}}}),attempt);
  return {id,attemptId:attempt,digest};
 };
 const owner=(kind:TaskKind)=>({taskSummaries:(actor:string)=>taskSummaries(db,kind,actor),taskEdges:(actor:string)=>taskEdges(db,kind as 'range'|'correspondence'|'vmaf',actor),cancel:()=>{throw Error('Cancellation callback not installed');}});
 const services={preparation:owner('preparation'),correspondence:owner('correspondence'),single:owner('single'),range:owner('range'),vmaf:owner('vmaf')};
 Object.assign(services.range,{taskChild:()=>true});Object.assign(services.correspondence,{taskRange:(id:string)=>JSON.parse(String(db.prepare('SELECT body FROM quality_plan_executions WHERE plan_id=?').get(id)?.body??'null'))?.rangeId??null,get:(id:string)=>JSON.parse(String(db.prepare('SELECT body FROM quality_correspondence_plans WHERE id=?').get(id)!.body))});Object.assign(services.vmaf,{get:(id:string)=>JSON.parse(String(db.prepare('SELECT body FROM quality_vmaf_jobs WHERE id=?').get(id)!.body))});
 const library={durableQualityJobsEnabled:true,discovery:{store:services.preparation,cancel:services.preparation.cancel},qualityCorrespondence:services.correspondence,qualityJobs:services.single,qualityRanges:services.range,qualityVmaf:services.vmaf} as unknown as MediaLibraryIndex;
 let clock=1000;const center=new TaskCenterService(library,()=>clock);
 return {db,insert,center,library,source,other,clock:(value:number)=>{clock=value;},close:()=>{center.close();db.close();}};
}
const query=(s='')=>taskQuery(new URLSearchParams(s));

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
 assert.equal(page.total,5);assert.deepEqual(new Set(page.entries.map(x=>x.id)),new Set(expected.map(x=>x.id)));assert.deepEqual(new Set(page.entries.map(x=>x.kind)),new Set(TASK_KINDS));
 assert.equal(f.center.query('actor-A',query(`mediaId=${f.source.mediaId}&mediaVersion=${f.other.mediaVersion}`)).total,0,'version cannot match the opposite side');
 assert.equal(f.center.query('actor-A',query('createdFrom=20&createdTo=21')).total,5);
 assert.equal(f.center.query('actor-A',query('createdFrom=0&createdTo=20')).total,0,'exclusive end');
 const single=f.center.query('actor-A',query('kind=single&metric=ssim')).entries[0];assert.equal(single.phase,'decode');assert.equal(single.result.available,true);assert.ok(!JSON.stringify(page).includes('not-JSON-result'),'no result parsing or result blob copying');
 assert.ok(!JSON.stringify(page).includes('actor-B'));
});

test('frozen pagination survives new tasks/state mutations and immutable tie order; refresh sees new facts',t=>{
 const f=fixture();t.after(f.close);for(const k of TASK_KINDS)f.insert(k,'actor-A',{state:'running'});
 const first=f.center.query('actor-A',query('limit=2'));assert.equal(first.total,5);assert.ok(first.nextCursor);
 f.db.exec("UPDATE quality_jobs SET state='failed'");f.insert('single','actor-A',{createdAt:999});
 const second=f.center.query('actor-A',query(`limit=2&cursor=${first.nextCursor}`));const third=f.center.query('actor-A',query(`limit=2&cursor=${second.nextCursor}`));
 const rows=[...first.entries,...second.entries,...third.entries];assert.equal(new Set(rows.map(r=>r.id)).size,5);assert.ok(rows.every(r=>r.state==='running'));assert.equal(third.nextCursor,null);assert.equal(second.capturedAt,first.capturedAt);
 assert.deepEqual(rows.map(r=>r.kind),[...TASK_KINDS].sort());const fresh=f.center.query('actor-A',query());assert.equal(fresh.total,6);assert.ok(fresh.entries.some(r=>r.state==='failed'));
});

test('cursor is scoped, signed, bounded, expiring, restart-invalid and recoverable without deleting jobs',t=>{
 const f=fixture();t.after(f.close);for(let n=0;n<4;n++)f.insert('single');
 const a=f.center.query('actor-A',query('limit=1')),cursor=a.nextCursor!;
 for(const [actor,s]of [['actor-B',`cursor=${cursor}`],['actor-A',`cursor=${cursor}&metric=psnr`],['actor-A',`cursor=${cursor.slice(0,-1)}${cursor.at(-1)==='0'?'1':'0'}`]])assert.throws(()=>f.center.query(actor,query(s)),(e:any)=>e.code==='task-cursor-expired');
 const restarted=new TaskCenterService(f.library);assert.throws(()=>restarted.query('actor-A',query(`cursor=${cursor}`)),(e:any)=>e.code==='task-cursor-expired');restarted.close();
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
 const temporary=new TaskCenterService({durableQualityJobsEnabled:false}as MediaLibraryIndex);assert.throws(()=>temporary.query('actor-A',query()),(e:any)=>e.code==='task-storage-unavailable');temporary.close();
 const f=fixture();t.after(f.close);for(let n=0;n<=TASK_HISTORY_ROWS.vmaf;n++)f.insert('vmaf');assert.throws(()=>f.center.query('actor-A',query()),(e:any)=>e.code==='task-history-budget');
});
