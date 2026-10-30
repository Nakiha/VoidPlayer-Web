import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {setImmediate} from 'node:timers/promises';
const hooks=registerHooks({load(url,ctx,next){
 if(url.endsWith('.css'))return {format:'module',source:'export {};',shortCircuit:true};
 if(url.endsWith('/src/services/identity.ts'))return {format:'module',source:'export const confirmedActor=()=>({id:"owner"});export const currentActor=confirmedActor;export const identityHealth=async()=>({actor:confirmedActor()}); export const observeIdentity=()=>{};',shortCircuit:true};
 if(url.endsWith('/src/admin/quality-reexecution.ts'))return {format:'module',source:'export const installQualityReexecution=()=>({clear(){},show(){}});',shortCircuit:true};
 if(url.endsWith('/src/admin/quality-navigation.ts'))return {format:'module',source:'export const qualityViewVisible=()=>true;',shortCircuit:true};
 if(url.endsWith('/src/ui/icons.ts'))return {format:'module',source:'export const icon=()=>"";',shortCircuit:true};
 return next(url,ctx);
}});
const {installTemporalQuality}=await import('../../src/admin/quality-temporal.ts');
const {installQualityRanges}=await import('../../src/admin/quality-ranges.ts');
const {installQualityCorrespondence}=await import('../../src/admin/quality-correspondence.ts');
hooks.deregister();
class Element extends EventTarget{
 children=[];dataset={};value='';textContent='';hidden=false;disabled=false;
 append(...items){for(const i of items){i.isConnected=true;this.children.push(i);}}
 replaceChildren(...items){this.children=[];this.append(...items);}
 querySelectorAll(){return this.children.filter(c=>c.dataset?.rangeId);}
 querySelector(selector){return this.parts?.get(selector)??(this.parts??=new Map(),this.parts.set(selector,new Element()),this.parts.get(selector));}
 setAttribute(){} remove(){} insertBefore(item,before){this.children.splice(before?this.children.indexOf(before):this.children.length,0,item);item.isConnected=true;}
}
const tick=async()=>{for(let i=0;i<8;i++)await setImmediate();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function harness(t,kind){
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const saved=new Map();
 const values={document:{getElementById:el,querySelector:selector=>el(selector),createElement:()=>new Element()},window:new EventTarget(),sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
 for(const [key,value]of Object.entries(values)){saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value,writable:true});}
 const requests=[],gate=deferred();const firstPages=new Map();
 const oldFetch=globalThis.fetch;
 const first={id:'first',state:'completed',revision:1,summary:{scoredPairs:1},input:{declaration:'Declared',reference:{mediaId:'reference',mediaVersion:'v1'},distorted:{mediaId:'distorted',mediaVersion:'v1'},clock:{segments:[]}}},second={...first,id:'second'};
 globalThis.fetch=async(url,init)=>{
  requests.push(String(url));const u=new URL(url,'http://local');
  if(u.searchParams.has('after')){
   const after=Number(u.searchParams.get('after'));
   const count=(firstPages.get(u.pathname)??0)+1;if(after===0)firstPages.set(u.pathname,count);
   if(after===0&&count===2&&(kind!=='correspondence'||u.pathname.endsWith('correspondence-plans')))return gate.promise;
   return new Response(JSON.stringify({entries:[after===0?first:second],after:after===0?1:2,more:after===0}));
  }
  return new Response(JSON.stringify({error:'detail intentionally unavailable'}),{status:404});
 };
 const controller=new AbortController();t.after(()=>{controller.abort();globalThis.fetch=oldFetch;for(const[key,d]of saved){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}});
 const panel=kind==='correspondence'?installQualityCorrespondence(controller.signal):kind==='ranges'?installQualityRanges(controller.signal):installTemporalQuality(controller.signal,{kind,parseInput:v=>v,readInput:()=>({}),frameLabel:()=>''});
 panel.activate(true);await tick();
 return {panel,el:id=>el((kind==='correspondence'?'quality-clock-':kind==='ranges'?'quality-range-':kind+'-')+id),requests,gate};
}
// Real controllers, request slots and HTTP client; only DOM/presentation and
// identity notification boundaries are controlled by this harness.
for(const kind of ['vmaf','xpsnr','ranges','correspondence'])test(`${kind}: pagination supersedes a slow refresh without disabling committed rows`,async t=>{
 const h=await harness(t,kind),container=kind==='ranges'?'list':'history',first=h.el(container).children[0];
 assert.ok(first);h.el('refresh').onclick();await tick();h.el(kind==='correspondence'?'history-more':'more').onclick();await tick();
 assert.equal(h.el(container).children.length,2);
 assert.ok(h.requests.some(u=>u.includes('after=1')),'next page has its own request identity');
 let n=h.requests.length;first.onclick();await tick();
 assert.ok(h.requests.slice(n).some(u=>u.endsWith('/first')),'first page row remains actionable');
 n=h.requests.length;h.el(container).children[1].onclick();await tick();
 assert.ok(h.requests.slice(n).some(u=>u.endsWith('/second')));
 h.gate.resolve(new Response(JSON.stringify({entries:[],after:1,more:false})));await tick();
 assert.equal(h.el(container).children.length,2,'ignored abort reply cannot erase committed pagination');
 h.panel.activate(false);h.panel.activate(true);await tick();n=h.requests.length;
 first.onclick();await tick();assert.equal(h.requests.length,n,'detached row cannot act after a scope roundtrip');
});
