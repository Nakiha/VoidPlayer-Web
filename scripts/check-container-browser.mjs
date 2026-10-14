// Local Blob and HTTP Range exercise the same opening policy and real core.
// Synthetic long TS is deliberate: seek work must follow GOP size, not time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';

const root = await mkdtemp(path.join(tmpdir(), 'vp-containers-'));
const engine = process.argv[2] ?? 'chromium';
let library, server, browser;
try {
  const encode = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 60000 });
  encode(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '70', '-an',
    '-c:v', 'mpeg2video', '-threads', '2', '-g', '12', '-bf', '2', '-b:v', '4M',
    '-muxrate', '16000000', '-f', 'mpegts', path.join(root, 'mpeg2.ts')]);
  encode(['-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=25', '-t', '3', '-an',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-g', '25', '-bf', '0',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', path.join(root, 'h264.mp4')]);
  encode(['-i', path.join(root, 'h264.mp4'), '-c', 'copy', '-f', 'mpegts', path.join(root, 'h264.ts')]);
  // The misleading suffix must not send local TS through Mp4Engine.
  await copyFile(path.join(root, 'mpeg2.ts'), path.join(root, 'renamed.mp4'));
  library = new MediaLibraryIndex([root], { watch: false }); await library.refresh();
  server = createMediaServer({ library, roots: library.roots, staticDir: path.resolve('dist'), onLog() {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
    ...(engine === 'chromium' && process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  for (const [name, local, software] of [
    ['renamed.mp4', true, false], ['mpeg2.ts', false, false],
    ['h264.ts', true, false], ['h264.ts', false, false],
    ['h264.mp4', true, false], ['h264.mp4', false, false],
    ['h264.ts', true, true], ['h264.ts', false, true],
  ]) {
    const context = await browser.newContext({locale:'zh-CN'}), page = await context.newPage(), errors = [], requests = [];
    let libraryEntryId;
    // Observe the real C boundary without changing packet data, clocks or decode.
    await page.addInitScript(()=>{window.__packetWork={accepted:0,receives:0,containerOpens:0};window.__indexStreams=[];const Base=Worker;window.Worker=class extends Base{constructor(url,options){super(url,options);this.addEventListener('message',event=>{if(event.data?.type==='container-test-work')window.__packetWork=event.data.work;if(event.data?.type==='container-test-index'){const message=event.data;let stream=window.__indexStreams.find(stream=>stream.id===message.id);if(!stream){stream={id:message.id,events:[],done:false,error:null};window.__indexStreams.push(stream);}if(message.error)stream.error=message.error;if(message.event){stream.events.push(message.event);if(message.event.type==='complete')stream.done=true;}}});}};});
    await context.route(/voidplayer-core(?:-mt)?\.js(?:\?|$)/,async route=>{
      const response=await route.fetch(),body=await response.text();let matched=false;
      const wrapped=body.replace(/export\s+default\s+([\w$]+)\s*;/,(_,name)=>{matched=true;return `const original=${name};export default async options=>{const core=await original(options),work={accepted:0,receives:0,containerOpens:0},ccall=core.ccall;core.ccall=function(name,result,types,args){const value=ccall.call(core,name,result,types,args);if(name==='vp_packet_send'&&args?.[4]===0&&value===0)work.accepted++;if(name==='vp_packet_receive')work.receives++;if(['vp_open','vp_open_blob','vp_open_range'].includes(name))work.containerOpens++;self.postMessage({type:'container-test-work',work:{...work}});return value;};return core;};`;});
      assert.ok(matched,'real core export is instrumented');await route.fulfill({response,body:wrapped});
    });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/media\/[0-9a-f]+$/.test(new URL(r.url()).pathname)) requests.push(r.headers()); });
    // Capture from the Worker that owns the actual request. Chromium does not
    // expose every Worker response body through Network.getResponseBody.
    await context.route(/packet-worker-[^/]+\.js(?:\?|$)/,async route=>{
      const response=await route.fetch(),body=await response.text();
      const observe=`const originalFetch=self.fetch.bind(self);self.fetch=async(...args)=>{const response=await originalFetch(...args),url=new URL(String(args[0]),self.location.href);if(url.pathname.endsWith('/frame-index')&&url.searchParams.get('kind')==='js-ts'){const id=crypto.randomUUID(),reader=response.clone().body.getReader(),decoder=new TextDecoder();void(async()=>{let pending='',complete=false;try{for(;;){const chunk=await reader.read();pending+=decoder.decode(chunk.value,{stream:!chunk.done});let at;while((at=pending.indexOf('\\n'))>=0){const line=pending.slice(0,at);pending=pending.slice(at+1);if(!line)continue;const event=JSON.parse(line);self.postMessage({type:'container-test-index',id,event});if(event.type==='complete')complete=true;}if(chunk.done)break;}}catch(error){if(!complete)self.postMessage({type:'container-test-index',id,error:String(error)});}finally{reader.releaseLock();}})();}return response;};`;
      await route.fulfill({response,body:observe+body});
    });
    await page.addInitScript(software => {
      localStorage.setItem('voidplayer.color-mode', software ? 'reference' : 'browser');
      localStorage.setItem('voidplayer.reference-decode', JSON.stringify({ decoder: software ? 'software' : 'hardware', depth: 2 }));
    }, software);
    try {
      await page.goto(base); await page.waitForFunction(() => window.voidPlayer);
      const call = (name, args = {}) => page.evaluate(({ name, args }) => window.voidPlayer.tools.find(t => t.name === name).execute(args), { name, args });
      if (local) {
        await page.locator('#file-A').setInputFiles(path.join(root, name));
        await page.waitForFunction(() => !window.voidPlayer.getState().busy && window.voidPlayer.getState().tracks[0]?.frame, null, { timeout: 60000 });
      } else {
        const listing = await call('list_library');
        const entry = listing.entries.find(e => e.name === name);
        assert.ok(entry, `library fixture ${name} is listed`);
        libraryEntryId = entry.id;
        await call('load_library_item', { id: libraryEntryId, slot: 'A' });
      }
      const first = await call('get_review_session'), long = name === 'mpeg2.ts' || name === 'renamed.mp4';
      if (!local && name === 'mpeg2.ts') {
        assert.equal(first.error, null);
        assert.equal(first.tracks[0].indexSource, 'server', 'cold JS library index must import from the server');
        assert.ok(first.tracks[0].frame, 'the complete JS index yields a real presentable frame');
        await page.waitForFunction(()=>window.__indexStreams.some(stream=>stream.done||stream.error),null,{timeout:180000});
        const coldStream=await page.evaluate(()=>window.__indexStreams[0]);
        assert.equal(coldStream.error,null);
        const indexEvents=coldStream.events;
        assert.ok(indexEvents.some(event => event.type === 'complete'), 'cold JS index stream reaches completion');
        const manifestAt=indexEvents.findIndex(event=>event.type==='manifest'&&event.protocol===1&&event.kind==='js-ts'&&event.state==='building');
        const scans=indexEvents.map((event,index)=>event.type==='progress'&&event.phase==='scan'?index:-1).filter(index=>index>=0);
        const manifest=indexEvents.find(event=>event.type==='manifest'&&event.state==='complete'),batches=indexEvents.filter(event=>event.type==='batch'),completeAt=indexEvents.findIndex(event=>event.type==='complete');
        const batchPositions=indexEvents.map((event,index)=>event.type==='batch'?index:-1).filter(index=>index>=0);
        assert.ok(manifestAt>=0&&scans.length&&Math.min(...scans)>manifestAt,'JS cold stream reports real scan progress');
        assert.ok(batchPositions.length&&Math.max(...scans)<Math.min(...batchPositions),'full scan precedes completed JS document transfer');
        assert.ok(completeAt>Math.max(...batchPositions),'finality follows every document chunk');
        assert.equal(manifest.protocol,1);assert.equal(manifest.kind,'js-ts');assert.equal(manifest.encoding,'json-utf8-base64');
        assert.deepEqual(batches.map(event=>event.seq),batches.map((_,index)=>index));
        const documentBytes=Buffer.concat(batches.map(event=>Buffer.from(event.data,'base64'))),document=JSON.parse(documentBytes.toString());
        assert.equal(documentBytes.length,manifest.totalBytes);assert.equal(document.epoch,manifest.epoch);
        assert.equal(indexEvents[completeAt].lastSeq,manifest.lastSeq);assert.equal(indexEvents[completeAt].totalBytes,manifest.totalBytes);
        assert.equal(document.index.kind,'js-ts-packets');assert.equal(document.index.codec,'mpeg2video');
        assert.equal(document.index.completeness.state,'complete');assert.equal(document.index.packets.length,1750);
        assert.equal(document.index.sourceVersion,first.tracks[0].id);
        assert.ok(first.tracks[0].jsIndexReused&&first.tracks[0].jsIndexPacketsScanned<=2,'cold server document avoids client scan');
        const coldStreamCount=await page.evaluate(()=>window.__indexStreams.length);
        await call('remove_review_track', { slot: 'A' });
        await call('load_library_item', { id: libraryEntryId, slot: 'A' });
        const warm = await call('get_review_session');
        assert.equal(warm.error, null);
        assert.equal(warm.tracks[0].indexSource,'server');
        assert.ok(warm.tracks[0].jsIndexReused&&warm.tracks[0].jsIndexPacketsScanned<=2,'warm server cache avoids packet rescan');
        await page.waitForFunction(count=>window.__indexStreams.length===count+1&&(window.__indexStreams.at(-1).done||window.__indexStreams.at(-1).error),coldStreamCount,{timeout:60000});
        const warmStream=await page.evaluate(()=>window.__indexStreams.at(-1));assert.equal(warmStream.error,null);
        const warmEvents=warmStream.events;
        assert.ok(!warmEvents.some(event=>event.state==='building'||event.phase==='scan'),'warm cache performs no server rebuild');
        assert.deepEqual(Buffer.concat(warmEvents.filter(event=>event.type==='batch').map(event=>Buffer.from(event.data,'base64'))),documentBytes,'warm document retains source/build/packet identities');
      }
      assert.equal(first.error, null);
      assert.equal(first.tracks[0].container, name === 'h264.mp4' ? 'isobmff' : 'mpegts');
      const usesFfmpegDecoder = first.tracks[0].decoder === 'ffmpeg-wasm';
      if (long || software || usesFfmpegDecoder) await page.waitForFunction(() => window.voidPlayer.getState().tracks[0]?.indexState === 'complete', null, { timeout: 60000 });
      const final = await call('get_review_session');
      assert.equal(final.error, null);
      if (name === 'h264.ts' || long) {
        assert.equal(final.tracks[0].indexKind,'packet-locators','admitted H.264 TS uses the verified JS packet index');
        assert.equal(final.tracks[0].seekStrategy,'packet-anchor');
        assert.equal(final.tracks[0].indexState,'complete');
        assert.equal(final.tracks[0].decoder,long||software?'ffmpeg-wasm':'webcodecs','decoder selection preserves the JS TS demux/index');
        assert.ok(final.tracks[0].seekAnchorCount>0);
      } else if (software || usesFfmpegDecoder) {
        assert.equal(final.tracks[0].decoder, 'ffmpeg-wasm');
        assert.equal(final.tracks[0].indexState, 'complete');
        assert.equal(final.tracks[0].seekStrategy, 'packet-anchor');
        assert.ok(final.tracks[0].seekAnchorCount > 0);
      } else if (name === 'h264.mp4') assert.equal(first.tracks[0].decoder, 'webcodecs', 'supported H.264 MP4 uses native decode');
      else assert.fail(`Unexpected unclassified container fixture: ${name}`);
      const timings = [],seekWork=[];
      for (const ptsUs of long ? [10e6, 36e6, 64e6, 10e6, 0] : [1e6, 2e6, 0]) {
        const before=await page.evaluate(()=>({...window.__packetWork})),requestStart=requests.length;
        const start = performance.now(); await call('seek_review', { ptsUs });
        const after=await page.evaluate(()=>({...window.__packetWork}));
        seekWork.push({ptsUs,accepted:after.accepted-before.accepted,receives:after.receives-before.receives,ranges:requests.slice(requestStart).map(headers=>headers.range)});
        timings.push(Math.round(performance.now() - start));
        const state = await call('get_review_session');
        assert.equal(state.error, null); assert.equal(state.tracks[0].frame.ptsUs, ptsUs);
      }
      const logs = await call('get_review_logs', { limit: 500 });
      assert.ok(logs.events.some(e => e.msg === '媒体适配器选择' && e.data.software === (name === 'h264.mp4' ? 'packet-mp4' : 'packet-ts')));
      assert.ok(!logs.events.some(e => /MP4 压缩包路径不可用/.test(e.msg)), 'TS never attempts the MP4 packet adapter');
      if (name==='h264.ts'||long) {
        const traces=logs.events.filter(e=>e.msg==='媒体管线追踪').map(e=>e.data);
        assert.ok(traces.some(e=>e.demuxBackend==='js-ts-packets'&&e.indexBackend==='js-ts-packet-index'));
        assert.ok(!traces.some(e=>e.demuxBackend==='ffmpeg-wasm'),'admitted TS never selects a container demux route');
      }
      if (long) {
        assert.equal(seekWork.length,5,'each requested forward/backward seek is measured');
        for(const seek of seekWork){assert.ok(seek.accepted>0&&seek.accepted<=30,JSON.stringify(seek));assert.ok(seek.receives>0&&seek.receives<=62,JSON.stringify(seek));}
        assert.equal((await page.evaluate(()=>window.__packetWork)).containerOpens,0,'packet decoding never opens the FFmpeg container API');
        console.log(`TS WORK ${JSON.stringify({local,timings,seeks:seekWork})}`);
      }
      if (!local) assert.ok(requests.length && requests.every(r => /^bytes=/.test(r.range ?? '')), 'remote reads are Range requests');
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine}: ${name} ${local ? 'local' : 'remote'} ${software ? 'software reference' : 'browser'} -> ${first.tracks[0].decoder}`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  await library?.close(); await rm(root, { recursive: true, force: true });
}
