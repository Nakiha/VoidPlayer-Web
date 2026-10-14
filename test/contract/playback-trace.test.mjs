import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {beginPlaybackTrace} from '../../scripts/testing/playback-trace.mjs';

test('final sampling failure preserves evidence and releases every diagnostic hook',()=>{
  let reads=0,cleared=0,disconnected=0;
  class Worker {listeners=new Map();postMessage(){}addEventListener(n,fn){this.listeners.set(n,fn);}removeEventListener(n){this.listeners.delete(n);}}
  const post=Worker.prototype.postMessage;
  const window={voidPlayer:{getState(){if(reads++)throw new Error('final sample failed');return {playing:false,busy:false,positionUs:0,error:null,playback:null,tracks:[]};}}};
  class Observer {static supportedEntryTypes=['longtask'];observe(){}disconnect(){disconnected++;}}
  const context={Worker,window,performance:{now:()=>10},PerformanceObserver:Observer,setInterval:()=>1,clearInterval:()=>cleared++};
  vm.runInNewContext(`(${beginPlaybackTrace.toString()})()`,context);
  const worker=new Worker();worker.postMessage({id:1,type:'extract',ctx:1,index:0});
  const evidence=window.__finishPlaybackTrace();
  assert.match(evidence.diagnosticErrors[0].error,/final sample failed/);
  assert.equal(Worker.prototype.postMessage,post);assert.equal(cleared,1);assert.equal(disconnected,1);assert.equal(worker.listeners.size,0);assert.equal(window.__finishPlaybackTrace,undefined);
  assert.equal(evidence.outstanding.length,1);
});

test('trace/profile/state diagnostic failures do not replace the original benchmark error or discard its artifact',async()=>{
  const source=await readFile('scripts/testing/browser/media/bitstream-analysis.mjs','utf8');
  const start=source.indexOf("          if (row.container === 'ts') await page.evaluate(beginPlaybackTrace);");
  const end=source.indexOf('          const playbackRow = {',start);
  assert.ok(start >= 0 && end > start, 'diagnostic block boundaries must exist');
  const body=source.slice(start,end);
  const original=new Error('original benchmark failed'),written=[];
  const page={evaluate:async fn=>{if(fn===beginPlaybackTrace)return;throw new Error('diagnostic finish failed');},context:()=>({newCDPSession:async()=>({send:async method=>{if(method==='Profiler.stop')throw new Error('stop failed');},detach:async()=>{throw new Error('detach failed');}})})};
  const call=async name=>{if(name==='benchmark_review')throw original;throw new Error(`${name} unavailable`);};
  const context={page,call,row:{container:'ts',codec:'h264',fixture:'video.ts'},engine:'chromium',input:'local-file',decoding:'software',beginPlaybackTrace,process:{argv:['--playback-profile']},assert,artifact:x=>x,writeFile:async(name,text)=>written.push({name,text})};
  await assert.rejects(vm.runInNewContext(`(async()=>{${body}})()`,context),error=>error===original);
  assert.equal(written.length,1);const evidence=JSON.parse(written[0].text);
  assert.match(evidence.benchmarkError,/original benchmark failed/);
  assert.deepEqual(evidence.diagnosticErrors.map(e=>e.phase),['trace-finish','profile-stop','profile-detach','state','logs']);
});
