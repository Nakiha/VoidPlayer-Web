import {t,msg,initializeLanguage} from '../i18n.ts';
import {AnnotationClient} from '../review/annotation-client.ts';
import {identityHealth,currentActor} from '../services/identity.ts';
import {cambiEvidenceList} from '../../shared/review/cambi-evidence.ts';
import type {CambiEvidence} from '../../shared/review/cambi-evidence.ts';
import {cambiScales} from '../../shared/analysis/quality/cambi.ts';
import type {CambiFrame,CambiJob,CambiPrepared,CambiNative} from '../../shared/analysis/quality/cambi.ts';
import {paintFrame,setPresentationGeometry,disposePresentation} from '../presentation/presenter.ts';
import type {DecodedFrame} from '../media/source.ts';
import type {FrameDescription} from '../../shared/media/frame-description.ts';
import './quality-pair-view.css';
await initializeLanguage();
const root=document.getElementById('pair-view')!,query=new URL(location.href).searchParams;
const space=query.get('space')??'',id=query.get('annotationId')??'',eid=query.get('evidenceId')??'',jobId=query.get('cambiJob')??'',index=Number(query.get('index'));
root.id='cambi-view';root.dataset.state='loading';
const title=document.createElement('h1');title.textContent=t(msg('cambi.viewer1','CAMBI · 原始多尺度色带证据'));
const note=document.createElement('p');note.textContent=t(msg('cambi.viewer2','固定官方 gray16le 热图，分数高=更多 banding 线索，不是合格线。尺度格点按2^scale映射到源坐标；局部窗口有邻域影响，不等于物体边界、跟踪或裁剪重算。显示转换不改变评分原始8/10位平面。未认证引用完整性，concealment unavailable。'));
const cancel=document.createElement('button');cancel.textContent=t(msg('cambi.viewer3','取消此查看（后台任务不受影响）'));
const status=document.createElement('p');status.id='cambi-view-status';status.role='status';
const facts=document.createElement('pre');facts.id='cambi-view-facts';
const pick=document.createElement('select');pick.id='cambi-view-scale';pick.setAttribute('aria-label','CAMBI scale');pick.disabled=true;
for(let i=0;i<5;i++)pick.add(new Option('scale '+i,String(i)));
const expanded=document.createElement('details'),expandLabel=document.createElement('summary');expandLabel.textContent=t(msg('cambi.fullFacts','完整的不可变来源与 recipe 证据'));expanded.append(expandLabel,facts);
const views=document.createElement('div');views.className='quality-pair-views';
const original=document.createElement('canvas');original.id='cambi-original';const heat=document.createElement('canvas');heat.id='cambi-heatmap';const stages:HTMLElement[]=[];
for(const [name,canvas]of [[t(msg('cambi.viewer4','经源/cache/AU/原始字节核验的独立快照')),original],[t(msg('cambi.viewer5','官方原始热图（0–65535固定线性显示）')),heat]] as const){const section=document.createElement('section'),label=document.createElement('h2'),stage=document.createElement('div');label.textContent=name;stage.className='frame-stage';stage.append(canvas);section.append(label,stage);views.append(section);stages.push(stage);}
const caption=document.createElement('p');caption.id='cambi-view-caption';root.append(title,note,cancel,status,pick,views,caption,expanded);views.style.visibility='hidden';
const outline=document.createElementNS('http://www.w3.org/2000/svg','svg');outline.classList.add('quality-pair-roi');outline.setAttribute('aria-label','CAMBI evidence region in source grid');stages[0].append(outline);
type Fact={frame:CambiFrame;geometry:CambiPrepared['geometry'];coverage:CambiPrepared['coverage'];shared?:CambiEvidence;native?:Pick<CambiNative,'recipe'|'component'>;identity:string};
let controller=new AbortController(),heatController=new AbortController(),epoch=0,heatSeq=0,frame:DecodedFrame|null=null,fact:Fact|null=null,owner='';
const sharedBase=`/api/quality/cambi/shared/${encodeURIComponent(space)}/${encodeURIComponent(id)}/${encodeURIComponent(eid)}`;
const privateBase='/api/quality/cambi/jobs/'+encodeURIComponent(jobId);
function stop(){epoch++;heatSeq++;controller.abort();heatController.abort();controller=new AbortController();frame?.close();frame=null;fact=null;facts.textContent='';caption.textContent='';pick.disabled=true;views.style.visibility='hidden';root.dataset.state='cancelled';status.textContent='cancelled';}
const hash=async(b:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b as Uint8Array<ArrayBuffer>))].map(n=>n.toString(16).padStart(2,'0')).join('');
async function bounded(url:string,signal:AbortSignal,max:number){const r=await fetch(url,{signal,cache:'no-store',headers:jobId?{'x-voidplayer-actor':owner}:{}});if(!r.ok)throw Error(`${r.status}: ${await r.text()}`);const reader=r.body!.getReader();let length=0;const parts:Uint8Array[]=[];try{for(;;){const v=await reader.read();if(v.done)break;length+=v.value.length;if(length>max)throw Error('CAMBI view response byte budget');parts.push(v.value);}}finally{await reader.cancel();}const out=new Uint8Array(length);let at=0;for(const b of parts){out.set(b,at);at+=b.length;}return out;}
const json=async<T>(url:string,signal:AbortSignal,max=2*1024*1024):Promise<T>=>JSON.parse(new TextDecoder().decode(await bounded(url,signal,max)));
async function read(signal:AbortSignal):Promise<Fact>{
 if(jobId){
  if(!/^cambi-[a-f0-9-]{36}$/.test(jobId)||!query.has('index')||!Number.isInteger(index)||index<0||index>=32)throw Error('Invalid owned CAMBI reference');
  const job=await json<CambiJob>(privateBase,signal);if(job.state!=='completed'||!job.resultDigest||job.actor.id!==owner)throw Error('A completed owned CAMBI result is required');
  const summary=await json<{geometry:CambiPrepared['geometry'];coverage:CambiPrepared['coverage'];recipe:CambiNative['recipe'];component:CambiNative['component']}>(privateBase+'/result',signal);
  const page=await json<{entries:CambiFrame[]}>(privateBase+`/frames?after=${index}&limit=1`,signal),f=page.entries[0];if(!f||f.index!==index)throw Error('Selected CAMBI frame missing');
  return {frame:f,geometry:summary.geometry,coverage:summary.coverage,native:{recipe:summary.recipe,component:summary.component},identity:JSON.stringify([job.id,job.attemptId,job.resultDigest])};
 }
 if(![space,id,eid].every(v=>/^[A-Za-z0-9_-]{1,200}$/.test(v)))throw Error('Invalid shared CAMBI reference');
 const record=await new AnnotationClient(signal).read(space,id);if(record.deleted)throw Error('Annotation deleted');const e=record.document.mark.cambiEvidence?.find(e=>e.id===eid);if(!e)throw Error('CAMBI attachment removed');
 const checked=cambiEvidenceList([e],true)[0];if(checked.verification!=='server-verified'||checked.serviceOrigin!==location.origin)throw Error('Historical or foreign evidence cannot inherit verification');
 return {frame:checked.value.frame,geometry:checked.value.geometry,coverage:checked.value.coverage,shared:checked,identity:JSON.stringify(checked)};
}
function redraw(){
 if(!frame||!fact)return;const g=fact.geometry,stage=stages[0],zoom=Math.min(stage.clientWidth/g.width,stage.clientHeight/g.height);
 setPresentationGeometry(original,{width:stage.clientWidth,height:stage.clientHeight,imageWidth:g.width,imageHeight:g.height,zoom,offsetX:0,offsetY:0,dpr:devicePixelRatio});paintFrame(original,frame);if(frame.presentedCommit===undefined)throw Error('CAMBI source not successfully presented');
 outline.setAttribute('viewBox',`0 0 ${g.width} ${g.height}`);outline.replaceChildren();if(fact.shared){const r=fact.shared.ref.region,factor=fact.shared.value.heatmap.mapping.factor,rect=document.createElementNS(outline.namespaceURI,'rect');for(const [k,v]of Object.entries({x:r.x*factor,y:r.y*factor,width:Math.min(g.width,(r.x+r.width)*factor)-r.x*factor,height:Math.min(g.height,(r.y+r.height)*factor)-r.y*factor}))rect.setAttribute(k,String(v));rect.setAttribute('vector-effect','non-scaling-stroke');outline.append(rect);}
}
async function loadHeat(){
 if(!fact)return;heatController.abort();heatController=new AbortController();const f=fact,s=Number(pick.value),ticket=++heatSeq,seq=epoch,signal=AbortSignal.any([controller.signal,heatController.signal]),scale=cambiScales(f.geometry.width,f.geometry.height)[s];
 const url=jobId?`${privateBase}/heatmap?index=${index}&scale=${s}`:sharedBase+'?scale='+s,bytes=await bounded(url,signal,scale.bytes);
 if(bytes.length!==scale.bytes||await hash(bytes)!==f.frame.heatmaps[s].sha256)throw Error('Official CAMBI heatmap bytes differ');if(seq!==epoch||signal.aborted||ticket!==heatSeq)return;
 heat.width=scale.width;heat.height=scale.height;const ctx=heat.getContext('2d')!,image=ctx.createImageData(scale.width,scale.height),dv=new DataView(bytes.buffer);
 for(let i=0;i<bytes.length/2;i++){const v=dv.getUint16(i*2,true)/257;image.data[i*4]=v;image.data[i*4+1]=v/4;image.data[i*4+2]=0;image.data[i*4+3]=255;}ctx.putImageData(image,0,0);heat.dataset.sha256=f.frame.heatmaps[s].sha256;heat.dataset.scale=String(s);
 caption.textContent=`CAMBI ${f.frame.score} · AU ${f.frame.target.picture.au} · source PTS ${f.frame.target.sourcePtsUs}µs · ${scale.width}×${scale.height} · source lattice (${scale.mapping.factor}x,${scale.mapping.factor}y), ceil edges · coverage ${f.coverage.scored}/${f.coverage.intervalAus}, unsampled ${f.coverage.unsampled}, unsupported ${f.coverage.unsupported.length} · no crop rescore`;
 if(f.shared&&s===f.shared.ref.scale){const r=f.shared.ref.region;ctx.strokeStyle='#00b7ff';ctx.lineWidth=1;ctx.strokeRect(r.x+.5,r.y+.5,r.width-1,r.height-1);}
}
async function open(){
 stop();const seq=epoch,signal=controller.signal;root.dataset.state='loading';status.textContent=t(msg('cambi.viewer6','核对共享不可变附件、原始热图与独立源快照…'));
 const current=()=>{if(seq!==epoch||signal.aborted)throw new DOMException('View superseded','AbortError');};
 try{
  if(jobId){owner=(await identityHealth()).actor?.id??'';current();if(!owner)throw Error('Choose the result owner identity first');}
  const f=await read(signal);current();fact=f;pick.value=String(f.shared?.ref.scale??0);
  const raw=await json<{pixelsBase64:string;description:FrameDescription;rawSha256:string}>(jobId?`${privateBase}/picture?index=${index}`:sharedBase+'/picture',signal,16*1024*1024);current();
  const decoded=Uint8Array.from(atob(raw.pixelsBase64),c=>c.charCodeAt(0)),d=raw.description;
  if(raw.rawSha256!==f.frame.rawSha256||JSON.stringify(d)!==JSON.stringify(f.frame.provenance.decoded.description))throw Error('Snapshot description differs');
  const parts:Uint8Array[]=[];for(const [i,p]of d.yuv!.planes.entries())for(let y=0;y<(i?d.height/2:d.height);y++)parts.push(decoded.subarray(p.offset+y*p.stride,p.offset+y*p.stride+(i?d.width/2:d.width)*(d.yuv!.bitDepth===8?1:2)));
  const tight=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){tight.set(p,at);at+=p.length;}if(await hash(tight)!==f.frame.rawSha256)throw Error('Snapshot raw planes differ');current();
  const fresh=await read(signal);current();if(JSON.stringify(fresh)!==JSON.stringify(f))throw Error('Immutable CAMBI evidence changed');if(jobId&&(await identityHealth()).actor?.id!==owner)throw Error('actor-changed');current();
  let closed=false;frame={kind:'yuv',width:d.width,height:d.height,description:d,pixels:new Uint8ClampedArray(decoded.buffer),ptsUs:0,sourcePtsUs:f.frame.target.sourcePtsUs,durationUs:1,byteSize:decoded.byteLength,rotation:0,sourcePicture:f.frame.target.picture,close(){if(!closed){closed=true;decoded.fill(0);}}};redraw();await loadHeat();current();
  facts.textContent=JSON.stringify(f.shared??f,null,2);views.style.visibility='visible';pick.disabled=false;root.dataset.state='ready';status.textContent=t(msg('cambi.viewer7','源身份、cache build、AU、真实 PTS、原始平面 SHA256 与官方热图布局已核对；未重新评分。'));
 }catch(error){if(seq===epoch){frame?.close();frame=null;fact=null;facts.textContent='';views.style.visibility='hidden';root.dataset.state=signal.aborted?'cancelled':'failed';status.textContent=String(error);}}
}
cancel.onclick=stop;pick.onchange=()=>{void loadHeat().catch(e=>{if(e?.name==='AbortError')return;views.style.visibility='hidden';root.dataset.state='failed';status.textContent=String(e);});};
const observer=new ResizeObserver(()=>{try{redraw();}catch(e){stop();status.textContent=String(e);}});observer.observe(stages[0]);
window.addEventListener('storage',e=>{if(jobId&&e.key==='voidplayer.identity')stop();});window.addEventListener('voidplayer-identity-change',()=>{if(jobId&&owner&&(currentActor()?.id??'')!==owner)stop();});
window.addEventListener('pagehide',()=>{stop();observer.disconnect();disposePresentation();},{once:true});void open();
