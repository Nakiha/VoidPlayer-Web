import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressWorkspace, parseWorkspace, readWorkspaceFile } from '../src/workspace-file.ts';
import { Viewport } from '../src/viewport.ts';
const document = () => ({schema:'voidplayer-workspace',version:1,generatedAt:new Date().toISOString(),serverUrl:'http://localhost:5180/',positionUs:500,
  tracks:[{slot:'A',mediaId:'a',offsetUs:0}],media:[{id:'a',name:'movie.mp4',size:100,lastModified:0,codec:'h264',decoder:'webcodecs',width:100,height:100,durationUs:1000,firstPtsUs:0,source:{kind:'library',id:'server-id',url:'/api/media/server-id'}}],marks:[],viewport:new Viewport().snapshot()});
test('plain and gzip workspace files resolve recorded server URLs and preserve the same validated data',async()=>{
 const value=parseWorkspace(document()), gzip=await compressWorkspace(value);
 assert.equal(value.media[0].source!.url,'http://localhost:5180/api/media/server-id');
 assert.deepEqual(await readWorkspaceFile(gzip,'http://another-host/'),value);
 assert.deepEqual(await readWorkspaceFile(new Blob([JSON.stringify(value)]),'http://another-host/'),value);
});
test('reject unsupported versions, unsafe URLs, duplicate slots, invalid refs and negative end times before load',()=>{
 const mutations: ((d: ReturnType<typeof document>) => unknown)[] = [d=>d.version=2,d=>d.media[0].source.url='file:///etc/passwd',d=>d.media[0].source.url='https://user:pass@example.com/v',d=>d.tracks.push({...d.tracks[0]}),d=>d.tracks[0].mediaId='absent',d=>d.tracks[0].offsetUs=-1000,d=>d.viewport.zoom=Infinity];
 for(const mutate of mutations) {
  const value=document();mutate(value);assert.throws(()=>parseWorkspace(value));
 }
});
test('old review exports remain readable with current-host relative sources and a default view',()=>{
 const d=document();const old={schema:'voidplayer-web-review',version:1,generatedAt:d.generatedAt,media:d.media,marks:[],alignment:d.tracks};
 const restored=parseWorkspace(old,'http://old-server/');assert.equal(restored.positionUs,0);assert.equal(restored.media[0].source!.url,'http://old-server/api/media/server-id');
});

test('workspace library navigation and pending search survive plain and compressed round trips',async()=>{
 const sources={tab:'recent',query:'最新片源',root:'root-1',directory:'评审/镜头 A',search:'hevc',all:false};
 const value=parseWorkspace({...document(),layout:{panels:{inspector:false,subtracks:true,sources:true},selected:'A',dockHeight:180,marksExpanded:false,sources}});
 assert.deepEqual(value.layout?.sources,sources);
 assert.deepEqual((await readWorkspaceFile(await compressWorkspace(value),'http://localhost/')).layout?.sources,sources);
  for(const invalid of [{...sources,tab:'invalid'},{...sources,all:'yes'},{...sources,query:'x'.repeat(1001)}])assert.throws(()=>parseWorkspace({...value,layout:{...value.layout,sources:invalid}}));
  assert.equal(parseWorkspace(document()).layout,undefined);
});

test('analysis panel state survives workspace round trips, invalid blocks are rejected',async()=>{
  const analysisView={view:{start:1000000,end:2000000},axis:'pts',windowUs:250000,layoutMode:'merged',showBitrate:true,showSize:false,follow:false,selected:['A','B'],numAxis:'pts'};
  const value=parseWorkspace({...document(),layout:{panels:{inspector:false,subtracks:true,sources:true,analysis:true},selected:'A',dockHeight:180,marksExpanded:false,analysisView}});
  assert.deepEqual(value.layout?.analysisView,analysisView);
  assert.deepEqual((await readWorkspaceFile(await compressWorkspace(value),'http://localhost/')).layout?.analysisView,analysisView);
  // 完整范围用 null 表示。
  const full=parseWorkspace({...document(),layout:{panels:{inspector:false,subtracks:true,sources:true},selected:'A',dockHeight:180,marksExpanded:false,analysisView:{...analysisView,view:null}}});
  assert.equal(full.layout?.analysisView?.view,null);
  // 无该块的老文件仍可读。
  assert.equal(parseWorkspace(document()).layout,undefined);
  for(const invalid of [
    {...analysisView,axis:'dts2'},
    {...analysisView,windowUs:123},
    {...analysisView,layoutMode:'auto'},
    {...analysisView,view:{start:2000000,end:1000000}},
    {...analysisView,view:{start:1000000,end:1000000}},
    {...analysisView,selected:['Z']},
    {...analysisView,selected:'A'},
  ])assert.throws(()=>parseWorkspace({...document(),layout:{panels:{inspector:false,subtracks:true,sources:true},selected:'A',dockHeight:180,marksExpanded:false,analysisView:invalid}}));
});

test('comparison contract round trips and rejects unsupported semantics rather than silently changing conditions', async () => {
  const comparison = { version: 1, colorMode: 'reference', referenceDecode: { decoder: 'software', depth: 2 }, presentation: 'voidplayer-sdr-v1', outputColorSpace: 'srgb' };
  const parsed = parseWorkspace({ ...document(), comparison });
  assert.deepEqual((await readWorkspaceFile(await compressWorkspace(parsed), 'http://localhost/')).comparison, comparison);
  assert.equal(parseWorkspace(document()).comparison, undefined);
  for (const invalid of [{ ...comparison, presentation: 'hdr-reference' }, { ...comparison, version: 2 }, { ...comparison, referenceDecode: { decoder: 'hardware', depth: 3 } }]) assert.throws(() => parseWorkspace({ ...document(), comparison: invalid }));
});

 test('track visibility is optional for older workspaces and validated when present', async () => {
   const old = document();
   assert.equal(parseWorkspace(old).tracks[0].visible, undefined);
   const value = { ...old, tracks: [{ ...old.tracks[0], visible: false }] };
   const restored = await readWorkspaceFile(await compressWorkspace(parseWorkspace(value)), old.serverUrl);
   assert.equal(restored.tracks[0].visible, false);
   assert.throws(() => parseWorkspace({ ...old, tracks: [{ ...old.tracks[0], visible: 'false' }] }));
 });
