import { PacketTimeline } from './packet-timeline.ts';
import { FlvIndexClient } from './flv-index-client.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';
import { scanFlv, flvDecoderConfig, flvIndexWarning, flvIndexIntegrity, flvMediaTiming, FlvReader } from './flv-demux.ts';
import type { FlvInput, FlvIndex, FlvCheckpoint } from './flv-demux.ts';
import { nativeFlvDecoder, wasmFlvDecoder, packetDecodeError } from './flv-decoder.ts';
import type { PacketDecoder, FlvFrame } from './flv-decoder.ts';
import type { RangeVersion } from './range-reader.ts';

export interface PreparedFlv extends FlvCheckpoint { version: RangeVersion; }

export class FlvEngine {
  nativeDiagnostics: Record<string, unknown>[] = [];
  readonly reader: FlvReader;
  private cache: FlvIndexClient;
  private scanReader?: FlvReader;
  private serverProgress?: (data: { durationUs: number; scannedBytes: number; totalBytes: number; packets: number }) => void;
  index!: FlvIndex;
  private checkpoint?: FlvCheckpoint;
  decoder!: PacketDecoder;
  private timeline?: PacketTimeline;
  private decodeFailure?: MediaOpenError;
  private primed: FlvFrame | null = null;
  // Startup is decoded against a finite one-packet prefix. A live decoder
  // cannot flush that prefix again while waiting for index growth: flushing
  // ends its reference chain. Keep one independently owned output until the
  // complete index makes ordinary random access possible.
  private startup: FlvFrame | null = null;
  private releaseStartup() { this.startup?.frame?.close(); this.startup = null; }
  private retainStartup() {
    this.releaseStartup();
    if (!this.indexComplete && this.primed) this.startup = cloneFrame(this.primed);
  }
  private indexingFailure: unknown;
  private growing = false;
  onIndexWaiting?: (waiting: boolean) => void;
  private waiters = new Set<() => void>();
  private waitForGrowth = async () => {
    if (this.indexingFailure) throw this.indexingFailure;
    if (!this.growing) return;
    this.onIndexWaiting?.(true);
    await new Promise<void>(resolve => this.waiters.add(resolve));
    this.onIndexWaiting?.(false);
    if (this.indexingFailure) throw this.indexingFailure;
  };
  private wake() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  /** Indexing is terminal; file integrity is reported separately. */
  get indexComplete(): boolean { return !!this.checkpoint?.complete; }
  private publishIndex(checkpoint: FlvCheckpoint) {
    this.checkpoint = checkpoint; this.index = checkpoint.index;
    this.timeline?.appendIndex(this.index);
    this.growing = !checkpoint.complete;
    if (checkpoint.complete) this.releaseStartup();
    this.timeline?.setGrowth(this.growing ? this.waitForGrowth : undefined);
    this.wake();
  }
  constructor(input: FlvInput, prepared?: PreparedFlv) {
    this.reader = new FlvReader(input, prepared?.version);
    this.cache = new FlvIndexClient('url' in input ? input.url : undefined, this.reader.size, progress => {
      if(this.index)this.serverProgress?.({...progress,durationUs:flvMediaTiming(this.index).durationUs});
    });
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
  async completeIndex(onProgress?: MediaOpenProgress, cached?: FlvIndex, publish?: (data: { durationUs: number; scannedBytes: number; totalBytes: number; packets: number }) => void) {
    this.growing = !this.checkpoint!.complete;
    // Startup deliberately drained one packet for display. Restart that cursor
    // once, before streaming, then retain it across every index publication.
    this.timeline?.replaceIndex(this.index);
    this.timeline?.setGrowth(this.growing ? this.waitForGrowth : undefined);
    const commit = (checkpoint: FlvCheckpoint) => {
      this.publishIndex(checkpoint);
      publish?.({ durationUs: checkpoint.index.firstPts + checkpoint.index.duration - checkpoint.index.packets[0].pts,
        scannedBytes: checkpoint.nextOffset, totalBytes: this.reader.size, packets: checkpoint.index.packets.length });
    };
    this.serverProgress = data => { onProgress?.('index'); publish?.(data); };
    try {
      cached ??= await this.cache.read(this.index) ?? undefined;
      if(!cached && this.cache.serverIndexRequired)throw new MediaOpenError('container','服务端 FLV 索引与源文件首包不一致，请清理旧索引后重试。');
      if (!this.checkpoint!.complete) {
        let completed: FlvCheckpoint;
        if(cached)completed={index:cached,nextOffset:cached.truncatedAt??this.reader.size,complete:true};
        else {
          const scanner=this.scanReader=new FlvReader(this.reader.input,this.reader.version);scanner.setIndexing(true);
          completed=await scanFlv(scanner,()=>onProgress?.('index'),this.checkpoint,false,commit);
        }
        if (completed.index.packets[0].pts !== this.index.packets[0].pts) throw new MediaOpenError('container', 'FLV 索引的起始包发生变化。');
        commit(completed);
      }
      if (!cached) void this.cache.save(this.index).catch(() => {});
      return { indexWarning: flvIndexWarning(this.index), indexIntegrity:flvIndexIntegrity(this.index), indexTruncatedAt:this.index.truncatedAt, indexSource: cached ? 'server' as const : 'client' as const, ...flvMediaTiming(this.index) };
    } catch (error) {
      this.indexingFailure = error; this.wake(); throw error;
    } finally { this.serverProgress=undefined; this.scanReader?.close(); this.scanReader = undefined; }
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
      this.retainStartup();
      return { codec: this.index.codec, decoder: this.decoder.kind, width: this.primed!.width, height: this.primed!.height,
        hardwareAcceleration: this.decoder.hardwareAcceleration,
        ...this.decoder.metadata?.(), decodedPixelFormat: this.primed!.frame?.format ?? null,
        indexWarning: flvIndexWarning(this.index),
        indexIntegrity: this.checkpoint!.complete ? flvIndexIntegrity(this.index) : undefined,
        indexTruncatedAt: this.index.truncatedAt,
        indexSource: this.cache.serverIndexRequired ? 'server' as const : 'client' as const,
        indexState: this.checkpoint!.complete ? 'complete' as const : 'building' as const,
        ...flvMediaTiming(this.index) };
    } catch (error) { this.close(); throw error; }
  }
  async extract(position: number, recycle?: ArrayBuffer): Promise<FlvFrame> {
    if (this.decodeFailure) throw this.decodeFailure;
    try { return await this.extractFrame(position, recycle); }
    catch (error) {
      const packet = this.index?.packets[(this.index.displayOrder ?? this.index.order)[position]];
      const failure = packetDecodeError(error, `FLV ${this.index?.codec ?? ''} ${this.decoder?.kind ?? ''} 第 ${position + 1} 帧（包位置 ${packet?.offset ?? '未知'}）`);
      if (failure.stage === 'decode' || failure.stage === 'resource') this.decodeFailure = failure;
      throw failure;
    }
  }
  async at(pts:number,recycle?:ArrayBuffer):Promise<FlvFrame>{
    if(this.primed&&this.primed.pts===pts){const f=this.primed;this.primed=null;return f;}
    if(this.startup?.pts===pts)return cloneFrame(this.startup,recycle);
    this.primed?.frame?.close();this.primed=null;return this.timeline!.at(pts,recycle);
  }
  next(pts:number,recycle?:ArrayBuffer){return this.timeline!.next(pts,recycle);}
  /** Decode the first output with a temporary software decoder over this
   * engine's already-open FLV index and reader. No scan, cache client, or
   * timeline is created for the witness. */
  async referenceWitness(glueURL: string, wasmBinary?: Uint8Array, threads = 1): Promise<FlvFrame> {
    if (this.decoder?.kind !== 'webcodecs' || !this.timeline) throw new MediaOpenError('decode', 'FLV 原生解码器尚未就绪。');
    const decoder = await wasmFlvDecoder(this.index, glueURL, wasmBinary, threads);
    const timeline = new PacketTimeline(this.index, decoder, packet => this.reader.read(packet.offset, packet.size));
    try {
      const firstPts = this.primed?.pts ?? this.index.packets[(this.index.displayOrder ?? this.index.order)[0]].pts;
      return await timeline.at(firstPts);
    } finally { timeline.close(); }
  }
  /** Switch only the decoder after reference admission rejects native output.
   * The packet index, reader, and cache lifecycle remain owned by this engine. */
  async switchToSoftware(glueURL: string, wasmBinary?: Uint8Array, threads = 1) {
    if (this.decoder?.kind === 'webcodecs') {
      const target=this.primed?.pts??this.index.packets[(this.index.displayOrder??this.index.order)[0]].pts;
      const decoder=await wasmFlvDecoder(this.index,glueURL,wasmBinary,threads);
      const timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size));
      let primed:FlvFrame;
      try{primed=await timeline.at(target);}catch(error){timeline.close();throw error;}
      this.primed?.frame?.close();this.timeline?.close();
      this.decoder=decoder;this.timeline=timeline;this.primed=primed;
      this.retainStartup();
    }
    return {
      codec: this.index.codec, decoder: this.decoder.kind, width: this.primed!.width, height: this.primed!.height,
      hardwareAcceleration: this.decoder.hardwareAcceleration, ...this.decoder.metadata?.(),
      decodedPixelFormat: this.primed!.frame?.format ?? this.primed!.description.format ?? null,
    };
  }
  /** Restore browser decoding over the same packet index after a color-mode switch. */
  async switchToNative(){
    if(this.decoder?.kind==='ffmpeg-wasm'){
      const decoder=await nativeFlvDecoder(this.index);
      if(decoder){
        const target=this.primed?.pts??this.index.packets[(this.index.displayOrder??this.index.order)[0]].pts;
        const timeline=new PacketTimeline(this.index,decoder,packet=>this.reader.read(packet.offset,packet.size));
        let primed:FlvFrame;
        try{primed=await timeline.at(target);}catch(error){timeline.close();if(error instanceof MediaOpenError&&error.stage==='decode')return this.decoderInfo();throw error;}
        this.primed?.frame?.close();this.timeline?.close();this.decoder=decoder;this.timeline=timeline;this.primed=primed;
        this.retainStartup();
      }
    }
    return this.decoderInfo();
  }
  private decoderInfo(){return {codec:this.index.codec,decoder:this.decoder.kind,width:this.primed!.width,height:this.primed!.height,
    hardwareAcceleration:this.decoder.hardwareAcceleration,...this.decoder.metadata?.(),
    decodedPixelFormat:this.primed!.frame?.format??this.primed!.description.format??null};}
  private async extractFrame(position:number,recycle?:ArrayBuffer):Promise<FlvFrame>{
    if(!Number.isInteger(position)||position<0||position>=(this.index.displayOrder ?? this.index.order).length)throw new MediaOpenError('input','FLV 帧位置越界。');
    return this.at(this.index.packets[(this.index.displayOrder ?? this.index.order)[position]].pts,recycle);
  }
  close() { this.indexingFailure = new Error('媒体已释放。'); this.growing = false; this.wake(); this.scanReader?.close(); this.cache.close(); this.releaseStartup(); this.primed?.frame?.close(); this.primed = null; this.timeline?.close(); this.timeline=undefined; this.decoder = undefined!; this.reader.close(); }
}

/** Worker responses transfer their resource, so never return the retained
 * resource itself. Software pixels also need independent transferable storage. */
function cloneFrame(source: FlvFrame, recycle?: ArrayBuffer): FlvFrame {
  let pixels: ArrayBuffer | undefined;
  if (source.pixels) {
    pixels = recycle?.byteLength === source.pixels.byteLength ? recycle : new ArrayBuffer(source.pixels.byteLength);
    new Uint8Array(pixels).set(new Uint8Array(source.pixels));
  }
  return { ...source, frame: source.frame?.clone(), pixels };
}
