import type { MediaOpenProgress } from './media-progress.ts';
import { Input, CustomSource, MP4, EncodedPacketSink } from 'mediabunny';
import type { EncodedPacket } from 'mediabunny';
import { MediaOpenError } from './media-errors.ts';
import { RangeReader } from './range-reader.ts';
import type { RandomAccessInput } from './range-reader.ts';
import { readVvcConfig } from './mp4-config.ts';
import { wasmFlvDecoder } from './flv-decoder.ts';
import type { PacketDecoder, FlvFrame } from './flv-decoder.ts';
import type { FlvCodec } from './flv-demux.ts';

/** MP4 supplies packet metadata without reading mdat; WASM only receives the
 * compressed packets needed for the requested GOP. No FFmpeg demux/index pass. */
export class Mp4Engine {
  private reader: RangeReader;
  private input: Input;
  private sink!: EncodedPacketSink;
  private decoder?: PacketDecoder;
  private packets: EncodedPacket[] = [];
  private order: number[] = [];
  private cursor = 0;
  private last = -1;
  private anchor = -Infinity;
  private drained = false;
  private primed: FlvFrame | null = null;
  private codec!: FlvCodec;
  constructor(source: RandomAccessInput) {
    this.reader = new RangeReader(source);
    this.input = new Input({ source: new CustomSource({ getSize: () => this.reader.size,
      read: (start, end) => this.reader.read(start, end - start), maxCacheSize: 1024 * 1024 }), formats: [MP4] });
  }
  async open(glueURL: string, wasmBinary?: Uint8Array, _forceWasm = true, threads = 1, onProgress?: MediaOpenProgress) {
    try {
      // These are capability checks, before opening the decoder. Only these
      // stages may route an unsupported container to FFmpeg's AVIO path.
      onProgress?.('inspect');
      try { await this.input.getFormat(); }
      catch (error) {
        if (error instanceof MediaOpenError) throw error;
        throw new MediaOpenError('container', '不是可通过 MP4 索引读取的文件。');
      }
      const track = await this.input.getPrimaryVideoTrack();
      if (!track) throw new MediaOpenError('container', 'MP4 没有视频轨道。');
      const id = await track.getInternalCodecId();
      const known = await track.getCodec();
      const codec = id === 'vvc1' || id === 'vvi1' ? 'vvc' : ({ avc: 'h264', hevc: 'hevc', av1: 'av1' } as Record<string, FlvCodec>)[known ?? ''];
      if (!codec) throw new MediaOpenError('codec', '此 MP4 编码需要 FFmpeg 解封装。');
      this.codec = codec;
      const config = codec === 'vvc' ? null : await track.getDecoderConfig();
      const raw = config?.description;
      const description = codec === 'vvc' ? await readVvcConfig(this.reader, track.id)
        : raw ? ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw) : new Uint8Array(0);
      onProgress?.('index');
      this.sink = new EncodedPacketSink(track);
      for await (const packet of this.sink.packets(undefined, undefined, { metadataOnly: true })) {
        this.packets.push(packet);
        if (this.packets.length > 2_000_000) throw new MediaOpenError('resource', 'MP4 帧索引超过上限。');
      }
      if (!this.packets.length || this.packets[0].type !== 'key') throw new MediaOpenError('container', 'MP4 缺少起始关键帧。');
      this.order = this.packets.map((_, i) => i).sort((a, b) => this.packets[a].timestamp - this.packets[b].timestamp);
      const pts = this.order.map(i => Math.round(this.packets[i].timestamp * 1e6));
      if (pts.some((p, i) => i > 0 && p <= pts[i - 1])) throw new MediaOpenError('container', 'MP4 显示时间戳无效。');
      const firstPtsUs = pts[0], times = pts.map(p => p - firstPtsUs);
      const durations = this.order.map((p, i) => Math.round(this.packets[p].duration * 1e6) || (i + 1 < pts.length ? pts[i + 1] - pts[i] : i ? pts[i] - pts[i - 1] : 40000));
      onProgress?.('decoder');
      this.decoder = await wasmFlvDecoder({ codec, description }, glueURL, wasmBinary, threads);
      onProgress?.('first-frame');
      this.primed = await this.extract(0);
      return { codec, decoder: 'ffmpeg-wasm', width: this.primed.width, height: this.primed.height,
        ...this.decoder.metadata?.(), firstPtsUs, durationUs: times.at(-1)! + durations.at(-1)!, times, durations };
    } catch (error) { this.close(); throw error; }
  }
  async extract(position: number, recycle?: ArrayBuffer): Promise<FlvFrame> {
    if (!this.decoder || !Number.isInteger(position) || position < 0 || position >= this.order.length) throw new MediaOpenError('input', 'MP4 帧位置越界。');
    if (position === 0 && this.primed) { const frame = this.primed; this.primed = null; return frame; }
    this.primed = null;
    const target = Math.round(this.packets[this.order[position]].timestamp * 1e6);
    if (this.last < 0 || position <= this.last || position > this.last + 8) {
      this.decoder.reset();
      this.cursor = this.order[position];
      while (this.cursor > 0 && (this.packets[this.cursor].type !== 'key' || Math.round(this.packets[this.cursor].timestamp * 1e6) > target)) this.cursor--;
      this.anchor = Math.round(this.packets[this.cursor].timestamp * 1e6); this.drained = false;
    }
    for (;;) {
      const frame = this.decoder.receive(target, recycle);
      if (frame) {
        if (frame.pts !== target) throw new MediaOpenError('decode', `MP4 解码未命中目标帧 ${target}（实际 ${frame.pts}）。`);
        this.last = position; return frame;
      }
      if (this.cursor < this.packets.length) {
        const meta = this.packets[this.cursor++], pts = Math.round(meta.timestamp * 1e6);
        if ((this.codec === 'hevc' || this.codec === 'vvc') && pts < this.anchor) continue;
        const packet = await this.sink.getPacket(meta.timestamp);
        if (!packet || packet.sequenceNumber !== meta.sequenceNumber) throw new MediaOpenError('container', 'MP4 压缩包与索引不一致。');
        // The public packet API exposes PTS and decode order, not DTS. Pass
        // AV_NOPTS_VALUE rather than inventing DTS for reordered pictures.
        await this.decoder.send(packet.data, { pts, dts: -(2 ** 63), key: packet.type === 'key', offset: 0, size: packet.byteLength });
      } else if (!this.drained) { this.drained = true; await this.decoder.drain(); }
      else throw new MediaOpenError('decode', 'MP4 未输出目标视频帧。');
    }
  }
  close() { this.primed = null; this.decoder?.close(); this.decoder = undefined; this.input.dispose(); this.reader.close(); this.packets = []; this.order = []; }
}
