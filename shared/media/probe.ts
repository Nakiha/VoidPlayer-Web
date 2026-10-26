import { Input, CustomSource, EncodedPacketSink, MP4, QTFF, MATROSKA, WEBM, MPEG_TS } from 'mediabunny';
import { isAnnexB,nalRanges } from './codecs/nal-framing.ts';
import {inspectDeclaredTracks} from './containers/cached-track-metadata.ts';
import { scanFlv } from './containers/flv-demux.ts';
import { avcGeometry } from './codecs/avc-geometry.ts';
import { hevcGeometry } from './codecs/hevc-geometry.ts';
import { DISCOVERY_LIMITS as LIMITS } from './discovery.ts';
import type { DiscoveryField, DiscoverySource, DiscoveryStream, MediaProbe } from './discovery.ts';

export const unknownProbeField = (reason: string, status: DiscoveryField['status'] = 'unknown'): DiscoveryField => ({value:null,status,source:'unavailable',reason});
const known = (value: string|number|boolean|null|undefined, source: DiscoveryField['source'] = 'container-index'): DiscoveryField =>
  value === undefined || value === null || typeof value === 'number' && !Number.isFinite(value) ? unknownProbeField('not-declared-by-parser') : {value,status:'known',source};
const fieldNames = ['codec','profile','width','height','codedWidth','codedHeight','sar','rotation','bitDepth','pixelFormat',
  'colorPrimaries','colorTransfer','colorMatrix','colorRange','durationUs','frameRate','frameRateMode','bitrate','decodedFrameCount'];
export const emptyProbeFields = ():Record<string,DiscoveryField> => ({...Object.fromEntries(fieldNames.map(k=>[k,unknownProbeField('not-exposed-by-metadata-adapter')])),
  frameRate:unknownProbeField('packet-timestamps-not-enumerated'),frameRateMode:unknownProbeField('CFR-VFR-not-measured'),
  bitrate:unknownProbeField('payloads-not-enumerated'),decodedFrameCount:unknownProbeField('no-decoder-run')});
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
/** No decoder, packet sink, browser or network capability. The host charges ALL
 * requested source bytes, including parser prefetch and repeated reads. */
export async function probeMedia(source:DiscoverySource,size:number,read:(offset:number,length:number)=>Promise<Uint8Array>,check:()=>void):Promise<MediaProbe> {
  let bytesRead=0,readCalls=0;
  const peek=async(offset:number,length:number)=>{
    check();
    if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0||offset+length>size
      ||++readCalls>LIMITS.probeReadCalls||bytesRead+length>LIMITS.probeBytes)throw Error('probe-budget-exceeded');
    bytesRead+=length;const value=await read(offset,length);check();if(value.length!==length)throw Error('source-changed');return value;
  };
  const head=await peek(0,Math.min(16,size));
  let container:DiscoveryField,streams:DiscoveryStream[]=[],streamInventoryComplete=false;
  let scope:MediaProbe['coverage']['scope']='metadata-only';
  let inventory:MediaProbe['inventory']={scope:'initial-container-declarations',reason:'startup-FLV-video-only',declaredTrackCount:null};
  if(head[0]===70&&head[1]===76&&head[2]===86){
    container=known('flv');scope='initial-video-configuration';
    const {index}=await scanFlv({size,read:peek},undefined,undefined,true);
    check();const fields=emptyProbeFields(),description=index.description;
    fields.codec=known(index.codec,'codec-configuration');
    const geometry=index.codec==='h264'?avcGeometry(description,true):index.codec==='hevc'?hevcGeometry(description,true):null;
    if(geometry){for(const key of ['width','height','codedWidth','codedHeight'] as const)fields[key]=known(geometry[key],'codec-configuration');
      fields.sar=geometry.sarSpecified?known(`${geometry.sarNum}:${geometry.sarDen}`,'codec-configuration'):unknownProbeField('SPS-SAR-unspecified');}
    Object.assign(fields,configurationPixelFields(index.codec,description));
    if(index.codec==='hevc'&&description.length>=23&&description[0]===1)fields.profile=known(String(description[1]&31),'codec-configuration');
    if(index.codec==='h264'&&description.length>=7&&description[0]===1)fields.profile=known(String(description[1]),'codec-configuration');
    // FLV video:0 is the parser's single video stream, not an authenticated AU.
    streams=[{id:'flv-video:0',type:'video',ordinal:0,fields,clock:{timeBase:{numerator:1,denominator:1000},domain:'flv-native-milliseconds',origin:null,relationToQualityAu:'not-established'}}];
    // Header audio bits/configuration can be incomplete or enhanced multitrack.
    // A startup scan cannot certify absence or enumerate the whole container.
  }else{
    const input=new Input({source:new CustomSource({getSize:()=>size,read:(start,end)=>peek(start,end-start),maxCacheSize:LIMITS.probeBytes,prefetchProfile:'none'}),
      formats:[MP4,QTFF,MATROSKA,WEBM,MPEG_TS]});
    try{
      const format=await input.getFormat();check();
      container=known(format===MP4?'mp4':format===QTFF?'quicktime':format===WEBM?'webm':format===MATROSKA?'matroska':'mpeg-ts');
      const declared=format===MPEG_TS?null:await inspectDeclaredTracks(size,peek,format===MP4||format===QTFF?'mp4':'matroska');check();
      const tracks=await input.getTracks();check();if(tracks.length>LIMITS.probeStreams)throw Error('probe-stream-budget-exceeded');
      for(let ordinal=0;ordinal<tracks.length;ordinal++){
        const track=tracks[ordinal],fields=emptyProbeFields();
        if(!Number.isSafeInteger(track.id)||track.id<1)throw Error('unsupported-track-identity');
        const codec=await track.getCodec();check();fields.codec=known(codec==='avc'?'h264':codec);
        const duration=await track.getDurationFromMetadata({skipLiveWait:true});check();
        fields.durationUs=duration!==null&&duration>=0&&Number.isSafeInteger(Math.round(duration*1e6))?known(Math.round(duration*1e6)):unknownProbeField('container-duration-unavailable');
        const resolution=await track.getTimeResolution();check();
        if(track.isVideoTrack()){
          fields.width=known(await track.getCodedWidth(),'container-or-codec-metadata');fields.height=known(await track.getCodedHeight(),'container-or-codec-metadata');check();
          fields.codedWidth=unknownProbeField('container-sample-dimensions-not-SPS-coded-grid');
          fields.codedHeight=unknownProbeField('container-sample-dimensions-not-SPS-coded-grid');
          fields.rotation={...known(await track.getRotation()),status:'derived',reason:'parser-reported;may-default-to-zero'};check();
          const sar=await track.getPixelAspectRatio();check();
          fields.sar={...known(`${sar.num}:${sar.den}`,'container-or-codec-metadata'),status:'derived',reason:'parser-reported;may-default-to-square'};
          // This can inspect a bounded initial configuration packet; never a
          // decoder or computeDuration()/computeFrameRateMetrics() scan.
          const config=await track.getDecoderConfig();check();
          if(config){fields.profile=known(config.codec,'codec-configuration');const color=await track.getColorSpace();check();
            for(const [key,value] of Object.entries({colorPrimaries:color.primaries,colorTransfer:color.transfer,colorMatrix:color.matrix,colorRange:color.fullRange==null?null:color.fullRange?'full':'limited'}))fields[key]=known(value,'container-or-codec-metadata');
            const d=config.description;let description=d?ArrayBuffer.isView(d)?new Uint8Array(d.buffer,d.byteOffset,d.byteLength):new Uint8Array(d):null;
            if(!description&&['avc','hevc'].includes(codec??'')){const first=await new EncodedPacketSink(track).getFirstPacket();check();description=first?.data??null;}
            if(description)Object.assign(fields,configurationPixelFields(codec==='avc'?'h264':codec??'',description));
          }
        }
        streams.push({id:`track:${track.id}:${ordinal}`,type:track.isVideoTrack()?'video':track.isAudioTrack()?'audio':'other',ordinal,fields,
          clock:{timeBase:Number.isSafeInteger(resolution)&&resolution>0?{numerator:1,denominator:resolution}:null,domain:'container-track-ticks',origin:null,relationToQualityAu:'not-established'}});
      }
      // Public playback tracks omit subtitles/data. Only the independently
      // bounded initial header inventory can prove that no declared row was lost.
      streamInventoryComplete=!!declared?.complete&&tracks.every(t=>declared.tracks.some(d=>d.id===t.id&&(t.isVideoTrack()?d.type==='video':d.type==='audio')));
      if(declared?.complete){for(const declaredTrack of declared.tracks){if(tracks.some(t=>t.id===declaredTrack.id))continue;
        const fields=emptyProbeFields();fields.handlerType=known(declaredTrack.handler);if(declaredTrack.codecIdentifier)fields.codecIdentifier=known(declaredTrack.codecIdentifier);
        streams.push({id:`declared-track:${declaredTrack.id}`,type:declaredTrack.type,ordinal:streams.length,fields,
          clock:{timeBase:declaredTrack.timeBase,domain:'container-track-ticks',origin:null,relationToQualityAu:'not-established'}});
      }}
      if(streams.length>LIMITS.probeStreams)throw Error('probe-stream-budget-exceeded');
      inventory={scope:'initial-container-declarations',reason:streamInventoryComplete?null:declared?.reason??(declared?.complete?'parser-and-header-track-inventory-mismatch':'bounded-TS-initial-program-metadata-only'),declaredTrackCount:declared?.complete?declared.tracks.length:null};
    }finally{input.dispose();}
  }
  check();return {schema:'voidplayer-media-probe',version:1,source,parser:'voidplayer-bounded-metadata-v1/mediabunny-1.55.7',container,streams,streamInventoryComplete,inventory,
    coverage:{scope,fullPacketEnumeration:false,decodedPictures:false,bytesRead,readCalls}};
}
