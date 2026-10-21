import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisResult } from '../../shared/analysis/bitstream/contract.ts';
import { OwnedBlocks, packLegacy, summaryOf, legacyOf, encodeProduct, decodeProduct, validateProduct, PRODUCT_LIMIT } from '../../shared/analysis/bitstream/products.ts';
import { DiagramStore } from '../../shared/analysis/bitstream/diagrams.ts';
const result = (): AnalysisResult => ({
  schema: 1,
  codec: "h264",
  analyzerVersion: "0.1.0",
  buildId: "test",
  recipe: "blocks-basic-v2",
  picture: {
    sourceVersion: "local:uuid",
    stream: "video",
    configuration: 0,
    au: 3,
    picture: 0,
    layer: 0,
    field: "frame",
  },
  sourcePtsUs: 100,
  width: 16,
  height: 16,
  confidence: "exact",
  reasons: [],
  capabilities: {
    blocks: "ready",
    qp: "ready",
    modes: "ready",
    motion: "unsupported",
  },
  qp: { component: "luma", bitDepth: 8, weighting: "pixel-area", mean: 23 },
  blocks: [{ x: 0, y: 0, width: 16, height: 16, qp: 23, mode: "intra" }],
  metrics: {
    startAu: 0,
    packets: 4,
    bytesRead: 1000,
    elapsedMs: 3,
    recordBytes: 12,
    heapBytes: 67108864,
  },
});

test('summary has independent readable coverage after blocks eviction', () => {
  const diagrams = new DiagramStore(); const r = result(); r.nalus = [{offset:0,size:1,type:5,temporalId:0,layer:0}]; const summary = summaryOf(r);
  diagrams.putSummary(summary);
  assert.equal('blocks' in summary, false);
  assert.deepEqual(diagrams.getSummary(summary.picture, summary.buildId, null), summary);
  assert.equal(diagrams.getSummary(summary.picture, 'other-build', null), null);
});
test('packed transport preserves null, checksums header and payload, owns buffers', async () => {
  const original = result(), packed = packLegacy(original), owned = new OwnedBlocks(packed);
  new Uint8Array(packed.payload).fill(0);
  assert.deepEqual(owned.legacy(), original);
  const transfer = owned.copy(); structuredClone(transfer, {transfer: [transfer.payload]});
  assert.deepEqual(owned.legacy(), original);
  const bytes = await encodeProduct(owned.copy());
  const decoded = await decodeProduct(bytes);
  assert.equal(decoded.product, 'blocks');
  if (decoded.product === 'blocks') assert.deepEqual(new OwnedBlocks(decoded).legacy(), original);
  for (const offset of [10, bytes.length - 34]) { const corrupt = bytes.slice(); corrupt[offset] ^= 1; await assert.rejects(decodeProduct(corrupt)); }
  await assert.rejects(decodeProduct(new Uint8Array(PRODUCT_LIMIT.frame + 1)));
  const summary = summaryOf(original); assert.throws(() => validateProduct({...summary, blocks: []} as any));
});

test('summary eviction clears readable coverage while coarse bins remain honest', () => {
  const r=result();r.nalus=[{offset:0,size:1,type:5,temporalId:0,layer:0}];
  const summary=summaryOf(r), diagrams=new DiagramStore(2500);
  diagrams.putSummary(summary);
  for(let au=4;au<20;au++)diagrams.putSummary({...summary,picture:{...summary.picture,au},sourcePtsUs:100+au});
  assert.equal(diagrams.getSummary(summary.picture,summary.buildId,null),null);
  assert.equal(diagrams.queryChart(summary.picture.sourceVersion,0,1000,100).count,17);
});
test('same source build or stream changes replace raw records AND coarse chart evidence', () => {
  const r=result();r.nalus=[{offset:0,size:1,type:5,temporalId:0,layer:0}];const original=summaryOf(r),diagrams=new DiagramStore();
  diagrams.putSummary(original);
  for(const buildId of ['replacement','third']){
    const next={...original,buildId,picture:{...original.picture,stream:buildId},qp:{...original.qp,mean:37}};
    diagrams.putSummary(next);
    assert.equal(diagrams.getSummary(original.picture,original.buildId,null),null);
    const chart=diagrams.queryChart(original.picture.sourceVersion,0,1000,100);
    assert.equal(chart.count,1);assert.equal(chart.pictures.reduce((n,p)=>n+(p.qpMean??0),0),37);
  }
});
test('summary cannot authorize block cache and corruption survives corrected checksums', async () => {
  const {AnalysisCache}=await import('../../shared/analysis/bitstream/cache.ts');
  const cache=new AnalysisCache(),r=result();cache.put(r);
  const first=cache.peek(r.picture);assert.ok(first);
  // 32MiB exact-block LRU: many bounded, disjoint source frames evict the first.
  const large={...r,width:4096,height:2304,blocks:[] as AnalysisResult['blocks']};
  for(let y=0;y<2304;y+=16)for(let x=0;x<4096;x+=16)large.blocks.push({x,y,width:16,height:16,qp:23,mode:'intra'});
  for(let au=10;au<100;au++)cache.put({...large,picture:{...large.picture,au}});
  assert.equal(cache.peek(r.picture),null);assert.ok(cache.sizeBytes<=32*1024*1024);
  const packed=packLegacy(r);new DataView(packed.payload).setUint8(10,7);assert.throws(()=>validateProduct(packed));
  assert.throws(()=>validateProduct({...summaryOf(r),capabilities:{...r.capabilities,blocks:'unsupported'}}));
});
test('bounded response rejects lying content length without allocating beyond the admitted size', async () => {
  const {readBoundedResponse}=await import('../../shared/analysis/bitstream/products.ts');
  const response=new Response(new Uint8Array(20),{headers:{'content-length':'4'}});
  await assert.rejects(readBoundedResponse(response),/Oversized/);
  await assert.rejects(readBoundedResponse(new Response('x',{headers:{'content-length':String(PRODUCT_LIMIT.frame+1)}})),/budget/);
});
test('summary pages enforce complete namespace and checksum; block magic is unambiguous', async () => {
  const {AnalysisStore}=await import('../../server/analysis/bitstream/store.ts');const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');const {productKey}=await import('../../shared/analysis/bitstream/products.ts');
  const folder=await mkdtemp(join(tmpdir(),'analysis-products-'));try{
    const store=new AnalysisStore(folder),r=result(),summary=summaryOf(r),id=createHash('sha256').update(productKey({...r.picture,au:0},r.buildId,null,'summary')).digest('hex');
    await store.putOutput(id,summary);assert.deepEqual(await store.getOutput(id,3),summary);
    await store.putOutput(id,{...summary,picture:{...summary.picture,au:4}});
    const original=JSON.parse(await readFile(store.productFile(id),'utf8')),page=JSON.parse(original.payload),members=page.members;members[1].buildId='wrong';original.payload=JSON.stringify(page);original.checksum=createHash('sha256').update(original.payload).digest('hex');await writeFile(store.productFile(id),JSON.stringify(original));
    assert.equal(await store.getOutput(id,3),null,'mixed page rejected even with valid checksum');
    const packed=packLegacy(r),blockId='c'.repeat(64);await store.putOutput(blockId,packed);const bytes=await readFile(store.productFile(blockId));assert.equal(bytes.readUInt32LE(0),0x31504156);assert.deepEqual(await store.getOutput(blockId),packed);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('service warms explicit summaries without workers, preserves exact blocks, and invalidates old build overlays', async () => {
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');const {makeDemandPlan}=await import('../../shared/analysis/bitstream/demand.ts');
 const previous={Worker:Object.getOwnPropertyDescriptor(globalThis,'Worker'),location:Object.getOwnPropertyDescriptor(globalThis,'location'),fetch:globalThis.fetch};
 let build='test',created=0;
 const r=result();r.picture.au=0;r.sourcePtsUs=100;r.sourceDtsUs=null;r.nalus=[{offset:0,size:1,type:5,temporalId:0,layer:0}];r.gop={startAu:0,endAu:1,configuration:0,anchor:'closed'};
 class WorkerMock{onmessage?:({data}:{data:any})=>void;onerror:any;onmessageerror:any;constructor(){created++;}terminate(){}postMessage(data:any){if(!data.target)return;queueMicrotask(()=>{const frame={...r,buildId:build};if(data.target.mode==='stream'){
  const plan=makeDemandPlan([{au:0,configuration:0,pts:100,dts:null,offset:0,size:1,key:true}],data.target,build);this.onmessage?.({data:{event:'plan',plan}});this.onmessage?.({data:{event:'chunk',result:summaryOf(frame)}});this.onmessage?.({data:{event:'progress',progress:{pictures:1,totalPictures:1,checkedUs:100,totalUs:100,indexComplete:true}}});this.onmessage?.({data:{ok:true}});
 }else this.onmessage?.({data:{ok:true,result:packLegacy(frame)}});});}}
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});globalThis.fetch=async()=>new Response(JSON.stringify({buildId:build}),{headers:{'content-type':'application/json'}});
 const service=new BitstreamAnalysisService(()=>{}),source={info:{},bitstreamFile:new Blob(['x'])} as any,token={picture:r.picture,sourcePtsUs:100,normalizedMediaUs:0,geometry:{codedWidth:16,codedHeight:16,visibleRect:{x:0,y:0,width:16,height:16}}} as any,target={mode:'stream' as const,product:'summary' as const,sourceVersion:r.picture.sourceVersion,firstPtsUs:100,durationUs:100,window:{startUs:0,endUs:100,axis:'pts' as const}};
 try{
  const exact=await service.request(source,token);assert.deepEqual(exact.blocks,r.blocks);assert.ok(service.cached(token));const first=created;
  await service.request(source,token);assert.equal(created,first,'same precise frame reuses private packed blocks');
  await service.requestStream(source,target,'A');const afterCold=created;assert.ok(service.cached(token));
  await service.requestStream(source,target,'A');assert.equal(created,afterCold);assert.equal(service.state.cacheHit,true);assert.ok(service.cached(token),'summary warm must retain same-identity blocks');
  build='replacement';await service.requestStream(source,target,'A');assert.equal(created,afterCold+1);assert.equal(service.cached(token),null,'new current build cannot read old exact blocks');
  assert.equal(service.sameDemand({...target.window,axis:'invalid'} as any),false);
 }finally{service.dispose();globalThis.fetch=previous.fetch;for(const key of ['Worker','location'] as const){if(previous[key])Object.defineProperty(globalThis,key,previous[key]!);else Reflect.deleteProperty(globalThis,key);}}
});

test('same GOP viewport moves retain one worker, latest window, pause release and AU-set resume', async () => {
 const {ReviewSession}=await import('../../src/session.ts');const {rgbaDescription}=await import('../../shared/media/frame-description.ts');const {makeDemandPlan}=await import('../../shared/analysis/bitstream/demand.ts');
 const previous={Worker:Object.getOwnPropertyDescriptor(globalThis,'Worker'),location:Object.getOwnPropertyDescriptor(globalThis,'location'),fetch:globalThis.fetch};
 const packets=Array.from({length:3},(_,au)=>({au,configuration:0,pts:100+au*100,dts:null,offset:0,size:1,key:au===0}));
 let created=0,terminated=0,repairs=0,releaseMiddle!:()=>void,reached!:()=>void;const firstReached=new Promise<void>(r=>{reached=r;});
 const frame=(au:number)=>({...result(),picture:{...result().picture,au},sourcePtsUs:100+au*100,sourceDtsUs:null,nalus:[{offset:0,size:1,type:5,temporalId:0,layer:0}],gop:{startAu:0,endAu:3,configuration:0,anchor:'closed' as const}});
 class WorkerMock{onmessage?:({data}:{data:any})=>void;onerror:any;onmessageerror:any;id=++created;terminate(){terminated++;}postMessage(data:any){if(data.event==='coverage-miss'){repairs++;this.onmessage?.({data:{event:'chunk',repair:true,result:summaryOf(frame(data.picture.au))}});return;}if(!data.target)return;queueMicrotask(()=>{
  this.onmessage?.({data:{event:'plan',plan:makeDemandPlan(packets,data.target,'test')}});
  const progress=(pictures:number)=>this.onmessage?.({data:{event:'progress',progress:{pictures,totalPictures:3,checkedUs:pictures===3?100:0,totalUs:100,indexComplete:true}}});
  if(this.id===1){this.onmessage?.({data:{event:'chunk',result:summaryOf(frame(0))}});progress(1);releaseMiddle=()=>{this.onmessage?.({data:{event:'chunk',result:summaryOf(frame(1))}});progress(2);};reached();}
  else{(session as any).bitstream.root.diagrams.clear();for(let au=0;au<2;au++)this.onmessage?.({data:{event:'coverage',picture:frame(au).picture,buildId:'test'}});this.onmessage?.({data:{event:'chunk',result:summaryOf(frame(2))}});progress(3);this.onmessage?.({data:{ok:true}});}
 });}}
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});globalThis.fetch=async()=>new Response(JSON.stringify({buildId:'test'}));
 const source={info:{id:'local:uuid',name:'coalescing.mp4',size:1,lastModified:0,codec:'h264',decoder:'webcodecs',width:16,height:16,firstPtsUs:100,durationUs:300},bitstreamFile:new Blob(['x']),async frameAt(time:number){const au=Math.min(2,Math.floor(time/100));return{kind:'video-sample',ptsUs:au*100,sourcePtsUs:100+au*100,durationUs:100,description:rgbaDescription(16,16),width:16,height:16,byteSize:1024,sourcePicture:frame(au).picture,close(){}};},async framesAfter(){return[];},async *framesFrom(){},dispose(){}} as unknown as import('../../src/media/source.ts').MediaSource;
 let commit=0;const session=new ReviewSession((_slot,frame)=>{frame.presentedCommit=++commit;});const oldWindow={startUs:0,endUs:100,axis:'pts' as const},newWindow={startUs:100,endUs:200,axis:'pts' as const};
 try{
  await session.load('A',async()=>source);const first=session.requestBitstreamViewport('A',oldWindow).catch(()=>{});await firstReached;
  const moved=session.requestBitstreamViewport('A',newWindow).catch(()=>{});await new Promise(r=>setImmediate(r));assert.equal(created,1);assert.deepEqual(session.getBitstreamAnalysisState('A').stream?.window,newWindow);
  releaseMiddle();assert.deepEqual(session.getBitstreamAnalysisState('A').stream?.window,newWindow);session.pauseBitstreamAnalysis('A');await Promise.all([first,moved]);assert.equal(terminated,1);assert.deepEqual(session.getBitstreamAnalysisState('A').stream?.window,newWindow);
  await session.resumeBitstreamAnalysis('A');assert.equal(created,2);assert.equal(terminated,2);assert.equal(repairs,2,'eviction between cache reply and coverage is repaired from the still-owned summary');assert.equal(session.getBitstreamAnalysisState('A').stream?.pictures,3);assert.deepEqual(session.getBitstreamAnalysisState('A').stream?.window,newWindow);
 }finally{await session.dispose();globalThis.fetch=previous.fetch;for(const key of ['Worker','location'] as const){if(previous[key])Object.defineProperty(globalThis,key,previous[key]!);else Reflect.deleteProperty(globalThis,key);}}
});

test('unsupported product modes fail explicitly at admission',async()=>{
 const {validateTarget,validateRange}=await import('../../shared/analysis/bitstream/contract.ts');
 assert.throws(()=>validateTarget({sourceVersion:'x',sourcePtsUs:0,normalizedMediaUs:0,product:'summary'}),/Summary requires/);
 assert.throws(()=>validateRange({sourceVersion:'x',firstPtsUs:0,startUs:0,endUs:1,product:'blocks'}),/require a stream or exact-picture/);
});

test('exact request rejects cross-product, index and build payloads before cache authorization',async()=>{
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');const {JS_TS_MEDIA_INDEX_IDENTITY}=await import('../../shared/media/indexing/media-index-identity.ts');
 const previous={Worker:Object.getOwnPropertyDescriptor(globalThis,'Worker'),location:Object.getOwnPropertyDescriptor(globalThis,'location'),fetch:globalThis.fetch};let outgoing:any,expected='test';
 class WorkerMock{onmessage?:({data}:{data:any})=>void;onerror:any;onmessageerror:any;terminate(){}postMessage(data:any){if(data.target)queueMicrotask(()=>this.onmessage?.({data:{ok:true,result:outgoing}}));}}
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});globalThis.fetch=async()=>new Response(JSON.stringify({buildId:expected}));
 const source={info:{},bitstreamFile:new Blob(['x'])} as any,token=(r:AnalysisResult)=>({picture:r.picture,sourcePtsUs:r.sourcePtsUs,normalizedMediaUs:0,geometry:{codedWidth:16,codedHeight:16,visibleRect:{x:0,y:0,width:16,height:16}}}) as any;
 try{for(const mode of ['legacy','summary','index','build','old-build-after-epoch']){
  const service=new BitstreamAnalysisService(()=>{}),original=result();expected='test';outgoing=packLegacy(original);await service.request(source,token(original));assert.ok(service.cached(token(original)));
  const next={...original,picture:{...original.picture,au:4}};outgoing=mode==='legacy'?next:mode==='summary'?summaryOf(next):packLegacy(next);
  if(mode==='index')outgoing.indexIdentity=JS_TS_MEDIA_INDEX_IDENTITY;if(mode==='build')outgoing.buildId='wrong';if(mode==='old-build-after-epoch')expected='replacement';
  await assert.rejects(service.request(source,token(next)),/identity mismatch/);assert.equal(service.cached(token(next)),null);
  if(mode==='old-build-after-epoch')assert.equal(service.cached(token(original)),null);
  service.dispose();
 }
 for(const fetcher of [async()=>{throw Error('network failed');},async()=>new Response('',{status:503}),async()=>new Response('{}')]){const failed=new BitstreamAnalysisService(()=>{});globalThis.fetch=fetcher;await assert.rejects(failed.request(source,token(result())));assert.notEqual(failed.state.state,'pending');failed.dispose();}
 const service=new BitstreamAnalysisService(()=>{}),r={...result(),buildId:'replacement'};let release!:(value:Response)=>void,calls=0;
 globalThis.fetch=async()=>++calls===1?await new Promise<Response>(resolve=>{release=resolve;}):new Response(JSON.stringify({buildId:'replacement'}));
 const late=service.request(source,token(r));const rejected=assert.rejects(late,/superseded/);outgoing=packLegacy(r);await service.request(source,token(r));assert.ok(service.cached(token(r)));release(new Response(JSON.stringify({buildId:'old'})));await rejected;assert.ok(service.cached(token(r)),'late old manifest cannot invalidate current blocks');service.dispose();
 }finally{globalThis.fetch=previous.fetch;for(const key of ['Worker','location'] as const){if(previous[key])Object.defineProperty(globalThis,key,previous[key]!);else Reflect.deleteProperty(globalThis,key);}}
});

test('maximum admitted NAL metadata fits products, oversized metadata/pages fail before body allocation',async()=>{
 const {AnalysisStore}=await import('../../server/analysis/bitstream/store.ts');const {mkdtemp,rm,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const r=result();r.nalus=Array.from({length:4096},(_,i)=>({offset:i*1000,size:100,type:5,temporalId:0,layer:0}));r.containerHeader={box:'avcC',byteLength:512,nalus:Array.from({length:256},(_,i)=>({offset:i*2,size:1,type:7,temporalId:0,layer:0}))};
 const value=packLegacy(r),wire=await encodeProduct(value);assert.ok(wire.length<PRODUCT_LIMIT.frame);assert.equal((await decodeProduct(wire)).validatedBlockCount,1);
 assert.throws(()=>validateProduct({...summaryOf(r),extra:'x'.repeat(PRODUCT_LIMIT.metadata+1)} as any),/budget/);
 const folder=await mkdtemp(join(tmpdir(),'analysis-page-budget-'));try{const store=new AnalysisStore(folder),id='d'.repeat(64);await writeFile(store.productFile(id),'{'+ ' '.repeat(PRODUCT_LIMIT.page));assert.equal(await store.getOutput(id,0),null);}finally{await rm(folder,{recursive:true,force:true});}
});
test('valid binary header with low length byte 123 cannot be mistaken for a JSON page',async()=>{
 const {AnalysisStore}=await import('../../server/analysis/bitstream/store.ts');const {mkdtemp,rm,readFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const folder=await mkdtemp(join(tmpdir(),'analysis-magic-'));try{
  let found:ReturnType<typeof packLegacy>|undefined;
  for(let n=1;n<=256;n++){const r=result();r.picture.sourceVersion='s'.repeat(n);const value=packLegacy(r),wire=await encodeProduct(value);if(new DataView(wire.buffer).getUint32(4,true)%256===123){found=value;break;}}
  assert.ok(found);const store=new AnalysisStore(folder),id='e'.repeat(64);await store.putOutput(id,found);const bytes=await readFile(store.productFile(id));assert.equal(bytes[4],123);assert.deepEqual(await store.getOutput(id),found);
 }finally{await rm(folder,{recursive:true,force:true});}
});

test('single-picture summary preserves same-identity verified stream GOP',()=>{const store=new DiagramStore(),r=result();r.nalus=[{offset:0,size:1,type:5,temporalId:0,layer:0}];r.gop={startAu:0,endAu:30,configuration:0,anchor:'closed'};store.put(r);const single={...r};delete single.gop;store.put(single);assert.deepEqual(store.summaryAt(r.picture.sourceVersion,r.picture.au)?.gop,r.gop);store.put({...single,buildId:'new'});assert.equal(store.summaryAt(r.picture.sourceVersion,r.picture.au)?.gop,undefined);});

test('SPS layout proves exact crop across plane padding; unknown/malformed layouts fail closed',async()=>{
 const {matchesAnalysisLayout}=await import('../../shared/analysis/bitstream/contract.ts');const r=result(),token={geometry:{codedWidth:16,codedHeight:18,visibleRect:{x:0,y:0,width:16,height:16}}} as import('../../shared/analysis/bitstream/contract.ts').PresentedFrameToken;
 assert.equal(matchesAnalysisLayout(r,token),false);r.sourceLayout={provenance:'configuration-sps-v1',configuration:0,codedWidth:16,codedHeight:16,visibleRect:{x:0,y:0,width:16,height:16}};assert.equal(matchesAnalysisLayout(r,token),true);
 const packed=packLegacy(r);assert.deepEqual((await decodeProduct(await encodeProduct(packed))).sourceLayout,r.sourceLayout);assert.deepEqual(legacyOf(packed).sourceLayout,r.sourceLayout);
 assert.equal(matchesAnalysisLayout(r,{...token,geometry:{...token.geometry,visibleRect:{x:0,y:1,width:16,height:15}}}),false);
 assert.throws(()=>validateProduct({...packed,sourceLayout:{...r.sourceLayout!,provenance:'guessed'}} as unknown as typeof packed));assert.throws(()=>validateProduct({...packed,productSchema:1} as unknown as typeof packed));assert.throws(()=>validateProduct({...packed,sourceLayout:{...r.sourceLayout!,configuration:1}}));
});

test('stream rejects wrong build products and plans before raw/cache coverage, including retained plans',async()=>{
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');const {makeDemandPlan}=await import('../../shared/analysis/bitstream/demand.ts');
 const previous={Worker:Object.getOwnPropertyDescriptor(globalThis,'Worker'),location:Object.getOwnPropertyDescriptor(globalThis,'location'),fetch:globalThis.fetch};let mode='valid';
 const frame={...result(),picture:{...result().picture,au:0},nalus:[{offset:0,size:1,type:5,temporalId:0,layer:0}],gop:{startAu:0,endAu:1,configuration:0,anchor:'closed' as const}};
 const packets=[{au:0,configuration:0,pts:100,dts:null,offset:0,size:1,key:true}];
 class WorkerMock{onmessage?:({data}:{data:any})=>void;onerror:any;onmessageerror:any;terminate(){}postMessage(data:any){if(!data.target)return;queueMicrotask(()=>{this.onmessage?.({data:{event:'plan',plan:makeDemandPlan(packets,data.target,mode==='plan'?'wrong':'test')}});const r={...frame,buildId:mode==='result'?'wrong':'test'};this.onmessage?.({data:{event:'chunk',result:data.target.product==='summary'?summaryOf(r):data.target.product==='blocks'?packLegacy(r):r}});this.onmessage?.({data:{event:'progress',progress:{pictures:1,totalPictures:1,checkedUs:100,totalUs:100,indexComplete:true}}});this.onmessage?.({data:{ok:true}});});}}
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});globalThis.fetch=async()=>new Response(JSON.stringify({buildId:'test'}));
 try{for(const product of [undefined,'summary','blocks'] as const)for(const bad of ['plan','result','retained']){const service=new BitstreamAnalysisService(()=>{}),source={info:{},bitstreamFile:new Blob(['x'])} as any,target={mode:'stream' as const,product,sourceVersion:frame.picture.sourceVersion,firstPtsUs:100,durationUs:100,window:{startUs:0,endUs:100,axis:'pts' as const}};if(bad==='retained'){mode='valid';await service.requestStream(source,target,'A');(service as unknown as {diagrams:DiagramStore}).diagrams.clear();}mode=bad==='plan'?'plan':'result';const cache=(service as unknown as {cache:import('../../shared/analysis/bitstream/cache.ts').AnalysisCache}).cache;let puts=0;const put=cache.put.bind(cache);cache.put=(...args)=>{puts++;put(...args);};await assert.rejects(service.requestStream(source,target,'A'),/build identity mismatch/);assert.equal(puts,0);assert.equal(service.state.state,'error');assert.equal((service as unknown as {diagrams:DiagramStore}).diagrams.queryChart(frame.picture.sourceVersion,0,1000).count,0);service.dispose();}}
 finally{globalThis.fetch=previous.fetch;for(const key of ['Worker','location'] as const){if(previous[key])Object.defineProperty(globalThis,key,previous[key]!);else Reflect.deleteProperty(globalThis,key);}}
});

test('full legacy and blocks streams pause at 30 and resume by readable coverage without duplicate delivery or put',async()=>{
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');
 const previous={Worker:Object.getOwnPropertyDescriptor(globalThis,'Worker'),location:Object.getOwnPropertyDescriptor(globalThis,'location'),fetch:globalThis.fetch};
 try{for(const product of [undefined,'blocks'] as const){let created=0,terminated=0,reached!:()=>void;const paused=new Promise<void>(r=>{reached=r;}),fresh:number[]=[],covered:number[]=[];
 const frame=(au:number)=>({...result(),picture:{...result().picture,au},sourcePtsUs:100+au*100,gop:{startAu:0,endAu:60,configuration:0,anchor:'closed' as const}});
 class WorkerMock{onmessage?:({data}:{data:any})=>void;onerror:any;onmessageerror:any;id=++created;au=0;stopped=false;owned:any;terminate(){this.stopped=true;terminated++;}emit(data:any){if(!this.stopped)queueMicrotask(()=>{if(!this.stopped)this.onmessage?.({data});});}next(){if(this.au===60){this.emit({ok:true});return;}this.emit({event:'cache',picture:frame(this.au).picture,buildId:'test'});}postMessage(data:any){if(data.target){this.next();return;}if(data.event==='cache'){this.owned=data.result;if(data.result){covered.push(this.au);this.emit({event:'coverage',picture:frame(this.au).picture,buildId:'test',gop:frame(this.au).gop,product});}else{fresh.push(this.au);this.emit({event:'chunk',result:product==='blocks'?packLegacy(frame(this.au)):frame(this.au)});}return;}if(data.ok){this.emit({event:'progress',progress:{pictures:this.au+1,totalPictures:60,checkedUs:(this.au+1)*100,totalUs:6000,indexComplete:true}});this.au++;if(this.id===1&&this.au===30){reached();return;}this.next();}}}
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:WorkerMock});Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});globalThis.fetch=async()=>new Response(JSON.stringify({buildId:'test'}));
 const service=new BitstreamAnalysisService(()=>{}),cache=(service as unknown as {cache:import('../../shared/analysis/bitstream/cache.ts').AnalysisCache}).cache,puts:number[]=[],put=cache.put.bind(cache);cache.put=(...args)=>{puts.push(args[0].picture.au);put(...args);};const source={info:{},bitstreamFile:new Blob(['x'])} as any,target={mode:'stream' as const,product,sourceVersion:result().picture.sourceVersion,firstPtsUs:100,durationUs:6000};
 const controller=new AbortController(),first=service.requestStream(source,target,'A',controller.signal);const cancelled=assert.rejects(first);await paused;controller.abort();await cancelled;assert.equal(puts.length,30);const complete=await service.requestStream(source,target,'A');assert.equal(complete.pictures,60);assert.deepEqual(fresh,Array.from({length:60},(_,i)=>i));assert.deepEqual(covered,Array.from({length:30},(_,i)=>i));assert.deepEqual(puts,fresh);assert.equal(new Set(puts).size,60);assert.equal(terminated,2);service.dispose();}}
 finally{globalThis.fetch=previous.fetch;for(const key of ['Worker','location'] as const){if(previous[key])Object.defineProperty(globalThis,key,previous[key]!);else Reflect.deleteProperty(globalThis,key);}}
});

test('shared forks reject late old manifest and result namespaces while same-build concurrency remains valid',async t=>{
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');
 const saved={fetch:globalThis.fetch,location:Object.getOwnPropertyDescriptor(globalThis,'location')};Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});
 const source={info:{},bitstreamFile:new Blob(['x'])} as any;
 const token=(r:AnalysisResult)=>({picture:r.picture,sourcePtsUs:r.sourcePtsUs,normalizedMediaUs:0,geometry:{codedWidth:16,codedHeight:16,visibleRect:{x:0,y:0,width:16,height:16}}}) as any;
 try{for(const late of ['manifest','result','same-build']){
  const root=new BitstreamAnalysisService(()=>{}),a=root.fork(()=>{}),b=root.fork(()=>{});let release!:()=>void,started!:()=>void,calls=0;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});const old={...result(),buildId:late==='same-build'?'new':'old'},fresh={...result(),buildId:'new',picture:{...result().picture,au:4}};
  globalThis.fetch=async()=>{if(++calls===1){if(late==='manifest'){started();await gate;}return new Response(JSON.stringify({buildId:old.buildId}));}return new Response(JSON.stringify({buildId:'new'}));};
  t.mock.method(a as any,'local',async()=>{if(late!=='manifest'){started();await gate;}return packLegacy(old);});t.mock.method(b as any,'local',async()=>packLegacy(fresh));
  const pending=a.request(source,token(old));const check=late==='same-build'?pending:assert.rejects(pending,/namespace superseded/);await ready;await b.request(source,token(fresh));release();await check;assert.ok(b.cached(token(fresh)),'old fork never clears current blocks');assert.equal(!!a.cached(token(old)),late==='same-build');root.dispose();
 }}finally{globalThis.fetch=saved.fetch;if(saved.location)Object.defineProperty(globalThis,'location',saved.location);else Reflect.deleteProperty(globalThis,'location');}
});

test('shared stream forks cannot reauthorize late old summaries or manifests over a newer namespace',async t=>{
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');const saved={fetch:globalThis.fetch,location:Object.getOwnPropertyDescriptor(globalThis,'location')};Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});
 const source={info:{},bitstreamFile:new Blob(['x'])} as any,target={mode:'stream' as const,product:'summary' as const,sourceVersion:'local:uuid',firstPtsUs:0,durationUs:1000};
 try{for(const late of ['manifest','result','same-build']){const root=new BitstreamAnalysisService(()=>{}),a=root.fork(()=>{}),b=root.fork(()=>{});let release!:()=>void,started!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{started=r;});const old={...result(),nalus:[{offset:0,size:1,type:5,temporalId:0,layer:0}],buildId:late==='same-build'?'new':'old',gop:{startAu:0,endAu:5,configuration:0,anchor:'closed' as const}},fresh={...old,buildId:'new',picture:{...old.picture,au:4}};
 globalThis.fetch=async()=>{if(++calls===1){if(late==='manifest'){started();await gate;}return new Response(JSON.stringify({buildId:old.buildId}));}return new Response(JSON.stringify({buildId:'new'}));};
 t.mock.method(a as any,'localRange',async(_f:unknown,_t:unknown,_s:unknown,consume:(r:unknown)=>void,progress:(r:unknown)=>void)=>{if(late!=='manifest'){started();await gate;}consume(summaryOf(old));progress({pictures:1,totalPictures:1,checkedUs:1000,totalUs:1000,indexComplete:true});});t.mock.method(b as any,'localRange',async(_f:unknown,_t:unknown,_s:unknown,consume:(r:unknown)=>void,progress:(r:unknown)=>void)=>{consume(summaryOf(fresh));progress({pictures:1,totalPictures:1,checkedUs:1000,totalUs:1000,indexComplete:true});});
 const pending=a.requestStream(source,target,'A');const check=late==='same-build'?pending:assert.rejects(pending,/namespace superseded/);await ready;await b.requestStream(source,target,'B');release();await check;assert.equal((root as any).diagrams.summaryAt('local:uuid',4)?.buildId,'new');assert.equal((root as any).diagrams.summaryAt('local:uuid',3)?.buildId,late==='same-build'?'new':undefined);root.dispose();
 }}finally{globalThis.fetch=saved.fetch;if(saved.location)Object.defineProperty(globalThis,'location',saved.location);else Reflect.deleteProperty(globalThis,'location');}
});


test('evicted shared namespace cannot be revived by a late picture or plan',async t=>{
 const {BitstreamAnalysisService}=await import('../../src/analysis/bitstream/service.ts');const {makeDemandPlan}=await import('../../shared/analysis/bitstream/demand.ts');const saved={fetch:globalThis.fetch,location:Object.getOwnPropertyDescriptor(globalThis,'location')};Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'http://localhost/'}});globalThis.fetch=async()=>new Response(JSON.stringify({buildId:'test'}));
 const service=new BitstreamAnalysisService(()=>{}),source={info:{},bitstreamFile:new Blob(['x'])} as any,r=result(),token={picture:r.picture,sourcePtsUs:r.sourcePtsUs,normalizedMediaUs:0,geometry:{codedWidth:16,codedHeight:16,visibleRect:{x:0,y:0,width:16,height:16}}} as any;
 try{t.mock.method(service as any,'local',async()=>{(service as any).contexts.clear();return packLegacy(r);});await assert.rejects(service.request(source,token),/namespace superseded/);assert.equal((service as any).contexts.size,0);assert.equal(service.cached(token),null);
 const target={mode:'stream' as const,product:'summary' as const,sourceVersion:r.picture.sourceVersion,firstPtsUs:100,durationUs:100,window:{startUs:0,endUs:100,axis:'pts' as const}};(service as any).streamBuild={sequence:(service as any).sequence,buildId:'test'};const plan=makeDemandPlan([{au:0,configuration:0,pts:100,dts:null,offset:0,size:1,key:true}],target,'test');assert.throws(()=>(service as any).acceptPlan(plan,target),/namespace superseded/);assert.equal((service as any).contexts.size,0);assert.equal((service as any).plans.size,0);
 }finally{service.dispose();globalThis.fetch=saved.fetch;if(saved.location)Object.defineProperty(globalThis,'location',saved.location);else Reflect.deleteProperty(globalThis,'location');}
});

test('remote cached GOP transport validates and publishes the batch atomically without picture downloads', async () => {
  const { BitstreamAnalysisService } = await import('../../src/analysis/bitstream/service.ts');
  const { makeDemandPlan } = await import('../../shared/analysis/bitstream/demand.ts');
  const saved = { fetch: globalThis.fetch, location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'http://localhost/' } });
  const target = { mode: 'stream' as const, product: 'summary' as const, sourceVersion: 'media@version', firstPtsUs: 100, durationUs: 80000,
    window: { startUs: 0, endUs: 80000, axis: 'pts' as const } };
  const source = { info: { source: { url: 'http://localhost/api/media/media?v=version' } } } as any;
  const summaries = [0, 1].map(au => summaryOf({ ...result(), sourcePtsUs: 100 + au * 40000, sourceDtsUs: null,
    picture: { ...result().picture, sourceVersion: target.sourceVersion, au }, gop: { startAu: 0, endAu: 2, configuration: 0, anchor: 'closed' },
    nalus: [{ offset: 0, size: 1, type: 5, temporalId: 0, layer: 0 }] }));
  const plan = makeDemandPlan([0, 1].map(au => ({ au, pts: 100 + au * 40000, dts: null, configuration: 0, offset: au, size: 1, key: au === 0 })), target, 'test');
  let mode = 'valid', downloads = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'DELETE') return Response.json({ ok: true });
    if (url.includes('capabilities')) return Response.json({ buildId: 'test' });
    if (init?.method === 'POST') return Response.json({ requestId: 'request' });
    if (url.includes('/chunks/')) { downloads++; throw Error('unexpected picture download'); }
    assert.equal(new URL(url).searchParams.get('pack'), 'gop');
    const batch = structuredClone(summaries);
    if (mode === 'build') batch[1].buildId = 'other';
    if (mode === 'duplicate') batch[1] = batch[0];
    return Response.json({ state: 'complete', seq: 1, buildId: 'test', published: 2, plan,
      progress: { pictures: 2, totalPictures: 2, totalUs: 80000, checkedUs: 80000, indexComplete: true },
      chunks: [{ startCursor: 1, cursor: mode === 'cursor' ? 3 : 2, cachedGop: batch }] });
  };
  try {
    for (mode of ['valid', 'build', 'duplicate', 'cursor']) {
      const counts: number[] = [], service = new BitstreamAnalysisService(() => { const count = service.state.stream?.pictures; if (count !== undefined) counts.push(count); });
      if (mode === 'valid') {
        assert.equal((await service.requestStream(source, target, 'A')).pictures, 2);
        assert.ok(!counts.includes(1), 'a cached GOP becomes visible in a single publication');
        assert.equal(service.queryChart(target.sourceVersion, 100, 80100, 100).count, 2);
      } else {
        await assert.rejects(service.requestStream(source, target, 'A'), /Invalid cached GOP/);
        assert.equal(service.queryChart(target.sourceVersion, 100, 80100, 100).count, 0, 'invalid batches publish no partial chart');
      }
      service.dispose();
    }
    assert.equal(downloads, 0);
  } finally { globalThis.fetch = saved.fetch; if (saved.location) Object.defineProperty(globalThis, 'location', saved.location); else Reflect.deleteProperty(globalThis, 'location'); }
});

test('cached GOP status bodies stay bounded even without a trustworthy content length', async () => {
  const { readSummaryStatus, SUMMARY_BATCH_LIMIT } = await import('../../shared/analysis/bitstream/products.ts');
  const maximum = SUMMARY_BATCH_LIMIT.bytes + 1024 * 1024;
  await assert.rejects(readSummaryStatus(new Response('{}', { headers: { 'content-length': String(maximum + 1) } })), /transport budget/);
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(maximum + 1)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readSummaryStatus(response), /transport budget/); assert.equal(cancelled, true);
});
