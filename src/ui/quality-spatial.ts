import './quality-spatial.css';
import type { PsnrResult } from '../../shared/analysis/quality/psnr.ts';
import { validatePsnrSpatial } from '../../shared/analysis/quality/psnr-spatial.ts';
import { t,msg } from '../i18n.ts';

/** The same immutable block facts appear in task results, shared evidence and
 * original-pair inspection. Color/display pixels never enter these numbers. */
export function qualitySpatial(root:HTMLElement,metric:PsnrResult,select?:(index:number|null)=>void,selected?:number) {
  validatePsnrSpatial(metric);const grid=metric.spatial;if(!grid)return;
  const section=document.createElement('section');section.className='quality-spatial';
  const title=document.createElement('h3');title.textContent=t(msg('quality.spatialTitle','源像素分块 PSNR'));
  const note=document.createElement('p');note.textContent=t(msg('quality.spatialNote','{count} 块，名义块 {width}×{height} 源像素；边缘按实际范围截断。按每样本 MSE 从高到低列出最差块，不是主观缺陷或置信度。'),{count:grid.blocks.length,width:grid.blockWidth,height:grid.blockHeight});
  section.append(title,note);
  if(select){const all=document.createElement('button');all.type='button';all.dataset.psnrBlock='all';all.textContent=t(msg('quality.spatialFullRoi','仅显示完整测量 ROI'));all.setAttribute('aria-pressed',String(selected===undefined));all.onclick=()=>{select(null);root.querySelector<HTMLButtonElement>('[data-psnr-block="all"]')?.focus();};section.append(all);}
  function table(indices:number[]) {
    const table=document.createElement('table');table.className='quality-spatial-table';
    const head=table.createTHead().insertRow();for(const label of ['#','ROI (x, y, width, height)','SSE','samples','MSE','PSNR (dB)']){const th=document.createElement('th');th.scope='col';th.textContent=label;head.append(th);}
    const body=table.createTBody();
    for(const index of indices){const block=grid!.blocks[index],r=block.roi,score=block.aggregate.psnr,row=body.insertRow();row.dataset.blockIndex=String(index);
      const first=row.insertCell();if(select){const button=document.createElement('button');button.type='button';button.dataset.psnrBlock=String(index);button.textContent=String(index);button.setAttribute('aria-pressed',String(index===selected));button.setAttribute('aria-label',t(msg('quality.spatialSelect','在两侧原帧查看块 {index}'),{index}));button.onclick=()=>{select(index);root.querySelector<HTMLButtonElement>(`[data-psnr-block="${index}"]`)?.focus();};first.append(button);}else first.textContent=String(index);
      for(const value of [`${r.x}, ${r.y}, ${r.width}, ${r.height}`,block.aggregate.sse,block.aggregate.samples,block.aggregate.mse.toFixed(6),score.kind==='positive-infinity'?'∞':score.db.toFixed(4)])row.insertCell().textContent=String(value);
    }return table;
  }
  const worst=document.createElement('h4');worst.textContent=t(msg('quality.spatialWorst','最差区域（分数越低、误差越大）'));section.append(worst,table(grid.worst));
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=t(msg('quality.spatialAll','完整有界分块事实（行优先）'));details.append(summary,table(grid.blocks.map(b=>b.index)));section.append(details);root.append(section);
}
