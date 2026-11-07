import { Input, CustomSource, MP4, QTFF, EncodedPacketSink } from 'mediabunny';
import type { EncodedPacket } from 'mediabunny';
import { avcGeometry } from '../codecs/avc-geometry.ts';
import { MediaOpenError } from '../io/media-errors.ts';
import { readMp4Configurations, validateFragmentPacket } from './mp4-config.ts';
import type { Mp4Reader } from './mp4-config.ts';
import type { PacketDecodeIndex } from '../indexing/packet-decode-index.ts';
import { hevcDisplayOrder, recoveredHevcTimes } from '../codecs/hevc-timeline.ts';
import type { FlvCodec, FlvPacket } from './flv-demux.ts';
import { aacMetadata } from './cached-track-metadata.ts';
import type { CachedTrackMetadata } from './cached-track-metadata.ts';

async function mp4TrackMetadata(input: Input): Promise<CachedTrackMetadata> {
  // These facts come from the already parsed moov. Do not read audio packets or
  // infer a container clock from normalized packet timestamps or sample rates.
  const video = await Promise.all((await input.getVideoTracks()).map(async track => ({
    timeBase: { numerator: 1, denominator: await track.getTimeResolution() },
  })));
  const tracks = await Promise.all((await input.getAudioTracks()).map(async track => {
    const known = await track.getCodec(), id = String(await track.getInternalCodecId());
    const codec = ({ mp4a: 'AAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', Opus: 'Opus', fLaC: 'FLAC',
      alac: 'ALAC', '.mp3': 'MP3', lpcm: 'PCM', sowt: 'PCM', twos: 'PCM' } as Record<string, string>)[id]
      ?? known?.toUpperCase() ?? id;
    // Only AAC config inspection is header-only; other decoder configs (DTS,
    // for example) may inspect packets and must not be requested here.
    const description = known === 'aac' ? (await track.getDecoderConfig())?.description : undefined;
    const aac = description ? aacMetadata(ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description)) : {};
    return { codec, sampleRate: await track.getSampleRate(), channels: await track.getNumberOfChannels(), ...aac,
      timeBase: { numerator: 1, denominator: await track.getTimeResolution() } };
  }));
  return { container: await input.getFormat() === QTFF ? 'QuickTime' : 'MP4', video,
    audio: { presence: tracks.length ? 'present' : 'absent', tracks, complete: true } };
}

export async function inspectMp4Playback(reader: Mp4Reader, onIndex?: () => void, observe?: (offset: number, bytes: Uint8Array) => void) {
  let fragmented = false;
  const input = new Input({ source: new CustomSource({ getSize: () => reader.size, async read(start, end) {
    const bytes = await (fragmented && reader.readMetadata ? reader.readMetadata(start, end - start) : reader.read(start, end - start));
    observe?.(start, bytes);
    return bytes;
  }, maxCacheSize: 1024 * 1024 }), formats: [MP4, QTFF] });
  try {
    try{await input.getFormat();}catch(error){if(error instanceof MediaOpenError)throw error;throw new MediaOpenError('container','不是可通过 MP4 索引读取的文件。');}
    const track=await input.getPrimaryVideoTrack();if(!track)throw new MediaOpenError('container','MP4 没有视频轨道。');
    if(![0,90,180,270].includes(track.rotation))throw new MediaOpenError('container','MP4 旋转角度不受支持。');
    const rotation=track.rotation as 0|90|180|270;
    const id=await track.getInternalCodecId(),known=await track.getCodec();
    const codec:PacketDecodeIndex['codec']=id==='mp4v'?'mpeg4':['jpeg','mjpa','mjpb'].includes(String(id))?'mjpeg':['apch','apcn','apcs','apco','ap4h','ap4x'].includes(String(id))?'prores':id==='vvc1'||id==='vvi1'?'vvc':({avc:'h264',hevc:'hevc',av1:'av1'} as Record<string,FlvCodec>)[known??''];
    if(!codec)throw new MediaOpenError('codec','此 MP4 视频编码暂不支持。');
    const configs=await readMp4Configurations(reader,track.id);
    fragmented = !!configs.fragmentSequenceNumbers;const displayBounds=configs.descriptions.length===1?configs.displayBounds??[]:[];
    let available = configs.availableSamples ?? configs.sampleSizes!.length;
    onIndex?.();const sink=new EncodedPacketSink(track), metadata:EncodedPacket[]=[];
    for await(const packet of sink.packets(undefined,undefined,{metadataOnly:true})){
      metadata.push(packet);if(metadata.length===available)break;if(metadata.length>2_000_000)throw new MediaOpenError('resource','MP4 包索引超过上限。');
    }
    if(!metadata.length||metadata[0].type!=='key')throw new MediaOpenError('container','MP4 缺少起始关键帧。');
    if(available!==metadata.length)throw new MediaOpenError('container','MP4 包数量与 sample 表不一致。');
    if (configs.indexIntegrity === 'prefix') {
      let cut = 0;
      for (let i = 1; i < metadata.length; i++) if (metadata[i].type === 'key') cut = i;
      if (!cut) throw new MediaOpenError('input', 'MP4 损坏前没有可确认完整的 GOP。');
      available = cut;
      metadata.length = cut;
      configs.indexTruncatedAt = configs.sampleOffsets![cut];
      configs.warning = `文件尾部缺失：仅播放前 ${cut} 个完整视频包；已舍弃末尾可能缺少参考帧的 GOP。`;
    }
    const resolution=await track.getTimeResolution();
    const packets:FlvPacket[]=metadata.map((p,i)=>{
      validateFragmentPacket(configs, i, p, resolution);
      const configuration=configs.sampleConfigurations?.[i]??0;
      if(i>0&&configuration!==(configs.sampleConfigurations?.[i-1]??0)&&p.type!=='key')throw new MediaOpenError('container','MP4 配置切换缺少随机访问点。');
      if(configs.sampleSizes?.[i]!==p.byteLength)throw new MediaOpenError('container','MP4 sample 长度与包索引不一致。');
      return {configuration,sequenceNumber:i,offset:configs.sampleOffsets![i],size:p.byteLength,pts:Math.round(p.timestamp*1e6),dts:Math.round(p.timestamp*1e6-(configs.compositionOffsets![i]/resolution)*1e6),key:p.type==='key'};
    });
    const prefixConfigs = { ...configs, sampleOffsets: configs.sampleOffsets!.slice(0, available), sampleSizes: configs.sampleSizes!.slice(0, available), compositionOffsets: configs.compositionOffsets!.slice(0, available) };
    const displayOrder=codec==='hevc'?await hevcDisplayOrder(reader,prefixConfigs,()=>onIndex?.()):null;
    const recovered=displayOrder&&recoveredHevcTimes(displayOrder,packets.map(p=>p.pts),metadata.map(p=>Math.round(p.duration*1e6)));
    if(displayOrder&&!recovered)throw new MediaOpenError('container','HEVC 图片顺序与容器时间不一致，但无法从非等距时间线恢复显示时间。');
    if(recovered)packets.forEach((p,i)=>{p.originalPts=p.pts;p.pts=recovered[i];});
    const order=packets.map((_,i)=>i).sort((a,b)=>packets[a].pts-packets[b].pts),pts=order.map(i=>packets[i].pts);
    if(pts.some((p,i)=>i>0&&p<=pts[i-1]))throw new MediaOpenError('container','MP4 包时间戳存在歧义，需要容器解码路径。');
    const durations=order.map((p,i)=>(recovered||configs.fragmentSequenceNumbers)&&i+1<pts.length?pts[i+1]-pts[i]:Math.round((configs.sampleDurations?.[p] !== undefined ? configs.sampleDurations[p]/resolution : metadata[p].duration)*1e6)||(i+1<pts.length?pts[i+1]-pts[i]:i?pts[i]-pts[i-1]:40000));
    const firstPts=pts[0],duration=pts.at(-1)!-firstPts+durations.at(-1)!;
    const index:PacketDecodeIndex={codec,...(['mpeg4','mjpeg','prores'].includes(codec)?{codecParameters:configs.codecParameters![0],codecConfigurations:configs.codecParameters}:{}),description:configs.descriptions[0],configurations:configs.descriptions,packets,order,firstPts,duration,durations,
      ...(configs.indexIntegrity === 'prefix' ? { truncatedAt: configs.indexTruncatedAt } : {})};
    const containerCrop=codec==='h264'&&configs.descriptions.some((description,i)=>{const g=avcGeometry(description),bounds=displayBounds[i];return g&&bounds&&(bounds.width<g.width||bounds.height<g.height);});
    // Multi-stsd previously used software decoding. Track-level WebCodecs
    // metadata describes the last entry, and reconfiguring from descriptions
    // alone does not preserve per-entry color interpretation on every engine.
    // Keep those inputs on the JS packet table with the verified WASM decoder.
    const nativeConfig=containerCrop||configs.descriptions.length>1||['mpeg4','mjpeg','prores'].includes(codec)?undefined:await track.getDecoderConfig()??undefined;
    return { index, rotation, displayBounds, nativeConfig, trackMetadata: await mp4TrackMetadata(input),
      color: nativeConfig ? await track.getColorSpace() : null,
      recovered: !!recovered, indexIntegrity: configs.indexIntegrity, indexTruncatedAt: configs.indexTruncatedAt,
      indexWarning: [configs.warning, recovered ? '容器未记录图片重排时间，已按 HEVC 图片顺序恢复等距时间线。' : undefined].filter(Boolean).join(' ') || undefined };
  } finally { input.dispose(); }
}
export type Mp4Playback = Awaited<ReturnType<typeof inspectMp4Playback>>;
