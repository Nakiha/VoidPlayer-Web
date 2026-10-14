import { RangeReader, type RandomAccessInput } from './range-reader.ts';
import { TsPacketSource, tsDecodeIndex, tsPictureStream } from './ts-packet-source.ts';
import type { TsPacketIndex } from './ts-packet-index.ts';
import { PacketTimeline } from './packet-timeline.ts';
import { nativeFlvDecoder, wasmFlvDecoder } from './flv-decoder.ts';
import type { FlvFrame, PacketDecodeIndex, PacketDecoder } from './flv-decoder.ts';
import type { PacketView } from './analysis/adapters.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';

/** H.264 finite/static TS admission. Both decoders consume this one JS source;
 * the engine has no FFmpeg container entry or alternative demux path. */
export class TsEngine {
  private reader: RangeReader;
  private controller = new AbortController();
  private source: TsPacketSource;
  private index?: PacketDecodeIndex;
  private document?: TsPacketIndex;
  private statistics?: {packets: PacketView[]};
  private timeline?: PacketTimeline;
  private primed: FlvFrame | null = null;
  private closed = false;
  private outputSize?: { width: number; height: number };
  private createNative:typeof nativeFlvDecoder;
  private createSoftware:typeof wasmFlvDecoder;

  constructor(input: RandomAccessInput, sourceVersion: string,
    decoders: {native?:typeof nativeFlvDecoder;software?:typeof wasmFlvDecoder} = {}) {
    this.reader = new RangeReader(input);
    this.source = new TsPacketSource(this.reader, sourceVersion, this.controller.signal);
    this.createNative=decoders.native??nativeFlvDecoder;
    this.createSoftware=decoders.software??wasmFlvDecoder;
  }
  cachedWindows() { return this.reader.cachedWindows(); }
  peekCachedBytes(offset: number, length: number) { return this.reader.peek(offset, length); }
  get analysisIndex() { return this.statistics; }
  /** Untrusted when serialized across runtimes; recipients must verify/rebuild. */
  get packetIndex() { return this.document; }
  private check() { if (this.closed) throw new MediaOpenError('input', 'JS TS engine is closed'); }
  private makeTimeline(decoder: PacketDecoder) {
    if (this.closed) { decoder.close(); this.check(); }
    return new PacketTimeline(this.index!, decoder, packet => this.source.readUnit(packet.sequenceNumber!),
      true, () => !this.closed, tsPictureStream(this.document!));
  }
  private async first(timeline: PacketTimeline, pts: number) {
    const frame = await timeline.at(pts);
    if (this.closed) { frame.frame?.close(); this.check(); }
    return frame;
  }
  async open(glueURL: string, wasmBinary?: Uint8Array, forceWasm = true, threads = 1, onProgress?: MediaOpenProgress) {
    try {
      this.check();
      onProgress?.('index');
      this.document = await this.source.open();
      this.index = tsDecodeIndex(this.document);
      this.statistics = {packets: this.document.packets.map(packet=>({pts:packet.timing.pts===null?null:packet.ptsUs,
        dts:packet.timing.dts===null?null:Math.round(packet.timing.dts*1e6/90000),size:packet.size,key:packet.key}))};
      onProgress?.('decoder');
      const native = !forceWasm ? await this.createNative(this.index, this.source.nativeConfig) : null;
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
      return { ...this.decoderInfo(), firstPtsUs: this.primed.pts,
        durationUs: this.index.firstPts + this.index.duration - this.primed.pts,
        times: this.index.order.map(au => this.index!.packets[au].pts - this.primed!.pts),
        durations: this.index.durations, indexIntegrity: 'complete' as const, indexWarning: undefined };
    } catch (error) { this.close(); throw error; }
  }
  private decoderInfo() {
    const decoder = this.timeline!.decoder;
    return { codec: 'h264' as const, decoder: decoder.kind, hardwareAcceleration: decoder.hardwareAcceleration,
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
      const native = await this.createNative(this.index!, this.source.nativeConfig);
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
      this.timeline = undefined; this.document = undefined; this.index = undefined; this.statistics = undefined;
      this.controller.abort(); this.source.close();
    }
  }
}
