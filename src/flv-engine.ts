import { FlvIndexClient } from './flv-index-client.ts';
import type { MediaOpenProgress } from './media-progress.ts';
import { MediaOpenError } from './media-errors.ts';
import { scanFlv, flvDecoderConfig, flvIndexWarning, FlvReader } from './flv-demux.ts';
import type { FlvInput, FlvIndex, FlvCheckpoint } from './flv-demux.ts';
import { nativeFlvDecoder, wasmFlvDecoder, packetDecodeError } from './flv-decoder.ts';
import type { PacketDecoder, FlvFrame } from './flv-decoder.ts';
import type { RangeVersion } from './range-reader.ts';

export interface PreparedFlv extends FlvCheckpoint { version: RangeVersion; }

export class FlvEngine {
  readonly reader: FlvReader;
  private cache: FlvIndexClient;
  index!: FlvIndex;
  private checkpoint?: FlvCheckpoint;
  decoder!: PacketDecoder;
  private cursor = 0;
  private configuration = 0;
  private drained = false;
  private anchorPts = -Infinity;
  private last = -1;
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
        if (completed.index.firstPts !== this.index.firstPts) throw new MediaOpenError('container', 'FLV 后续视频包早于首帧，无法保持帧时间基准。');
        await beforeCommit?.();
        this.checkpoint = completed; this.index = completed.index;
        // The startup packet has been drained. Resume future extraction with
        // a fresh decoder cursor while retaining the already displayed frame.
        this.last = -1;
      } finally { this.reader.setIndexing(false); }
    }
    if (!cached) void this.cache.save(this.index).catch(() => {});
    return { indexWarning: flvIndexWarning(this.index), indexSource: cached ? 'server' as const : 'client' as const, firstPtsUs: this.index.firstPts, durationUs: this.index.duration,
      times: this.index.order.map(i => this.index.packets[i].pts - this.index.firstPts), durations: this.index.durations };
  }
  async open(glueURL: string, wasmBinary?: Uint8Array, forceWasm = false, threads = 1, onProgress?: MediaOpenProgress, nativeOnly = false) {
    try {
      await this.prepare(onProgress);
      if (!forceWasm) {
        try {
          onProgress?.('decode');
          const native = await nativeFlvDecoder(this.index);
          if (native) { this.decoder = native; onProgress?.('first-frame'); this.primed = await this.extract(0); }
        } catch (error) {
          if (error instanceof MediaOpenError && error.stage !== 'decode') throw error;
          this.decoder?.close(); this.decoder = undefined!;
        }
      }
      if (!this.decoder && nativeOnly) return null;
      if (!this.decoder) {
        onProgress?.('decoder');
        this.decodeFailure = undefined; this.configuration = 0;
        this.decoder = await wasmFlvDecoder(this.index, glueURL, wasmBinary, threads);
        this.last = -1;
        onProgress?.('first-frame');
        this.primed = await this.extract(0);
      }
      return { codec: this.index.codec, decoder: this.decoder.kind, width: this.primed!.width, height: this.primed!.height,
        hardwareAcceleration: this.decoder.hardwareAcceleration,
        ...this.decoder.metadata?.(), decodedPixelFormat: this.primed!.frame?.format ?? null,
        indexWarning: flvIndexWarning(this.index),
        indexState: this.checkpoint!.complete ? 'complete' as const : 'building' as const,
        firstPtsUs: this.index.firstPts, durationUs: this.index.duration,
        times: this.index.order.map(i => this.index.packets[i].pts - this.index.firstPts), durations: this.index.durations };
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
  private async extractFrame(position: number, recycle?: ArrayBuffer): Promise<FlvFrame> {
    const idx = this.index;
    if (!Number.isInteger(position) || position < 0 || position >= idx.order.length) throw new MediaOpenError('input', 'FLV 帧位置越界。');
    if (position === 0 && this.primed) { const f = this.primed; this.primed = null; return f; }
    this.primed?.frame?.close(); this.primed = null;
    const target = idx.packets[idx.order[position]].pts;
    const configuration = idx.packets[idx.order[position]].configuration ?? 0;
    if (configuration !== this.configuration) {
      if (!this.decoder.reconfigure) throw new MediaOpenError('decode', '解码器不支持视频配置切换。');
      await this.decoder.reconfigure({ codec: idx.codec, description: idx.configurations![configuration] });
      this.configuration = configuration; this.last = -1;
    }
    if (this.last < 0 || position <= this.last || position > this.last + 8) {
      this.decoder.reset();
      this.cursor = idx.order[position];
      while (this.cursor > 0 && (idx.packets[this.cursor - 1].configuration ?? 0) === configuration && (!idx.packets[this.cursor].key || idx.packets[this.cursor].pts > target)) this.cursor--;
      this.anchorPts = idx.packets[this.cursor].pts;
      this.drained = false;
    }
    for (;;) {
      const frame = this.decoder.receive(target, recycle);
      if (frame) {
        if (frame.pts !== target) { frame.frame?.close(); throw new MediaOpenError('decode', `FLV 解码未命中目标帧 ${target}（实际 ${frame.pts}）。`); }
        this.last = position; return frame;
      }
      if (this.cursor < idx.packets.length && (idx.packets[this.cursor].configuration ?? 0) === configuration) {
        const packet = idx.packets[this.cursor++];
        // Leading pictures after a CRA may refer to the preceding GOP. They
        // cannot be displayed when random access starts at this keyframe.
        if ((idx.codec === 'hevc' || idx.codec === 'vvc') && packet.pts < this.anchorPts) continue;
        await this.decoder.send(await this.reader.read(packet.offset, packet.size), packet);
      } else if (!this.drained) { this.drained = true; await this.decoder.drain(); }
      else throw new MediaOpenError('decode', 'FLV 文件未输出目标视频帧。');
    }
  }
  close() { this.cache.close(); this.primed?.frame?.close(); this.primed = null; this.decoder?.close(); this.decoder = undefined!; this.reader.close(); }
}
