import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {updateMediaInfo} from '../src/media-state.ts';
import {ReviewSession} from '../src/session.ts';
import {openFFmpegMedia} from '../src/ffmpeg-media.ts';
import type {MediaInfo} from '../src/model.ts';
import type {MediaInfoChange} from '../src/media-state.ts';
test('metadata changes increment one revision and emit detached complete snapshots',()=>{
  const events:MediaInfoChange[]=[];
  const source={info:{id:'test',name:'test',size:1,lastModified:0,codec:'h264',decoder:'webcodecs',width:256,height:128,durationUs:40000,firstPtsUs:0} as MediaInfo,onInfoChange:(c?:MediaInfoChange)=>events.push(c!)};
  assert.equal(updateMediaInfo(source,{durationUs:80000,indexState:'complete',indexWarning:'tail'},'index'),true);
  assert.equal(events.length,1);assert.equal(events[0].revision,1);assert.equal(events[0].before.durationUs,40000);assert.equal(events[0].after.durationUs,80000);
  assert.equal(updateMediaInfo(source,{durationUs:80000,indexState:'complete',indexWarning:'tail'},'index'),false);
  assert.equal(events.length,1);updateMediaInfo(source,{indexWarning:undefined},'index');assert.equal(events[1].revision,2);assert.equal(events[0].after.indexWarning,'tail');
});
test('real WASM prefetch never changes displayed metadata; seek changes UI/Agent state after drawing',async()=>{
  const file=new File([await readFile(new URL('../fixtures/fate/h264--extradata-reload-multi-stsd.mov',import.meta.url))],'multi.mov');
  const source=await openFFmpegMedia(file,{glueURL:new URL('../public/vendor/voidplayer-core/voidplayer-core.js',import.meta.url).href,wasmBinary:await readFile(new URL('../public/vendor/voidplayer-core/voidplayer-core.wasm',import.meta.url))});
  let drawn=0;const session=new ReviewSession((_slot,f)=>{drawn=f.width;});
  try{
    await session.load('A',async()=>source);assert.equal(drawn,256);
    const before=session.getState().tracks[0];const prefetched=await source.framesAfter(0,3);prefetched.forEach(f=>f.close());
    assert.equal(session.getState().tracks[0].width,256);assert.equal(session.getState().tracks[0].metadataRevision,before.metadataRevision);
    await session.seek(80000);const after=session.getState().tracks[0];assert.equal(drawn,128);assert.equal(after.width,128);assert.equal(after.output?.width,128);assert.ok(after.metadataRevision!>before.metadataRevision!);
    await session.seek(0);assert.equal(session.getState().tracks[0].width,256);
  }finally{source.dispose();}
});
