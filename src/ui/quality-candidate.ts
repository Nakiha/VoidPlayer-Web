import {t,msg} from '../i18n.ts';
import {currentActor} from '../services/identity.ts';
import {AnnotationClient} from '../review/annotation-client.ts';
import {createQualityCandidate,qualityCandidateOperation,type QualityCandidateCommand} from '../review/quality-evidence-client.ts';
import type {QualityJob} from '../../shared/analysis/quality/jobs.ts';
import {randomUUID} from '../../shared/utils/uuid.ts';
import {qualityPairViewUrl} from '../../shared/review/quality-pair-view.ts';
/** Same atomic command as HTTP Agent. Persist a frozen receipt request BEFORE
 * sending; uncertain retries do not depend on a fresh private-result lookup. */
export function installQualityCandidate(root:HTMLElement,job:QualityJob,actor:string,client:string,signal:AbortSignal){
  const title=document.createElement('h3');title.textContent=t(msg('qualityCandidate.title','从完成结果创建共享测量候选'));
  const notice=document.createElement('p');notice.textContent=t(msg('qualityCandidate.notice','候选只记录测量事实，尚未经人工缺陷判断。文本和严重度由你明确填写；创建后以共享标注查看原帧和 ROI。'));
  const form=document.createElement('form');form.className='quality-candidate-form';
  const field=(name:string,control:HTMLElement)=>{const label=document.createElement('label');label.append(document.createTextNode(name),control);form.append(label);};
  const space=document.createElement('select');space.dataset.candidateSpace='';field(t(msg('quality.space','标注空间')),space);
  const side=document.createElement('select');side.dataset.candidateSide='';side.add(new Option('reference','reference'));side.add(new Option('distorted','distorted'));field(t(msg('qualityCandidate.side','主锚点侧')),side);
  const text=document.createElement('input');text.required=true;text.maxLength=2000;text.dataset.candidateText='';field(t(msg('qualityCandidate.text','候选说明')),text);
  const severity=document.createElement('input');severity.type='number';severity.min='1';severity.max='5';severity.step='1';severity.value='1';severity.required=true;severity.dataset.candidateSeverity='';field(t(msg('qualityCandidate.severity','严重度（调用者填写，1–5）')),severity);
  const submit=document.createElement('button');submit.type='submit';submit.dataset.candidateCreate='';submit.textContent=t(msg('qualityCandidate.create','原子创建候选及证据'));submit.disabled=true;
  const status=document.createElement('p');status.role='status';status.dataset.candidateStatus='';const links=document.createElement('div');form.append(submit);root.append(title,notice,form,status,links);
  let pending:QualityCandidateCommand|undefined,busy=false,blockedDraft=false,draftSpace:string|undefined;
  const key=`voidplayer-quality-candidate:${actor}:${client}:${job.id}`;
  const valid=()=>root.isConnected&&!signal.aborted&&currentActor()?.id===actor;
  const freeze=()=>{for(const control of [space,side,text,severity])control.disabled=!!pending;};
  try{
    const raw=sessionStorage.getItem(key);
    if(raw){
      const value=JSON.parse(raw) as QualityCandidateCommand;
      draftSpace=typeof value?.space==='string'?value.space:undefined;
      text.value=typeof value?.candidate?.text==='string'?value.candidate.text:'';
      severity.value=typeof value?.candidate?.severity==='number'?String(value.candidate.severity):'';
      side.value=value?.evidence?.side==='distorted'?'distorted':'reference';
      try{
        qualityCandidateOperation(value,{kind:'gui',id:client});
        if(value.evidence.jobId!==job.id||value.evidence.attemptId!==job.attempt?.id){blockedDraft=true;throw new Error('Saved request belongs to a different result.');}
        // A valid saved command may have reached the server. Never turn it
        // into a new editable request just because its response was lost.
        pending=structuredClone(value);freeze();
        status.textContent=t(msg('qualityCandidate.pending','原提交结果未确认；表单已冻结，重试只使用已保存的同一操作。'));
      }catch(error){
        if(blockedDraft)throw error;
        // The old client ran this SAME complete validator before fetch. A
        // semantically invalid legacy command could not have been sent.
        // Keep its stored contents until an explicit corrected submission,
        // but restore editable fields instead of freezing an invalid receipt.
        status.textContent=t(msg('qualityCandidate.recovered','旧草稿未通过本地校验、未发送，已恢复为可编辑内容。修正后将创建新操作；有效的未知提交不会这样解锁。'));
      }
    }
  }catch(error){blockedDraft=true;status.textContent=String(error);}
  void new AnnotationClient(signal).request<{id:string;name:string}[]>('/api/annotations/spaces','GET',undefined,actor).then(spaces=>{if(!valid())return;for(const s of spaces)space.add(new Option(s.name,s.id));if(draftSpace!==undefined)space.value=draftSpace;submit.disabled=!space.value||blockedDraft;}).catch(error=>{if(valid())status.textContent=String(error);});
  form.onsubmit=event=>{event.preventDefault();if(busy||blockedDraft||!valid())return;
    void(async()=>{busy=true;submit.disabled=true;try{
      if(!pending){if(job.state!=='completed'||!job.attempt||!job.result.digest||!text.value.trim())throw new Error('A completed result and explicit candidate text are required');
        const command:QualityCandidateCommand={space:space.value,id:randomUUID(),operationId:randomUUID(),evidence:{jobId:job.id,attemptId:job.attempt.id,digest:job.result.digest,side:side.value as 'reference'|'distorted'},candidate:{text:text.value.trim(),severity:severity.valueAsNumber}};
        qualityCandidateOperation(command,{kind:'gui',id:client});
        sessionStorage.setItem(key,JSON.stringify(command));pending=command;freeze();}
      const command=structuredClone(pending),record=await createQualityCandidate(command,{kind:'gui',id:client},actor);
      if(!valid())return;sessionStorage.removeItem(key);status.textContent=t(msg('qualityCandidate.created','已创建共享测量候选；未自动认定为缺陷。'));form.hidden=true;
      const activity=document.createElement('a');activity.href=`/?annotation=${encodeURIComponent(record.id)}&space=${encodeURIComponent(record.space)}`;activity.target='_blank';activity.rel='noopener';activity.textContent=t(msg('qualityCandidate.open','在新窗口打开候选标注'));links.append(activity);
      for(const evidence of record.document.mark.qualityEvidence??[]){const link=document.createElement('a');link.className='quality-pair-open';link.href=qualityPairViewUrl({space:record.space,annotationId:record.id,evidenceId:evidence.id},location.origin);link.target='_blank';link.rel='noopener';link.textContent=t(msg('quality.openPair','在新窗口查看原帧对与 ROI'));links.append(link);}
    }catch(error){if(valid())status.textContent=pending?`${error instanceof Error?error.message:String(error)} · ${pending.operationId}`:t(msg('qualityCandidate.notSent','本地校验未通过或草稿未能保存，未发送请求；请修改后提交：{error}'),{error:error instanceof Error?error.message:String(error)});}finally{busy=false;if(valid())submit.disabled=false;}})();
  };
}
