import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaLibraryIndex } from '../../server/library.ts';
import { DiscoveryStore } from '../../server/discovery/store.ts';
import {openIndexDatabase} from '../../server/sqlite.ts';
import { parseDiscoveryQuery, evaluateDiscovery, preparationInput } from '../../shared/media/discovery.ts';
import { emptyProbeFields } from '../../shared/media/probe.ts';
import type { MediaProbe, DiscoveryStream } from '../../shared/media/discovery.ts';
const source={id:'a'.repeat(24),version:'b'.repeat(24)};
const field=(value:string|number)=>({value,status:'known' as const,source:'codec-configuration' as const});
const stream=(id:string,codec:string,width:number):DiscoveryStream=>({id,type:'video',ordinal:0,fields:{...emptyProbeFields(),codec:field(codec),width:field(width)},
  clock:{timeBase:{numerator:1,denominator:1000},domain:'container-track-ticks',origin:null,relationToQualityAu:'not-established'}});
test('discovery validates bounded scope and evaluates conjunctions within one stream, preserving unknown',()=>{
  assert.throws(()=>parseDiscoveryQuery(new URLSearchParams('codec=h264&codec=hevc')));
  for(const q of ['limit=33','bitDepth=17','minWidth=400&maxWidth=30','includeUnknown=false','startPts=0'])assert.throws(()=>parseDiscoveryQuery(new URLSearchParams(q)));
  assert.equal(evaluateDiscovery([stream('a','h264',32),stream('b','hevc',1920)],true,{codec:'h264',minWidth:1000}).state,'not-match');
  assert.equal(evaluateDiscovery([stream('a','hevc',32)],false,{codec:'h264'}).state,'unknown');
  assert.equal(evaluateDiscovery([],true,{codec:'h264'}).state,'not-match');
  assert.equal(evaluateDiscovery([stream('a','h264',32)],true,{bitDepth:10}).state,'unknown');
  const s=stream('a','h264',32);s.fields.bitDepth={...field(10),status:'derived'};assert.equal(evaluateDiscovery([s],true,{bitDepth:10}).state,'unknown');
  for(const value of [null,{}, {source,operation:'decode',client:{id:'client',name:'Client'}},{source:{...source,version:'v'},operation:'probe',client:{id:'client',name:'Client'}},
    {source:{...source,id:[source.id]},operation:'probe',client:{id:'client',name:'Client'}}])assert.throws(()=>preparationInput(value));
});
test('whole-library discovery scans bounded pages, reports cumulative unknown and invalidates cursor on cache/source mutations',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'vp-discovery-'));let library:MediaLibraryIndex|undefined;
  t.after(async()=>{await library?.close();await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<5;i++)await writeFile(path.join(dir,`sample-${i}.flv`),'not probed');
  library=new MediaLibraryIndex([dir],{database:path.join(dir,'library.sqlite'),watch:false});await library.refresh();
  const store=library.discovery.store;
  const q=parseDiscoveryQuery(new URLSearchParams('codec=h264&limit=2'));
  const first=store.browse(q);assert.equal(first.entries.length,2);assert.equal(first.coverage.cumulative.unknown,2);assert.equal(first.coverage.totals,null);assert.ok(first.nextCursor);
  const second=store.browse({...q,cursor:first.nextCursor!});assert.equal(second.entries.length,2);assert.equal(second.coverage.cumulative.unknown,4);
  const last=store.browse({...q,cursor:second.nextCursor!});assert.equal(last.coverage.exhausted,true);assert.deepEqual(last.coverage.totals,{match:0,unknown:5,notMatch:0});
  assert.throws(()=>store.browse({...q,filters:{codec:'hevc'},cursor:first.nextCursor!}),e=>(e as any).code==='discovery-snapshot-changed');
  const current=library.browse({recursive:true}).entries[0];
  const probe:MediaProbe={schema:'voidplayer-media-probe',version:1,source:{id:current.id,version:current.version!},parser:'test',container:field('flv'),
    streams:[stream('one','h264',32)],streamInventoryComplete:false,coverage:{scope:'initial-video-configuration',fullPacketEnumeration:false,decodedPictures:false,bytesRead:10,readCalls:1}};
  const actor={id:'actor',name:'Actor'} as any,submitted=store.submit({source:probe.source,operation:'probe',client:{id:'client',name:'Client'}},actor,'request','key',Date.now());
  store.start(submitted.job.id,Date.now());store.finish(submitted.job.id,'completed',Date.now(),null,probe,{probe,witness:{} as any});
  assert.throws(()=>store.browse({...q,cursor:first.nextCursor!}),e=>(e as any).code==='discovery-snapshot-changed');
  assert.equal(store.detail(probe.source).technical.probe?.streams[0].fields.codec.value,'h264');
  const fresh=store.browse({...q,limit:32});assert.equal((fresh.entries.find((e:any)=>e.source.id===current.id) as any).decision.state,'match');
  // Failed/cancelled preparations retain actual receipts, not a lifetime result reservation.
  for(let i=0;i<1001;i++){const j=store.submit({source:probe.source,operation:'probe',client:{id:'batch',name:'Batch'}},actor,'request',`batch-${i}`,1000).job;store.cancel(j.id,actor.id,1001);}
  assert.equal(store.submit({source:probe.source,operation:'probe',client:{id:'batch',name:'Batch'}},actor,'replay','batch-0',2000).replayed,true);
  assert.ok(Number(store.db.prepare('SELECT sum(reserved_bytes) n FROM discovery_jobs').get()!.n)<2*1024*1024);
  // Receipt-first replay survives a stale source version and probe eviction.
  store.db.prepare('DELETE FROM discovery_probes').run();await writeFile(path.join(dir,current.name),'replacement');await library.refresh();
  assert.equal(store.submit({source:probe.source,operation:'probe',client:{id:'client',name:'Client'}},actor,'request2','key',Date.now()).replayed,true);
  assert.throws(()=>store.submit({source:probe.source,operation:'quality-index',client:{id:'client',name:'Client'}},actor,'request3','key',Date.now()),e=>(e as any).code==='idempotency-conflict');
});
test('discovery reuses bounded existing cache namespaces without probing, never joins or silently chooses conflicting evidence',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-discovery-cached-'));await writeFile(path.join(dir,'cached.mp4'),Buffer.alloc(10000));
 const library=new MediaLibraryIndex([dir],{database:path.join(dir,'library.sqlite'),watch:false});await library.refresh();t.after(async()=>{await library.close();await rm(dir,{recursive:true,force:true});});
 const entry=library.browse().entries[0],store=library.discovery.store,records=Buffer.alloc(48);records.writeBigInt64LE(0n);records.writeBigInt64LE(0n,8);records.writeBigInt64LE(40n,16);records.writeBigInt64LE(-1n,24);records.writeInt32LE(100,32);
 const put=(build:string,width:number)=>{const identity={kind:'ffmpeg' as const,streamKey:'video:0',schemaVersion:3,indexerBuild:build.repeat(40)};
  library.frameIndexes.put(entry.id,entry.version!,entry.size,{schema:3,kind:'ffmpeg-container',size:entry.size,codec:'h264',width,height:360,timeBaseNum:1,timeBaseDen:1000,streamIndex:0,
   indexerBuild:identity.indexerBuild,recordBytes:48,firstPts:'0',originVerified:true,indexIntegrity:'complete',count:1,records:records.toString('base64')},library.frameIndexes.epoch,identity);};
 put('a',640);let page=store.browse(parseDiscoveryQuery(new URLSearchParams('codec=h264&minWidth=640')));assert.equal((page.entries[0] as any).decision.state,'match');
 const detail=store.detail({id:entry.id,version:entry.version!});assert.equal(detail.technical.state,'cached-streams-only');assert.equal(detail.technical.probe,null);assert.equal(detail.technical.streamInventoryComplete,false);
 assert.equal(detail.technical.streams[0].cachedIndex!.identity.indexerBuild,'a'.repeat(40));assert.equal(detail.technical.streams[0].clock.relationToQualityAu,'not-established');
 page=store.browse(parseDiscoveryQuery(new URLSearchParams('codec=hevc')));assert.equal((page.entries[0] as any).decision.state,'unknown','cache inventory does not prove absence of another stream');
 put('b',1920);page=store.browse(parseDiscoveryQuery(new URLSearchParams('codec=h264&minWidth=640')));assert.equal((page.entries[0] as any).decision.state,'unknown');
 assert.equal(store.detail({id:entry.id,version:entry.version!}).technical.streams[0].fields.codec.reason,'cached-stream-evidence-conflict');
 for(const build of ['c','d','e'])put(build,640);const truncated=store.detail({id:entry.id,version:entry.version!});assert.equal(truncated.technical.cachedEvidenceTruncated,true);assert.equal(truncated.technical.cacheProjection.identitiesRead,5);
 assert.ok(truncated.technical.cacheProjection.bytes<=5*45056);assert.equal(store.db.prepare('SELECT count(*) AS n FROM discovery_jobs').get()!.n,0);
  store.db.exec("UPDATE roots SET state='offline'");const unavailable=store.browse(parseDiscoveryQuery(new URLSearchParams('codec=h264')));assert.equal((unavailable.entries[0] as any).decision.state,'unknown');assert.equal((unavailable.entries[0] as any).decision.reason,'library-root-not-ready');
});
test('future discovery schema is rejected before creating current tables and closes its failed constructor connection',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-discovery-version-')),file=path.join(dir,'library.sqlite');
 const library=new MediaLibraryIndex([dir],{database:file,watch:false});t.after(async()=>{await library.close();await rm(dir,{recursive:true,force:true});});
 const db=openIndexDatabase(file);try{db.exec('CREATE TABLE discovery_meta(id INTEGER PRIMARY KEY,version INTEGER,revision INTEGER);INSERT INTO discovery_meta VALUES(1,2,0)');}finally{db.close();}
 assert.throws(()=>new DiscoveryStore(file),e=>(e as any).code==='discovery-schema-unsupported');
 const read=openIndexDatabase(file);try{assert.equal(read.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='discovery_jobs'").get()!.n,0);}finally{read.close();}
});
test('100000-row discovery uses bounded primary-key seeks even on deep sparse-search pages',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'vp-discovery-deep-')),library=new MediaLibraryIndex([dir],{database:path.join(dir,'library.sqlite'),watch:false});await library.refresh();
 t.after(async()=>{await library.close();await rm(dir,{recursive:true,force:true});});const store=library.discovery.store,root=String(store.db.prepare('SELECT id FROM roots LIMIT 1').get()!.id);
 const insert=store.db.prepare("INSERT INTO media(id,root_id,path,parent,size,modified,version,state,generation,observed_at) VALUES(?,?,?,'',1,1,?,'ready',1,1)");
 store.transaction(()=>{for(let i=0;i<100000;i++)insert.run(i.toString(16).padStart(24,'0'),root,i===99999?'needle.flv':`plain-${i}.flv`,'b'.repeat(24));});
 const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT id,root_id,path,state FROM media INDEXED BY sqlite_autoindex_media_1 WHERE id>? ORDER BY id LIMIT ?').all('000000000000000000015f90',65).map(r=>String(r.detail));
 assert.ok(plan.some(s=>/SEARCH media USING INDEX sqlite_autoindex_media_1 \(id>\?\)/.test(s)),JSON.stringify(plan));assert.ok(plan.every(s=>!/(SCAN |TEMP B-TREE)/.test(s)),JSON.stringify(plan));
 const query=parseDiscoveryQuery(new URLSearchParams('search=needle&codec=h264&limit=2'));let cursor,pages=0,scanned=0,result;
 do{result=store.browse({...query,...(cursor?{cursor}:{})});pages++;assert.ok(result.work.candidateRowsRead<=65);assert.ok(result.coverage.candidates.page<=64);scanned+=result.coverage.candidates.page;
  assert.ok(result.work.sourceRowsProjected<=1);if(!result.coverage.exhausted){assert.equal(result.coverage.total,null);assert.equal(result.coverage.totals,null);assert.equal(result.entries.length,0);}
  cursor=result.nextCursor;
 }while(cursor);
 assert.equal(scanned,100000);assert.equal(result.coverage.total,1);assert.equal(result.coverage.cumulative.unknown,1);assert.equal(result.entries.length,1);assert.equal((result.entries[0] as any).file.name,'needle.flv');
 console.log({registered:100000,pages,scanned,plan});
});
