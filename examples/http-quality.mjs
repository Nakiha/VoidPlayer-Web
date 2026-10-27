#!/usr/bin/env node
/** Ordinary HTTP only: no application imports, browser, service queue or stored credentials. */
import {isDeepStrictEqual} from 'node:util';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export class HttpQualityError extends Error {
  constructor(code,message,details={}){super(message);this.code=code;this.details=details;}
}
const pending=new Set(['queued','running','preparing','cancelling']);
const stop=(code,message,details)=>{throw new HttpQualityError(code,message,details);};
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const nonempty=v=>typeof v==='string'&&v.length>0;
function selectedIdentityCookie(response,actorId){
 if(!nonempty(actorId))return null;
 const headers=response.headers,values=typeof headers.getSetCookie==='function'?headers.getSetCookie():[headers.get('set-cookie')].filter(nonempty);
 // Keep Expires commas intact if a transport combines Set-Cookie fields.
 const matches=values.flatMap(v=>v.split(/,(?=\s*[^;,\s=]+\s*=)/)).map(v=>v.split(';',1)[0].trim()).filter(v=>/^voidplayer-user\s*=/.test(v));
 if(matches.length!==1)return null;
 let value=matches[0].slice(matches[0].indexOf('=')+1).trim();
 if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);
 try{if(!value||decodeURIComponent(value)!==actorId)return null;}catch{return null;}
 return 'voidplayer-user='+encodeURIComponent(actorId);
}
// Check the acknowledgement envelope used by this example, not domain input
// admission. A 2xx with missing ownership/result handles is not proof of failure.
function completeAcknowledgement(id,value,body,params,response,expected){
 if(!record(value))return false;
 if(id==='identity.select')return record(value.actor)&&selectedIdentityCookie(response,value.actor.id)!==null;
 if(id==='relation.create')return typeof value.replayed==='boolean'&&record(value.relation)&&nonempty(value.relation.id)&&value.relation.revision===1;
 if(id==='plan.create')return typeof value.replayed==='boolean'&&record(value.plan)&&nonempty(value.plan.id)&&nonempty(value.plan.state);
 if(id.endsWith('.reexecute')){
  // The published server contract trims reason. Compare normalized receipt
  // semantics, while retaining the byte-identical original body for replay.
  const normalized={...body,reason:typeof body.reason==='string'?body.reason.trim():body.reason};
  return typeof value.replayed==='boolean'&&record(value.job)&&nonempty(value.job.id)&&value.job.id!==params.id&&nonempty(value.job.state)&&record(value.receipt)&&value.receipt.actorId===expected.actor&&value.receipt.key===expected.key&&value.receipt.parentId===params.id&&value.receipt.jobId===value.job.id&&isDeepStrictEqual(value.receipt.request,normalized)&&record(value.job.retryOf)&&value.job.retryOf.retryOf===params.id&&value.job.retryOf.planDigest===body.planDigest&&value.job.retryOf.reason===normalized.reason&&isDeepStrictEqual(value.receipt.lineage,value.job.retryOf);
 }
 if(['library.prepare','single.submit','plan.execute','vmaf.submit'].includes(id))return typeof value.replayed==='boolean'&&record(value.job)&&nonempty(value.job.id)&&nonempty(value.job.state);
 if(['range.candidates','vmaf.candidates'].includes(id))return record(value.policy)&&value.policy.space===body.space&&Array.isArray(value.selected)&&Array.isArray(value.createdIds)&&value.createdIds.every(nonempty);
 if(id==='evidence.candidate')return value.id===body.id&&value.space===params.space&&Number.isSafeInteger(value.revision)&&value.revision>0&&record(value.document);
 if(id==='vmaf.preflight')return value.nativeExecution===false;
 return false;
}

/** Explicit source/relation/recipe/budget/policy configuration is never inferred.
 * allow defaults to {}. cookie is an in-memory embedding option, never a CLI file field.
 * fetchImpl/onObservation permit testing ordinary transport loss and stopping observation. */
export async function runHttpQuality(serverURL,input={},options={}){
 input=structuredClone(input);
 const base=new URL(serverURL);
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)stop('invalid-server','Use a plain service origin without credentials, path, query or fragment.');
 if('cookie'in input)stop('credential-input','Cookies must not be stored in the input file. Select an identity explicitly.');
 const allow={...options.allow},fetchImpl=options.fetchImpl??fetch,operations=new Map();
 let cookie=options.cookie??'',actor=options.actor??null,requests=0;
 const deadline=Date.now()+(options.maxElapsedMs??180000),maxRequests=options.maxRequests??1200;
 const url=path=>{const u=new URL(path,base);if(u.origin!==base.origin)stop('foreign-link','Refusing a link outside the selected service.');return u;};
 async function request(path,{method='GET',body,action,key,privateRead=false,text=false,onSend}={}){
  if(++requests>maxRequests||Date.now()>=deadline)stop('observation-budget','Client observation budget reached. Durable work was not cancelled.');
  const headers={accept:text?'text/plain, text/markdown':'application/json'};
  if(cookie)headers.cookie=cookie;
  if(actor&&privateRead)headers['x-voidplayer-actor']=actor;
  if(method==='POST')Object.assign(headers,{origin:base.origin,'content-type':'application/json','x-voidplayer-action':action,...(actor?{'x-voidplayer-actor':actor}:{}),...(key?{'idempotency-key':key}:{})});
  const target=url(path),init={method,headers,redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now()))),...(body===undefined?{}:{body})};
  onSend?.();
  const response=await fetchImpl(target,init);
  // Bound public data retained by this small client, including chunked bodies.
  let value;
  try{
   const reader=response.body?.getReader(),chunks=[];let size=0;
   try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)stop('response-budget','Response exceeded the client byte limit.');chunks.push(value);}}
   finally{await reader?.cancel();}
   const bytes=Buffer.concat(chunks);value=text?bytes.toString('utf8'):bytes.length?JSON.parse(bytes.toString('utf8')):null;
  }catch(error){stop(error?.code??'invalid-response-body','The HTTP response body could not be read completely.',{status:response.status,phase:'response-body'});}
  if(!response.ok)stop(value?.code??'http-error',value?.error??`HTTP ${response.status}`,{status:response.status,response:value,path});
  return {value,response};
 }
 const get=async(path,privateRead=false)=>(await request(path,{privateRead})).value;
 async function checkActor(){if(actor){const current=await get('/api/agent');if(current.actor?.id!==actor)stop('actor-changed','Stop: the selected cookie actor changed; no pending write was replayed.');}}
 async function describe(id){
  if(!operations.has(id))stop('missing-operation',`The public task catalog did not advertise ${id}.`);
  const item=operations.get(id);if(!item.contract){const c=await get(item.links.describe);if(c.schema!=='voidplayer-agent-operation'||c.version!==1||c.id!==id)stop('operation-version','Unsupported operation description.');item.contract=c;}
  return item.contract;
 }
 const pathFor=(op,params={})=>op.path.replace(/\{([^}]+)\}/g,(_,key)=>{if(params[key]===undefined)stop('missing-parameter',`Missing explicit ${key}.`);return encodeURIComponent(params[key]);});
 async function read(id,params={},query={}){const op=await describe(id);const u=url(pathFor(op,params));for(const [k,v]of Object.entries(query))u.searchParams.set(k,String(v));return get(u,op.identity.cookieRequired);}
 async function write(id,body,permission,params={},suffix){
  const op=await describe(id);
  if(!allow[permission])stop('authorization-required',`Explicit --allow-${permission} is required.`,{next:[op.links.guide,`/api/agent/operations/${id}`]});
  if(op.identity.cookieRequired&&!actor)stop('identity-required','Explicit identity selection is required.');
  if(op.write?.keyHeader&&(!input.key||!/^[A-Za-z0-9._:-]{1,90}$/.test(input.key)))stop('missing-key','Supply a stable operation key (1..90 ASCII letters/digits/._:-). Keep it and the original input for uncertain-response replay.');
  const frozen=JSON.stringify(body),key=op.write?.keyHeader?`${input.key}:${suffix??id}`:undefined,path=pathFor(op,params),submittedActor=actor;
  const replayable=op.write?.idempotency!=='none';
  const originalRequest=()=>({operation:id,origin:base.origin,path,actor:submittedActor,key:key??null,body:JSON.parse(frozen),replay:op.write.idempotency,next:op.links.guide});
  const unknown=error=>stop('unknown-post-outcome','The POST outcome is unknown. Resolve only this frozen operation with the original actor and body/key (or digest/policy/operationId). Never choose a new key or actor. Non-idempotent identity creation needs manual resolution.',{...originalRequest(),responseIssue:{code:error?.code??'transport-error',status:error?.details?.status??null,phase:error?.details?.phase??'transport'}});
  for(let attempt=0;;attempt++){
   try{await checkActor();}catch(error){if(error?.code==='actor-changed'){error.details.originalRequest=originalRequest();throw error;}if(attempt>0)unknown(error);throw error;}
   let sent=false;
   try{
    const result=await request(path,{method:'POST',body:frozen,action:op.write.action,key,onSend:()=>{sent=true;}});
    if(!completeAcknowledgement(id,result.value,body,params,result.response,{actor:submittedActor,key}))stop('invalid-write-acknowledgement','The successful response omitted the operation acknowledgement.',{status:result.response.status,phase:'acknowledgement'});
    if(id==='identity.select'){cookie=selectedIdentityCookie(result.response,result.value.actor.id);actor=result.value.actor.id;}
    return result.value;
   }catch(error){
    // One explicitly authorized replay, with byte-identical body/key and original actor.
    // HTTP validation/ownership failures are definite; never retry those or change the key.
    const status=error?.details?.status,knownRejection=status>=400&&status<500;
    if(knownRejection||!sent&&attempt===0){if(attempt>0&&error instanceof HttpQualityError)error.details.originalRequest=originalRequest();throw error;}
    if(!replayable||!allow.retryUnknown||attempt>0)unknown(error);
   }
  }
 }
 async function observe(id,params,extract=x=>x){
  for(let n=0;n<600;n++){
   const value=await read(id,params),job=extract(value);
   if(options.onObservation&&await options.onObservation({operation:id,value})===false)stop('observation-stopped','Observation stopped; durable work was not cancelled.',{operation:id,params});
   if(!pending.has(job.state)){if(job.state!=='completed')stop(job.reason?.code??'terminal-job',job.reason?.message??`Terminal ${job.state}`,{job,operation:id});return value;}
   await new Promise(resolve=>setTimeout(resolve,options.pollMs??100));
  }
  stop('observation-budget','Bounded observation finished without cancellation.',{operation:id,params});
 }
 // Entry is deliberately llms.txt, even in deployments without dist or a player.
 const entry=(await request('/llms.txt',{text:true})).value;
 const manifestPath=/\]\((\/api\/agent)\)/.exec(entry)?.[1];if(!manifestPath)stop('missing-entry','llms.txt did not link the runtime manifest.');
 const manifest=await get(manifestPath);if(manifest.schema!=='voidplayer-agent'||manifest.version!==1)stop('manifest-version','Unsupported agent manifest.');
 if(actor&&manifest.actor?.id!==actor)stop('actor-changed','Initial cookie actor does not match the captured actor.');
 const catalog=await get(manifest.links.taskCatalog);if(catalog.schema!=='voidplayer-agent-tasks'||catalog.version!==1)stop('catalog-version','Unsupported task catalog.');
 const mode=input.mode??'single';if(!['single','range','vmaf'].includes(mode))stop('invalid-mode','Choose single, range or vmaf explicitly.');
 const tasks=['identity','library','quality.correspondence',`quality.${mode}`,'evidence'];
 for(const id of tasks){const t=catalog.entries.find(t=>t.id===id);if(!t)stop('missing-task',`Task ${id} unavailable.`);await request(t.links.guide,{text:true});const detail=await get(t.links.describe);if(detail.schema!=='voidplayer-agent-task'||detail.version!==1)stop('task-version','Unsupported task description.');for(const op of detail.operations)operations.set(op.id,op);}
 const report={schema:'voidplayer-http-quality-example',version:1,mode,writesAuthorized:Object.keys(allow).filter(k=>allow[k]),capabilities:manifest.capabilities.filter(c=>['library.discovery','library.preparations','quality.'+mode,'quality.jobs'].includes(c.id)),discovery:[],next:[]};
 // Reexecution selects an existing owned job; it never rediscovers, prepares,
 // repairs a plan or silently changes the original source/recipe/model.
 if(input.reexecution){
  const intent=input.reexecution,id=intent.jobId;
  if(typeof id!=='string'||typeof intent.reason!=='string')stop('explicit-reexecution-required','Supply the original jobId and explicit reason.');
  if(!actor){if(!input.identity)stop('identity-required','Select the original actor explicitly; never recreate an identity after uncertainty.');await write('identity.select',input.identity,'identity');}
  report.actor={id:actor};report.original=await read(`${mode}.get`,{id});report.chain=await read(`${mode}.reexecutions`,{id});
  // A plan POST is explicitly described as read-only. It is the only POST this
  // default path performs and cannot create any durable work.
  const op=await describe(`${mode}.reexecution-plan`);await checkActor();
  if(!intent.request){report.reexecutionPlan=(await request(pathFor(op,{id}),{method:'POST',body:JSON.stringify({reason:intent.reason}),action:op.write.action})).value;}
  if(!allow.reexecute){report.next=[op.links.guide,'Explicitly confirm the plan digest and full cost, then allow-reexecute. After an unknown POST retain its frozen request, actor and key; never use a replacement key.'];return report;}
  if(intent.actor!==actor)stop('actor-changed','Explicit reexecution.actor must equal the original selected actor; pending operations cannot move between actors.');
  const body=intent.request??{schema:'voidplayer-quality-reexecution',version:1,reason:intent.reason,planDigest:intent.confirmPlanDigest,confirm:intent.confirmCost};
  if(body.reason!==intent.reason||!nonempty(body.planDigest)||!record(body.confirm))stop('explicit-cost-confirmation-required','Supply confirmPlanDigest and exact confirmCost from the read-only plan, or the frozen original request after an unknown result.');
  if(report.reexecutionPlan&&(!report.reexecutionPlan.eligible||body.planDigest!==report.reexecutionPlan.digest||JSON.stringify(body.confirm)!==JSON.stringify(report.reexecutionPlan.cost)))stop('reexecution-blocked','The original conditions or explicit cost confirmation do not match; no computation was submitted.',{plan:report.reexecutionPlan});
  const accepted=await write(`${mode}.reexecute`,body,'reexecute',{id});report.reexecutionReceipt=accepted.receipt;
  const job=await observe(`${mode}.get`,{id:accepted.job.id},mode==='range'?v=>v.job:v=>v);report.job=job;
  const completed=mode==='range'?job.job:job;
  if(mode==='range'){report.results=[];for(let after=0,n=0;n<16;n++){const page=await read('range.results',{id:completed.id},{after,limit:4});report.results.push(...page.entries);if(page.nextAu===null)break;after=page.nextAu;}}
  else report.result=await read(`${mode}.result`,{id:completed.id});
  // Publication is always a separate, explicitly authorized policy/operation.
  if(allow.candidate){
   if(!input.candidate)stop('explicit-policy-required','Supply a complete explicit policy for the new result.');
   let publication;
   if(mode==='single'){const p=input.candidate;if(!p.id||!p.operationId||!p.space)stop('explicit-policy-required','Single candidate needs id, operationId and space.');const record=await write('evidence.candidate',{action:'create-quality-candidate',operationId:p.operationId,id:p.id,revision:0,client:{id:'http-quality-reexecution',kind:'agent'},candidate:{text:p.text,severity:p.severity},evidence:{jobId:completed.id,attemptId:completed.attempt.id,digest:completed.result.digest,side:p.side}},'candidate',{space:p.space});publication={createdIds:[record.id],policy:{space:p.space}};}
   else publication=await write(`${mode}.candidates`,input.candidate,'candidate',{id:completed.id});
   report.publication=publication;report.annotations=[];for(const id of publication.createdIds)report.annotations.push(await read('evidence.record',{space:publication.policy.space,id}));report.events=await read('evidence.events',{space:publication.policy.space},{after:0});
  }
  report.chain=await read(`${mode}.reexecutions`,{id});report.requests=requests;return report;
 }
 // Bounded read-only discovery; caller chooses IDs/versions, never filenames or nearest PTS.
 const query=new URLSearchParams(input.query??{includeUnknown:'1',limit:'16'});query.delete('cursor');const firstQuery=query.toString();let cursor=null,restarts=0;
 for(let n=0;n<64;n++){
  const q=new URLSearchParams(firstQuery);if(cursor)q.set('cursor',cursor);
  let page;try{page=await read('library.discover',{},Object.fromEntries(q));}catch(e){if(e.code==='discovery-snapshot-changed'&&restarts++===0){cursor=null;report.discovery=[];continue;}throw e;}
  report.discovery.push(...page.entries);cursor=page.nextCursor;if(!cursor)break;if(n===63)stop('discovery-budget','Discovery requires more pages; narrow the explicit scope.');
 }
 if(!input.reference||!input.distorted){report.next=['/api/agent/operations/library.describe','Supply explicit reference and distorted {id,version}; never infer a relation from names or duration.'];return report;}
 for(const source of [input.reference,input.distorted]){
  if(!/^[a-f0-9]{24}$/.test(source.id)||!/^[a-f0-9]{24}$/.test(source.version))stop('explicit-source-required','Select exact source IDs and versions from public discovery.');
  if(!report.discovery.some(e=>e.source.id===source.id&&e.source.version===source.version))stop('source-selection-changed','The explicit selected version is absent from the discovery snapshot.');
  await read('library.describe',{id:source.id},{v:source.version});
 }
 if(!Object.values(allow).some(Boolean)){report.next=['/agent/quality/sources.md','Explicit identity, prepare, plan and compute permissions are separate. No writes were performed.'];return report;}
 if(!actor){if(!input.identity)stop('identity-required','Supply an explicit existing identity ID or an explicitly authorized identity creation.');await write('identity.select',input.identity,'identity');}
 report.actor={id:actor};
 if(mode==='vmaf'){const cap=await read('vmaf.capability');report.nativeCapability=cap;if(!cap.enabled){report.next=['/agent/quality/vmaf.md','Native VMAF unavailable; no preparation, plan, scoring or metric substitution was performed.'];return report;}}
 const sources=[];
 for(const [side,source]of [['reference',input.reference],['distorted',input.distorted]]){
  let proof;
  try{proof=await read('quality.source',{id:source.id},{v:source.version});}
  catch(e){if(e.code!=='cache-miss')throw e;
   if(!allow.prepare){report.next=['/api/agent/operations/library.prepare'];report.reason='cache-miss';return report;}
   if(!input.client?.id||!input.client?.name)stop('explicit-client-required','Supply client id and name for preparation attribution.');
   const accepted=await write('library.prepare',{source,operation:'quality-index',client:input.client},'prepare',{},`prepare-${side}`);
   await observe('library.preparation',{id:accepted.job.id});proof=await read('quality.source',{id:source.id},{v:source.version});
  }
  sources.push(proof);
 }
 report.sources=sources;
 if(!allow.plan){report.next=['/api/agent/operations/relation.create','/api/agent/operations/plan.create'];return report;}
 if(!input.declaration||!input.clock||!input.plan)stop('explicit-plan-required','Supply declaration, exact clock segments, interval/sampling/recipe and total/planning budgets.');
 const client={id:input.client.id,kind:'agent'},relationSource=s=>({mediaId:s.id,mediaVersion:s.version,stream:'video',configuration:0});
 const relation=(await write('relation.create',{schema:'voidplayer-quality-reference-relation',version:1,client,reference:relationSource(input.reference),distorted:relationSource(input.distorted),declaration:input.declaration,clock:input.clock},'plan')).relation;
 const planInput={...input.plan,schema:'voidplayer-quality-correspondence-plan',version:1,client,relation:{id:relation.id,revision:relation.revision},referenceBuildId:sources[0].binding.indexBuildId,distortedBuildId:sources[1].binding.indexBuildId};
 const accepted=await write('plan.create',planInput,'plan'),detail=await observe('plan.get',{id:accepted.plan.id},v=>v.plan);report.plan=detail;
 // Explain the frozen AU facts independently of whether computation is authorized.
 report.rows=[];for(let after=0,n=0;n<16;n++){const page=await read('plan.rows',{id:accepted.plan.id},{after,limit:32});report.rows.push(...page.entries);if(page.nextAu===null)break;after=page.nextAu;}
 if(detail.summary?.executionBlock)stop('plan-blocked','The explicit plan is not executable; no holes were filled.',{summary:detail.summary});
 if(!allow.compute){report.next=[mode==='single'?'/api/agent/operations/single.submit':mode==='range'?'/api/agent/operations/plan.execute':'/api/agent/operations/vmaf.preflight'];return report;}
 let job,publication;
 if(mode==='single'){
  const frozen=await read('plan.range-input',{id:accepted.plan.id});if(frozen.pairs.length!==1)stop('single-pair-required','Single mode requires exactly one selected mapped pair.');
  job=(await write('single.submit',{schema:'voidplayer-psnr-frame-job',version:1,client,request:frozen.pairs[0]},'compute')).job;
  job=await observe('single.get',{id:job.id});report.job=job;report.result=await read('single.result',{id:job.id});
  if(allow.candidate){const p=input.candidate;if(!p?.id||!p.operationId||!p.space||!['reference','distorted'].includes(p.side)||typeof p.text!=='string'||!Number.isInteger(p.severity))stop('explicit-policy-required','Single publication requires explicit id, operationId, space, side, text and severity.');
   const record=await write('evidence.candidate',{action:'create-quality-candidate',operationId:p.operationId,id:p.id,revision:0,client,candidate:{text:p.text,severity:p.severity},evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:p.side}},'candidate',{space:p.space});publication={createdIds:[record.id],policy:{space:p.space}};
  }
 }else if(mode==='range'){
  job=(await write('plan.execute',{digest:detail.plan.resultDigest},'compute',{id:accepted.plan.id})).job;
  report.job=await observe('range.get',{id:job.id},v=>v.job);report.results=[];
  for(let after=0,n=0;n<16;n++){const page=await read('range.results',{id:job.id},{after,limit:4});report.results.push(...page.entries);if(page.nextAu===null)break;after=page.nextAu;}
  if(allow.candidate){if(!input.candidate)stop('explicit-policy-required','Supply an explicit complete candidate policy.');publication=await write('range.candidates',input.candidate,'candidate',{id:job.id});}
 }else{
  if(!input.vmaf)stop('explicit-native-required','Supply model, exact cadenceUs, metrics and native/raw/time budget.');
  const body={...input.vmaf,schema:'voidplayer-native-vmaf-job',version:1,client,plan:{id:detail.plan.id,attemptId:detail.plan.attemptId,digest:detail.plan.resultDigest}};
  await write('vmaf.preflight',body,'compute');job=(await write('vmaf.submit',body,'compute')).job;report.job=await observe('vmaf.get',{id:job.id});report.result=await read('vmaf.result',{id:job.id});report.frames=[];
  for(let after=0,n=0;n<8;n++){const page=await read('vmaf.frames',{id:job.id},{after,limit:4});report.frames.push(...page.entries);if(page.next===null)break;after=page.next;}
  if(allow.candidate){if(!input.candidate)stop('explicit-policy-required','Supply a complete explicit VMAF policy.');publication=await write('vmaf.candidates',input.candidate,'candidate',{id:job.id});}
 }
 if(publication){
  report.publication=publication;const space=publication.policy.space;report.annotations=[];for(const id of publication.createdIds)report.annotations.push(await read('evidence.record',{space,id}));
  report.viewerLinks=report.annotations.flatMap(record=>(record.document.mark.qualityEvidence??[]).map(e=>{const u=url(manifest.annotations.originalPairViewer.path);u.search=new URLSearchParams({space:record.space,annotationId:record.id,evidenceId:e.id}).toString();return {url:u.href,requiresFrontend:true,requiresBrowser:true,readOnly:true};}));
  report.events=[];for(let after=0,n=0;n<64;n++){const page=await read('evidence.events',{space},{after});if(page.resetRequired){report.snapshot=await get(page.snapshotUrl);report.eventReset=true;break;}report.events.push(...page.events);if(!page.more)break;after=page.cursor;}
 }else report.next=['/agent/quality/candidates.md','Publication requires explicit candidate permission and policy.'];
 report.requests=requests;return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [server,...args]=process.argv.slice(2),known={identity:'--allow-identity',prepare:'--allow-prepare',plan:'--allow-plan',compute:'--allow-compute',candidate:'--allow-candidate',reexecute:'--allow-reexecute',retryUnknown:'--allow-retry-unknown'},files=args.filter(a=>!a.startsWith('--')),flags=args.filter(a=>a.startsWith('--'));
 try{
  if(!server||files.length>1||flags.some(f=>!Object.values(known).includes(f)))throw Error('Usage: node examples/http-quality.mjs SERVER_ORIGIN [input.json] [--allow-identity] [--allow-prepare] [--allow-plan] [--allow-compute] [--allow-candidate] [--allow-reexecute] [--allow-retry-unknown]');
  const input=files[0]?JSON.parse(await readFile(files[0],'utf8')):{},allow=Object.fromEntries(Object.entries(known).map(([key,flag])=>[key,flags.includes(flag)]));
  console.log(JSON.stringify(await runHttpQuality(server,input,{allow}),null,2));
 }catch(e){console.error(JSON.stringify({code:e.code??'client-error',error:e.message,details:e.details??null}));process.exitCode=1;}
}
