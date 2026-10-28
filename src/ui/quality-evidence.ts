import {cambiEvidenceApplies} from '../../shared/review/cambi-evidence.ts';
import { qualityPairViewUrl } from '../../shared/review/quality-pair-view.ts';
import { t, msg } from '../i18n.ts';
import type { Mark } from '../../shared/review/model.ts';
import type { AnnotationDocument, AnnotationRecord } from '../../shared/review/annotation-record.ts';
import type { QualityJob } from '../../shared/analysis/quality/jobs.ts';
import { qualityEvidenceValue, evidenceApplies } from '../../shared/review/quality-evidence.ts';
import { attachAnnotationQuality } from '../review/quality-evidence-client.ts';
import { randomUUID } from '../../shared/utils/uuid.ts';
import { currentActor } from '../services/identity.ts';
import { qualitySpatial } from './quality-spatial.ts';

type Target = {space:string;id:string;revision:number;actor:string;document:AnnotationDocument};
export function forwardOutputText(){
  return t(msg('quality.forwardGuarantee','精确绑定的是所选码流窗口的实际解码输出，未认证引用图完整性。当前接口无法检测错误隐藏（concealment）；缺失参考帧仍可能返回分数。'));
}
function dialog(title: string) {
  const root=document.createElement('dialog');root.className='quality-evidence-dialog';root.setAttribute('aria-label',title);
  const heading=document.createElement('h2');heading.textContent=title;
  const close=document.createElement('button');close.type='button';close.textContent=t(msg('quality.close', "关闭"));close.onclick=()=>root.close();
  root.append(heading,close);root.addEventListener('close',()=>root.remove(),{once:true});document.body.append(root);root.showModal();return root;
}
export function qualityFacts(root:HTMLElement,value:ReturnType<typeof qualityEvidenceValue>) {
  const metric=value.result.metric,score=metric.aggregate.psnr;
  const summary=document.createElement('p');summary.className='quality-evidence-score';
  summary.textContent=t(msg('quality.score', 'PSNR {score} dB · 越高越好 · {depth} 位源 YUV 码值 · ROI {roi}'), {score:score.kind==='positive-infinity'?'∞':score.db.toFixed(4),depth:metric.bitDepth,roi:JSON.stringify(metric.roi)});
  const conditions=document.createElement('p');conditions.textContent=`${metric.implementation} · ${value.result.decoder.backend} ${value.result.decoder.buildId} · ${JSON.stringify(metric.color)}`;
  const sources=document.createElement('dl');
  for(const side of ['reference','distorted']as const){const source=value.result.provenance[side],label=document.createElement('dt'),identity=document.createElement('dd');label.textContent=side;identity.textContent=`${source.mediaId}@${source.mediaVersion} · source PTS ${source.sourcePtsUs} µs · AU ${source.picture.au}${source.decode?` · decode AU ${source.decode.startAu}→${source.decode.mode==='packet-identity-gop-v1'?source.decode.endAu:source.picture.au} · target AU ${source.picture.au} (${source.dependency?.outputFrames} outputs)`:``}`;sources.append(label,identity);}
  const details=document.createElement('details'),heading=document.createElement('summary'),data=document.createElement('pre');
  heading.textContent=t(msg('quality.fullProvenance','完整不可变 provenance'));data.className='quality-evidence-provenance';data.textContent=JSON.stringify(value,null,2);details.append(heading,data);
  root.append(summary,conditions,sources);
  if(value.sequenceXpsnr){const v=value.sequenceXpsnr,p=document.createElement('p');p.className='quality-xpsnr-score';const db=(n:typeof v.planes.y)=>n.kind==='finite'?n.db.toFixed(4):'∞';p.textContent=`XPSNR Y ${db(v.planes.y)} U ${db(v.planes.u)} V ${db(v.planes.v)} dB · frame ${v.index+1}/${v.frames} · official pooled minimum ${db(v.pooled.minimum)} dB · reference first; temporal full-frame measurement, no localized defect or perceptual superiority claim`;root.append(p);}
  if(value.sequenceVmaf){const v=value.sequenceVmaf,p=document.createElement('p');p.className='quality-vmaf-score';p.textContent=`VMAF ${v.score.toFixed(6)} · ${v.recipe.model} · frame ${v.index+1}/${v.frames} · mean ${v.pooled.mean.toFixed(6)} · full-frame temporal score; no localized defect or heatmap; clip reset and final flush`;root.append(p);}

  if(value.result.provenance.reference.decode||value.result.provenance.distorted.decode){
    const notice=document.createElement('p');notice.className='quality-forward-guarantee';notice.textContent=forwardOutputText();root.append(notice);
  }
  const ssim=value.result.ssim;
  qualitySpatial(root,metric,undefined,undefined,ssim);root.append(details);
}
/** Facts already explicitly published with the annotation; never fetch a private job. */
export function showQualityEvidence(mark: Mark, annotation: AnnotationDocument, space?:string) {
  const root=dialog(mark.cambiEvidence?.length?'CAMBI':t(msg('quality.evidenceTitle', "PSNR 证据")));
  if(mark.qualityCandidate){const badge=document.createElement('p');badge.textContent=t(msg('qualityCandidate.badge','测量候选 · 创建时未作人工判断'));root.append(badge);}
  for(const evidence of mark.cambiEvidence??[]){const section=document.createElement('section'),label=document.createElement('p'),facts=document.createElement('pre');label.textContent=`CAMBI ${evidence.value.frame.score} · ${evidence.verification} · ${cambiEvidenceApplies(annotation,evidence)?t(msg('quality.applies', "匹配此标注的锚点和区域")):t(msg('quality.notApplies', "历史证据：当前锚点或区域已不同"))} · source PTS ${evidence.value.frame.target.sourcePtsUs} µs`;facts.textContent=JSON.stringify(evidence,null,2);section.append(label,facts);if(space&&space!=='local'&&evidence.verification==='server-verified'&&evidence.serviceOrigin===location.origin){const link=document.createElement('a');link.className='quality-pair-open';link.href=`/quality.html?cambi=1&space=${encodeURIComponent(space)}&annotationId=${mark.id}&evidenceId=${evidence.id}`;link.target='_blank';link.rel='noopener';link.textContent=t(msg('cambi.open','CAMBI · 查看原始热图、源快照与真实区域'));section.append(link);}root.append(section);}
  for(const evidence of mark.qualityEvidence ?? []) {
    const section=document.createElement('section'),label=document.createElement('p');
    label.textContent=`${evidence.verification==='server-verified'?t(msg('quality.verified', "关联时已由来源服务核验")):t(msg('quality.historical', "历史副本，本服务未核验"))} · ${evidenceApplies(annotation,evidence)?t(msg('quality.applies', "匹配此标注的锚点和区域")):t(msg('quality.notApplies', "历史证据：当前锚点或区域已不同"))} · ${evidence.attachedBy.name} · ${evidence.attachedAt}`;
    const ref=document.createElement('pre');ref.textContent=JSON.stringify({serviceOrigin:evidence.serviceOrigin,...evidence.ref,completedAt:evidence.completedAt},null,2);
    section.append(label);qualityFacts(section,evidence.value);section.append(ref);
    if(space&&space!=='local'&&evidence.verification==='server-verified'&&evidence.serviceOrigin===location.origin){
      const link=document.createElement('a');link.className='quality-pair-open';link.href=qualityPairViewUrl({space,annotationId:mark.id,evidenceId:evidence.id},location.origin);link.target='_blank';link.rel='noopener';link.textContent=t(msg('quality.openPair','在新窗口查看原帧对与 ROI'));section.append(link);
    }
    root.append(section);
  }
}
/** Capture scope/actor/revision before any asynchronous preview. A retry reuses
 * the same operation ID and reference, including after a lost HTTP response. */
export async function attachQualityDialog(target:Target, remember:(record:AnnotationRecord)=>Promise<void>) {
  const root=dialog(t(msg('quality.attachTitle', "关联已完成的 PSNR 结果")));
  const note=document.createElement('p');note.textContent=t(msg('quality.shareNotice', "此操作会向所有可查看该标注的人共享两侧片源身份、测量 ROI 和不可变结果事实。"));
  const label=document.createElement('label');label.textContent=t(msg('quality.jobId', "已完成任务 ID "));
  const input=document.createElement('input');input.name='jobId';input.maxLength=200;label.append(input);
  const side=document.createElement('select');side.name='side';side.setAttribute('aria-label',t(msg('quality.side', "标注对应的片源侧")));
  for(const value of ['reference','distorted']){const option=document.createElement('option');option.value=value;option.textContent=value;side.append(option);}
  const preview=document.createElement('button');preview.type='button';preview.textContent=t(msg('quality.preview', "预览结果"));
  const publish=document.createElement('button');publish.type='button';publish.textContent=t(msg('quality.publish', "共享到标注"));publish.disabled=true;
  const status=document.createElement('p');status.role='status';const body=document.createElement('div');
  const anchor=document.createElement('p');anchor.textContent=t(msg('quality.target', '目标 {space}/{id} · 修订 {revision} · 源 PTS {pts} µs'), {space:target.space,id:target.id,revision:target.revision,pts:target.document.mark.frame.sourcePtsUs});
  root.append(note,anchor,label,side,preview,publish,status,body);
  let command:Parameters<typeof attachAnnotationQuality>[0]|undefined,busy=false;
  const invalidate=()=>{if(busy)return;command=undefined;publish.disabled=true;body.replaceChildren();};input.oninput=invalidate;side.onchange=invalidate;
  preview.onclick=async()=>{
    if(busy)return;invalidate();busy=true;preview.disabled=true;input.disabled=true;side.disabled=true;status.textContent='';
    try {
      if(currentActor()?.id!==target.actor)throw new Error(t(msg('quality.actorChanged', "用户已切换，请重新打开关联操作。")));
      if(!/^[a-zA-Z0-9_-]{1,200}$/.test(input.value))throw new Error(t(msg('quality.enterJob', "请输入已完成的任务 ID。")));
      const response=await fetch(`/api/quality/jobs/${input.value}`,{headers:{'x-voidplayer-actor':target.actor},cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error(t(msg('quality.privateUnavailable', "当前用户无法访问此已完成任务。")));
      const job=await response.json() as QualityJob;
      if(job.state!=='completed'||!job.result.available||!job.attempt||!job.result.digest)throw new Error(t(msg('quality.completedRequired', "需要已完成的结果。")));
      const raw=await fetch(`/api/quality/jobs/${job.id}/result`,{headers:{'x-voidplayer-actor':target.actor},cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!raw.ok)throw new Error(t(msg('quality.unavailable', "结果不可用。")));
      const value=qualityEvidenceValue((await raw.json()).value);
      if(!root.isConnected)return;
      command={space:target.space,id:target.id,revision:target.revision,operationId:randomUUID(),evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:side.value as 'reference'|'distorted'}};
      qualityFacts(body,value);publish.disabled=false;
    } catch(error){status.textContent=(error as Error).message;}finally{busy=false;preview.disabled=false;input.disabled=false;side.disabled=false;}
  };
  publish.onclick=async()=>{
    if(busy||!command)return;busy=true;publish.disabled=true;preview.disabled=true;input.disabled=true;side.disabled=true;
    try {
      if(currentActor()?.id!==target.actor)throw new Error(t(msg('quality.actorChanged', "用户已切换，请重新打开关联操作。")));
      const record=await attachAnnotationQuality(command,{kind:'gui'},target.actor);
      await remember(record);if(root.isConnected)root.close();
    }catch(error){status.textContent=t(msg('quality.retry', '{error} 重试将复用操作 {operation}。'), {error:(error as Error).message,operation:command.operationId});}
    finally{busy=false;publish.disabled=false;preview.disabled=false;input.disabled=false;side.disabled=false;}
  };
}
