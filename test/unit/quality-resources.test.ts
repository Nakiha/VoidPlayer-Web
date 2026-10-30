import test from 'node:test';
import assert from 'node:assert/strict';
import {QualityAdmission} from '../../server/quality-admission.ts';
import {DEFAULT_QUALITY_RESOURCES,qualityResourceLimits} from '../../shared/service/quality-resources.ts';
import type {QualityReservation} from '../../shared/service/quality-resources.ts';
const MiB=1024**2;
const reservation=(executor:QualityReservation['executor']='vmaf',memoryBytes=640*MiB):QualityReservation=>({executor,memoryBytes,readBytes:32*MiB,threads:1});
function limits(){return {...structuredClone(DEFAULT_QUALITY_RESOURCES),concurrency:4,memoryBytes:4*1024**3,perExecutor:{...DEFAULT_QUALITY_RESOURCES.perExecutor,vmaf:2}};}

test('global and algorithm reservations jointly gate work; lowering drains without evicting owners',()=>{
  const a=new QualityAdmission(),l=limits();a.configure(l);
  const first=a.acquire(reservation()),second=a.acquire(reservation());
  assert.throws(()=>a.acquire(reservation()),{code:'quality-busy'});
  const cambi=a.acquire(reservation('cambi'));assert.equal(a.resources().running,3);
  a.configure({...l,concurrency:1});assert.equal(a.resources().running,3);
  assert.throws(()=>a.acquire(reservation('psnr')),{code:'quality-busy'});
  first();second();assert.equal(a.resources().running,1);
  assert.throws(()=>a.acquire(reservation('psnr')),{code:'quality-busy'});
  cambi();const next=a.acquire(reservation('psnr'));next();next();assert.equal(a.resources().running,0);
});
test('aggregate memory, IO and internal thread reservations cannot be bypassed by different algorithms',()=>{
  for(const resource of ['memoryBytes','readBytes','threads'] as const){
    const a=new QualityAdmission(),l=limits();a.configure({...l,[resource]:resource==='threads'?1:resource==='memoryBytes'?1000*MiB:48*MiB});
    const release=a.acquire(reservation());assert.throws(()=>a.acquire(reservation('cambi')),{code:'quality-busy'});
    release();const next=a.acquire(reservation('cambi'));next();
  }
});
test('an impossible reservation is a stable refusal, while index/bitstream owners remain exclusive',()=>{
  const a=new QualityAdmission();assert.throws(()=>a.acquire(reservation('vmaf',3*1024**3)),{code:'quality-resource-limit'});
  assert.equal(a.resources().running,0);let ordinary=true;
  const unregister=a.register(()=>ordinary);assert.throws(()=>a.acquire(reservation()),{code:'quality-busy'});
  ordinary=false;const release=a.acquire(reservation());assert.throws(()=>a.ordinary(),{code:'quality-busy'});
  release();a.ordinary();unregister();
});
test('global and actor queue caps span registered durable stores and unregister before storage closes',()=>{
  const a=new QualityAdmission();a.configure({...limits(),outstanding:3,actorOutstanding:2});
  const first=[{actor:'a',count:1}],second=[{actor:'b',count:1}];
  const off=a.registerQueue(()=>first),off2=a.registerQueue(()=>second);
  a.assertQueue('a');first.push({actor:'a',count:1});
  assert.throws(()=>a.assertQueue('c'),{code:'quality-global-queue-full'});
  first.pop();second[0].actor='a';assert.throws(()=>a.assertQueue('a'),{code:'quality-global-actor-limit'});
  a.assertQueue('b');off();off2();assert.equal(a.resources().outstanding,0);
});
test('resource limits reject unbounded, fractional and misleading auxiliary parallelism',()=>{
  for(const mutate of [(l:any)=>l.concurrency=0,(l:any)=>l.concurrency=9,(l:any)=>l.threads=1.5,(l:any)=>l.memoryBytes=Infinity,(l:any)=>l.perExecutor.preparation=2,(l:any)=>l.gpu=1]){
    const l=limits();mutate(l);assert.throws(()=>qualityResourceLimits(l));
  }
  const l=limits(),a=new QualityAdmission();a.configure(l);l.concurrency=8;const view=a.resources();view.limits.concurrency=8;assert.equal(a.resources().limits.concurrency,4);
});
test('quality index preparation retains explicit exclusive admission even when scoring concurrency is raised',()=>{
 const a=new QualityAdmission();a.configure(limits());
 const scoring=a.acquire(reservation());assert.throws(()=>a.acquire(reservation('preparation'),true),{code:'quality-busy'});scoring();
 const index=a.acquire(reservation('preparation'),true);assert.equal(a.resources().exclusiveOwner,true);
 for(const kind of ['psnr','vmaf','inspection'] as const)assert.throws(()=>a.acquire(reservation(kind)),{code:'quality-busy'});
 index();assert.equal(a.resources().exclusiveOwner,false);a.acquire(reservation())();
});
