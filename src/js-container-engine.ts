import { RangeReader, type RandomAccessInput } from './range-reader.ts';
import { TsPacketSource } from './ts-packet-source.ts';
import {MatroskaPacketSource} from './matroska-packet-source.ts';
import type {JsPacketIndex} from './matroska-packet-index.ts';
import {jsPictureStream} from './matroska-packet-index.ts';
import {jsDecodeIndex} from './js-decode-index.ts';
import { PacketTimeline } from './packet-timeline.ts';
import { nativeFlvDecoder, wasmFlvDecoder } from './flv-decoder.ts';
import type { FlvFrame, PacketDecodeIndex, PacketDecoder } from './flv-decoder.ts';
import type { PacketView } from './analysis/adapters.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import type { IndexProgress } from './worker-protocol.ts';
import { MediaOpenError } from './media-errors.ts';
import { TsCombinationNotMigrated } from './ts-packet-source.ts';
import { inspectCachedTracks } from './cached-track-metadata.ts';
import { probeTsVideo } from './media-diagnostics.ts';
import { staticTsPsi } from './ts-static-psi.ts';
import {localJsSourceVersion,loadLocalJsIndex,saveLocalJsIndex} from './js-packet-index-cache.ts';
import {loadServerJsIndex} from './js-packet-index-client.ts';

/** Finite static JS container admission. Both decoders consume one JS source;
 * the engine has no FFmpeg container entry or alternative demux path. */
export class JsContainerEngine {
  private reader: RangeReader;
  private format:'ts'|'matroska';
  private controller = new AbortController();
  private source?: TsPacketSource | MatroskaPacketSource;
  private input:RandomAccessInput;private sourceVersion:string;private persistent:boolean;
  private index?: PacketDecodeIndex;
  private document?: JsPacketIndex;
  private statistics?: {packets: PacketView[]};
  private timeline?: PacketTimeline;
  private primed: FlvFrame | null = null;
  private closed = false;
  private indexPacketsScanned=0;
  private indexOrigin:'client'|'server'='client';
  private outputSize?: { width: number; height: number };
  private createNative:typeof nativeFlvDecoder;
  private createSoftware:typeof wasmFlvDecoder;
  private checkPsi?: (bytes:Uint8Array)=>void;
  private prefix?:Uint8Array;

  constructor(input: RandomAccessInput, sourceVersion: string,
    decoders: {native?:typeof nativeFlvDecoder;software?:typeof wasmFlvDecoder;persistent?:boolean} = {}, format:'ts'|'matroska'='ts') {
    this.format=format;this.reader = new RangeReader(input);
    this.input=input;this.sourceVersion=sourceVersion;this.persistent=!!decoders.persistent;
    this.createNative=decoders.native??nativeFlvDecoder;
    this.createSoftware=decoders.software??wasmFlvDecoder;
  }
  cachedWindows() { return this.reader.cachedWindows(); }
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
    const prefix = await this.reader.read(0, Math.min(65536, this.reader.size));
    this.checkPsi=staticTsPsi(prefix);
    const codecs = probeTsVideo(prefix);
    const tracks = await inspectCachedTracks(this.reader.size, async (at,length)=>this.reader.peek(at,length));
    // Keep existing audio and other TS combinations on their declared,
    // unmigrated route. Do not silently lose a stream ignored by Mediabunny.
    if(codecs.length!==1||!['H.264 / AVC','H.265 / HEVC'].includes(codecs[0]))throw new TsCombinationNotMigrated('initial product migration requires one declared H.264/HEVC video stream');
    if(tracks.audio.presence!=='absent'||!tracks.audio.complete)throw new TsCombinationNotMigrated('initial product migration requires confirmed video-only H.264/HEVC TS');
    this.prefix=prefix.slice();
    }
    let cached:JsPacketIndex|undefined;
    if(this.persistent){
      if('file' in this.input){this.sourceVersion=await localJsSourceVersion(this.reader,this.controller.signal,bytes=>onIndexProgress?.({packets:0,scannedBytes:bytes,totalBytes:this.reader.size,bytesRead:bytes}));cached=await loadLocalJsIndex(this.reader,this.sourceVersion,this.format,this.controller.signal,true);}
      else {cached=await loadServerJsIndex(this.input.url,this.sourceVersion,this.reader.size,this.format,this.controller.signal,onIndexProgress);if(cached)this.indexOrigin='server';}
    }
    const Source=this.format==='ts'?TsPacketSource:MatroskaPacketSource;
    this.source = new Source({size:this.reader.size,read:async(at,length)=>{
      const bytes=await this.reader.read(at,length);
      if(this.checkPsi&&at%188===0&&length%188===0)this.checkPsi(bytes);
      return bytes;
    },close:()=>this.reader.close()}, this.sourceVersion, this.controller.signal);
    this.document = await this.source!.open(cached,onIndexProgress);
    this.indexPacketsScanned=this.source!.packetsRead;
    if(this.persistent)await saveLocalJsIndex(this.document);
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
        durations: this.index.durations, indexIntegrity: 'complete' as const, indexWarning: undefined };
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
    let first:FlvFrame;
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
      this.timeline = undefined; this.document = undefined; this.index = undefined; this.statistics = undefined;this.prefix=undefined;this.checkPsi=undefined;
      this.controller.abort();try{this.source?.close();}finally{this.reader.close();}
    }
  }
}
