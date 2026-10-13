// Eight independent, actively consumed streams beside the unchanged playback
// benchmark. Reports measurements; it does not claim a universal hardware limit.
import { withBrowserFixture } from './testing/browser-fixture.mjs';
import { MediaLibraryIndex } from '../server/library.ts';
import { createMediaServer } from '../server/app.ts';
import { AdminController } from '../server/admin.ts';
import { loadConfig } from '../server/config.ts';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const engine = process.argv[2] ?? 'webkit';
const durationMs = Number(process.env.ANALYSIS_STRESS_MS ?? 120000);
assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 120000 && durationMs <= 600000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const distribution = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: values.length, p50: sorted[Math.floor(sorted.length*.5)] ?? null,
    p95: sorted[Math.floor(sorted.length*.95)] ?? null,
    p99: sorted[Math.floor(sorted.length*.99)] ?? null, max: sorted.at(-1) ?? null };
};
const media = await mkdtemp(path.join(os.tmpdir(), 'vp-analysis-stress-'));
let admin, library;
try {
  for (let i=0;i<8;i++) await copyFile(path.resolve('fixtures/video/h264_9s_1920x1080.mp4'), path.join(media, `stress-${i}.mp4`));
  await withBrowserFixture({ caseName: 'analysis-sustained', engine, timeoutMs: durationMs+240000,
    roots: [path.resolve('fixtures/video'), media], launchOptions: {headless:false},
    dependencies: { async startService({temp, roots}) {
      const configFile = path.join(temp,'config.json');
      await writeFile(configFile, JSON.stringify({mediaRoots:roots,dataDir:temp,staticDir:path.resolve('dist'),indexWatch:false}));
      const config = await loadConfig(['--config',configFile], 'production');
      library = new MediaLibraryIndex(roots,{database:path.join(temp,'library.sqlite'),watch:false,settleMs:0});
      admin = new AdminController(config,library);
      const server = createMediaServer({roots,library,admin,staticDir:config.staticDir,onLog(){}});
      const close = async () => {
        server.closeAllConnections();
        if(server.listening)await new Promise(resolve=>server.close(resolve));
        await admin.close(); await library.close();
      };
      try { await library.refresh();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}); }
      catch(error){await close();throw error;}
      return {server,close,url:`http://127.0.0.1:${server.address().port}/`};
    } },
  },async({page,ready,url,artifact})=>{
    await ready();
    const scheduler=admin.analysis;
    assert.equal(scheduler.resources().concurrency,8);
    const entries=(await library.list()).entries.filter(e=>e.name.startsWith('stress-'));
    assert.equal(entries.length,8);
    const started=performance.now(),cpu=process.cpuUsage(),io=process.resourceUsage();
    const samples=[],jobs=[],failures=[],settings=[],ranges=[],seekMs=[];
    let active=true,probe=true,bench,benchCode,benchLog='';
    const activeJobs=new Map(), lanePictures=Array(8).fill(0);
    const sample=()=>samples.push({ms:performance.now()-started,...scheduler.resources(),lanePictures:[...lanePictures],rss:process.memoryUsage().rss,
      cpu:process.cpuUsage(cpu),io:process.resourceUsage()});
    const sampling=setInterval(sample,1000);sample();
    const consumers=entries.map(async(entry,lane)=>{
      while(active){
        const at=performance.now(),job=await scheduler.submit(entry.id,entry.version,{
          mode:'stream',sourceVersion:`${entry.id}@${entry.version}`,firstPtsUs:0,durationUs:9000000,
        },`load-${lane}`);
        activeJobs.set(lane,job.requestId);
        let cursor=0,maxInputBytes=0,resultBytes=0,complete=false;
        try {
          while(active){
            const state=await scheduler.streamStatus(job.requestId,`load-${lane}`,cursor);
            if(!active)break;
            assert.ok(state && ['queued','running','complete'].includes(state.state),JSON.stringify(state));
            for(const ref of state.chunks){
              const result=await scheduler.store.get(ref.id);assert.equal(result?.confidence,'exact');
              assert.equal(ref.cursor,cursor+1);cursor=ref.cursor;lanePictures[lane]++;
              maxInputBytes=Math.max(maxInputBytes,result.metrics.bytesRead);
              resultBytes+=Buffer.byteLength(JSON.stringify(result));
            }
            if(state.state==='complete'&&cursor===state.published){complete=true;break;}
            if(!state.chunks.length)await sleep(10);
          }
        }finally{
          scheduler.release(job.requestId,`load-${lane}`);activeJobs.delete(lane);
          jobs.push({lane,ms:performance.now()-at,pictures:cursor,complete,maxInputBytes,resultBytes});
        }
      }
    }).map(p=>p.catch(error=>{failures.push(String(error.stack??error));active=false;}));
    const rangeTask=(async()=>{
      const entry=(await library.list()).entries.find(e=>e.name==='h264_9s_1920x1080.mp4');
      while(probe){
        const at=performance.now(),response=await fetch(new URL(`/api/media/${entry.id}?v=${entry.version}`,url),{headers:{range:'bytes=0-65535'},signal:AbortSignal.timeout(30000)});
        assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,65536);
        ranges.push(performance.now()-at);await sleep(100);
      }
    })();
    const configuration=(async()=>{
      for(const [at,concurrency] of [[durationMs*.5,4],[durationMs*.75,8]]){
        while(active&&performance.now()-started<at)await sleep(100);
        if(!active)return;
        const before=scheduler.resources(),setting=await admin.analysisSettings();
        await admin.saveAnalysisSettings({revision:setting.revision,concurrency});
        settings.push({ms:performance.now()-started,before,after:scheduler.resources()});
      }
    })();
    try {
      while(scheduler.resources().running<8&&active){assert.ok(performance.now()-started<30000);await sleep(100);}
      console.log('Eight active streams; starting the unchanged 4 × 3 × 8-second visible playback benchmark');
      bench=spawn(process.execPath,['scripts/bench-playback.mjs',engine],{env:{...process.env,BASE_URL:url,
        BENCH_REPEATS:'3',BENCH_DURATION_MS:'8000',BENCH_REPORT:artifact('playback.json')},stdio:['ignore','pipe','pipe']});
      bench.stdout.on('data',b=>benchLog+=b);bench.stderr.on('data',b=>{benchLog+=b;process.stderr.write(b);});
      const benchDone=once(bench,'close').then(([code])=>{benchCode=code;});
      // Separately exercise actual seek completions under the same background load.
      const call=(name,params={})=>page.evaluate(({name,params})=>window.voidPlayer.tools.find(t=>t.name===name).execute(params),{name,params});
      const entry=(await call('list_library')).entries.find(e=>e.name==='h264_9s_1920x1080.mp4');
      await call('load_library_item',{id:entry.id,slot:'A'});
      for(let n=0;n<12;n++){
        const at=performance.now();await call('seek_review',{ptsUs:(n*719123)%8000000});seekMs.push(performance.now()-at);await sleep(100);
      }
      await benchDone;
      while(active&&performance.now()-started<durationMs)await sleep(200);
      assert.ok(active,'all eight consumers survive sustained load');
    }finally{
      active=false;probe=false;
      const cancelStart=performance.now();
      for(const [lane,id] of activeJobs)scheduler.release(id,`load-${lane}`);
      await Promise.all(consumers);await configuration;await rangeTask;
      while(scheduler.resources().running){assert.ok(performance.now()-cancelStart<10000,'cancel reclaims workers');await sleep(10);}
      const cancelMs=performance.now()-cancelStart;
      clearInterval(sampling);sample();
      if(benchCode===undefined&&bench){bench.kill('SIGTERM');await once(bench,'close');}
      await writeFile(artifact('playback.log'),benchLog);
      const endIO=process.resourceUsage(),endCPU=process.cpuUsage(cpu);
      const report={environment:{cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,ram:os.totalmem(),platform:process.platform,node:process.version,engine},
        durationMs:performance.now()-started,requestedDurationMs:durationMs,defaultConcurrency:8,settings,
        cpuMs:{user:endCPU.user/1000,system:endCPU.system/1000},rssBytes:distribution(samples.map(s=>s.rss)),
        io:{fsReadOperations:endIO.fsRead-io.fsRead,fsWriteOperations:endIO.fsWrite-io.fsWrite,
          consumedResultBytes:jobs.reduce((sum,j)=>sum+j.resultBytes,0),note:'OS operation counters may be zero with page cache; consumed bytes are logical payload, not physical disk traffic.'},
        rangeMs:distribution(ranges),seekMs:distribution(seekMs),cancelMs,
        pictures:jobs.reduce((sum,j)=>sum+j.pictures,0),jobs,failures,playbackExitCode:benchCode,samples};
      await writeFile(artifact('sustained.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({pictures:report.pictures,rss:report.rssBytes,rangeMs:report.rangeMs,seekMs:report.seekMs,cancelMs,failures,benchCode}));
    }
    assert.deepEqual(failures,[]);
    assert.equal(benchCode,0,'existing playback thresholds must pass under sustained analysis');
    assert.ok(samples.filter(s=>s.running===8).length>=30,'at least 30 seconds of eight admitted workers');
    assert.ok(lanePictures.every(count=>count>=30),'every lane consumes real output, not only idle reserved slots');
    const restored = samples.find(s => s.ms >= durationMs*.75 && s.concurrency === 8);
    assert.ok(restored && lanePictures.every((count,lane)=>count>restored.lanePictures[lane]),
      'every lane continues producing after concurrency returns to eight');
  });
}finally{await rm(media,{recursive:true,force:true});}
