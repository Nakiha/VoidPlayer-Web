import { Input, CustomSource, EncodedPacketSink, MP4, QTFF, MATROSKA, WEBM, MPEG_TS } from 'mediabunny';
import {configurationPixelFields} from './codecs/configuration-pixel-fields.ts';
export {configurationPixelFields} from './codecs/configuration-pixel-fields.ts';
import {inspectDeclaredTracks} from './containers/cached-track-metadata.ts';
import {flvPrefixMetadata} from './containers/flv-prefix-metadata.ts';
import { avcGeometry } from './codecs/avc-geometry.ts';
import { hevcGeometry } from './codecs/hevc-geometry.ts';
import { DISCOVERY_LIMITS as LIMITS } from './discovery.ts';
import type { DiscoveryField, DiscoverySource, DiscoveryStream, MediaProbe } from './discovery.ts';

export const unknownProbeField = (reason: string, status: DiscoveryField['status'] = 'unknown'): DiscoveryField => ({value:null,status,source:'unavailable',reason});
const known = (value: string|number|boolean|null|undefined, source: DiscoveryField['source'] = 'container-index'): DiscoveryField =>
  value === undefined || value === null || typeof value === 'number' && !Number.isFinite(value) ? unknownProbeField('not-declared-by-parser') : {value,status:'known',source};
const fieldNames = ['codec','profile','width','height','codedWidth','codedHeight','sar','rotation','bitDepth','pixelFormat',
  'colorPrimaries','colorTransfer','colorMatrix','colorRange','durationUs','frameRate','frameRateMode','bitrate','decodedFrameCount','sampleRate','channels'];
export const emptyProbeFields = ():Record<string,DiscoveryField> => ({...Object.fromEntries(fieldNames.map(k=>[k,unknownProbeField('not-exposed-by-metadata-adapter')])),
  frameRate:unknownProbeField('packet-timestamps-not-enumerated'),frameRateMode:unknownProbeField('CFR-VFR-not-measured'),
  bitrate:unknownProbeField('payloads-not-enumerated'),decodedFrameCount:unknownProbeField('no-decoder-run')});
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
  let scope:MediaProbe['coverage']['scope']='metadata-only',prefixCoverage:MediaProbe['coverage']['prefix'];
  let inventory:MediaProbe['inventory']={scope:'initial-container-declarations',reason:'startup-FLV-video-only',declaredTrackCount:null};
  if(head[0]===70&&head[1]===76&&head[2]===86){
    container=known('flv');scope='bounded-container-prefix';
    const prefix=await flvPrefixMetadata(size,peek);prefixCoverage=prefix.prefix;
    const clock={timeBase:{numerator:1,denominator:1000},domain:'flv-native-milliseconds' as const,origin:null,relationToQualityAu:'not-established' as const};
    if(prefix.video){const fields=emptyProbeFields(),{codec,description}=prefix.video;fields.codec=codec?known(codec,'codec-configuration'):unknownProbeField(prefix.video.reason??'unsupported-video-codec');
      if(description&&codec){const geometry=codec==='h264'?avcGeometry(description,true):codec==='hevc'?hevcGeometry(description,true):null;
        if(geometry){for(const key of ['width','height','codedWidth','codedHeight'] as const)fields[key]=known(geometry[key],'codec-configuration');fields.sar=geometry.sarSpecified?known(`${geometry.sarNum}:${geometry.sarDen}`,'codec-configuration'):unknownProbeField('SPS-SAR-unspecified');}
        Object.assign(fields,configurationPixelFields(codec,description));
        if(codec==='hevc'&&description.length>=23&&description[0]===1)fields.profile=known(String(description[1]&31),'codec-configuration');
        if(codec==='h264'&&description.length>=7&&description[0]===1)fields.profile=known(String(description[1]),'codec-configuration');
      }
      streams.push({id:'flv-video:0',type:'video',ordinal:streams.length,fields,clock});
    }
    if(prefix.audio){const fields=emptyProbeFields(),audio=prefix.audio;fields.codec=audio.codec?known(audio.codec):unknownProbeField(audio.reason??'unsupported-audio-format');
      fields.sampleRate=known(audio.metadata.sampleRate);fields.channels=known(audio.metadata.channels);fields.profile=audio.metadata.codec?known(audio.metadata.codec,'codec-configuration'):unknownProbeField(audio.reason??'audio-profile-not-observed');
      streams.push({id:'flv-audio:0',type:'audio',ordinal:streams.length,fields,clock});
    }
    inventory={scope:'initial-container-declarations',reason:prefix.video?'bounded-FLV-prefix-inventory-incomplete':'video-not-observed-within-bounded-FLV-prefix',declaredTrackCount:null};
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
    coverage:{scope,fullPacketEnumeration:false,decodedPictures:false,bytesRead,readCalls,...(prefixCoverage?{prefix:prefixCoverage}:{})}};
}
