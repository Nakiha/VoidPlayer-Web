/** Bounded H.264 SPS/VUI parsing for geometry and native reorder capability. */
import type { HevcGeometry } from './hevc-geometry.ts';
export interface AvcGeometry extends HevcGeometry { interlaced: boolean; maxReorderFrames: number | null; }
class Bits {
  p=0;
  readonly b:Uint8Array;
  constructor(b:Uint8Array){this.b=b;}
  read(n:number):number {if(n<0||n>32||this.p+n>this.b.length*8)throw new Error('truncated AVC SPS');let v=0;while(n--){v=v*2+((this.b[this.p>>3]>>(7-(this.p&7)))&1);this.p++;}return v;}
  skip(n:number){while(n>0){const k=Math.min(n,32);this.read(k);n-=k;}}
  ue(max=0x7fffffff){let n=0;while(!this.read(1))if(++n>30)throw new Error('invalid AVC Exp-Golomb');const v=2**n-1+this.read(n);if(v>max)throw new Error('AVC SPS bound');return v;}
  se(){const n=this.ue();return n&1?(n+1)/2:-n/2;}
}
const ratios=[[1,1],[1,1],[12,11],[10,11],[16,11],[40,33],[24,11],[20,11],[32,11],[80,33],[18,11],[15,11],[64,33],[160,99],[4,3],[3,2],[2,1]];
export function parseAvcSps(nal:Uint8Array):AvcGeometry {
  if((nal[0]&31)!==7)throw new Error('not AVC SPS');
  const rbsp=[];for(let i=1;i<nal.length;i++){if(nal[i]===3&&i>=3&&nal[i-1]===0&&nal[i-2]===0)continue;rbsp.push(nal[i]);}
  const b=new Bits(Uint8Array.from(rbsp));const profile=b.read(8);b.skip(16);b.ue(31);
  let chroma=1,separate=0;
  if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){
    chroma=b.ue(3);if(chroma===3)separate=b.read(1);b.ue(6);b.ue(6);b.skip(1);
    if(b.read(1))for(let i=0;i<(chroma===3?12:8);i++)if(b.read(1)){let last=8,next=8;for(let j=0;j<(i<6?16:64);j++){if(next)next=(last+b.se()+256)%256;last=next||last;}}
  }
  b.ue(12);const poc=b.ue(2);if(poc===0)b.ue(12);else if(poc===1){b.skip(1);b.se();b.se();for(let i=b.ue(255);i>0;i--)b.se();}
  b.ue(16);b.skip(1);const codedWidth=(b.ue(2047)+1)*16,mbHeight=b.ue(2047)+1;
  const frameOnly=b.read(1);if(!frameOnly)b.skip(1);b.skip(1);
  const codedHeight=mbHeight*16*(2-frameOnly),array=separate?0:chroma;
  const subX=array===1||array===2?2:1,subY=(array===1?2:1)*(2-frameOnly);
  let x=0,y=0,right=0,bottom=0;
  if(b.read(1)){x=b.ue(32768)*subX;right=b.ue(32768)*subX;y=b.ue(32768)*subY;bottom=b.ue(32768)*subY;}
  const width=codedWidth-x-right,height=codedHeight-y-bottom;if(width<=0||height<=0)throw new Error('invalid AVC crop');
  let sarNum=1,sarDen=1,maxReorderFrames:number|null=null;
  if(b.read(1)){
    if(b.read(1)){const id=b.read(8);if(id===255){sarNum=b.read(16);sarDen=b.read(16);}else if(ratios[id])[sarNum,sarDen]=ratios[id];else throw new Error('invalid AVC SAR');}
    if(b.read(1))b.skip(1);if(b.read(1)){b.skip(4);if(b.read(1))b.skip(24);}if(b.read(1)){b.ue();b.ue();}
    if(b.read(1))b.skip(65);
    const hrd=()=>{const count=b.ue(31);b.skip(8);for(let i=0;i<=count;i++){b.ue();b.ue();b.skip(1);}b.skip(20);};
    const nalHrd=b.read(1);if(nalHrd)hrd();const vclHrd=b.read(1);if(vclHrd)hrd();if(nalHrd||vclHrd)b.skip(1);b.skip(1);
    if(b.read(1)){b.skip(1);b.ue();b.ue();b.ue();b.ue();maxReorderFrames=b.ue(16);b.ue(16);}
  }
  if(!sarNum||!sarDen)throw new Error('invalid AVC SAR');
  return {codedWidth,codedHeight,x,y,width,height,sarNum,sarDen,interlaced:!frameOnly,maxReorderFrames};
}
export function avcGeometry(description:Uint8Array):AvcGeometry|null {
  try{
    if(description.length<7||description[0]!==1)return null;
    let offset=6;const values:AvcGeometry[]=[];
    for(let i=0;i<(description[5]&31);i++){
      if(offset+2>description.length)return null;const len=description[offset]*256+description[offset+1];offset+=2;
      if(offset+len>description.length)return null;values.push(parseAvcSps(description.subarray(offset,offset+len)));offset+=len;
    }
    return values.length&&values.every(v=>JSON.stringify(v)===JSON.stringify(values[0]))?values[0]:null;
  }catch{return null;}
}
/** Interlaced or unspecified reorder bounds need the conservative software DPB.
 * WebCodecs capability probes alone do not promise complete/correct output here. */
export const nativeAvcCompatible=(g:AvcGeometry|null)=>!!g&&!g.interlaced&&g.maxReorderFrames!==null;

/** AVC samples may repeat/change parameter sets in-band without a new FLV
 * sequence header. Select those sets before handing a key picture to WebCodecs. */
export function avcInBandDescription(bytes:Uint8Array,current:Uint8Array):Uint8Array|null {
  if(current.length<7)return null;
  const lengthBytes=(current[4]&3)+1;let offset=0;
  const sps:Uint8Array[]=[],pps:Uint8Array[]=[];
  while(offset<bytes.length){
    if(offset+lengthBytes>bytes.length)throw new Error('truncated AVC NAL length');
    let size=0;for(let i=0;i<lengthBytes;i++)size=size*256+bytes[offset++];
    if(size<=0||offset+size>bytes.length)throw new Error('AVC NAL exceeds packet');
    const nal=bytes.subarray(offset,offset+size);offset+=size;
    if((nal[0]&31)===7)sps.push(nal);else if((nal[0]&31)===8)pps.push(nal);
  }
  if(!sps.length)return null;
  if(!pps.length)return null; // A lone SPS requires PPS-id tracking, do not guess.
  if(sps.length>31||pps.length>255||[...sps,...pps].some(n=>n.length>65535))throw new Error('AVC parameter set bound');
  const result=new Uint8Array(7+sps.reduce((n,b)=>n+2+b.length,0)+pps.reduce((n,b)=>n+2+b.length,0));
  result.set([1,sps[0][1],sps[0][2],sps[0][3],current[4],0xe0|sps.length]);let at=6;
  const put=(nal:Uint8Array)=>{result[at++]=nal.length>>8;result[at++]=nal.length&255;result.set(nal,at);at+=nal.length;};
  sps.forEach(put);result[at++]=pps.length;pps.forEach(put);
  return result.length===current.length&&result.every((b,i)=>b===current[i])?null:result;
}
