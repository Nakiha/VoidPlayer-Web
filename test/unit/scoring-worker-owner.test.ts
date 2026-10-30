import test from 'node:test';
import assert from 'node:assert/strict';
import {ScoringWorkerOwner} from '../../server/analysis/quality/scoring-worker-owner.ts';
import {QualityAdmission} from '../../server/quality-admission.ts';
import type {QualityExecutionContext} from '../../server/analysis/quality/execution-context.ts';
// @ts-ignore deterministic whole-execution clock boundary
import {controlledExecutionDeadline} from '../helpers/analysis-lifecycle.mjs';
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
class Owner extends ScoringWorkerOwner {
  execute<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>){return this.owned({budget:{maxElapsedMs:10000}},signal,()=>{},work);}
}
for(const reason of ['deadline','cancel','shutdown'] as const)test(`final asynchronous work cannot return success after ${reason}; admission lasts until it drains`,async()=>{
 const admission=new QualityAdmission(),owner=new Owner({qualityAdmission:admission} as QualityExecutionContext,'/unused');
 const controller=new AbortController(),gate=deferred<void>(),started=deferred<void>();let combined!:AbortSignal;
 const clock=controlledExecutionDeadline(10000,()=>owner.execute(controller.signal,async s=>{combined=s;started.resolve();await gate.promise;return 'late success';}));
 const rejected=assert.rejects(clock.work,e=>reason==='deadline'?(e as {code:string}).code==='budget-exceeded':reason==='shutdown'?(e as {code:string}).code==='cancelled':(e as Error).name==='AbortError');
 await started.promise;
 let closing:Promise<void>|undefined;
 if(reason==='deadline')clock.expire();else if(reason==='cancel')controller.abort(new DOMException('cancelled','AbortError'));else closing=owner.close();
 assert.equal(combined.aborted,true);assert.equal(admission.resources().running,1);
 assert.throws(()=>admission.acquire(),{code:'quality-busy'});
 gate.resolve();await rejected;await closing;assert.equal(admission.resources().running,0);await owner.close();
});
test('work without an expired deadline returns its value and releases once',async()=>{
 const admission=new QualityAdmission(),owner=new Owner({qualityAdmission:admission} as QualityExecutionContext,'/unused');
 assert.equal(await owner.execute(new AbortController().signal,async()=>42),42);assert.equal(admission.resources().running,0);await owner.close();
});

test('elapsed deadline is enforced even before a delayed timer can execute',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);
 const admission=new QualityAdmission(),owner=new Owner({qualityAdmission:admission} as QualityExecutionContext,'/unused');
 await assert.rejects(owner.execute(new AbortController().signal,async()=>{now=10001;return 'too late';}),{code:'budget-exceeded'});
 assert.equal(admission.resources().running,0);await owner.close();
});
