import { PacketTimeline } from './packet-timeline.ts';
import { FlvIndexClient } from './flv-index-client.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';
import { scanFlv, flvDecoderConfig, flvIndexWarning, flvMediaTiming, FlvReader } from './flv-demux.ts';
import type { FlvInput, FlvIndex, FlvCheckpoint } from './flv-demux.ts';
import { nativeFlvDecoder, wasmFlvDecoder, packetDecodeError } from './flv-decoder.ts';
import type { PacketDecoder, FlvFrame } from './flv-decoder.ts';
import type { RangeVersion } from './range-reader.ts';

export interface PreparedFlv extends FlvCheckpoint { version: RangeVersion; }

export class FlvEngine {
  nativeDiagnostics: Record<string, unknown>[] = [];
  readonly reader: FlvReader;
  private cache: FlvIndexClient;
  index!: FlvIndex;
  private checkpoint?: FlvCheckpoint;
  decoder!: PacketDecoder;
  private timeline?: PacketTimeline;
  private decodeFailure?: MediaOpenError;
  private primed: FlvFrame | null = null;
  constructor(input: FlvInput, prepared?: PreparedFlv) {
    this.reader = new FlvReader(input, prepared?.version);
    this.cache = new FlvIndexClient('url' in input ? input.url : undefined, this.reader.size);
    if (prepared) { this.index = prepared.index; this.checkpoint = prepared; }
  }
  async prepare(onProgress?: MediaOpenProgress): Promise<PreparedFlv> {
    if (!this.index) {
      onProgress?.('index');
      // First-frame reads stay small; bulk scan read-ahead starts after display.
      try {
        this.checkpoint = await scanFlv(this.reader, () => onProgress?.('index'), undefined, true);
        this.index = this.checkpoint.index;
        flvDecoderConfig(this.index);
      } catch (error) { this.close(); throw error; }
      finally { this.reader.setIndexing(false); }
    }
    return { ...this.checkpoint!, version: this.reader.version };
  }
  async completeIndex(onProgress?: MediaOpenProgress, cached?: FlvIndex, beforeCommit?: () => Promise<void>) {
    cached ??= await this.cache.read(this.index) ?? undefined;
    if (!this.checkpoint!.complete) {
      this.reader.setIndexing(true);
      try {
        const completed = cached ? { index: cached, nextOffset: this.reader.size, complete: true }
          : await scanFlv(this.reader, () => onProgress?.('index'), this.checkpoint);
        if (completed.index.packets[0].pts !== this.index.packets[0].pts) throw new MediaOpenError('container', 'FLV 索引的起始包发生变化。');
        await beforeCommit?.();
        this.checkpoint = completed; this.index = completed.index;
        this.timeline?.replaceIndex(this.index);
        // The startup packet has been drained. Resume future extraction with
        // a fresh decoder cursor while retaining the already displayed frame.
      } finally { this.reader.setIndexing(false); }
    }
    if (!cached) void this.cache.save(this.index).catch(() => {});
    return { indexWarning: flvIndexWarning(this.index), indexSource: cached ? 'server' as const : 'client' as const, ...flvMediaTiming(this.index) };
  }
  async open(glueURL: string, wasmBinary?: Uint8Array, forceWasm = false, threads = 1, onProgress?: MediaOpenProgress, nativeOnly = false) {
    try {
      await this.prepare(onProgress);
      if (!forceWasm) {
        this.nativeDiagnostics = [];
        let phase = 'capability';
        try {
          onProgress?.('decode');
          const native = await nativeFlvDecoder(this.index, undefined, event => this.nativeDiagnostics.push(event));
          phase = 'first-frame';
          if (native) { this.decoder = native; this.timeline=new PacketTimeline(this.index,native,p=>this.reader.read(p.offset,p.size)); onProgress?.('first-frame'); this.primed = await this.extract(0); }
        } catch (error) {
          if (error instanceof MediaOpenError && error.stage !== 'decode') throw error;
          this.nativeDiagnostics.push({ reason: 'native-failed', phase, error: error instanceof Error ? error.message : String(error) });
          this.decoder?.close(); this.decoder = undefined!;
        }
      }
      if (!this.decoder && nativeOnly) return null;
      if (!this.decoder) {
        onProgress?.('decoder');
        this.decodeFailure = undefined;
        this.decoder = await wasmFlvDecoder(this.index, glueURL, wasmBinary, threads);
        this.timeline=new PacketTimeline(this.index,this.decoder,p=>this.reader.read(p.offset,p.size));
        onProgress?.('first-frame');
        this.primed = await this.extract(0);
      }
      return { codec: this.index.codec, decoder: this.decoder.kind, width: this.primed!.width, height: this.primed!.height,
        hardwareAcceleration: this.decoder.hardwareAcceleration,
        ...this.decoder.metadata?.(), decodedPixelFormat: this.primed!.frame?.format ?? null,
        indexWarning: flvIndexWarning(this.index),
        indexState: this.checkpoint!.complete ? 'complete' as const : 'building' as const,
        ...flvMediaTiming(this.index) };
    } catch (error) { this.close(); throw error; }
  }
  async extract(position: number, recycle?: ArrayBuffer): Promise<FlvFrame> {
    if (this.decodeFailure) throw this.decodeFailure;
    try { return await this.extractFrame(position, recycle); }
    catch (error) {
      const packet = this.index?.packets[this.index.order[position]];
      const failure = packetDecodeError(error, `FLV ${this.index?.codec ?? ''} ${this.decoder?.kind ?? ''} 第 ${position + 1} 帧（包位置 ${packet?.offset ?? '未知'}）`);
      if (failure.stage === 'decode' || failure.stage === 'resource') this.decodeFailure = failure;
      throw failure;
    }
  }
  async at(pts:number,recycle?:ArrayBuffer):Promise<FlvFrame>{
    if(this.primed&&this.primed.pts===pts){const f=this.primed;this.primed=null;return f;}
    this.primed?.frame?.close();this.primed=null;return this.timeline!.at(pts,recycle);
  }
  next(pts:number,recycle?:ArrayBuffer){return this.timeline!.next(pts,recycle);}
  private async extractFrame(position:number,recycle?:ArrayBuffer):Promise<FlvFrame>{
    if(!Number.isInteger(position)||position<0||position>=this.index.order.length)throw new MediaOpenError('input','FLV 帧位置越界。');
    return this.at(this.index.packets[this.index.order[position]].pts,recycle);
  }
  close() { this.cache.close(); this.primed?.frame?.close(); this.primed = null; this.timeline?.close(); this.timeline=undefined; this.decoder = undefined!; this.reader.close(); }
}
