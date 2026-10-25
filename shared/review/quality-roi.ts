import type { PsnrRoi } from '../analysis/quality/psnr.ts';
/** Separate source-grid tool: normalized pointer coordinates come only from its
 * own unrotated snapshot rectangle, never the playback viewport or pen bounds. */
export function qualityRoi(width:number,height:number,input:PsnrRoi):PsnrRoi{
  if(![width,height,...Object.values(input)].every(Number.isSafeInteger)||width<2||height<2
    ||[width,height,input.x,input.y,input.width,input.height].some(n=>n%2)||input.x<0||input.y<0||input.width<2||input.height<2
    ||input.x+input.width>width||input.y+input.height>height)throw new Error('ROI must use even integer coordinates inside both visible source grids');
  return {...input};
}
export function draggedQualityRoi(width:number,height:number,a:{x:number;y:number},b:{x:number;y:number}):PsnrRoi{
  if(![a.x,a.y,b.x,b.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new Error('ROI pointer lies outside the snapshot');
  const x=Math.round(Math.min(a.x,b.x)*width/2)*2,y=Math.round(Math.min(a.y,b.y)*height/2)*2;
  const right=Math.round(Math.max(a.x,b.x)*width/2)*2,bottom=Math.round(Math.max(a.y,b.y)*height/2)*2;
  return qualityRoi(width,height,{x,y,width:right-x,height:bottom-y});
}
