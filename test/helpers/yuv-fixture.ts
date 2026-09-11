import { rgbaDescription } from '../../src/frame-description.ts';
import type { FrameDescription } from '../../src/frame-description.ts';
export function yuvFixture(depth=8, semi=false, full=false, matrix='bt709', width=5, height=3, shift=0) {
  const bytes=depth>8?2:1, cw=Math.ceil(width/2), ch=Math.ceil(height/2);
  let length=0;
  const planes=Array.from({length:semi?2:3},(_,i)=>{
    const w=i?cw:width,h=i?ch:height,stride=w*bytes*(i&&semi?2:1)+4;
    const p={offset:length,stride,width:w,height:h};length+=stride*h;return p;
  });
  const description:FrameDescription=rgbaDescription(width,height,{format:semi?'NV12':'YUV',stride:null,byteLength:length,
    color:{matrix,fullRange:full,primaries:matrix==='bt2020-ncl'?'bt2020':'bt709',transfer:'bt709'},
    yuv:{bitDepth:depth,bitShift:shift,subsampleX:1,subsampleY:1,semiplanar:semi,chromaLocation:null,planes}});
  const pixels=new Uint8ClampedArray(length);pixels.fill(213);
  const write=(c:number,x:number,y:number,code:number)=>{
    const p=planes[semi&&c?1:c];
    const at=p.offset+y*p.stride+x*bytes*(semi&&c?2:1)+(semi&&c===2?bytes:0);
    const value=code*2**shift;pixels[at]=value%256;if(bytes===2)pixels[at+1]=Math.floor(value/256);
  };
  const scale=2**(depth-8), max=2**depth-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)write(0,x,y,full?Math.round(x/(width-1)*max):Math.round((16+219*x/(width-1))*scale));
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++){write(1,x,y,(x===0?128:80)*scale);write(2,x,y,(y===0?128:190)*scale);}
  return {description,pixels,write};
}
