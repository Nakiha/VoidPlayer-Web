import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeAnalysisAttempt, executionPolicy, hasExecutionExtension} from '../../src/bitstream-analysis/execution.ts';
import {RETRY_FULL} from '../../src/bitstream-analysis/execution-error.ts';
import {AnalysisFailure, coreFailure} from '../../src/bitstream-analysis/failure.ts';
import {metadataBudgetBytes, PRODUCT_LIMIT} from '../../src/bitstream-analysis/products.ts';
import type {AnalysisOutput} from '../../src/bitstream-analysis/products.ts';
const result=(au:number,attempt:string):AnalysisOutput=>({picture:{au},attempt,blocks:[]} as unknown as AnalysisOutput);
const cost=(r:AnalysisOutput)=>metadataBudgetBytes(r)+40;
const policyOptions=()=>({fast:true,policy:executionPolicy(),signal:new AbortController().signal});

test('late retry discards every speculative owner before full publishes/cache writes',async()=>{
 const visible:AnalysisOutput[]=[],modes:number[]=[],policy=executionPolicy();let finished=false;
 await executeAnalysisAttempt({...policyOptions(),policy,publish:async r=>{visible.push(r);},
  attempt:async(mode,publish,path,reserve)=>{modes.push(mode);path(!!mode);
   for(let au=0;au<3;au++){const r=result(au,mode?'fast':'full');reserve(au,()=>cost(r));await publish(r);if(mode)assert.equal(visible.length,0);}
   if(mode)throw coreFailure(RETRY_FULL,'late parameter change');finished=true;return 3;
  }});
 assert.ok(finished);assert.deepEqual(modes,[1,0]);assert.equal(policy.retries,1);
 assert.deepEqual(visible,[0,1,2].map(au=>result(au,'full')));
});
test('successful fast attempt is published only after decode completes, with awaited backpressure',async()=>{
 const events:string[]=[];
 await executeAnalysisAttempt({...policyOptions(),publish:async r=>{events.push('publish'+r.picture.au);await Promise.resolve();events.push('ack'+r.picture.au);},
  attempt:async(_mode,publish,path,reserve)=>{path(true);for(let au=0;au<2;au++){const r=result(au,'fast');reserve(au,()=>cost(r));await publish(r);assert.deepEqual(events,[]);}events.push('decoded');return 2;}});
 assert.deepEqual(events,['decoded','publish0','ack0','publish1','ack1']);
});
test('known-ineligible configuration keeps immediate full streaming',async()=>{
 let delivered=0;
 await executeAnalysisAttempt({...policyOptions(),publish:async()=>{delivered++;},attempt:async(_m,publish,path)=>{path(false);await publish(result(0,'full'));assert.equal(delivered,1);return 1;}});
});
test('one retry belongs to the whole request and cannot loop even on another retry tag',async()=>{
 const policy=executionPolicy(),modes:number[]=[];
 await assert.rejects(executeAnalysisAttempt({...policyOptions(),policy,attempt:async(mode,_pub,path)=>{modes.push(mode);path(!!mode);throw coreFailure(RETRY_FULL,'repeat');}}));
 assert.deepEqual(modes,[1,0]);assert.equal(policy.retries,1);
 await executeAnalysisAttempt({...policyOptions(),policy,attempt:async(mode)=>{assert.equal(mode,0);return 0;}});
});
for(const phase of ['before','fast','before-full','full','commit'] as const)
test(`cancellation ${phase} never leaks fast owners or starts another fallback`,async()=>{
 const controller=new AbortController(),visible:AnalysisOutput[]=[],modes:number[]=[],policy=executionPolicy();
 if(phase==='before')controller.abort();
 await assert.rejects(executeAnalysisAttempt({fast:true,policy,signal:controller.signal,
  event:e=>{if(e==='fallback'&&phase==='before-full')controller.abort();},
  publish:async r=>{visible.push(r);if(phase==='commit'||phase==='full')controller.abort();},
  attempt:async(mode,publish,path,reserve)=>{modes.push(mode);path(!!mode);const r=result(0,mode?'fast':'full');reserve(0,()=>cost(r));await publish(r);
   if(mode&&phase==='fast')controller.abort();
   if(mode&&['before-full','full'].includes(phase))throw coreFailure(RETRY_FULL,'late');
   return 1;
  }}),{name:'AbortError'});
 if(['before','fast','before-full'].includes(phase))assert.deepEqual(visible,[]);
 if(phase==='full')assert.deepEqual(visible,[result(0,'full')]);
 if(phase==='commit')assert.deepEqual(modes,[1]);
 assert.ok(policy.retries<=1);
});
for(const error of [coreFailure(-48,'memory'),coreFailure(-1094995529,'corrupt'),new AnalysisFailure('source-changed','source'),new AnalysisFailure('no-safe-anchor-within-budget','anchor')])
test(`nonretry ${error.message} keeps one attempt and zero publication`,async()=>{
 let calls=0,delivered=0;
 await assert.rejects(executeAnalysisAttempt({...policyOptions(),publish:async()=>{delivered++;},attempt:async(_m,publish,path,reserve)=>{calls++;path(true);const r=result(0,'fast');reserve(0,()=>cost(r));await publish(r);throw error;}}),e=>e===error);
 assert.equal(calls,1);assert.equal(delivered,0);
});
test('capacity is reserved before allocating an owner; full retry ignores speculative reservation',async()=>{
 let allocations=0;const modes:number[]=[];
 await executeAnalysisAttempt({...policyOptions(),attempt:async(mode,publish,path,reserve)=>{modes.push(mode);path(!!mode);
  reserve(0,()=>PRODUCT_LIMIT.inFlight+1);allocations++;await publish(result(0,'full'));return 1;
 }});
 assert.deepEqual(modes,[1,0]);assert.equal(allocations,1);
});
test('a consumer failure during commit cannot retry a published generation',async()=>{
 let attempts=0;
 await assert.rejects(executeAnalysisAttempt({...policyOptions(),publish:async()=>{throw coreFailure(RETRY_FULL,'consumer');},attempt:async(_m,publish,path,reserve)=>{attempts++;path(true);const r=result(0,'fast');reserve(0,()=>cost(r));await publish(r);return 1;}}));
 assert.equal(attempts,1);
});
test('missing reservation and incomplete execution extension fail closed',async()=>{
 await assert.rejects(executeAnalysisAttempt({...policyOptions(),attempt:async(_m,publish,path)=>{path(true);await publish(result(0,'fast'));return 1;}}),/without a sufficient reservation/);
 assert.equal(hasExecutionExtension({}),false);
 assert.throws(()=>hasExecutionExtension({_vpa_execution_path:()=>0}),/Incomplete/);
 assert.throws(()=>hasExecutionExtension({_vpa_execution_abi:()=>1}),/mismatch/);
});
