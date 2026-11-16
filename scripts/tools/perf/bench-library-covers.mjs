// Run from the repository root after preparing fixtures/video and the playback core.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaLibraryIndex } from '../../../server/library.ts';
import { createMediaServer } from '../../../server/app.ts';
import { thumbnailImageUrl } from '../../../shared/thumbnails/contract.ts';

const samples=['h264_9s_1920x1080.mp4','h265_10s_1920x1080.mp4','vp9_10s_1920x1080.webm','dolby_hlg_1080p30.mp4'];
const count=16;
if (process.argv[2]==='serve') {
  const temp=await mkdtemp(path.join(os.tmpdir(),'vp-cover-bench-')), media=path.join(temp,'media');
  await mkdir(media);
  for (let i=0;i<count;i++) await copyFile(path.join('fixtures/video',samples[i%4]),path.join(media,i+'-'+samples[i%4]));
  const library=new MediaLibraryIndex([{id:'bench',path:media}],{watch:false,database:path.join(temp,'library.sqlite')});
  await library.refresh();
  const server=createMediaServer({library,roots:[media],onLog(){}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let writes=0;
  const put=library.thumbnails.put.bind(library.thumbnails);
  library.thumbnails.put=(...args)=>{writes++;return put(...args);};
  const metrics=()=>({cpu:process.cpuUsage(),rss:process.memoryUsage.rss(),writes,storage:library.thumbnails.overview().bytes});
  let peak=0,timer;
  process.on('message',async command=>{
    if (command==='close') {
      clearInterval(timer);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      await library.close();await rm(temp,{recursive:true,force:true});process.disconnect();return;
    }
    const m=metrics();
    if (command==='start') {
      peak=m.rss;timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage.rss());},10);
    } else clearInterval(timer);
    process.send({...m,peak:Math.max(peak,m.rss)});
  });
  process.send({base:'http://127.0.0.1:'+server.address().port});
} else {
  const p95=values=>Math.round(values.toSorted((a,b)=>a-b)[Math.ceil(values.length*.95)-1]*10)/10;
  for (const [scenario,width] of [['serial',1],['concurrent',8],['same file',16]]) {
    const child=fork(import.meta.filename,['serve'],{stdio:['ignore','ignore','inherit','ipc']});
    const request=async msg=>{const reply=once(child,'message');child.send(msg);return (await reply)[0];};
    try {
      const [{base}]=await once(child,'message');
      const list=base+'/api/library/browse?root=bench&limit=60';
      const entries=(await (await fetch(list)).json()).entries;
      assert.equal(entries.length,count);
      const urls=entries.map(e=>base+thumbnailImageUrl(e.id,e.version));
      const get=async url=>{
        const t=performance.now(),r=await fetch(url);
        const data=await r.arrayBuffer();
        assert.equal(r.status,200);
        if (url!==list) {assert.equal(r.headers.get('content-type'),'image/jpeg');assert.ok(data.byteLength>0);}
        return performance.now()-t;
      };
      for (const phase of ['browse','cold','warm']) {
        const m=await request('start'),latencies=[],listing=[];
        const start=performance.now();
        let done=false,index=0;
        const probe=(async()=>{
          if (phase!=='cold') return;
          do {listing.push(await get(list));await delay(20);} while (!done);
        })();
        try {
          await Promise.all(Array.from({length:width},async()=>{
            while (index<count) {
              const i=index++;
              latencies.push(await get(phase==='browse'?list:urls[scenario==='same file'?0:i]));
            }
          }));
        } finally {done=true;}
        const elapsed=performance.now()-start;
        await probe;
        const n=await request('stop'), generated=n.writes-m.writes;
        assert.equal(generated,phase==='cold'?(scenario==='same file'?1:count):0);
        console.log(JSON.stringify({scenario,phase,requests:count,concurrency:width,elapsedMs:Math.round(elapsed),
          p95Ms:p95(latencies),throughputPerSec:Math.round(count*1000/elapsed),generated,
          serverCpuMs:Math.round((n.cpu.user+n.cpu.system-m.cpu.user-m.cpu.system)/1000),
          peakRssDeltaMiB:Math.round((n.peak-m.rss)/1048576),cacheKiB:Math.round(n.storage/1024),
          ...(listing.length?{listingP95Ms:p95(listing),listingSamples:listing.length}:{})}));
      }
    } finally {const stopped=once(child,'exit');child.send('close');await stopped;}
  }
}
