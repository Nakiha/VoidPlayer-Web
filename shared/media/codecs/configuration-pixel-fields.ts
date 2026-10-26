import {isAnnexB,nalRanges} from './nal-framing.ts';
import type {DiscoveryField} from '../discovery.ts';
const unknownProbeField=(reason:string):DiscoveryField=>({value:null,status:'unknown',source:'unavailable',reason});
const known=(value:string|number,source:DiscoveryField['source']):DiscoveryField=>({value,status:'known',source});
/** Only nominal encoded configuration, never a decoder's output pixel layout. */
export function configurationPixelFields(codec:string,description:Uint8Array):{bitDepth:DiscoveryField;pixelFormat:DiscoveryField}{
  const absent={bitDepth:unknownProbeField('configuration-pixel-format-unavailable'),pixelFormat:unknownProbeField('configuration-pixel-format-unavailable')};
  let depth:number,chroma:number;
  try{
    if(isAnnexB(description)){
      const nals=nalRanges(codec,description,description).filter(n=>codec==='h264'?(description[n.offset]&31)===7:codec==='hevc'&&(description[n.offset]>>1&63)===33);
      if(!nals.length||nals.length>31||nals.some(n=>n.size>4096))return absent;
      if(codec==='h264'){
        const avcc=new Uint8Array(7+nals.reduce((sum,n)=>sum+2+n.size,0));avcc.set([1,description[nals[0].offset+1],0,0,255,0xe0|nals.length]);let at=6;
        for(const n of nals){avcc[at++]=n.size>>8;avcc[at++]=n.size&255;avcc.set(description.subarray(n.offset,n.offset+n.size),at);at+=n.size;}return configurationPixelFields(codec,avcc);
      }
      const formats=nals.map(n=>{const nal=description.subarray(n.offset,n.offset+n.size),rbsp:number[]=[];for(let i=2;i<nal.length;i++){if(nal[i]===3&&i>=4&&nal[i-1]===0&&nal[i-2]===0)continue;rbsp.push(nal[i]);}
        let bit=0;const read=(count:number)=>{if(count>32||bit+count>rbsp.length*8)throw Error();let value=0;while(count--){value=value*2+((rbsp[bit>>3]>>(7-(bit&7)))&1);bit++;}return value;};
        const skip=(count:number)=>{while(count){const n=Math.min(count,32);read(n);count-=n;}};
        const ue=(max:number)=>{let zeros=0;while(!read(1))if(++zeros>16)throw Error();const value=2**zeros-1+read(zeros);if(value>max)throw Error();return value;};
        skip(4);const layers=read(3);if(layers>6)throw Error();skip(1+96);const profiles:number[]=[],levels:number[]=[];for(let i=0;i<layers;i++){profiles.push(read(1));levels.push(read(1));}
        if(layers)skip((8-layers)*2);for(let i=0;i<layers;i++){if(profiles[i])skip(88);if(levels[i])skip(8);}ue(15);const c=ue(3);if(c===3)read(1);ue(32768);ue(32768);if(read(1))for(let i=0;i<4;i++)ue(32768);const d=8+ue(8);if(8+ue(8)!==d)throw Error();return `${c}:${d}`;
      });
      if(new Set(formats).size!==1)return absent;[chroma,depth]=formats[0].split(':').map(Number);
      const sampling=['400','420','422','444'][chroma];if(!sampling||depth>16)return absent;
      return {bitDepth:known(depth,'codec-configuration'),pixelFormat:known(`yuv${sampling}p${depth===8?'':depth}`,'codec-configuration')};
    }
    if(codec==='hevc'&&description.length>=23&&description[0]===1){depth=8+(description[17]&7);chroma=description[16]&3;if(depth!==8+(description[18]&7))return absent;}
    else if(codec==='h264'&&description.length>=7&&description[0]===1){
      let at=6;const values:string[]=[];
      for(let i=0;i<(description[5]&31);i++){
        if(at+2>description.length)return absent;const length=description[at]*256+description[at+1];at+=2;
        if(length<4||length>4096||at+length>description.length)return absent;
        const nal=description.subarray(at,at+length);at+=length;if((nal[0]&31)!==7)return absent;
        const rbsp:number[]=[];for(let n=1;n<nal.length;n++){if(nal[n]===3&&n>=3&&nal[n-1]===0&&nal[n-2]===0)continue;rbsp.push(nal[n]);}
        let bit=0;const read=(count:number)=>{if(bit+count>rbsp.length*8)throw Error();let v=0;while(count--){v=v*2+((rbsp[bit>>3]>>(7-(bit&7)))&1);bit++;}return v;};
        const ue=(max:number)=>{let zeros=0;while(!read(1))if(++zeros>16)throw Error();const value=2**zeros-1+read(zeros);if(value>max)throw Error();return value;};
        const profile=read(8);read(16);ue(31);let c=1,d=8;
        if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)){c=ue(3);if(c===3)read(1);d=8+ue(6);if(8+ue(6)!==d)return absent;}
        else if(![66,77,88].includes(profile))return absent;
        values.push(`${c}:${d}`);
      }
      if(!values.length||new Set(values).size!==1)return absent;[chroma,depth]=values[0].split(':').map(Number);
    }else return absent;
    const sampling=['400','420','422','444'][chroma];if(!sampling||depth<8||depth>16)return absent;
    return {bitDepth:known(depth,'codec-configuration'),pixelFormat:known(`yuv${sampling}p${depth===8?'':depth}`,'codec-configuration')};
  }catch{return absent;}
}
