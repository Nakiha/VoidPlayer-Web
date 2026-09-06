import { MediaOpenError } from './media-errors.ts';
import { demuxFlv, flvDecoderConfig, FlvReader } from './flv-demux.ts';
import type { FlvInput, FlvIndex } from './flv-demux.ts';
import { nativeFlvDecoder, wasmFlvDecoder } from './flv-decoder.ts';
import type { PacketDecoder, FlvFrame } from './flv-decoder.ts';

export class FlvEngine {
  readonly reader: FlvReader;
  index!: FlvIndex;
  decoder!: PacketDecoder;
  private cursor = 0;
  private drained = false;
  private anchorPts = -Infinity;
  private last = -1;
  private primed: FlvFrame | null = null;
  constructor(input: FlvInput) { this.reader = new FlvReader(input); }
  async open(glueURL: string, wasmBinary?: Uint8Array, forceWasm = false, threads = 1) {
    try {
      this.index = await demuxFlv(this.reader);
      flvDecoderConfig(this.index);
      if (!forceWasm) {
        try {
          const native = await nativeFlvDecoder(this.index);
          if (native) { this.decoder = native; this.primed = await this.extract(0); }
        } catch (error) {
          if (error instanceof MediaOpenError && error.stage !== 'decode') throw error;
          this.decoder?.close(); this.decoder = undefined!;
        }
      }
      if (!this.decoder) {
        this.decoder = await wasmFlvDecoder(this.index, glueURL, wasmBinary, threads);
        this.last = -1;
        this.primed = await this.extract(0);
      }
      return { codec: this.index.codec, decoder: this.decoder.kind, width: this.primed!.width, height: this.primed!.height,
        ...this.decoder.metadata?.(), decodedPixelFormat: this.primed!.frame?.format ?? null,
        firstPtsUs: this.index.firstPts, durationUs: this.index.duration,
        times: this.index.order.map(i => this.index.packets[i].pts - this.index.firstPts), durations: this.index.durations };
    } catch (error) { this.close(); throw error; }
  }
  async extract(position: number, recycle?: ArrayBuffer): Promise<FlvFrame> {
    const idx = this.index;
    if (!Number.isInteger(position) || position < 0 || position >= idx.order.length) throw new MediaOpenError('input', 'FLV 帧位置越界。');
    if (position === 0 && this.primed) { const f = this.primed; this.primed = null; return f; }
    this.primed?.frame?.close(); this.primed = null;
    const target = idx.packets[idx.order[position]].pts;
    if (this.last < 0 || position <= this.last || position > this.last + 8) {
      this.decoder.reset();
      this.cursor = idx.order[position];
      while (this.cursor > 0 && (!idx.packets[this.cursor].key || idx.packets[this.cursor].pts > target)) this.cursor--;
      this.anchorPts = idx.packets[this.cursor].pts;
      this.drained = false;
    }
    for (;;) {
      const frame = this.decoder.receive(target, recycle);
      if (frame) {
        if (frame.pts !== target) { frame.frame?.close(); throw new MediaOpenError('decode', `FLV 解码未命中目标帧 ${target}（实际 ${frame.pts}）。`); }
        this.last = position; return frame;
      }
      if (this.cursor < idx.packets.length) {
        const packet = idx.packets[this.cursor++];
        // Leading pictures after a CRA may refer to the preceding GOP. They
        // cannot be displayed when random access starts at this keyframe.
        if ((idx.codec === 'hevc' || idx.codec === 'vvc') && packet.pts < this.anchorPts) continue;
        await this.decoder.send(await this.reader.read(packet.offset, packet.size), packet);
      } else if (!this.drained) { this.drained = true; await this.decoder.drain(); }
      else throw new MediaOpenError('decode', 'FLV 文件未输出目标视频帧。');
    }
  }
  close() { this.primed?.frame?.close(); this.primed = null; this.decoder?.close(); this.decoder = undefined!; this.reader.close(); }
}
