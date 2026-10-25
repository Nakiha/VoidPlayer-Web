import { QualityPairViewSession } from '../session.ts';
import { paintFrame,setPresentationGeometry,disposePresentation } from '../presentation/presenter.ts';
import { presentationRect } from '../presentation/presentation-surface.ts';
import type { PresentationGeometry } from '../presentation/presentation-surface.ts';
import { PAIR_VIEW_SIDES,pairViewReference,verifyPairViewPresentation } from '../../shared/review/quality-pair-view.ts';
import type { PairViewSide } from '../../shared/review/quality-pair-view.ts';
import { t,msg,initializeLanguage,onLanguageChange } from '../i18n.ts';
import './quality-pair-view.css';
import { qualitySpatial } from './quality-spatial.ts';

const disposeLanguage=await initializeLanguage();
const root=document.querySelector<HTMLElement>('#pair-view')!;
const title=document.createElement('h1');title.textContent=t(msg('quality.pairTitle','原测量帧对与 ROI'));
const note=document.createElement('p');note.textContent=t(msg('quality.pairDisplay','仅查看原缓存绑定的两张独立快照，不重新评分。显示色彩由呈现链路转换；PSNR 来自源 YUV 码值，不是屏幕像素。'));
const limits=document.createElement('p');limits.textContent=t(msg('quality.pairLimits','支持无裁剪、方形像素、无旋转的 FLV 闭合关键帧。缓存、版本、解码器或几何不匹配时不展示。'));
const cancel=document.createElement('button');cancel.textContent=t(msg('quality.pairCancel','取消并释放快照'));cancel.type='button';
const status=document.createElement('p');status.role='status';status.id='pair-status';
const blocks=document.createElement('div');blocks.id='pair-blocks';
const blockControl=document.createElement('label');blockControl.hidden=true;const blockLabel=document.createElement('span');blockLabel.textContent=t(msg('quality.spatialPicker','在原帧上查看分块'));
const blockSelect=document.createElement('select');blockSelect.id='pair-block-selection';blockControl.append(blockLabel,blockSelect);
const views=document.createElement('div');views.className='quality-pair-views';views.style.visibility='hidden';
const stages={} as Record<PairViewSide,HTMLElement>,canvases={} as Record<PairViewSide,HTMLCanvasElement>,svgs={} as Record<PairViewSide,SVGSVGElement>,captions={} as Record<PairViewSide,HTMLElement>;
const geometry={} as Record<PairViewSide,PresentationGeometry>;
for(const side of PAIR_VIEW_SIDES) {
  const section=document.createElement('section'),heading=document.createElement('h2');heading.textContent=side;
  const stage=stages[side]=document.createElement('div');stage.className='frame-stage';stage.dataset.side=side;
  const canvas=canvases[side]=document.createElement('canvas');canvas.id=`pair-${side}`;canvas.setAttribute('aria-label',side);
  const svg=svgs[side]=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('quality-pair-roi');svg.setAttribute('aria-label','ROI');
  const caption=captions[side]=document.createElement('p');caption.className='quality-pair-caption';
  stage.append(canvas,svg);section.append(heading,stage,caption);views.append(section);
}
root.append(title,note,limits,cancel,status,blockControl,views,blocks);
const session=new QualityPairViewSession((side,frame)=>{
  const stage=stages[side],width=stage.clientWidth,height=stage.clientHeight,d=frame.description,scale=Math.min(width/d.width,height/d.height);
  const g=geometry[side]={width,height,imageWidth:d.width,imageHeight:d.height,zoom:scale,offsetX:0,offsetY:0,dpr:devicePixelRatio};
  setPresentationGeometry(canvases[side],g);paintFrame(canvases[side],frame);
},location.href);
function render() {
  const state=session.getState();root.dataset.state=state.state;views.style.visibility=state.state==='ready'?'visible':'hidden';
  status.textContent=state.state==='ready'?t(msg('quality.pairReady','两侧快照已按源、缓存、AU、实际 PTS 和几何核对；ROI 为只读覆盖层。')):state.error??state.state;
  blocks.replaceChildren();if(state.state==='ready'&&state.evidence)qualitySpatial(blocks,state.evidence.value.result.metric,index=>session.selectBlock(index),state.selectedBlock);
  const grid=state.state==='ready'?state.evidence?.value.result.metric.spatial:undefined;
  blockControl.hidden=!grid;blockSelect.replaceChildren();
  if(grid){blockSelect.append(new Option(t(msg('quality.spatialFullRoi','仅显示完整测量 ROI')),''));for(const block of grid.blocks){const score=block.aggregate.psnr;blockSelect.append(new Option(`#${block.index} · ROI ${JSON.stringify(block.roi)} · ${score.kind==='positive-infinity'?'∞':score.db.toFixed(4)} dB`,String(block.index)));}blockSelect.value=state.selectedBlock===undefined?'':String(state.selectedBlock);}
  for(const side of PAIR_VIEW_SIDES) {
    const svg=svgs[side];svg.replaceChildren();
    if(state.state!=='ready'||!state.evidence||!state.presented) {setPresentationGeometry(canvases[side],null);continue;}
    verifyPairViewPresentation(state.evidence,side,state.presented[side]);
    const g=geometry[side],r=presentationRect(g),roi=state.evidence.value.result.metric.roi;
    svg.setAttribute('viewBox',`0 0 ${g.width} ${g.height}`);
    const rect=document.createElementNS(svg.namespaceURI,'rect');
    for(const [key,value] of Object.entries({x:r.x+roi.x*g.zoom,y:r.y+roi.y*g.zoom,width:roi.width*g.zoom,height:roi.height*g.zoom}))rect.setAttribute(key,String(value));
    rect.setAttribute('vector-effect','non-scaling-stroke');svg.append(rect);
    if(state.selectedBlock!==undefined){const block=state.evidence.value.result.metric.spatial!.blocks[state.selectedBlock];const outline=document.createElementNS(svg.namespaceURI,'rect');outline.classList.add('quality-selected-block');outline.setAttribute('data-block-index',String(block.index));
      for(const [key,value]of Object.entries({x:r.x+block.roi.x*g.zoom,y:r.y+block.roi.y*g.zoom,width:block.roi.width*g.zoom,height:block.roi.height*g.zoom}))outline.setAttribute(key,String(value));outline.setAttribute('vector-effect','non-scaling-stroke');svg.append(outline);}
    const p=state.presented[side];captions[side].textContent=`${p.sourceBinding.mediaId}@${p.sourceBinding.mediaVersion} · source PTS ${p.sourcePtsUs} µs · AU ${p.picture?.au}`;
  }
}
session.subscribe(render);cancel.onclick=()=>session.cancel();blockSelect.onchange=()=>session.selectBlock(blockSelect.value===''?null:Number(blockSelect.value));
const removeLanguage=onLanguageChange(()=>{title.textContent=t(msg('quality.pairTitle','原测量帧对与 ROI'));note.textContent=t(msg('quality.pairDisplay','仅查看原缓存绑定的两张独立快照，不重新评分。显示色彩由呈现链路转换；PSNR 来自源 YUV 码值，不是屏幕像素。'));limits.textContent=t(msg('quality.pairLimits','支持无裁剪、方形像素、无旋转的 FLV 闭合关键帧。缓存、版本、解码器或几何不匹配时不展示。'));cancel.textContent=t(msg('quality.pairCancel','取消并释放快照'));blockLabel.textContent=t(msg('quality.spatialPicker','在原帧上查看分块'));render();});
const observer=new ResizeObserver(()=>{if(session.getState().state==='ready'){try{session.redraw();render();}catch(error){session.cancel();status.textContent=(error as Error).message;}}});
for(const stage of Object.values(stages))observer.observe(stage);
const api=Object.freeze({getState:()=>session.getState(),open:(reference:Parameters<typeof session.open>[0])=>session.open(reference),selectBlock:(index:number|null)=>session.selectBlock(index),cancel:()=>session.cancel(),close:()=>session.close(),resources:()=>session.resources.snapshot()});
Object.defineProperty(window,'voidPlayerQualityPair',{value:api,configurable:true});
window.addEventListener('pagehide',()=>{observer.disconnect();removeLanguage();disposeLanguage();void session.close().finally(disposePresentation);},{once:true});
try {const query=new URL(location.href).searchParams;const reference=pairViewReference({space:query.get('space')!,annotationId:query.get('annotationId')!,evidenceId:query.get('evidenceId')!});void session.open(reference).catch(()=>{});}catch(error){status.textContent=(error as Error).message;root.dataset.state='failed';}
