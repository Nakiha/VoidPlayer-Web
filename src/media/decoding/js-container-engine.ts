import type { DecodeThreads } from '../policy/wasm-threads.ts';
import { RangeReader, type RandomAccessInput } from '../../../shared/media/io/range-reader.ts';
import { TsPacketSource } from '../../../shared/media/containers/ts-packet-source.ts';
import type { TsPlaybackPrefix } from '../../../shared/media/containers/ts-packet-source.ts';
import {TsContainerPacketSource} from '../../../shared/media/containers/mpeg2-ts-packet-source.ts';
import {MatroskaPacketSource} from '../../../shared/media/containers/matroska-packet-source.ts';
import type {JsPacketIndex} from '../../../shared/media/containers/matroska-packet-index.ts';
import {jsPictureStream} from '../../../shared/media/containers/matroska-packet-index.ts';
import {jsDecodeIndex} from '../indexing/js-decode-index.ts';
import { PacketTimeline } from './packet-timeline.ts';
import { nativePacketDecoder, wasmPacketDecoder } from './flv-decoder.ts';
import type { PacketFrame, PacketDecoder } from './flv-decoder.ts';
import type { PacketDecodeIndex } from '../../../shared/media/indexing/packet-decode-index.ts';
import type { PacketView } from '../../../shared/analysis/metadata/adapters.ts';
import type { MediaOpenProgress } from '../progress.ts';
import type { IndexProgress } from '../workers/worker-protocol.ts';
import { MediaOpenError } from '../../../shared/media/io/media-errors.ts';
import { inspectCachedTracks } from '../../../shared/media/containers/cached-track-metadata.ts';
import { staticTsPsi } from '../../../shared/media/containers/ts-static-psi.ts';
import type { TsPacketIndex } from '../../../shared/media/indexing/ts-packet-index.ts';
import {loadServerJsIndex} from '../indexing/js-packet-index-client.ts';

/** Finite static JS container admission. Both decoders consume one JS source;
 * the engine has no FFmpeg container entry or alternative demux path. */
export class JsContainerEngine {
  private reader: RangeReader;
  private format:'ts'|'matroska';
  private controller = new AbortController();
  private source?: TsPacketSource | TsContainerPacketSource | MatroskaPacketSource;
  private input:RandomAccessInput;private sourceVersion:string;private persistent:boolean;
  private index?: PacketDecodeIndex;
  private document?: JsPacketIndex;
  private statistics?: {packets: PacketView[]};
  private timeline?: PacketTimeline;
  private primed: PacketFrame | null = null;
  private closed = false;
  private indexPacketsScanned=0;
  private indexOrigin:'client'|'server'='client';
  private outputSize?: { width: number; height: number };
  private createNative:typeof nativePacketDecoder;
  private createSoftware:typeof wasmPacketDecoder;
  private prefix?:Uint8Array;
  private startup?: TsPacketIndex;
  private startupSource?: TsContainerPacketSource;
  private firstPtsUs?: number;
  private published?: TsPlaybackPrefix;
  private waiters = new Set<()=>void>();
  onIndexWaiting?: (waiting: boolean)=>void;

  private wakeIndex() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private waitForGrowth = async () => {
    if (!this.startup) return;
    this.onIndexWaiting?.(true);
    await new Promise<void>(resolve=>this.waiters.add(resolve));
    this.onIndexWaiting?.(false);
    this.check();
  };
  private indexTask?: Promise<ReturnType<JsContainerEngine['timing']>>;
  get indexComplete() { return !this.startup; }
  tuneVvc(axis?: import('../contract.ts').VvcTuningAxis) { return this.timeline?.decoder.tuneVvc?.(axis) ?? null; }

  private tsSource(reader: RangeReader, size = reader.size) {
    return new TsContainerPacketSource({size,read:(at,length)=>reader.read(at,length),close:()=>reader.close()},
      this.sourceVersion,this.controller.signal);
  }

  /** The bounded reader ends at a video PES boundary. Keep only GOPs
   * closed by a subsequent verified anchor from that reader. */
  private async prepareTsStartup() {
    if (!this.persistent || this.format !== 'ts' || !('file' in this.input) || this.reader.size <= 4*1024*1024) return;
    const reader = new RangeReader(this.input);
    let candidate: TsContainerPacketSource | undefined;
    try {
      const limit = Math.floor(4*1024*1024/188)*188;
      const psi = staticTsPsi(await reader.read(0,188*348));
      if (psi.videoStreams.length !== 1) return;
      const {pid,type} = psi.videoStreams[0];
      // MPEG-2 I pictures alone do not prove a closed startup GOP.
      if (type !== 27 && type !== 36) return;
      const tail = await reader.read(limit-188*1024,188*1024);
      let end = tail.length-188;
      for (; end >= 0; end -= 188) {
        if (tail[end] === 0x47 && (tail[end+1]&64) && ((tail[end+1]&31)*256+tail[end+2]) === pid) break;
      }
      if (end < 0) return;
      candidate = this.tsSource(reader,limit-tail.length+end);
      const prefix = await candidate.open();
      const lastKey = prefix.packets.findLastIndex(packet=>packet.key);
      if (prefix.recovery || prefix.indexIntegrity || lastKey < 1) return;
      const packets = prefix.packets.slice(0,lastKey);
      const decode = jsDecodeIndex(prefix);
      const order = decode.order.filter(au=>au<lastKey);
      if (order.some((au,i)=>decode.order[i]!==au)) return;
      this.index = {...decode,packets:decode.packets.slice(0,lastKey),order,durations:decode.durations.slice(0,lastKey),
        duration:decode.packets[decode.order[lastKey]].pts-decode.firstPts};
      this.indexPacketsScanned = candidate.packetsRead;
      this.startup = prefix;
      this.source = this.startupSource = candidate;
      this.updateStatistics({packets});
      return prefix;
    } catch (error) {
      this.controller.signal.throwIfAborted();
      if (!(error instanceof MediaOpenError) || error.stage !== 'container') throw error;
      // Broadcast recovery and unusual short startup layouts use the complete parser.
      return;
    } finally {
      if (!this.startup) { candidate?.close(); reader.close(); }
    }
  }

  private updateStatistics(index: Pick<JsPacketIndex,'packets'>) {
    this.statistics = {packets: index.packets.map(packet=>({pts:packet.timing.pts===null?null:packet.ptsUs,
      dts:packet.timing.dts===null?null:Math.round(packet.timing.dts*1e6*packet.timing.timebase[0]/packet.timing.timebase[1]),size:packet.size,key:packet.key}))};
  }

  private timing() {
    const index = this.index!, document = this.document!, origin = this.firstPtsUs!;
    return { firstPtsUs:origin,durationUs:index.firstPts+index.duration-origin,
      times:index.order.map(au=>index.packets[au].pts-origin),durations:index.durations,indexSource:this.indexOrigin,
      seekAnchorCount:index.packets.filter(packet=>packet.key).length,jsIndexPacketsScanned:this.indexPacketsScanned,
      indexIntegrity:document.indexIntegrity==='prefix'?'prefix' as const:'complete' as const,indexTruncatedAt:document.indexTruncatedAt,
      indexWarning:document.kind==='js-ts-packets'&&document.recovery?'广播采集恢复：保留原始时钟；部分尾包，画面身份未验证。':
        document.indexIntegrity==='prefix'?'封装损坏：仅保留已确认的有效前段。':undefined };
  }

  private checkContinuation(document: Pick<TsPacketIndex,'codec'|'pid'|'configuration'|'packets'>, index: PacketDecodeIndex) {
    const previous = this.index!, prefix = this.startup!, records = this.published?.packets ?? prefix.packets;
    const samePacket = (a: TsPacketIndex['packets'][number], b: TsPacketIndex['packets'][number]) =>
      a.locator===b.locator && a.pesOffset===b.pesOffset && a.size===b.size && a.ptsUs===b.ptsUs && a.key===b.key &&
      a.timing.pts===b.timing.pts && a.timing.dts===b.timing.dts;
    if (document.codec!==prefix.codec || document.pid!==prefix.pid ||
      JSON.stringify(document.configuration)!==JSON.stringify(prefix.configuration) ||
      previous.packets.some((_,i)=>!document.packets[i] || !samePacket(records[i],document.packets[i])) ||
      previous.order.some((au,i)=>index.order[i]!==au)) throw new MediaOpenError('container','TS 完整索引与已播放前段不一致。');
  }

  private extendPlayback(prefix: TsPlaybackPrefix, source: TsContainerPacketSource) {
    if (prefix.packets.length <= this.index!.packets.length) return;
    const previous = this.index!;
    const packets = prefix.packets.map(p=>({sequenceNumber:p.au,offset:p.locator,size:p.size,pts:p.ptsUs,
      dts:p.timing.dts===null?null:Math.round(p.timing.dts*1e6/90000),key:p.key,identityKnown:false}));
    const order = packets.map((_,i)=>i).sort((a,b)=>packets[a].pts-packets[b].pts);
    const durations = order.map((au,i)=>(i+1<order.length?packets[order[i+1]].pts:prefix.nextPtsUs)-packets[au].pts);
    const index = {...previous,packets,order,durations,duration:prefix.nextPtsUs-previous.firstPts};
    this.checkContinuation(prefix,index);
    this.source = source;
    this.published = prefix;
    this.index = index;
    this.updateStatistics(prefix);
    this.timeline!.appendIndex(index);
    this.wakeIndex();
  }

  async completeIndex(publish?: (progress: IndexProgress)=>void) {
    this.check();
    if (!this.startup) return this.timing();
    if (!this.indexTask) {
      const source = this.tsSource(this.reader);
      this.indexTask = (async()=>{
        try {
          const document = await source.open(undefined,data=>publish?.({...data,durationUs:this.index!.firstPts+this.index!.duration-this.firstPtsUs!}),
            false,prefix=>this.extendPlayback(prefix,source));
          this.check();
          const index = jsDecodeIndex(document);
          if (document.kind!=='js-ts-packets' || document.recovery) throw new MediaOpenError('container','TS 后台索引改变了封装读取方式。');
          this.checkContinuation(document,index);
          this.source = source;
          this.document = document;
          this.index = index;
          this.indexPacketsScanned = source.packetsRead;
          this.startup = this.published = undefined;
          this.updateStatistics(document);
          this.timeline!.appendIndex(index);
          this.timeline!.setGrowth();
          this.wakeIndex();
          return this.timing();
        } catch (error) {
          if (this.source !== source) source.close();
          this.timeline?.setGrowth();
          this.wakeIndex();
          throw error;
        }
      })();
    }
    return this.indexTask;
  }
  constructor(input: RandomAccessInput, sourceVersion: string,
    decoders: {native?:typeof nativePacketDecoder;software?:typeof wasmPacketDecoder;persistent?:boolean} = {}, format:'ts'|'matroska'='ts') {
    this.format=format;this.reader = new RangeReader(input);
    this.input=input;this.sourceVersion=sourceVersion;this.persistent=!!decoders.persistent;
    this.createNative=decoders.native??nativePacketDecoder;
    this.createSoftware=decoders.software??wasmPacketDecoder;
  }
  cachedWindows() {
    const windows=new Map(this.reader.cachedWindows().map(w=>[w.offset,w]));
    for(let offset=0;offset<(this.prefix?.length??0);offset+=65536)windows.set(offset,{offset,length:Math.min(65536,this.prefix!.length-offset)});
    return [...windows.values()].sort((a,b)=>a.offset-b.offset);
  }
  peekCachedBytes(offset: number, length: number) {
    return this.reader.peek(offset,length)??(Number.isSafeInteger(offset)&&Number.isSafeInteger(length)&&offset>=0&&length>=0
      &&length<=65536&&this.prefix&&offset+length<=this.prefix.length?this.prefix.slice(offset,offset+length):undefined);
  }
  get analysisIndex() { return this.statistics; }
  /** Untrusted when serialized across runtimes; recipients must verify/rebuild. */
  get packetIndex() { return this.document; }
  private check() { if (this.closed) throw new MediaOpenError('input', 'JS TS engine is closed'); }
  private makeTimeline(decoder: PacketDecoder) {
    if (this.closed) { decoder.close(); this.check(); }
    return new PacketTimeline(this.index!, decoder, packet => this.source!.readUnit(packet.sequenceNumber!),
      true, () => !this.closed && this.indexComplete, jsPictureStream(this.document!));
  }
  private async first(timeline: PacketTimeline, pts: number) {
    const frame = await timeline.at(pts);
    if (this.closed) { frame.frame?.close(); this.check(); }
    return frame;
  }
  async prepare(onIndexProgress?: (data:IndexProgress)=>void) {
    this.check();
    if (this.document) return this.document;
    const libraryPlayback = 'url' in this.input && !!this.input.library;
    if(this.format==='ts' && !libraryPlayback){
    let prefix = await this.reader.read(0, Math.min(65536, this.reader.size));
    const tracks=await inspectCachedTracks(this.reader.size,async(at,n)=>this.reader.peek(at,n));
    // Retain a bounded startup window already needed by video indexing, so
    // optional AAC observation survives the full scan evicting early windows.
    if(tracks.audio.presence==='present')prefix=await this.reader.read(0,Math.min(1024*1024,this.reader.size));
    // TS source owns bounded synchronization/PSI recovery and validation.
    // Decoder preference never selects a container fallback.
    this.prefix=prefix.slice();
    }
    const startup = await this.prepareTsStartup();
    if (startup) return this.document = startup;
    let cached:JsPacketIndex|undefined;
    if ('url' in this.input && (this.persistent || libraryPlayback)) {
      cached=await loadServerJsIndex(this.input.url,this.sourceVersion,this.reader.size,this.format,this.controller.signal,onIndexProgress,this.input.library);
      if(cached)this.indexOrigin='server';
    }
    const sourceReader={size:this.reader.size,read:async(at:number,length:number)=>{
      const bytes=await this.reader.read(at,length);
      return bytes;
    },close:()=>this.reader.close()};
    this.source=this.format==='ts'?new TsContainerPacketSource(sourceReader,this.sourceVersion,this.controller.signal):new MatroskaPacketSource(sourceReader,this.sourceVersion,this.controller.signal);
    this.document = await this.source!.open(cached,onIndexProgress,libraryPlayback);
    this.indexPacketsScanned=this.source!.packetsRead;
    this.check();
    this.index = jsDecodeIndex(this.document);
    this.updateStatistics(this.document);
    return this.document;
  }
  async open(glueURL: string, wasmBinary?: Uint8Array, forceWasm = true, threads: DecodeThreads = 1, onProgress?: MediaOpenProgress, onIndexProgress?: (data:IndexProgress)=>void) {
    try {
      this.check();
      onProgress?.('index');
      this.document = await this.prepare(onIndexProgress);
      this.index ??= jsDecodeIndex(this.document);
      onProgress?.('decoder');
      let native:PacketDecoder|null=null;
      if(!forceWasm)try{native=await this.createNative(this.index,this.source!.nativeConfig);}catch(error){
        const codecFailure=error instanceof MediaOpenError&&error.stage==='decode'||error instanceof DOMException&&['NotSupportedError','EncodingError'].includes(error.name);
        if(!codecFailure)throw error;
      }
      const decoder = native ?? await this.createSoftware(this.index, glueURL, wasmBinary, threads);
      this.timeline = this.makeTimeline(decoder);
      onProgress?.('first-frame');
      try { this.primed = await this.first(this.timeline, this.index.firstPts); }
      catch (error) {
        const failed = this.timeline;
        this.timeline = undefined;
        failed?.close();
        if (decoder.kind !== 'webcodecs' || !(error instanceof MediaOpenError) || error.stage !== 'decode') throw error;
        const software = await this.createSoftware(this.index, glueURL, wasmBinary, threads);
        this.timeline = this.makeTimeline(software);
        this.primed = await this.first(this.timeline, this.index.firstPts);
      }
      this.outputSize = { width: this.primed.width, height: this.primed.height };
      this.firstPtsUs = this.primed.pts;
      if (this.startup) { this.timeline.replaceIndex(this.index); this.timeline.setGrowth(this.waitForGrowth); }
      return { ...this.decoderInfo(),...this.timing(),indexState:this.startup?'building' as const:'complete' as const,
        jsIndexReused:this.source!.indexReused };
    } catch (error) { this.close(); throw error; }
  }
  private decoderInfo() {
    const decoder = this.timeline!.decoder;
    return { codec: this.document!.codec,demuxBackend:this.document!.kind,indexBackend:this.document!.kind==='js-ts-packets'?'js-ts-packet-index':'js-matroska-packet-index', decoder: decoder.kind, hardwareAcceleration: decoder.hardwareAcceleration,
      width: this.outputSize!.width, height: this.outputSize!.height, ...decoder.metadata?.() };
  }
  private timed(frame: PacketFrame): PacketFrame {
    const index = this.index!;
    let lo = 0, hi = index.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.packets[index.order[mid]].pts <= frame.pts) lo = mid + 1; else hi = mid;
    }
    frame.durationUs = index.durations[Math.max(0,lo-1)];
    return frame;
  }
  async at(pts: number, recycle?: ArrayBuffer) {
    this.check();
    this.reader.setPlaybackReadAhead(false);
    if (this.primed?.pts === pts) { const frame = this.primed; this.primed = null; return this.timed(frame); }
    this.primed?.frame?.close(); this.primed = null;
    return this.timed(await this.timeline!.at(pts, recycle));
  }
  async next(pts: number, recycle?: ArrayBuffer) {
    this.check();
    this.reader.setPlaybackReadAhead(true);
    const frame = await this.timeline!.next(pts, recycle);
    return frame && this.timed(frame);
  }
  extract(position: number, recycle?: ArrayBuffer) {
    this.check();
    if (!Number.isInteger(position) || position < 0 || position >= this.index!.order.length)
      throw new MediaOpenError('input', 'JS TS frame position out of bounds');
    return this.at(this.index!.packets[this.index!.order[position]].pts, recycle);
  }
  async referenceWitness(glueURL: string, wasmBinary?: Uint8Array, threads: DecodeThreads = 1) {
    this.check();
    this.reader.setPlaybackReadAhead(false);
    if (this.timeline?.decoder.kind !== 'webcodecs') throw new MediaOpenError('decode', 'JS TS native decoder is not ready');
    const decoder = await this.createSoftware(this.index!, glueURL, wasmBinary, threads);
    const witness = this.makeTimeline(decoder);
    try { return await witness.at(this.index!.firstPts); }
    finally { witness.close(); }
  }
  private async replaceDecoder(decoder: PacketDecoder, pts = this.index!.firstPts) {
    this.reader.setPlaybackReadAhead(false);
    const next = this.makeTimeline(decoder);
    let first:PacketFrame;
    try {first=await this.first(next,pts);}
    catch(error){next.close();throw error;}
    // Commit only after the candidate produced a valid actual frame. A failed
    // candidate leaves the previous decoder/source usable for transaction rollback.
    this.primed?.frame?.close(); this.timeline!.close();
    next.appendIndex(this.index!);
    this.timeline = next; this.primed = first;
    if (this.startup) { next.replaceIndex(this.index!); next.setGrowth(this.waitForGrowth); }
    this.outputSize = { width: first.width, height: first.height };
  }
  async switchToSoftware(glueURL: string, wasmBinary?: Uint8Array, threads: DecodeThreads = 1, replace = false, pts?: number) {
    this.check();
    if (replace || this.timeline!.decoder.kind === 'webcodecs')
      await this.replaceDecoder(await this.createSoftware(this.index!, glueURL, wasmBinary, threads), pts);
    return this.decoderInfo();
  }
  async switchToNative() {
    this.check();
    if (this.timeline!.decoder.kind === 'ffmpeg-wasm') {
      const native = await this.createNative(this.index!, this.source!.nativeConfig);
      if (native) await this.replaceDecoder(native);
    }
    return this.decoderInfo();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.primed?.frame?.close(); this.primed = null;
    try { this.timeline?.close(); }
    finally {
      this.timeline = undefined; this.document = undefined; this.index = undefined; this.statistics = undefined;this.prefix=undefined;
      this.controller.abort(); this.wakeIndex();
      try { this.startupSource?.close(); this.source?.close(); } finally {
        this.startupSource = this.source = undefined;
        this.startup = this.published = undefined;
        this.indexTask = undefined;
        this.reader.close();
      }
    }
  }
}
