import { EXECUTION_EVENT } from './execution-error.ts';
import {isProduct} from './products.ts';
import type {AnalysisOutput} from './products.ts';
export interface AnalysisCounters { fastOpen:number; fullOpen:number; fallback:number; stagedBytesPeak:number; init:number; open:number; feed:number; step:number; decodedAU:number; preroll:number; products:number; cacheHit:number; uniqueDelivered:number; payloadBytes:number|null; coverageBytes:number; readBytes:number; initMs:number; openMs:number; feedMs:number; stepMs:number }
export const emptyCounters=():AnalysisCounters=>({fastOpen:0,fullOpen:0,fallback:0,stagedBytesPeak:0,init:0,open:0,feed:0,step:0,decodedAU:0,preroll:0,products:0,cacheHit:0,uniqueDelivered:0,payloadBytes:0,coverageBytes:0,readBytes:0,initMs:0,openMs:0,feedMs:0,stepMs:0});
/** Counts successful outputs, including reference preroll. Durations are
 * inclusive core calls; no independent pixel reconstruction claim. */
export function countCore(core:any,counters:AnalysisCounters) {
 for(const [name,key] of [['_vpa_open','open'],['_vpa_feed','feed'],['_vpa_feed_known','feed'],['_vpa_step','step']] as const){const call=core[name].bind(core);core[name]=(...args:any[])=>{const start=performance.now();const ret=call(...args);counters[`${key}Ms`]+=performance.now()-start;if((key==='feed'&&ret===0)||(key==='open'&&ret===0)||key==='step')counters[key]++;if(key==='step'&&ret===1)counters.decodedAU++;if(key==='open'&&ret===0){if(typeof core._vpa_execution_path==='function'&&core._vpa_execution_path()===1)counters.fastOpen++;else counters.fullOpen++;}return ret;};}
 core[EXECUTION_EVENT]=(event:string,bytes=0)=>{if(event==='fallback')counters.fallback++;else if(event==='staged-bytes')counters.stagedBytesPeak=Math.max(counters.stagedBytesPeak,bytes);};
 return core;
}
/** Logical product content only: UTF-8 header + owned payload. Structured-clone
 * envelopes/allocator overhead are not observable. Never stringify legacy blocks. */
export function countProduct(result:AnalysisOutput,hit:boolean,counters:AnalysisCounters,coverage?:unknown) {
 if(hit)counters.cacheHit++;else counters.products++;
 counters.preroll=Math.max(0,counters.decodedAU-counters.products);counters.readBytes=result.metrics.bytesRead;
 if(coverage){counters.coverageBytes+=new TextEncoder().encode(JSON.stringify(coverage)).byteLength;return;}
 if(!isProduct(result)){counters.payloadBytes=null;return;}
 const header=result.product==='blocks'?{...result,payload:undefined}:result;
 const bytes=new TextEncoder().encode(JSON.stringify(header)).byteLength+(result.product==='blocks'?result.payload.byteLength:0);
 if(counters.payloadBytes!==null)counters.payloadBytes+=bytes;
}
