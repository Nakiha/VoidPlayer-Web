import { RangeReader, type RandomAccessInput } from '../shared/media/io/range-reader.ts';
import { TsPacketSource } from '../shared/media/containers/ts-packet-source.ts';
import {TsContainerPacketSource} from '../shared/media/containers/mpeg2-ts-packet-source.ts';
import {MatroskaPacketSource} from '../shared/media/containers/matroska-packet-source.ts';
import type {JsPacketIndex} from '../shared/media/containers/matroska-packet-index.ts';
import {jsPictureStream} from '../shared/media/containers/matroska-packet-index.ts';
import {jsDecodeIndex} from './js-decode-index.ts';
import { PacketTimeline } from './packet-timeline.ts';
import { nativePacketDecoder, wasmPacketDecoder } from './flv-decoder.ts';
import type { PacketFrame, PacketDecoder } from './flv-decoder.ts';
import type { PacketDecodeIndex } from '../shared/media/indexing/packet-decode-index.ts';
import type { PacketView } from './analysis/adapters.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import type { IndexProgress } from './worker-protocol.ts';
import { MediaOpenError } from '../shared/media/io/media-errors.ts';
import { TsCombinationNotMigrated } from '../shared/media/containers/ts-packet-source.ts';
import { inspectCachedTracks } from '../shared/media/containers/cached-track-metadata.ts';
import {localJsSourceVersion,loadLocalJsIndex,saveLocalJsIndex} from './js-packet-index-cache.ts';
import {loadServerJsIndex} from './js-packet-index-client.ts';

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
      true, () => !this.closed, jsPictureStream(this.document!));
  }
  private async first(timeline: PacketTimeline, pts: number) {
    const frame = await timeline.at(pts);
    if (this.closed) { frame.frame?.close(); this.check(); }
    return frame;
  }
  async prepare(onIndexProgress?: (data:IndexProgress)=>void) {
    this.check();
    if (this.document) return this.document;
    if(this.format==='ts'){
    let prefix = await this.reader.read(0, Math.min(65536, this.reader.size));
    const tracks=await inspectCachedTracks(this.reader.size,async(at,n)=>this.reader.peek(at,n));
    // Retain a bounded startup window already needed by video indexing, so
    // optional AAC observation survives the full scan evicting early windows.
    if(tracks.audio.presence==='present')prefix=await this.reader.read(0,Math.min(1024*1024,this.reader.size));
    // TS source owns bounded synchronization/PSI recovery and validation.
    // Decoder preference never selects a container fallback.
    this.prefix=prefix.slice();
    }
    let cached:JsPacketIndex|undefined;
    if(this.persistent){
      if('file' in this.input){this.sourceVersion=await localJsSourceVersion(this.reader,this.controller.signal,bytes=>onIndexProgress?.({packets:0,scannedBytes:bytes,totalBytes:this.reader.size,bytesRead:bytes}));cached=await loadLocalJsIndex(this.reader,this.sourceVersion,this.format,this.controller.signal,true);}
      else {cached=await loadServerJsIndex(this.input.url,this.sourceVersion,this.reader.size,this.format,this.controller.signal,onIndexProgress,this.input.library);if(cached)this.indexOrigin='server';}
    }
    const sourceReader={size:this.reader.size,read:async(at:number,length:number)=>{
      const bytes=await this.reader.read(at,length);
      return bytes;
    },close:()=>this.reader.close()};
    this.source=this.format==='ts'?new TsContainerPacketSource(sourceReader,this.sourceVersion,this.controller.signal):new MatroskaPacketSource(sourceReader,this.sourceVersion,this.controller.signal);
    this.document = await this.source!.open(cached,onIndexProgress);
    this.indexPacketsScanned=this.source!.packetsRead;
    if(this.persistent)await saveLocalJsIndex(this.document,this.controller.signal);
    this.check();
    this.index = jsDecodeIndex(this.document);
    this.statistics = {packets: this.document.packets.map(packet=>({pts:packet.timing.pts===null?null:packet.ptsUs,
      dts:packet.timing.dts===null?null:Math.round(packet.timing.dts*1e6*packet.timing.timebase[0]/packet.timing.timebase[1]),size:packet.size,key:packet.key}))};
    return this.document;
  }
  async open(glueURL: string, wasmBinary?: Uint8Array, forceWasm = true, threads = 1, onProgress?: MediaOpenProgress, onIndexProgress?: (data:IndexProgress)=>void) {
    try {
      this.check();
      onProgress?.('index');
      this.document = await this.prepare(onIndexProgress);
      this.index = jsDecodeIndex(this.document);
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
      return { ...this.decoderInfo(), indexSource:this.indexOrigin,jsIndexReused:this.source!.indexReused,jsIndexPacketsScanned:this.indexPacketsScanned, firstPtsUs: this.primed.pts,
        durationUs: this.index.firstPts + this.index.duration - this.primed.pts,
        times: this.index.order.map(au => this.index!.packets[au].pts - this.primed!.pts),
        seekAnchorCount: this.index.packets.filter(packet=>packet.key).length,
        durations: this.index.durations,indexIntegrity:this.document.indexIntegrity==='prefix'?'prefix' as const:'complete' as const,indexTruncatedAt:this.document.indexTruncatedAt,indexWarning:this.document.kind==='js-ts-packets'&&this.document.recovery?'广播采集恢复：保留原始时钟；部分尾包，画面身份未验证。':this.document.indexIntegrity==='prefix'?'封装损坏：仅保留已确认的有效前段。':undefined };
    } catch (error) { this.close(); throw error; }
  }
  private decoderInfo() {
    const decoder = this.timeline!.decoder;
    return { codec: this.document!.codec,demuxBackend:this.document!.kind,indexBackend:this.document!.kind==='js-ts-packets'?'js-ts-packet-index':'js-matroska-packet-index', decoder: decoder.kind, hardwareAcceleration: decoder.hardwareAcceleration,
      width: this.outputSize!.width, height: this.outputSize!.height, ...decoder.metadata?.() };
  }
  async at(pts: number, recycle?: ArrayBuffer) {
    this.check();
    if (this.primed?.pts === pts) { const frame = this.primed; this.primed = null; return frame; }
    this.primed?.frame?.close(); this.primed = null;
    return this.timeline!.at(pts, recycle);
  }
  async next(pts: number, recycle?: ArrayBuffer) { this.check(); return this.timeline!.next(pts, recycle); }
  extract(position: number, recycle?: ArrayBuffer) {
    this.check();
    if (!Number.isInteger(position) || position < 0 || position >= this.index!.order.length)
      throw new MediaOpenError('input', 'JS TS frame position out of bounds');
    return this.at(this.index!.packets[this.index!.order[position]].pts, recycle);
  }
  async referenceWitness(glueURL: string, wasmBinary?: Uint8Array, threads = 1) {
    this.check();
    if (this.timeline?.decoder.kind !== 'webcodecs') throw new MediaOpenError('decode', 'JS TS native decoder is not ready');
    const decoder = await this.createSoftware(this.index!, glueURL, wasmBinary, threads);
    const witness = this.makeTimeline(decoder);
    try { return await witness.at(this.index!.firstPts); }
    finally { witness.close(); }
  }
  private async replaceDecoder(decoder: PacketDecoder) {
    const next = this.makeTimeline(decoder);
    let first:PacketFrame;
    try {first=await this.first(next,this.index!.firstPts);}
    catch(error){next.close();throw error;}
    // Commit only after the candidate produced a valid actual frame. A failed
    // candidate leaves the previous decoder/source usable for transaction rollback.
    this.primed?.frame?.close(); this.timeline!.close();
    this.timeline = next; this.primed = first;
    this.outputSize = { width: first.width, height: first.height };
  }
  async switchToSoftware(glueURL: string, wasmBinary?: Uint8Array, threads = 1) {
    this.check();
    if (this.timeline!.decoder.kind === 'webcodecs')
      await this.replaceDecoder(await this.createSoftware(this.index!, glueURL, wasmBinary, threads));
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
      this.controller.abort();try{this.source?.close();}finally{this.reader.close();}
    }
  }
}
