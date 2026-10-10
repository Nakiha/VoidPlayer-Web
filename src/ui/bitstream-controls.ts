import { SLOTS } from '../model.ts';
import type { Slot } from '../model.ts';
import type { ReviewSession } from '../session.ts';
import { t,msg } from '../i18n.ts';
export function installBitstreamControls(session:ReviewSession,canvases:Record<Slot,HTMLCanvasElement>){
 const active=new Map<Slot,{controller:AbortController;overlay?:import('../analysis-overlay/controller.ts').ReturnOverlay}>();
 for(const slot of SLOTS){
  const button=document.getElementById(`bitstream-${slot}`) as HTMLButtonElement;
  const mode=document.getElementById(`bitstream-mode-${slot}`) as HTMLSelectElement;
  const status=document.getElementById(`bitstream-status-${slot}`)!;
  const off=()=>{const entry=active.get(slot);entry?.controller.abort();entry?.overlay?.dispose();active.delete(slot);button.setAttribute('aria-pressed','false');mode.hidden=true;status.hidden=true;session.cancelBitstreamAnalysis();};
  button.onclick=async()=>{
   if(active.has(slot)){off();return;}
   const entry:{controller:AbortController;overlay?:import('../analysis-overlay/controller.ts').ReturnOverlay}={controller:new AbortController()};active.set(slot,entry);button.setAttribute('aria-pressed','true');status.hidden=false;status.textContent=t(msg('bitstream.pending','正在分析当前帧…'));
   try{const {createAnalysisOverlay}=await import('../analysis-overlay/controller.ts');if(entry.controller.signal.aborted)return;entry.overlay=createAnalysisOverlay(session,slot,canvases[slot]);const requested=session.getPresentedFrame(slot);const result=await session.requestBitstreamAnalysis(slot,entry.controller.signal);if(entry.controller.signal.aborted||session.getPresentedFrame(slot)?.commit!==requested?.commit)return;entry.overlay.setResult(result);mode.hidden=false;status.textContent=result.confidence==='exact'?`${result.picture.stream} / AU ${result.picture.au} · ${result.blocks.length} ${t(msg('bitstream.blocks','块'))}${result.qp.mean===null?'':` · QP ${result.qp.mean.toFixed(1)}`}`:result.reasons.join('; ');mode.querySelector<HTMLOptionElement>('[value="qp"]')!.disabled=result.capabilities.qp!=='ready';}
   catch(error){if(!entry.controller.signal.aborted)status.textContent=error instanceof Error?error.message:String(error);}
  };
  session.subscribePresentedFrames((changed)=>{if(changed===slot&&active.has(slot)){status.textContent='';status.title='';}});
  mode.onchange=()=>active.get(slot)?.overlay?.setMode(mode.value as 'blocks'|'qp'|'modes');
  canvases[slot].closest('.frame-stage')!.addEventListener('pointermove',event=>{const e=event as PointerEvent,rect=(event.currentTarget as HTMLElement).getBoundingClientRect(),b=active.get(slot)?.overlay?.hit(e.clientX-rect.left,e.clientY-rect.top);status.title=b?`${b.x},${b.y} · ${b.width}×${b.height} · ${b.mode} · QP ${b.qp??'—'}`:'';});
  session.subscribe(()=>{const state=session.getState();const track=state.tracks.find(track=>track.slot===slot);button.disabled=!track||!!track.failure||state.playing&&!active.has(slot);if(!track&&active.has(slot))off();});
 }
}
