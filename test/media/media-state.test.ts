import { BrowserWorker } from '../helpers/browser-worker-host.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {updateMediaInfo,recordPresentedFrame} from '../../src/media/state.ts';
import {rgbaDescription} from '../../shared/media/frame-description.ts';
import type {DecodedFrame,MediaSource} from '../../src/media/contract.ts';
import {ReviewSession} from '../../src/session.ts';
import {openPacketMedia} from '../../src/media/decoding/packet-media.ts';
import type {MediaInfo} from '../../shared/media/types.ts';
import type {MediaInfoChange} from '../../src/media/state.ts';
import { visiblePixelHash } from '../helpers/visible-pixels.ts';

test('software admission hands its validated frame to presentation without another packet decode', async () => {
  const file = new File([await readFile(new URL('../../fixtures/fate/h264--extradata-reload-multi-stsd.mov', import.meta.url))], 'multi.mov');
  const requests: string[] = [];
  const source = await openPacketMedia('mp4', { file }, file, {
    forceWasm: true, glueURL: new URL('../../public/vendor/voidplayer-core/voidplayer-core.js', import.meta.url).href,
    wasmBinary: await readFile(new URL('../../public/vendor/voidplayer-core/voidplayer-core.wasm', import.meta.url)),
    workerFactory() {
      const worker = new BrowserWorker(new URL('../../src/media/decoding/packet-worker.ts', import.meta.url));
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (message, transfer) => { requests.push(message.type); post(message, transfer); };
      return worker as unknown as Worker;
    },
  });
  try {
    await source.admitReference!(1);
    assert.equal(requests.filter(type => type === 'at').length, 1, 'admission consumes the primed frame');
    const first = await source.frameAt(0);
    assert.equal(requests.filter(type => type === 'at').length, 1, 'presentation consumes the validated frame');
    const hash = visiblePixelHash(first.description, first.pixels!);
    first.close();
    const replay = await source.frameAt(0);
    assert.equal(requests.filter(type => type === 'at').length, 2, 'the handoff is consumed exactly once');
    assert.equal(visiblePixelHash(replay.description, replay.pixels!), hash);
    replay.close();

    await source.reconfigureColorMode!('reference', { decoder: 'software', depth: 1 });
    const later = await source.frameAt(80000);
    assert.equal(later.width, 128, 'a seek must discard the pending origin and decode the requested configuration');
    later.close();
    const returned = await source.frameAt(0);
    assert.equal(returned.width, 256);
    assert.equal(visiblePixelHash(returned.description, returned.pixels!), hash);
    returned.close();

    await source.reconfigureColorMode!('reference', { decoder: 'software', depth: 1 });
    const following = await source.framesAfter(0, 3);
    assert.ok(following.length > 0);
    following.forEach(frame => frame.close());
    const count = requests.filter(type => type === 'at').length;
    const afterStream = await source.frameAt(0);
    assert.equal(requests.filter(type => type === 'at').length, count + 1, 'streaming invalidates the pending origin');
    assert.equal(visiblePixelHash(afterStream.description, afterStream.pixels!), hash);
    afterStream.close();

    const frameAt = source.frameAt.bind(source);
    let closed = 0, validated: DecodedFrame | undefined;
    source.frameAt = async pts => {
      const frame = await frameAt(pts), close = frame.close.bind(frame);
      frame.close = () => { closed++; close(); };
      validated = frame;
      return frame;
    };
    await source.reconfigureColorMode!('reference', { decoder: 'software', depth: 1 });
    assert.equal(closed, 0);
    await source.reconfigureColorMode!('reference', { decoder: 'software', depth: 1 });
    assert.equal(closed, 1, 'reconfiguration releases the previous unconsumed validation frame');
    const controller = new AbortController();
    const captured = source.frameAt;
    source.frameAt = async pts => { const frame = await captured(pts); controller.abort(); return frame; };
    await assert.rejects(source.reconfigureColorMode!('reference', { decoder: 'software', depth: 1 }, controller.signal), { name: 'AbortError' });
    assert.equal(closed, 3, 'cancellation closes both the previous and late validation frame');
    source.frameAt = captured;
    await source.reconfigureColorMode!('reference', { decoder: 'software', depth: 1 });
    assert.ok(validated);
    source.dispose();
    assert.equal(closed, 4, 'disposing the source releases its unconsumed frame');
    source.dispose();
    assert.equal(closed, 4);
  } finally { source.dispose(); }
});
test('metadata changes increment one revision and emit detached complete snapshots',()=>{
  const events:MediaInfoChange[]=[];
  const source={info:{id:'test',name:'test',size:1,lastModified:0,codec:'h264',decoder:'webcodecs',width:256,height:128,durationUs:40000,firstPtsUs:0} as MediaInfo,onInfoChange:(c?:MediaInfoChange)=>events.push(c!)};
  assert.equal(updateMediaInfo(source,{durationUs:80000,indexState:'complete',indexWarning:'tail'},'index'),true);
  assert.equal(events.length,1);assert.equal(events[0].revision,1);assert.equal(events[0].before.durationUs,40000);assert.equal(events[0].after.durationUs,80000);
  assert.equal(updateMediaInfo(source,{durationUs:80000,indexState:'complete',indexWarning:'tail'},'index'),false);
  assert.equal(events.length,1);updateMediaInfo(source,{indexWarning:undefined},'index');assert.equal(events[1].revision,2);assert.equal(events[0].after.indexWarning,'tail');
});
test('presented source tags retain provenance without replacing resource tags',()=>{
  const sourceColor={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:true};
  const resourceColor={primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false};
  const source={info:{id:'tags',name:'tags',size:1,lastModified:0,codec:'hevc',decoder:'webcodecs',width:2,height:2,durationUs:40000,firstPtsUs:0}} as MediaSource;
  for(const origin of ['container','decoder',undefined] as const){
    const description=rgbaDescription(2,2,{sourceColor,sourceColorOrigin:origin,color:resourceColor});
    const frame={width:2,height:2,description} as DecodedFrame;
    recordPresentedFrame(source,frame);
    assert.equal(source.info.colorSource,origin??'decoder');
    assert.deepEqual(source.info.color,sourceColor);
    assert.deepEqual(source.info.output?.color,resourceColor);
    assert.deepEqual(description.color,resourceColor);
  }
});
test('real WASM prefetch never changes displayed metadata; seek changes UI/Agent state after drawing',async()=>{
  const file=new File([await readFile(new URL('../../fixtures/fate/h264--extradata-reload-multi-stsd.mov',import.meta.url))],'multi.mov');
  const source=await openPacketMedia('mp4',{file},file,{forceWasm:true,glueURL:new URL('../../public/vendor/voidplayer-core/voidplayer-core.js',import.meta.url).href,wasmBinary:await readFile(new URL('../../public/vendor/voidplayer-core/voidplayer-core.wasm',import.meta.url))});
  let drawn=0;const session=new ReviewSession((_slot,f)=>{drawn=f.width;});
  try{
    await session.load('A',async()=>source);assert.equal(drawn,256);
    const before=session.getState().tracks[0];const prefetched=await source.framesAfter(0,3);prefetched.forEach(f=>f.close());
    assert.equal(session.getState().tracks[0].width,256);assert.equal(session.getState().tracks[0].metadataRevision,before.metadataRevision);
    await session.seek(80000);const after=session.getState().tracks[0];assert.equal(drawn,128);assert.equal(after.width,128);assert.equal(after.output?.width,128);assert.ok(after.metadataRevision!>before.metadataRevision!);
    await session.seek(0);assert.equal(session.getState().tracks[0].width,256);
  }finally{source.dispose();}
});
