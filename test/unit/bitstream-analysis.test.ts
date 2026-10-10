import {test} from 'node:test';import assert from 'node:assert/strict';
import {inspectPacketPicture} from '../../src/packet-picture.ts';
import {pictureId,validateResult} from '../../src/bitstream-analysis/contract.ts';
import {AnalysisCache} from '../../src/bitstream-analysis/cache.ts';
import type {AnalysisResult} from '../../src/bitstream-analysis/contract.ts';
const result=():AnalysisResult=>({schema:1,analyzerVersion:'0.1.0',buildId:'test',recipe:'blocks-basic-v1',picture:{sourceVersion:'local:uuid',stream:'video',configuration:0,au:3,picture:0,layer:0,field:'frame'},sourcePtsUs:100,width:16,height:16,confidence:'exact',reasons:[],capabilities:{blocks:'ready',qp:'ready',modes:'ready',motion:'unsupported'},qp:{component:'luma',bitDepth:8,weighting:'pixel-area',mean:23},blocks:[{x:0,y:0,width:16,height:16,qp:23,mode:'intra'}],metrics:{startAu:0,packets:4,bytesRead:1000,elapsedMs:3,recordBytes:12,heapBytes:67108864}});
test('AU admission rejects duplicate pictures, enhancement layers and malformed length prefixes',()=>{
 const config=new Uint8Array(5);config[4]=3;
 assert.equal(inspectPacketPicture('h264',config,new Uint8Array([0,0,0,2,0x65,0x80])).closedRandomAccess,true);
 assert.equal(inspectPacketPicture('h264',config,new Uint8Array([0,0,0,2,0x65,0x80,0,0,0,2,0x61,0x80])).singlePicture,false);
 assert.equal(inspectPacketPicture('h264',config,new Uint8Array([0,0,0,20,0x65,0x80])).singlePicture,false);
 const hevc=new Uint8Array(22);hevc[21]=3;
 assert.equal(inspectPacketPicture('hevc',hevc,new Uint8Array([0,0,0,3,0x26,1,0x80])).closedRandomAccess,true);
 assert.equal(inspectPacketPicture('hevc',hevc,new Uint8Array([0,0,0,3,0x2a,1,0x80])).closedRandomAccess,false,'CRA is not a closed IDR');
 assert.equal(inspectPacketPicture('hevc',hevc,new Uint8Array([0,0,0,3,0x27,1,0x80])).singlePicture,false);
});
test('exact results require complete nonoverlapping coded coverage',()=>{const r=result();validateResult(r);r.blocks.push({...r.blocks[0]});assert.throws(()=>validateResult(r),/Overlapping/);r.blocks=[];assert.throws(()=>validateResult(r),/Incomplete/);});
test('cache uses persistent picture identity and releases detached copies',()=>{const cache=new AnalysisCache(),r=result();cache.put(r);r.blocks[0].qp=2;const hit=cache.get(r.picture)!;assert.equal(hit.blocks[0].qp,23);hit.blocks[0].qp=0;assert.equal(cache.get(r.picture)!.blocks[0].qp,23);assert.equal(cache.get({...r.picture,sourceVersion:'other'}),null);assert.notEqual(pictureId(r.picture),pictureId({...r.picture,configuration:1}));cache.clear();assert.equal(cache.sizeBytes,0);});
test('coded crop and rotation share the presenter rectangle and have an exact inverse',async()=>{
 const {codedToViewport,viewportToCoded}=await import('../../src/analysis-overlay/geometry.ts');
 for(const rotation of [0,90,180,270]){const token:any={geometry:{visibleRect:{x:8,y:4,width:64,height:32},rotation}};const g={width:500,height:400,imageWidth:256,imageHeight:128,zoom:3,offsetX:11,offsetY:-9,dpr:2};const projected=codedToViewport(24,12,token,g),inverse=viewportToCoded(projected.x,projected.y,token,g);assert.equal(inverse.x,24);assert.equal(inverse.y,12);}
});
test('atomic cache rejects corrupted and incomplete chunks; quota evicts old pictures',async()=>{
 const {AnalysisStore}=await import('../../server/analysis/store.ts');const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const folder=await mkdtemp(join(tmpdir(),'vp-analysis-store-'));
 try{const store=new AnalysisStore(folder,1100),a='a'.repeat(64),b='b'.repeat(64),r=result();await store.put(a,r);assert.deepEqual(await new AnalysisStore(folder).get(a),r);await writeFile(join(folder,a+'.json'),'truncated');assert.equal(await store.get(a),null);await store.put(a,r);await store.put(b,{...r,picture:{...r.picture,au:4}});assert.equal(await store.get(a),null);assert.ok(await store.get(b));await store.put('c'.repeat(64),{...r,confidence:'partial',reasons:['missing-reference'],blocks:[]});assert.equal(await store.get('c'.repeat(64)),null);}finally{await rm(folder,{recursive:true,force:true});}
});
