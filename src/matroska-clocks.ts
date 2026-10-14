import type {TsPacketReader} from './ts-packet-source.ts';
import {MediaOpenError} from './media-errors.ts';
import {TsCombinationNotMigrated} from './ts-packet-source.ts';

/** Clock/structure supplement for pinned Mediabunny, not a payload demuxer.
 * Block payload stays with EncodedPacketSink. Its locator is cluster data start
 * plus the selected track's block ordinal, never the block's byte offset. */
export interface PacketCodecParameters {
  width:number;height:number;sarNum:number;sarDen:number;
  colorPrimaries:number;colorTransfer:number;colorSpace:number;colorRange:number;
}
export interface MatroskaTrackConfiguration { codecId:string;description:Uint8Array;parameters:PacketCodecParameters; }
/** Narrow legacy FFV1 mapping; other VFW codecs stay outside admission. */
export function matroskaFfv1Configuration(configuration:MatroskaTrackConfiguration){
  if(configuration.codecId==='V_FFV1')return configuration.description;
  if(configuration.codecId!=='V_MS/VFW/FOURCC')return;
  const bytes=configuration.description;
  if(bytes.length<40)throw new MediaOpenError('container','Truncated Matroska BITMAPINFOHEADER');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),size=view.getUint32(0,true);
  if(String.fromCharCode(...bytes.subarray(16,20))!=='FFV1')return;
  // FFmpeg writes biSize=40+extradata, with an optional final even-byte pad.
  // A bare 40-byte header is also valid; extradata always begins at offset 40.
  if(size<40||size>bytes.length||size!==40&&size!==bytes.length&&!(size%2===1&&size===bytes.length-1)
    ||view.getInt32(4,true)!==configuration.parameters.width||view.getInt32(8,true)!==configuration.parameters.height
    ||view.getUint16(12,true)!==1||![0,8,16,24,32,48].includes(view.getUint16(14,true)))
    throw new MediaOpenError('container','Invalid Matroska FFV1 BITMAPINFOHEADER');
  const end=size>40?size:bytes.length;
  return bytes.slice(40,end);
}
export async function matroskaStructure(reader:TsPacketReader,trackId:number,signal:AbortSignal,metadataOnly=false) {
  const bad=(message:string):never=>{throw new MediaOpenError('container',`JS Matroska: ${message}`);};
  const outside=(message:string):never=>{throw new TsCombinationNotMigrated(`Matroska: ${message}`);};
  let windowStart=-1,window:Uint8Array=new Uint8Array(),elements=0;
  const read=async(at:number,length:number)=>{
    signal.throwIfAborted();
    if(!Number.isSafeInteger(at)||at<0||length<0||at+length>reader.size)bad('truncated element');
    if(at<windowStart||at+length>windowStart+window.length){windowStart=at;window=await reader.read(at,Math.min(65536,reader.size-at));signal.throwIfAborted();}
    return window.subarray(at-windowStart,at-windowStart+length);
  };
  const vint=(bytes:Uint8Array,at:number,id=false)=>{
    let width=1,mask=128;while(width<=8&&!(bytes[at]&mask)){width++;mask>>=1;}
    if(width>8||id&&width>4||at+width>bytes.length)bad('invalid element integer');
    let value=id?bytes[at]:bytes[at]&(mask-1),unknown=!id&&(bytes[at]&(mask-1))===mask-1;
    for(let i=1;i<width;i++){value=value*256+bytes[at+i];unknown=unknown&&bytes[at+i]===255;}
    if(!unknown&&!Number.isSafeInteger(value))bad('element integer exceeds safe range');
    return {value,width,unknown};
  };
  const header=async(at:number,end:number)=>{
    if(++elements>2_000_000)throw new MediaOpenError('resource','JS Matroska element budget');
    const bytes=await read(at,Math.min(16,end-at)),id=vint(bytes,0,true),size=vint(bytes,id.width),data=at+id.width+size.width;
    if(data>end||!size.unknown&&data+size.value>end)bad('element exceeds parent');
    return {id:id.value,data,end:size.unknown?end:data+size.value,unknown:size.unknown};
  };
  const uint=async(at:number,end:number)=>{if(end-at>8||end<=at)bad('invalid clock integer');let n=0;for(const b of await read(at,end-at))n=n*256+b;if(!Number.isSafeInteger(n))bad('clock exceeds safe range');return n;};
  let scale=1_000_000,segments=0,selectedTrack=false,videoTracks=0,trailingOffset:number|undefined;
  const clocks=new Map<number,{pts:number;blockOffset:number;size:number;timebase:[number,number]}>();
  let configuration:MatroskaTrackConfiguration|undefined;
  const track=async(start:number,end:number)=>{
    let id=0,type=0,unsupported=false,codecId='',description=new Uint8Array(),privateRange:{start:number;end:number}|undefined,width=0,height=0,displayWidth=0,displayHeight=0,displayUnit=0;
    let colorPrimaries=2,colorTransfer=2,colorSpace=2,colorRange=0;
    for(let at=start;at<end;){const h=await header(at,end);if(h.unknown)bad('unknown track element length');
      if(h.id===0xd7)id=await uint(h.data,h.end);
      if(h.id===0x83)type=await uint(h.data,h.end);
      if(h.id===0x86){if(h.end-h.data>128)bad('codec identifier budget');codecId=new TextDecoder().decode(await read(h.data,h.end-h.data));}
      if(h.id===0x63a2)privateRange={start:h.data,end:h.end};
      if(h.id===0x6d80||h.id===0x23314f||h.id===0x6624||h.id===0xe2)unsupported=true; // encodings / timestamp scale / codec state / track operations
      // Matroska element semantics: https://www.matroska.org/technical/elements.html
      if(h.id===0xe0)for(let q=h.data;q<h.end;){const video=await header(q,h.end);if(video.unknown)bad('unknown video metadata length');
        if(video.id===0x7670)unsupported=true;
        if(video.id===0xb0)width=await uint(video.data,video.end);
        if(video.id===0xba)height=await uint(video.data,video.end);
        if(video.id===0x54b0)displayWidth=await uint(video.data,video.end);
        if(video.id===0x54ba)displayHeight=await uint(video.data,video.end);
        if(video.id===0x54b2)displayUnit=await uint(video.data,video.end);
        if(video.id===0x55b0)for(let c=video.data;c<video.end;){const color=await header(c,video.end);if(color.unknown)bad('unknown color metadata length');
          if(color.id===0x55b1)colorSpace=await uint(color.data,color.end);
          if(color.id===0x55ba)colorTransfer=await uint(color.data,color.end);
          if(color.id===0x55bb)colorPrimaries=await uint(color.data,color.end);
          if(color.id===0x55b9){const range=await uint(color.data,color.end);colorRange=range===1?1:range===2?2:0;}
          c=color.end;
        }
        if([0x54aa,0x54bb,0x54cc,0x54dd,0x53b8,0x53c0].includes(video.id)&&await uint(video.data,video.end)!==0)unsupported=true;
        if(video.id===0x9a&&await uint(video.data,video.end)===1)unsupported=true;
        q=video.end;
      }
      if((h.id===0x56aa||h.id===0x56bb)&&await uint(h.data,h.end)!==0)unsupported=true;
      at=h.end;
    }
    if(type===1){videoTracks++;if(id===trackId){selectedTrack=true;if(unsupported)outside('encoded/scaled/delayed video tracks require separate admission');
      if(width<1||height<1||width>32768||height>32768||displayUnit>3)outside('video dimensions/display unit');
      displayWidth ||= width;displayHeight ||= height;
      const num=displayWidth*height,den=displayHeight*width,gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
      if(!Number.isSafeInteger(num)||!Number.isSafeInteger(den)||num<1||den<1)bad('invalid display aspect ratio');
      const factor=gcd(num,den),sarNum=num/factor,sarDen=den/factor;
      if(sarNum>2147483647||sarDen>2147483647||[colorPrimaries,colorTransfer,colorSpace].some(n=>n>255))outside('codec parameter range');
      if(privateRange){if(privateRange.end-privateRange.start>4096)outside('codec configuration budget');description=(await read(privateRange.start,privateRange.end-privateRange.start)).slice();}
      configuration={codecId,description,parameters:{width,height,sarNum,sarDen,colorPrimaries,colorTransfer,colorSpace,colorRange}};
    }}
  };
  const cluster=async(start:number,end:number,unknown:boolean)=>{
    let timestamp:number|undefined,ordinal=0,at=start;
    const block=async(data:number,blockEnd:number,offset:number,simple:boolean)=>{
      const bytes=await read(data,Math.min(12,blockEnd-data)),id=vint(bytes,0);
      if(id.value!==trackId)return false;
      if(bytes.length<id.width+3)bad('truncated block header');
      if(timestamp===undefined)bad('block precedes cluster timestamp');
      const flags=bytes[id.width+2];
      // Invisible is a container output constraint, independent of the codec's
      // show-frame bit. Pinned Mediabunny does not carry it in EncodedPacket.
      if(flags&8)outside('invisible video blocks require decode-without-display mapping');
      if(flags&6)outside('laced video blocks require verified multi-picture mapping');
      if(flags&(simple?0x70:0xf0))bad('reserved video block flags');
      const relative=new DataView(bytes.buffer,bytes.byteOffset).getInt16(id.width),pts=timestamp!+relative;
      if(!Number.isSafeInteger(pts))bad('block clock exceeds safe range');
      const locator=start+ordinal++;
      if(clocks.size>=250000)throw new MediaOpenError('resource','JS Matroska packet budget');
      clocks.set(locator,{pts,blockOffset:offset,size:blockEnd-data-id.width-3,timebase:[scale,1e9]});
      return true;
    };
    while(at<end){const h=await header(at,end);
      if(unknown&&[0x1f43b675,0x1549a966,0x1654ae6b,0x1c53bb6b,0x1254c367,0x114d9b74,0x1941a469,0x1043a770].includes(h.id))break;
      if(h.id===0xe7)timestamp=await uint(h.data,h.end);
      else if(h.id===0xa3)await block(h.data,h.end,at,true);
      else if(h.id===0xa0){let selected=false,transformed=false,blocks=0;for(let p=h.data;p<h.end;){const child=await header(p,h.end);if(child.unknown)bad('unknown block group member length');
        if([0xa4,0x75a1,0xa2,0xfd,0x8e,0xc8].includes(child.id))transformed=true;
        if(child.id===0x75a2){if(child.end-child.data<1||child.end-child.data>8)bad('invalid discard padding');if((await read(child.data,child.end-child.data)).some(b=>b!==0))transformed=true;}
        if(child.id===0xa2){const bytes=await read(child.data,Math.min(8,child.end-child.data));selected=vint(bytes,0).value===trackId||selected;}
        if(child.id===0xa1){blocks++;selected=await block(child.data,child.end,p,false)||selected;}
        p=child.end;}
        if(selected&&transformed)outside('video BlockGroup output transforms require separate admission');
        if(selected&&blocks!==1)bad('BlockGroup requires one video block');}
      else if(h.unknown)bad('unknown cluster member length');
      at=h.end;
    }
    return at;
  };
  for(let at=0;at<reader.size;){
    if(segments===1){const next=await read(at,Math.min(4,reader.size-at)),id=next.length===4?new DataView(next.buffer,next.byteOffset,4).getUint32(0):0;
      // A finite Segment has ended. Foreign trailing bytes are outside that
      // declared container, while a second EBML/Segment still fails closed.
      if(id!==0x1a45dfa3&&id!==0x18538067&&next[0]!==0xec&&next[0]!==0xbf){trailingOffset=at;break;}
    }
    const h=await header(at,reader.size);
    if(h.id===0x18538067){if(++segments!==1)outside('linked/multiple segments require separate admission');
      for(let p=h.data;p<h.end;){const child=await header(p,h.end);
        if(child.id===0x1549a966){for(let q=child.data;q<child.end;){const info=await header(q,child.end);if(info.unknown)bad('unknown info member length');if(info.id===0x2ad7b1){if(clocks.size)outside('late timestamp scale');scale=await uint(info.data,info.end);if(scale<1||scale>1e9)outside('timestamp scale outside admission');}q=info.end;}}
        else if(child.id===0x1654ae6b){for(let q=child.data;q<child.end;){const entry=await header(q,child.end);if(entry.unknown)bad('unknown track length');if(entry.id===0xae)await track(entry.data,entry.end);q=entry.end;}if(metadataOnly)break;}
        else if(child.id===0x1f43b675){p=await cluster(child.data,child.end,child.unknown);continue;}
        else if(child.unknown)bad('unknown segment member length');
        p=child.end;
      }
    }else if(h.unknown)bad('unknown top-level element length');
    at=h.end;
  }
  if(segments!==1||videoTracks!==1||!selectedTrack)outside('requires one declared video track in one segment');
  return {clocks,configuration:configuration!,trailingOffset};
}
export async function matroskaClocks(reader:TsPacketReader,trackId:number,signal:AbortSignal) {
  return (await matroskaStructure(reader,trackId,signal)).clocks;
}
