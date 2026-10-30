import { playbackBenchmarksEnabled, verifyPlaybackPresentation } from './testing/playback-presentation.mjs';
// Production Worker path: native-decode rejection must lead to bounded packet IO.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm,readdir } from 'node:fs/promises';
import { RangeReader } from '../shared/media/io/range-reader.ts';
import { readMp4Configurations } from '../shared/media/containers/mp4-config.ts';
import { mp4BoundaryFixture } from './mp4-boundary-fixture.ts';
import { chromium, webkit } from 'playwright';
import { createMediaServer } from '../server/app.ts';
const root = path.resolve(import.meta.dirname, '..');
const name = process.argv[2] ?? 'webkit';
const temporary = await mkdtemp(path.join(os.tmpdir(), 'vp-range-browser-'));
const boundary = await mp4BoundaryFixture();
await writeFile(path.join(temporary, 'h264_boundary.mp4'), boundary.oversized);
const tableReader = new RangeReader({ file: new Blob([boundary.valid]) });
const table = await readMp4Configurations(tableReader, 1); tableReader.close();
await writeFile(path.join(temporary, 'h264_truncated.mp4'), boundary.valid.subarray(0, table.sampleOffsets[13] + 1));
const server = createMediaServer({ roots: [path.join(root, 'fixtures/video'),path.join(root,'fixtures/demux-removal'), temporary], staticDir: path.join(root, 'dist'), onLog() {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await (name === 'chromium' ? chromium : webkit).launch({ headless: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  const packetWorker='/assets/'+(await readdir(path.join(root,'dist/assets'))).find(file=>/^packet-worker-.*\.js$/.test(file));
  for (const file of ['h266_10s_1920x1080.mp4', 'h264_high422p_1s_320x180.mp4', 'ffv1_yuv422p_8bit.mkv', 'h264_boundary.mp4', 'h264_truncated.mp4']) {
    const page = await browser.newPage({locale:'zh-CN'});
    // Exercise unreadable main-thread resources after real packet open and
    // transfer, through playback and seek. Worker receive is covered separately
    // in decoder-policy.test.ts; this does not emulate hardware decoding.
    if (file === 'h264_truncated.mp4') await page.addInitScript(() => {
      Object.defineProperty(VideoFrame.prototype, 'format', { configurable: true, get() { return null; } });
      VideoFrame.prototype.allocationSize = function() { throw new DOMException('Opaque frame', 'NotSupportedError'); };
    });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/\/api\/media\/[0-9a-f]+$/.test(new URL(r.url()).pathname)) requests.push(r.headers()); });
    try {
      await page.goto(base); await page.waitForFunction(() => !!window.voidPlayer);
      // Assert decoder-capability policy explicitly in browser matching mode.
      await page.evaluate(() => window.voidPlayer.tools.find(t => t.name === 'set_review_color_mode').execute({ mode: 'browser' }));
      const result = await page.evaluate(async ({ file, playbackBenchmarksEnabled }) => {
        const call = (name, params = {}) => window.voidPlayer.tools.find(t => t.name === name).execute(params);
        const listing = await call('list_library', { search: file });
        const item = listing.entries.find(e => e.name === file);
        if (!item) throw new Error('Missing Range fixture: ' + file);
        await call('load_library_item', { id: item.id, slot: 'A' });
        const first = await call('get_review_session');
        const duration = first.tracks[0].durationUs;
        let boundary;
        if (file === 'h264_truncated.mp4') {
          // Sample 13 is incomplete; discard its entire GOP, including the
          // three earlier packets in that GOP, rather than exposing them.
          await call('seek_review', { ptsUs: 1299999 });
          const tail = (await call('get_review_session')).tracks[0].frame.ptsUs;
          await call('step_review', { direction: 1 });
          const afterEnd = (await call('get_review_session')).tracks[0].frame.ptsUs;
          await call('step_review', { direction: -1 });
          const previous = (await call('get_review_session')).tracks[0].frame.ptsUs;
          boundary = { tail, afterEnd, previous };
        }
        const seekFrames = [];
        for (const ptsUs of [Math.floor(duration * .6), 0, duration - 1, 0]) {
          await call('seek_review', { ptsUs });
          seekFrames.push((await call('get_review_session')).tracks[0].frame.ptsUs);
        }
        await call('step_review', { direction: 1 });
        const last = await call('get_review_session');
        const bench = playbackBenchmarksEnabled ? await call('benchmark_review', { durationMs: 1000 }) : undefined;
        return { first, last, bench, boundary, seekFrames };
      }, { file, playbackBenchmarksEnabled });
      if (!playbackBenchmarksEnabled) result.functionalPresentation = await verifyPlaybackPresentation(page);
      assert.deepEqual(errors, []);
      // New Chromium builds can decode High 4:2:2 natively. Preserve the
      // capability-first policy; VVC and FFV1 exercise mandatory WASM here.
      if (!file.startsWith('h264_')) assert.equal(result.first.tracks[0].decoder, 'ffmpeg-wasm');
      else assert.ok(['webcodecs', 'ffmpeg-wasm'].includes(result.first.tracks[0].decoder));
      if (file === 'h264_boundary.mp4') {
        assert.equal(result.first.tracks[0].decoder, 'webcodecs', 'intact samples in an overdeclared mdat retain native decoding');
        assert.match(result.first.tracks[0].indexWarning, /mdat/);
      }
      if (file === 'h264_truncated.mp4') {
        assert.equal(result.first.tracks[0].decoder, 'webcodecs', 'tail truncation alone must not force software decoding');
        assert.equal(result.first.tracks[0].durationUs, 1000000);
        assert.equal(result.first.tracks[0].indexIntegrity, 'prefix');
        assert.match(result.first.tracks[0].indexWarning, /前 10 个完整视频包/);
        assert.match(result.first.tracks[0].indexWarning, /GOP/);
        assert.deepEqual(result.boundary, { tail: 900000, afterEnd: 900000, previous: 800000 });
        assert.deepEqual(result.seekFrames, [600000, 0, 900000, 0]);
        assert.equal(result.last.tracks[0].frame.ptsUs, 100000);
      }
      assert.ok(result.last.tracks[0].frame.ptsUs > 0);
      assert.ok(requests.length > 0 && requests.every(r => /^bytes=/.test(r.range ?? '')));
      if (result.bench) assert.ok(!result.bench.error, JSON.stringify(result.bench));
      // Local benchmarks remain separate from the CI presentation proof.
      console.log(JSON.stringify({ browser: name, file, reads: requests.length, benchmark: result.bench, functionalPresentation: result.functionalPresentation }));
    } finally { await page.close(); }
  }
  // New finite codec cases use actual product UI loading for both local and
  // library sources. Reference/software also exercises the same JS packets
  // with a different decoder preference; no container core can be selected.
  for(const [file,format,count] of [
    ['ffv1_yuv422p_8bit.mkv','js-matroska-packets',60],['ffv1_yuv444p10le.mkv','js-matroska-packets',60],
    ['mpeg2_10s_1280x720.ts','js-ts-packets',600],['av1_10s_1920x1080.webm','js-matroska-packets',600],
    ['mpeg4.mp4','mp4-packet',24],['mjpeg.mov','mp4-packet',24],['prores.mov','mp4-packet',24],
  ])for(const mode of ['browser','reference'])for(const input of ['library','local']){
    const page=await browser.newPage({locale:'zh-CN'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(mode=>{localStorage.setItem('voidplayer.color-mode',mode);localStorage.setItem('voidplayer.reference-decode',JSON.stringify({decoder:'software',depth:2}));},mode);
    try{
      await page.goto(base);await page.waitForFunction(()=>window.voidPlayer);
      if(input==='local')await page.locator('#file-A').setInputFiles(path.join(root,file.endsWith('.mov')||file==='mpeg4.mp4'?'fixtures/demux-removal':'fixtures/video',file));
      else await page.evaluate(async file=>{const call=(name,args={})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),entry=(await call('list_library',{search:file})).entries.find(e=>e.name===file);if(!entry)throw Error('Missing fixture '+file);const result=await call('load_library_item',{id:entry.id,slot:'A'});if(result.error)throw Error(result.error);},file);
      await page.waitForFunction(file=>{const state=window.voidPlayer.getState();return !state.busy&&state.tracks[0]?.name===file&&!!state.tracks[0]?.frame;},file,{timeout:60000});
      const result=await page.evaluate(async({count,input,packetWorker,format,mode})=>{
        const call=(name,args={})=>window.voidPlayer.tools.find(t=>t.name===name).execute(args),first=(await call('get_review_session')).tracks[0],seeks=[];
        // Drain the actual compiled product Worker sequentially. UI stepping
        // deliberately probes two frames ahead and may re-seek; using its RPC
        // 'next' contract verifies every decoder output without O(GOP*frames)
        // redundant paused seeks. The UI still verifies presentation/seek/EOF.
        let outputs=1;
        if(input==='library'){
          const worker=new Worker(packetWorker,{type:'module'}),pending=new Map();let sequence=0;
          const rpc=(type,data={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(`Worker ${type} timeout`));},60000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,type,...data});});
          worker.onmessage=event=>{const m=event.data;if(typeof m.ok!=='boolean')return;const entry=pending.get(m.id);if(!entry)return;pending.delete(m.id);clearTimeout(entry.timer);m.ok?entry.resolve(m.data):entry.reject(Error(m.error));};
          worker.onerror=event=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error(event.message));}pending.clear();};
          try{
            const source=first.source,url=new URL(source.url,location.href),version=url.searchParams.get('v'),container=format==='mp4-packet'?'mp4':format==='js-ts-packets'?'ts':'matroska';
            const opened=await rpc('init',{input:{url:url.href,size:first.size,library:{origin:location.origin,id:source.id,version}},container,sourceVersion:`${source.id}@${version}`,persistent:true,forceWasm:mode==='reference',threads:1,glueURL:new URL('/vendor/voidplayer-core/voidplayer-core.js',location.href).href});
            let frame=await rpc('extract',{position:0}),previous=-Infinity;outputs=0;
            while(frame){if(frame.pts<=previous)throw Error('Duplicate or reordered product output');previous=frame.pts;frame.frame?.close();outputs++;if(outputs>count)throw Error('Extra product output');frame=await rpc('next',{pts:previous});}
            if(opened.times.length!==count)throw Error('Product index cardinality mismatch');
            await rpc('dispose');
          }finally{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('Worker closed'));}worker.terminate();}
        }
        for(const ptsUs of [Math.floor(first.durationUs*.6),0,first.durationUs-1,0]){await call('seek_review',{ptsUs});seeks.push((await call('get_review_session')).tracks[0].frame.ptsUs);}
        await call('seek_review',{ptsUs:first.durationUs-1});const tail=(await call('get_review_session')).tracks[0].frame.ptsUs;await call('step_review',{direction:1});const afterEnd=(await call('get_review_session')).tracks[0].frame.ptsUs;
        const logs=await call('get_review_logs',{limit:2000}),selected=logs.events.filter(e=>e.msg==='媒体管线追踪'&&e.data?.phase==='container-selected').at(-1)?.data;
        return{first,outputs,seeks,tail,afterEnd,selected};
      },{count,input,packetWorker,format,mode});
      assert.deepEqual(errors,[]);assert.equal(result.selected?.demuxBackend,format);assert.ok(result.first.width>0);assert.ok(result.first.height>0);
      if(input==='library')assert.equal(result.outputs,count);assert.equal(result.tail,result.afterEnd);assert.equal(result.seeks[1],0);assert.equal(result.seeks[3],0);
      if(mode==='reference')assert.equal(result.first.decoder,'ffmpeg-wasm');
      console.log(JSON.stringify({browser:name,file,mode,input,decoder:result.first.decoder,demuxBackend:result.selected.demuxBackend,outputs:result.outputs,tail:result.tail,seeks:result.seeks,passed:true}));
    }finally{await page.close();}
  }
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
