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
