import {bindNativePresentedFrame} from '../../shared/review/native-presented-binding.ts';
import {SessionResources} from '../session/resources.ts';
import type {ReviewSession} from '../session.ts';
import {t,msg} from '../i18n.ts';
import {currentActor} from '../services/identity.ts';
import {QualityClient} from '../services/quality-jobs.ts';
import {QualityJobObserver,type QualityObservation} from '../analysis/quality/job-observer.ts';
import {FramePairClient} from '../analysis/quality/pair-client.ts';
import type {QualityFramePage} from '../../shared/analysis/quality/selection.ts';
import type {FramePairRequest,InspectedFramePair} from '../../shared/analysis/quality/frame-pair.ts';
import {qualityRoi,draggedQualityRoi} from '../../shared/review/quality-roi.ts';
import {psnrGridPlan,type PsnrRoi} from '../../shared/analysis/quality/psnr.ts';
import {ssimPlan,SSIM_VARIANT} from '../../shared/analysis/quality/ssim.ts';
import {terminalQualityJob} from '../../shared/analysis/quality/jobs.ts';
import {paintFrame,setPresentationGeometry} from '../presentation/presenter.ts';
import type {DecodedFrame} from '../media/source.ts';
import {installQualityCandidate} from './quality-candidate.ts';
import {qualityFacts,forwardOutputText} from './quality-evidence.ts';
import {randomUUID} from '../../shared/utils/uuid.ts';

/** Explicit user action only. No playback seek/pause/index builder or private
 * job ownership hidden in a view. The AU choice belongs to this independent view. */
export function openQualityRoi(session:ReviewSession,mode:'explicit'|'presented'='explicit'){
  if(document.getElementById('quality-roi-dialog'))return;
  const presented=mode==='presented';
  const actor=currentActor()?.id;if(!actor)throw new Error(t(msg('qualityWorkflow.identityRequired','请先选择服务身份。')));
  const choices=session.qualitySourceChoices(),sourceScope=JSON.stringify(choices);
  if(!choices.length)throw new Error(t(msg('qualityRoi.libraryRequired','请先载入媒体库片源；本工具不上传本地文件。')));
  const clientKey=presented?'voidplayer-quality-presented-client':'voidplayer-quality-roi-client';
  let client=sessionStorage.getItem(clientKey);if(!client){client=randomUUID();sessionStorage.setItem(clientKey,client);}
  const root=document.createElement('dialog');root.className='quality-roi-dialog';root.id='quality-roi-dialog';root.dataset.selectionMode=mode;
  const heading=document.createElement('h2');heading.textContent=t(msg('qualityRoi.title','独立帧对与 ROI 测量'));
  const note=document.createElement('p');note.textContent=t(msg('qualityRoi.selection','播放器只提供已载入媒体。普通播放帧身份不继承：请分别显式选择缓存 AU，核验后查看独立快照。不会按 PTS 猜帧、自动建索引、暂停或定位播放器。'));
  if(presented){heading.textContent=t(msg('qualityRoi.presentedTitle','测量锁定的暂停画面'));note.textContent=t(msg('qualityRoi.presentedSelection','分别选择已暂停的原生解码轨道，锁定真正上屏的帧。后台测量该 AU 的原始源平面，不测屏幕转换后的像素；之后播放变化不改写已锁定的选择。不会自动暂停、定位或建立索引。不支持的解码与几何会明确拒绝。'));}
  const guarantee=document.createElement('p');guarantee.textContent=forwardOutputText();
  const close=document.createElement('button');close.type='button';close.textContent=t(msg('quality.close','关闭'));close.onclick=()=>root.close();
  const pickers=document.createElement('div');pickers.className='quality-roi-pickers';
  const status=document.createElement('p');status.role='status';status.id='quality-roi-status';
  const verify=document.createElement('button');verify.type='button';verify.id='quality-roi-verify';verify.textContent=t(msg('qualityRoi.verify','核验并呈现所选原始帧'));verify.disabled=true;
  const cancelPlan=document.createElement('button');cancelPlan.type='button';cancelPlan.textContent=t(msg('qualityRoi.cancelSnapshot','取消快照核验并释放 Worker'));
  const views=document.createElement('div');views.className='quality-roi-views';
  const form=document.createElement('form');form.id='quality-roi-form';form.hidden=true;
  const roiInputs={}as Record<keyof PsnrRoi,HTMLInputElement>;
  for(const key of ['x','y','width','height']as const){const label=document.createElement('label'),input=roiInputs[key]=document.createElement('input');input.name=key;input.type='number';input.step='2';input.min=key==='x'||key==='y'?'0':'2';input.required=true;label.append(key,input);form.append(label);}
  const snapNote=document.createElement('p');snapNote.textContent=t(msg('qualityRoi.snap','可在任一独立快照内拖选：端点吸附到最近的偶数源像素，数值立即显示；ROI 同时应用两侧。与播放器缩放、平移、分割和屏幕 DPR 无关。'));form.append(snapNote);
  const checkbox=(label:string)=>{const control=document.createElement('input');control.type='checkbox';const wrap=document.createElement('label');wrap.append(control,label);form.append(wrap);return control;};
  const ssim=checkbox(t(msg('quality.ssimEnable','同次测量另附 SSIM（FFmpeg 均匀 8×8，步长 4；不是高斯窗口 SSIM）')));ssim.id='quality-roi-ssim';const ssimNote=document.createElement('p');ssimNote.textContent=t(msg('quality.ssimMinimum','SSIM 的 ROI 和每个实际边缘块至少 16×16 源像素。仅计算有效窗口，各平面覆盖范围单独记录；不补边、不重采样。'));form.append(ssimNote);
  const grid=checkbox(t(msg('quality.spatialEnable','同次测量生成分块与最差区域证据（最多 64 块）')));grid.id='quality-roi-grid';
  const gridInputs=[document.createElement('input'),document.createElement('input')];for(const [i,input]of gridInputs.entries()){input.type='number';input.step='2';input.min='2';input.value='16';input.setAttribute('aria-label',i?'block height':'block width');form.append(input);}
  const submit=document.createElement('button');submit.type='submit';submit.id='quality-roi-submit';submit.textContent=t(msg('qualityWorkflow.submit','发起持久测量'));form.append(submit);
  const retry=document.createElement('button');retry.type='button';retry.hidden=true;retry.id='quality-roi-retry';retry.textContent=t(msg('qualityWorkflow.retry','使用原幂等键重试提交'));
  const stop=document.createElement('button');stop.type='button';stop.disabled=true;stop.id='quality-roi-cancel';stop.textContent=t(msg('qualityWorkflow.cancel','取消任务'));
  const life=document.createElement('p');life.textContent=t(msg('qualityWorkflow.lifetime','任务由服务持有。关闭此页或切换分类只停止观察；仅“取消任务”会请求终止。网络故障不表示任务失败。'));
  if(presented)life.append(document.createTextNode(t(msg('qualityRoi.preparationLifetime',' 尚未完成的显式缓存构建与快照准备会在关闭时请求取消；已提交的持久评分任务继续运行。'))));
  const jobStatus=document.createElement('p');jobStatus.role='status';jobStatus.id='quality-roi-job-status';
  const history=document.createElement('a');history.href='/admin/#quality';history.target='_blank';history.rel='noopener';history.textContent=t(msg('qualityRoi.history','在任务管理中继续观察历史任务'));life.append(document.createTextNode(' '),history);
  const resultRoot=document.createElement('section');root.append(heading,close,note,guarantee,pickers,verify,cancelPlan,status,views,form,retry,stop,life,jobStatus,resultRoot);document.body.append(root);root.showModal();
  const resources=new SessionResources(64*1024*1024);
  const lifeController=new AbortController(),signal=lifeController.signal,api=new QualityClient(),worker=new FramePairClient();
  let enabled=false,canBuildSource=false;let pendingSources:Promise<void>=Promise.resolve();
  let planning:AbortController|undefined,pendingPlan:Promise<unknown>=Promise.resolve(),sequence=0,plan:InspectedFramePair|undefined,request:FramePairRequest|undefined;
  let frames:DecodedFrame[]=[],pages:(QualityFramePage|undefined)[]=[undefined,undefined],selected:(number|undefined)[]=[undefined,undefined],queries=[0,0],observation:QualityObservation|undefined,lastResult='';
  const builds:(AbortController|undefined)[]=[undefined,undefined];
  const valid=()=>!signal.aborted&&root.open&&root.isConnected&&currentActor()?.id===actor&&JSON.stringify(session.qualitySourceChoices())===sourceScope;
  const controls:HTMLSelectElement[]=[],sourceControls:HTMLSelectElement[]=[],nextButtons:HTMLButtonElement[]=[];
  const canvases:HTMLCanvasElement[]=[],stages:HTMLElement[]=[],captions:HTMLElement[]=[],overlays:SVGSVGElement[]=[];
  const clear=()=>{plan=undefined;request=undefined;for(const frame of frames)frame.close();frames=[];for(const canvas of canvases)setPresentationGeometry(canvas,null);for(const stage of stages){delete stage.dataset.presentedCommit;delete stage.dataset.roiBinding;}views.hidden=true;form.hidden=true;};
  const invalidate=()=>{sequence++;planning?.abort();clear();};
  const actions=()=>{verify.disabled=!enabled||!valid()||selected.some(x=>x===undefined)||!!observation?.pending||!!observation?.busy;submit.disabled=!enabled||!request||!!observation?.pending||!!observation?.busy;retry.hidden=!observation?.pending;retry.disabled=!!observation?.busy;for(const input of form.querySelectorAll<HTMLInputElement>('input'))input.disabled=!!observation?.pending||!!observation?.busy;for(const control of [...controls,...sourceControls,...nextButtons])control.disabled=!!observation?.pending||!!observation?.busy;};
  const discovery=api.request<{capabilities:{id:string;enabled:boolean}[]}>(actor!,'/api/agent',signal).then(manifest=>{if(!valid())return false;enabled=manifest.capabilities.some(c=>c.id==='quality.jobs'&&c.enabled);canBuildSource=manifest.capabilities.some(c=>c.id==='quality.source-build'&&c.enabled);if(!enabled)status.textContent=t(msg('qualityWorkflow.unavailable','此实例不提供持久画质任务（例如临时数据库）。不会回退到浏览器临时计算。'));actions();return enabled;}).catch(error=>{if(valid())status.textContent=String(error);return false;});
  const roi=()=>qualityRoi(frames[0].width,frames[0].height,Object.fromEntries(Object.entries(roiInputs).map(([key,input])=>[key,Number(input.value)]))as PsnrRoi);
  function overlay(){for(const svg of overlays){svg.replaceChildren();if(!frames.length)return;try{const r=roi(),rect=document.createElementNS(svg.namespaceURI,'rect');for(const [key,value]of Object.entries({x:r.x,y:r.y,width:r.width,height:r.height}))rect.setAttribute(key,String(value));rect.setAttribute('vector-effect','non-scaling-stroke');svg.append(rect);}catch{/* Invalid numeric input is shown on submit; never paints a guessed ROI. */}}}
  const setRoi=(r:PsnrRoi)=>{for(const key of Object.keys(r)as (keyof PsnrRoi)[])roiInputs[key].value=String(r[key]);overlay();};
  for(const side of [0,1]){
    const field=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=side?'distorted':'reference';
    const source=document.createElement('select');source.dataset.roiSource=String(side);for(const [i,choice]of choices.entries())source.add(new Option(`${choice.slot} · ${choice.name}`,String(i)));source.value=String(Math.min(side,choices.length-1));
    const au=document.createElement('select');au.dataset.roiAu=String(side);au.add(new Option('—',''));const next=document.createElement('button');next.type='button';next.textContent=t(msg('qualityWorkflow.moreFrames','下一页候选帧'));next.hidden=true;
    const refresh=document.createElement('button');refresh.type='button';refresh.dataset.roiRefresh=String(side);refresh.textContent=presented?t(msg('qualityRoi.recapture','重新捕获暂停画面')):t(msg('qualityRoi.refresh','重新读取缓存候选'));refresh.onclick=()=>void load();field.append(legend,source,au,next,refresh);pickers.append(field);controls.push(au);sourceControls.push(source);nextButtons.push(next,refresh);
    const build=document.createElement('button'),cancelBuild=document.createElement('button');build.type=cancelBuild.type='button';build.dataset.roiBuild=String(side);cancelBuild.dataset.roiBuildCancel=String(side);
    build.textContent=t(msg('qualityRoi.buildSource','显式构建可信缓存（最多64MiB来源、30秒执行）'));cancelBuild.textContent=t(msg('qualityRoi.cancelBuild','取消缓存构建'));build.hidden=cancelBuild.hidden=true;
    if(presented){au.hidden=true;field.append(build,cancelBuild);nextButtons.push(build);}
    const section=document.createElement('section'),caption=document.createElement('p'),stage=document.createElement('div'),canvas=document.createElement('canvas'),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    stage.className='quality-roi-stage';stage.dataset.roiStage=String(side);svg.classList.add('quality-roi-overlay');stage.append(canvas,svg);section.append(caption,stage);views.append(section);canvases.push(canvas);stages.push(stage);captions.push(caption);overlays.push(svg);
    let start:{x:number;y:number}|undefined;
    const point=(event:PointerEvent)=>{const matrix=svg.getScreenCTM();if(!matrix)throw new Error('Snapshot coordinate transform is unavailable');const p=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());return{x:p.x/frames[side].width,y:p.y/frames[side].height};};
    svg.onpointerdown=event=>{if(!frames.length||observation?.pending||observation?.busy)return;try{start=point(event);}catch(error){status.textContent=String(error);return;}svg.setPointerCapture(event.pointerId);};
    svg.onpointerup=event=>{if(!start)return;const from=start;start=undefined;if(observation?.pending||observation?.busy)return;try{setRoi(draggedQualityRoi(frames[side].width,frames[side].height,from,point(event)));status.textContent=JSON.stringify(roi());}catch(error){status.textContent=String(error);}};
    svg.onpointercancel=()=>{start=undefined;};
    async function load(more=false){const q=++queries[side];builds[side]?.abort();build.hidden=true;delete field.dataset.presentedInput;invalidate();selected[side]=undefined;au.replaceChildren(new Option('—',''));actions();const previous=pages[side];pages[side]=undefined;next.hidden=true;
      const previousRead=pendingSources;let release!:()=>void;pendingSources=new Promise<void>(resolve=>release=resolve);await previousRead;
      try{if(!await discovery||!valid()||queries[side]!==q)return;const choice=choices[Number(source.value)],url=new URL(choice.source.url,location.origin);if(url.origin!==location.origin||!url.searchParams.get('v'))throw new Error('A version-locked same-service library source is required');
        const capture=presented?session.captureNativePresented(choice.slot):undefined;
        const binding=capture?await api.source(actor!,choice.source.id,url.searchParams.get('v')!,signal):undefined;
        const page=await api.frames(actor!,choice.source.id,url.searchParams.get('v')!,capture?{afterAu:capture.input.au,limit:1,buildId:binding!.binding.indexBuildId}:{afterAu:more?previous?.nextAu??0:0,limit:50,...(more&&previous?{buildId:previous.source.binding.indexBuildId}:{})},signal);
        if(!valid()||queries[side]!==q)return;if(!page.inspection.supported)throw new Error(page.inspection.reason??'Unsupported snapshot geometry');pages[side]=page;
        if(capture){if(!session.isNativePresentedCurrent(capture))throw new Error(t(msg('qualityRoi.captureChanged','查询期间暂停画面已变化，请重新捕获。')));const target=bindNativePresentedFrame(capture,page,location.origin);page.entries=[target];selected[side]=0;}
        for(const [i,target]of page.entries.entries())au.add(new Option(`AU ${target.picture.au} · source PTS ${target.sourcePtsUs} µs`,String(i)));next.hidden=presented||page.nextAu===null;caption.textContent=`${choice.name} · ${page.codec} · ${JSON.stringify(page.source.binding)}`;
        if(capture){field.dataset.presentedInput=JSON.stringify(capture);caption.textContent+=` · commit ${capture.commit} · AU ${capture.input.au}`;}
        status.textContent=presented?t(msg('qualityRoi.captured','已锁定两侧所选暂停帧；请明确核验原始帧与 ROI。相同 PTS 不表示跨源对应关系。')):t(msg('qualityRoi.selectAu','请显式选择两侧 AU；相同 PTS 不表示跨源对应关系。'));
      }catch(error){if(valid()&&queries[side]===q){pages[side]=undefined;selected[side]=undefined;build.hidden=!presented||!canBuildSource||(error as {code?:string}).code!=='cache-miss';status.textContent=error instanceof Error?error.message:String(error);}}finally{release();if(valid())actions();}}
    build.onclick=()=>{if(build.disabled||builds[side])return;const q=++queries[side],controller=builds[side]=new AbortController();invalidate();build.disabled=true;cancelBuild.hidden=false;
      status.textContent=t(msg('qualityRoi.building','正在执行单独的有界缓存构建；不解码像素、不提交评分。取消后须关闭文件与 Worker 才释放服务容量，完成与取消竞争时请显式重新读取缓存。'));
      const previous=pendingSources;let release!:()=>void;pendingSources=new Promise<void>(resolve=>release=resolve);
      void(async()=>{await previous;let completed=false;try{if(!valid()||q!==queries[side]||controller.signal.aborted)return;const choice=choices[Number(source.value)],url=new URL(choice.source.url,location.origin);if(url.origin!==location.origin||!url.searchParams.get('v'))throw new Error('A version-locked same-service source is required');
        await api.buildSource(actor!,choice.source.id,url.searchParams.get('v')!,AbortSignal.any([signal,controller.signal]));completed=true;
      }catch(error){if(valid()&&q===queries[side])status.textContent=error instanceof Error?error.message:String(error);}finally{release();builds[side]=undefined;cancelBuild.hidden=true;if(valid()){actions();if(completed&&q===queries[side])void load();else build.disabled=false;}}})();};
    cancelBuild.onclick=()=>{builds[side]?.abort();status.textContent=t(msg('qualityRoi.buildCancelRequested','已请求取消缓存构建；服务将在文件和 Worker 实际关闭后释放容量。若构建已提交，请显式重新读取缓存。'));};
    source.onchange=()=>void load();next.onclick=()=>void load(true);au.onchange=()=>{invalidate();selected[side]=au.value===''?undefined:Number(au.value);actions();};void load();
  }
  const redraw=()=>{if(!frames.length)return;for(const [i,frame]of frames.entries()){const stage=stages[i],width=stage.clientWidth,height=stage.clientHeight;if(!width||!height)throw new Error('Snapshot view has no drawable geometry');setPresentationGeometry(canvases[i],{width,height,imageWidth:frame.width,imageHeight:frame.height,zoom:Math.min(width/frame.width,height/frame.height),offsetX:0,offsetY:0,dpr:devicePixelRatio});paintFrame(canvases[i],frame);if(!Number.isSafeInteger(frame.presentedCommit)||frame.presentedCommit!<1)throw new Error('Snapshot presentation has no successful identity commit');stages[i].dataset.presentedCommit=String(frame.presentedCommit);}overlay();};
  verify.onclick=()=>{if(verify.disabled)return;invalidate();const g=sequence,controller=planning=new AbortController();status.textContent=t(msg('qualityRoi.verifying','独立 Worker 正在核验源版本、缓存见证、AU 输出身份、颜色和精确几何…'));verify.disabled=true;
    const task=pendingPlan.catch(()=>{}).then(async()=>{try{if(!valid()||g!==sequence)return;const [a,b]=pages as [QualityFramePage,QualityFramePage];if(a.geometry.width!==b.geometry.width||a.geometry.height!==b.geometry.height)throw new Error('Snapshot grids must have equal visible dimensions');
      const full={x:0,y:0,width:a.geometry.width,height:a.geometry.height},input:FramePairRequest={pairing:'caller-specified',reference:a.entries[selected[0]!],distorted:b.entries[selected[1]!],roi:qualityRoi(full.width,full.height,full)};
      const inspected=await worker.plan(input,[a.source,b.source],actor!,location.href,controller.signal);if(!valid()||g!==sequence)return;plan=inspected;
      frames=[];for(const [i,raw]of inspected.frames.entries()){const release=resources.reserve('derived',raw.pixels.byteLength);if(!release)throw new Error('ROI snapshot memory budget exceeded');frames.push({kind:'yuv',width:raw.description.width,height:raw.description.height,description:raw.description,ptsUs:0,sourcePtsUs:raw.pts,durationUs:1,byteSize:raw.pixels.byteLength,rotation:0,pixels:new Uint8ClampedArray(raw.pixels.buffer,raw.pixels.byteOffset,raw.pixels.byteLength),sourcePicture:structuredClone((i?inspected.provenance.distorted:inspected.provenance.reference).picture),close:release});}
      for(const [i,frame]of frames.entries()){const p=i?inspected.provenance.distorted:inspected.provenance.reference;captions[i].textContent=`${p.mediaId}@${p.mediaVersion} · AU ${p.picture.au} · source PTS ${p.sourcePtsUs} µs · ${JSON.stringify(p.indexIdentity)} · build ${p.indexBuildId}`;stages[i].dataset.roiBinding=JSON.stringify({target:p,sourceGeometry:inspected.sourceGeometry[i?'distorted':'reference']});stages[i].style.aspectRatio=`${frame.width}/${frame.height}`;overlays[i].setAttribute('viewBox',`0 0 ${frame.width} ${frame.height}`);}views.hidden=false;form.hidden=false;setRoi(full);redraw();request=input;
      status.textContent=t(msg('qualityRoi.ready','两侧独立快照已核验并上屏；仅此快照的明确 AU 与源网格用于 ROI，播放器保持独立。'));
    }catch(error){if(valid()&&g===sequence){clear();status.textContent=error instanceof Error?error.message:String(error);}}finally{if(valid()&&g===sequence)actions();}});pendingPlan=task;};
  cancelPlan.onclick=()=>{invalidate();status.textContent=t(msg('qualityRoi.snapshotCancelled','快照核验已取消；正在等待 Worker 实际退出后复用容量。'));void pendingPlan.finally(actions);};
  for(const input of Object.values(roiInputs))input.oninput=overlay;
  const observer=new QualityJobObserver(api,actor,client,value=>{if(!valid())return;observation=value;actions();const job=value.detail;jobStatus.textContent=[job?`${job.id} · ${job.state} · ${job.phase} · ${job.progress.scoredPairs}/1`:'',value.operationError?String(value.operationError):'',value.error?String(value.error):''].filter(Boolean).join('\n');stop.disabled=!job||terminalQualityJob(job.state)||job.state==='cancelling';
    const key=value.result?`${value.result.jobId}/${value.result.attemptId}`:'';if(lastResult!==key){lastResult=key;resultRoot.replaceChildren();if(value.result&&job){qualityFacts(resultRoot,value.result.value);const candidate=document.createElement('section');resultRoot.append(candidate);installQualityCandidate(candidate,job,actor,client!,signal);}}
  },sessionStorage);
  form.onsubmit=event=>{event.preventDefault();if(!valid()||!plan||!request||submit.disabled)return;try{const selectedRoi=roi(),spatial=grid.checked?{blockWidth:Number(gridInputs[0].value),blockHeight:Number(gridInputs[1].value)}:undefined,companion=ssim.checked?{variant:SSIM_VARIANT}:undefined;if(spatial)psnrGridPlan(selectedRoi,spatial);if(companion)ssimPlan(selectedRoi,companion,spatial);
    void observer.submit({schema:'voidplayer-psnr-frame-job',version:1,client:{kind:'browser',id:client!},request:{...structuredClone(request),roi:selectedRoi,...(spatial?{spatial}:{}),...(companion?{ssim:companion}:{})}}).then(()=>observer.poll());
  }catch(error){status.textContent=error instanceof Error?error.message:String(error);}};
  retry.onclick=()=>void observer.submit().then(()=>observer.poll());stop.onclick=()=>{if(observation?.detail)void observer.cancel(observation.detail.id);};
  const resized=new ResizeObserver(()=>{try{redraw();}catch(error){invalidate();status.textContent=error instanceof Error?error.message:String(error);}});for(const stage of stages)resized.observe(stage);
  const unsubscribe=session.subscribe(()=>{if(!valid())root.close();});
  const revoke=()=>{lifeController.abort();root.close();};window.addEventListener('pagehide',revoke,{signal});window.addEventListener('voidplayer-identity-change',revoke,{signal});window.addEventListener('storage',event=>{if(event.key==='voidplayer.identity')revoke();},{signal});
  const timer=setInterval(()=>{if(enabled&&valid()&&!document.hidden)void observer.poll();},1000);
  root.addEventListener('close',()=>{lifeController.abort();observer.dispose();invalidate();clearInterval(timer);unsubscribe();resized.disconnect();root.remove();},{once:true});
  void discovery.then(ready=>{if(ready&&valid())void observer.poll();});actions();
}
